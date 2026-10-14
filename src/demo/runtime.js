// Demo mode (v1.86.0): AGENT_DESKTOP_DEMO=1 makes Agent Desktop show ONLY invented data (the fictional "Aurora Studio"), for videos.
// Required first thing from main.js (via ./index.js, which only loads this file when the variable is set). Responsibilities:
//   1. point every location the app reads at the demo base folder (env + user-profile redirect) and build it from the fixtures;
//   2. replace the few IPC handlers that would touch the machine, the network or the real CLI (overrides.js);
//   3. give main.js the small set of hooks it calls (fake sessions, window UI, no background sweeps).
// Demo mode runs on top of the existing sandbox ("test mode") isolation: dangerous sweeps are off and writes outside the base are refused.
"use strict";
const fs = require("fs");
const path = require("path");
const { resolvePaths, VIRTUAL_REPORTS } = require("./paths");

const P = resolvePaths(process.env);
const state = { P, ctx: null, studio: null, rateFile: null, rate: null, threads: new Map() };

// ---- 1. environment -----------------------------------------------------------------------------------------
process.env.AGENT_DESKTOP_TEST_MODE = "1";                       // sandbox isolation (no sweeps, no reaping, guarded writes)
process.env.AGENT_DESKTOP_ROOT = P.root;
process.env.AGENT_DESKTOP_TEST_ALLOW_WRITE = P.base;             // the one place demo mode may write
process.env.AGENT_DESKTOP_HEALTH_ROOT = P.health;                // My Health store root
process.env.AGENT_DESKTOP_DAILY_REAL_TASKS = "1";                // My Daily reads the task store from the (demo) root, not built-in samples
process.env.AGENT_DESKTOP_THROTTLE_FILE = path.join(P.root, "usage_now.json");
// The user profile moves into the base folder, so every "~/.claude" read lands in the demo world (os.homedir() follows USERPROFILE/HOME).
process.env.USERPROFILE = P.home;
process.env.HOME = P.home;
process.env.APPDATA = path.join(P.home, "AppData", "Roaming");
process.env.LOCALAPPDATA = path.join(P.home, "AppData", "Local");

const { materialize } = require("./materialize");
const built = materialize(P, { now: Date.now(), pid: process.pid });
state.studio = built.studio;
state.rateFile = built.rateFile;
state.rate = built.rate;

// Keep the usage bars "fresh": the cache has an age that the tooltips show. Rewritten once a minute while the app runs.
const refreshRate = () => { try { fs.writeFileSync(state.rateFile, JSON.stringify(state.rate(), null, 2)); } catch (e) { /* cosmetic */ } };
setInterval(refreshRate, 60 * 1000).unref();

// ---- 2. IPC overrides -----------------------------------------------------------------------------------------
function installIpcPatch() {
  const { ipcMain } = require("electron");
  const overrides = require("./overrides");
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    const ov = overrides.handlers[channel];
    return origHandle(channel, ov ? (event, arg) => ov(event, arg, listener, state) : listener);
  };
}
installIpcPatch();
// A main-process error must be logged, never shown as a blocking dialog on screen (a listener suppresses Electron's error box).
const errLog = path.join(P.base, "demo-errors.log");
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { try { fs.appendFileSync(errLog, new Date().toISOString() + " " + ev + ": " + String(e && e.stack || e).slice(0, 1500) + "\n"); } catch (x) { /* nothing more to do */ } });
// Channels whose handlers are not registered in demo mode (IRIS is off): answer "nothing" so the renderer's polls stay quiet.
(function stubs() {
  const { ipcMain } = require("electron");
  const none = { "iris-pending": () => [], "iris-status": () => ({ enabled: false, me: {}, peers: [], addresses: [], listening: false }), "iris-log": () => [] };
  for (const ch of Object.keys(none)) { try { ipcMain.handle(ch, none[ch]); } catch (e) { /* already registered */ } }
})();

