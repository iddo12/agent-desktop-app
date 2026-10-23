// PROJECTS IPC (main process). Reads the Project Autopilot ledger (<workspace>/shared_state/projects/<slug>/project.json + events.jsonl) ON DEMAND and
// changes it ONLY through project.py (it owns the lock + atomic write). The renderer sends a slug and an action, never a path. Live updates: the
// projects folder is watched (debounced 700 ms) and the window is told "projects-changed"; the view re-reads. Nothing is ever written from here.
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("./projectsLogic");

function init({ ipcMain: raw, getMainWindow, log, cfg, run, now, watch, setupHint, fsImpl }) {
  const F = fsImpl || fs;
  const hint = setupHint || { workspace: "Open Setup and fill in the workspace folder.", tool: "Open Setup." };
  const say = typeof log === "function" ? log : () => {};
  const clock = now || (() => new Date().toISOString());
  const get = (k) => { try { return cfg(k); } catch (e) { return null; } };
  const wc = () => { try { const w = getMainWindow(); return w && !(typeof w.isDestroyed === "function" && w.isDestroyed()) ? w.webContents : null; } catch (e) { return null; } };
  const handle = (channel, fn) => raw.handle(channel, async (event, arg) => {
    try {
      const c = wc();
      if (!c || !event || event.sender !== c || !event.senderFrame || event.senderFrame !== c.mainFrame) { say(channel + " refused: not the main window"); return { ok: false, reason: "Not allowed." }; }
      if (arg !== undefined && arg !== null) { if (typeof arg !== "object" || Array.isArray(arg)) return { ok: false, reason: "Bad request." }; if (JSON.stringify(arg).length > 2000) return { ok: false, reason: "That request is too large." }; }
    } catch (x) { return { ok: false, reason: "Not allowed." }; }
    try { return await fn(arg || {}); } catch (x) { say(channel + " failed: code=" + (x && x.code ? x.code : "unknown")); return { ok: false, reason: "That did not work." }; }
  });

  // Paths come from the workspace folder and shared-tools settings (nothing hard-coded to a drive); no separate overrides exist.
  const projectsDir = () => get("projectsDir") || (get("workspaceRoot") ? path.join(get("workspaceRoot"), "shared_state", "projects") : null);
  const projectsTool = () => get("projectsTool") || (get("sharedTools") ? path.join(get("sharedTools"), "projects", "project.py") : null);
  const runTool = run || ((args) => new Promise((resolve) => {
    const py = get("pythonExe"), tool = projectsTool(), root = projectsDir();
    if (!py || !tool || !F.existsSync(tool)) return resolve({ ok: false, reason: "project.py is not set up. " + hint.tool });
    // PROJECTS_DIR is passed explicitly so the tool writes exactly where this view reads (a sandbox never touches the live ledger by accident).
    require("child_process").execFile(py, [tool].concat(args), { timeout: 20000, windowsHide: true, env: Object.assign({}, process.env, root ? { PROJECTS_DIR: root } : {}) },
      (err, out, errOut) => resolve(err ? { ok: false, reason: refusal(String(errOut || "")) } : { ok: true, out: String(out || "") }));
  }));
  // project.py says why in plain words (SystemExit text); pass on only the known, harmless ones
  function refusal(stderr) {
    if (/budget is not signed/i.test(stderr)) return "The budget is not signed yet. System Optimization has to sign it first.";
    if (/locked by another writer/i.test(stderr)) return "Another agent is writing to this project. Try again in a moment.";
    if (/no such question/i.test(stderr)) return "That question is not there any more.";
    if (/no such project/i.test(stderr)) return "That project is not there any more.";
    return "The project tool did not accept that.";
  }

  const lastGood = new Map();   // slug -> last project that read fine; shown when Dropbox holds a file for a moment
  let watcher = null, timer = null;
  function startWatch() {
    if (watcher) return; const d = projectsDir(); if (!d) return;
    try {
      const w = (watch || F.watch);
      watcher = w(d, { persistent: false, recursive: true }, (evt, name) => {
        if (name && /\.lock$|\.tmp$/i.test(String(name))) return;     // our own writers' scratch files are not news
        clearTimeout(timer); timer = setTimeout(() => { const c = wc(); if (c) { try { c.send("projects-changed"); } catch (e) { /* window gone */ } } }, 700);
      });
      if (watcher && watcher.on) watcher.on("error", () => { watcher = null; });
    } catch (e) { watcher = null; }
  }

  handle("projects-list", () => {
    const d = projectsDir(); if (!d) return { ok: false, reason: "The workspace folder is not set. " + hint.workspace };
    const r = L.loadAll(F, path, d, clock(), lastGood);
    if (!r) return { ok: true, projects: [], counts: { green: 0, amber: 0, red: 0, total: 0, finished: 0 }, loadedAt: clock(), empty: true, canWrite: false };
    startWatch();
    return Object.assign({ ok: true, canWrite: !!(get("pythonExe") && projectsTool()) }, r);
  });
  handle("projects-detail", (a) => {
    const d = projectsDir(); if (!d) return { ok: false, reason: "The workspace folder is not set. " + hint.workspace };
    const inp = L.readProject(F, path, d, a.slug); if (!inp) return { ok: false, reason: "That project is not there." };
    const v = L.viewOf(inp, clock());
    return { ok: true, project: v.detail, intake: v.detail.status === "draft" ? L.readIntake(F, path, d, a.slug) : "", canWrite: !!(get("pythonExe") && projectsTool()), loadedAt: clock() };
  });
  handle("projects-answer", async (a) => {
    if (!L.SLUG_OK.test(String(a.slug || "")) || !L.QID_OK.test(String(a.qid || ""))) return { ok: false, reason: "Bad request." };
    const text = L.clip(String(a.text == null ? "" : a.text), 500).trim(); if (!text) return { ok: false, reason: "Write an answer first." };
    // `--text=...` keeps an answer that starts with "-" from being read as an option
    return runTool(["answer", a.slug, a.qid, "--text=" + text, "--by=Iddo"]).then((r) => (r.ok ? { ok: true } : r));
  });
  handle("projects-green-light", async (a) => {
    if (!L.SLUG_OK.test(String(a.slug || ""))) return { ok: false, reason: "Bad request." };
    const d = projectsDir(); const inp = d ? L.readProject(F, path, d, a.slug) : null;
    if (!inp) return { ok: false, reason: "That project is not there." };
    if (inp.project.status !== "draft") return { ok: false, reason: "This project is not waiting for a Green light." };
    if (!(inp.project.budget || {}).signed_by) return { ok: false, reason: "The budget is not signed yet. System Optimization has to sign it first." };   // project.py refuses too
    return runTool(["green-light", a.slug, "--by=Iddo"]).then((r) => (r.ok ? { ok: true } : r));
  });
  return { stop() { clearTimeout(timer); try { if (watcher && watcher.close) watcher.close(); } catch (e) { /* closed */ } watcher = null; } };
}

module.exports = { init };
