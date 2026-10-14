// My Research filter logic (v1.102.0), pure functions shared by the renderer (window.researchFilter) and tests/research-controls.test.js.
// One filter state drives EVERY part of the view (hero, the five, "More from the agents", the List view, glance counts, theme pills):
//   { worth, idea, starred, tier, topic, noRun, agent, q }
// agent = "" for all agents; q = the search text (headline, so-what, agent, source domain, theme), Hebrew-safe (niqqud and accents ignored).
(function (root) {
  "use strict";
  const lower = (v) => String(v || "").trim().toLowerCase();
  // fold for search: NFKD, drop combining marks (Hebrew niqqud/cantillation, Latin accents), Hebrew final letters to their base form, lower case
  const FINALS = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
  function fold(v) {
    let s = String(v == null ? "" : v);
    try { s = s.normalize("NFKD"); } catch (x) { /* very old engines */ }
    return s.replace(/[̀-֑ͯ-ׇ]/g, "").replace(/[ךםןףץ]/g, (c) => FINALS[c]).replace(/[‎‏‪-‮]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  }
  function host(u) { const m = String(u || "").match(/^https?:\/\/([^\/?#]+)/i); return m ? m[1].replace(/^www\./, "").toLowerCase() : ""; }
  function themeOf(f) { return String((f && f.topic) || "").split(/[,(]/)[0].replace(/\s+/g, " ").trim().slice(0, 90); }
  function noFilters(agent) { return { worth: false, idea: false, starred: false, tier: null, topic: null, noRun: false, agent: agent || "", q: "" }; }
  // the chip/tile filters (not agent, not search): what "Needs your eye", "High tier" ... set
  const chipActive = (F) => !!(F.worth || F.idea || F.starred || F.tier || F.topic || F.noRun);
  const isActive = (F) => !!(chipActive(F) || F.agent || fold(F.q));
  function hay(agent, f) {
    const src = Array.isArray(f.sources) ? f.sources.map((s) => host(s && s.url) + " " + ((s && s.title) || "")).join(" ") : "";
    return fold([f.title, f.soWhat, agent, f.topic, src].join(" \u0001 "));
  }
  // every word of the query must appear somewhere in the finding's text
  function matchesQuery(agent, f, q) { const words = fold(q).split(" ").filter(Boolean); if (!words.length) return true; const h = hay(agent, f); return words.every((w) => h.indexOf(w) >= 0); }
  // scope = agent + search only (the base the glance counts, theme pills and chip counts are taken from)
  function inScope(agent, f, F) {
    if (F.agent && lower(agent) !== lower(F.agent)) return false;
    return matchesQuery(agent, f, F.q);
  }
  // isMarked(agent, f) -> bool (the "Interesting" marks live in the renderer)
  function matches(agent, f, F, isMarked) {
    if (!inScope(agent, f, F)) return false;
    if (F.worth && !f.worth) return false;
    if (F.idea && !f.idea) return false;
    if (F.starred && !(isMarked && isMarked(agent, f))) return false;
    if (F.tier && f.tier !== F.tier) return false;
    if (F.topic && themeOf(f) !== F.topic) return false;
    return true;
  }
  // flat list of {agent, f} from the digests
  function flatten(digests) { return (digests || []).flatMap((d) => (d.findings || []).map((f) => ({ agent: d.agent, f }))); }
  // "Show:" options: agents that have findings this week, with their count, alphabetical
  function agentOptions(digests) {
    return (digests || []).filter((d) => d.findings && d.findings.length).map((d) => ({ agent: d.agent, n: d.findings.length }))
      .sort((a, b) => a.agent.localeCompare(b.agent));
  }
  // the counts shown on the glance tiles and chips, inside the current scope (agent + search)
  function counts(items, F, isMarked) {
    const sc = items.filter((x) => inScope(x.agent, x.f, F));
    return { scope: sc.length, high: sc.filter((x) => x.f.tier === "high").length, normal: sc.filter((x) => x.f.tier === "normal").length, low: sc.filter((x) => x.f.tier === "low").length,
      worth: sc.filter((x) => x.f.worth).length, idea: sc.filter((x) => x.f.idea).length, starred: sc.filter((x) => isMarked && isMarked(x.agent, x.f)).length,
      shown: F.noRun ? 0 : items.filter((x) => matches(x.agent, x.f, F, isMarked)).length, total: items.length };
  }
  // the five (top5.picks) that pass the filters, keeping each pick's original rank (1-based)
  function filterPicks(picks, F, isMarked) {
    return (picks || []).map((p, i) => Object.assign({ rank: i + 1 }, p)).filter((p) => p.finding && !F.noRun && matches(p.agent, p.finding, F, isMarked));
  }
  // the human words for the active filters (each becomes a chip with an x)
  function activeLabels(F) {
    const out = [];
    if (F.agent) out.push({ key: "agent", label: "Agent: " + F.agent });
    if (fold(F.q)) out.push({ key: "q", label: "Search: “" + String(F.q).trim() + "”" });
    if (F.tier) out.push({ key: "tier", label: { high: "▲ High tier", normal: "■ Normal", low: "▼ Low" }[F.tier] || F.tier });
    if (F.worth) out.push({ key: "worth", label: "👁 Needs your eye" });
    if (F.idea) out.push({ key: "idea", label: "💡 Idea candidates" });
    if (F.starred) out.push({ key: "starred", label: "★ Interesting" });
    if (F.topic) out.push({ key: "topic", label: "Theme: " + F.topic });
    if (F.noRun) out.push({ key: "noRun", label: "Did not run" });
    return out;
  }
  // apply one control (same toggling rules as before v1.102.0; agent and search are kept when a chip changes)
  function setFilter(F, k, v) {
    const n = Object.assign({}, F);
    if (k === "noRun") { const on = !F.noRun; const z = noFilters(F.agent); z.q = F.q; z.noRun = on; return z; }
    n.noRun = false;
    if (k === "agent") n.agent = String(v || "");
    else if (k === "q") n.q = String(v || "");
    else if (k === "tier" || k === "topic") n[k] = F[k] === v ? null : v;
    else n[k] = !F[k];
    return n;
  }
  function clearOne(F, k) { const n = Object.assign({}, F); if (k === "agent" || k === "q") n[k] = ""; else if (k === "tier" || k === "topic") n[k] = null; else n[k] = false; return n; }
  const api = { fold, host, themeOf, noFilters, chipActive, isActive, hay, matchesQuery, inScope, matches, flatten, agentOptions, counts, filterPicks, activeLabels, setFilter, clearOne };
  /* global module */
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.researchFilter = api;
})(typeof window !== "undefined" ? window : this);
