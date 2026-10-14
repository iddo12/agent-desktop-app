// node tests/waitingQueue.test.js - pure helpers of src/renderer/waiting-queue.js (question + background extraction), loaded in a vm with a stub DOM.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "waiting-queue.js"), "utf-8");
const win = {};
const stubEl = () => ({ appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, insertAdjacentElement() {}, remove() {}, style: {} });
const ctx = { window: win, document: { readyState: "complete", getElementById: () => null, querySelectorAll: () => [], createElement: stubEl, addEventListener() {}, body: stubEl() }, localStorage: { getItem: () => null, setItem() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, Promise, MutationObserver: function () { this.observe = () => {}; } };
ctx.window = win; vm.createContext(ctx); vm.runInContext(src, ctx);
const P = win.WaitingQueuePure;
let n = 0, fails = 0; const t = (name, fn) => { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } };

t("exports exist", () => assert.ok(P && typeof P.extractQuestion === "function" && typeof P.lastAgentBlock === "function"));
t("takes the text after QUESTION FOR YOU as the question, the rest as background", () => {
  const r = P.extractQuestion("We deployed the theme.\n\nStaging is clean.\n\nQUESTION FOR YOU\nMay I restart Agent Desktop now? Yes or no.");
  assert.strictEqual(r.why, "May I restart Agent Desktop now? Yes or no.");
  assert.ok(r.ctx.includes("We deployed the theme.") && r.ctx.includes("Staging is clean."));
  assert.ok(!r.ctx.includes("restart Agent Desktop now"));
});
t("fenced question block is cleaned", () => {
  const r = P.extractQuestion("Report text.\n\n```\nQUESTION FOR YOU\nWhich style do you pick, A or B?\n```\n");
  assert.strictEqual(r.why, "Which style do you pick, A or B?");
});
t("without the marker: the last paragraph with a question mark", () => {
  const r = P.extractQuestion("First part.\n\nWhat do you want to do about the cutover date?\n\nI will wait.");
  assert.strictEqual(r.why, "What do you want to do about the cutover date?");
  assert.ok(r.ctx.includes("First part."));
});
t("no question at all: the last paragraph", () => { const r = P.extractQuestion("One.\n\nTwo is last."); assert.strictEqual(r.why, "Two is last."); });
t("empty text", () => { const r = P.extractQuestion(""); assert.strictEqual(r.why, ""); assert.strictEqual(r.ctx, ""); });
t("very long background is cut to the newest part", () => {
  const long = ("word ".repeat(400)).trim(); const r = P.extractQuestion(long + "\n\nIs this OK?", 300);
  assert.ok(r.ctx.length <= 304, "ctx " + r.ctx.length); assert.ok(r.ctx.startsWith("..."));
});
t("long question is shortened", () => { const r = P.extractQuestion("A".repeat(700) + "?"); assert.ok(r.why.length <= 420); });
t("lastAgentBlock picks the newest agent block", () => {
  const b = P.lastAgentBlock([{ role: "agent", lines: ["a"] }, { role: "user", lines: ["u"] }, { role: "agent", lines: ["b"] }, { role: "status", lines: ["s"] }]);
  assert.deepStrictEqual(b.lines, ["b"]);
  assert.strictEqual(P.lastAgentBlock([{ role: "user", lines: ["u"] }]), null);
  assert.strictEqual(P.lastAgentBlock(null), null);
});
t("looksAsking: ends with a question", () => { assert.ok(P.looksAsking("Done the work.\n\nShould I restart it?")); });
t("looksAsking: trailing DONE line is ignored, BLOCKED counts", () => {
  assert.ok(P.looksAsking("Pick one.\n\nMay I deploy?\n\nBLOCKED: waiting for your yes"));
  assert.ok(!P.looksAsking("Waiting on Software Engineering for the fix.\n\nBLOCKED: waiting on another agent, Alex needs to say yes later"));
  assert.ok(!P.looksAsking("All finished. Is it live? yes.\n\nDONE: shipped"));
  assert.ok(P.looksAsking("Fixed it. Should I also do X?\n\nDONE: fixed"));
});
t("looksAsking: plain statements and empty are not questions", () => { assert.ok(!P.looksAsking("Everything is fine.")); assert.ok(!P.looksAsking("")); assert.ok(P.looksAsking("QUESTION FOR YOU: go?")); });

console.log("waitingQueue: " + (n - fails) + "/" + n + " passed"); process.exit(fails ? 1 : 0);
