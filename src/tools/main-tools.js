// TOOLS v1 IPC registration (main process). Cheap: handlers only; the service loads on the first call (first open of the Tools view).
// Every tools-* channel: only the main window's own frame may call it and an oversized argument is refused. The renderer sends only
// a tool id (never a path or command); the main process looks the command up in tools.json and applies the launcher allow-list.
"use strict";
const MAX_ARG_CHARS = 2048;

function init({ ipcMain: raw, getMainWindow, dialog, userData, workspaceRoot, testMode, log, env, openExternal, nativeImage }) {
  const say = typeof log === "function" ? log : () => {};
  let svc = null;
  // The confirmation is a NATIVE dialog opened here in the main process: a compromised page cannot click it.
  const confirm = async (d) => {
    if (!dialog || typeof dialog.showMessageBox !== "function") return false;
    const w = typeof getMainWindow === "function" ? getMainWindow() : null;
    const lines = [(d.changed ? "This launcher CHANGED since you approved it" + (d.approvedAt ? " on " + d.approvedAt : "") + ". Check who changed it before you continue." : "First start of this tool, or a new launcher."),
      "", "Tool: " + d.name + (d.owner ? " (owner: " + d.owner + ")" : ""), "File: " + d.real, "Arguments: " + (d.args.length ? d.args.join(" ") : "none"),
      "SHA-256: " + d.sha256.slice(0, 16) + "..." + (d.partial ? " (large file: size, date and first 1 MB)" : ""),
      "", "This approves the launcher file only, not the program it starts."];
    const r = await dialog.showMessageBox(w || undefined, { type: d.changed ? "warning" : "question", buttons: ["Cancel", "Start and trust"], defaultId: 0, cancelId: 0, noLink: true, title: "Start " + d.name, message: (d.changed ? "Launcher changed: start " : "Start ") + d.name + "?", detail: lines.join("\n") });
    return r.response === 1;
  };
  const service = () => (svc || (svc = require("./service").createService({ userData, workspaceRoot, testMode, log: say, env: env || process.env, openExternal, confirm, nativeImage })));
  const handle = (channel, fn) => raw.handle(channel, async (event, arg) => {
    try {
      const w = typeof getMainWindow === "function" ? getMainWindow() : null;
      const wc = w && !(typeof w.isDestroyed === "function" && w.isDestroyed()) ? w.webContents : null;
      if (!wc || !event || event.sender !== wc || (event.senderFrame && wc.mainFrame && event.senderFrame !== wc.mainFrame)) { say(channel + " refused: not the main window"); return { ok: false, reason: "Not allowed." }; }
      if (arg !== undefined && arg !== null) { let n; try { n = JSON.stringify(arg).length; } catch (e) { return { ok: false, reason: "Bad request." }; } if (n > MAX_ARG_CHARS) return { ok: false, reason: "That request is too large." }; }
    } catch (e) { return { ok: false, reason: "Not allowed." }; }
    try { return await fn(arg); } catch (e) { say(channel + " failed: code=" + (e && e.code ? e.code : "unknown")); return { ok: false, reason: "That did not work." }; }
  });
  const idOf = (a) => (a && typeof a.id === "string" && a.id.length <= 64 ? a.id : "");
  // view preferences (card size S/M/L): one tiny file in userData; the value is checked against the allow-list on both read and write
  const prefsFile = () => require("path").join(userData, "tools_prefs.json");
  const readPrefs = () => { try { const j = JSON.parse(require("fs").readFileSync(prefsFile(), "utf8").replace(/^﻿/, "")); return { cardSize: j && (j.cardSize === "S" || j.cardSize === "L") ? j.cardSize : "M", tab: j && j.tab === "service" ? "service" : "app" }; } catch (e) { return { cardSize: "M", tab: "app" }; } };
  handle("tools-prefs-get", () => ({ ok: true, prefs: readPrefs() }));
  handle("tools-prefs-set", (a) => {
    const v = a && (a.cardSize === "S" || a.cardSize === "M" || a.cardSize === "L") ? a.cardSize : null;
    const tb = a && (a.tab === "app" || a.tab === "service") ? a.tab : null;
    if (!v && !tb) return { ok: false, reason: "Bad request." };
    const cur = readPrefs();   // a patch: whichever key is missing keeps its stored value
    try { require("fs").writeFileSync(prefsFile(), JSON.stringify({ cardSize: v || cur.cardSize, tab: tb || cur.tab }), "utf8"); } catch (e) { return { ok: false, reason: "Not saved." }; }
    return { ok: true };
  });
  handle("tools-load", () => service().load());
  handle("tools-start", (a) => service().start(idOf(a)));
  handle("tools-refresh", () => service().refreshStats());
  handle("tools-open-link", (a) => service().openLink(idOf(a), a && a.kind));
  return { service };
}

module.exports = { init };
