"use strict";
// v1.132.0 sync guard (2026-10-18). A synchronous file open on a Dropbox folder can cost a fixed 2 s each (Dropbox's filter driver
// answering late); 60 agents x several files read with readFileSync froze the main thread for minutes (stalls of 1898 s seen).
//
// WHAT. Installed once, first thing in main.js (main thread only; AD_SYNCGUARD=0 turns everything off):
//   1. TRACER   every sync call that can block (readFileSync, execSync, execFileSync, spawnSync) records "what, since when" in shared memory.
//               A worker thread watches that slot and appends to <userData>\sync-stalls.log when a call is still running after 2 s, so a
//               frozen main thread still leaves a trace (the main thread cannot log while stuck). Each call that took >= 2 s is logged too.
//   2. POOL     readFileSync of a file under a cache root (the agents folder) is done by a small pool of worker threads: the main thread
//               waits at most READ_TIMEOUT_MS (3 s); on timeout it throws ETIMEDOUT (callers already try/catch a missing file) and the late
//               result still lands in the cache for next time. Reads run in parallel across the pool.
//   3. CACHE    fresh for FRESH_MS; after that the old copy is returned at once and refreshed in the background (stale-while-revalidate).
//               Every in-process write/rename/unlink to a path drops its entry, so AD never reads back an older copy of its own write.
//               Coordination files (locks, mailboxes, outboxes, tmp, pending) are never cached.
//   4. TIMEOUTS execSync/execFileSync/spawnSync without a timeout get DEFAULT_EXEC_TIMEOUT_MS instead of waiting forever.
//   4b. WARMING a cold read also warms its folder (other notes/config files, in parallel); warmRoot(root) does it for every agent folder at start.
//       Once reads are visibly slow (2 in a row > 1 s) a cold read waits only SOFT_WAIT_MS for 30 s, so a slow sync client costs the UI fractions
//       of a second per read instead of 2 s each; the value is cached when it arrives.
//   5. takeSlowest() returns the slowest sync call since the last call (the governor line in main.js logs it).

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { Worker, MessageChannel, receiveMessageOnPort, isMainThread } = require("worker_threads");

const ON = isMainThread && process.env.AD_SYNCGUARD !== "0";
const SLOW_MS = 2000;
const READ_TIMEOUT_MS = Number(process.env.AD_SYNCGUARD_READ_TIMEOUT_MS) || 3000;
const FRESH_MS = Number(process.env.AD_SYNCGUARD_FRESH_MS) || 10000;
const MAX_STALE_MS = 10 * 60 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 4000;
const POOL_SIZE = 16;          // opens on a slow sync client run in parallel (16 files cost the same 2 s as one), so a wide pool warms a folder fast
const SOFT_WAIT_MS = 250;      // once reads are visibly slow, a cold read waits only this long; the result is cached when it arrives
const SOFT_WINDOW_MS = 30000;
const SLOW_READ_MS = 1000;
const PREFETCH_EXT = /\.(md|json|txt)$/i;
const PREFETCH_MAX_BYTES = 200 * 1024;
const PREFETCH_MAX_FILES = 40;
const DEFAULT_EXEC_TIMEOUT_MS = 20000;
// only plain data files: AD's own source (require), transcripts (.jsonl) and binaries never go through the pool
const CACHE_EXT = /\.(md|json|txt|ya?ml|csv)$/i;
const NEVER_CACHE = /(^|[\\/])(.*\.(lock|tmp|part|pid)|.*(mailbox|outbox|inbox|pending|lock)[^\\/]*|\.paused|runtime\.json)$/i;

const orig = {
  readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, appendFileSync: fs.appendFileSync, renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync, copyFileSync: fs.copyFileSync, rmSync: fs.rmSync, writeFile: fs.writeFile, appendFile: fs.appendFile,
  rename: fs.rename, unlink: fs.unlink, copyFile: fs.copyFile, rm: fs.rm, createWriteStream: fs.createWriteStream,
  execSync: cp.execSync, execFileSync: cp.execFileSync, spawnSync: cp.spawnSync,
};

