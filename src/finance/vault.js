// MY FINANCE vault location guard (v1.90.0, main process). Money data must never sit in a cloud-synced folder or inside the app.
// A string check alone is not enough (review B1): "Dropbox (Personal)", "G:\My Drive", 8.3 short names (DROPBO~1), junctions and symlinks
// into Dropbox, and the \\?\ prefix all slipped past it. So every candidate is checked twice:
//   1. lexically, after stripping \\?\ and \\.\ and normalising, against a wide list of sync-client folder names;
//   2. on the REAL location: the nearest existing ancestor is resolved with fs.realpathSync.native (follows junctions and symlinks,
//      expands 8.3 names), the rest of the path is appended, and the same check runs again.
// UNC / network paths (\\server\share) are refused: the vault is local only (a NAS path is the owner's decision, see the report).
// Not-yet-existing path segments that look like 8.3 short names (XXXXXX~1) are refused, because they cannot be resolved yet.
"use strict";
const fs = require("fs");
const path = require("path");

// One path segment that a sync client owns. Matched against every segment, case-insensitive.
const CLOUD_SEGMENTS = [
  /^dropbox( \(.*\))?$/i, /^dropbox[ ._-].*$/i, /^dropbox$/i,             // Dropbox, "Dropbox (Personal)", "Dropbox (Acmeco)", Dropbox-Business
  /^onedrive( .*)?$/i, /^onedrive[._-].*$/i, /^skydrive$/i,                // OneDrive, "OneDrive - Company"
  /^google ?drive( .*)?$/i, /^my drive$/i, /^shared drives$/i, /^googledrive$/i, // Google Drive for desktop (G:\My Drive)
  /^icloud ?drive( .*)?$/i, /^iclouddrive$/i, /^icloud$/i,
  /^box$/i, /^box sync$/i, /^box drive$/i,
  /^pcloud( drive)?$/i, /^pclouddrive$/i,
  /^mega$/i, /^megasync$/i, /^mega ?sync( .*)?$/i,
  /^sync$/i, /^sync\.com$/i, /^tresorit( .*)?$/i, /^nextcloud$/i, /^owncloud$/i, /^syncthing$/i,
];
const SHORT_NAME = /~\d+$/;                   // an 8.3 alias like DROPBO~1

// "\\?\E:\x" -> "E:\x", "\\?\UNC\srv\s" -> "\\srv\s", "\\.\E:\x" -> "E:\x"
function stripDevicePrefix(p) {
  let s = String(p || "");
  if (/^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(s)) s = "\\\\" + s.slice(8);
  else if (/^[\\/]{2}[?.][\\/]/.test(s)) s = s.slice(4);
  return s;
}
const isUnc = (p) => /^[\\/]{2}[^\\/?.]/.test(p) || /^[\\/]{2}[?.][\\/]UNC/i.test(p);
const segments = (p) => path.resolve(p).split(/[\\/]+/).filter(Boolean);
const lower = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, "");

function cloudSegment(p) { return segments(p).some((seg) => CLOUD_SEGMENTS.some((re) => re.test(seg.trim()))); }
function inside(child, parent) { const c = lower(child), pa = lower(parent); return c === pa || c.startsWith(pa + "\\") || c.startsWith(pa + "/"); }

// The real location: nearest existing ancestor through realpath, plus the not-yet-existing tail. {real, tail[]} or null if nothing resolves.
function realLocation(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try { const real = stripDevicePrefix(fs.realpathSync.native(cur)); return { real: tail.length ? path.join(real, ...tail.slice().reverse()) : real, tail }; }
    catch (e) {
      const up = path.dirname(cur);
      if (up === cur) return null;
      tail.push(path.basename(cur)); cur = up;
    }
  }
  return null;
}

// -> null when the folder is acceptable, else a plain-words reason
function unsafeReason(p, appDir) {
  if (typeof p !== "string" || !p.trim()) return "no folder";
  const raw = p.trim();
  if (isUnc(raw)) return "a network (UNC) path";
  const s = stripDevicePrefix(raw);
  if (!/^[A-Za-z]:[\\/]/.test(s)) return "not a full path with a drive letter";
  // R3: Windows drops a trailing dot or space from a name, but Node creates it literally ("Box." next to "Box"): such a folder cannot be
  // deleted from Explorer, and the name check would not see the sync folder. R6: a ":" after the drive is an alternate data stream.
  const segs = s.slice(3).split(/[\\/]+/).filter(Boolean);
  if (segs.some((g) => g !== "." && g !== ".." && /[. ]$/.test(g))) return "a folder name ending in a dot or a space";
  if (segs.some((g) => g.includes(":"))) return "a name with a colon (a stream name)";
  if (cloudSegment(s)) return "inside a cloud-synced folder";
  const appReal = appDir ? ((realLocation(appDir) || {}).real || path.resolve(appDir)) : null;
  if (appDir && (inside(s, appDir) || (appReal && inside(s, appReal)))) return "inside the app folder";
  const loc = realLocation(s);
  if (!loc) return "the drive does not exist";
  if (isUnc(loc.real)) return "a network (UNC) location";
  if (cloudSegment(loc.real)) return "really inside a cloud-synced folder (through a junction, link or short name)";
  if (appReal && inside(loc.real, appReal)) return "really inside the app folder";
  if (loc.tail.some((seg) => SHORT_NAME.test(seg))) return "a short (8.3) folder name that cannot be checked yet";
  return null;
}

module.exports = { unsafeReason, realLocation, stripDevicePrefix, cloudSegment, CLOUD_SEGMENTS };
