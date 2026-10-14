// v1.113.0 voice inbox - dictation (PHEME) addressed to ONE agent, delivered to THAT agent whatever tab is open.
//
// Why: PHEME used to click into the Agent Desktop window and paste, so a dictation recorded for the Health agent went to
// the Video Editing agent when the owner switched tabs while it was being transcribed (2026-10-11 01:13). The target is now
// decided when the dictation STARTS and carried in the message itself:
//   1. This app writes the selected agent to <userData>\active-agent.json whenever the selection (or the visible view)
//      changes (event driven, no polling): { path, name, view, pid, voiceInbox, ... }.
//   2. PHEME reads it when the key is pressed and pins that agent for the whole recording + transcription.
//   3. PHEME drops <userData>\voice-inbox\<id>.json = { id, agentPath, text, createdAt, source } (written as .tmp, renamed).
//      This module watches that folder (fs.watch, no timer), claims each file (rename into processing\), hands the request
//      to the renderer, which sends it through the SAME pipeline as the compose box (outbox item = delivery proof, retry,
//      "Not delivered" with Retry / Dismiss) for that agent's path, and writes the outcome to processed\<id>.json, which
//      PHEME waits for. A message is never typed into whatever agent happens to be visible.
// Pure helpers + createInbox() (all I/O in a folder, delivery injected) so it is unit-testable without Electron;
// init() is the thin Electron wiring, loaded from main.js inside try/catch so a fault can only disable the inbox.
const fs = require("fs");
const path = require("path");

const MAX_TEXT = 20000;
const MAX_FILE_BYTES = 256 * 1024;
const EXPIRE_MS = 10 * 60 * 1000;           // a request older than this is not delivered (it would arrive out of context)
const DELIVER_TIMEOUT_MS = 90 * 1000;
const KEEP_PROCESSED = 40;
const MAX_PER_MINUTE = 5;
const KEEP_PROCESSED_MS = 24 * 3600 * 1000;
const SAFE_ID = /^[A-Za-z0-9][\w.-]{0,79}$/;

const sanitizeSource = (s) => String(s == null ? "" : s).replace(/[^\w.-]/g, "").slice(0, 24) || "unknown";

// raw file text -> { ok:true, req } | { ok:false, reason, id? }
function parseRequest(raw, fileName, now) {
  const t = now == null ? Date.now() : now;
  const id = String(fileName || "").replace(/\.json$/i, "");
  if (!SAFE_ID.test(id)) return { ok: false, reason: "bad-file-name", id: "" };
  let o;
  try { o = JSON.parse(String(raw || "").replace(/^﻿/, "")); } catch (e) { return { ok: false, reason: "unreadable-json", id }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, reason: "not-an-object", id };
  if (typeof o.agentPath !== "string" || !o.agentPath.trim()) return { ok: false, reason: "no-agent-path", id };
  if (typeof o.text !== "string" || !o.text.trim()) return { ok: false, reason: "empty-text", id };
  if (o.text.length > MAX_TEXT) return { ok: false, reason: "text-too-long (" + o.text.length + " > " + MAX_TEXT + ")", id };
  const createdAt = Number(o.createdAt);
  if (!(createdAt > 0)) return { ok: false, reason: "no-created-at", id };
  const req = { id, agentPath: o.agentPath, text: o.text, createdAt, source: sanitizeSource(o.source) };
  if (t - createdAt > EXPIRE_MS) return { ok: false, reason: "expired (" + Math.round((t - createdAt) / 1000) + " s old)", id, req };
  return { ok: true, req };
}

