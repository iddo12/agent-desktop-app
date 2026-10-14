// Run: node tests/libraryFilter.test.js
const assert = require("assert");
const F = require("../src/libraryFilter");

const NOW = Date.parse("2026-10-07T12:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
const E = [
  { id: "a", title: "COPIER - verified card ingest", description: "Copies camera cards, proves every byte", agent: "Software Engineering Agent", topic: "Acmeco Tools", link: "D:\\x\\Launch-Copier.vbs", updatedAt: iso(1) },
  { id: "b", title: "Agent Desktop", description: "The Electron app", agent: "Security", topic: "Internal tools", link: "https://github.com/example-user/agent-desktop", updatedAt: iso(20) },
  { id: "c", title: "CUTTER quick-cull", description: "Mark in/out ranges and export", agent: "Software Engineering Agent", topic: "Acmeco Tools", link: "x/cutter.exe", updatedAt: iso(400) },
  { id: "d", title: "Idea: smart crop", description: "", agent: "Video Editing Agent", topic: "Task idea", link: "", updatedAt: "" },
];
let n = 0;
const t = (name, fn) => { fn(); n++; };

t("words splits and lowercases", () => assert.deepStrictEqual(F.words("  Camera,  CARDS "), ["camera", "cards"]));
t("empty query matches all", () => assert.strictEqual(E.filter((e) => F.matches(e, F.words(""))).length, 4));
t("AND across fields, any order", () => assert.deepStrictEqual(E.filter((e) => F.matches(e, F.words("software copier"))).map((e) => e.id), ["a"]));
t("matches topic and file name", () => {
  assert.deepStrictEqual(E.filter((e) => F.matches(e, F.words("acmeco tools"))).map((e) => e.id), ["a", "c"]);
  assert.deepStrictEqual(E.filter((e) => F.matches(e, F.words("launch-copier.vbs"))).map((e) => e.id), ["a"]);
});
t("no match", () => assert.strictEqual(E.filter((e) => F.matches(e, F.words("zzzz"))).length, 0));
t("relAge", () => {
  assert.strictEqual(F.relAge(E[0], NOW), "1d ago");
  assert.strictEqual(F.relAge({ updatedAt: iso(0) }, NOW), "today");
  assert.strictEqual(F.relAge(E[1], NOW), "2w ago");
  assert.strictEqual(F.relAge(E[2], NOW), "13mo ago");
  assert.strictEqual(F.relAge({ updatedAt: iso(900) }, NOW), "2y ago");
  assert.strictEqual(F.relAge(E[3], NOW), "");
});
t("withinDays", () => {
  assert.deepStrictEqual(E.filter((e) => F.withinDays(e, 7, NOW)).map((e) => e.id), ["a"]);
  assert.deepStrictEqual(E.filter((e) => F.withinDays(e, 30, NOW)).map((e) => e.id), ["a", "b"]);
  assert.strictEqual(E.filter((e) => F.withinDays(e, 0, NOW)).length, 4);
});
t("sort updated (undated last), oldest, title, agent", () => {
  assert.deepStrictEqual(F.sort(E, "updated").map((e) => e.id), ["a", "b", "c", "d"]);
  assert.deepStrictEqual(F.sort(E, "title").map((e) => e.id), ["b", "a", "c", "d"]);
  assert.deepStrictEqual(F.sort(E, "agent").map((e) => e.id), ["b", "a", "c", "d"]);
  assert.strictEqual(F.sort(E, "oldest")[0].id, "d");
  assert.strictEqual(F.sort(E, "bogus")[0].id, "a");
});
t("sort does not mutate", () => { const c = E.slice(); F.sort(E, "title"); assert.deepStrictEqual(E, c); });
t("group by topic: biggest first, none last", () => {
  const g = F.group(F.sort(E, "updated"), "topic");
  assert.deepStrictEqual(g.map((x) => x.label + ":" + x.items.length), ["Acmeco Tools:2", "Internal tools:1", "Task idea:1"]);
  const g2 = F.group([{ id: "z", agent: "" }, { id: "y", agent: "B" }], "agent");
  assert.deepStrictEqual(g2.map((x) => x.label), ["B", "(none)"]);
  assert.strictEqual(F.group(E, "").length, 1);
});
t("facets", () => assert.deepStrictEqual(F.facets(E, "topic"), [["Acmeco Tools", 2], ["Internal tools", 1], ["Task idea", 1]]));
t("hue is stable and in range", () => { assert.strictEqual(F.hue("Security"), F.hue("Security")); assert.ok(F.hue("x") >= 0 && F.hue("x") < 360); });
t("highlightParts", () => {
  assert.deepStrictEqual(F.highlightParts("Camera card", ["card"]), [{ t: "Camera ", hit: false }, { t: "card", hit: true }]);
  assert.deepStrictEqual(F.highlightParts("abc", []), [{ t: "abc", hit: false }]);
  assert.deepStrictEqual(F.highlightParts("a.b a.b", ["a.b"]).filter((p) => p.hit).length, 2); // regex chars are escaped
  assert.strictEqual(F.highlightParts("", ["x"])[0].t, "");
});
console.log(`libraryFilter.test.js: ${n} passed`);