// ---- tracer: one shared slot (seqlock-free: the worker only needs "still the same call after 2 s") ----
const sab = new SharedArrayBuffer(8 * 4 + 240);
const meta = new Float64Array(sab, 0, 4);        // [0] call counter, [1] start (ms since epoch), [2] 1 = a call is running
const lbl = new Uint8Array(sab, 32, 240);
let slowest = { ms: 0, label: "" };
let worker = null;
let started = false;

function begin(label) {
  meta[2] = 0;
  const b = Buffer.from(String(label).slice(0, 200), "utf8");
  lbl.fill(0); lbl.set(b.subarray(0, 239));
  meta[1] = Date.now(); meta[0] += 1; meta[2] = 1;
  return meta[1];
}
function end(t0, label) {
  meta[2] = 0;
  const ms = Date.now() - t0;
  if (ms > slowest.ms) slowest = { ms, label: String(label).slice(0, 200) };
  if (ms >= SLOW_MS && worker) { try { worker.postMessage({ slow: { ms, label: String(label).slice(0, 200) } }); } catch (e) { /* tracer is best effort */ } }
}

const WATCH_SRC = `
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const meta = new Float64Array(workerData.sab, 0, 4);
const lbl = new Uint8Array(workerData.sab, 32, 240);
const log = (m) => { try { fs.appendFileSync(workerData.logPath, new Date().toISOString() + " " + m + "\\n"); } catch (e) {} };
try { if (fs.statSync(workerData.logPath).size > 5 * 1024 * 1024) fs.writeFileSync(workerData.logPath, ""); } catch (e) {}
log("sync guard started pid " + process.pid);
let lastSeq = -1, lastLogged = 0;
setInterval(() => {
  if (meta[2] !== 1) { lastSeq = -1; return; }
  const seq = meta[0], age = Date.now() - meta[1];
  if (age < ${SLOW_MS}) return;
  const text = Buffer.from(lbl).toString("utf8").replace(/\\0+$/, "");
  if (seq !== lastSeq || Date.now() - lastLogged > 30000) { lastSeq = seq; lastLogged = Date.now(); log("STILL BLOCKED " + age + " ms in: " + text); }
}, 500);
parentPort.on("message", (m) => { if (m.slow) log("SLOW " + m.slow.ms + " ms: " + m.slow.label); });
`;

const READ_SRC = `
const { parentPort } = require("worker_threads");
const fs = require("fs");
parentPort.on("message", ({ p, port, flag }) => {
  let out;
  try { out = { ok: true, data: fs.readFileSync(p) }; }
  catch (e) { out = { ok: false, err: { code: e.code, errno: e.errno, syscall: e.syscall, path: e.path, message: e.message } }; }
  port.postMessage(out);
  port.close();
  Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
});
`;

// ---- pool + cache ----
let pool = null;
let cacheRoots = [];
const cache = new Map();   // resolved path -> { buf, t, refreshing }
const version = new Map(); // resolved path -> bumped by every in-process write; a read that started before a bump must not be cached
const timedOut = new Map(); // resolved path -> time of a read that timed out and has not completed since: writes to it are refused
const lc = (s) => (process.platform === "win32" ? s.toLowerCase() : s);