// What the app tells the world about the selected agent. view "chat" = an agent chat is showing; anything else = another view.
function activeDoc(sel, ctx) {
  const c = ctx || {};
  const s = sel || {};
  return {
    path: typeof s.path === "string" && s.path ? s.path : null,
    name: typeof s.name === "string" ? s.name : "",
    view: s.view === "chat" ? "chat" : "other",
    pid: c.pid || 0,
    startedAt: c.startedAt || 0,
    voiceInbox: !!c.inboxArmed,
    inboxDir: c.inboxDir || "",
    closed: !!c.closed,
    updatedAt: c.now == null ? Date.now() : c.now,
  };
}
const sameDoc = (a, b) => !!a && !!b && ["path", "name", "view", "pid", "startedAt", "voiceInbox", "inboxDir", "closed"].every((k) => a[k] === b[k]);

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } } };
// rename onto a file another process is reading can fail with EPERM/EBUSY on Windows: retry 3x (20-50 ms gaps) before giving up
function writeJsonAtomic(file, obj, rename) {
  const ren = rename || fs.renameSync;
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj), "utf8"); // no BOM
  for (let i = 0; ; i++) {
    try { ren(tmp, file); return; }
    catch (e) {
      if (i >= 3 || !(e && (e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES"))) { try { fs.unlinkSync(tmp); } catch (e2) { /* ok */ } throw e; }
      sleepSync(20 + Math.floor(Math.random() * 31));
    }
  }
}

// The active-agent file: written only when something changed.
function createActiveWriter({ file, pid, startedAt, inboxDir, now, log, rename }) {
  const say = log || (() => {});
  const clock = now || Date.now;
  let last = null, lastFailed = false, armed = false, closed = false, sel = { path: null, name: "", view: "other" };
  function flush() {
    const doc = activeDoc(sel, { pid, startedAt, inboxArmed: armed, inboxDir, closed, now: clock() });
    if (sameDoc(last, doc) && !lastFailed) return false; // unchanged, unless the last write failed (the file on disk is then stale)
    try { writeJsonAtomic(file, doc, rename); last = doc; lastFailed = false; return true; }
    catch (e) { lastFailed = true; last = doc; say("voice-inbox: cannot write active-agent.json: " + e.message); return false; }
  }
  return {
    set(s) { sel = { path: s && s.path, name: s && s.name, view: s && s.view }; return flush(); },
    setArmed(v) { armed = !!v; return flush(); },
    close() { closed = true; return flush(); },
    current: () => last,
  };
}

// dir: the voice-inbox folder. deliver(req) -> Promise<{ ok, reason?, agent?, how? }>  (renderer glue, see main wiring).
function createInbox({ dir, deliver, log, now, watch, timeoutMs, maxPerMinute, neverWake }) {
  const say = log || (() => {});
  const clock = now || Date.now;
  const procDir = path.join(dir, "processing");
  const doneDir = path.join(dir, "processed");
  let chain = Promise.resolve();
  let timer = null, rescan = null, watcher = null, closed = false;
  const stamps = []; // when requests were accepted for delivery (rate cap)
  const cap = maxPerMinute == null ? MAX_PER_MINUTE : maxPerMinute;
  const seen = new Set(); // file names claimed in this run (a duplicate fs event must not claim twice)

  function finish(id, req, result) {
    const out = { id, agentPath: req ? req.agentPath : "", source: req ? req.source : "", createdAt: req ? req.createdAt : 0,
      chars: req && req.text ? req.text.length : 0, result: result, at: clock() };
    try { writeJsonAtomic(path.join(doneDir, id + ".json"), out); } catch (e) { say("voice-inbox: cannot write result for " + id + ": " + e.message); }
    try { fs.unlinkSync(path.join(procDir, id + ".json")); } catch (e) { /* already gone */ }
    prune();
  }
  function prune() {
    try {
      const files = fs.readdirSync(doneDir).filter((f) => f.endsWith(".json")).map((f) => {
        let m = 0; try { m = fs.statSync(path.join(doneDir, f)).mtimeMs; } catch (e) { /* gone */ }
        return { f, m };
      }).sort((a, b) => b.m - a.m);
      files.forEach((x, i) => { if (i >= KEEP_PROCESSED || clock() - x.m > KEEP_PROCESSED_MS) { try { fs.unlinkSync(path.join(doneDir, x.f)); } catch (e) { /* ok */ } } });
    } catch (e) { /* cosmetic */ }
  }
  const withTimeout = (p, ms) => new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, reason: "timeout-state-unknown" }), ms);
    if (t.unref) t.unref();
    Promise.resolve(p).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); resolve({ ok: false, reason: "deliver-error: " + ((e && e.message) || e) }); });
  });

  async function processOne(name) {
    const file = path.join(procDir, name);
    let raw = "", parsed;
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_FILE_BYTES) parsed = { ok: false, reason: "file-too-large", id: name.replace(/\.json$/i, "") };
      else raw = fs.readFileSync(file, "utf8");
    } catch (e) { say("voice-inbox: cannot read " + name + ": " + e.message); return; }
    parsed = parsed || parseRequest(raw, name, clock());
    if (!parsed.ok) {
      say("voice-inbox: refused " + name + ": " + parsed.reason);
      finish(parsed.id || name.replace(/\.json$/i, ""), parsed.req || null, { ok: false, reason: parsed.reason });
      return;
    }
    const req = parsed.req;
    const tNow = clock();
    while (stamps.length && tNow - stamps[0] > 60000) stamps.shift();
    if (stamps.length >= cap) {
      say("voice-inbox: refused " + req.id + ": rate-limited (more than " + cap + " requests a minute)");
      finish(req.id, req, { ok: false, reason: "rate-limited (max " + cap + " per minute)" });
      return;
    }
    stamps.push(tNow);
    let nw = null;
    try { nw = typeof neverWake === "function" ? neverWake(req) : null; } catch (e) { nw = null; }
    if (nw) req.neverWake = String(nw); // the renderer delivers to a RUNNING session but refuses to start this agent
    const r = await withTimeout(deliver(req), timeoutMs || DELIVER_TIMEOUT_MS);
    const result = r && typeof r === "object" ? r : { ok: false, reason: "no-result" };
    say("voice-inbox: " + (result.ok ? "accepted" : "NOT delivered (" + result.reason + ")") + " id=" + req.id + " agent=" + (result.agent || req.agentPath.split(/[\\/]/).pop()) +
      " chars=" + req.text.length + " source=" + req.source + (result.how ? " how=" + result.how : ""));
    finish(req.id, req, result);
  }

  // claim every new .json in the inbox (rename = atomic: a second instance or a duplicate event cannot also take it)
  function scan() {
    if (closed) return [];
    let names;
    try { names = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)); } catch (e) { return []; }
    const claimed = [];
    for (const n of names) {
      if (seen.has(n)) continue;
      try { fs.renameSync(path.join(dir, n), path.join(procDir, n)); } catch (e) { continue; } // not ours / still being written
      seen.add(n); if (seen.size > 500) seen.clear();
      claimed.push(n);
    }
    // oldest dictation first (names are time-ordered ids; createdAt decides when it can be read cheaply)
    const order = claimed.map((n) => { let c = 0; try { c = Number(JSON.parse(fs.readFileSync(path.join(procDir, n), "utf8").replace(/^﻿/, "")).createdAt) || 0; } catch (e) { /* parse error handled later */ } return { n, c }; })
      .sort((a, b) => a.c - b.c || (a.n < b.n ? -1 : 1));
    for (const x of order) chain = chain.then(() => processOne(x.n)).catch((e) => say("voice-inbox: error " + ((e && e.message) || e)));
    return order.map((x) => x.n);
  }
  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { scan(); } catch (e) { say("voice-inbox: scan failed " + e.message); }
      // one-shot rescan 2 s later: fs.watch can drop an event (a rename racing the first scan); claiming is idempotent
      if (!closed && !rescan) { rescan = setTimeout(() => { rescan = null; try { scan(); } catch (e) { /* next event */ } }, 2000); if (rescan.unref) rescan.unref(); }
    }, 60);
    if (timer.unref) timer.unref();
  }

  function start() {
    fs.mkdirSync(procDir, { recursive: true });
    fs.mkdirSync(doneDir, { recursive: true });
    // a request that was being processed when the app stopped may or may not have been sent: never resend it, say so
    try {
      for (const n of fs.readdirSync(procDir).filter((f) => /\.json$/i.test(f))) {
        const id = n.replace(/\.json$/i, "");
        say("voice-inbox: " + n + " was in flight when the app stopped - not resent");
        finish(id, null, { ok: false, reason: "interrupted-state-unknown" });
      }
    } catch (e) { /* none */ }
    // .tmp leftovers from a crashed writer are not requests; tidy the very old ones
    try { for (const n of fs.readdirSync(dir).filter((f) => /\.tmp$/i.test(f))) { try { if (clock() - fs.statSync(path.join(dir, n)).mtimeMs > 3600 * 1000) fs.unlinkSync(path.join(dir, n)); } catch (e) { /* ok */ } } } catch (e) { /* ok */ }
    const arm = watch || ((d, cb) => { const w = fs.watch(d, { persistent: false }, cb); return w; });
    try {
      watcher = arm(dir, () => schedule());
      if (watcher && typeof watcher.on === "function") watcher.on("error", (e) => { say("voice-inbox: watcher error " + ((e && e.message) || e)); try { watcher.close(); } catch (e2) { /* ok */ } watcher = null; });
    } catch (e) { say("voice-inbox: cannot watch " + dir + ": " + e.message); return false; }
    schedule(); // anything dropped while the app was not running
    return true;
  }
  function close() { closed = true; try { if (watcher) watcher.close(); } catch (e) { /* ok */ } if (timer) clearTimeout(timer); if (rescan) clearTimeout(rescan); }
  return { start, scan, close, idle: () => chain, dir };
}

