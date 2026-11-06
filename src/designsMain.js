// My Designs IPC (v1.125.0, main process). Read only. The renderer sends at most a design id; the library folder, the source folder and the
// reference link are looked up here from styles.json, so a page can never make main open an arbitrary path or URL.
"use strict";
const fs = require("fs");
const path = require("path");
const D = require("./designsData");

// "Sync with <partner>" (button on the page; the partner name comes from the configuration key partnerName). The shared tool is <sharedTools>/style_library/sync_designs_with_partner.py and Python comes from the
// configuration (keys sharedTools, pythonExe; both auto-derived), so nothing here names a drive or a person. Missing script or Python = "not-available"
// and the page hides the button. The renderer sends no argument: the command line is fixed ("sync").
const SYNC_REL = ["style_library", "sync_designs_with_partner.py"];
const SYNC_TIMEOUT_MS = 120000;
const SYNC_MAX_BUFFER = 64 * 1024;

// Turns the script's stdout ("push: N file(s) updated in ...", "pull: N design(s) from <partner> (M new)[; problems: ...]") into the lines to show and one status sentence.
function parseSync(stdout, partner) {
  const lines = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 6).map((l) => l.slice(0, 300));
  let pushed = null, fresh = null, problems = "";
  for (const l of lines) {
    let m = /^push:\s*(\d+)\s+file/i.exec(l); if (m) pushed = Number(m[1]);
    m = /^pull:\s*\d+\s+design.*\((\d+)\s+new\)/i.exec(l); if (m) fresh = Number(m[1]);
    m = /;\s*problems:\s*(.+)$/i.exec(l); if (m) problems = m[1].slice(0, 160);
  }
  let summary = pushed == null && fresh == null ? "Sync finished." : "Synced: " + (pushed == null ? 0 : pushed) + " pushed, " + (fresh == null ? 0 : fresh) + " new from " + (partner || "the other side");
  if (problems) summary += " (problems: " + problems + ")";
  return { lines, summary };
}

// Finds the script and Python through the configuration; null when either is missing. Injected cfg/exists keep it testable.
function syncPlan(cfg, exists) {
  const has = typeof exists === "function" ? exists : (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
  let tools = null, py = null;
  try { tools = cfg.get("sharedTools"); py = cfg.get("pythonExe"); } catch (e) { return null; }
  if (!tools || !py) return null;
  const script = path.join(tools, ...SYNC_REL);
  return has(script) && has(py) ? { python: py, script } : null;
}

function init({ ipcMain, getMainWindow, cfg, openFolder, openExternal, disabled, log, execFile }) {
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
    return { ok: true, items: r.items.map(D.publicItem), canSync: !!syncPlan(cfg), partner: partnerName() };
  });
  const partnerName = () => { try { const v = cfg.get("partnerName"); return typeof v === "string" ? v.slice(0, 40) : ""; } catch (e) { return ""; } };
  let syncing = false;   // one sync at a time: a second click while it runs is ignored
  handle("designs-sync", () => {
    if (disabled && disabled()) return { ok: false, reason: "not-available" };
    const plan = syncPlan(cfg);
    if (!plan) return { ok: false, reason: "not-available" };
    if (syncing) return { ok: false, reason: "busy" };
    syncing = true;
    const run = execFile || require("child_process").execFile;
    const env = Object.assign({}, process.env, libDir() ? { STYLE_LIBRARY_DIR: libDir() } : {});
    return new Promise((resolve) => {
      run(plan.python, [plan.script, "sync"], { timeout: SYNC_TIMEOUT_MS, windowsHide: true, maxBuffer: SYNC_MAX_BUFFER, env, encoding: "utf8", shell: false }, (err, stdout) => {
        syncing = false;
        if (err) { say("designs-sync failed: code=" + (err.code != null ? err.code : err.killed ? "timeout" : "unknown")); resolve({ ok: false, reason: err.killed ? "Sync timed out." : "Sync failed." }); return; }
        const p = parseSync(stdout, partnerName());
        resolve({ ok: true, lines: p.lines, summary: p.summary });
      });
    });
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

module.exports = { init, parseSync, syncPlan };
