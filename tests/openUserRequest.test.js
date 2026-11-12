// node tests/openUserRequest.test.js - v1.155.12: an unanswered person request is carried into the fresh session after a handoff reset
const assert = require("assert");
const K = require("../src/keepGoing");
const G = require("../src/keepGoingGlue");
let fails = 0, n = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } }
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse("2026-11-11T10:00:00Z");
const a = (i, text, tool) => JSON.stringify({ type: "assistant", timestamp: iso(T0 + i * 1000), message: { content: [].concat(text ? [{ type: "text", text }] : [], tool ? [{ type: "tool_use", name: "Bash", input: {} }] : []) } });
const u = (i, text) => JSON.stringify({ type: "user", timestamp: iso(T0 + i * 1000), message: { content: text } });
const r = (i) => JSON.stringify({ type: "user", timestamp: iso(T0 + i * 1000), message: { content: [{ type: "tool_result", content: "ok" }] } });
const raw = (...l) => l.join("\n");
const HP = "Write handoff_latest.md now. Handoff saved when done.";

t("open request mid-work is carried", () => {
  const o = K.openUserRequest(raw(u(1, "[hid:abc] please fix the logo"), a(2, "", true), r(3), a(4, "", true), u(5, HP), a(6, "Handoff saved")));
  assert.ok(o); assert.strictEqual(o.text, "please fix the logo");
});
t("answered request is not carried", () => {
  assert.strictEqual(K.openUserRequest(raw(u(1, "hello"), a(2, "", true), r(3), a(4, "Done, here it is."), u(5, HP), a(6, "Handoff saved"))), null);
});
t("handoff turn does not count as an answer", () => {
  assert.ok(K.openUserRequest(raw(u(1, "do X"), u(2, HP), a(3, "Handoff saved. Next: ..."))));
});
t("app messages are not requests", () => {
  assert.strictEqual(K.openUserRequest(raw(u(1, "[[HANDOFF-RESUME]] C:\h.md\nContinue"), a(2, "", true), u(3, "[[KEEPGOING]] go on"), a(4, "", true))), null);
  assert.strictEqual(K.openUserRequest(raw(u(1, "<system-reminder>x</system-reminder>"))), null);
});
t("peer turns are not requests (wrapper text, notices, origin kind)", () => {
  assert.strictEqual(K.openUserRequest(raw(u(1, "Another Claude session sent a message:\n<cross-session-message from=\"x\">hi</cross-session-message>"))), null);
  assert.strictEqual(K.openUserRequest(raw(u(1, "[Cross-session idle notice] done"))), null);
  assert.strictEqual(K.openUserRequest(raw(u(1, "[Cross-session delivery notice] held"))), null);
  assert.strictEqual(K.openUserRequest(raw(u(1, "[Artifact comment sent to Claude] c"))), null);
  assert.strictEqual(K.openUserRequest(raw(JSON.stringify({ type: "user", origin: { kind: "peer" }, timestamp: iso(T0), message: { content: "do this" } }))), null);
  assert.ok(K.openUserRequest(raw(JSON.stringify({ type: "user", origin: { kind: "human" }, timestamp: iso(T0), message: { content: "do this" } }))));
});
t("latest of two requests wins; long text is cut", () => {
  const o = K.openUserRequest(raw(u(1, "first"), u(2, "second " + "x".repeat(5000))), false, 100);
  assert.ok(o.text.startsWith("second ")); assert.ok(o.text.length < 130);
});
t("glue appends it to the resume text, and fails open", () => {
  const mk = (readTail) => G.create({ now: () => T0, log() {}, emit() {}, agents: () => [], readTail, readFile: () => "## OPEN NOW\n1. thing\n", storage: { load: () => ({}), save() {} } });
  const g = mk(() => ({ text: raw(u(1, "need the report"), a(2, "", true)), partialFirst: false }));
  const x = g.resumeText("A", "C:\h.md");
  assert.ok(x.text.startsWith("[[HANDOFF-RESUME]]")); assert.ok(x.text.includes("UNANSWERED REQUEST")); assert.ok(x.text.includes("need the report"));
  const y = mk(() => { throw new Error("boom"); }).resumeText("A", "C:\h.md");
  assert.ok(y.text.startsWith("[[HANDOFF-RESUME]]")); assert.ok(!y.text.includes("UNANSWERED"));
});
console.log(n - fails + "/" + n + " passed"); process.exit(fails ? 1 : 0);
