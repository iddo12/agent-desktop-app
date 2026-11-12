// node tests/outboxDedupe.test.js - v1.155.12: an identical message still waiting is not queued twice
const assert = require("assert");
const L = require("../src/outbox");
let fails = 0, n = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } }
const NOW = 1e12;
const mk = (ap, text, ago, extra) => Object.assign(L.create(ap, text, NOW - ago), extra || {});
t("same text, same agent, waiting = duplicate", () => { const a = mk("A", "please fix the logo", 60000); assert.strictEqual(L.findDuplicate([a], "A", "please  fix the logo ", NOW), a); });
t("other agent / other text = not duplicate", () => { const a = mk("A", "x y", 1000); assert.strictEqual(L.findDuplicate([a], "B", "x y", NOW), null); assert.strictEqual(L.findDuplicate([a], "A", "x z", NOW), null); });
t("seen, superseded or old copy = not duplicate", () => {
  assert.strictEqual(L.findDuplicate([mk("A", "hi there", 1000, { state: "seen" })], "A", "hi there", NOW), null);
  assert.strictEqual(L.findDuplicate([mk("A", "hi there", 1000, { newer: true })], "A", "hi there", NOW), null);
  assert.strictEqual(L.findDuplicate([mk("A", "hi there", 20 * 60000)], "A", "hi there", NOW), null);
});
t("failed or cancelled copy does not block a resend; sent does", () => {
  assert.strictEqual(L.findDuplicate([mk("A", "hi there", 1000, { state: "failed" })], "A", "hi there", NOW), null);
  assert.strictEqual(L.findDuplicate([mk("A", "hi there", 1000, { state: "cancelled" })], "A", "hi there", NOW), null);
  assert.ok(L.findDuplicate([mk("A", "hi there", 1000, { state: "sent" })], "A", "hi there", NOW));
});
t("empty text never matches", () => assert.strictEqual(L.findDuplicate([mk("A", "  ", 1)], "A", "", NOW), null));
console.log(n - fails + "/" + n + " passed"); process.exit(fails ? 1 : 0);
