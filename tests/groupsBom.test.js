"use strict";
// 2026-10-07: agent_groups.json re-saved with a BOM by another agent made Agent Desktop silently show NO groups.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-groups-"));
process.env.AGENT_DESKTOP_ROOT = root;
const { readGroups, writeGroups, GROUPS_PATH } = require("../src/groups");
const { readJsonFile, stripBom } = require("../src/jsonfile");

const DOC = { version: 1, groups: [
  { id: "g1", name: "Core", color: "#3b82f6", parentId: null, order: 0, members: ["COO", "Security"] },
  { id: "g2", name: "Legal", color: "#10b981", parentId: null, order: 1, members: ["Legal"] },
] };

test("a BOM at the start of agent_groups.json does not drop the groups", () => {
  fs.writeFileSync(GROUPS_PATH, "﻿" + JSON.stringify(DOC, null, 4), "utf-8");
  const g = readGroups();
  assert.strictEqual(g.groups.length, 2);
  assert.deepStrictEqual(g.groups[0].members, ["COO", "Security"]);
});

test("a normal file without a BOM still reads", () => {
  fs.writeFileSync(GROUPS_PATH, JSON.stringify(DOC), "utf-8");
  assert.strictEqual(readGroups().groups.length, 2);
});

test("an unreadable file is kept as a copy before Agent Desktop writes its own version", () => {
  fs.writeFileSync(GROUPS_PATH, "{ this is not json", "utf-8");
  assert.strictEqual(readGroups().groups.length, 0, "falls back to no groups, as before");
  writeGroups(DOC);
  const copies = fs.readdirSync(root).filter((n) => n.startsWith("agent_groups.json.unreadable_"));
  assert.strictEqual(copies.length, 1, "the broken original was preserved");
  assert.strictEqual(fs.readFileSync(path.join(root, copies[0]), "utf-8"), "{ this is not json");
  assert.strictEqual(readGroups().groups.length, 2, "the new file is good");
});

test("a valid file is NOT copied on write (no clutter)", () => {
  for (const n of fs.readdirSync(root)) if (n.startsWith("agent_groups.json.unreadable_")) fs.unlinkSync(path.join(root, n));
  fs.writeFileSync(GROUPS_PATH, "﻿" + JSON.stringify(DOC), "utf-8");
  writeGroups(DOC);
  assert.strictEqual(fs.readdirSync(root).filter((n) => n.startsWith("agent_groups.json.unreadable_")).length, 0);
});

test("readJsonFile / stripBom", () => {
  const f = path.join(root, "x.json");
  fs.writeFileSync(f, "﻿{\"a\":1}", "utf-8");
  assert.deepStrictEqual(readJsonFile(f), { a: 1 });
  fs.writeFileSync(f, "{\"a\":2}", "utf-8");
  assert.deepStrictEqual(readJsonFile(f), { a: 2 });
  assert.strictEqual(stripBom("﻿abc"), "abc");
  assert.strictEqual(stripBom("abc"), "abc");
  assert.throws(() => { fs.writeFileSync(f, "nope", "utf-8"); readJsonFile(f); });
});
