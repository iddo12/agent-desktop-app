// PC health panel (v1.111.0) - main-process side. Nothing runs until the panel asks. One collector process at a time:
//   python <pcHealthScript> --stream --interval 1 --max-seconds 300   (one JSON object per line per tick)
//   python <pcHealthScript> --seconds 15                              (one-shot "Snapshot")
// v1.121.0: the script is the appConfig key "pcHealthScript" (default <sharedTools>/pc_health/pc_health.py) and python is the person's pythonExe
// setting or the bare `python` command. Without the script the panel shows a calm "needs setup" state (feature "pcHealth"); nothing is spawned.
// The collector is read-only. This module spawns it hidden (windowsHide), forwards each parsed line to the renderer, and kills it
// (whole tree, by PID) when the panel is left, the window is hidden/minimised, the 5-minute cap passes, the page reloads or the app quits.
// createCollector() has no Electron dependency (spawn / killTree are injected) so tests/pchealth-main.test.js drives it with a fake collector.
"use strict";

const path = require("path");
const os = require("os");
const child_process = require("child_process");

const CAP_MS = 300 * 1000;        // live stops by itself after 5 minutes
const STALL_MS = 25 * 1000;       // no line for this long while live = something is wrong
const SNAPSHOT_SECONDS = 15;
const KILL_GRACE_MS = 5000;       // after taskkill, force-forget a process that never reports closing
const MAX_LINE = 2 * 1024 * 1024; // a collector line is ~3 KB; anything this big is garbage

// Splits a byte stream into JSON lines. Partial lines wait for the next chunk; non-JSON lines are counted, never thrown.
function createLineParser(onObject, onBad) {
  let buf = "";
  const take = (line) => {
    line = line.trim();
    if (!line) return;
    let o;
    try { o = JSON.parse(line); } catch (e) { if (onBad) onBad(line.slice(0, 120)); return; }
    if (o && typeof o === "object" && !Array.isArray(o)) onObject(o); else if (onBad) onBad(line.slice(0, 120));
  };
  return {
    push(chunk) {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.length <= MAX_LINE) take(line); }
      if (buf.length > MAX_LINE) buf = "";
    },
    end() { const rest = buf; buf = ""; if (rest.trim()) take(rest); },
  };
}

function killTreeDefault(pid, done) {
  child_process.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }, () => { if (done) done(); });
}
function killTreeSync(pid) {
  try { child_process.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }); } catch (e) { /* best effort at exit */ }
}

