"use strict";
// Finds the programs Agent Desktop starts (Claude Code, Node/npm, git, python) on THIS computer (v1.121.0).
// Order for every program: the person's own setting (appConfig key, from the environment or app-config.json, only if the file exists)
// > what the old code found first (PATH lookups, the Claude Desktop package folder) > other usual install places built from
// Windows environment variables (never a fixed drive letter) > not found (null). Nothing here throws and nothing is a person's folder.
//
// Everything is injected so tests run on any machine with a fake file system:
//   createLaunchEnv({ cfg, env, fs, where, platform, path, regQuery })
//     cfg      appConfig (source(), get())   |  where(name) -> first PATH match or null (default: the `where` command)
//     regQuery(key, value) -> string|null (default: `reg query`, Windows only; used for the Node.js install folder)

const nodeFs = require("fs");
const nodePath = require("path");
const childProcess = require("child_process");

// Spawned lookups are slow (a `where` or `reg query` can take tens of ms to seconds on a busy PC), so: a short timeout (2 s), no shell, and
// every answer (including "not found") is remembered for 5 minutes by createLaunchEnv. prime() fills that memory in the background (async) so
// the later synchronous callers find the answer ready instead of waiting for a process.
const SPAWN_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const firstLine = (out) => { const first = String(out).split(/\r?\n/)[0].trim(); return first || null; };
function defaultWhere(name) {
  try {
    return firstLine(childProcess.execFileSync("where", [name], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: SPAWN_TIMEOUT_MS }));
  } catch (e) { return null; } // PATH lookup unavailable or program missing
}
function whereAsync(name) {
  return new Promise((resolve) => {
    try { childProcess.execFile("where", [name], { encoding: "utf-8", windowsHide: true, timeout: SPAWN_TIMEOUT_MS }, (err, out) => resolve(err ? null : firstLine(out))); } catch (e) { resolve(null); }
  });
}
const regMatch = (out, value) => { const m = String(out).match(new RegExp("\\s" + value + "\\s+REG_\\w+\\s+(.+?)\\s*$", "mi")); return m ? m[1].trim() : null; };
function defaultRegQuery(key, value) {
  try {
    return regMatch(childProcess.execFileSync("reg", ["query", key, "/v", value], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: SPAWN_TIMEOUT_MS }), value);
  } catch (e) { return null; }
}
function regQueryAsync(key, value) {
  return new Promise((resolve) => {
    try { childProcess.execFile("reg", ["query", key, "/v", value], { encoding: "utf-8", windowsHide: true, timeout: SPAWN_TIMEOUT_MS }, (err, out) => resolve(err ? null : regMatch(out, value))); } catch (e) { resolve(null); }
  });
}

// The plain-words message shown when Claude Code cannot be found. One place so the banner, the start-agent error and the Setup row agree.
const CLAUDE_MISSING_MESSAGE =
  "Claude Code is not installed on this computer (or Agent Desktop cannot find it). " +
  "Install Claude Code from claude.com/product/claude-code, sign in once, then open Setup > Claude Code and press Fix.";

