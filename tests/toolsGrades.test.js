// node tests/toolsGrades.test.js - v1.160.0 "All programs" tab: parse, sort, filter, service read (missing/bad file = empty state), readiness object in tools.json.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const G = require("../src/tools/grades");
const S = require("../src/tools/schema");
const M = require("../src/tools/model");
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.log("FAIL " + name + "\n  " + e.message); process.exit(1); } };
const doc = () => ({ schema: "mytools-grades/1", generated: "2026-11-14", target: 90, weights: { features: 20, tests: 12 }, summary: { mean: 50 }, unknownField: 1, tools: [
  { id: "a", name: "Alpha", owner: "SE", score: 79, rank: 1, lensvidCandidate: "yes", criteria: { features: 13, tests: 9 }, evidence: { features: "src/x" }, hoursTo90: 7, hoursTo90NoIddo: 3,
    tasks: [{ title: "T1", pct: 47, points: 7, hours: 4, needsIddo: true, model: "opus" }, { title: "T2", pct: 10, hours: 3 }], laterTasks: [{ title: "L1", pct: 0, hours: 1, optional: true }] },
  { id: "b", name: "beta", score: 51, lensvidCandidate: "maybe", tasks: [] },
  { id: "c", name: "Gamma", score: 95, lensvidCandidate: "no", tasks: [{ title: "x", pct: 5, hours: 1 }] },
  { id: "BAD ID", name: "x", score: 1 }, { id: "a", name: "dup", score: 1 }, "junk", { id: "d", name: "", score: "high", lensvidCandidate: "weird" } ] });
t("parse: keeps good rows, drops bad/duplicate ones, ignores unknown fields", () => {
  const g = G.parse(doc()); assert.ok(g.ok); assert.deepStrictEqual(g.tools.map((x) => x.id), ["a", "b", "c", "d"]);
  assert.strictEqual(g.mean, 50); assert.strictEqual(g.atOrAbove, 1);
  const a = g.tools[0]; assert.strictEqual(a.criteria[0].max, 20); assert.strictEqual(a.criteria[0].evidence, "src/x"); assert.ok(a.needsIddo); assert.strictEqual(a.tasks[0].model, "opus"); assert.strictEqual(a.laterTasks.length, 1);
  const d = g.tools[3]; assert.strictEqual(d.score, 0); assert.strictEqual(d.candidate, "no"); assert.strictEqual(d.name, "d");
});
t("parse: wrong schema / not an object = empty state reason, no throw", () => { for (const bad of [null, [], "x", { schema: "x", tools: [] }, { schema: "mytools-grades/1" }]) { const r = G.parse(bad); assert.strictEqual(r.ok, false); assert.ok(r.reason); } });
t("sort: score desc default, name, hours, lensvid first", () => {
  const rows = G.parse(doc()).tools;
  assert.deepStrictEqual(G.sortRows(rows, "score").map((x) => x.id), ["c", "a", "b", "d"]);
  assert.deepStrictEqual(G.sortRows(rows, "name").map((x) => x.id), ["a", "b", "d", "c"]);
  assert.deepStrictEqual(G.sortRows(rows, "hours").map((x) => x.id), ["b", "d", "c", "a"]);
  assert.deepStrictEqual(G.sortRows(rows, "lensvid").map((x) => x.id), ["a", "b", "c", "d"]);
});
t("filter: candidate chips OR, needsIddo narrows", () => {
  const rows = G.parse(doc()).tools;
  assert.deepStrictEqual(G.filterRows(rows, ["yes"]).map((x) => x.id), ["a"]);
  assert.deepStrictEqual(G.filterRows(rows, ["yes", "maybe"]).map((x) => x.id), ["a", "b"]);
  assert.deepStrictEqual(G.filterRows(rows, ["internal"]).map((x) => x.id), ["c", "d"]);
  assert.deepStrictEqual(G.filterRows(rows, ["needsIddo"]).map((x) => x.id), ["a"]);
  assert.deepStrictEqual(G.filterRows(rows, ["maybe", "needsIddo"]).map((x) => x.id), []);
  assert.strictEqual(G.filterRows(rows, null).length, 4);
});
t("headerLine: comparison only against an older generation", () => {
  const g = G.parse(doc());
  assert.strictEqual(G.headerLine(g, null).meanWas, null);
  assert.strictEqual(G.headerLine(g, { ok: true, generated: "2026-11-14", mean: 40, atOrAbove: 0 }).meanWas, null);
  const h = G.headerLine(g, { ok: true, generated: "2026-11-01", mean: 47.1, atOrAbove: 0 }); assert.strictEqual(h.meanWas, 47.1); assert.strictEqual(h.atOrAboveWas, 0);
});
t("schema: readiness as a number or as { score, target, stage }", () => {
  const base = (o) => Object.assign({ id: "demo", basket: "other", name: "Demo", purpose: "p", status: "built" }, o);
  let e = S.validateTool(base({ readiness: { score: 72, target: 85, stage: "beta", graded: "2026-11-14" } })).entry; assert.strictEqual(e.readiness, 72); assert.strictEqual(e.readinessTarget, 85); assert.strictEqual(e.readinessStage, "beta");
  e = S.validateTool(base({ readiness: 40 })).entry; assert.strictEqual(e.readiness, 40); assert.strictEqual(e.readinessTarget, 90);
  e = S.validateTool(base({ readiness: { score: 500 } })).entry; assert.strictEqual(e.readiness, null);
  const c = M.toCard(S.validateTool(base({ readiness: { score: 72, target: 85 } })).entry, {}); assert.strictEqual(c.readinessTarget, 85);
});
t("model: equal rank falls back to readiness score desc", () => {
  const base = (o) => Object.assign({ id: "demo", basket: "other", name: "Demo", purpose: "p", status: "built" }, o);
  const cs = [{ id: "x", name: "X", readiness: { score: 30 } }, { id: "y", name: "Y", readiness: { score: 80 } }, { id: "z", name: "Z" }].map((o) => M.toCard(S.validateTool(base(o)).entry, {}));
  assert.deepStrictEqual(M.groupCards(cs)[1].cards.map((c) => c.id), ["y", "x", "z"]);
});
t("service.loadGrades: missing file, bad file, good file (config path, no hard-coded drive)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adgr-")); const userData = fs.mkdtempSync(path.join(os.tmpdir(), "adgr-u-"));
  const file = path.join(dir, "grades.json");
  const svc = require("../src/tools/service").createService({ userData, testMode: true, env: { AGENT_DESKTOP_TOOLS_GRADES: file }, log: () => {}, openExternal: () => {} });
  let r = svc.loadGrades(); assert.ok(r.ok && r.empty && /grade/i.test(r.reason), "missing file");
  fs.writeFileSync(file, "{not json"); r = svc.loadGrades(); assert.ok(r.ok && r.empty, "bad json");
  fs.writeFileSync(file, "\uFEFF" + JSON.stringify(doc())); r = svc.loadGrades(); assert.ok(r.ok && !r.empty && r.total === 4 && r.tools.length === 4 && r.tools[0].id === "c");
  r = svc.loadGrades({ sort: "name", filters: ["yes"] }); assert.deepStrictEqual(r.tools.map((x) => x.id), ["a"]); assert.strictEqual(r.total, 4);
  const d2 = doc(); d2.generated = "2026-11-15"; d2.summary.mean = 55; fs.writeFileSync(file, JSON.stringify(d2)); r = svc.loadGrades(); assert.strictEqual(r.header.meanWas, 50, "previous generation remembered");
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true });
});
console.log("toolsGrades: all " + n + " tests passed");
