// v1.109.0: the ONE "open this path" pipeline for clickable paths in agent chat (replaces registry.openLocalPdf).
// The path text comes from an agent's reply, so it is untrusted: every check happens HERE, in main.
//   - plain local drive-letter path only (no UNC, no \\?\ device path, no alternate data stream, no '..', no reserved names)
//   - lexically under an allowed root BEFORE any fs call (so an offline mapped drive can never hang main)
//   - realpath'd, and the REAL target must be under an allowed root too (no symlink / junction escape)
//   - a regular file with an allow-listed extension (pathLinks.ALLOWED_EXTS), or a folder; never anything executable
//   - shell.openPath only after all of that; each open is logged (path only) and rate-limited
const fs = require("fs");
const path = require("path");
const { isPlainLocalPath } = require("./localPath");
const PL = require("./pathLinks");

function isUnder(root, p, orEqual) {
  const r = path.resolve(root).replace(/[\\/]+$/, "").toLowerCase();
  const q = p.replace(/[\\/]+$/, "").toLowerCase();
  return (orEqual && q === r) || q.startsWith(r + path.sep);
}

const RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function createOpener(cfg) {
  // v1.121.0: roots may be a function so a change made in Setup applies without a restart.
  const getRoots = () => (typeof cfg.roots === "function" ? cfg.roots() : cfg.roots || []).filter(Boolean);
  let realRootsCache = null, realRootsAt = 0, realRootsKey = "";   // real (long, symlink-resolved) form of the roots, recomputed at most every 60 s
  function realRoots() {
    const t = Date.now();
    const roots = getRoots(), key = roots.join("|");   // a changed list (Setup) is never served from the old cache
    if (realRootsCache && key === realRootsKey && t - realRootsAt < 60000) return realRootsCache;
    const out = roots.slice();
    for (const r of roots) { try { out.push(fs.realpathSync.native(r)); } catch (e) { /* root missing */ } }
    realRootsCache = out; realRootsAt = t; realRootsKey = key;
    return out;
  }
  const shell = cfg.shell;
  const log = cfg.log || (() => {});
  const now = cfg.now || (() => Date.now());
  const maxOpens = cfg.maxOpens || 8;
  const windowMs = cfg.windowMs || 10000;
  const opens = [];

  function note(line) { try { log(line); } catch (e) { /* logging must never throw */ } }

  // -> { ok:true, real, kind:"file"|"folder" } | { ok:false, why }
  function check(rawPath) {
    if (typeof rawPath !== "string" || !rawPath || rawPath.length > 1000) return { ok: false, why: "not a path" };
    const s = PL.normalize(rawPath);
    if (!isPlainLocalPath(s)) return { ok: false, why: "not a plain local drive-letter path" };
    const segs = s.slice(3).split("\\").filter((x) => x !== "");
    for (const seg of segs) {
      if (seg === "..") return { ok: false, why: "parent-folder step in path" };
      if (seg === "." || /[. ]$/.test(seg)) return { ok: false, why: "segment ends with a dot or space" };
      if (RESERVED_RE.test(seg)) return { ok: false, why: "reserved device name" };
    }
    const resolved = path.resolve(s);
    if (!getRoots().some((r) => isUnder(r, resolved, true))) return { ok: false, why: "outside the allowed folders" };
    let real;
    try { real = fs.realpathSync.native(resolved); } catch (e) { return { ok: false, why: "does not exist" }; }
    if (!isPlainLocalPath(real)) return { ok: false, why: "real target is not a plain local path" };
    const rootsReal = realRoots();
    if (!rootsReal.some((r) => isUnder(r, real, true))) return { ok: false, why: "real target is outside the allowed folders" };
    let st;
    try { st = fs.statSync(real); } catch (e) { return { ok: false, why: "does not exist" }; }
    if (st.isDirectory()) return { ok: true, real, kind: "folder" };
    if (!st.isFile()) return { ok: false, why: "not a regular file or folder" };
    if (!PL.isAllowedExt(PL.extOf(real))) return { ok: false, why: "file type is not on the allow-list" };
    return { ok: true, real, kind: "file" };
  }

  // guesses: [{text, hasExt}] (or plain strings) -> per guess null | { end, real, kind } (end = length of the matched prefix)
  function resolve(guesses) {
    const list = Array.isArray(guesses) ? guesses.slice(0, 20) : [];
    return list.map((g) => {
      const text = typeof g === "string" ? g : g && g.text;
      if (typeof text !== "string" || !text || text.length > 500) return null;
      for (const p of PL.prefixes(text, g && g.hasExt)) {
        const c = check(p.text);
        if (c.ok) return { end: p.end, real: c.real, kind: c.kind };
      }
      return null;
    });
  }

  async function open(rawPath) {
    const t = now();
    while (opens.length && t - opens[0] > windowMs) opens.shift();
    if (opens.length >= maxOpens) {
      note(`REFUSED (rate limit) ${JSON.stringify(String(rawPath)).slice(0, 300)}`);
      return { ok: false, error: "Too many opens in a row - wait a moment." };
    }
    const c = check(rawPath);
    if (!c.ok) {
      note(`REFUSED ${JSON.stringify(String(rawPath)).slice(0, 300)}: ${c.why}`);
      return { ok: false, error: c.why };
    }
    opens.push(t);
    const err = await shell.openPath(c.real); // "" on success
    if (err) {
      note(`REFUSED ${c.real}: openPath failed: ${err}`);
      return { ok: false, error: "openPath failed: " + err };
    }
    note(`OPENED ${c.kind} ${c.real}`);
    return { ok: true, kind: c.kind };
  }

  return { check, resolve, open };
}

module.exports = { createOpener, isUnder };
