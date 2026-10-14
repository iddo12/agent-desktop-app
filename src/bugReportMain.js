"use strict";
// Main-process side of "Report a problem" (v1.123.0). Six IPC handlers, ALL main-window only (same sender check as src/setupMain.js,
// plus the frame must be the window's main frame). The renderer never sends a path: the screenshot and the destination folder come from
// the file dialogs here (the folder defaults to the Desktop, resolved here), the terminal from an agent id that must match the current agent
// list. Nothing is uploaded. The collecting/scrubbing/writing itself is src/bugReport.js (pure).

const os = require("os");
const path = require("path");
const br = require("./bugReport");

const bad = (error) => ({ ok: false, error });
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

function register(deps) {
  const { ipcMain, dialog, shell, getMainWindow } = deps;
  const state = { shot: null, bundle: null, bundleKey: null, previewId: 0, lastDir: null, destDir: null, term: null };

  function fromMainWindow(event) {
    try {
      const w = getMainWindow();
      if (!(w && !w.isDestroyed() && event && event.sender === w.webContents)) return false;
      return !!event.senderFrame && event.senderFrame === w.webContents.mainFrame;   // not a sub-frame of the window
    } catch (e) { return false; }
  }
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, a) => {
    if (!fromMainWindow(event)) return bad("not-allowed");
    try { return await fn(a && typeof a === "object" ? a : {}); } catch (e) { return bad("internal"); }
  });
  const agentList = () => { try { return (deps.listAgents() || []).map((a) => ({ id: String(a.folderName), name: String(a.displayName || a.folderName), path: a.path })); } catch (e) { return []; } };
  // stable aliases for agent folder and display names (agent-1, agent-2 ... in alphabetical order of the folder name)
  const aliasesOf = (list) => { const out = []; list.slice().sort((x, y) => x.id.localeCompare(y.id)).forEach((a, i) => { out.push([a.id, "agent-" + (i + 1)]); if (a.name !== a.id) out.push([a.name, "agent-" + (i + 1)]); }); return out; };
  const aliasOf = (list, id) => { const p = aliasesOf(list).find((x) => x[0] === id); return p ? p[1] : "agent"; };
  const destNow = () => state.destDir || deps.desktopDir();

  // terminal text: from the preview the person saw (state.term) when fromPreview, never a fresh read at create time
  async function makeEnv(a, inc, list) {
    let terminalTail = "", terminalAgent = "";
    if (inc.terminal) {
      if (a.fromPreview) { terminalTail = state.term.raw; terminalAgent = state.term.name; }
      else {
        const ag = list.find((x) => x.id === a.agentId);
        if (!ag) return { error: "agent-unknown" };
        terminalTail = String(deps.terminalTail(ag.path) || ""); terminalAgent = aliasOf(list, ag.id);
      }
    }
    let gitCommit = "", claudeVersion = "";
    try { gitCommit = await deps.gitCommit(); } catch (e) { /* not available */ }
    try { claudeVersion = await deps.claudeVersion(); } catch (e) { /* not available */ }
    let user = "", host = "", homedir = "";
    try { user = os.userInfo().username; } catch (e) { /* unknown */ } try { host = os.hostname(); } catch (e) { /* unknown */ } try { homedir = os.homedir(); } catch (e) { /* unknown */ }
    const extra = [process.env.USERDOMAIN, process.env.COMPUTERNAME].filter(Boolean);
    return { env: {
      userDataDir: deps.userDataDir, appVersion: deps.appVersion, gitCommit, claudeVersion,
      windows: os.type() + " " + os.release() + " (" + os.arch() + ")", ramGb: Math.round(os.totalmem() / 1e9), nodeVersion: process.version, electronVersion: process.versions && process.versions.electron,
      user, host, homedir, names: (typeof deps.names === "function" ? deps.names() : []).concat(extra), aliases: aliasesOf(list),
      featureStates: deps.featureStates(), appLog: deps.appLog(),
      terminalTail, terminalAgent, screenshotPath: state.shot ? state.shot.path : null,
    } };
  }
  const cleanInput = (a) => {
    const i = a.include && typeof a.include === "object" ? a.include : {};
    return { what: str(a.what, br.LIMITS.what), steps: str(a.steps, br.LIMITS.steps), include: { terminal: i.terminal === true, screenshot: i.screenshot === true && !!state.shot }, agentId: str(a.agentId, 200) };
  };
  const keyOf = (inp) => JSON.stringify([inp.what, inp.steps, inp.include, inp.agentId, state.shot && state.shot.path]);
  async function buildFor(a, opts) {
    const inp = cleanInput(a);
    const list = agentList();
    const e = await makeEnv({ agentId: inp.agentId, fromPreview: !!(opts && opts.fromPreview) }, inp.include, list);
    if (e.error) return bad(e.error);
    const b = br.build(inp, e.env);
    if (!b.ok) return b;
    return { ok: true, bundle: b, key: keyOf(inp), env: e.env, inp };
  }

  handle("bug-report-info", async () => {
    state.destDir = null; state.term = null; state.shot = null; state.bundle = null; state.bundleKey = null;   // each time the dialog opens: nothing carries over
    return {
      ok: true, defaultDir: deps.desktopDir(), version: deps.appVersion,
      agents: agentList().map((x) => ({ id: x.id, name: x.name })), items: br.ITEMS.map((i) => ({ id: i.id, always: i.always, files: i.files })),
    };
  });

  handle("bug-report-pick-folder", async () => {
    const res = await dialog.showOpenDialog(getMainWindow(), { title: "Folder for the report", defaultPath: destNow(), properties: ["openDirectory", "createDirectory"] });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: true, canceled: true };
    const v = br.validateDestDir(res.filePaths[0]);
    if (!v.ok) return v;
    state.destDir = v.dir;   // the ONLY way a folder other than the default is ever used
    return { ok: true, path: v.dir };
  });

  handle("bug-report-pick-screenshot", async (a) => {
    if (a.clear === true) { state.shot = null; return { ok: true, cleared: true }; }
    const res = await dialog.showOpenDialog(getMainWindow(), { title: "Choose a screenshot", properties: ["openFile"], filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }] });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: true, canceled: true };
    const v = br.validShot(res.filePaths[0]);
    if (!v.ok) return v;
    state.shot = { path: res.filePaths[0] };
    return { ok: true, name: path.basename(res.filePaths[0]), size: v.size };
  });

  handle("bug-report-preview", async (a) => {
    const r = await buildFor(a);
    if (!r.ok) return r;
    state.bundle = r.bundle; state.bundleKey = r.key; state.previewId++;
    // what the person is now looking at is the ONLY terminal text a report may contain
    if (r.inp.include.terminal) { const ag = agentList().find((x) => x.id === r.inp.agentId); state.term = { agentId: r.inp.agentId, raw: r.env.terminalTail, name: ag ? aliasOf(agentList(), ag.id) : "" }; }
    return { ok: true, previewId: state.previewId, files: br.previewOf(r.bundle) };
  });

  handle("bug-report-create", async (a) => {
    const v = br.validateDestDir(destNow());   // a destination sent by the renderer is ignored
    if (!v.ok) return v;
    const inp = cleanInput(a);
    let bundle;
    if (inp.include.terminal) {
      // the terminal text must be exactly what a preview showed for this agent; never re-read it now
      if (!agentList().some((x) => x.id === inp.agentId)) return bad("agent-unknown");
      if (!state.term || state.term.agentId !== inp.agentId) return bad("preview-required");
      const r = await buildFor(a, { fromPreview: true }); if (!r.ok) return r; bundle = r.bundle;
    } else if (state.bundle && a.previewId === state.previewId && state.bundleKey === keyOf(inp)) bundle = state.bundle;
    else { const r = await buildFor(a); if (!r.ok) return r; bundle = r.bundle; }
    let w = br.write(bundle, v.dir, { fs: deps.fs });
    if (!w.ok && w.error === "cannot-write" && !state.destDir) {
      // The default folder (Desktop) can be protected by Windows (Controlled Folder Access). Retry once in the app's own data folder, which never is.
      try {
        const own = path.join(deps.userDataDir, "bug-reports");
        (deps.fs || require("fs")).mkdirSync(own, { recursive: true });
        const w2 = br.write(bundle, own, { fs: deps.fs });
        if (w2.ok) { state.lastDir = w2.dir; return { ok: true, dir: w2.dir, zip: w2.zip, files: w2.files, fellBack: true, reason: "desktop-blocked" }; }
      } catch (e) { /* fall through to the original error */ }
    }
    if (!w.ok) return w.error === "cannot-write" ? { ok: false, error: "cannot-write", hint: w.hint || (state.destDir ? "blocked-by-windows" : undefined) } : w;   // an explicitly picked folder never falls back silently
    state.lastDir = w.dir;
    return { ok: true, dir: w.dir, zip: w.zip, files: w.files };
  });

  handle("bug-report-open-folder", async () => {
    if (!state.lastDir) return bad("invalid-arguments");
    try { shell.showItemInFolder(state.lastDir); } catch (e) { return bad("internal"); }
    return { ok: true };
  });
  return { state };
}

module.exports = { register };
