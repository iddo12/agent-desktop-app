// node tests/noHardcodedPrompts.test.js - v1.121.0 guard for the renderer vocabulary / agent-facing prompt strings and the dev scripts that were converted
// (area "prompts"): the CODE of these files (comments and REM lines are ignored: they are history, not behaviour) must not hard-code a person's name,
// a drive-letter path, a site, an agent folder name or a workspace tool name. Names come from the configuration layer (src/renderer/app-cfg.js).
// Also unit-tests app-cfg.js with the owner-style configuration: the old texts must come out exactly as before.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const ROOT = path.join(__dirname, "..");
const BS = String.fromCharCode(92);
let n = 0, fails = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };

const FILES = [
  "src/research/write.js", "src/wakeAgentMain.js", "src/renderer/app-cfg.js", "src/renderer/guards.js", "src/renderer/keepgoing.js", "src/renderer/waiting-queue.js", "src/renderer/renderer.js",
  "src/predict.js", "src/predictMain.js", "src/research/summary.js", "src/tools/schema.js", "src/tools/model.js", // names round
  "tools/make-fixtures.js", "tools/research-aggregate.js", "tools/health-pane-sandbox.cjs", "Start-TestDesktop.bat", "INSTALL_AND_USE_FOR_CLAUDE.md",
];
const PATTERNS = [
  ["a person's name", /Alex|Sarah|Id{2}o|Mer[a]v|example-user/g],
  ["a drive-letter path", /\b[A-Za-z]:[\\/]/g],
  ["a drive-letter path (escaped)", /\b[A-Za-z]:\\\\/g],
  ["a site name", /acmeco\.com/gi],
  ["a Dropbox or workspace folder", /Dropbox|Claude[ ]work|Claude[ ]stuff/g],
  ["an agent folder name", /COO Agent|SEO Agent|System Optimization|Master_Context|Software Engineering Agent/g],
  ["a workspace question tool", /ask_owner/g],
  ["a built-in plan default", /DEFAULT_PLAN_ID|infrastructure_facts/g],
];
function code(rel, text) {
  if (/\.bat$/.test(rel)) return text.split(/\r?\n/).filter((l) => !/^\s*REM\b/i.test(l)).join("\n");
  // a document: generic examples (a sample drive folder, "cloud folders may lock files") are fine, personal names are not
  if (/\.md$/.test(rel)) return text.split("\n").filter((l) => /Alex|Sarah|Id{2}o|Mer[a]v|example-user/.test(l)).join("\n");
  const s = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return s.split("\n").map((l) => { const m = /(^|[^:])\/\/(?!\/)/.exec(l); return m ? l.slice(0, m.index + m[1].length) : l; }).join("\n");
}
for (const rel of FILES) {
  t("no hard-coded names/paths in the code of " + rel, () => {
    const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const text = code(rel, raw), hits = [];
    for (const [what, re] of PATTERNS) for (const m of text.matchAll(re)) {
      const line = text.slice(text.lastIndexOf("\n", m.index) + 1, text.indexOf("\n", m.index) < 0 ? undefined : text.indexOf("\n", m.index)).trim();
      hits.push(what + ": " + line.slice(0, 120));
    }
    assert.deepStrictEqual(hits, [], rel + " has " + hits.length + " hard-coded value(s)");
  });
}
t("the guard itself catches a planted value (self-test)", () => {
  assert.ok(/Alex/.test(code("x.js", 'const s = "' + "Al" + 'ex approved";')));
  assert.ok(!/Alex/.test(code("x.js", "const a = 1; // " + "Al" + "ex said")));
  assert.ok(!/Alex/.test(code("x.bat", "REM " + "Al" + "ex")));
});
t("app-cfg.js is loaded before the scripts that use it", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
  const i = html.indexOf('"app-cfg.js"'), r = html.indexOf('"renderer.js"');
  assert.ok(i > 0 && i < r, "app-cfg.js must come first");
});

// ---- app-cfg.js with the owner-style configuration ----
function load(values, bridge) {
  const win = { api: bridge === undefined ? { config: { getAll: async () => ({ ok: true, values }) } } : bridge };
  const ctx = { window: win, Promise }; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/renderer/app-cfg.js"), "utf8"), ctx);
  return win.AppCfg;
}
const owner = { ownerName: "Alex", partnerName: "Sarah", planTier: "max5x", tasksTool: ["C:", "Example", "Workspace", "shared_tools", "tasks", "tasks.py"].join(BS) };
(async () => {
  const A = load(owner); await A.ready;
  t("owner-style config: the old texts come out exactly as before", () => {
    assert.strictEqual(A.owner(), "Alex"); assert.strictEqual(A.owner({ cap: true }), "Alex");
    assert.strictEqual(A.partner({ upper: true }), "SARAH"); assert.strictEqual(A.partner(), "Sarah");
    assert.strictEqual(A.planTier(), "max5x"); assert.strictEqual(A.toolName("tasksTool", ""), "tasks.py");
    assert.strictEqual(A.hasPartner(), true);
  });
  const E = load({}); await E.ready;
  t("unconfigured: neutral words, plan not set, no partner, never throws", () => {
    assert.strictEqual(E.owner(), "the user"); assert.strictEqual(E.owner({ cap: true }), "The user");
    assert.strictEqual(E.partner({ upper: true }), "PARTNER"); assert.strictEqual(E.planTier(), null);
    assert.strictEqual(E.toolName("tasksTool", ""), ""); assert.strictEqual(E.hasPartner(), false); assert.strictEqual(E.get("nothing"), null);
  });
  const NB = load({}, {}); await NB.ready;
  t("no config bridge (tests, old shells): loads, neutral defaults", () => { assert.strictEqual(NB.isLoaded(), true); assert.strictEqual(NB.owner(), "the user"); });
  const BAD = load({}, { config: { getAll: async () => { throw new Error("x"); } } }); await BAD.ready;
  t("a failing bridge keeps the neutral defaults", () => { assert.strictEqual(BAD.owner(), "the user"); assert.strictEqual(BAD.planTier(), null); });
  const GARBAGE = load({ ownerName: 5, planTier: "enterprise", partnerName: "  " }); await GARBAGE.ready;
  t("garbage values are ignored", () => { assert.strictEqual(GARBAGE.owner(), "the user"); assert.strictEqual(GARBAGE.planTier(), null); assert.strictEqual(GARBAGE.hasPartner(), false); });
  const R = load({ ownerName: "Ann" }); await R.ready;
  t("a configured name replaces the neutral one", () => { assert.strictEqual(R.owner(), "Ann"); });
  console.log(n - fails + "/" + n + " passed");
  process.exit(fails ? 1 : 0);
})();
