// node tests/toolsRankReadiness.test.js - v1.159.0: tools.json `rank` orders each group, `readiness` is kept and shown.
"use strict";
const assert = require("assert");
const S = require("../src/tools/schema");
const M = require("../src/tools/model");
const base = (o) => Object.assign({ id: "demo", basket: "other", name: "Demo", purpose: "Does a thing", status: "built" }, o || {});
const card = (o) => M.toCard(S.validateTool(base(o)).entry, {});
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.log("FAIL " + name + "\n  " + e.message); process.exit(1); } };
t("schema keeps rank and readiness", () => { const e = S.validateTool(base({ rank: 3, readiness: 79.4 })).entry; assert.strictEqual(e.rank, 3); assert.strictEqual(e.readiness, 79); });
t("bad values load as null and do not reject", () => {
  for (const bad of [0, -1, 1.5, "2", null, 10000]) { const r = S.validateTool(base({ rank: bad })); assert.ok(r.ok); assert.strictEqual(r.entry.rank, null); }
  for (const bad of [-1, 101, "5", NaN, null]) { const r = S.validateTool(base({ readiness: bad })); assert.ok(r.ok); assert.strictEqual(r.entry.readiness, null); }
  assert.strictEqual(S.validateTool(base({ readiness: 0 })).entry.readiness, 0);
});
t("card carries both", () => { const c = card({ rank: 2, readiness: 40 }); assert.strictEqual(c.rank, 2); assert.strictEqual(c.readiness, 40); assert.strictEqual(card({}).rank, null); });
t("group sorts by rank, unranked after (newest first), stable", () => {
  const cards = [card({ id: "u1", name: "U1", updated: "2026-11-01" }), card({ id: "r3", name: "R3", rank: 3, updated: "2026-01-01" }), card({ id: "u2", name: "U2", updated: "2026-11-10" }), card({ id: "r1", name: "R1", rank: 1 }), card({ id: "r2", name: "R2", rank: 2 })];
  const ids = () => M.groupCards(cards.slice().reverse())[1].cards.map((c) => c.id);
  assert.deepStrictEqual(ids(), ["r1", "r2", "r3", "u2", "u1"]);
  assert.deepStrictEqual(ids(), ids());
  assert.deepStrictEqual(M.groupByKind(cards)[0].groups[1].cards.map((c) => c.id), ["r1", "r2", "r3", "u2", "u1"]);
});
console.log("toolsRankReadiness: all " + n + " tests passed");
