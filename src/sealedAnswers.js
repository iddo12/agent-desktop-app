// SEALED ANSWERS (v1.153.0-pre, Security, 2026-11-01). When the owner clicks an answer in Agent Desktop's "waiting for you" bar (or a quick button on an
// inline ask card), the main process signs {id, answer, question hash, how, time, nonce} with an Ed25519 key only Agent Desktop holds and stores the
// seal inside the question's record (open_questions\answered\<id>.json). Any agent can then run `ask_iddo.py verify <id>` (public key only) and treat a
// valid seal as the owner's own words. shared_tools\ask_iddo.py `resolve` never writes a seal, so an agent cannot mint one.
//
// THREAT MODEL (read before changing):
//  1. The private key is generated here, wrapped with Electron safeStorage (Windows DPAPI) and kept in <stateDir>\seal.key.enc, with the public key in
//     <stateDir>\pub.json. stateDir = %LOCALAPPDATA%\AgentDesktop\sealed-answers (override AGENT_DESKTOP_SEALED_DIR), outside the workspace/Dropbox.
//     Agents hold no secret: they verify with the public key. No AD IPC takes a signature or a key; the only IPC ("seal-answer") takes {id, text, via},
//     re-reads the ask FILE itself, and refuses a closed ask or an already sealed one.
//  2. The seal binds the question id, the exact answer text, a hash of question + asking agent + quick answers, the way it was given (button/typed), a
//     time and a nonce. Editing the question after the answer, moving a seal to another id, or changing the answer text all fail verification.
//  3. Time: signing time is never earlier than the last seal in the ledger (a rolled-back clock cannot produce older-looking seals); the verifier
//     rejects seals dated before the question was created or in the future, and can enforce a maximum age.
//  4. PLAIN LIMIT: a hostile process running as the SAME Windows user could call DPAPI itself, read the key and forge. This closes agent claims
//     ("Iddo said yes"), `resolve`, prompt injection and stray workspace files; it does not defend against code running as the owner with the
//     intent to forge. (Stronger: key in a TPM/Hello-bound store; not built.)
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), os = require("os");

const ID_RX = /^\d{8}-\d{6}-[0-9a-f]{4}$/, NONCE_RX = /^[0-9a-f]{32}$/;
const LEDGER_FUTURE_MS = 24 * 3600 * 1000;   // clock rollback up to a day is still covered; a ledger line further ahead is treated as poison and ignored
const MAX_ANSWER = 600, FUTURE_SKEW_MS = 2 * 60 * 1000, PREDATE_SKEW_MS = 2 * 60 * 1000;
const VIAS = ["button", "typed"];

function stateDir(env, platform, homedir) {
  env = env || process.env; platform = platform || process.platform; homedir = homedir || os.homedir();
  if (env.AGENT_DESKTOP_SEALED_DIR) return env.AGENT_DESKTOP_SEALED_DIR;
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(homedir, "AppData", "Local"), "AgentDesktop", "sealed-answers");
  return path.join(env.XDG_STATE_HOME || path.join(homedir, ".local", "state"), "agent-desktop", "sealed-answers");
}
// Same fields as answerOnce.qhash and shared_tools\ask_confirm.py (question, asking agent, quick answers).
function qhash(ask) {
  const quick = Array.isArray(ask.quick) ? ask.quick.map(String) : [];
  return crypto.createHash("sha256").update(JSON.stringify(["qh2", String(ask.question), String(ask.agent == null ? "" : ask.agent), quick, String(ask.context == null ? "" : ask.context), !!ask.merav, String(ask.created == null ? "" : ask.created)]), "utf8").digest("hex");
}
function message(s) {
  return Buffer.from(["sealed-answer-v1", s.id, s.answer, s.qhash, s.via, String(s.ts), s.nonce, s.kid].join("\x1f"), "utf8");
}
function rawPub(keyObj) { return (keyObj.type === "private" ? crypto.createPublicKey(keyObj) : keyObj).export({ type: "spki", format: "der" }).subarray(-32); }
function kidOf(pubRaw) { return crypto.createHash("sha256").update(pubRaw).digest("hex").slice(0, 16); }