function createCollector(o) {
  const spawn = o.spawn || child_process.spawn;
  const killTree = o.killTree || killTreeDefault;
  // python / script may be functions, read at every start, so a change made in Setup applies without a restart (null script = needs setup)
  const pythonNow = () => (typeof o.python === "function" ? o.python() : o.python) || "python";
  const scriptNow = () => (typeof o.script === "function" ? o.script() : o.script) || null;
  const capMs = o.capMs || CAP_MS;
  const stallMs = o.stallMs || STALL_MS;
  const killGraceMs = o.killGraceMs || KILL_GRACE_MS;
  const capGraceMs = o.capGraceMs == null ? 3000 : o.capGraceMs;
  const onData = o.onData || (() => {});
  const onStatus = o.onStatus || (() => {});
  const log = o.log || (() => {});
  const now = o.now || Date.now;

  let cur = null;        // { token, child, mode, killed, startedAt, lastActivity, stderr, timers, closed }
  let queued = null;     // a start requested while the previous process was still dying
  let tokenSeq = 0;

  function clearTimers(c) { for (const t of c.timers) { clearTimeout(t); clearInterval(t); } c.timers = []; }

  function finish(c) { // the process is gone (or forgotten): free the slot, then run a queued start
    if (c.closed) return;
    c.closed = true;
    clearTimers(c);
    if (cur === c) cur = null;
    log(`collector ${c.mode} pid=${c.pid} gone`);
    if (!cur && queued) { const q = queued; queued = null; start(q); }
  }

  function fail(c, message, reason) {
    if (c.closed || c.killed) return;
    c.killed = true;
    clearTimers(c);
    onStatus({ state: "error", mode: c.mode, reason: reason || "error", message });
    killIt(c);
  }

  function killIt(c) {
    try { if (c.child.stdin) c.child.stdin.destroy(); } catch (e) { /* already closed */ }
    if (c.pid) killTree(c.pid, () => {});
    c.timers.push(setTimeout(() => { // the process never reported closing: forget it rather than block the next start forever
      try { c.child.kill("SIGKILL"); } catch (e) { /* gone */ }
      finish(c);
    }, killGraceMs));
  }

  function start(mode) {
    if (cur) {
      if (cur.killed) { queued = mode; return { ok: true, queued: true }; } // never two at once: wait for the old one to be gone
      if (cur.mode === mode) return { ok: true, already: true };
      queued = mode; stop("switch"); return { ok: true, queued: true };
    }
    const script = scriptNow();
    if (!script) {
      onStatus({ state: "needs-setup", mode, reason: "needs-setup", message: NEEDS_SETUP_MESSAGE });
      return { ok: false, reason: "needs-setup" };
    }
    const python = pythonNow();
    const cwd = o.cwd || path.dirname(script); // the script's own folder: a python.exe dropped in %TEMP% is never picked up by the search
    const args = mode === "snapshot" ? [script, "--seconds", String(SNAPSHOT_SECONDS)]
      : [script, "--stream", "--interval", "1", "--max-seconds", String(Math.round(capMs / 1000))];
    const c = { token: ++tokenSeq, child: null, pid: null, mode, killed: false, closed: false, startedAt: now(), lastActivity: now(), stderr: "", timers: [], snapChunks: [] };
    let child;
    try {
      child = spawn(python, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" }) });
    } catch (e) {
      onStatus({ state: "error", mode, reason: "spawn", message: spawnMessage(e) });
      return { ok: false, error: String(e && e.message || e) };
    }
    c.child = child; c.pid = child.pid || null; cur = c;
    log(`collector ${mode} spawned pid=${c.pid}`);
    onStatus({ state: "starting", mode });

    const parser = createLineParser((obj) => {
      if (c.killed || c.closed) return;
      c.lastActivity = now();
      if (mode === "live") {
        if (!c.sawData) { c.sawData = true; onStatus({ state: "running", mode }); }
        onData(obj, { snapshot: false });
      }
    }, (bad) => { c.bad = (c.bad || 0) + 1; if (c.bad <= 3) log(`collector non-JSON line ignored: ${bad}`); });
    if (child.stdout) child.stdout.on("data", (chunk) => {
      c.lastActivity = now();
      if (mode === "snapshot") c.snapChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      else parser.push(chunk);
    });
    if (child.stderr) child.stderr.on("data", (chunk) => { c.stderr = (c.stderr + chunk.toString("utf-8")).slice(-1500); });
    if (child.stdin) child.stdin.on("error", () => {});

    child.on("error", (e) => { // ENOENT = no python on PATH
      fail(c, spawnMessage(e), e && e.code === "ENOENT" ? "no-python" : "spawn");
      finish(c);
    });
    child.on("close", (code) => {
      if (c.closed) return;
      if (!c.killed) { // it ended on its own
        parser.end();
        if (mode === "snapshot") {
          let obj = null;
          try { obj = JSON.parse(Buffer.concat(c.snapChunks).toString("utf-8")); } catch (e) { obj = null; }
          if (obj && typeof obj === "object") { onData(obj, { snapshot: true }); onStatus({ state: "stopped", mode, reason: "snapshot-done" }); }
          else onStatus({ state: "error", mode, reason: "exit", message: exitMessage(code, c.stderr, "The snapshot did not return readable data") });
        } else if (code === 0 && now() - c.startedAt >= capMs * 0.9) {
          onStatus({ state: "stopped", mode, reason: "cap" });
        } else {
          onStatus({ state: "error", mode, reason: "exit", message: exitMessage(code, c.stderr, "The collector stopped unexpectedly") });
        }
      }
      finish(c);
    });

    // watchdogs
    const limit = mode === "snapshot" ? SNAPSHOT_SECONDS * 1000 + stallMs : stallMs;
    c.timers.push(setInterval(() => { if (!c.killed && now() - c.lastActivity > limit) fail(c, `No data from the collector for ${Math.round(limit / 1000)} s. Pause and resume, or try the Snapshot button.`, "stalled"); }, Math.max(250, Math.min(5000, Math.round(limit / 5)))));
    if (mode === "live") c.timers.push(setTimeout(() => { if (!c.killed) stop("cap"); }, capMs + capGraceMs)); // the collector caps itself; this is the belt to its braces
    return { ok: true, pid: c.pid };
  }

  function stop(reason) {
    const c = cur;
    if (!c || c.killed || c.closed) return false;
    c.killed = true;
    clearTimers(c);
    log(`collector ${c.mode} pid=${c.pid} stopping (${reason})`);
    onStatus({ state: "stopped", mode: c.mode, reason: reason || "stopped" });
    killIt(c);
    return true;
  }

  return {
    startLive: () => start("live"),
    startSnapshot: () => start("snapshot"),
    stop,
    cancelQueued: () => { queued = null; },
    active: () => !!(cur && !cur.killed),
    present: () => !!cur,           // true while a process exists, even one being killed
    mode: () => (cur ? cur.mode : null),
    pid: () => (cur ? cur.pid : null),
    killNowSync: () => { if (cur && cur.pid) killTreeSync(cur.pid); },
  };
}

const NEEDS_SETUP_MESSAGE = "PC Health needs Python and its measuring script (pc_health.py). Open Setup and press Set up on PC Health.";
function spawnMessage(e) {
  if (e && e.code === "ENOENT") return "Python was not found on this PC (the \"python\" command). The PC health panel needs it to read the machine's sensors.";
  return "Could not start the PC health collector: " + String((e && e.message) || e).slice(0, 200);
}
function exitMessage(code, stderr, lead) {
  const tail = String(stderr || "").trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 240);
  return `${lead} (exit code ${code}).` + (tail ? " " + tail : "");
}

