// v1.96.0 wake-agent - main-process wiring. Loaded from main.js inside try/catch (a fault can only disable the pipe).
//   <userData>\wake\pipe-name          random pipe name of this start
//   <userData>\wake\wake_config.json   { "wakeable": [folder names], "neverWake": [extra names] }. Seeded ONCE (when the file
//                                      is missing) with every agent folder that is not never-wake / personal_data; a
//                                      folder added later is not wakeable until someone adds it here.
//   <userData>\wake\state.json         wake timestamps of the last 24 h for the rate limit (atomic temp+rename writes)
// Caller identity: no secret. identify(pid) walks the CLI process's ancestry (one async PowerShell / CIM walk, timeout,
// never on the main thread; `claude agents --json` is asked only when the claimant is the shipped CLI) and
// wakeAgent.verifyCaller accepts it only under the ONLY live `claude --bg` session of the COO
// Agent or Security folder, with a bg id Agent Desktop recorded itself (noteSession, called from main.js when it
// dispatches or finds a session). See the header of wakeAgent.js for what that does and does not guarantee.
// Log: <workspace>\shared_reports\coo\wake_log.jsonl (UTF-8, no BOM, rotated to .1 at 5 MB). The sandbox (test mode) uses its
// own userData, a "-test" pipe name and its own log file.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const W = require("./wakeAgent");

// v1.121.0: the two caller folders (directly under the workspace) are the configured roles roleCoo / roleSecurity, never literals.
// Exact folder names only (a role written with a trailing * is ignored here: a caller must be one precise folder). Not configured = no caller of that kind is accepted.
const ROLE_KEY = { coo: "roleCoo", security: "roleSecurity" };
// A role is ONE folder name under the workspace: no separators, drive letters or "..", checked again here where it becomes a path.
function folderNameOk(v) { return typeof v === "string" && !!v && !/[\\/:*?"<>|\0-\x1f]/.test(v) && v.indexOf("..") < 0 && !/^[. ]+$/.test(v); }
function callerFolders() {
  const out = {};
  let c = null;
  try { c = require("./appConfig"); } catch (e) { c = null; }
  for (const id of Object.keys(ROLE_KEY)) {
    const v = c ? c.get(ROLE_KEY[id]) : null;
    out[id] = typeof v === "string" && v && !v.endsWith("*") && folderNameOk(v) ? v : null;
  }
  return out;
}
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const PS_TIMEOUT_MS = 20000;

const recorded = { coo: new Set(), security: new Set() }; // bg ids Agent Desktop dispatched / found for the two callers

function callerForSessionCwd(workspace, sessionCwd) {
  if (!workspace || !sessionCwd) return null;
  const agentDir = path.resolve(path.dirname(sessionCwd)).toLowerCase();
  const folders = callerFolders();
  for (const id of W.ALLOWED_CALLERS) {
    if (!folders[id] || !folderNameOk(folders[id])) continue;
    const want = path.resolve(workspace, folders[id]).toLowerCase();
    if (agentDir === want && path.dirname(want) === path.resolve(workspace).toLowerCase()) return id;
  }
  return null;
}
// main.js: after `claude --bg` printed "backgrounded · <id>" (its own dispatch), and when the sweep finds exactly ONE live
// session for a folder (never when there are several - see findAliveBackgroundAgent).
function noteSession({ workspace, sessionCwd, id }) {
  const c = callerForSessionCwd(workspace, sessionCwd);
  if (c && typeof id === "string" && /^[0-9a-f]{6,}$/i.test(id)) recorded[c].add(id.toLowerCase());
}

// The live COO / Security bg sessions: listed by `claude agents --json` for the caller's session folder, alive (pid),
// AND with an id Agent Desktop recorded itself. B2-R2: when MORE than one live bg session exists in a caller's session
// folder (recorded or not - someone may have started a second `claude --bg` there), NO session is accepted for that
// caller; the conflict is returned so it can be logged. Returns { sessions, conflicts: [{ caller, ids }] }.
function callerSessions(bgAgents, workspace) {
  const live = { coo: [], security: [] };
  for (const a of Array.isArray(bgAgents) ? bgAgents : []) {
    if (!a || a.kind !== "background" || !a.pid || !a.cwd) continue;
    const c = callerForSessionCwd(workspace, a.cwd);
    if (c) live[c].push(a);
  }
  const sessions = [], conflicts = [];
  for (const c of W.ALLOWED_CALLERS) {
    if (live[c].length > 1) { conflicts.push({ caller: c, ids: live[c].map((a) => String(a.id || "?")) }); continue; }
    const a = live[c][0];
    if (!a || !a.id || !recorded[c].has(String(a.id).toLowerCase())) continue;
    sessions.push({ caller: c, id: String(a.id).toLowerCase(), pid: Number(a.pid), sessionId: a.sessionId || null });
  }
  return { sessions, conflicts };
}

// The whole process table in ONE CIM query (about 1 s, a consistent snapshot), then [claimed process, parent, ...] walked
// in JS as { pid, ppid, name, created (ms), cmd }. Async (execFile), with a timeout.
function processTable(opts) {
  const script =
    "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
    "$all = Get-CimInstance Win32_Process -OperationTimeoutSec 15 | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; " +
    "ppid=[int]$_.ParentProcessId; name=[string]$_.Name; created=$(if($_.CreationDate){[int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0}); " +
    "cmd=[string]$_.CommandLine } }; ConvertTo-Json -InputObject @($all) -Compress -Depth 3";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { encoding: "buffer", windowsHide: true, timeout: (opts && opts.timeoutMs) || PS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, out) => {
        if (err) return reject(err);
        try {
          const txt = Buffer.from(out).toString("utf8").replace(/^\ufeff/, "").trim();
          const j = txt ? JSON.parse(txt) : [];
          resolve(Array.isArray(j) ? j : [j]);
        } catch (e) { reject(e); }
      });
  });
}
function chainFromTable(table, pid, max) {
  const byPid = new Map((table || []).map((p) => [p.pid, p]));
  const out = [];
  let p = byPid.get(Number(pid));
  while (p && out.length < (max || 18)) {
    out.push(p);
    if (!p.ppid || p.ppid === p.pid || out.some((x) => x.pid === p.ppid)) break;
    p = byPid.get(p.ppid);
  }
  return out;
}
async function processChain(pid, opts) {
  return chainFromTable(await processTable(opts), pid, opts && opts.max);
}

