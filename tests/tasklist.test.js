"use strict";
const assert = require("assert");
const L = require("../src/tasklist/tasklistLogic");
let n = 0;
const t = (name, fn) => { fn(); n++; };

const items = [
  { id: "a", title: "Tech title", plain: "Plain A", status: "open", needsIddo: true, priority: 2, updated: "2026-10-22T10:00:00" },
  { id: "b", title: "B", status: "blocked", priority: 2, updated: "2026-10-22T10:01:00" },
  { id: "c", title: "C", status: "open", startedAt: "2026-10-22T09:00:00", progress: "half way", priority: 2, order: 20, updated: "2026-10-22T10:02:00" },
  { id: "d", title: "D", status: "open", priority: 1, order: 10, updated: "2026-10-22T10:03:00" },
  { id: "e", title: "E", status: "open", priority: 3, updated: "2026-10-22T10:04:00" },
  { id: "f", title: "F", status: "done", closedAt: "2026-10-22T08:00:00", updated: "2026-10-22T08:00:00" },
  { id: "g", title: "G", status: "done", closedAt: "2026-10-21T08:00:00", updated: "2026-10-21T08:00:00" },
];
const store = { agent: "X", items, archive: [{ id: "h", status: "done", closedAt: "2026-10-22T07:00:00" }] };

t("groups", () => assert.deepStrictEqual(items.map((i) => L.groupOf(i)), ["needs_you", "stuck", "working", "not_started", "not_started", "finished", "finished"]));
t("plain wording wins over the technical title", () => assert.strictEqual(L.toRow("X", items[0]).title, "Plain A"));
t("progress line shows only while working", () => { assert.strictEqual(L.toRow("X", items[2]).line, "half way"); assert.strictEqual(L.toRow("X", items[3]).line, ""); });
t("sorted by group, then manual order, then priority", () => {
  const r = L.summarize([store], "2026-10-22T12:00:00").rows;
  assert.deepStrictEqual(r.map((x) => x.id), ["a", "b", "c", "d", "e", "f", "g"]);
});
t("counts with done today (and yesterday) from items and archive", () => {
  const c = L.summarize([store], "2026-10-22T12:00:00").counts;
  assert.deepStrictEqual([c.needs_you, c.stuck, c.working, c.not_started, c.finished, c.doneToday, c.doneYesterday], [1, 1, 1, 2, 2, 2, 1]);
});
t("junk items are skipped; control and bidi characters stripped", () => {
  const s = L.summarize([{ agent: "X", items: [null, "x", { id: "z", title: "a‮b​c", status: "open" }] }], "2026-10-22T12:00:00");
  assert.strictEqual(s.rows.length, 1); assert.strictEqual(s.rows[0].title, "abc");
});
t("moveArgs: up/down/top/bottom inside one agent, finished never moves", () => {
  const rows = L.summarize([store], "2026-10-22T12:00:00").rows;
  assert.deepStrictEqual(L.moveArgs(rows, "e", "up"), ["--move", "e", "--before", "d"]);
  assert.deepStrictEqual(L.moveArgs(rows, "e", "down"), null);
  assert.deepStrictEqual(L.moveArgs(rows, "d", "bottom"), ["--move", "d", "--bottom"]);
  assert.deepStrictEqual(L.moveArgs(rows, "e", "top"), ["--move", "e", "--top"]);
  assert.strictEqual(L.moveArgs(rows, "f", "up"), null);
  assert.strictEqual(L.moveArgs(rows, "--top", "up"), null);   // an id that starts with "-" never reaches the argument list
});
t("agent names with path characters are refused", () => { assert.ok(L.AGENT_OK.test("Software Engineering Agent")); assert.ok(!L.AGENT_OK.test("..\\x")); assert.ok(!L.AGENT_OK.test("a/b")); });
console.log("tasklist.test.js: " + n + " passed");
