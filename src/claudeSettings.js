"use strict";
// The two edits Agent Desktop may make in the person's Claude Code settings file (~/.claude/settings.json), v1.121.0:
//   ensureStatusLine()   installs src/statusline.cjs as the status line (usage figures), or upgrades Agent Desktop's own older entry
//   ensureRemoteControl() sets remoteControlAtStartup:true when the person has not chosen either way
// Both run only after the person turned on "Claude Code integration" in Setup (appConfig consent record) - main.js checks that.
//
// Safety rules for the file itself (it also belongs to Claude Code and to the person):
//   - written ATOMICALLY: a temp file in the same folder, then a rename, so a crash never leaves a half-written settings file;
//   - a ONE-TIME backup, settings.json.agentdesktop.bak, is copied before the first change (an existing .bak is never overwritten);
//   - a different, person-made status line is never touched; a parse error means "do nothing" (the file is never replaced by a guess).
//
// grandfather(cfg): an install that already has OUR status line (its command points to this install's statusline.cjs) or already has
// remoteControlAtStartup:true gets a consent record with source "existing-install" once, when it has no claudeIntegration section yet,
// so the update does not silently stop what the person already had. Fails closed on any parse error. A person's own explicit
// remoteControlAtStartup:false is a "no" and grants nothing.
//
// Everything is injectable (home folder, fs, script path, node finder) so the tests run on a temp HOME.

const nodeFs = require("fs");
const nodePath = require("path");

const RATE_LIMIT_REFRESH_INTERVAL_SECONDS = 60;
const BACKUP_NAME = "settings.json.agentdesktop.bak";

function createClaudeSettings(deps) {
  const d = deps || {};
  const fs = d.fs || nodeFs;
  const path = d.path || nodePath;
  const home = d.home;
  const scriptPath = d.scriptPath;
  const findNode = typeof d.findNode === "function" ? d.findNode : () => null;
  const settingsPath = home ? path.join(home, ".claude", "settings.json") : null;
  const backupPath = home ? path.join(home, ".claude", BACKUP_NAME) : null;

  // The parsed settings, {} when the file does not exist yet. Throws when the file exists but cannot be parsed (callers then do nothing).
  function read() {
    if (!settingsPath || !fs.existsSync(settingsPath)) return { settings: {}, existed: false, hadBom: false };
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const hadBom = raw.charCodeAt(0) === 0xfeff;
    const j = JSON.parse(hadBom ? raw.slice(1) : raw);
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("settings.json is not an object");
    return { settings: j, existed: true, hadBom };
  }

  // One-time copy of the original before the first change. Never overwrites an existing backup.
  function backupOnce() {
    if (!settingsPath || !fs.existsSync(settingsPath)) return;
    try { fs.copyFileSync(settingsPath, backupPath, fs.constants ? fs.constants.COPYFILE_EXCL : 1); } catch (e) { /* already there (kept) or not copyable: the change still goes ahead only if the write below works */ }
  }

  // temp file in the same folder + rename = the file is either the old one or the new one, never half of each
  function writeAtomic(settings) {
    const dir = path.dirname(settingsPath);
    backupOnce();
    const tmp = path.join(dir, ".settings.json." + process.pid + "." + Date.now() + ".tmp");
    try {
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
      fs.renameSync(tmp, settingsPath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean */ }
      throw e;
    }
  }

  function isOurStatusLine(sl) {
    return !!(sl && sl.type === "command" && typeof sl.command === "string" && scriptPath && sl.command.includes(scriptPath));
  }

  function ensureStatusLine() {
    try {
      const r = read();
      const settings = r.settings;
      const existing = settings.statusLine;
      // a genuinely different, person-made status line stays untouched; only our own is installed or upgraded
      if (existing && !isOurStatusLine(existing)) { if (r.hadBom) writeAtomic(settings); return { changed: false, reason: "other-statusline" }; }
      const nodeExe = findNode();
      if (!nodeExe) return { changed: false, reason: "no-node" }; // no Node.js: leave the settings alone rather than write a command that cannot run
      const desired = { type: "command", command: `"${nodeExe}" "${scriptPath}"`, refreshInterval: RATE_LIMIT_REFRESH_INTERVAL_SECONDS };
      if (isOurStatusLine(existing) && existing.command === desired.command && existing.refreshInterval === desired.refreshInterval) {
        if (r.hadBom) { writeAtomic(settings); return { changed: true, reason: "bom-removed" }; } // a BOM made Claude Code ignore the file
        return { changed: false, reason: "up-to-date" };
      }
      settings.statusLine = desired;
      writeAtomic(settings);
      return { changed: true, reason: "installed" };
    } catch (e) { return { changed: false, reason: "error" }; } // malformed JSON etc.: not silently overwritten
  }

  function ensureRemoteControl() {
    try {
      const r = read();
      if ("remoteControlAtStartup" in r.settings) {
        if (r.hadBom) { writeAtomic(r.settings); return { changed: true, reason: "bom-removed" }; }
        return { changed: false, reason: "already-chosen" }; // an explicit choice, either way, is left alone
      }
      r.settings.remoteControlAtStartup = true;
      writeAtomic(r.settings);
      return { changed: true, reason: "set" };
    } catch (e) { return { changed: false, reason: "error" }; }
  }

  function grandfather(cfg) {
    try {
      if (!cfg || cfg.hasSection("claudeIntegration")) return { granted: false, reason: "section exists" };
      if (!settingsPath || !fs.existsSync(settingsPath)) return { granted: false, reason: "no settings file" };
      const r = read(); // a parse error throws -> fail closed below
      if (!isOurStatusLine(r.settings.statusLine) && r.settings.remoteControlAtStartup !== true) return { granted: false, reason: "nothing of ours" };
      const g = cfg.grantConsent("claudeIntegration", "existing-install");
      return { granted: !!g.ok, reason: g.ok ? "existing-install" : g.error };
    } catch (e) { return { granted: false, reason: "error" }; }
  }

  return { ensureStatusLine, ensureRemoteControl, grandfather, settingsPath, backupPath, isOurStatusLine };
}

module.exports = { createClaudeSettings, RATE_LIMIT_REFRESH_INTERVAL_SECONDS, BACKUP_NAME };