// Optional read audit (AGENT_DESKTOP_DEMO_AUDIT=1): every file-system READ outside the demo base, the fixtures, the app's own folder and
// Electron's own folder is appended to <base>\demo-reads.log (one line per distinct path). Used to prove demo mode reads nothing real.
if (process.env.AGENT_DESKTOP_DEMO_AUDIT === "1") {
  const allowed = [P.base, P.fixtures, P.repo, path.dirname(process.execPath)].map((x) => path.resolve(x).toLowerCase());
  const seen = new Set();
  const log = path.join(P.base, "demo-reads.log");
  const note = (p) => {
    try {
      if (p === undefined || p === null || typeof p === "number") return;
      const s = p instanceof URL ? require("url").fileURLToPath(p) : String(p);
      if (/^node:|^\\\\\.\\pipe/.test(s)) return;
      const r = path.resolve(s).toLowerCase();
      if (allowed.some((a) => r === a || r.startsWith(a + path.sep)) || r.indexOf(path.sep + "node_modules" + path.sep) >= 0 || seen.has(r)) return; // node_modules = program code, not data
      seen.add(r);
      fs.appendFileSync(log, path.resolve(s) + "\n");
    } catch (e) { /* audit only */ }
  };
  for (const n of ["readFileSync", "readdirSync", "statSync", "lstatSync", "existsSync", "openSync", "accessSync", "realpathSync", "createReadStream"]) {
    const o = fs[n]; if (typeof o !== "function") continue;
    const w = function (p, ...a) { note(p); return o.call(this, p, ...a); };
    if (o.native) w.native = function (p, ...a) { note(p); return o.native.call(this, p, ...a); };
    fs[n] = w;
  }
  for (const n of ["readFile", "readdir", "stat", "lstat", "access", "open", "realpath"]) {
    const o = fs[n]; if (typeof o === "function") fs[n] = function (p, ...a) { note(p); return o.call(this, p, ...a); };
    const op = fs.promises[n]; if (typeof op === "function") fs.promises[n] = function (p, ...a) { note(p); return op.call(this, p, ...a); };
  }
}

function readThread(folder) {
  if (state.threads.has(folder)) return state.threads.get(folder);
  let t = { messages: [] };
  try { t = JSON.parse(fs.readFileSync(path.join(P.fixtures, "agents", folder, "thread.json"), "utf8").replace(/^\uFEFF/, "")); } catch (e) { /* none */ }
  state.threads.set(folder, t);
  return t;
}

// ---- 3. hooks for main.js ---------------------------------------------------------------------------------------
module.exports = {
  ON: true,
  P,
  VIRTUAL_REPORTS,
  state,
  // main.js hands over the session internals once they exist.
  attach(ctx) { state.ctx = ctx; },
  threadFor: readThread,
  windowOptions() { return process.env.AGENT_DESKTOP_DEMO_OFFSCREEN === "1" ? { x: -12000, y: -12000, width: 1900, height: 1140, skipTaskbar: true } : {}; },
  agentInfo(folder) { return (state.studio.agents || []).find((a) => a.folder === folder) || null; },
  // window UI: no sandbox label, demo-only nav entry (My Finance) and the hidden destinations
  injectUi(webContents) {
    const dir = path.join(__dirname, "renderer");
    webContents.on("did-finish-load", () => {
      try {
        let fin = "null";
        try { fin = JSON.stringify(JSON.parse(fs.readFileSync(path.join(P.fixtures, "finance.json"), "utf8").replace(/^\uFEFF/, ""))); } catch (e) { /* no finance fixture: empty view */ }
        webContents.insertCSS(fs.readFileSync(path.join(dir, "demo.css"), "utf8"));
        webContents.executeJavaScript("window.__demoBase = " + JSON.stringify(path.join(P.base, "root")) + ";window.__demoFinance = " + fin + ";\n" + fs.readFileSync(path.join(dir, "demo-ui.js"), "utf8")).catch(() => {});
      } catch (e) { /* cosmetic */ }
    });
  },
};