function writeAtomic(file, text) {
  const tmp = file + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} throw e; }
}

function makeStateIo(stateFile) {
  return {
    // null = no file yet; throws on an unreadable file so the handler fails closed
    loadState: () => {
      let raw;
      try { raw = fs.readFileSync(stateFile, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
      const j = JSON.parse(raw.replace(/^﻿/, ""));
      if (!j || !Array.isArray(j.wakes)) throw new Error("state.json has no wakes array");
      return j;
    },
    saveState: (s) => writeAtomic(stateFile, JSON.stringify(s)),
  };
}

function makeAppendLog(logFile) {
  return (obj) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try {
      if (fs.statSync(logFile).size > LOG_ROTATE_BYTES) {
        try { fs.unlinkSync(logFile + ".1"); } catch (e) {}
        fs.renameSync(logFile, logFile + ".1");
      }
    } catch (e) {}
    fs.appendFileSync(logFile, JSON.stringify(obj) + "\n", "utf8");
  };
}

function readConfig(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    return j && typeof j === "object" ? j : {};
  } catch (e) { return {}; } // unreadable -> nothing wakeable (fail closed)
}

function agentRecords(listAgents) {
  return listAgents().map((a) => {
    let cfg = null;
    try {
      let raw = fs.readFileSync(path.join(a.path, "agent_config.json"), "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      cfg = JSON.parse(raw);
    } catch (e) {}
    return { displayName: a.displayName, folderName: a.folderName, path: a.path, paused: !!a.paused, configPersonal: W.flaggedPersonal(cfg) };
  });
}

// deps: ipcMain, app, getMainWindow, listAgents (sync), listBgAgents (async, `claude agents --json`), workspace, log, testMode
//       processChain (optional override, tests). In TEST MODE ONLY, AGENT_DESKTOP_WAKE_TEST_SESSIONS_FILE may name a JSON
//       file of [{caller, id, pid, sessionId}] used instead of the real bg-agent list (the sandbox has no real sessions).
function init({ ipcMain, app, getMainWindow, listAgents, listBgAgents, workspace, log, testMode, processChain: chainFn, cliPath: cliOverride }) {
  const say = typeof log === "function" ? log : () => {};
  const dir = path.join(app.getPath("userData"), "wake");
  fs.mkdirSync(dir, { recursive: true });
  const pipeName = `\\\\.\\pipe\\agent-desktop-wake${testMode ? "-test" : ""}-${crypto.randomBytes(8).toString("hex")}`;

  const cfgFile = path.join(dir, "wake_config.json");
  let seeded = null; // logged to the wake log below, loudly: a deleted config is re-seeded from today's agents
  if (!fs.existsSync(cfgFile)) {
    try {
      const seed = W.seedWakeable(agentRecords(listAgents));
      writeAtomic(cfgFile, JSON.stringify({
        _note: "Folders the lead and security agents may wake. A folder not listed here is never woken. neverWake adds names to the built-in never-wake list.",
        wakeable: seed, neverWake: [],
      }, null, 2));
      say(`wake-agent: wake_config.json seeded with ${seed.length} wakeable folders`);
      seeded = seed;
    } catch (e) { say("wake-agent: cannot seed wake_config.json: " + e.message); }
  }
  const stateFile = path.join(dir, "state.json");
  // v1.121.0: the log goes under the configured shared reports folder (userData when none is set up); the throttle file is the configured usage file
  const guard = require("./testGuard");
  const reportsDir = guard.workspaceDir("sharedReports");
  const logFile = testMode ? path.join(dir, "wake_log.test.jsonl") : (reportsDir ? path.join(reportsDir, "coo", "wake_log.jsonl") : path.join(dir, "wake_log.jsonl"));
  const throttleEnv = process.env.AGENT_DESKTOP_THROTTLE_FILE || null; // read at start, like before; the configured file is looked up at each request
  const throttleFile = () => throttleEnv || guard.usageNowPath() || "";
  const testSessionsFile = testMode ? process.env.AGENT_DESKTOP_WAKE_TEST_SESSIONS_FILE : null;

  const waiting = new Map();
  let seq = 0;
  ipcMain.on("wake-reply", (event, msg) => {
    const w = getMainWindow();
    if (!w || w.isDestroyed() || event.sender !== w.webContents || !msg) return;
    const p = waiting.get(msg.id);
    if (p) { waiting.delete(msg.id); clearTimeout(p.timer); p.resolve(msg.result); }
  });
  const askRenderer = (kind, payload) => new Promise((resolve, reject) => {
    const w = getMainWindow();
    if (!w || w.isDestroyed()) return reject(new Error("no-window"));
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("renderer-timeout")); }, 45000);
    waiting.set(id, { resolve, timer });
    w.webContents.send("wake-request", Object.assign({ id, kind }, payload));
  });

  const cliPath = cliOverride || path.join(__dirname, "..", "tools", "wake-agent.js");
  const appendLog = makeAppendLog(logFile);
  let conflictLoggedAt = 0;
  const sessionsNow = async () => {
    if (testSessionsFile) return JSON.parse(fs.readFileSync(testSessionsFile, "utf8"));
    const r = callerSessions(await listBgAgents(), workspace);
    if (r.conflicts.length && Date.now() - conflictLoggedAt > 10 * 60 * 1000) {
      conflictLoggedAt = Date.now();
      const line = "more than one live bg session in a caller folder - no caller accepted from it: " + JSON.stringify(r.conflicts);
      say("wake-agent: ALERT " + line);
      try { appendLog({ at: new Date().toISOString(), cmd: "alert", result: "caller-folder-conflict", conflicts: r.conflicts }); } catch (e) {}
    }
    return r.sessions;
  };
  // process table first; `claude agents --json` only when the claimant really is the shipped wake CLI under node
  const identify = async (pid) => {
    const chain = await (chainFn || processChain)(pid);
    const pre = W.checkClaimant(pid, chain, { cliPath });
    if (pre.error) return pre;
    return W.verifyCaller(pid, chain, await sessionsNow(), { cliPath });
  };
  if (seeded) { try { appendLog({ at: new Date().toISOString(), cmd: "alert", result: "wake-config-seeded", wakeable: seeded }); } catch (e) {} }

  const io = makeStateIo(stateFile);
  W.setPartnerNameSource(() => require("./appConfig").get("partnerName"));
  const handle = W.createHandler({
    identify,
    listAgents: () => agentRecords(listAgents),
    wakeable: () => readConfig(cfgFile).wakeable,
    neverWakeList: () => readConfig(cfgFile).neverWake,
    throttle: () => W.readThrottle(throttleFile(), Date.now()),
    callerLabel: (caller) => { const f = callerFolders()[caller]; return f ? f.replace(/ Agent$/i, "") : null; },
    ownerName: () => { try { return require("./appConfig").get("ownerName"); } catch (e) { return null; } },
    askRenderer,
    appendLog,
    loadState: io.loadState,
    saveState: io.saveState,
    log: say,
  });
  const server = W.startServer({
    pipeName, handle, log: say,
    onListening: () => { try { writeAtomic(path.join(dir, "pipe-name"), pipeName); } catch (e) {} },
  });
  app.on("before-quit", () => { try { server.close(); } catch (e) {} });
  return { pipeName, dir, server };
}

function _reset() { recorded.coo.clear(); recorded.security.clear(); } // tests

module.exports = {
  init, noteSession, callerSessions, processChain, processTable, chainFromTable, makeStateIo, makeAppendLog, writeAtomic, agentRecords,
  callerFolders, callerForSessionCwd, LOG_ROTATE_BYTES, _reset,
};
