"use strict";
// v1.93.0 performance logger - OFF unless AD_PERF=1 (then it costs a few microseconds per IPC call).
//
// WHY. Every perf report so far (LOADTIME_REPORT.md, PERF_FIXES_REPORT.md) had to build its own
// throwaway harness to answer "where does the main thread spend its time?". This keeps the answer
// one environment variable away, in the real app, on any machine (the partner's slower PC included):
//
//   AD_PERF=1             per-IPC handler time (sync part + until the promise settles), event-loop
//                         stalls (> AD_PERF_STALL_MS, default 50 ms), event-loop delay histogram,
//                         per-process memory (app.getAppMetrics) every 15 s, named marks.
//   AD_PERF_FS=1          also count every synchronous fs call (count, ms, bytes) by caller file:line.
//   AD_PERF_FILE=<path>   where the jsonl goes (default <userData>\perf.jsonl).
//
// Output: one JSON object per line: {t, kind, ...}; t = ms since process start. A "summary" line
// (aggregates) every 30 s and at quit. Read it with tools/perf-summary.js.
//
// Outside AD_PERF=1, init() returns at once and nothing is wrapped: behaviour is unchanged.

const fs = require("fs");
const path = require("path");
const { performance, monitorEventLoopDelay } = require("perf_hooks");

const ON = process.env.AD_PERF === "1";
const FS_ON = ON && process.env.AD_PERF_FS === "1";
const STALL_MS = Number(process.env.AD_PERF_STALL_MS) || 50;

// time since process start, in ms (performance.now() starts at process start in Node/Electron main)
const now = () => Math.round(performance.now() * 10) / 10;

let out = null;
let pending = [];
function write(obj) {
  if (!ON) return;
  obj.t = obj.t === undefined ? now() : obj.t;
  const line = JSON.stringify(obj) + "\n";
  if (out) out.write(line); else pending.push(line);
}

const ipcStats = new Map(); // channel -> {n, syncSum, syncMax, totSum, totMax}
function ipcRecord(channel, syncMs, totMs) {
  let s = ipcStats.get(channel);
  if (!s) { s = { n: 0, syncSum: 0, syncMax: 0, totSum: 0, totMax: 0 }; ipcStats.set(channel, s); }
  s.n++; s.syncSum += syncMs; s.totSum += totMs;
  if (syncMs > s.syncMax) s.syncMax = syncMs;
  if (totMs > s.totMax) s.totMax = totMs;
  if (syncMs >= 20 || totMs >= 200) write({ kind: "ipc", ch: channel, sync: +syncMs.toFixed(1), total: +totMs.toFixed(1) });
}

function wrapIpc(ipcMain) {
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => origHandle(channel, function (...args) {
    const t0 = performance.now();
    let r;
    try { r = fn.apply(this, args); } catch (e) { const d = performance.now() - t0; ipcRecord(channel, d, d); throw e; }
    const t1 = performance.now();
    if (r && typeof r.then === "function") {
      return r.then((v) => { ipcRecord(channel, t1 - t0, performance.now() - t0); return v; },
        (e) => { ipcRecord(channel, t1 - t0, performance.now() - t0); throw e; });
    }
    ipcRecord(channel, t1 - t0, t1 - t0);
    return r;
  });
  const origOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = (channel, fn) => origOn(channel, function (...args) {
    const t0 = performance.now();
    try { return fn.apply(this, args); } finally { const d = performance.now() - t0; ipcRecord("on:" + channel, d, d); }
  });
}

// ---- synchronous fs accounting (AD_PERF_FS=1) -----------------------------------------------
const fsStats = new Map(); // "fn caller" -> {n, ms, bytes}
const FS_FNS = ["readFileSync", "statSync", "lstatSync", "readdirSync", "existsSync", "openSync", "readSync",
  "writeFileSync", "appendFileSync", "mkdirSync", "accessSync", "renameSync", "unlinkSync", "closeSync", "fstatSync", "copyFileSync", "rmSync"];
const SELF = __filename;
function callerOf() {
  const o = {};
  const lim = Error.stackTraceLimit;
  Error.stackTraceLimit = 14;
  Error.captureStackTrace(o, callerOf);
  Error.stackTraceLimit = lim;
  const lines = String(o.stack).split("\n").slice(1);
  const found = [];
  for (const l of lines) {
    if (l.includes(SELF) || l.includes("testGuard.js") || l.includes("node:") || l.includes("node_init")) continue;
    const m = /([^\\/()]+\.(?:js|cjs)):(\d+)/.exec(l);
    if (m) found.push(m[1] + ":" + m[2]);
    if (found.length === 2) break;
  }
  // two frames: the fs call site and who called it (helpers like jsonfile.js / fsRetry.js say little alone)
  return found.length ? found.join(" < ") : "?";
}
function wrapFs() {
  for (const name of FS_FNS) {
    const orig = fs[name];
    if (typeof orig !== "function") continue;
    fs[name] = function (...a) {
      const t0 = performance.now();
      let r;
      try { r = orig.apply(this, a); return r; } finally {
        const d = performance.now() - t0;
        const key = name + " " + callerOf();
        let s = fsStats.get(key);
        if (!s) { s = { n: 0, ms: 0, bytes: 0, maxMs: 0 }; fsStats.set(key, s); }
        s.n++; s.ms += d; if (d > s.maxMs) s.maxMs = d;
        if (name === "readFileSync" && r) s.bytes += r.length || 0;
        else if (name === "readSync" && typeof r === "number") s.bytes += r;
        if (d >= 50) write({ kind: "fs-slow", fn: key, ms: +d.toFixed(1), arg: typeof a[0] === "string" ? a[0].slice(-120) : undefined });
      }
    };
  }
}