function getPool() {
  if (pool) return pool;
  pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const w = new Worker(READ_SRC, { eval: true });
    w.unref();
    w.on("error", () => { /* a dead reader just stops being picked */ w.dead = true; });
    w.inflight = 0;
    pool.push(w);
  }
  return pool;
}
// workers 0-1 are kept for the read the main thread is waiting on; the rest take prefetches, so a waiting read never queues behind a warm-up
function pickReader(foreground) {
  const live = getPool().filter((w, i) => !w.dead && (foreground ? i < 2 : i >= 2));
  if (!live.length) return null;
  return live.reduce((a, b) => (b.inflight < a.inflight ? b : a));
}
function toErr(e) {
  const err = new Error(e.message || "read failed");
  if (e.code) err.code = e.code; if (e.errno) err.errno = e.errno; if (e.syscall) err.syscall = e.syscall; if (e.path) err.path = e.path;
  return err;
}
function cacheSet(key, buf) {
  timedOut.delete(key);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { buf, t: Date.now(), refreshing: false });
}
function wanted(key) {
  if (!cacheRoots.length) return false;
  const k = lc(key);
  if (!cacheRoots.some((r) => k.startsWith(r))) return false;
  return CACHE_EXT.test(key) && !NEVER_CACHE.test(key) && !/[\\/]node_modules[\\/]/i.test(key);
}
function resolveKey(p) {
  if (typeof p === "string") return path.resolve(p);
  if (p instanceof URL && p.protocol === "file:") return path.resolve(require("url").fileURLToPath(p));
  return null;
}
function decode(buf, opts) {
  const enc = typeof opts === "string" ? opts : opts && opts.encoding;
  const copy = Buffer.from(buf);
  return enc && enc !== "buffer" ? copy.toString(enc) : copy;
}

// the read itself, in a pool thread, bounded by READ_TIMEOUT_MS

// ports of reads that are still running (prefetches and timed-out reads). The event loop delivers their results, but a main thread that is
// busy in a sync loop never turns it, so every guarded read also drains them directly.
const lateReads = new Set();
function lateHandle(entry, m) {
  if (!lateReads.delete(entry)) return;
  entry.w.inflight--;
  if (m.ok && m.data.length <= MAX_FILE_BYTES && (version.get(entry.key) || 0) === entry.v) cacheSet(entry.key, Buffer.from(m.data.buffer, m.data.byteOffset, m.data.length));
  try { entry.port.close(); } catch (e) { /* closed */ }
}
function trackLate(port1, key, w) {
  const entry = { port: port1, key, w, v: version.get(key) || 0 };
  lateReads.add(entry);
  port1.on("message", (m) => lateHandle(entry, m));
  port1.unref();
}
function drainLate() {
  if (!lateReads.size) return;
  for (const entry of Array.from(lateReads)) {
    const r = receiveMessageOnPort(entry.port);
    if (r) lateHandle(entry, r.message);
  }
}

let slowReads = 0, lastSlowAt = 0;
function pooledRead(key) {
  const tStart = Date.now();
  const limit = slowReads >= 2 && tStart - lastSlowAt < SOFT_WINDOW_MS ? SOFT_WAIT_MS : READ_TIMEOUT_MS;
  const w = pickReader(true);
  if (!w) return null;
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  w.inflight++;
  w.postMessage({ p: key, port: port2, flag }, [port2]);
  const r = Atomics.wait(flag, 0, 0, limit);
  if (r === "timed-out") {
    slowReads++; lastSlowAt = Date.now();
    trackLate(port1, key, w);
    timedOut.set(key, Date.now());
    const err = new Error(`syncGuard: reading ${key} did not finish in ${limit} ms (slow disk or sync client); skipped, it will be cached when it arrives`);
    err.code = "ETIMEDOUT"; err.path = key;
    throw err;
  }
  w.inflight--;
  if (Date.now() - tStart > SLOW_READ_MS) { slowReads++; lastSlowAt = Date.now(); } else if (slowReads && Date.now() - lastSlowAt > SOFT_WINDOW_MS) slowReads = 0;
  const msg = receiveMessageOnPort(port1);
  port1.close();
  if (!msg) return null;
  const m = msg.message;
  if (!m.ok) throw toErr(m.err);
  return Buffer.from(m.data.buffer, m.data.byteOffset, m.data.length);
}
function refreshAsync(key, entry) {
  if (entry.refreshing) return;
  entry.refreshing = true;
  const v = version.get(key) || 0;
  fs.promises.readFile(key).then(
    (b) => { if ((version.get(key) || 0) !== v) { entry.refreshing = false; return; } if (b.length <= MAX_FILE_BYTES) cacheSet(key, b); else cache.delete(key); },
    (e) => { if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) cache.delete(key); else entry.refreshing = false; }
  );
}


