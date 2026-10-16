// My Designs IPC (v1.125.0, main process). Read only. The renderer sends at most a design id; the library folder, the source folder and the
// reference link are looked up here from styles.json, so a page can never make main open an arbitrary path or URL.
"use strict";
const D = require("./designsData");

function init({ ipcMain, getMainWindow, cfg, openFolder, openExternal, disabled, log }) {
  const say = typeof log === "function" ? log : () => {};
  const guard = (event) => {
    const w = typeof getMainWindow === "function" ? getMainWindow() : null;
    const wc = w && !(typeof w.isDestroyed === "function" && w.isDestroyed()) ? w.webContents : null;
    return !!(wc && event && event.sender === wc && (!event.senderFrame || !wc.mainFrame || event.senderFrame === wc.mainFrame));
  };
  const libDir = () => { try { return cfg.isReady("designs") ? cfg.get("styleLibrary") : null; } catch (e) { return null; } };
  const idOf = (a) => (a && Number.isInteger(a.id) && a.id > 0 ? a.id : 0);
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, arg) => {
    if (!guard(event)) { say(channel + " refused: not the main window"); return { ok: false, reason: "Not allowed." }; }
    try { return await fn(arg); } catch (e) { say(channel + " failed: code=" + (e && e.code ? e.code : "unknown")); return { ok: false, reason: "That did not work." }; }
  });

  let last = null;   // the list the page was last given: the open handlers look the design up here instead of re-reading styles.json on every click
  const find = (id) => { const d = libDir(); if (!d) return null; if (last && last.dir === d) { const e = last.items.find((x) => x.id === id); if (e) return e; } return D.findById(d, id); };
  handle("designs-load", () => {
    if (disabled && disabled()) return { ok: false, reason: "needs-setup" };
    const r = D.load(libDir());
    if (!r.ok) return { ok: false, reason: r.reason };
    last = { dir: libDir(), items: r.items };
    return { ok: true, items: r.items.map(D.publicItem) };
  });
  handle("designs-open-source", async (a) => {
    if (disabled && disabled()) return { ok: false, reason: "Not available here." };
    const e = idOf(a) && find(idOf(a));
    if (!e || !e.source) return { ok: false, reason: "This design has no source folder recorded." };
    const r = await openFolder(e.source);
    return r && r.ok ? { ok: true } : { ok: false, reason: (r && r.error) || "Could not open it." };
  });
  handle("designs-open-reference", async (a) => {
    if (disabled && disabled()) return { ok: false, reason: "Not available here." };
    const e = idOf(a) && find(idOf(a));
    if (!e || !e.referenceIsUrl) return { ok: false, reason: "No link recorded." };
    await openExternal(e.reference);
    return { ok: true };
  });
}

module.exports = { init };
