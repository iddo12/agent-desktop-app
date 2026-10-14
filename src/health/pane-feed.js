// My Health visual pane: the ONE file the pane reads (v1.114.0). Main process only.
// Contract (approved by Security 2026-10-11):
//   - The Health Agent writes a single precomputed aggregate file, atomically: <health folder>\vault\pane_feed\health_pane.json
//   - This module reads it from that path (the health folder is the configuration key healthParent, passed in by main; never from the renderer). Only tests may point elsewhere: in TEST MODE the env var AGENT_DESKTOP_HEALTH_PANE_FEED
//     (an absolute path) or, by default, the synthetic sample in tests/fixtures. The env var is ignored in live mode.
//   - The renderer gets only the parsed, normalised JSON (pane-logic.js normalizeFeed). It never receives a path, cannot name a file,
//     and the contents are never logged or copied anywhere. No network. No polling: a read when the pane opens, plus one watch on the
//     feed's own folder while the pane is open (event only: it carries no content, the renderer re-asks).
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("./pane-logic");
const roots = require("./roots");

// TEST MODE ONLY (v1.121.0): the synthetic sample lives in tests/, which an install may not ship. It is looked up lazily, only in test mode; when the file
// is not there the pane simply reports "missing" (readFeed stats the path and answers state "missing"). Live mode never touches tests/.
const sampleFile = () => path.join(__dirname, "..", "..", "tests", "fixtures", "health_pane.sample.json");

// Which file to read. Returns {file, sample} or {file:null, code}.
function resolveFeedPath(opts) {
  const o = opts || {}, e = o.env || {}, fsx = o.fs || fs;
  if (o.testMode) {
    const want = e.AGENT_DESKTOP_HEALTH_PANE_FEED && String(e.AGENT_DESKTOP_HEALTH_PANE_FEED).trim();
    if (want) { if (!path.isAbsolute(want) || /(^|[\\/])\.\.([\\/]|$)/.test(want)) return { file: null, code: "form" }; return { file: want, sample: false }; }
    return { file: o.sample || sampleFile(), sample: true };
  }
  const parentOpt = typeof o.parent === "function" ? o.parent() : o.parent;
  const parent = typeof parentOpt === "string" && parentOpt.trim() ? parentOpt.trim() : null;
  const live = o.live || (parent ? path.join(parent, "vault", "pane_feed", "health_pane.json") : null);
  if (!live || !parent) return { file: null, code: "noparent" };
  const rr = roots.realResolve(live, fsx);                 // a junction, symlink or subst drive in the way is refused
  if (rr.redirected) return { file: null, code: "redirect" };
  if (!roots.inside(rr.real, parent)) return { file: null, code: "outside" };
  return { file: live, sample: false };
}

// Read + validate. Never throws. Returns {state, ...}: ok | missing | invalid | newer | blocked.
//   ok:  {state:"ok", feed, now}   (the renderer decides stale/fresh with `now`, which is main's clock or a test override)
function readFeed(opts) {
  const o = opts || {}, fsx = o.fs || fs, e = o.env || {};
  const nowOf = () => {
    if (o.testMode && e.AGENT_DESKTOP_HEALTH_PANE_NOW) { const t = Date.parse(e.AGENT_DESKTOP_HEALTH_PANE_NOW); if (isFinite(t)) return t; }
    return Date.now();
  };
  const r = resolveFeedPath(o);
  if (!r.file) return { state: "blocked", reason: "The health feed location was not accepted.", code: r.code, now: nowOf() };
  let st;
  try { st = fsx.statSync(r.file); } catch (err) { return { state: "missing", now: nowOf() }; }
  if (!st.isFile()) return { state: "missing", now: nowOf() };
  if (st.size > L.MAX_FEED_BYTES) return { state: "invalid", reason: "The health feed is too large.", code: "size", now: nowOf() };
  let raw;
  try { raw = JSON.parse(String(fsx.readFileSync(r.file, "utf8")).replace(/^\uFEFF/, "")); } catch (err) { return { state: "invalid", reason: "The health feed could not be read.", code: "parse", now: nowOf() }; }
  const n = L.normalizeFeed(raw);
  if (!n.ok) return { state: n.code === "newer" ? "newer" : "invalid", reason: n.reason, code: n.code, now: nowOf() };
  // Sandbox convenience: the synthetic sample is dated when it was written; unless a test pins the clock, make it read as fresh.
  let now = nowOf();
  if (o.testMode && r.sample && !e.AGENT_DESKTOP_HEALTH_PANE_NOW) { const g = Date.parse(n.feed.generated_at); if (isFinite(g)) now = g + 30 * 60000; }
  return { state: "ok", feed: n.feed, now, sample: !!r.sample };
}

// One watch on the feed's own folder, only while the pane is open. onChange() gets no argument (no content, no name).
// Returns {active, stop}. active is false when no watch could be set up (folder missing, watcher error): the caller retries on its next
// call (every paneFeed read). While the feed folder does not exist yet, its PARENT is watched for the folder to appear, so the pane
// fills in by itself when the file first shows up; that watch reports `active:false` so the next read upgrades it to the real one.
function watchFeed(opts, onChange) {
  const o = opts || {}, fsx = o.fs || fs;
  const r = resolveFeedPath(o);
  const out = { active: false, stop() {} };
  if (!r.file) return out;
  const dir = path.dirname(r.file), base = path.basename(r.file).toLowerCase();
  let w = null, timer = null;
  const fire = () => { clearTimeout(timer); timer = setTimeout(() => { try { onChange(); } catch (e) { /* the window may be gone */ } }, 600); };
  const dirExists = (() => { try { return fsx.statSync(dir).isDirectory(); } catch (e) { return false; } })();
  const target = dirExists ? dir : path.dirname(dir), want = dirExists ? base : path.basename(dir).toLowerCase();
  try {
    w = fsx.watch(target, { persistent: false }, (ev, name) => {
      if (name && String(name).toLowerCase() !== want) return;     // only the feed file (or, before the folder exists, the folder name)
      fire();
    });
    w.on("error", () => { out.active = false; });                  // watcher died (folder removed): the next read starts a new one
    out.active = dirExists;
  } catch (e) { w = null; out.active = false; }
  out.stop = () => { clearTimeout(timer); if (w) { try { w.close(); } catch (e) { /* closed */ } w = null; } };
  return out;
}

module.exports = { sampleFile, resolveFeedPath, readFeed, watchFeed };
