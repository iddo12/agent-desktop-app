"use strict";
const assert = require("assert");
const L = require("../src/intake/intakeLogic");
let n = 0;
const t = (name, fn) => { fn(); n++; };

const ev = [
  { id: "capture/a", kind: "capture", sub: "command", status: "pending_approval", title: "Tell Marketing", suggested_agent: "Marketing", path: "x.txt" },
  { id: "capture/a", kind: "capture", sub: "command", status: "sent", title: "Tell Marketing" },   // index claims sent
  { id: "capture/c", kind: "capture", sub: "idea", status: "new", title: "wind noise" },
  { id: "health/d", kind: "health", status: "new", title: "secret", path: "p", sealed: true },
  { id: "receipts/r", kind: "receipts", sub: "receipt", status: "new", title: "bag" },
  { id: "capture/../evil", kind: "capture" },
  { id: "", kind: "capture" }, null, "junk",
];
const items = () => L.foldIndex(ev);
const get = (id) => { const i = items().find((x) => x.id === id); if (i) i.hash = i.sealed ? "" : "H"; return i; };
const O = { requireVerified: false, defaultAgent: "Personal Assistant" };

t("fold: last line wins, bad ids and junk dropped", () => assert.deepStrictEqual(items().map((x) => x.id), ["capture/a", "capture/c", "health/d", "receipts/r"]));
t("sealed items carry no title or path", () => { const h = get("health/d"); assert.ok(h.sealed && h.title === "" && h.path === ""); });
t("a held command stays pending until WE record an approval, even if the index says sent", () => assert.strictEqual(L.summarize(items(), {}).rows.find((r) => r.id === "capture/a").status, "pending_approval"));
t("counts: sealed not in shared totals or waiting", () => { const c = L.summarize(items(), {}).counts; assert.strictEqual(c.health, 1); assert.strictEqual(c.all, 3); assert.strictEqual(c.pending, 1); });
t("tabs: receipts and ideas", () => { const r = L.summarize(items(), {}).rows; assert.strictEqual(r.find((x) => x.id === "receipts/r").tab, "receipts"); assert.strictEqual(r.find((x) => x.id === "capture/c").tab, "notes"); });
t("approve to default route has no `to`", () => { const d = L.decide({ action: "approve", hash: "H" }, get("capture/a"), {}, O, "T"); assert.ok(d.ok && !d.deliver && d.record.to === undefined); });
t("approve to another agent sets to_other and a delivery", () => { const d = L.decide({ action: "approve", to: "Marketing", hash: "H" }, get("capture/a"), {}, O, "T"); assert.ok(d.ok && d.record.to_other === true && d.deliver.agent === "Marketing"); });
t("sealed cannot be approved or sent, but can be rejected", () => {
  assert.strictEqual(L.decide({ action: "approve", to: "COO" }, get("health/d"), {}, O, "T").ok, false);
  assert.strictEqual(L.decide({ action: "reject" }, get("health/d"), {}, O, "T").ok, true);
});
t("requireVerified blocks unverified approval", () => assert.strictEqual(L.decide({ action: "approve", hash: "H" }, get("capture/a"), {}, { requireVerified: true }, "T").ok, false));
t("rejected and already-approved cannot be approved again", () => {
  assert.strictEqual(L.decide({ action: "approve", hash: "H" }, get("capture/a"), { "capture/a": { id: "capture/a", action: "reject" } }, O, "T").ok, false);
  assert.strictEqual(L.decide({ action: "approve", hash: "H" }, get("capture/a"), { "capture/a": { id: "capture/a", action: "approve", hash: "H" } }, O, "T").ok, false);
});
t("foldApprovals ignores junk", () => assert.deepStrictEqual(Object.keys(L.foldApprovals([{ id: "a", action: "approve" }, { id: "b", action: "x" }, null])), ["a"]));
t("sealed is sticky: a later event cannot unseal and the sealed path is remembered", () => {
  const f = L.foldIndex([{ id: "health/s", kind: "health", sealed: true, path: "secret.txt", title: "x" }, { id: "health/s", kind: "capture", title: "now open", path: "other.txt" }]);
  assert.ok(f[0].sealed && f[0].title === "" && f[0].path === "" && f[0].sealedPaths.includes("secret.txt") && f[0].sealedPaths.includes("other.txt"));
});
t("approve needs the hash of what was shown", () => {
  assert.strictEqual(L.decide({ action: "approve" }, get("capture/a"), {}, O, "T").ok, false);
  assert.strictEqual(L.decide({ action: "approve", hash: "OLD" }, get("capture/a"), {}, O, "T").ok, false);
});
t("approval record carries the hash; a changed item is pending again", () => {
  const d = L.decide({ action: "approve", hash: "H" }, get("capture/a"), {}, O, "T");
  assert.strictEqual(d.record.hash, "H");
  const it = get("capture/a"); it.hash = "CHANGED";
  assert.strictEqual(L.effectiveStatus(it, { "capture/a": { id: "capture/a", action: "approve", hash: "H" } }), "pending_approval");
  assert.strictEqual(L.effectiveStatus(get("capture/a"), { "capture/a": { id: "capture/a", action: "approve" } }), "pending_approval");   // no hash = not valid
});
t("no default agent and no pick = refused", () => assert.strictEqual(L.decide({ action: "approve", hash: "H" }, get("capture/a"), {}, { defaultAgent: "" }, "T").ok, false));
t("bidi and zero-width characters are stripped", () => {
  const f = L.foldIndex([{ id: "capture/z", kind: "capture", title: "a\u202Eb\u200Bc\u2066d" }]);
  assert.strictEqual(f[0].title, "abcd");
});
t("approved but undelivered to_other item can be retried with the same hash", () => {
  const it = get("capture/c");
  const ap = { "capture/c": { id: "capture/c", action: "approve", to: "Marketing", to_other: true, hash: "H" } };
  const d = L.decide({ action: "approve", hash: "H" }, it, ap, O, "T");
  assert.ok(d.ok && d.retry && d.deliver.agent === "Marketing");
  assert.strictEqual(L.decide({ action: "approve", hash: "X" }, it, ap, O, "T").ok, false);
});
console.log("intake.test.js: " + n + " passed");