// ---- event loop ------------------------------------------------------------------------------
let stallTotal = 0, stallCount = 0, stallWorst = 0;
function startLoopMonitor() {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const TICK = 20;
  let last = performance.now();
  const t = setInterval(() => {
    const n = performance.now();
    const late = n - last - TICK;
    last = n;
    if (late > STALL_MS) {
      stallTotal += late; stallCount++; if (late > stallWorst) stallWorst = late;
      write({ kind: "stall", ms: Math.round(late), at: Math.round(n - late) });
    }
  }, TICK);
  t.unref();
  return h;
}

let appRef = null, hist = null;
function memorySample() {
  if (!appRef) return;
  try {
    const procs = appRef.getAppMetrics().map((m) => ({
      type: m.type, pid: m.pid, ws: m.memory && m.memory.workingSetSize, priv: m.memory && m.memory.privateBytes,
      cpu: m.cpu && +m.cpu.percentCPUUsage.toFixed(2),
    }));
    const heap = process.memoryUsage();
    write({ kind: "mem", procs, mainHeapMB: +(heap.heapUsed / 1048576).toFixed(1), mainRssMB: +(heap.rss / 1048576).toFixed(1) });
  } catch (e) { /* metrics are best effort */ }
}

function summary(final) {
  const ipc = {};
  for (const [k, s] of ipcStats) ipc[k] = { n: s.n, syncSum: +s.syncSum.toFixed(1), syncMax: +s.syncMax.toFixed(1), totSum: +s.totSum.toFixed(1), totMax: +s.totMax.toFixed(1) };
  const fsTop = [...fsStats.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 60)
    .map(([k, s]) => ({ fn: k, n: s.n, ms: +s.ms.toFixed(1), maxMs: +s.maxMs.toFixed(1), bytes: s.bytes }));
  write({
    kind: final ? "final" : "summary", stallTotal: Math.round(stallTotal), stallCount, stallWorst: Math.round(stallWorst),
    loopDelay: hist ? { p50: +(hist.percentile(50) / 1e6).toFixed(1), p99: +(hist.percentile(99) / 1e6).toFixed(1), max: +(hist.max / 1e6).toFixed(1) } : null,
    ipc, fs: FS_ON ? fsTop : undefined,
  });
}

function mark(name, extra) { if (ON) write(Object.assign({ kind: "mark", name }, extra || {})); }

// AD_PERF_PROFILE=<seconds>: V8 CPU profile of the main process from start for that many seconds, written beside
// the jsonl as <file>.cpuprofile (open in Chrome DevTools > Performance, or tools/perf-summary.js).
function startProfile(seconds, file) {
  try {
    const inspector = require("inspector");
    const s = new inspector.Session();
    s.connect();
    s.post("Profiler.enable", () => s.post("Profiler.setSamplingInterval", { interval: 1000 }, () => s.post("Profiler.start")));
    setTimeout(() => {
      s.post("Profiler.stop", (err, res) => {
        if (!err && res) { try { fs.writeFileSync(file, JSON.stringify(res.profile)); } catch (e) { /* best effort */ } }
        write({ kind: "mark", name: "cpuprofile written", file, err: err ? String(err) : undefined });
        s.disconnect();
      });
    }, seconds * 1000).unref();
  } catch (e) { write({ kind: "mark", name: "cpuprofile failed", err: String(e) }); }
}

function init({ app, ipcMain }) {
  if (!ON) return false;
  appRef = app;
  const profS = Number(process.env.AD_PERF_PROFILE) || 0;
  if (profS > 0) startProfile(profS, (process.env.AD_PERF_FILE || path.join(require("os").tmpdir(), "ad-perf.jsonl")) + ".cpuprofile");
  wrapIpc(ipcMain);
  if (FS_ON) wrapFs();
  hist = startLoopMonitor();
  app.whenReady().then(() => {
    const file = process.env.AD_PERF_FILE || path.join(app.getPath("userData"), "perf.jsonl");
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { /* exists */ }
    out = fs.createWriteStream(file, { flags: "a" });
    for (const l of pending) out.write(l);
    pending = [];
    mark("app ready");
    memorySample();
    setInterval(memorySample, 15000).unref();
    setInterval(() => summary(false), 30000).unref();
  });
  app.on("will-quit", () => { summary(true); try { out && out.end(); } catch (e) { /* closing */ } });
  write({ kind: "mark", name: "perfLog init", pid: process.pid, startEpoch: Date.now() - performance.now(), fs: FS_ON });
  return true;
}

module.exports = { ON, init, mark, summary, now };
