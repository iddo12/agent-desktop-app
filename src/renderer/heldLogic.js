// Pure id-set logic for the held-message approval bar (no DOM). Loaded before intake.js; also required by tests.
// Rule: an approval may only ever cover ids the owner was SHOWN when they confirmed. A message that arrives later is never swept in.
/* global module */
(function (root) {
  "use strict";
  const isHeld = (r) => !!r && r.status === "held" && !r.queued;
  const heldRows = (rows) => (Array.isArray(rows) ? rows.filter(isHeld) : []);
  // A voice note whose transcript is still being made cannot be approved (the owner has not read it).
  const approvable = (r) => isHeld(r) && !(r.voice && (r.transcriptState === "pending" || r.transcriptState === "waiting"));
  const sig = (r) => [r.id, r.text, !!r.voice, r.photos, !!r.video, !!r.hidden, (r.transcriptState === "waiting" ? "pending" : r.transcriptState) || "", r.transcript || ""].join("\u0001");
  // -> { ids: approvable ids among `ids` that are held now, skipped: how many of them were held but still transcribing }
  function plan(ids, rows) {
    const by = new Map(heldRows(rows).map((r) => [r.id, r]));
    const out = []; let skipped = 0;
    for (const id of ids) { const r = by.get(id); if (!r) continue; if (approvable(r)) out.push(id); else skipped++; }
    return { ids: out, skipped };
  }
  // Freeze what the "approve all" bar shows: every approvable held id now, with a signature per held id.
  function freeze(rows) {
    const held = heldRows(rows), p = plan(held.map((r) => r.id), rows);
    const sigs = {}; for (const r of held) sigs[r.id] = sig(r);
    return { ids: p.ids, skipped: p.skipped, sigs };
  }
  // After a refresh: has the held set changed since the bar was frozen? A NEW held id, or a listed row whose content changed, closes the bar.
  // A listed row that disappeared (decided elsewhere) is not a change; plan() just drops it.
  function changed(frozen, rows) {
    for (const r of heldRows(rows)) {
      if (!Object.prototype.hasOwnProperty.call(frozen.sigs, r.id)) return true;
      if (frozen.sigs[r.id] !== sig(r)) return true;
    }
    return false;
  }
  // Final ids for the Yes click: exactly the frozen ids that are still held and approvable; null if the set changed.
  function confirmIds(frozen, rows) {
    if (!frozen || changed(frozen, rows)) return null;
    return plan(frozen.ids, rows);
  }
  const api = { isHeld, approvable, plan, freeze, changed, confirmIds };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.heldLogic = api;
})(typeof window !== "undefined" ? window : this);
