// MY FINANCE IPC registration (main process, v1.90.0 skeleton). Cheap: handlers only; the service loads on the first call (first open).
// Every finance-* channel: only the main window's own frame may call it and an oversized argument is refused (same guard as My Research).
// The renderer never sends a path: it sends filter values (validated in the service), "drop"/"vault" for the Open-folder button, and its
// remembered tab. No network, no credentials, no shell commands; logs carry channel names and error codes only, never amounts or merchants.
"use strict";
const path = require("path");
const fs = require("fs");
const MAX_ARG_CHARS = 1024;
const TABS = ["home", "fcards", "finvoices", "fincome", "fexpenses", "fvat", "faccounts", "fqueue", "fpackage", "frates", "fsources", "fcash", "overview", "accounts", "transactions", "categories", "receipts", "import", "accountant"];

function init({ ipcMain: raw, getMainWindow, userData, appDir, testMode, log, env, openPath, feedConfig, today }) {
  const say = typeof log === "function" ? log : () => {};
  let svc = null;
  const service = () => (svc || (svc = require("./service").createService({ userData, appDir, testMode: !!testMode, env: env || process.env, defaultDir: () => require("../appConfig").get("financeVault"), log: say })));
  // v1.129.0 feed (read-only JSON from the Accounting feed tool): the path and the login links come from the configuration layer, never from the renderer.
  const cfgGet = (k) => { try { return require("../appConfig").get(k); } catch (e) { return null; } };
  const fc = feedConfig || { path: () => cfgGet("financeFeedPath"), links: () => cfgGet("financeLoginLinks") };
  let reader = null;
  const feedReader = () => (reader || (reader = require("./feedReader").createFeedReader({ getPath: () => fc.path(), appDir, log: say })));
  const handle = (channel, fn) => raw.handle(channel, async (event, arg) => {
    try {
      const w = typeof getMainWindow === "function" ? getMainWindow() : null;
      const wc = w && !(typeof w.isDestroyed === "function" && w.isDestroyed()) ? w.webContents : null;
      if (!wc || !event || event.sender !== wc || !event.senderFrame || event.senderFrame !== wc.mainFrame) { say(channel + " refused: not the main window"); return { ok: false, reason: "Not allowed." }; }
      if (arg !== undefined && arg !== null) { if (typeof arg !== "object" || Array.isArray(arg)) return { ok: false, reason: "Bad request." }; let n; try { n = JSON.stringify(arg).length; } catch (x) { return { ok: false, reason: "Bad request." }; } if (n > MAX_ARG_CHARS) return { ok: false, reason: "That request is too large." }; }
    } catch (x) { return { ok: false, reason: "Not allowed." }; }
    try { return await fn(arg); } catch (x) { say(channel + " failed: code=" + (x && x.code ? x.code : "unknown")); return { ok: false, reason: "That did not work." }; }
  });
  // the view's own small prefs file (not localStorage): the tab that was open last. vaultDir in the same file is read by the service
  // (set by hand or by the Security agent; the view never changes it). Review S3: the file is written atomically, every other key is kept,
  // and a file that exists but does not parse is NEVER overwritten (that would silently drop vaultDir and switch the vault).
  const prefsFile = () => path.join(userData, "finance_prefs.json");
  // -> {ok:true, value} (missing file = empty) | {ok:false} (exists but unreadable)
  const readPrefs = () => {
    let text;
    try { text = fs.readFileSync(prefsFile(), "utf8"); } catch (x) { return x && x.code === "ENOENT" ? { ok: true, value: {} } : { ok: false }; }
    try { const j = JSON.parse(text.replace(/^﻿/, "")); return j && typeof j === "object" && !Array.isArray(j) ? { ok: true, value: j } : { ok: false }; } catch (x) { return { ok: false }; }
  };
  handle("finance-prefs-get", () => { const r = readPrefs(); const tab = r.ok ? r.value.tab : null; return { ok: true, prefs: { tab: TABS.includes(tab) ? tab : "home" } }; });
  handle("finance-prefs-set", (a) => {
    if (!a || !TABS.includes(a.tab)) return { ok: false, reason: "Bad request." };
    const r = readPrefs();
    if (!r.ok) return { ok: false, reason: "finance_prefs.json cannot be read, so it was left untouched." };
    const next = Object.assign({}, r.value, { tab: a.tab });
    const file = prefsFile(), tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
    try { fs.writeFileSync(tmp, JSON.stringify(next), "utf8"); fs.renameSync(tmp, file); } catch (x) { try { fs.unlinkSync(tmp); } catch (y) { /* ignore */ } return { ok: false, reason: "Not saved." }; }
    return { ok: true };
  });
  handle("finance-load", () => service().load());
  handle("finance-feed", (a) => {
    const FR = require("./feedReader");
    const scope = a && typeof a.scope === "string" && FR.SCOPES.includes(a.scope) ? a.scope : "all";
    const FP = require("./feedPages");
    const page = a && typeof a.page === "string" && FP.PAGES.includes(a.page) ? a.page : null;
    if (a && a.page !== undefined && a.page !== null && !page) return { ok: false, reason: "Bad request." };
    const offset = a && Number.isInteger(a.offset) && a.offset >= 0 && a.offset <= 100000 ? a.offset : 0;
    const filter = a && typeof a.filter === "string" ? a.filter : null;
    const r = feedReader().readFeed();
    if (!r.ok) return { ok: false, code: r.code, reason: r.reason, firstError: r.firstError || null };
    const t = typeof today === "function" ? today() : null;
    const d = new Date();
    const local = t || d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    let links = null; try { links = FR.parseLoginLinks(fc.links()); } catch (e) { links = null; }
    if (page) return { ok: true, page: FP.pageView(r.feed, page, scope, { today: local, loginLinks: links || undefined, offset, filter }) };
    return { ok: true, view: FR.homeView(r.feed, scope, { today: local, loginLinks: links || undefined }) };
  });
  handle("finance-transactions", (a) => service().transactions(a));
  handle("finance-import-scan", () => service().importScan());
  handle("finance-demo-create", () => service().createDemo());
  handle("finance-demo-remove", () => service().removeDemo());
  handle("finance-closed", () => { if (svc) svc.dropCache(); return { ok: true }; });   // the view closed: forget the cached ledger
  handle("finance-open-folder", async (a) => {
    const which = a && a.which === "vault" ? "vault" : a && a.which === "drop" ? "drop" : null;
    if (!which) return { ok: false, reason: "Bad request." };
    const p = service().folderFor(which);
    if (!p) return { ok: false, reason: "The finance folder is not allowed (cloud-synced)." };
    if (typeof openPath !== "function") return { ok: false, reason: "Not available." };
    const err = await openPath(p);
    return err ? { ok: false, reason: "The folder could not be opened." } : { ok: true };
  });
  return { service };
}

module.exports = { init, TABS };
