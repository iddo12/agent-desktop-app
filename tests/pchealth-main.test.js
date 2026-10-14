// node tests/pchealth-main.test.js - PC health collector lifecycle (src/pcHealthMain.js) against a fake collector (tests/fixtures/fake-pc-health.js).
// Real child processes, so "killed by PID, no orphan, never two at once" is checked for real.
"use strict";
const assert = require("assert");
const path = require("path");
const cp = require("child_process");
const M = require("../src/pcHealthMain");
const FAKE = path.join(__dirname, "fixtures", "fake-pc-health.js");

let n = 0, fails = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
async function until(fn, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await sleep(25); } throw new Error("timeout waiting for " + what); }

// a spawn that runs the fake with node instead of python, in a chosen mode, remembering every pid it started
function rig(mode, extra) {
  const pids = [];
  const events = { data: [], status: [] };
  const spawn = (py, args, opts) => {
    const child = cp.spawn(process.execPath, [FAKE, ...args.slice(1)], Object.assign({}, opts, { env: Object.assign({}, opts.env, { FAKE_MODE: typeof mode === "function" ? mode(args) : mode }) }));
    pids.push(child.pid);
    return child;
  };
  const c = M.createCollector(Object.assign({ script: FAKE, spawn, onData: (d, m) => events.data.push([d, m]), onStatus: (s) => events.status.push(s), killGraceMs: 2000 }, extra || {}));
  const aliveCount = () => pids.filter(alive).length;
  return { c, pids, events, aliveCount, states: () => events.status.map((s) => s.state + (s.reason ? ":" + s.reason : "")) };
}
async function t(name, fn) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + (e.stack || e.message)); } }

