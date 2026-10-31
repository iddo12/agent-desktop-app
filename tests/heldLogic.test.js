"use strict";
const assert = require("assert");
const HL = require("../src/renderer/heldLogic");
const row = (id, o) => Object.assign({ id, status: "held", agent: "coo", text: "t" + id, voice: false, photos: 0 }, o || {});
let n = 0; const t = (name, fn) => { fn(); n++; };

t("freeze lists exactly the approvable held rows", () => {
  const rows = [row("a"), row("b", { voice: true, transcriptState: "pending" }), row("c", { queued: "approve" }), row("d", { status: "approved" }), row("e", { voice: true, transcriptState: "failed" })];
  const f = HL.freeze(rows);
  assert.deepStrictEqual(f.ids, ["a", "e"]); assert.strictEqual(f.skipped, 1);
});
t("a new message arriving after the bar opened is never approved: confirmIds returns null", () => {
  const f = HL.freeze([row("a"), row("b")]);
  const later = [row("a"), row("b"), row("evil")];
  assert.strictEqual(HL.changed(f, later), true);
  assert.strictEqual(HL.confirmIds(f, later), null);
});
t("unchanged set confirms exactly the frozen ids", () => {
  const rows = [row("a"), row("b")], f = HL.freeze(rows);
  assert.deepStrictEqual(HL.confirmIds(f, rows), { ids: ["a", "b"], skipped: 0 });
});
t("a listed row whose text changed closes the bar", () => {
  const f = HL.freeze([row("a")]);
  assert.strictEqual(HL.changed(f, [row("a", { text: "different" })]), true);
});
t("a listed row that disappeared is dropped, not a change", () => {
  const f = HL.freeze([row("a"), row("b")]);
  assert.deepStrictEqual(HL.confirmIds(f, [row("a")]), { ids: ["a"], skipped: 0 });
});
t("a frozen row already queued elsewhere is not approved again", () => {
  const f = HL.freeze([row("a"), row("b")]);
  assert.deepStrictEqual(HL.confirmIds(f, [row("a", { queued: "reject" }), row("b")]).ids, ["b"]);
});
t("a transcript that finishes while the bar is open closes it (content changed)", () => {
  const f = HL.freeze([row("v", { voice: true, transcriptState: "pending" })]);
  assert.deepStrictEqual(f.ids, []);
  assert.strictEqual(HL.changed(f, [row("v", { voice: true, transcriptState: "ready", transcript: "hi" })]), true);
});
t("a frozen pending row stays skipped even if listed", () => {
  const rows = [row("a"), row("v", { voice: true, transcriptState: "pending" })], f = HL.freeze(rows);
  assert.deepStrictEqual(HL.confirmIds(f, rows), { ids: ["a"], skipped: 0 });
});
t("approve selected: exactly the ticked ids, pending ones skipped and counted, unticked and unknown never included", () => {
  const rows = [row("a"), row("b"), row("v", { voice: true, transcriptState: "pending" }), row("new")];
  assert.deepStrictEqual(HL.plan(["a", "v", "gone"], rows), { ids: ["a"], skipped: 1 });
});
t("a voice note waiting for a queue slot is also not approvable", () => assert.strictEqual(HL.approvable(row("w", { voice: true, transcriptState: "waiting" })), false));
t("single approve is off only for pending voice notes", () => {
  assert.strictEqual(HL.approvable(row("v", { voice: true, transcriptState: "pending" })), false);
  assert.strictEqual(HL.approvable(row("v", { voice: true, transcriptState: "failed" })), true);
  assert.strictEqual(HL.approvable(row("v", { voice: true, transcriptState: "ready" })), true);
  assert.strictEqual(HL.approvable(row("a", { queued: "approve" })), false);
});
console.log("heldLogic.test.js: " + n + " passed");