function createLaunchEnv(deps) {
  const d = deps || {};
  const cfg = d.cfg || null;
  const env = d.env || process.env;
  const fs = d.fs || nodeFs;
  const platform = d.platform || process.platform;
  const P = d.path || (platform === "win32" ? nodePath.win32 : nodePath.posix);
  // answers of the spawned lookups, remembered for 5 minutes (also "not found"); an injected where/regQuery (tests) is used as given
  const now = typeof d.now === "function" ? d.now : Date.now;
  const memo = new Map();
  const recall = (k) => { const h = memo.get(k); return h && now() - h.t < CACHE_TTL_MS ? h : null; };
  const remember = (k, v) => { memo.set(k, { t: now(), v }); return v; };
  const where = d.where || ((name) => { const h = recall("w:" + name); return h ? h.v : remember("w:" + name, defaultWhere(name)); });
  const regQuery = d.regQuery || ((key, value) => { const k = "r:" + key + "|" + value, h = recall(k); return h ? h.v : remember(k, defaultRegQuery(key, value)); });
  try { if (cfg && typeof cfg.onChange === "function") cfg.onChange(() => memo.clear()); } catch (e) { /* no change notifications: the 5 minutes decide */ }

  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
  // "there is an entry here": stat, or (for a link into Claude Desktop's package store that stat cannot follow from some processes) lstat.
  const present = (p) => { if (isFile(p)) return true; try { return !!(fs.lstatSync && fs.lstatSync(p)); } catch (e) { return false; } };
  const joinEnv = (varName, ...segs) => (env[varName] ? P.join(env[varName], ...segs) : null);

  // A value the person set (environment or config file) and that still exists. Auto-detected values are NOT explicit.
  function explicit(key) {
    try {
      if (!cfg) return null;
      const s = cfg.source(key);
      if (s !== "env" && s !== "config") return null;
      const v = cfg.get(key);
      return typeof v === "string" && present(v) ? v : null;
    } catch (e) { return null; }
  }
  const auto = (key) => { try { const v = cfg ? cfg.get(key) : null; return typeof v === "string" && isFile(v) ? v : null; } catch (e) { return null; } };
  const existing = (list) => { for (const p of list) if (p && isFile(p)) return p; return null; };

  // ---- Node.js ----
  function nodeFromRegistry() {
    if (platform !== "win32") return null;
    for (const k of ["HKLM\\SOFTWARE\\Node.js", "HKCU\\SOFTWARE\\Node.js", "HKLM\\SOFTWARE\\WOW6432Node\\Node.js"]) {
      const dir = regQuery(k, "InstallPath");
      if (dir) { const f = P.join(dir, "node.exe"); if (isFile(f)) return f; }
    }
    return null;
  }
  function node() {
    if (platform !== "win32") return explicit("nodeExe") || where("node") || auto("nodeExe");
    return explicit("nodeExe") || where("node.exe") || nodeFromRegistry() || auto("nodeExe")
      || existing([joinEnv("ProgramFiles", "nodejs", "node.exe"), joinEnv("ProgramW6432", "nodejs", "node.exe"), joinEnv("LOCALAPPDATA", "Programs", "nodejs", "node.exe")]);
  }
  // npm lives next to node.exe; `where npm.cmd` first (what the old code did), then the folder of the node we found.
  function npm() {
    if (platform !== "win32") return where("npm");
    const found = where("npm.cmd");
    if (found) return found;
    let n = null; try { n = node(); } catch (e) { n = null; }
    return existing([n ? P.join(P.dirname(n), "npm.cmd") : null, joinEnv("ProgramFiles", "nodejs", "npm.cmd"), joinEnv("ProgramW6432", "nodejs", "npm.cmd")]);
  }
  // The folder to put in front of PATH so `npm`/`node` work for a child process (null = leave PATH alone).
  function nodeDir() { const n = node(); return n ? P.dirname(n) : null; }

  // ---- git ----
  function git() {
    const ex = explicit("gitExe");
    if (ex) return ex;
    if (platform !== "win32") return "git";
    const dirs = String(env.PATH || env.Path || "").split(";").filter(Boolean);
    for (const dir of dirs) { const p = P.join(dir.replace(/"/g, ""), "git.exe"); if (isFile(p)) return p; }
    return existing([
      joinEnv("ProgramFiles", "Git", "cmd", "git.exe"), joinEnv("ProgramFiles", "Git", "bin", "git.exe"),
      joinEnv("ProgramW6432", "Git", "cmd", "git.exe"), joinEnv("LOCALAPPDATA", "Programs", "Git", "cmd", "git.exe"),
    ]);
  }

  // ---- python: the person's setting, else the bare command (exactly what the old code ran), so PATH decides ----
  function pythonCommand() {
    const ex = explicit("pythonExe");
    return ex || "python";
  }
  // Is there a python this app can use? (a setting that still exists, or one found on PATH)
  function pythonFound() { return !!(explicit("pythonExe") || auto("pythonExe")); }

  // ---- Claude Code ----
  // extra.first()  = Agent Desktop's own managed copy (tried before everything)
  // extra.legacy() = the Claude Desktop package folder / `where claude.cmd` chain the old code tried (returns a path or null)
  // Never returns a path that does not exist, so "not installed" is a real answer, not a missing file found later.
  function claude(extra) {
    const x = extra || {};
    const looked = [];
    // trust = the path came from `where` (the old code returned it unchecked: the package-store link can fail a stat yet still launch)
    const tryIt = (source, p, trust) => { if (p) { looked.push(p); if (trust || present(p)) return { ok: true, path: p, source }; } return null; };
    let r;
    if (x.first && (r = tryIt("private", x.first()))) return r;
    if ((r = tryIt("setting", explicit("claudeExe")))) return r;
    if (x.legacy && (r = tryIt("legacy", x.legacy()))) return r;
    if (platform === "win32") {
      if ((r = tryIt("path", where("claude.cmd"), true))) return r;
      if ((r = tryIt("known-place", joinEnv("APPDATA", "npm", "claude.cmd")))) return r; // npm install -g, default prefix (the old code's last stop)
      if ((r = tryIt("path", where("claude.exe"), true))) return r;
      const cands = [
        joinEnv("USERPROFILE", ".local", "bin", "claude.exe"),            // the native installer
        joinEnv("LOCALAPPDATA", "Programs", "claude", "claude.exe"),
      ];
      for (const c of cands) if ((r = tryIt("known-place", c))) return r;
      const n = (() => { try { return npm(); } catch (e) { return null; } })();
      if (n && (r = tryIt("npm-prefix", P.join(P.dirname(n), "claude.cmd")))) return r;
    } else if ((r = tryIt("path", where("claude"), true))) return r;
    if ((r = tryIt("auto", auto("claudeExe")))) return r;
    return { ok: false, reason: "not-installed", looked, message: CLAUDE_MISSING_MESSAGE };
  }

  // Fills the lookup memory in the background (async, nothing blocks), so the synchronous callers above find answers waiting.
  async function prime() {
    if (d.where && d.regQuery) return false; // everything injected: nothing to warm
    const names = platform === "win32" ? ["claude.cmd", "claude.exe", "node.exe", "npm.cmd"] : ["claude", "node", "npm"];
    if (!d.where) await Promise.all(names.map(async (n) => { if (!recall("w:" + n)) remember("w:" + n, await whereAsync(n)); }));
    if (!d.regQuery && platform === "win32" && !recall("w:node.exe")?.v) {
      for (const k of ["HKLM\\SOFTWARE\\Node.js", "HKCU\\SOFTWARE\\Node.js", "HKLM\\SOFTWARE\\WOW6432Node\\Node.js"]) {
        const key = "r:" + k + "|InstallPath";
        if (!recall(key)) remember(key, await regQueryAsync(k, "InstallPath"));
      }
    }
    primedOnce = true;
    return true;
  }
  let primedOnce = false;
  // has prime() finished? (until then a caller that must not wait for a process can skip the spawned lookups)
  const primed = () => primedOnce || !!(d.where && d.regQuery);
  function clearCache() { memo.clear(); primedOnce = false; }

  return { node, npm, nodeDir, git, pythonCommand, pythonFound, claude, explicit, prime, primed, clearCache };
}

function claudeNotInstalledError(detail) {
  const e = new Error(CLAUDE_MISSING_MESSAGE + (detail ? " (" + detail + ")" : ""));
  e.code = "CLAUDE_NOT_INSTALLED";
  return e;
}

module.exports = { createLaunchEnv, claudeNotInstalledError, CLAUDE_MISSING_MESSAGE };
