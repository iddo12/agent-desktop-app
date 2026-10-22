"use strict";
const assert = require("assert");
const L = require("../src/intake/intakeLogic");
let n = 0;
const t = (name, fn) => { fn(); n++; };

const idx = { items: [
  { id: "a", kind: "command", status: "pending_approval", verified: true, transcript: "Tell Marketing to draft the recap", suggested_agent: "Marketing" },
  { id: "b", kind: "command", status: "pending_approval", verified: false, suggested_agent: "Marketing" },
  { id: "c", kind: "idea", status: "new", verified: true },
  { id: "d", kind: "health", status: "new", verified: true },
  { id: "e", kind: "command", status: "sent", verified: true },
  { id: "a", kind: "note" },
  { kind: "note" },
  null,
] };

t("normalize drops duplicates, no-id and junk", () => assert.strictEqual(L.normalizeIndex(idx).length, 5));
t("verified must be literally true", () => assert.strictEqual(L.normalizeIndex([{ id: "x", verified: "true" }])[0].verified, false));
t("index claiming sent without an approval record shows as waiting", () => {
  const s = L.summarize(L.normalizeIndex(idx), {});
  assert.strictEqual(s.rows.find((r) => r.id === "e").status, "pending_approval");
});
t("sealed items stay out of the shared counts", () => {
  const s = L.summarize(L.normalizeIndex(idx), {});
  assert.strictEqual(s.counts.health, 1);
  assert.strictEqual(s.counts.all, 4);
});
t("pending count only counts verified, unsealed items", () => {
  const s = L.summarize(L.normalizeIndex(idx), {});
  assert.strictEqual(s.counts.pending, 2);   // a and e (b is unverified)
});
t("unverified cannot be approved but can be rejected", () => {
  const it = L.normalizeIndex(idx).find((x) => x.id === "b");
  assert.strictEqual(L.decide({ action: "approve" }, it, {}, "Health", 1).ok, false);
  assert.strictEqual(L.decide({ action: "reject" }, it, {}, "Health", 1).ok, true);
});
t("sealed goes only to the Health agent", () => {
  const it = L.normalizeIndex(idx).find((x) => x.id === "d");
  assert.strictEqual(L.decide({ action: "send", agent: "COO" }, it, {}, "Health", 1).ok, false);
  assert.strictEqual(L.decide({ action: "send", agent: "Health" }, it, {}, "Health", 1).ok, true);
  assert.strictEqual(L.decide({ action: "send", agent: "Health" }, it, {}, "", 1).ok, false);
});
t("approve uses the suggested agent and words the message as approved on the PC", () => {
  const it = L.normalizeIndex(idx).find((x) => x.id === "a");
  const r = L.decide({ action: "approve" }, it, {}, "Health", 5);
  assert.ok(r.ok && r.record.agent === "Marketing" && /approved on the PC/.test(r.record.message));
});
t("rejected items cannot be approved", () => {
  const it = L.normalizeIndex(idx).find((x) => x.id === "a");
  assert.strictEqual(L.decide({ action: "approve" }, it, { a: { action: "reject" } }, "Health", 1).ok, false);
});
console.log("intake.test.js: " + n + " passed");