function receiptMessage(r) {
  const o = Object.assign({}, r); delete o.sig;
  return Buffer.from("approval-receipt-v1" + JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])), "utf8");
}
function verifyReceipt(r, pub) {
  try {
    if (!r || !pub || r.kid !== pub.kid || kidOf(Buffer.from(pub.pub, "hex")) !== pub.kid) return false;
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub.pub, "hex")]);
    return crypto.verify(null, receiptMessage(r), crypto.createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(String(r.sig || ""), "base64"));
  } catch (e) { return false; }
}

// Pure check used by the tests; shared_tools\sealed_verify.py is the same rule for agents. pub = {kid, pub(hex)} from pub.json.
function verify(seal, ask, pub, o) {
  o = o || {}; const now = o.now == null ? Date.now() : o.now;
  if (!seal || typeof seal !== "object") return { ok: false, reason: "no seal" };
  if (seal.v !== 1) return { ok: false, reason: "unknown seal version" };
  if (!ask || !ID_RX.test(String(ask.id || "")) || seal.id !== ask.id) return { ok: false, reason: "seal is for another question id" };
  if (typeof seal.answer !== "string" || !seal.answer || seal.answer.length > MAX_ANSWER) return { ok: false, reason: "bad answer" };
  if (VIAS.indexOf(seal.via) < 0) return { ok: false, reason: "bad via" };
  if (!NONCE_RX.test(String(seal.nonce || ""))) return { ok: false, reason: "bad nonce" };
  if (typeof seal.ts !== "number" || !isFinite(seal.ts)) return { ok: false, reason: "bad time" };
  if (!pub || !/^[0-9a-f]{64}$/.test(String(pub.pub || "")) || seal.kid !== pub.kid || kidOf(Buffer.from(pub.pub, "hex")) !== pub.kid) return { ok: false, reason: "seal key is not the published Agent Desktop key" };
  if (seal.qhash !== qhash(ask)) return { ok: false, reason: "the question, its agent or its quick answers changed after the answer" };
  if (ask.answer != null && ask.answer !== seal.answer) return { ok: false, reason: "record answer differs from the sealed answer" };
  let good = false;
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub.pub, "hex")]);
    good = crypto.verify(null, message(seal), crypto.createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(String(seal.sig || ""), "base64"));
  } catch (e) { good = false; }
  if (!good) return { ok: false, reason: "signature does not verify" };
  if (seal.ts > now + FUTURE_SKEW_MS) return { ok: false, reason: "seal is dated in the future" };
  const created = Date.parse(ask.created || "");
  if (isFinite(created) && seal.ts < created - PREDATE_SKEW_MS) return { ok: false, reason: "seal is older than the question" };
  if (o.maxAgeMs != null && now - seal.ts > o.maxAgeMs) return { ok: false, reason: "seal is older than the allowed age" };
  return { ok: true, answer: seal.answer, via: seal.via, ts: seal.ts };
}

