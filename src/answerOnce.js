// ANSWER ONCE (v1.152.0, Security, 2026-10-31). The owner answers an agent's registered question (shared_tools\ask_iddo.py) with ONE real click
// from any place; the answer is typed into the ASKING agent's chat as a genuine user message and the question is resolved.
// This file is the main-process half of "answer from OUTSIDE Agent Desktop": shared_tools\ask_confirm.py pops a small always-on-top window;
// the owner's click on THAT window writes a signed request file into <stateDir>\inbox. This service verifies and hands it to the renderer.
//
// THREAT MODEL (read before changing):
//  1. The point is that an approval is never an agent's claim. The only writer of a request is the confirm window, started as a process on the
//     owner's desktop; it signs the request with a key that lives OUTSIDE the workspace/Dropbox (stateDir = %LOCALAPPDATA%\AgentDesktop\answer-once
//     or AGENT_DESKTOP_ANSWER_ONCE_DIR), where agents' tools and permission layers do not read or write. No signature = ignored.
//  2. A request binds the question id, the exact answer text, a hash of the question text shown, a window nonce and a timestamp. AD accepts it only
//     if the ask is STILL OPEN, the answer is one of that ask's own quick answers (no free text), the question text still matches what the owner saw,
//     the nonce is the file name and unused, and it is < 10 min old. Consumed files move to done\ or rejected\ (audit.log lists each).
//  3. A same-user process that reads the key file could forge a request; no file scheme can stop code running as the owner. This closes the realistic
//     cases: an agent claiming "Iddo said yes", an injected instruction, a stray file written into the workspace.
//  4. A test instance (AGENT_DESKTOP_TEST_MODE) only runs this service when AGENT_DESKTOP_ANSWER_ONCE_DIR is set, so a sandbox never eats live requests.
//  5. The window cannot be clicked by an agent through AD's APIs; AD never writes into inbox\ and no AD IPC takes a request body.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), os = require("os");

const MAX_AGE_MS = 10 * 60 * 1000, FUTURE_SKEW_MS = 60 * 1000, MAX_FILE = 4096;
const ID_RX = /^\d{8}-\d{6}-[0-9a-f]{4}$/, NONCE_RX = /^[0-9a-f]{32}$/;

function stateDir(env, platform, homedir) {
  env = env || process.env; platform = platform || process.platform; homedir = homedir || os.homedir();
  if (env.AGENT_DESKTOP_ANSWER_ONCE_DIR) return env.AGENT_DESKTOP_ANSWER_ONCE_DIR;
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(homedir, "AppData", "Local"), "AgentDesktop", "answer-once");
  return path.join(env.XDG_STATE_HOME || path.join(homedir, ".local", "state"), "agent-desktop", "answer-once");
}
function qhash(question) { return crypto.createHash("sha256").update(String(question), "utf8").digest("hex").slice(0, 16); }
function macOf(key, f) {
  return crypto.createHmac("sha256", key).update(["v1", f.id, f.answer, f.qhash, f.nonce, String(f.ts)].join("\x1f"), "utf8").digest("hex");
}
function readKey(dir, create) {
  const p = path.join(dir, "key");
  try { const k = fs.readFileSync(p, "utf8").trim(); if (/^[0-9a-f]{64}$/.test(k)) return k; } catch (e) { /* missing */ }
  if (!create) return null;
  fs.mkdirSync(dir, { recursive: true });
  const k = crypto.randomBytes(32).toString("hex");
  try { fs.writeFileSync(p, k + "\n", { flag: "wx", mode: 0o600 }); return k; } catch (e) { try { return fs.readFileSync(p, "utf8").trim(); } catch (e2) { return null; } }
}
function timingEq(a, b) { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); }

// Pure check. req = parsed file, fileNonce = the file's base name, ask = the open question's JSON or null.
function verify(req, o) {
  if (!req || typeof req !== "object") return { ok: false, reason: "not an object" };
  if (req.v !== 1) return { ok: false, reason: "unknown version" };
  if (!ID_RX.test(String(req.id || ""))) return { ok: false, reason: "bad id" };
  if (!NONCE_RX.test(String(req.nonce || "")) || req.nonce !== o.fileNonce) return { ok: false, reason: "nonce does not match the file name" };
  if (typeof req.answer !== "string" || !req.answer || req.answer.length > 300) return { ok: false, reason: "bad answer" };
  if (typeof req.qhash !== "string" || !/^[0-9a-f]{16}$/.test(req.qhash)) return { ok: false, reason: "bad question hash" };
  if (typeof req.ts !== "number" || !isFinite(req.ts)) return { ok: false, reason: "bad time" };
  if (!o.key) return { ok: false, reason: "no key" };
  if (!timingEq(macOf(o.key, req), req.mac || "")) return { ok: false, reason: "signature does not match" };
  const age = o.now - req.ts;
  if (age > MAX_AGE_MS) return { ok: false, reason: "stale (older than 10 minutes)", stale: true };
  if (age < -FUTURE_SKEW_MS) return { ok: false, reason: "time is in the future" };
  if (!o.ask) return { ok: false, reason: "that question is no longer open" };
  if (qhash(o.ask.question) !== req.qhash) return { ok: false, reason: "the question text changed after the window was shown" };
  if (!Array.isArray(o.ask.quick) || !o.ask.quick.includes(req.answer)) return { ok: false, reason: "the answer is not one of the question's quick answers" };
  return { ok: true };
}

