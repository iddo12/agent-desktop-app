// My Designs filter logic (v1.125.0). Pure functions, no DOM. Loaded in the renderer as window.DesignsFilter and by tests via require().
(function (root) {
  "use strict";
  const words = (q) => String(q || "").toLowerCase().split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
  const hay = (e) => [e.name, e.group, e.kind, e.type, e.status, (e.tags || []).join(" "), e.notes, e.reference, e.addedBy].filter((x) => x !== undefined && x !== null && x !== "").join(" \u0001 ").toLowerCase();
  const cmpText = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true });

  // f = { type:"all|motion|still", group:"" , tag:"", status:"all|draft|approved", q:"" }. Search words are ANDed; "#58" or "58" also matches id 58.
  function apply(list, f) {
    f = f || {};
    const ws = words(f.q);
    const out = (list || []).filter((e) => {
      if (f.type && f.type !== "all" && e.type !== f.type) return false;
      if (f.group && e.group !== f.group) return false;
      if (f.tag && !(e.tags || []).includes(f.tag)) return false;
      if (f.status && f.status !== "all" && e.status !== f.status) return false;
      if (!ws.length) return true;
      const h = hay(e);
      return ws.every((w) => { const m = /^#?(\d+)$/.exec(w); return h.includes(w) || (!!m && e.id === Number(m[1])); });   // a number matches the id exactly (not 158 / 580) and still matches text
    });
    return out.sort((a, b) => a.id - b.id);
  }

  // distinct values with counts for the dropdowns, A to Z
  function facets(list, field) {
    const m = new Map();
    for (const e of list || []) for (const v of field === "tags" ? e.tags || [] : [e[field]]) { if (!v) continue; m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].sort((a, b) => cmpText(a[0], b[0])).map(([value, count]) => ({ value, count }));
  }

  // After a reload: a filter value that no longer exists (removed group or tag) goes back to All, so the grid is never empty by accident.
  function sanitize(list, f) {
    const g = new Set((list || []).map((e) => e.group)), tg = new Set();
    for (const e of list || []) for (const v of e.tags || []) tg.add(v);
    const out = Object.assign({}, f);
    if (out.group && !g.has(out.group)) out.group = "";
    if (out.tag && !tg.has(out.tag)) out.tag = "";
    return out;
  }

  const useText = (id) => "use my design #" + id;

  const api = { apply, facets, words, useText, sanitize };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.DesignsFilter = api;
})(typeof window !== "undefined" ? window : this);