// ---- Electron wiring --------------------------------------------------------------------------------------------------
// app.getPath("userData") is the sandbox's own folder in test mode, so the sandbox never touches the live inbox.
function init({ app, ipcMain, getMainWindow, log, now }) {
  const say = typeof log === "function" ? log : () => {};
  const userData = app.getPath("userData");
  const dir = path.join(userData, "voice-inbox");
  const clock = now || Date.now;
  fs.mkdirSync(dir, { recursive: true });
  const active = createActiveWriter({ file: path.join(userData, "active-agent.json"), pid: process.pid, startedAt: clock(), inboxDir: dir, now: clock, log: say });

  const winOk = (event) => { const w = getMainWindow(); return !!(w && !w.isDestroyed() && event.sender === w.webContents); };
  ipcMain.on("active-agent-changed", (event, sel) => { if (winOk(event)) active.set(sel); });

  // main -> renderer request, answered on "voice-inbox-reply"
  const waiting = new Map();
  let seq = 0;
  ipcMain.on("voice-inbox-reply", (event, msg) => {
    if (!winOk(event) || !msg) return;
    const p = waiting.get(msg.id);
    if (p) { waiting.delete(msg.id); p(msg.result); }
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function deliver(req) {
    // the window may not exist yet when the app has just started with a dictation already waiting
    for (let i = 0; i < 120; i++) {
      const w = getMainWindow();
      if (w && !w.isDestroyed() && !w.webContents.isLoading()) {
        return new Promise((resolve) => {
          const id = ++seq;
          waiting.set(id, resolve);
          w.webContents.send("voice-inbox-request", { id, agentPath: req.agentPath, text: req.text, createdAt: req.createdAt, source: req.source, voiceId: req.id, neverWake: req.neverWake || "" });
        });
      }
      await sleep(500);
    }
    return { ok: false, reason: "no-window" };
  }
  const neverWake = (req) => {
    try {
      const W = require("./wakeAgent");
      let extra = [];
      try { const j = JSON.parse(fs.readFileSync(path.join(userData, "wake", "wake_config.json"), "utf8").replace(/^﻿/, "")); if (Array.isArray(j.neverWake)) extra = j.neverWake; } catch (e) { /* default list only */ }
      const folder = String(req.agentPath || "").split(/[\\/]/).filter(Boolean).pop() || "";
      return W.isNeverWake(extra, { displayName: folder, folderName: folder });
    } catch (e) { return null; }
  };
  const inbox = createInbox({ dir, deliver, log: say, now: clock, neverWake });
  const armed = inbox.start();
  active.setArmed(armed);
  app.on("before-quit", () => { try { inbox.close(); active.close(); } catch (e) { /* quitting */ } });
  return { dir, inbox, active };
}

module.exports = { init, createInbox, createActiveWriter, parseRequest, activeDoc, sameDoc, sanitizeSource, MAX_TEXT, EXPIRE_MS, DELIVER_TIMEOUT_MS, KEEP_PROCESSED, MAX_PER_MINUTE, writeJsonAtomic };
