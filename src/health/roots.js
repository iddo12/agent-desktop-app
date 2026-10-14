// My Health: where the store lives, and whether a folder is acceptable (review finding F3). Kept apart from service.js so the reminder
// scheduler can find routines.json at start without loading the store, importers or agent-file code.
//
// A candidate folder is REFUSED when it:
//   - is written as a UNC path, a \\?\ or \\.\ device path, or contains a ".." segment or an 8.3 short name (NAME~1);
//   - is redirected: the real path (fs.realpathSync.native of the nearest existing ancestor) differs from the resolved path, i.e. a
//     junction, symlink or subst drive is involved;
//   - sits in a synced folder (a path segment naming a cloud-sync service: OneDrive, Google Drive, iCloud, Box, or a ".dropbox" marker in an ancestor);
//   - in TEST MODE (the sandbox) is, by REAL path, inside the vault or the Health parent folder;
//   - in LIVE mode is not inside the configured health folder (the parent: configuration key healthParent), or has no `.health-root` marker file in
//     the folder or one of its ancestors up to that parent. The default vault needs the marker too: the empty file `.health-root` in the vault root
//     (the original owner's vault already has it; service.js creates it when Setup made the folder and the vault is not there yet, and again at the next start if that first write failed and the vault is still empty).
//   - with no configured health folder in live mode: refused (code noparent) until Setup has one.
// Reasons are returned as short codes and a plain message; the folder name is never put in the message.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const MARKER = ".health-root";
const SYNC_SEG = /^(dropbox( \(.*\))?|onedrive( - .*)?|google ?drive|my drive|icloud( drive)?|iclouddrive|box( sync)?|sync\.com|pcloud|mega)$/i;

const lc = (p) => String(p).replace(/[\\/]+$/, "").toLowerCase();
const insideLc = (c, parent) => c === parent || c.startsWith(parent + "\\") || c.startsWith(parent + "/");
const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, "").toLowerCase();
const inside = (child, parent) => { const c = norm(child), p = norm(parent); return c === p || c.startsWith(p + path.sep); };

// Real path of a folder that may not exist yet: realpath of the nearest existing ancestor + the remainder. `redirected` is true when that
// ancestor's real path is not the path we asked for (ignoring case).
function realResolve(p, fsx) {
  const abs = path.resolve(p); let cur = abs; const rest = [];
  for (let i = 0; i < 64; i++) {
    let real = null;
    try { real = fsx.realpathSync.native ? fsx.realpathSync.native(cur) : fsx.realpathSync(cur); } catch (e) { real = null; }
    if (real != null) return { real: path.join(real, ...rest.reverse()), redirected: lc(real) !== lc(cur) };
    const up = path.dirname(cur); if (up === cur) break; rest.push(path.basename(cur)); cur = up;
  }
  return { real: abs, redirected: false };
}
function isSynced(real, fsx) {
  const parts = real.split(/[\\/]+/).filter(Boolean);
  if (parts.some((s) => SYNC_SEG.test(s))) return true;
  let cur = real;
  for (let i = 0; i < 12; i++) { try { if (fsx.existsSync(path.join(cur, ".dropbox")) || fsx.existsSync(path.join(cur, ".dropbox.cache"))) return true; } catch (e) { /* unreadable */ } const up = path.dirname(cur); if (up === cur) break; cur = up; }
  return false;
}
function hasMarker(real, parentReal, fsx) {
  let cur = real;
  for (let i = 0; i < 12; i++) {
    try { if (fsx.existsSync(path.join(cur, MARKER))) return true; } catch (e) { /* ignore */ }
    if (lc(cur) === lc(parentReal)) return false; const up = path.dirname(cur); if (up === cur) return false; cur = up;
  }
  return false;
}

// opts: {env, testMode, userData, vault, parent, fs}; parent = the health folder (a path, or a function returning it), vault defaults to <parent>\vault.
function resolveRoot(opts) {
  const o = opts || {}, e = o.env || {}, fsx = o.fs || fs;
  const parentOpt = typeof o.parent === "function" ? o.parent() : o.parent;
  const parent = typeof parentOpt === "string" && parentOpt.trim() ? parentOpt.trim() : null;
  const vault = o.vault || (parent ? path.join(parent, "vault") : null);
  const want = e.AGENT_DESKTOP_HEALTH_ROOT && String(e.AGENT_DESKTOP_HEALTH_ROOT).trim();
  const fail = (code, reason) => ({ ok: false, code, reason: reason || "The health store folder was not accepted." });
  // v1.86.0 demo mode: the folder was built from the fixtures a moment ago; accept it as is, so the real vault location is never even probed.
  if (e.AGENT_DESKTOP_DEMO === "1" && o.testMode && want && path.isAbsolute(want)) return { ok: true, root: want, isDefault: false };
  const def = vault ? path.join(vault, "extracted") : null;
  const cand = want || (o.testMode ? path.join(o.userData || os.tmpdir(), "health-test") : def);
  if (!cand) return fail("noparent", "The health folder is not set up yet.");
  const raw = String(cand);
  if (/^\\\\/.test(raw) || /^[\\/]{2}/.test(raw) || /^\\\\[?.]\\/.test(raw)) return fail("form");           // UNC, \\?\ and \\.\ forms
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw) || /~\d/.test(raw)) return fail("form");                           // parent segments, 8.3 short names
  if (!path.isAbsolute(raw)) return fail("form");
  const rr = realResolve(raw, fsx);
  if (rr.redirected) return fail("redirect");
  if (isSynced(rr.real, fsx)) return fail("synced");
  const vaultReal = vault ? realResolve(vault, fsx).real : null, parentReal = parent ? realResolve(parent, fsx).real : null;
  if (o.testMode) {
    if (parent && (insideLc(lc(rr.real), lc(vaultReal)) || insideLc(lc(rr.real), lc(parentReal)) || inside(rr.real, vault) || inside(rr.real, parent))) return fail("vault", "Test mode never uses the real health vault.");
    return { ok: true, root: raw, isDefault: false };
  }
  if (!parentReal) return fail("noparent", "The health folder is not set up yet.");
  if (!insideLc(lc(rr.real), lc(parentReal))) return fail("outside");
  if (fsx.existsSync(vaultReal) && !hasMarker(rr.real, parentReal, fsx)) return fail("marker", "The health folder's marker file (.health-root) is missing. Choose the health folder again in Setup, or add an empty file with that name to the vault folder.");
  return { ok: true, root: raw, isDefault: !want, vault, parent };
}

module.exports = { MARKER, resolveRoot, inside, norm, realResolve, isSynced };
