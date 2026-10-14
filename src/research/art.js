// MY RESEARCH art finder (v1.107.0, main process). Finds the picture Graphics made for a finding. The folders are FIXED by the caller;
// the renderer never supplies a path. Three sources, first hit wins:
//   1. <shared>\<week>\manifest.json   (shared_reports\research_art; { "<agent>/<findingId>": { image, label } })
//   2. <shared>\<week>\<agent-slug>\<findingId>.png   (the file itself; also .jpg/.jpeg/.webp)
//   3. <graphics>\<week>\manifest.json   (Graphics Agent\research_art; lower priority, it holds only the first few images)
// A file counts as "ready" only when it is a plain file (no symlink), non-empty, at most MAX_BYTES, has an image extension, sits inside an allowed
// root, and is at least SETTLE_MS old (not still being written). A missing or corrupt manifest simply finds nothing from that source.
"use strict";
const fs = require("fs");
const path = require("path");
const U = require("./unread");

const SETTLE_MS = 5000, MAX_BYTES = 8 * 1024 * 1024, MAX_MANIFEST = 2 * 1024 * 1024;
const EXT = [".png", ".jpg", ".jpeg", ".webp"];
const ID_RE = /^[\w.\- ]{1,120}$/;

function createArt(o) {
  const shared = o.sharedDir, graphics = o.graphicsDir;
  const roots = (o.allowedRoots || [shared, graphics]).filter(Boolean).map((r) => path.resolve(r));
  const clock = typeof o.now === "function" ? o.now : () => Date.now();
  const memo = new Map();                                  // manifest file -> { sig, map }

  const inside = (f) => roots.some((r) => { const rel = path.relative(r, f); return rel && !rel.startsWith("..") && !path.isAbsolute(rel); });
  function usable(f) {
    if (typeof f !== "string" || !f || f.length > 1000 || f.indexOf("\0") >= 0) return null;
    const abs = path.resolve(f);
    if (EXT.indexOf(path.extname(abs).toLowerCase()) < 0 || !inside(abs)) return null;
    let st; try { st = fs.lstatSync(abs); } catch (e) { return null; }
    try { if (!inside(fs.realpathSync.native(abs)) && !roots.some((r) => { try { return path.relative(fs.realpathSync.native(r), fs.realpathSync.native(abs)).indexOf("..") !== 0; } catch (e) { return false; } })) return null; } catch (e) { return null; }   // a junction in a parent folder must not lead outside the art folders
    if (!st.isFile() || st.size <= 0 || st.size > MAX_BYTES) return null;
    if (clock() - st.mtimeMs < SETTLE_MS) return null;
    return abs;
  }
  function manifest(file) {
    let st; try { st = fs.lstatSync(file); } catch (e) { memo.delete(file); return new Map(); }
    if (!st.isFile() || st.size > MAX_MANIFEST) return new Map();
    const sig = st.mtimeMs + ":" + st.size, hit = memo.get(file);
    if (hit && hit.sig === sig) return hit.map;
    let map = new Map();
    try { map = U.manifestIndex(JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""))); } catch (e) { map = new Map(); }
    if (memo.size > 200) memo.clear();
    memo.set(file, { sig, map });
    return map;
  }
  // -> absolute path of a ready picture, or null
  function find(week, agent, id) {
    if (!U.WEEK_RE.test(week) || typeof id !== "string" || !ID_RE.test(id) || id === "." || id === ".." || typeof agent !== "string" || !agent.trim()) return null;
    const mk = U.manifestKey(agent, id);
    if (shared) {
      const hit = usable(manifest(path.join(shared, week, "manifest.json")).get(mk));
      if (hit) return hit;
      const slug = U.slugOf(agent);
      if (slug) for (const ext of EXT) { const f = usable(path.join(shared, week, slug, id + ext)); if (f) return f; }
    }
    if (graphics) { const hit = usable(manifest(path.join(graphics, week, "manifest.json")).get(mk)); if (hit) return hit; }
    return null;
  }
  return { find, has: (week, agent, id) => !!find(week, agent, id) };
}

module.exports = { createArt, SETTLE_MS, MAX_BYTES };