// deliver({id, agent, answer}) -> Promise<{ok, error?, retry?}>. retry:true leaves the file for the next scan (window not ready yet).
function createService(o) {
  const dir = o.dir, qdir = o.questionsDir, now = o.now || Date.now, log = o.log || (() => {});
  const inbox = path.join(dir, "inbox"), done = path.join(dir, "done"), rejected = path.join(dir, "rejected"), results = path.join(dir, "results");
  let timer = null, busy = false;
  const audit = (line) => { try { fs.appendFileSync(path.join(dir, "audit.log"), new Date(now()).toISOString() + " " + line + "\n"); } catch (e) { /* cosmetic */ } };
  const move = (name, to) => { try { fs.mkdirSync(to, { recursive: true }); fs.renameSync(path.join(inbox, name), path.join(to, name)); } catch (e) { try { fs.unlinkSync(path.join(inbox, name)); } catch (e2) { /* gone */ } } };
  const result = (nonce, r) => { try { fs.mkdirSync(results, { recursive: true }); fs.writeFileSync(path.join(results, nonce + ".json"), JSON.stringify(Object.assign({ at: new Date(now()).toISOString() }, r))); } catch (e) { /* the window just times out */ } };
  const readAsk = (id) => { try { return JSON.parse(fs.readFileSync(path.join(qdir, id + ".json"), "utf8").replace(/^﻿/, "")); } catch (e) { return null; } };

  async function scan() {
    if (busy) return 0; busy = true; let handled = 0;
    try {
      fs.mkdirSync(inbox, { recursive: true });
      const key = readKey(dir, true);
      for (const name of fs.readdirSync(inbox)) {
        const m = /^([0-9a-f]{32})\.json$/.exec(name); if (!m) continue;
        const nonce = m[1], full = path.join(inbox, name);
        let st; try { st = fs.statSync(full); } catch (e) { continue; }
        if (!st.isFile() || st.size > MAX_FILE) { audit("reject " + name + ": not a small file"); move(name, rejected); continue; }
        if (fs.existsSync(path.join(done, name)) || fs.existsSync(path.join(rejected, name))) { audit("reject " + name + ": nonce already used"); try { fs.unlinkSync(full); } catch (e) { /* ignore */ } continue; }
        let req; try { req = JSON.parse(fs.readFileSync(full, "utf8").replace(/^﻿/, "")); } catch (e) { continue; /* half-written: next scan; stale ones are cleaned below */ }
        const ask = ID_RX.test(String(req && req.id || "")) ? readAsk(req.id) : null;
        const v = verify(req, { key, now: now(), ask, fileNonce: nonce });
        if (!v.ok) { audit("reject " + name + " (" + (req && req.id) + "): " + v.reason); result(nonce, { ok: false, error: v.reason }); move(name, rejected); handled++; continue; }
        let r; try { r = await o.deliver({ id: req.id, agent: ask.agent, answer: req.answer }); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
        if (r && r.retry) { if (now() - req.ts > MAX_AGE_MS) { audit("reject " + name + ": not delivered in time"); result(nonce, { ok: false, error: "Agent Desktop was not ready in time" }); move(name, rejected); } continue; }
        audit((r && r.ok ? "delivered " : "failed ") + name + " (" + req.id + ", " + ask.agent + ") answer=" + JSON.stringify(req.answer) + (r && r.error ? " error=" + r.error : ""));
        result(nonce, { ok: !!(r && r.ok), error: r && r.error || "" }); move(name, r && r.ok ? done : rejected); handled++;
      }
    } catch (e) { log("answerOnce scan: " + (e && e.message)); } finally { busy = false; }
    return handled;
  }
  return { scan, start(ms) { if (!timer) { timer = setInterval(() => { scan(); }, ms || 2000); if (timer.unref) timer.unref(); } }, stop() { if (timer) clearInterval(timer); timer = null; }, dirs: { inbox, done, rejected, results } };
}

module.exports = { stateDir, qhash, macOf, readKey, verify, createService, MAX_AGE_MS };
