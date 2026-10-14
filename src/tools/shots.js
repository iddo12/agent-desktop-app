// TOOLS screenshots (v1.85.0). Main-process helpers: validate a tool's `screenshots` entries against the disk, make 1120x700 JPEG
// thumbnails ONCE into the app's own cache (userData\tools_thumbs, never Dropbox) and describe each shot for the renderer.
// Entries live in tools.json: screenshots: [{file, caption, taken:"YYYY-MM-DD"}], files at <catalogue dir>\screenshots\<tool-id>\<file>.
// Invalid entries are ignored and reported by code only (never the value).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const EXTS = [".png", ".jpg", ".jpeg"];            // webp dropped: nativeImage decoding of it is not guaranteed
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SHOTS = 6;                       // the drawer shows at most six
const MAX_SIDE = 8000, MAX_PIXELS = 40e6;  // refuse "dimension bombs" before any decode
const NEW_THUMBS_PER_LOAD = 4;             // thumbnails made per snapshot; the rest fill in on the next refresh
const THUMB_W = 1120, THUMB_H = 700, THUMB_Q = 82;   // sharp enough for the Large card size (v1.85.1; was 640x400)
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isInside = (parent, child) => { const rel = path.relative(parent, child); return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel); };
const isRealDate = (s) => { if (typeof s !== "string" || !DATE.test(s)) return false; const d = new Date(s + "T00:00:00Z"); return !isNaN(d) && d.toISOString().slice(0, 10) === s; };

// Reads only the image header. -> { w, h } or null (not a PNG/JPEG, truncated or unreadable). Never decodes.
function readDims(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString("latin1", 12, 16) === "IHDR") return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (n >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let p = 2;
      while (p + 9 < n) {
        if (buf[p] !== 0xff) { p++; continue; }
        const m = buf[p + 1];
        if (m === 0xff) { p++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
        const len = buf.readUInt16BE(p + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
        if (len < 2) return null;
        p += 2 + len;
      }
    }
    return null;
  } catch (e) { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
}
const dimsOk = (d) => !!d && d.w > 0 && d.h > 0 && d.w <= MAX_SIDE && d.h <= MAX_SIDE && d.w * d.h <= MAX_PIXELS;

function plainDir(dir, realBase) {            // a real directory, not a link or junction, and really inside the base
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    return isInside(realBase, fs.realpathSync(dir));
  } catch (e) { return false; }
}

// -> { ok, abs, code }. Never throws.
function checkFile(baseDir, toolId, file) {
  if (typeof file !== "string" || !PLAIN_NAME.test(file) || file.includes("..") || RESERVED.test(file)) return { ok: false, code: "bad-file-name" };
  if (!EXTS.includes(path.extname(file).toLowerCase())) return { ok: false, code: "bad-extension" };
  const shotsDir = path.join(baseDir, "screenshots"), folder = path.join(shotsDir, toolId);
  const abs = path.join(folder, file);
  if (!isInside(folder, abs)) return { ok: false, code: "outside-folder" };
  let realBase;
  try { realBase = fs.realpathSync(baseDir); } catch (e) { return { ok: false, code: "missing" }; }
  if (!fs.existsSync(folder)) return { ok: false, code: "missing" };
  if (!plainDir(shotsDir, realBase) || !plainDir(folder, realBase)) return { ok: false, code: "outside-folder" };
  let st;
  try { st = fs.lstatSync(abs); } catch (e) { return { ok: false, code: "missing" }; }
  if (!st.isFile()) return { ok: false, code: "not-a-file" };            // also refuses symlinks (lstat)
  if (st.size > MAX_BYTES) return { ok: false, code: "too-big" };
  if (st.size < 16) return { ok: false, code: "empty" };
  try { if (!isInside(fs.realpathSync(folder), fs.realpathSync(abs))) return { ok: false, code: "outside-folder" }; } catch (e) { return { ok: false, code: "missing" }; }
  const d = readDims(abs);
  if (!d) return { ok: false, code: "bad-image" };
  if (!dimsOk(d)) return { ok: false, code: "too-large" };
  return { ok: true, abs, size: st.size, mtimeMs: st.mtimeMs };
}

