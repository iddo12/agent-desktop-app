// Library search / filter / sort / group logic (v1.84.2). Pure functions, no DOM: the renderer (library.js) draws, this decides.
// Loaded in the renderer as window.LibraryFilter and by tests/libraryFilter.test.js through require().
(function (root) {
  "use strict";

  const DAY = 86400000;

  // Words typed in the search box. Every word must appear somewhere in the entry (AND), in any order, case-insensitive.
  function words(query) {
    return String(query || "").toLowerCase().split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
  }

  function fileName(link) {
    const s = String(link || "").split(/[?#]/)[0].replace(/\\/g, "/");
    return s.slice(s.lastIndexOf("/") + 1);
  }

  function haystack(e) {
    return [e.title, e.description, e.topic, e.agent, fileName(e.link), e.stage, e.status].filter(Boolean).join(" \u0001 ").toLowerCase();
  }

  function matches(e, ws) {
    if (!ws.length) return true;
    const h = haystack(e);
    return ws.every((w) => h.includes(w));
  }

  function ageDays(e, now) {
    const t = Date.parse((e && (e.updatedAt || e.createdAt)) || "");
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.floor(((now || Date.now()) - t) / DAY));
  }

  // "today" / "3d ago" / "5w ago" / "4mo ago" / "2y ago"; "" when there is no date.
  function relAge(e, now) {
    const d = ageDays(e, now);
    if (d === null) return "";
    if (d === 0) return "today";
    if (d < 14) return d + "d ago";
    if (d < 60) return Math.floor(d / 7) + "w ago";
    if (d < 730) return Math.floor(d / 30) + "mo ago";
    return Math.floor(d / 365) + "y ago";
  }

  function withinDays(e, days, now) {
    if (!days) return true;
    const d = ageDays(e, now);
    return d !== null && d < Number(days);
  }

  const cmpText = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true });
  const time = (e) => { const t = Date.parse(e.updatedAt || e.createdAt || ""); return Number.isFinite(t) ? t : 0; };

  const SORTS = {
    updated: (a, b) => time(b) - time(a) || cmpText(a.title, b.title),
    oldest: (a, b) => time(a) - time(b) || cmpText(a.title, b.title),
    title: (a, b) => cmpText(a.title, b.title),
    agent: (a, b) => cmpText(a.agent, b.agent) || time(b) - time(a),
  };

  function sort(list, by) {
    return list.slice().sort(SORTS[by] || SORTS.updated);
  }

  // Groups keep the order of the (already sorted) list inside each group; groups themselves go biggest first, then A to Z,
  // and "(none)" always last.
  function group(list, by) {
    if (by !== "topic" && by !== "agent") return [{ key: "", label: "", items: list }];
    const m = new Map();
    for (const e of list) {
      const k = String(e[by] || "").trim() || "(none)";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    return [...m.entries()]
      .sort((a, b) => (a[0] === "(none)") - (b[0] === "(none)") || b[1].length - a[1].length || cmpText(a[0], b[0]))
      .map(([key, items]) => ({ key, label: key, items }));
  }

  // Distinct values of a field with counts, for the filter dropdowns (biggest first).
  function facets(list, field) {
    const m = new Map();
    for (const e of list) { const k = String(e[field] || "").trim(); if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || cmpText(a[0], b[0]));
  }

  // A stable small number per name, so the same agent / category always gets the same chip colour.
  function hue(name) {
    let h = 0;
    for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  // Splits text into [{t, hit}] parts for highlighting the search words (DOM-free; the caller builds text nodes and <mark>).
  function highlightParts(text, ws) {
    const s = String(text || "");
    if (!ws.length || !s) return [{ t: s, hit: false }];
    const esc = ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
    const re = new RegExp("(" + esc.join("|") + ")", "ig");
    const out = [];
    let last = 0, m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) out.push({ t: s.slice(last, m.index), hit: false });
      out.push({ t: m[0], hit: true });
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < s.length) out.push({ t: s.slice(last), hit: false });
    return out;
  }

  const api = { words, matches, ageDays, relAge, withinDays, sort, group, facets, hue, highlightParts, fileName };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.LibraryFilter = api;
})(typeof window !== "undefined" ? window : globalThis);
