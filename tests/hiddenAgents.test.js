// node tests/hiddenAgents.test.js - v1.140.0 hidden agents: the setting parser and marker, the config key, and static guards that hiding is
// display-only (main's own listAgents stays whole, rows are kept but not displayed, lookups by path/name still see hidden agents). No names in code.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const H = require("../src/hiddenAgents");
let n = 0, fails = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + ": " + e.message); } };
const src = (p) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");
const list = [{ folderName: "Alpha", displayName: "Alpha Agent", path: "/w/Alpha" }, { folderName: "Beta", displayName: "Beta", path: "/w/Beta" }, { folderName: "Gamma", path: "/w/Gamma" }];

t("parse: ; , and new lines, trimmed, case-insensitive, empty and junk ignored", () => {
  assert.deepStrictEqual([...H.parse(" Alpha ; beta,\nGAMMA ;; ")], ["alpha", "beta", "gamma"]);
  assert.strictEqual(H.parse("").size, 0); assert.strictEqual(H.parse(null).size, 0); assert.strictEqual(H.parse(42).size, 0);
  assert.strictEqual(H.parse("x".repeat(121)).size, 0);
});
t("mark: flags by folder or display name, never drops an agent, never mutates the input", () => {
  const m = H.mark(list, "beta;Alpha Agent");
  assert.strictEqual(m.length, 3); assert.deepStrictEqual(m.map((a) => a.hidden), [true, true, false]);
  assert.strictEqual(list[0].hidden, undefined); assert.notStrictEqual(m[0], list[0]);
});
t("mark: default (no setting) hides nothing", () => { assert.ok(H.mark(list, null).every((a) => a.hidden === false)); assert.ok(H.mark(list, "").every((a) => a.hidden === false)); });
t("mark: a bad list is an empty list; non-object entries pass through", () => { assert.deepStrictEqual(H.mark(null, "a"), []); assert.deepStrictEqual(H.mark([null, 1], "a"), [null, 1]); });
t("config key hiddenAgents exists, defaults to null, takes a ; list, refuses control characters, env override works", () => {
  const { createAppConfig } = require("../src/appConfig");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adhid-"));
  const c = createAppConfig({ userDataDir: dir, env: {} });
  assert.strictEqual(c.get("hiddenAgents"), null);
  assert.ok(c.set("hiddenAgents", "Alpha;Beta").ok !== false); assert.strictEqual(c.get("hiddenAgents"), "Alpha;Beta");
  const bad = c.set("hiddenAgents", "a\u0001b"); assert.ok(bad && bad.ok === false);
  const e = createAppConfig({ userDataDir: dir, env: { AGENT_DESKTOP_HIDDEN_AGENTS: "Gamma" } }); assert.strictEqual(e.get("hiddenAgents"), "Gamma");
  fs.rmSync(dir, { recursive: true, force: true });
});
t("main: only the renderer-facing lists are marked; main's own listAgents() calls are unchanged", () => {
  const m = src("main.js");
  assert.ok(/ipcMain\.handle\("list-agents".*require\("\.\/hiddenAgents"\)\.mark\(listAgents\(\)/.test(m));
  assert.ok(/get-agent-overview.*hiddenAgents"\)\.mark\(/.test(m));
  assert.strictEqual((m.match(/hiddenAgents"\)\.mark\(/g) || []).length, 2);
  assert.ok(!/function listAgents[\s\S]{0,400}hidden/.test(m));
});
t("renderer: hidden rows are kept (class + hidden attribute), never filtered out of `agents`; toggle exists; active agent always shown", () => {
  const r = src("renderer/renderer.js");
  assert.ok(/row\.classList\.add\("agent-hidden"\); row\.hidden = true;/.test(r));
  assert.ok(!/agents = agentList\.filter/.test(r)); assert.ok(/agents = agentList;/.test(r));
  assert.ok(/agent\.path !== activeAgentPath/.test(r)); assert.ok(/hidden-agents-toggle/.test(r));
  assert.ok(/hidden: !!a\.hidden/.test(r));   // the libraryBridge still returns hidden agents (lookups by name), with the flag
});
t("pickers and fleet views leave hidden agents out; waiting queue ignores hidden rows", () => {
  assert.ok(/a\.hidden && !\(window\.hiddenAgentsView/.test(src("renderer/library.js")));
  assert.ok(/list = list\.filter\(\(a\) => !a\.hidden\)/.test(src("renderer/argus.js")));
  assert.ok(/agent-hidden/.test(src("renderer/waiting-queue.js")));
  assert.ok(/shownA = overview\.agents\.filter/.test(src("renderer/header-tasks.js")));
  assert.ok(/hidden: !!a\.hidden/.test(src("overview.js")));
});
t("research lookups by name (Ask bar) still use the full list", () => { assert.ok(/\(bridge\.agents\(\) \|\| \[\]\)\.find\(/.test(src("renderer/research.js"))); });
t("no agent name is hard-coded in the hiding code", () => {
  for (const f of ["hiddenAgents.js", "renderer/renderer.js"]) assert.ok(!/["']Security["']/.test(src(f)), f);
});
console.log(n - fails + "/" + n + " passed"); process.exit(fails ? 1 : 0);
