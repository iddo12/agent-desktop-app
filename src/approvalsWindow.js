// THYRA DOCK WINDOW (v1.153.0-pre): the Approvals list as its own small, movable, always-on-top window the owner can keep open all day (second screen).
// Pure helpers: remembered state (bounds + open flag) and clamping a saved position onto a screen that still exists (a monitor can be unplugged).
// Nothing here answers a prompt; the dock window uses the same owner-click-only IPC as the pop-up (src/approvalsPopup.js has the rules).
"use strict";
const fs = require("fs"), path = require("path");

const DEFAULT = { width: 340, height: 420 }, MIN = { width: 220, height: 140 }, TAB = { width: 200, height: 34 }, MAX_SIZE = 4000;

function readState(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const b = j && j.bounds, num = (v) => typeof v === "number" && isFinite(v);
    const rb = (b) => (b && num(b.x) && num(b.y) && num(b.width) && num(b.height) ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null);
    return { open: j && j.open === true, onTop: !(j && j.onTop === false), collapsed: !!(j && j.collapsed === true), bounds: rb(b), full: rb(j && j.full) };
  } catch (e) { return { open: false, onTop: true, collapsed: false, bounds: null, full: null }; }
}
function writeState(file, st) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ open: !!st.open, onTop: st.onTop !== false, collapsed: !!st.collapsed, bounds: st.bounds || null, full: st.full || null }));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}
// workAreas: [{x,y,width,height}] of every display. Returns bounds that are at least half visible on some display, size within limits;
// a position on a screen that is gone falls back to the top-right corner of the primary (first) work area.
function clampBounds(saved, workAreas, minSize) {
  const mn = minSize || MIN;
  const wa = (workAreas && workAreas.length) ? workAreas : [{ x: 0, y: 0, width: 1280, height: 720 }];
  const size = (b) => ({ width: Math.max(mn.width, Math.min(MAX_SIZE, Math.round(b ? b.width : DEFAULT.width))), height: Math.max(mn.height, Math.min(MAX_SIZE, Math.round(b ? b.height : DEFAULT.height))) });
  const s = size(saved);
  if (saved) {
    for (const a of wa) {
      const ox = Math.min(saved.x + s.width, a.x + a.width) - Math.max(saved.x, a.x), oy = Math.min(saved.y + s.height, a.y + a.height) - Math.max(saved.y, a.y);
      if (ox >= s.width / 2 && oy >= Math.min(s.height, 80)) return { x: saved.x, y: saved.y, width: s.width, height: s.height };   // still on a screen
    }
  }
  const p = wa[0];
  const w = Math.min(s.width, p.width), h = Math.min(s.height, p.height);
  return { x: p.x + p.width - w - 16, y: p.y + 16, width: w, height: h };
}
module.exports = { readState, writeState, clampBounds, DEFAULT, MIN, TAB };
