// node tests/toolsSortUpdated.test.js - v1.155.15: My Tools shows the newest software first (`updated` desc, ties by name, missing last).
"use strict";
const assert = require("assert");
const S = require("../src/tools/schema");
const M = require("../src/tools/model");
const base = (o) => Object.assign({ id: "demo", basket: "other", name: "Demo", purpose: "Does a thing", status: "built" }, o || {});
const card = (o) => M.toCard(S.validateTool(base(o)).entry, {});
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.log("FAIL " + name + "\n  " + e.message); process.exit(1); } };

t("schema: updated accepts YYYY-MM-DD, a bad value loads as empty and does not reject", () => {
  assert.strictEqual(S.validateTool(base({ updated: "2026-11-13" })).entry.updated, "2026-11-13");
  for (const bad of ["yesterday", "2026-1-3", 5, {}, null, undefined]) { const r = S.validateTool(base({ updated: bad })); assert.ok(r.ok); assert.strictEqual(r.entry.updated, ""); }
});
t("model: card carries updated", () => { assert.strictEqual(card({ updated: "2026-11-01" }).updated, "2026-11-01"); assert.strictEqual(card({}).updated, ""); });
t("model: baskets sort newest first, ties by name, missing dates last, order stable", () => {
  const cards = [card({ id: "z", name: "Zed", updated: "2026-10-01" }), card({ id: "n", name: "None" }), card({ id: "b", name: "Beta", updated: "2026-11-13" }),
    card({ id: "a", name: "alpha", updated: "2026-11-13" }), card({ id: "m", name: "Mid", updated: "2026-10-20" }), card({ id: "n2", name: "Aardvark" })];
  const ids = () => M.groupCards(cards.slice().reverse())[1].cards.map((c) => c.id);
  assert.deepStrictEqual(ids(), ["a", "b", "m", "z", "n2", "n"]);
  assert.deepStrictEqual(ids(), ids(), "same input, same order");
  assert.deepStrictEqual(M.groupByKind(cards)[0].groups[1].cards.map((c) => c.id), ["a", "b", "m", "z", "n2", "n"], "tabs use the same order");
});
console.log("toolsSortUpdated: all " + n + " tests passed");