(async () => {
  await t("line parser: split chunks, several lines per chunk, junk ignored", () => {
    const got = [], bad = [];
    const p = M.createLineParser((o) => got.push(o), (b) => bad.push(b));
    p.push('{"a":1}\n{"b"'); p.push(':2}\nnot json\n[1,2]\n'); p.push('{"c":3}');
    assert.deepStrictEqual(got, [{ a: 1 }, { b: 2 }]);
    assert.strictEqual(bad.length, 2);
    p.end();
    assert.deepStrictEqual(got[2], { c: 3 });
  });

  await t("live: lines forwarded (even when split), running status, one process, stop kills it by PID", async () => {
    const r = rig("stream");
    const s = r.c.startLive();
    assert.ok(s.ok && s.pid);
    await until(() => r.events.data.length >= 3, 4000, "3 ticks");
    assert.strictEqual(r.events.data[0][0].elapsed_s, 1, "split first line reassembled");
    assert.ok(r.states().includes("running"));
    assert.deepStrictEqual(r.c.startLive(), { ok: true, already: true }, "a second start must not spawn another");
    assert.strictEqual(r.pids.length, 1);
    r.c.stop("user");
    await until(() => r.aliveCount() === 0, 5000, "process gone");
    await until(() => !r.c.present(), 5000, "slot freed");
    assert.ok(r.states().includes("stopped:user"));
    const before = r.events.data.length; await sleep(300);
    assert.strictEqual(r.events.data.length, before, "no data after stop");
  });

  await t("restart right after stop never has two alive at once", async () => {
    const r = rig("stream");
    r.c.startLive();
    await until(() => r.events.data.length >= 1, 4000, "first tick");
    let maxAlive = 0; const poll = setInterval(() => { maxAlive = Math.max(maxAlive, r.aliveCount()); }, 10);
    r.c.stop("window-hidden");
    r.c.startLive();           // queued until the old one is gone
    r.c.stop("user"); r.c.startLive(); // mashing
    await until(() => r.pids.length >= 2 && r.events.data.length > 1, 6000, "second run");
    r.c.stop("left");
    await until(() => r.aliveCount() === 0, 5000, "all gone");
    clearInterval(poll);
    assert.ok(maxAlive <= 1, "max alive was " + maxAlive);
  });

  await t("collector exits with an error: clear message with exit code and stderr tail", async () => {
    const r = rig("exit1");
    r.c.startLive();
    await until(() => r.events.status.some((s) => s.state === "error"), 4000, "error status");
    const e = r.events.status.find((s) => s.state === "error");
    assert.ok(/exit code 1/.test(e.message) && /psutil/.test(e.message), e.message);
    await until(() => !r.c.present(), 3000, "slot freed");
  });

  await t("python missing (ENOENT): friendly message, no crash, slot freed", async () => {
    const events = [];
    const c = M.createCollector({ python: "no-such-python-xyz", script: FAKE, spawn: cp.spawn, onStatus: (s) => events.push(s), killGraceMs: 500 });
    c.startLive();
    await until(() => events.some((s) => s.state === "error"), 4000, "error");
    const e = events.find((s) => s.state === "error");
    assert.strictEqual(e.reason, "no-python");
    assert.ok(/Python was not found/.test(e.message));
    await until(() => !c.present(), 3000, "slot freed");
    c.stop("x");
  });

  await t("silent collector: stall watchdog reports and kills it", async () => {
    const r = rig("silent", { stallMs: 400 });
    r.c.startLive();
    await until(() => r.events.status.some((s) => s.reason === "stalled"), 5000, "stalled");
    await until(() => r.aliveCount() === 0, 5000, "killed");
  });

  await t("non-JSON output is ignored, JSON still delivered", async () => {
    const r = rig("garbage");
    r.c.startLive();
    await until(() => r.events.data.length >= 1, 4000, "a tick");
    assert.strictEqual(r.events.data.length, 1);
    r.c.stop("left"); await until(() => r.aliveCount() === 0, 5000, "gone");
  });

  await t("cap: collector ending cleanly at the cap -> stopped:cap", async () => {
    const r = rig("cleanexit", { capMs: 700 });
    r.c.startLive();
    await until(() => r.events.status.some((s) => s.reason === "cap"), 4000, "cap");
    assert.ok(!r.events.status.some((s) => s.state === "error"));
  });
  await t("cap: a collector that ignores its own cap is stopped by main's backstop", async () => {
    const r = rig("stream", { capMs: 500, capGraceMs: 100 });
    r.c.startLive();
    await until(() => r.events.status.some((s) => s.reason === "cap"), 4000, "backstop cap");
    await until(() => r.aliveCount() === 0, 5000, "gone");
  });
  await t("an early clean exit is NOT reported as the cap", async () => {
    const r = rig("cleanexit", { capMs: 300000 });
    r.c.startLive();
    await until(() => r.events.status.some((s) => s.state === "error"), 4000, "error");
  });

  await t("snapshot: one JSON (pretty-printed) parsed, flagged, snapshot-done", async () => {
    const r = rig("snapshot");
    r.c.startSnapshot();
    await until(() => r.events.status.some((s) => s.reason === "snapshot-done"), 4000, "done");
    assert.strictEqual(r.events.data.length, 1);
    assert.strictEqual(r.events.data[0][1].snapshot, true);
    assert.strictEqual(r.events.data[0][0].top_procs[0].name, "a.exe");
    await until(() => r.aliveCount() === 0, 3000, "exited");
  });

  await t("snapshot while live: live is stopped first, never two alive", async () => {
    const r = rig((args) => (args.includes("--stream") ? "stream" : "snapshot"));
    r.c.startLive();
    await until(() => r.events.status.some((s) => s.state === "running"), 4000, "live");
    let maxAlive = 0; const poll = setInterval(() => { maxAlive = Math.max(maxAlive, r.aliveCount()); }, 10);
    r.c.startSnapshot();
    await until(() => r.events.status.some((s) => s.reason === "snapshot-done"), 8000, "snapshot done");
    clearInterval(poll);
    assert.ok(maxAlive <= 1, "max alive " + maxAlive);
    assert.strictEqual(r.pids.length, 2);
  });

  await t("killNowSync kills the running collector", async () => {
    const r = rig("stream");
    r.c.startLive(); await until(() => r.events.data.length >= 1, 4000, "tick");
    r.c.killNowSync();
    await until(() => r.aliveCount() === 0, 5000, "gone");
  });


  // ---- init(): window events, with a fake window / ipc and the fake collector run by node ----
  function initRig(capMs) {
    const EE = require("events");
    process.env.FAKE_MODE = "stream";
    process.env.AD_PCHEALTH_PYTHON = process.execPath; process.env.AD_PCHEALTH_SCRIPT = FAKE;
    const w = new EE(); w.webContents = new EE(); w.sent = []; w.webContents.send = (ch, p) => w.sent.push([ch, p]);
    w.vis = true; w.min = false; w.isVisible = () => w.vis; w.isMinimized = () => w.min; w.isDestroyed = () => false;
    const handlers = {}; const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
    const app = new EE();
    const h = M.init({ ipcMain, app, getMainWindow: () => w, testMode: true, log: () => {}, capMs });
    const call = (ch, payload) => handlers[ch]({ sender: w.webContents }, payload);
    const pids = () => { const out = cp.execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*fake-pc-health.js*' } | ForEach-Object { $_.ProcessId }"], { encoding: "utf8", windowsHide: true }); return out.split(/\s+/).filter(Boolean); };
    return { w, call, h, pids, statuses: () => w.sent.filter((x) => x[0] === "pchealth-status").map((x) => x[1].state + (x[1].reason ? ":" + x[1].reason : "")) };
  }
  await t("init: an iframe (sub-frame) navigation does not stop live; a main-frame reload does", async () => {
    const r = initRig();
    await r.call("pchealth-start");
    await until(() => r.h.collector.active() && r.statuses().includes("running"), 8000, "running");
    r.w.webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    r.w.webContents.emit("did-start-loading");
    await sleep(400);
    assert.ok(r.h.collector.active(), "subframe navigation must not stop the collector");
    r.w.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    await sleep(300);
    assert.ok(r.h.collector.active(), "same-document navigation must not stop it");
    r.w.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await until(() => !r.h.collector.present(), 6000, "stopped by reload");
    assert.ok(r.statuses().includes("stopped:reload"));
    assert.strictEqual(M.isMainFrameNavigation({}, "u", false, true), true);
    assert.strictEqual(M.isMainFrameNavigation({}, "u", false, false), false);
  });
  await t("init: after the cap, minimise/restore does NOT restart live; Resume (start) does", async () => {
    const r = initRig(600);
    await r.call("pchealth-start");
    await until(() => r.statuses().includes("stopped:cap"), 8000, "cap");
    await until(() => !r.h.collector.present(), 6000, "gone");
    r.w.min = true; r.w.emit("minimize"); await sleep(300);
    r.w.min = false; r.w.emit("restore"); await sleep(800);
    assert.ok(!r.h.collector.present(), "must stay stopped after cap + minimise/restore");
    await r.call("pchealth-start");
    await until(() => r.h.collector.active(), 6000, "resumed by the user");
    await r.call("pchealth-stop", { reason: "user" });
    await until(() => !r.h.collector.present(), 6000, "stopped");
  });
  await t("init: window hidden then restored restarts live only while the panel wants it", async () => {
    const r = initRig();
    await r.call("pchealth-start");
    await until(() => r.h.collector.active(), 8000, "live");
    r.w.min = true; r.w.emit("minimize");
    await until(() => !r.h.collector.present(), 6000, "paused on minimise");
    r.w.min = false; r.w.emit("restore");
    await until(() => r.h.collector.active(), 8000, "restarted on restore");
    await r.call("pchealth-stop", { reason: "left" });
    await until(() => !r.h.collector.present(), 6000, "stopped");
    r.w.min = true; r.w.emit("minimize"); r.w.min = false; r.w.emit("restore"); await sleep(600);
    assert.ok(!r.h.collector.present(), "left the panel: nothing restarts");
  });
  await t("collector cwd is the script's folder (not %TEMP%)", async () => {
    let got = null;
    const c = M.createCollector({ script: FAKE, spawn: (py, args, opts) => { got = opts.cwd; return cp.spawn(process.execPath, [FAKE], Object.assign({}, opts, { env: Object.assign({}, opts.env, { FAKE_MODE: "silent" }) })); }, onStatus: () => {}, killGraceMs: 1000 });
    c.startLive(); assert.strictEqual(got, path.dirname(FAKE)); c.stop("x");
    await until(() => !c.present(), 6000, "gone");
  });
  console.log(fails ? `pchealth-main: ${fails} of ${n} FAILED` : `pchealth-main: all ${n} passed`);
  process.exit(fails ? 1 : 0);
})();
