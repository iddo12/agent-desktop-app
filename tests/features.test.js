// node tests/features.test.js - feature registry (v1.121.0): states, wired flag, known keys, SETUP.md in sync, strings for every feature.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { createAppConfig, KEYS } = require("../src/appConfig");
const features = require("../src/features");
const SS = require("../src/renderer/setup-strings.js");
let n = 0, fails = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adfeat-"));
const mk = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
const make = (env) => { const c = createAppConfig({ userDataDir: mk("ud" + Math.random().toString(36).slice(2, 7)), env: env || {} }); c.setRegistry(features); return c; };

// converted so far: pcHealth, claudeCode, claudeIntegration, telegram (launch / start-up area, v1.121.0); other areas add theirs here
const CONVERTED = ["pcHealth", "claudeCode", "claudeIntegration", "telegram"];
const WANTED = ["argus", "memory", "myDaily", "myHealth", "myFinance", "pcHealth", "claudeCode", "claudeIntegration", "telegram", "tools", "library", "research", "fleet", "iris", "keepGoing", "usage", "voice"];
t("the registry declares exactly the 17 features (plus the hidden workspace card)", () => {
  assert.deepStrictEqual(features.list().map((f) => f.id).sort(), WANTED.slice().sort());
  assert.ok(features.get("workspace").hidden);
});
t("every requires / step key is a known config key; every step kind is known", () => {
  for (const f of features.list(true)) {
    for (const k of f.requires) assert.ok(KEYS[k], f.id + " requires unknown key " + k);
    for (const s of f.steps) { assert.ok(KEYS[s.key], f.id + " step key " + s.key); assert.ok(features.KNOWN_STEP_KINDS.indexOf(s.kind) >= 0, s.kind); assert.ok(s.label && s.help, f.id + "." + s.key); }
    assert.ok(f.help && f.agentHelp && f.title && f.group, f.id);
  }
});
t("every feature says whether it is wired (converted to the config layer)", () => {
  for (const f of features.list(true)) assert.strictEqual(typeof f.wired, "boolean", f.id);
});
t("tile ids match the real sidebar tiles", () => {
  const lp = require("../src/leftpane.js"); const known = new Set(lp.SYSTEMS.map((s) => s.id).concat(["health", "tools", "research", "finance", "fleet"]));
  for (const f of features.list()) if (f.tileId) assert.ok(known.has(f.tileId), f.id + " -> " + f.tileId);
});
t("states: unconfigured = needs-setup, configured = ready, no feature needs more than the keys it declares", () => {
  const ws = mk("ws"); fs.mkdirSync(path.join(ws, "shared_reports")); fs.mkdirSync(path.join(ws, "Agents"));
  const c = make({ AGENT_DESKTOP_WORKSPACE_ROOT: ws });
  assert.strictEqual(c.feature("argus").state, "ready");
  assert.strictEqual(c.feature("research").state, "ready");
  assert.strictEqual(c.feature("memory").state, "needs-setup", "memory also needs the statistics file");
  const stats = path.join(ws, "memory_stats.json"); fs.writeFileSync(stats, "{}");
  assert.strictEqual(make({ AGENT_DESKTOP_WORKSPACE_ROOT: ws, AGENT_DESKTOP_MEMORY_STATS_FILE: stats }).feature("memory").state, "ready");
  assert.strictEqual(c.feature("fleet").state, "needs-setup", "no mailbox folder");
  assert.strictEqual(c.feature("usage").state, "needs-setup");
  assert.strictEqual(c.feature("voice").state, "needs-setup", "voice needs the speech program and model; nothing is auto-detected");
  assert.deepStrictEqual(c.feature("voice").missing, ["whisperExe", "whisperModel"]);
  assert.deepStrictEqual(c.feature("fleet").missing, ["exchangeDir"]);
  assert.strictEqual(c.feature("argus").wired, true);
  assert.strictEqual(c.feature("voice").wired, true);
});
t("detect(): found only lists values that exist; suggestions carry path + exists + tag", () => {
  const ws = mk("ws2"); fs.mkdirSync(path.join(ws, "shared_reports"));
  const c = make({ AGENT_DESKTOP_WORKSPACE_ROOT: ws });
  const d = features.detect(c, "argus");
  assert.strictEqual(d.ok, true); assert.strictEqual(d.found.sharedReports, path.join(ws, "shared_reports"));
  const s = features.suggestions(c, "argus"); assert.ok(s.every((x) => x.path && typeof x.exists === "boolean" && (x.tag === "detected" || x.tag === "new")));
  const c2 = make({ AGENT_DESKTOP_WORKSPACE_ROOT: path.join(ws, "nothing-here") });
  assert.ok(features.suggestions(c2, "argus").every((x) => x.exists === false && x.tag === "new"));
});
t("the fleet label is renamable and defaults to 'Shared fleet'", () => {
  assert.strictEqual(features.get("fleet").title, "Shared fleet");
  assert.ok(features.get("fleet").steps.some((s) => s.key === "fleetLabel"));
});
t("setup-strings.js has English and Hebrew copy for every feature", () => {
  for (const lang of ["en", "he"]) for (const id of WANTED) { const f = SS.feature(lang, id); assert.strictEqual(f.length, 5, lang + id); assert.ok(f[1] && f[2], lang + id); }
  assert.strictEqual(SS.lang.he.dir, "rtl");
  assert.ok(Object.keys(SS.lang.en.errors).every((k) => SS.lang.he.errors[k]), "Hebrew errors complete");
  assert.ok(Object.keys(SS.lang.en.states).every((k) => SS.lang.he.states[k]));
});
t("SETUP.md is up to date (run: node tools/gen-setup-md.js)", () => {
  const want = require("../tools/gen-setup-md.js").render();
  const have = fs.readFileSync(path.join(__dirname, "..", "SETUP.md"), "utf8").replace(/\r\n/g, "\n");
  assert.strictEqual(have, want, "SETUP.md is out of date: run node tools/gen-setup-md.js");
});
t("SETUP.md mentions every feature, every key", () => {
  const md = require("../tools/gen-setup-md.js").render();
  for (const id of WANTED) assert.ok(md.indexOf("### " + id + " ") >= 0, id);
  for (const k of Object.keys(KEYS)) assert.ok(md.indexOf("- " + k + " (") >= 0, k);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(n - fails + "/" + n + " passed");
process.exit(fails ? 1 : 0);