// did-start-navigation arrives as (event-with-fields) in current Electron and as (event, url, isInPlace, isMainFrame) in older ones.
function isMainFrameNavigation(...args) {
  const ev = args[0];
  if (ev && typeof ev.isMainFrame === "boolean") return ev.isMainFrame && !ev.isSameDocument;
  if (ev && ev.details && typeof ev.details.isMainFrame === "boolean") return ev.details.isMainFrame && !ev.details.isSameDocument;
  return args[3] === true && args[2] !== true;
}

function init(deps0) {
  const { ipcMain, app, getMainWindow, testMode, log } = deps0;
  let { capMs } = deps0;
  const lg = (l) => { try { if (log) log("pchealth: " + l); } catch (e) { /* logging never breaks the panel */ } };
  const env = process.env;
  if (!capMs && testMode && +env.AD_PCHEALTH_CAP_MS > 0) capMs = +env.AD_PCHEALTH_CAP_MS; // sandbox: a short cap to watch it happen
  // v1.121.0: both come from the configuration layer, read at every start. The sandbox overrides (AD_PCHEALTH_SCRIPT / _PYTHON) still win in test mode.
  const cfgm = () => { try { return deps0.cfg || require("./appConfig"); } catch (e) { return null; } };
  const testScript = testMode && env.AD_PCHEALTH_SCRIPT ? env.AD_PCHEALTH_SCRIPT : null;
  const script = () => {
    if (testScript) return testScript;
    const c = cfgm(); if (!c) return null;
    try { return c.isReady("pcHealth") ? c.get("pcHealthScript") : null; } catch (e) { return null; }
  };
  const python = () => {
    if (testMode && env.AD_PCHEALTH_PYTHON) return env.AD_PCHEALTH_PYTHON;
    return launchPython();
  };
  const launchPython = () => { // the person's pythonExe setting if it still exists, else the bare command the old code ran
    try { return require("./launchEnv").createLaunchEnv({ cfg: cfgm() }).pythonCommand(); } catch (e) { return "python"; }
  };
  const assumeVisible = !!(testMode && env.AD_PCHEALTH_ASSUME_VISIBLE === "1"); // sandbox windows stay hidden, so they would otherwise auto-pause
  let wanted = false;           // the panel is open and wants live data (not user-paused)
  const attached = new WeakSet();

  const win = () => { const w = getMainWindow(); return w && !w.isDestroyed() ? w : null; };
  const send = (ch, p) => { const w = win(); if (w) { try { w.webContents.send(ch, p); } catch (e) { /* window closing */ } } };
  const visible = () => { const w = win(); return !!w && (assumeVisible || (w.isVisible() && !w.isMinimized())); };

  const collector = createCollector({
    python, script, log: lg, capMs,
    cwd: testMode ? os.tmpdir() : undefined, // the sandbox's cwd guard only accepts folders inside the sandbox / temp
    onData: (d, meta) => send("pchealth-data", Object.assign({}, d, meta && meta.snapshot ? { snapshot: true } : {})),
    onStatus: (s) => {
      lg(`status ${s.state}${s.reason ? " " + s.reason : ""}`);
      // after the 5-minute cap or an error nothing may restart by itself (minimise/restore): the user presses Resume live
      if (s.state === "error" || s.state === "needs-setup" || (s.state === "stopped" && s.reason === "cap")) wanted = false;
      send("pchealth-status", s);
    },
  });

  function sync() { // one place that decides whether live data should be flowing right now
    if (wanted && visible()) { if (!collector.active() || collector.mode() !== "live") collector.startLive(); }
    else if (collector.mode() === "live" && collector.active()) {
      collector.stop(wanted ? "window-hidden" : "left");
    } else if (!wanted) collector.cancelQueued();
  }
  function stopAll(reason) { wanted = false; collector.cancelQueued(); collector.stop(reason || "left"); }

  function attach(w) {
    if (attached.has(w)) return;
    attached.add(w);
    for (const ev of ["minimize", "restore", "show", "hide"]) w.on(ev, () => setTimeout(sync, 50));
    w.on("closed", () => stopAll("closed"));
    w.webContents.on("did-start-navigation", (...a) => { if (isMainFrameNavigation(...a)) stopAll("reload"); }); // not iframes (docs, library)
    w.webContents.on("render-process-gone", () => stopAll("gone"));
  }
  const fromApp = (event) => { const w = win(); return !!w && event.sender === w.webContents; };

  ipcMain.handle("pchealth-start", (event) => {
    if (!fromApp(event)) return { ok: false, reason: "not from the main window" };
    attach(win());
    wanted = true;
    if (!visible()) { send("pchealth-status", { state: "stopped", mode: "live", reason: "window-hidden" }); return { ok: true, visible: false }; }
    const r = collector.startLive();
    return Object.assign({ visible: true }, r);
  });
  ipcMain.handle("pchealth-stop", (event, payload) => {
    if (!fromApp(event)) return { ok: false, reason: "not from the main window" };
    stopAll(payload && payload.reason === "user" ? "user" : "left");
    return { ok: true };
  });
  ipcMain.handle("pchealth-snapshot", (event) => {
    if (!fromApp(event)) return { ok: false, reason: "not from the main window" };
    attach(win());
    wanted = false; // the snapshot replaces live until the user resumes
    return collector.startSnapshot();
  });

  const quit = () => { wanted = false; collector.cancelQueued(); collector.stop("quit"); collector.killNowSync(); };
  app.on("before-quit", quit);
  app.on("will-quit", quit);
  process.on("exit", () => { try { collector.killNowSync(); } catch (e) { /* exiting anyway */ } });
  return { collector, sync };
}

module.exports = { init, isMainFrameNavigation, createCollector, createLineParser, spawnMessage, exitMessage, CAP_MS, STALL_MS, NEEDS_SETUP_MESSAGE };
