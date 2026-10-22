// TASK LIST IPC (main process). Reads the fleet task stores (<sharedReports>/tasks/<agent>.json) and changes them ONLY through tasks.py
// (one writer logic: lock + atomic replace live there). The renderer sends an agent name and an action, never a path. Live updates: the store
// folder is watched and the window is told "tasklist-changed" (debounced); the view re-reads. Nothing leaves this PC.
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("./tasklistLogic");
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 400;

function init({ ipcMain: raw, getMainWindow, log, cfg, run, now, watch }) {
  const say = typeof log === "function" ? log : () => {};
  const clock = now || (() => new Date().toISOString());
  const wc = () => { try { const w = getMainWindow(); return w && !(typeof w.isDestroyed === "function" && w.isDestroyed()) ? w.webContents : null; } catch (e) { return null; } };
  const handle = (channel, fn) => raw.handle(channel, async (event, arg) => {
    try {
      const c = wc();
      if (!c || !event || event.sender !== c || !event.senderFrame || event.senderFrame !== c.mainFrame) { say(channel + " refused: not the main window"); return { ok: false, reason: "Not allowed." }; }
      if (arg !== undefined && arg !== null) { if (typeof arg !== "object" || Array.isArray(arg)) return { ok: false, reason: "Bad request." }; if (JSON.stringify(arg).length > 2000) return { ok: false, reason: "That request is too large." }; }
    } catch (x) { return { ok: false, reason: "Not allowed." }; }
    try { return await fn(arg || {}); } catch (x) { say(channel + " failed: code=" + (x && x.code ? x.code : "unknown")); return { ok: false, reason: "That did not work." }; }
  });

  const storeDir = () => { const r = cfg("sharedReports"); return r ? path.join(r, "tasks") : null; };
  const runTool = run || ((args) => new Promise((resolve) => {
    const py = cfg("pythonExe"), tool = cfg("tasksTool");
    if (!py || !tool) return resolve({ ok: false, reason: "Python or tasks.py is not set up. Open Setup." });
    require("child_process").execFile(py, [tool].concat(args), { timeout: 20000, windowsHide: true }, (err, out, errOut) => resolve(err ? { ok: false, reason: "The task tool did not accept that." } : { ok: true, out: String(out || "") }));
  }));

  function agentNames() {
    const d = storeDir(); if (!d) return null;
    try { return fs.readdirSync(d).filter((f) => /\.json$/i.test(f) && !/\.tmp$/i.test(f)).map((f) => f.slice(0, -5)).filter((n) => L.AGENT_OK.test(n)).sort((a, b) => a.localeCompare(b)).slice(0, 200); }
    catch (e) { return e && e.code === "ENOENT" ? [] : null; }
  }
  function readStore(agent) {
    const d = storeDir(); if (!d) return null;
    try {
      const f = path.join(d, agent + ".json");
      if (path.dirname(path.resolve(f)).toLowerCase() !== path.resolve(d).toLowerCase()) return null;
      const st = fs.statSync(f); if (!st.isFile() || st.size > MAX_STORE_BYTES) return null;
      const j = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
      return { agent, items: Array.isArray(j.items) ? j.items : [], archive: Array.isArray(j.archive) ? j.archive : [], auto: !!(j.settings && j.settings.autoContinue) };
    } catch (e) { return null; }
  }
  // Iddo's switch "always continue to the next task, even after a handoff": the global flag lives next to the task folder, the per-agent flag in the store
  function globalAuto() {
    const r = cfg("sharedReports"); if (!r) return false;
    try { const f = path.join(r, "task_list_settings.json"); if (fs.statSync(f).size > 4096) return false; return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")).autoContinue === true; } catch (e) { return false; }
  }
  const known = (agent) => { const n = agentNames(); return typeof agent === "string" && n && n.includes(agent); };

  let watcher = null, timer = null;
  function startWatch() {
    if (watcher) return; const d = storeDir(); if (!d) return;
    try {
      const w = (watch || fs.watch);
      watcher = w(d, { persistent: false }, () => { clearTimeout(timer); timer = setTimeout(() => { const c = wc(); if (c) { try { c.send("tasklist-changed"); } catch (e) { /* window gone */ } } }, 500); });
      if (watcher && watcher.on) watcher.on("error", () => { watcher = null; });
    } catch (e) { watcher = null; }
  }

  handle("tasklist-load", (a) => {
    const d = storeDir(); if (!d) return { ok: false, reason: "The shared reports folder is not set. Open Setup and fill in sharedReports." };
    const names = agentNames(); if (!names) return { ok: false, reason: "The task folder could not be read." };
    startWatch();
    const want = a.agent && a.agent !== "all" ? (known(a.agent) ? [a.agent] : []) : names;
    if (a.agent && a.agent !== "all" && !want.length) return { ok: false, reason: "That agent has no task list." };
    const stores = want.map(readStore).filter(Boolean);
    const sum = L.summarize(stores, clock());
    const perAgent = names.map((n) => { const s = stores.find((x) => x.agent === n); return { agent: n }; });
    return { ok: true, agents: perAgent, counts: sum.counts, rows: sum.rows.slice(0, MAX_ROWS), truncated: sum.rows.length > MAX_ROWS, canReorder: want.length === 1, auto: { global: globalAuto(), agent: want.length === 1 && stores[0] ? stores[0].auto : null }, canWrite: !!(cfg("pythonExe") && cfg("tasksTool")), at: clock() };
  });

  handle("tasklist-move", async (a) => {
    if (!known(a.agent)) return { ok: false, reason: "Pick one agent first." };
    if (!["up", "down", "top", "bottom"].includes(a.dir) || typeof a.id !== "string") return { ok: false, reason: "Bad request." };
    const s = readStore(a.agent); if (!s) return { ok: false, reason: "That task list could not be read." };
    const rows = L.summarize([s], clock()).rows;
    const args = L.moveArgs(rows, a.id, a.dir); if (!args) return { ok: true, changed: false };
    const r = await runTool(["--agent", a.agent].concat(args)); return r.ok ? { ok: true, changed: true } : r;
  });
  // Clear tags what it archives with one batch id and reports which agents it really cleared; Undo restores exactly that batch (never an older clear).
  handle("tasklist-clear", async (a) => {
    const targets = a.agent && a.agent !== "all" ? (known(a.agent) ? [a.agent] : []) : (agentNames() || []);
    const batch = require("crypto").randomBytes(8).toString("hex");
    const cleared = []; let failed = 0;
    for (const ag of targets) {
      const s = readStore(ag); if (!s || !s.items.some((i) => i && i.status === "done")) continue;
      const r = await runTool(["--agent", ag, "--clear-finished", "--batch", batch]); if (r.ok) cleared.push(ag); else failed++;
    }
    return failed ? { ok: false, reason: "Some lists could not be cleared." } : { ok: true, cleared: cleared.length, batch: cleared.length ? batch : null, agents: cleared };
  });
  handle("tasklist-undo", async (a) => {
    if (typeof a.batch !== "string" || !/^[0-9a-f]{8,64}$/.test(a.batch)) return { ok: false, reason: "Nothing to undo." };
    let failed = 0;
    for (const ag of agentNames() || []) {
      const s = readStore(ag); if (!s || !s.archive.some((i) => i && i.archiveBatch === a.batch)) continue;
      const r = await runTool(["--agent", ag, "--unarchive-batch", a.batch]); if (!r.ok) failed++;
    }
    return failed ? { ok: false, reason: "Some lists could not be restored." } : { ok: true };
  });
  handle("tasklist-auto", async (a) => {
    if (typeof a.on !== "boolean") return { ok: false, reason: "Bad request." };
    const all = !a.agent || a.agent === "all";
    if (!all && !known(a.agent)) return { ok: false, reason: "That agent has no task list." };
    const r = await runTool((all ? [] : ["--agent", a.agent]).concat(["--auto-continue", a.on ? "on" : "off"], all ? ["--global"] : []));
    return r.ok ? { ok: true } : r;
  });
  return { stop() { clearTimeout(timer); try { if (watcher && watcher.close) watcher.close(); } catch (e) { /* closed */ } watcher = null; } };
}

module.exports = { init };
