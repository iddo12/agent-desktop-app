// node tests/research-controls.test.js - My Research controls (v1.102.0): the ONE filter state that drives the hero, the five, the grid,
// the List view and every count (src/renderer/research-filter.js, pure), the agent filter pref, and static guards on the renderer wiring.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const RF = require("../src/renderer/research-filter.js");
let n = 0, fails = 0;
function t(name, fn) { try { fn(); n++; console.log("ok  " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n  " + (e && e.stack || e)); } }

// a fixture where High tier and Needs your eye DIFFER (the W41 fixtures have one high item and no worth flags)
const F = (title, o) => Object.assign({ title, soWhat: "", topic: "", tier: "normal", worth: false, idea: false, sources: [] }, o);
const digests = [
  { agent: "Security", findings: [F("Windows zero-day fixed", { tier: "high", worth: true, topic: "Windows patches", sources: [{ url: "https://www.bleepingcomputer.com/x", title: "BC" }] }),
    F("Chrome V8 bug", { tier: "high", topic: "Browsers" }), F("NAS firmware", { tier: "low", worth: true, topic: "QNAP" })] },
  { agent: "Legal Agent", findings: [F("חוק הספאם: קנס לכל מייל", { worth: true, idea: true, topic: "Spam law", soWhat: "עד 1,000 ש״ח" }), F("EU AI act", { tier: "high", idea: true, topic: "AI rules" })] },
  { agent: "News Agent", findings: [] },
];
const items = RF.flatten(digests);
const marked = new Set(["Security|NAS firmware"]);
const isMarked = (a, f) => marked.has(a + "|" + f.title);
const pick = (Fl) => items.filter((x) => RF.matches(x.agent, x.f, Fl, isMarked)).map((x) => x.f.title);
const base = RF.noFilters();

t("no filter: everything; isActive false", () => { assert.strictEqual(pick(base).length, 5); assert.strictEqual(RF.isActive(base), false); });
t("High tier and Needs your eye give DIFFERENT sets when the data differs", () => {
  const hi = pick(RF.setFilter(base, "tier", "high")), wo = pick(RF.setFilter(base, "worth"));
  assert.deepStrictEqual(hi, ["Windows zero-day fixed", "Chrome V8 bug", "EU AI act"]);
  assert.deepStrictEqual(wo, ["Windows zero-day fixed", "NAS firmware", "חוק הספאם: קנס לכל מייל"]);
  assert.notDeepStrictEqual(hi, wo);
});
t("Idea, Low, Interesting and theme filters", () => {
  assert.deepStrictEqual(pick(RF.setFilter(base, "idea")), ["חוק הספאם: קנס לכל מייל", "EU AI act"]);
  assert.deepStrictEqual(pick(RF.setFilter(base, "tier", "low")), ["NAS firmware"]);
  assert.deepStrictEqual(pick(RF.setFilter(base, "starred")), ["NAS firmware"]);
  assert.deepStrictEqual(pick(RF.setFilter(base, "topic", "Browsers")), ["Chrome V8 bug"]);
});
t("tier/topic toggle off on a second click; flags toggle", () => {
  const a = RF.setFilter(base, "tier", "high"); assert.strictEqual(RF.setFilter(a, "tier", "high").tier, null);
  assert.strictEqual(RF.setFilter(RF.setFilter(base, "worth"), "worth").worth, false);
});
t("agent filter: only that agent (case-insensitive), combines with chips; agent and search survive a chip change and Did not run", () => {
  const a = RF.setFilter(base, "agent", "Security");
  assert.deepStrictEqual(pick(a), ["Windows zero-day fixed", "Chrome V8 bug", "NAS firmware"]);
  assert.deepStrictEqual(pick(RF.setFilter(a, "tier", "high")), ["Windows zero-day fixed", "Chrome V8 bug"]);
  assert.deepStrictEqual(pick(RF.setFilter(base, "agent", "security")), pick(a));
  const nr = RF.setFilter(RF.setFilter(a, "q", "x"), "noRun"); assert.strictEqual(nr.agent, "Security"); assert.strictEqual(nr.q, "x"); assert.strictEqual(nr.noRun, true);
});
t("search: headline, so-what, agent, source domain, theme; every word must match; case-insensitive", () => {
  assert.deepStrictEqual(pick(RF.setFilter(base, "q", "zero-day")), ["Windows zero-day fixed"]);
  assert.deepStrictEqual(pick(RF.setFilter(base, "q", "bleepingcomputer")), ["Windows zero-day fixed"]);
  assert.deepStrictEqual(pick(RF.setFilter(base, "q", "legal")), ["חוק הספאם: קנס לכל מייל", "EU AI act"]);
  assert.deepStrictEqual(pick(RF.setFilter(base, "q", "browsers")), ["Chrome V8 bug"]);
  assert.deepStrictEqual(pick(RF.setFilter(base, "q", "CHROME bug")), ["Chrome V8 bug"]);
  assert.deepStrictEqual(pick(RF.setFilter(base, "q", "chrome zebra")), []);
});
t("Hebrew-safe search: niqqud ignored, final letters match their base form, so-what searched", () => {
  assert.deepStrictEqual(pick(RF.setFilter(base, "q", "הספאם")), ["חוק הספאם: קנס לכל מייל"]);
  assert.deepStrictEqual(pick(RF.setFilter(base, "q", "חוֹק")), ["חוק הספאם: קנס לכל מייל"]);     // with a niqqud mark
  assert.deepStrictEqual(pick(RF.setFilter(base, "q", "קנס")), ["חוק הספאם: קנס לכל מייל"]);
  assert.strictEqual(RF.fold("קנס"), RF.fold("קנס".replace("ס", "ס")));
  assert.strictEqual(RF.fold("מייל"), "מייל"); assert.strictEqual(RF.fold("שלום"), RF.fold("שלומ"));
  assert.deepStrictEqual(pick(RF.setFilter(base, "q", "1,000")), ["חוק הספאם: קנס לכל מייל"]);
});
t("counts: glance/chips follow agent + search scope; shown/total match the filter", () => {
  const c = RF.counts(items, RF.setFilter(base, "agent", "Security"), isMarked);
  assert.deepStrictEqual([c.scope, c.high, c.worth, c.idea, c.starred, c.low, c.shown, c.total], [3, 2, 2, 0, 1, 1, 3, 5]);
  const d = RF.counts(items, RF.setFilter(base, "tier", "high"), isMarked); assert.strictEqual(d.shown, 3); assert.strictEqual(d.scope, 5);
  assert.strictEqual(RF.counts(items, RF.setFilter(base, "noRun"), isMarked).shown, 0);
});
t("filterPicks keeps the original rank and drops picks without a finding or outside the filter", () => {
  const picks = [{ agent: "Legal Agent", finding: digests[1].findings[0] }, { agent: "Security", finding: null }, { agent: "Security", finding: digests[0].findings[1] }];
  assert.deepStrictEqual(RF.filterPicks(picks, base, isMarked).map((p) => p.rank), [1, 3]);
  assert.deepStrictEqual(RF.filterPicks(picks, RF.setFilter(base, "tier", "high"), isMarked).map((p) => p.rank), [3]);
  assert.deepStrictEqual(RF.filterPicks(picks, RF.setFilter(base, "noRun"), isMarked), []);
});
t("agentOptions: only agents with findings, with counts, alphabetical", () => {
  assert.deepStrictEqual(RF.agentOptions(digests), [{ agent: "Legal Agent", n: 2 }, { agent: "Security", n: 3 }]);
});
t("activeLabels and clearOne: each active filter is a removable chip", () => {
  let f = RF.setFilter(RF.setFilter(RF.setFilter(base, "agent", "Security"), "tier", "high"), "q", "zero");
  assert.deepStrictEqual(RF.activeLabels(f).map((x) => x.key), ["agent", "q", "tier"]);
  f = RF.clearOne(f, "tier"); assert.strictEqual(f.tier, null); f = RF.clearOne(f, "agent"); assert.strictEqual(f.agent, ""); f = RF.clearOne(f, "q");
  assert.strictEqual(RF.isActive(f), false);
});
t("W41 test fixtures: the same story cannot satisfy High and Needs your eye differently (no worth flags) - documented in CONTROLS_AUDIT.md", () => {
  const dir = path.join(__dirname, "fixtures", "research", "2026-W41");
  const a = JSON.parse(fs.readFileSync(path.join(dir, "Alpha Agent.json"), "utf8"));
  assert.ok(Array.isArray(a.findings));
});

// static guards on the renderer wiring (the bugs this release fixed must not come back)
const R = path.join(__dirname, "..", "src", "renderer");
const js = fs.readFileSync(path.join(R, "research.js"), "utf8"), nav = fs.readFileSync(path.join(R, "research-nav.js"), "utf8"), css = fs.readFileSync(path.join(R, "styles-research.css"), "utf8");
const mainR = fs.readFileSync(path.join(__dirname, "..", "src", "research", "main-research.js"), "utf8");
t("renderer: hero/five are filtered and redrawn on every filter change (root cause of 'High tier and Needs your eye show the same')", () => {
  assert.ok(/RF\.filterPicks\(t\.picks, S\.f, isMarked\)/.test(js));
  assert.ok(/const refilter = \(\) => \{[\s\S]{0,400}renderLead\(\); renderFilterBlock\(\); renderList\(\);/.test(js));
  assert.ok(/function renderFilterEmpty\(/.test(js));
});
t("renderer: 'Show:' agent filter + search + count; the request row is worded as a request", () => {
  assert.ok(/function renderFindBar\(/.test(js) && js.includes('"Show:"') && js.includes('"All agents ("') && js.includes('q.type = "search"'));
  assert.ok(/e\.key === "Escape"/.test(js) && js.includes("stopPropagation"));
  assert.ok(!js.includes('"Also research..."'), "the old filter-looking label is gone");
  assert.ok(js.includes('"to look into:"') && js.includes('"Send to " +'));
  assert.ok(js.includes("S.jumpToAgents()"), "'Agents ran' no longer pretends to filter");
});
t("research-nav loads research-filter.js before research.js; css has the new controls; the agent filter is kept in the prefs file", () => {
  assert.ok(nav.indexOf("research-filter.js") >= 0 && nav.indexOf("research-filter.js") < nav.indexOf('s.src = "research.js"'));
  for (const c of [".rs-findbar", ".rs-show", ".rs-q", ".rs-achip", ".rs-empty-f"]) assert.ok(css.includes(c), c);
  assert.ok(/agentFilter: str\(j\.agentFilter, 120\)/.test(mainR) && /a\.agentFilter === "string"/.test(mainR));
});
console.log((fails ? "FAILED " : "PASSED ") + n + " passed, " + fails + " failed");
process.exit(fails ? 1 : 0);
