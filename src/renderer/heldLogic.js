// Pure id-set logic for the held-message approval bar (no DOM). Loaded before intake.js; also required by tests.
// Rule: an approval may only ever cover ids the owner was SHOWN when they confirmed. A message that arrives later is never swept in.
/* global module */
(function (root) {
  "use strict";
  const isHeld = (r) => !!r && r.status === "held" && !r.queued;
  const heldRows = (rows) => (Array.isArray(rows) ? rows.filter(isHeld) : []);
  // A voice note whose transcript is still being made cannot be approved (the owner has not read it).
  const approvable = (r) => isHeld(r) && !(r.voice && (r.transcriptState === "pending" || r.transcriptState === "waiting"));
  // The owner's edits (drafts[id] = { text?, transcript? }): only fields that differ from the original count; the transcript is editable once it is ready or has failed.
  const editOf = (r, d) => {
    const out = {};
    if (!r || !d) return out;
    if (typeof d.text === "string" && d.text.trim() !== String(r.text || "").trim()) out.text = d.text;
    if (r.voice && (r.transcriptState === "ready" || r.transcriptState === "failed") && typeof d.transcript === "string" && d.transcript.trim() !== String(r.transcript || "").trim()) out.transcript = d.transcript;
    return out;
  };
  const sig = (r, drafts) => [r.id, r.text, !!r.voice, r.photos, !!r.video, !!r.hidden, (r.transcriptState === "waiting" ? "pending" : r.transcriptState) || "", r.transcript || "",
    JSON.stringify(editOf(r, drafts && drafts[r.id]))].join("\u0001");
  // -> { id: { text?, transcript? } } for the held ids that have real edits (what goes to the PC with an Approve)
  function editsFor(ids, rows, drafts) {
    const by = new Map(heldRows(rows).map((r) => [r.id, r])), out = {};
    for (const id of ids) { const r = by.get(id); if (!r) continue; const e = editOf(r, drafts && drafts[id]); if (e.text !== undefined || e.transcript !== undefined) out[id] = e; }
    return out;
  }
  // -> { ids: approvable ids among `ids` that are held now, skipped: how many of them were held but still transcribing }
  function plan(ids, rows) {
    const by = new Map(heldRows(rows).map((r) => [r.id, r]));
    const out = []; let skipped = 0;
    for (const id of ids) { const r = by.get(id); if (!r) continue; if (approvable(r)) out.push(id); else skipped++; }
    return { ids: out, skipped };
  }
  // Freeze what the "approve all" bar shows: every approvable held id now, with a signature per held id.
  function freeze(rows, drafts) {
    const held = heldRows(rows), p = plan(held.map((r) => r.id), rows);
    const sigs = {}; for (const r of held) sigs[r.id] = sig(r, drafts);
    return { ids: p.ids, skipped: p.skipped, sigs };
  }
  // After a refresh: has the held set changed since the bar was frozen? A NEW held id, or a listed row whose content changed, closes the bar.
  // A listed row that disappeared (decided elsewhere) is not a change; plan() just drops it.
  function changed(frozen, rows, drafts) {
    for (const r of heldRows(rows)) {
      if (!Object.prototype.hasOwnProperty.call(frozen.sigs, r.id)) return true;
      if (frozen.sigs[r.id] !== sig(r, drafts)) return true;
    }
    return false;
  }
  // Final ids for the Yes click: exactly the frozen ids that are still held and approvable; null if the set changed.
  function confirmIds(frozen, rows, drafts) {
    if (!frozen || changed(frozen, rows, drafts)) return null;
    return plan(frozen.ids, rows);
  }
  const api = { isHeld, approvable, plan, freeze, changed, confirmIds, editOf, editsFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.heldLogic = api;
})(typeof window !== "undefined" ? window : this);
