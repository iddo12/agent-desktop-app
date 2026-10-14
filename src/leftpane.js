// Left pane layout logic (v1.80.0). Pure: no DOM, no Electron, loads in Node (tests) and as a renderer script.
// The DOM work is in renderer/leftpane.js; this file only decides WHAT goes where, so it can be unit-tested.
//
// Layout setting: "compact" (default: Systems as an icon grid, bare agent rows) or "classic" (the pre-1.80 stack).
// Anything that is not exactly "classic" means compact, and the renderer falls back to classic if building the
// compact layout throws, so a bad stored value or a bug can never leave the pane without its entries.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LeftPane = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // "dock" = Option F (Systems as a two-column card grid with a More card, bare rows, ONE dock for the selected agent),
  // "grid" = Option C (Systems as an icon grid with dim soon tiles, a legend bar, rows without description),
  // "classic" = the stack from before v1.80.0. UI-UX layouts v2 (2026-10-06); the owner picked C and F on 2026-10-07.
  const LAYOUTS = ["dock", "grid", "classic"];
  const DEFAULT_LAYOUT = "dock";
  const LAYOUT_LABELS = { dock: "F: selected-agent dock", grid: "C: Systems icon grid", classic: "Classic (before 1.80)" };

  // The live systems, in tile order. `sel` finds the entry the owning module already put in the sidebar; the tile
  // reuses that very element (click handlers, badges, hover digests all keep working), it is only moved and restyled.
  const SYSTEMS = [
    { id: "argus", sel: ".argus-nav", label: "ARGUS" },
    { id: "memory", sel: ".memory-nav", label: "MEMORY" },
    { id: "daily", sel: ".daily-nav", label: "My Daily" },
    { id: "iris", sel: ".iris-nav", label: "IRIS" },
    { id: "library", sel: "#library-nav", label: "Library" },
  ];

  // Systems that are coming. A tile here is dim and does nothing. When a module later adds a real entry for the same
  // id (give its sidebar element data-system-nav="health"), that entry replaces the placeholder: a new system adds a
  // tile, not a row.
  const SOON = [
    { id: "health", label: "Health" },
    { id: "tasks", label: "Tasks" },
    { id: "reviews", label: "Reviews" },
    { id: "tools", label: "Tools" },
  ];

  // The run-state legend shown as a hover tip on the state square. Same wording as the legend header-tasks.js draws under
  // the list (swatch classes are the existing .xp-lg / .xp-lg-need ones, so the colours are never copied anywhere).
  const LEGEND = [
    { cls: "xp-lg xp-lg-off", glyph: "", label: "not running" },
    { cls: "xp-lg xp-lg-ready", glyph: "", label: "open, waiting" },
    { cls: "xp-lg xp-lg-working", glyph: "", label: "working now" },
    { cls: "xp-lg-need blocked", glyph: "!", label: "blocked: can't progress, act now" },
    { cls: "xp-lg-need pending", glyph: "…", label: "pending: queued, still working" },
    { cls: "xp-lg-need stopped", glyph: "○", label: "stopped: nobody blocked it, look" },
  ];

  // A stored value that is not one of the three (old "compact", garbage, null) means the default.
  function normalizeLayout(v) { return LAYOUTS.indexOf(v) >= 0 ? v : DEFAULT_LAYOUT; }

  // Collapsed = icon strip (labels and "soon" tiles hidden). Stored as "1"/"0"; anything else = expanded.
  function parseCollapsed(raw) { return raw === "1" || raw === true || raw === "true"; }
  function serializeCollapsed(b) { return b ? "1" : "0"; }

  // foundIds: ids of the live system entries that exist in the DOM now. extraIds: ids of any further entries tagged
  // data-system-nav. Returns the tile list in display order: live (known order, then extras), then the soon tiles
  // whose id is not live yet. Unknown/duplicate ids are ignored.
  function planTiles(foundIds, extraIds) {
    const found = new Set(foundIds || []);
    const tiles = [];
    const seen = new Set();
    for (const s of SYSTEMS) if (found.has(s.id)) { tiles.push({ id: s.id, kind: "live", label: s.label, wide: !!s.wide }); seen.add(s.id); }
    for (const id of extraIds || []) {
      if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,23}$/.test(id) || seen.has(id)) continue;
      tiles.push({ id, kind: "live", label: id, wide: false }); seen.add(id);
    }
    for (const s of SOON) if (!seen.has(s.id)) tiles.push({ id: s.id, kind: "soon", label: s.label, wide: false });
    return tiles;
  }

  // Memory line for the dock from the three bar widths ("97%", "30%", "60%", or numbers). L1 is % of its 4 KB cap, L2/L3
  // are % of their scales (same meaning as the bars). Returns "" when there are no figures.
  function parsePct(v) { const n = parseFloat(v); return isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null; }
  function memoryLine(widths) {
    if (!Array.isArray(widths) || widths.length < 3) return "";
    const p = widths.slice(0, 3).map(parsePct);
    if (p.some((x) => x == null)) return "";
    return "L1 " + p[0] + "% · L2 " + p[1] + "% · L3 " + p[2] + "%";
  }

  // What the dock shows for the selected agent. `row` is a plain object read off the selected row. Returns null when
  // nothing is selected. `sig` changes only when something visible changes, so the renderer rewrites the dock rarely.
  function dockModel(row) {
    if (!row || !row.folder) return null;
    const paused = !!row.paused;
    return { folder: row.folder, name: row.name || row.folder, role: row.role || "", state: row.state || "off", paused,
      memory: memoryLine(row.widths), action: paused ? "Resume" : "Pause",
      sig: [row.folder, row.name, row.role, row.state, paused ? 1 : 0, memoryLine(row.widths), row.needs || ""].join("|") };
  }


  // ---- v1.83.2 refinements (UI-UX review of the left pane) ----

  // Library counts: an en dash until the registry has answered, so a zero reads as real, not as "not loaded yet".
  const DASH = "–";
  function countText(n, loaded) { return loaded ? String(Number.isFinite(n) ? n : 0) : DASH; }

  // C's legend card: collapsed behind a "?" button. Stored "1" = open, "0" = closed. Nothing stored yet (first run)
  // means open ONCE (persist:true tells the renderer to write "0" so it starts closed from the next load on).
  function legendInitial(raw) {
    if (raw === null || raw === undefined) return { open: true, persist: true };
    return { open: parseCollapsed(raw), persist: false };
  }

  // The "N coming" line that replaces the word "soon" repeated on every disabled tile. "" when nothing is coming.
  function comingLine(n) { return n > 0 ? n + " coming" : ""; }

  // Run state of an agent row, as words and as the shape drawn on the avatar (the same shapes the legend uses, so colour is
  // never the only signal). state: "working" | "ready" | anything else = off.
  const STATE_WORDS = { working: "Working now", ready: "Open, waiting", off: "Not running" };
  const STATE_SHAPES = { working: "triangle", ready: "pause bars", off: "hollow square" };
  function stateKey(state) { return state === "working" || state === "ready" ? state : "off"; }
  function stateWord(state) { return STATE_WORDS[stateKey(state)]; }
  function stateShape(state) { return STATE_SHAPES[stateKey(state)]; }
  // Needs badge (blocked / pending / stopped): the row's own reason text if there is one, else the kind in words.
  const NEEDS_WORDS = { blocked: "Blocked: can't progress, act now", pending: "Pending: queued, still working", stopped: "Stopped: nobody blocked it, look" };
  function needsWord(kind, why) { return NEEDS_WORDS[kind] ? (why ? String(why) : NEEDS_WORDS[kind]) : ""; }
  // The agent's own health reading (the small dot at the right of a row). Separate from the run state.
  const HEALTH_WORDS = { Healthy: "healthy", Warning: "warning", Critical: "critical", Unknown: "no reading" };
  function healthWord(label) { return "Health: " + (HEALTH_WORDS[label] || HEALTH_WORDS.Unknown); }

  return { countText, legendInitial, comingLine, stateWord, stateShape, needsWord, healthWord, LAYOUTS, LAYOUT_LABELS, parsePct, memoryLine, dockModel, DEFAULT_LAYOUT, SYSTEMS, SOON, LEGEND, normalizeLayout, parseCollapsed, serializeCollapsed, planTiles };
});