// ---- prefetch: warm the cache in parallel without blocking anyone ----
const warmedDirs = new Map(); // dir -> time
function prefetchFiles(files) {
  for (const key of files) {
    if (cache.has(key) || !wanted(key)) continue;
    const w = pickReader();
    if (!w) return;
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    w.inflight++;
    w.postMessage({ p: key, port: port2, flag }, [port2]);
    trackLate(port1, key, w);
  }
}
function prefetchDir(dir) {
  const k = path.resolve(dir), now = Date.now();
  if (now - (warmedDirs.get(k) || 0) < 60000) return;
  warmedDirs.set(k, now);
  try {
    const out = [];
    for (const name of fs.readdirSync(k)) {
      if (out.length >= PREFETCH_MAX_FILES) break;
      if (!PREFETCH_EXT.test(name)) continue;
      const f = path.join(k, name);
      try { const st = fs.statSync(f); if (st.isFile() && st.size <= PREFETCH_MAX_BYTES) out.push(f); } catch (e) { /* vanished */ }
    }
    prefetchFiles(out);
  } catch (e) { /* unreadable folder: nothing to warm */ }
}
// warm every agent folder (top-level notes/config files) under root, in the background
function warmRoot(root) {
  setImmediate(() => {
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
      for (const d of dirs) prefetchDir(d);
    } catch (e) { /* root not readable */ }
  });
}

function guardedReadFileSync(p, opts) {
  const key = typeof p === "number" ? null : resolveKey(p);
  const flagged = opts && typeof opts === "object" && opts.flag && opts.flag !== "r";
  if (key && !flagged && wanted(key)) {
    drainLate();
    const e = cache.get(key);
    const now = Date.now();
    if (e && now - e.t < FRESH_MS) return decode(e.buf, opts);
    if (e && now - e.t < MAX_STALE_MS) { refreshAsync(key, e); return decode(e.buf, opts); }
    prefetchDir(path.dirname(key));
    const t0 = begin("readFileSync(pool) " + key);
    try {
      const buf = pooledRead(key);
      if (buf) { if (buf.length <= MAX_FILE_BYTES) cacheSet(key, buf); return decode(buf, opts); }
    } finally { end(t0, "readFileSync(pool) " + key); }
  }
  const t0 = begin("readFileSync " + (key || String(p)));
  try { return orig.readFileSync.apply(fs, arguments); } finally { end(t0, "readFileSync " + (key || String(p))); }
}

function drop(p) { const k = resolveKey(p); if (k) { cache.delete(k); version.set(k, (version.get(k) || 0) + 1); } }
function wrapWrite(obj, name, positions) {
  const f = orig[name];
  if (!f) return;
  obj[name] = function () { try { for (const i of positions) if (arguments[i] !== undefined) drop(arguments[i]); } catch (e) { /* cache hygiene only */ } return f.apply(this, arguments); };
}


// A read that timed out looks like "file missing" to callers that swallow every error and fall back to defaults; if such a caller then
// writes its default back, real content is lost (agents.js updateAgent did exactly that shape). Refuse any overwrite of a path whose last
// read timed out and has not completed since.
function refusal(p) {
  const k = resolveKey(p);
  const t = k && timedOut.get(k);
  if (!t) return null;
  if (Date.now() - t > MAX_STALE_MS) { timedOut.delete(k); return null; }
  const err = new Error(`syncGuard: refusing to overwrite ${k}: its last read timed out, so the data to write may be a default built without the real content`);
  err.code = "EAGAIN"; err.path = k;
  return err;
}
function wrapOverwrite(obj, name) {
  const f = obj[name];
  if (!f) return;
  const isPromise = obj === fs.promises;
  const isSync = /Sync$/.test(name);
  obj[name] = function () {
    const o = arguments[2];
    const appending = o && typeof o === "object" && /^a/.test(String(o.flag || "")); // appendFileSync calls writeFileSync with flag "a"
    const err = appending ? null : refusal(arguments[0]);
    if (err) {
      if (isSync) throw err;
      if (isPromise) return Promise.reject(err);
      const cb = arguments[arguments.length - 1];
      if (typeof cb === "function") { process.nextTick(cb, err); return; }
      throw err;
    }
    return f.apply(this, arguments);
  };
}