// io = { dir, protect(buf)->buf, unprotect(buf)->buf, now() }. protect/unprotect are safeStorage in the app, identity-ish in tests.
function createSealer(io) {
  const dir = io.dir, now = io.now || Date.now;
  const keyFile = path.join(dir, "seal.key.enc"), pubFile = path.join(dir, "pub.json"), ledger = path.join(dir, "ledger.jsonl");
  let priv = null, pub = null;

  function writePub(rawP) {
    const j = JSON.stringify({ v: 1, alg: "ed25519", kid: kidOf(rawP), pub: rawP.toString("hex") });
    try { if (fs.readFileSync(pubFile, "utf8").trim() === j) return; } catch (e) { /* write it */ }
    fs.writeFileSync(pubFile, j + "\n");
  }
  function load() {
    if (priv) return;
    fs.mkdirSync(dir, { recursive: true });
    try {
      const der = io.unprotect(fs.readFileSync(keyFile));
      priv = crypto.createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
    } catch (e) { priv = null; }
    if (!priv) {
      if (fs.existsSync(keyFile)) throw new Error("seal key exists but cannot be unwrapped; refusing to replace it silently");
      const kp = crypto.generateKeyPairSync("ed25519");
      fs.writeFileSync(keyFile, io.protect(kp.privateKey.export({ type: "pkcs8", format: "der" })), { flag: "wx" });
      priv = kp.privateKey;
    }
    pub = rawPub(priv);
    writePub(pub);                                       // heals a tampered or missing pub.json
  }
  function lastTs() {
    let t = 0; const cap = now() + LEDGER_FUTURE_MS;   // a poisoned ledger line cannot push seals into the future
    try { const lines = fs.readFileSync(ledger, "utf8").trim().split("\n"); for (const l of lines.slice(-50)) { try { const v = JSON.parse(l).ts || 0; if (v <= cap) t = Math.max(t, v); } catch (e) { /* skip */ } } } catch (e) { /* none */ }
    return t;
  }
  // ask = the record as read from open_questions\<id>.json. Returns the seal object (not yet stored anywhere).
  function seal(ask, text, via) {
    load();
    if (!ask || !ID_RX.test(String(ask.id || ""))) throw new Error("bad question id");
    text = String(text == null ? "" : text).trim();
    if (!text || text.length > MAX_ANSWER) throw new Error("bad answer");
    if (VIAS.indexOf(via) < 0) throw new Error("bad via");
    const s = { v: 1, id: ask.id, answer: text, qhash: qhash(ask), via, ts: Math.max(Math.floor(now()), lastTs() + 1), nonce: crypto.randomBytes(16).toString("hex"), kid: kidOf(pub) };
    s.sig = crypto.sign(null, message(s), priv).toString("base64");
    fs.appendFileSync(ledger, JSON.stringify({ id: s.id, ts: s.ts, nonce: s.nonce, answer: s.answer, via: s.via }) + "\n");
    return s;
  }
  // APPROVAL RECEIPTS (approvals pop-up): the same key signs a line of the approvals log. Domain-separated prefix, so a receipt can never be
  // replayed as an answer seal and vice versa. rec is plain JSON data; the returned object is rec + {kid, sig}.
  function signReceipt(rec) {
    load();
    const out = Object.assign({}, rec, { kid: kidOf(pub) });
    out.sig = crypto.sign(null, receiptMessage(out), priv).toString("base64");
    return out;
  }
  return { seal, signReceipt, publicInfo: () => { load(); return { kid: kidOf(pub), pub: pub.toString("hex") }; }, dir };
}

// The IPC body: seal the owner's answer into the OPEN question file (the renderer then calls resolve-open-question, which moves it to answered\).
// Refuses a closed, already answered or malformed ask; the answer must be one of its quick answers (button) or any non-empty text (typed).
function sealIntoFile(sealer, questionsDir, id, text, via, shown) {
  if (!ID_RX.test(String(id || ""))) return { ok: false, error: "bad id" };
  const file = path.join(questionsDir, id + ".json");
  let ask;
  try { ask = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (e) { return { ok: false, error: "question is not open" }; }
  if (!ask || ask.id !== id || !ask.question) return { ok: false, error: "bad question file" };
  if (ask.seal) return { ok: false, error: "already sealed" };
  // The seal must bind what the owner SAW. The renderer passes the question/agent/quick of the card on screen; an agent that edited the file after
  // the card was drawn (or before the click) makes them differ and nothing is sealed.
  if (!shown || typeof shown !== "object" || !shown.question) return { ok: false, error: "no displayed question to bind the seal to" };
  if (qhash(shown) !== qhash(ask)) return { ok: false, error: "the question changed since it was shown" };
  text = String(text == null ? "" : text).trim();
  if (via === "button" && !(Array.isArray(ask.quick) && ask.quick.indexOf(text) >= 0)) return { ok: false, error: "not one of the question's quick answers" };
  let s;
  try { s = sealer.seal(ask, text, via); } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 200) }; }
  ask.answer = s.answer; ask.answered = new Date(s.ts).toISOString(); ask.answered_by = "owner via Agent Desktop UI"; ask.seal = s;
  const tmp = file + ".seal.tmp";
  try { fs.writeFileSync(tmp, JSON.stringify(ask, null, 1)); fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ } return { ok: false, error: "could not store the seal" }; }
  return { ok: true, kid: s.kid };
}

module.exports = { verifyReceipt, stateDir, qhash, message, verify, createSealer, sealIntoFile, kidOf };
