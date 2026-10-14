// My Health: IPC registration (main process). Cheap on purpose: it only registers handlers. The service, the store
// and the importers are require()d on the FIRST call, i.e. when the Health tile is first opened.
// Every health-* channel: only the main window's own frame may call it, an oversized argument is refused, and the
// renderer can never pass a file path to read: the file chooser is opened HERE (main) and the paths stay in main.
// Stage 1b: the routine REMINDER scheduler is created here (small, no store code). `boot()` reads routines.json once at start; a
// timer exists only while at least one reminder is enabled (see reminders.js).
"use strict";
const MAX_ARG_CHARS = 65536;

const fs = require("fs");
const path = require("path");

function init({ ipcMain: raw, getMainWindow, dialog, userData, testMode, log, env, openExternal, notify }) {
  const say = typeof log === "function" ? log : () => {};
  let svc = null;
  const e0 = env || process.env;
  // Screen-capture flag (review F17): while the My Health view is open the empty file <userData>\health-open.flag exists, so GuideTool and any
  // other screen capturer can skip capture. Created on open, removed on close, at quit, and (after a crash) at the next start. No content.
  const flagFile = userData ? path.join(userData, "health-open.flag") : null;
  const setFlag = (on) => { if (!flagFile) return; try { if (on) { fs.mkdirSync(path.dirname(flagFile), { recursive: true }); fs.closeSync(fs.openSync(flagFile, "w")); } else fs.unlinkSync(flagFile); } catch (e) { /* already gone / not writable */ } };
  setFlag(false);                       // a flag left behind by a crash is stale
  let viewOpen = false;
  // v1.121.0: the health folder comes from the configuration (healthParent). Read once at start: a Setup change applies after the next start
  // (the store and the reminder scheduler are built from it).
  const healthParent = () => require("../appConfig").get("healthParent");
  const resolved = require("./roots").resolveRoot({ env: e0, testMode, userData, parent: healthParent });
  const RT = require("./routines");
  const reminders = require("./reminders").create({
    log: say,
    load: () => (resolved.ok ? RT.createRoutineFile(resolved.root).load() : RT.defaultState()),
    notify: (text) => { if (typeof notify === "function") notify(text); },
  });
  const service = () => {
    if (!svc) {
      svc = require("./service").createService({
        userData, testMode, log: say, env: e0, openExternal, reminders, parent: healthParent,
        pickFolder: async () => {
          if (testMode && e0.AGENT_DESKTOP_HEALTH_TEST_PICK_DIR) return String(e0.AGENT_DESKTOP_HEALTH_TEST_PICK_DIR);   // sandbox only
          const w = typeof getMainWindow === "function" ? getMainWindow() : null;
          const r = await dialog.showOpenDialog(w || undefined, { title: "Import a folder of health exports", properties: ["openDirectory"] });
          return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
        },
        pickFiles: async () => {
          // Test mode only: the sandbox harness cannot drive a native dialog, so it may name synthetic files through the environment.
          if (testMode && e0.AGENT_DESKTOP_HEALTH_TEST_PICK) return String(e0.AGENT_DESKTOP_HEALTH_TEST_PICK).split("|").filter(Boolean);
          const w = typeof getMainWindow === "function" ? getMainWindow() : null;
          const r = await dialog.showOpenDialog(w || undefined, {
            title: "Import health file", properties: ["openFile", "multiSelections"],
            filters: [{ name: "Health exports", extensions: ["csv", "json", "txt"] }, { name: "All files", extensions: ["*"] }],
          });
          return r.canceled ? [] : r.filePaths;
        },
      });
    }
    return svc;
  };
  const handle = (channel, fn, gated) => raw.handle(channel, async (event, arg) => {
    try {
      const w = typeof getMainWindow === "function" ? getMainWindow() : null;
      const wc = w && !(typeof w.isDestroyed === "function" && w.isDestroyed()) ? w.webContents : null;
      if (!wc || !event || event.sender !== wc || (event.senderFrame && wc.mainFrame && event.senderFrame !== wc.mainFrame)) { say(channel + " refused: not the main window"); return { ok: false, reason: "Not allowed." }; }
      if (arg !== undefined && arg !== null) { let n; try { n = JSON.stringify(arg).length; } catch (e) { return { ok: false, reason: "Bad request." }; } if (n > MAX_ARG_CHARS) return { ok: false, reason: "That request is too large." }; }
    } catch (e) { return { ok: false, reason: "Not allowed." }; }
    if (gated !== false && !viewOpen) return { ok: false, reason: "My Health is not open." };   // the bridge only answers while the My Health view is on screen
    try { return await fn(arg); } catch (e) { say(channel + " failed: code=" + (e && e.code ? e.code : "unknown")); return { ok: false, reason: "That did not work." }; }
  });
  // v1.114.0 visual pane: ONE precomputed feed file (pane-feed.js). The path is fixed in main; the renderer gets parsed JSON only, and a
  // content-free "changed" event from one watch on that file's folder while the view is open.
  let paneWatch = null;
  const paneOpts = () => ({ env: e0, testMode, userData, parent: healthParent });
  const stopPaneWatch = () => { if (paneWatch) { paneWatch.stop(); paneWatch = null; } };
  handle("health-view-state", (a) => { viewOpen = !!(a && a.open); setFlag(viewOpen); if (!viewOpen) stopPaneWatch(); return { ok: true }; }, false);
  handle("health-pane-feed", () => {
    const pf = require("./pane-feed");
    if (!paneWatch || !paneWatch.active) { stopPaneWatch(); paneWatch = pf.watchFeed(paneOpts(), () => { const w = typeof getMainWindow === "function" ? getMainWindow() : null; if (viewOpen && w && !w.isDestroyed()) w.webContents.send("health-pane-changed"); }); }
    const r = pf.readFeed(paneOpts());
    if (r.state !== "ok") say("health-pane-feed: " + r.state + (r.code ? " code=" + r.code : ""));   // state and code only, never a value
    return Object.assign({ ok: true }, r);
  });
  handle("health-load", () => service().load());
  handle("health-import-pick", () => service().importPick());
  handle("health-import-folder", () => service().importFolder());
  handle("health-import-choose", (a) => service().importChoose(a));
  handle("health-lab-add", (a) => service().addLab(a));
  handle("health-reading-add", (a) => service().addReading(a));
  handle("health-med-add", (a) => service().addMed(a));
  handle("health-med-stop", (a) => service().stopMed(a));
  handle("health-agent-load", () => service().agentLoad());
  handle("health-agent-act", (a) => service().agentAct(a));
  handle("health-extra-load", (a) => service().extraLoad(a));
  handle("health-extra-act", (a) => service().extraAct(a));
  // v1.118.0 Body tab: pain_log.jsonl in the health store folder (body-store.js). Code loads on first call.
  let bodyStore = null;
  const body = () => { if (!resolved.ok) return null; if (!bodyStore) bodyStore = require("./body-store").create({ root: resolved.root }); return bodyStore; };
  handle("health-body-load", () => { const b = body(); return b ? b.load() : { ok: false, reason: resolved.reason || "The health folder is not available." }; });
  handle("health-body-save", (a) => { const b = body(); return b ? b.save(a && a.entries) : { ok: false, reason: resolved.reason || "The health folder is not available." }; });
  handle("health-open-link", (a) => service().openLink(a && a.url));
  return { service, reminders, boot: () => reminders.boot(), shutdown: () => { viewOpen = false; setFlag(false); stopPaneWatch(); reminders.stop(); }, flagFile };
}

module.exports = { init };
