// My Designs data (v1.125.0). Reads the shared style library (styles.json + its preview files) and turns it into a clean, bounded list
// for the page. Pure Node, no electron. The library folder comes from the configuration (key styleLibrary), never from a built-in path.
// Everything from the file is untrusted: text is clipped, colours are checked, a preview must be a known media type that sits really
// inside the library folder (no ".." and no symlink escape); the renderer only ever receives the checked absolute preview path.
"use strict";
const fs = require("fs");
const path = require("path");

const MAX_FILE = 8 * 1024 * 1024;     // styles.json larger than this is refused
const MAX_ITEMS = 5000;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEO_EXTS = new Set([".mp4", ".webm"]);
const PARTNER_KEY = "partner";           // folder + origin tag the sync tool uses for the other side's designs (<library>/<PARTNER_KEY>/styles.json)
const PARTNER_ID_BASE = 100000;       // partner design "M-N" gets the internal integer id 100000+N so every IPC keeps taking an integer
const PARTNER_ID = /^M-(\d{1,5})$/;
const HEX = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const clip = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, n);

function isInside(parent, child) { const rel = path.relative(parent, child); return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel); }

// -> { file, kind:"image"|"video" } or null
function resolvePreview(dir, rel, realDir) {
  if (typeof rel !== "string" || !rel || rel.length > 300) return null;
  const ext = path.extname(rel).toLowerCase();
  const kind = IMAGE_EXTS.has(ext) ? "image" : VIDEO_EXTS.has(ext) ? "video" : null;
  if (!kind) return null;
  const abs = path.resolve(dir, rel);
  if (!isInside(path.resolve(dir), abs)) return null;
  let real;
  try { real = fs.realpathSync.native(abs); if (!fs.statSync(real).isFile()) return null; } catch (e) { return null; }
  if (!isInside(realDir, real)) return null;
  return { file: real, kind };
}

function inferType(s, kind) {
  if (s.type === "motion" || s.type === "still" || s.type === "transition" || s.type === "effect") return s.type;
  const ext = path.extname(String(s.preview || "")).toLowerCase();
  return kind === "video" || ext === ".gif" ? "motion" : "still";
}

// opt = { id, label, origin } overrides the id for the partner list (already validated by the caller)
function cleanEntry(s, dir, realDir, opt) {
  if (!s || typeof s !== "object") return null;
  if (!opt && (!Number.isInteger(s.id) || s.id < 1)) return null;
  const id = opt ? opt.id : s.id;
  const pv = resolvePreview(dir, s.preview, realDir);
  const palette = (Array.isArray(s.palette) ? s.palette : []).map((c) => String(c).trim()).filter((c) => HEX.test(c)).slice(0, 12);
  const ref = clip(s.reference, 500).trim();
  return {
    id, label: opt ? opt.label : "#" + id, origin: opt ? opt.origin : "",
    name: clip(s.name, 200) || ("Design " + (opt ? opt.label : id)), group: clip(s.group, 120),
    type: inferType(s, pv && pv.kind), kind: clip(s.kind, 40),
    tags: (Array.isArray(s.tags) ? s.tags : []).map((t) => clip(t, 40).trim()).filter(Boolean).slice(0, 30),
    status: s.status === "approved" ? "approved" : "draft",
    previewFile: pv ? pv.file : "", previewKind: pv ? pv.kind : "none",
    source: clip(s.source, 500), reference: ref, referenceIsUrl: /^https?:\/\/\S+$/i.test(ref),
    palette, notes: clip(s.notes, 1000), addedBy: clip(s.added_by, 80), added: clip(s.added, 40),
    durationS: Number.isFinite(s.duration_s) && s.duration_s > 0 ? s.duration_s : 0,
  };
}

// The other side's synced designs: <dir>/<PARTNER_KEY>/styles.json. Any problem = an empty list (the main list never fails because of it).
function loadPartner(dir, realDir) {
  try {
    const file = path.join(dir, PARTNER_KEY, "styles.json");
    if (fs.statSync(file).size > MAX_FILE) return [];
    const doc = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    const list = doc && Array.isArray(doc.styles) ? doc.styles : [];
    const out = [], seen = new Set();
    for (const s of list.slice(0, MAX_ITEMS)) {
      const m = s && typeof s === "object" && typeof s.id === "string" ? PARTNER_ID.exec(s.id) : null;
      if (!m || Number(m[1]) < 1) continue;
      const id = PARTNER_ID_BASE + Number(m[1]);
      if (seen.has(id)) continue;
      const e = cleanEntry(s, dir, realDir, { id, label: "M-" + Number(m[1]), origin: PARTNER_KEY });
      if (e) { seen.add(id); out.push(e); }
    }
    return out.sort((a, b) => a.id - b.id);
  } catch (e) { return []; }
}

// load(dir) -> { ok:true, items:[...sorted by id], dir } | { ok:false, reason:"needs-setup"|"missing"|"unreadable"|"too-big" }
function load(dir) {
  if (!dir || typeof dir !== "string") return { ok: false, reason: "needs-setup" };
  const file = path.join(dir, "styles.json");
  let raw, realDir;
  try {
    realDir = fs.realpathSync.native(dir);
    const st = fs.statSync(file);
    if (st.size > MAX_FILE) return { ok: false, reason: "too-big" };
    raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch (e) { return { ok: false, reason: e && e.code === "ENOENT" ? "missing" : "unreadable" }; }
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { return { ok: false, reason: "unreadable" }; }
  const list = doc && Array.isArray(doc.styles) ? doc.styles : null;
  if (!list) return { ok: false, reason: "unreadable" };
  const seen = new Set(), items = [];
  for (const s of list.slice(0, MAX_ITEMS)) {
    const e = cleanEntry(s, dir, realDir);
    if (e && !seen.has(e.id)) { seen.add(e.id); items.push(e); }
  }
  items.sort((a, b) => a.id - b.id);
  for (const e of loadPartner(dir, realDir)) if (!seen.has(e.id)) { seen.add(e.id); items.push(e); }   // after the own list, by number
  return { ok: true, items, dir };
}

// What the renderer gets: no filesystem facts beyond the preview path; the source path is shown as text only.
const publicItem = (e) => ({ id: e.id, label: e.label, origin: e.origin, name: e.name, group: e.group, type: e.type, kind: e.kind, tags: e.tags, status: e.status, preview: e.previewFile, previewKind: e.previewKind, source: e.source, reference: e.reference, referenceIsUrl: e.referenceIsUrl, palette: e.palette, notes: e.notes, addedBy: e.addedBy, added: e.added, durationS: e.durationS });

function findById(dir, id) { const r = load(dir); if (!r.ok) return null; return r.items.find((e) => e.id === id) || null; }

module.exports = { load, publicItem, findById, resolvePreview, isInside, HEX };