function wrapExec(name, label) {
  const f = orig[name];
  cp[name] = function () {
    const a = Array.prototype.slice.call(arguments);
    const lib = /[\\/]node_modules[\\/]/.test(new Error().stack || "");
    // options position: execSync(cmd, opts) -> 1; execFileSync/spawnSync(file, args?, opts) -> 2 when args is an array, else 1
    const idx = name === "execSync" ? 1 : (Array.isArray(a[1]) ? 2 : 1);
    const o = a[idx];
    if (lib) { /* a library's own sync call: traced, not given a timeout */ }
    else if (o === undefined) a[idx] = { timeout: DEFAULT_EXEC_TIMEOUT_MS };
    else if (o && typeof o === "object" && o.timeout === undefined) a[idx] = Object.assign({}, o, { timeout: DEFAULT_EXEC_TIMEOUT_MS });
    const what = label + " " + String(a[0]).slice(0, 150);
    const t0 = begin(what);
    try { return f.apply(cp, a); } finally { end(t0, what); }
  };
}

let installed = false;
function install() {
  if (!ON || installed) return;
  installed = true;
  fs.readFileSync = guardedReadFileSync;
  wrapWrite(fs, "writeFileSync", [0]); wrapWrite(fs, "appendFileSync", [0]); wrapWrite(fs, "renameSync", [0, 1]);
  wrapWrite(fs, "unlinkSync", [0]); wrapWrite(fs, "copyFileSync", [1]); wrapWrite(fs, "rmSync", [0]);
  wrapWrite(fs, "writeFile", [0]); wrapWrite(fs, "appendFile", [0]); wrapWrite(fs, "rename", [0, 1]);
  wrapWrite(fs, "unlink", [0]); wrapWrite(fs, "copyFile", [1]); wrapWrite(fs, "rm", [0]); wrapWrite(fs, "createWriteStream", [0]);
  for (const n of ["writeFile", "appendFile", "rename", "unlink", "copyFile", "rm"]) {
    const f = fs.promises[n];
    if (f) { const idx = n === "rename" ? [0, 1] : n === "copyFile" ? [1] : [0]; fs.promises[n] = function () { try { for (const i of idx) drop(arguments[i]); } catch (e) { /* hygiene */ } return f.apply(this, arguments); }; }
  }
  wrapOverwrite(fs, "writeFileSync"); wrapOverwrite(fs, "writeFile"); wrapOverwrite(fs.promises, "writeFile");
  wrapExec("execSync", "execSync"); wrapExec("execFileSync", "execFileSync"); wrapExec("spawnSync", "spawnSync");
}

// start({ logPath, cacheRoots }): after app.getPath("userData") is usable. Safe to call again with new roots.
function start(o) {
  if (!ON) return;
  o = o || {};
  cacheRoots = (o.cacheRoots || []).filter(Boolean).map((r) => lc(path.resolve(r)));
  if (started || !o.logPath) return;
  started = true;
  try {
    worker = new Worker(WATCH_SRC, { eval: true, workerData: { sab, logPath: o.logPath } });
    worker.unref();
    worker.on("error", () => { worker = null; });
  } catch (e) { worker = null; }
}
function takeSlowest() { const s = slowest; slowest = { ms: 0, label: "" }; return s; }
function stats() { return { on: ON, timedOut: timedOut.size, cacheEntries: cache.size, roots: cacheRoots.slice(), readTimeoutMs: READ_TIMEOUT_MS }; }
function clearCache() { cache.clear(); }

function _markTimedOut(p) { timedOut.set(path.resolve(p), Date.now()); }   // test hook
module.exports = { _markTimedOut, install, start, warmRoot, prefetchDir, takeSlowest, stats, clearCache, _orig: orig };