// raw = the shape-checked entries from schema.js ([{file,caption,taken}]). Returns { shots:[{file,caption,taken,abs,size,mtimeMs}], rejected:[{index,code}] }.
function resolveShots(baseDir, toolId, raw) {
  const shots = [], rejected = [], seen = new Set();
  (Array.isArray(raw) ? raw : []).forEach((s, index) => {
    if (!s || typeof s.caption !== "string" || !s.caption.trim() || s.caption.length > 200) { rejected.push({ index, code: "bad-caption" }); return; }
    if (!isRealDate(s.taken)) { rejected.push({ index, code: "bad-date" }); return; }
    const key = typeof s.file === "string" ? s.file.toLowerCase() : "";
    if (key && seen.has(key)) { rejected.push({ index, code: "duplicate" }); return; }
    const c = checkFile(baseDir, toolId, s.file);
    if (!c.ok) { rejected.push({ index, code: c.code }); return; }
    if (shots.length >= MAX_SHOTS) { rejected.push({ index, code: "too-many" }); return; }
    seen.add(key);
    shots.push({ file: s.file, caption: s.caption.trim(), taken: s.taken, abs: c.abs, size: c.size, mtimeMs: c.mtimeMs });
  });
  return { shots, rejected };
}

// "older than v<version>": the shot was taken before the tool's last release date.
function staleLabel(taken, tool) {
  const d = tool && tool.release && tool.release.date;
  if (!d || !DATE.test(String(taken)) || taken >= d) return "";
  const v = String(tool.version || "").replace(/^v/i, "");
  return v ? "older than v" + v : "older than the latest release";
}

function thumbName(shot) { return crypto.createHash("sha1").update(shot.abs + "|" + shot.size + "|" + Math.round(shot.mtimeMs) + "|" + THUMB_W).digest("hex").slice(0, 24) + ".jpg"; }

// Files that failed or were refused are remembered (path+size+mtime) so a refresh does not decode them again.
const failed = new Set();

// Makes (once) and returns the cached thumbnail path, or "" when it cannot be made (now or yet). nativeImage is injected (electron's,
// or a test fake). budget = { left } shared by one snapshot: when it is used up, uncached thumbs are left for the next refresh.
// The thumbnail is cover-cropped to 16:10 (top-left kept) so the card box never stretches a shot.
function ensureThumb(shot, cacheDir, nativeImage, budget) {
  try {
    const name = thumbName(shot);
    const out = path.join(cacheDir, name);
    if (fs.existsSync(out)) return out;
    if (failed.has(name)) return "";
    if (!nativeImage || typeof nativeImage.createFromPath !== "function") return "";
    if (budget) { if (budget.left <= 0) return ""; budget.left--; }
    if (!dimsOk(readDims(shot.abs))) { failed.add(name); return ""; }
    let img = nativeImage.createFromPath(shot.abs);
    if (!img || img.isEmpty()) { failed.add(name); return ""; }
    const sz = img.getSize();
    const w = sz.width, h = sz.height;
    if (w > 0 && h > 0) {
      const want = THUMB_W / THUMB_H;                         // 1.6
      let cw = w, ch = h;
      if (w / h > want) cw = Math.round(h * want); else ch = Math.round(w / want);
      if (cw !== w || ch !== h) img = img.crop({ x: 0, y: 0, width: cw, height: ch });
    }
    if (img.getSize().width > THUMB_W) img = img.resize({ width: THUMB_W, height: THUMB_H, quality: "better" });
    const buf = img.toJPEG(THUMB_Q);
    if (!buf || !buf.length) { failed.add(name); return ""; }
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = out + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, buf); fs.renameSync(tmp, out);
    return out;
  } catch (e) { try { failed.add(thumbName(shot)); } catch (e2) { /* ignore */ } return ""; }
}

// What the renderer gets per shot: URLs only (thumb for cards/strips, full for the lightbox), never a path. thumb "" = not ready.
function describe(shots, tool, cacheDir, nativeImage, budget) {
  return shots.map((s, i) => {
    const t = ensureThumb(s, cacheDir, nativeImage, budget);
    return { index: i, caption: s.caption, taken: s.taken, stale: staleLabel(s.taken, tool), thumb: t ? pathToFileURL(t).href : "", full: pathToFileURL(s.abs).href, pending: !t && !failed.has(thumbName(s)) };
  });
}

module.exports = { EXTS, MAX_BYTES, MAX_SHOTS, MAX_SIDE, MAX_PIXELS, NEW_THUMBS_PER_LOAD, THUMB_W, THUMB_H, readDims, isRealDate, checkFile, resolveShots, staleLabel, thumbName, ensureThumb, describe, _failed: failed };
