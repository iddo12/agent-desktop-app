// MY RESEARCH unread badge (v1.107.0). PURE logic (no fs, no electron): main-research.js feeds it the findings on disk and the persisted state
// (inside research_prefs.json). Every finding is shown (no gating on pictures); this only decides which are UNREAD.
//
// State (inside research_prefs.json, validated by cleanState, bounded):
//   gatingStart  ms timestamp of the first evaluation after the update. At that moment every finding that exists is GRANDFATHERED as read
//                (put into `seen`), so the badge starts at 0, not at the size of the backlog.
//   seen         keys the owner has read.
// Key = week|agent(lower case)|findingId, the same shape as the image-wrong key.
"use strict";

const MAX_SEEN = 5000;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const KEY_RE = /^\d{4}-W\d{2}\|[^|]{1,120}\|.{1,120}$/;

const lower = (v) => String(v == null ? "" : v).trim().toLowerCase();
const keyOf = (week, agent, id) => week + "|" + lower(agent) + "|" + String(id == null ? "" : id);
// the folder name Graphics uses: lower case, every run of non-alphanumerics becomes one "-"
const slugOf = (agent) => lower(agent).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const goodKey = (k) => typeof k === "string" && k.length < 300 && KEY_RE.test(k);

// the prefs file -> a clean state; anything of the wrong type is dropped (never trusted from disk)
function cleanState(j) {
  const o = j && typeof j === "object" && !Array.isArray(j) ? j : {};
  const seen = new Set(), out = [];
  for (const k of Array.isArray(o.seen) ? o.seen : []) if (goodKey(k) && !seen.has(k)) { seen.add(k); out.push(k); }
  const gs = typeof o.gatingStart === "number" && Number.isFinite(o.gatingStart) && o.gatingStart > 0 ? o.gatingStart : null;
  return { gatingStart: gs, seen: out.slice(-MAX_SEEN) };
}

// items: [{ week, agent, id }] (every finding on disk, all weeks); state: prefs; now: ms
// -> { state, changed, unread:Set, count }
function evaluate(o) {
  const items = (o.items || []).map((x) => ({ key: keyOf(x.week, x.agent, x.id), week: x.week, id: x.id, agent: x.agent })).filter((x) => WEEK_RE.test(x.week) && x.id && lower(x.agent));
  const st = cleanState(o.state);
  const seen = new Set(st.seen);
  let changed = false;
  if (st.gatingStart === null) {
    // first evaluation after the update: everything that exists is read. Never on an empty listing (a folder that could not be read
    // would otherwise turn the whole backlog into 'new' on the next call).
    if (!items.length) return { state: st, changed: false, unread: new Set(), count: 0 };
    st.gatingStart = o.now; changed = true;
    for (const x of items) seen.add(x.key);
  }
  const unread = new Set();
  for (const x of items) if (!seen.has(x.key)) unread.add(x.key);
  return { state: { gatingStart: st.gatingStart, seen: [...seen].slice(-MAX_SEEN) }, changed, unread, count: unread.size };
}

// mark keys as read. Only keys that exist right now are accepted (the renderer cannot stuff the list with anything else).
function markSeen(state, keys, existing) {
  const st = cleanState(state), seen = new Set(st.seen);
  let added = 0;
  for (const k of keys || []) if (goodKey(k) && existing.has(k) && !seen.has(k)) { seen.add(k); added++; }
  return { state: { gatingStart: st.gatingStart, seen: [...seen].slice(-MAX_SEEN) }, added };
}

// ---- art manifests. Graphics writes { "<agent display name>/<findingId>": { image: "<absolute path>", label } }.
// -> Map(lower("agent/findingId") -> image path string). A bad file or a bad entry gives an empty map / is skipped.
function manifestIndex(json) {
  const m = new Map();
  if (!json || typeof json !== "object" || Array.isArray(json)) return m;
  const src = json.items && typeof json.items === "object" && !Array.isArray(json.items) ? json.items : json;   // tolerate a wrapper
  for (const [k, v] of Object.entries(src)) {
    if (typeof k !== "string" || k.indexOf("/") < 1 || k.length > 300) continue;
    const img = typeof v === "string" ? v : v && typeof v === "object" && typeof v.image === "string" ? v.image : "";
    if (img && img.length < 1000) m.set(lower(k), img);
  }
  return m;
}
const manifestKey = (agent, id) => lower(agent) + "/" + String(id).toLowerCase();

module.exports = { evaluate, markSeen, cleanState, keyOf, slugOf, goodKey, manifestIndex, manifestKey, MAX_SEEN, WEEK_RE };
