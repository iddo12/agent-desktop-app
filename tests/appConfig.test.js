// node tests/appConfig.test.js - the configuration layer (v1.121.0): resolution order, validation, atomic writes, onChange. Temp dirs only (no D:/E:).
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { createAppConfig, KEYS } = require("../src/appConfig");
const features = require("../src/features");
let n = 0, fails = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adcfg-"));
const mk = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
const make = (ud, env, extra) => { const c = createAppConfig(Object.assign({ userDataDir: ud, env: env || {}, documentsDir: path.join(tmp, "Documents") }, extra || {})); c.setRegistry(features); return c; };

t("nothing configured: everything is null, nothing throws", () => {
  const c = make(mk("ud1"));
  for (const k of c.allKeys()) { c.get(k); c.path(k); }
  assert.strictEqual(c.get("workspaceRoot"), null);
  assert.strictEqual(c.path("sharedReports"), null);
  assert.strictEqual(c.feature("argus").state, "needs-setup");
  assert.strictEqual(c.isReady("argus"), false);
  assert.strictEqual(c.feature("nope").state, "needs-setup");
});
t("no default points at a person's folder: appConfig.js has no drive-letter paths", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "appConfig.js"), "utf8");
  assert.ok(!/[A-Za-z]:[\\/]{1,2}[A-Za-z]/.test(src.replace(/\/\/.*$/gm, "")), "drive-letter path in appConfig.js");
});
t("env beats file beats auto-detect", () => {
  const ud = mk("ud2"), ws1 = mk("ws1"), ws2 = mk("ws2"), ws3 = mk("ws3");
  fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify({ schema: 1, values: { workspaceRoot: ws2 } }));
  let c = make(ud, { AGENT_DESKTOP_ROOT: path.join(ws3, "agents") });
  assert.strictEqual(c.get("workspaceRoot"), ws2, "file beats auto-detect (parent of AGENT_DESKTOP_ROOT)");
  assert.strictEqual(c.source("workspaceRoot"), "config");
  c = make(ud, { AGENT_DESKTOP_WORKSPACE_ROOT: ws1, AGENT_DESKTOP_ROOT: path.join(ws3, "agents") });
  assert.strictEqual(c.get("workspaceRoot"), ws1, "env beats file");
  assert.strictEqual(c.source("workspaceRoot"), "env");
  c = make(mk("ud2b"), { AGENT_DESKTOP_ROOT: path.join(ws3, "agents") });
  assert.strictEqual(c.get("workspaceRoot"), ws3);
  assert.strictEqual(c.get("agentsRoot"), path.join(ws3, "agents"));
  assert.strictEqual(c.source("workspaceRoot"), "auto");
});
t("derived paths follow the workspace; sub-paths cannot escape", () => {
  const ws = mk("ws4"); const c = make(mk("ud3"), { AGENT_DESKTOP_WORKSPACE_ROOT: ws });
  assert.strictEqual(c.get("sharedReports"), path.join(ws, "shared_reports"));
  assert.strictEqual(c.get("tasksTool"), path.join(ws, "shared_tools", "tasks", "tasks.py"));
  assert.strictEqual(c.path("sharedReports", "coo", "brief.json"), path.join(ws, "shared_reports", "coo", "brief.json"));
  assert.strictEqual(c.path("sharedReports", "..", "x"), null);
  assert.strictEqual(c.path("sharedReports", path.join(ws, "abs")), null);
});
t("bad values are refused: relative, traversal, NUL, device paths, wrong kind", () => {
  const c = make(mk("ud4"));
  for (const v of ["relative/dir", "..\\..\\x", tmp + path.sep + "a" + path.sep + ".." + path.sep + "b", "C:\\x\\..\\y", "\\\\?\\C:\\x", path.join(tmp, "a\0b"), "", 5]) {
    const r = c.set("workspaceRoot", v, { create: true });
    assert.strictEqual(r.ok, false, "accepted " + JSON.stringify(v));
  }
  assert.strictEqual(c.set("planTier", "gold").ok, false);
  assert.strictEqual(c.set("planTier", "max5x").ok, true);
  assert.strictEqual(c.set("nokey", "x").ok, false);
  assert.strictEqual(c.set("outputRoots", "notalist").ok, false);
});
t("a folder that does not exist is refused unless create is asked; files must exist", () => {
  const c = make(mk("ud5")); const p = path.join(tmp, "newfolder", "deep");
  assert.strictEqual(c.set("workspaceRoot", p).error, "folder-missing");
  assert.ok(!fs.existsSync(p));
  assert.strictEqual(c.set("workspaceRoot", p, { create: true }).ok, true);
  assert.ok(fs.statSync(p).isDirectory());
  assert.strictEqual(c.get("workspaceRoot"), p);
  assert.strictEqual(c.set("tasksTool", path.join(tmp, "nofile.py")).error, "file-missing");
  const f = path.join(tmp, "t.py"); fs.writeFileSync(f, "x");
  assert.strictEqual(c.set("tasksTool", f).ok, true);
});
t("writes are atomic: no temp file left, valid JSON, schema field, unknown fields kept", () => {
  const ud = mk("ud6"); const ws = mk("ws6");
  fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify({ schema: 1, values: {}, future: { a: 1 } }));
  const c = make(ud);
  assert.strictEqual(c.set("workspaceRoot", ws).ok, true);
  assert.deepStrictEqual(fs.readdirSync(ud), ["app-config.json"]);
  const j = JSON.parse(fs.readFileSync(path.join(ud, "app-config.json"), "utf8"));
  assert.strictEqual(j.schema, 1); assert.strictEqual(j.values.workspaceRoot, ws); assert.deepStrictEqual(j.future, { a: 1 });
  const bad = createAppConfig({ userDataDir: ud, env: {}, fs: Object.assign({}, fs, { renameSync() { throw new Error("disk full"); } }) });
  const r = bad.set("workspaceRoot", ws);
  assert.strictEqual(r.ok, false); assert.deepStrictEqual(fs.readdirSync(ud), ["app-config.json"]);
});
t("a corrupt or BOM file never throws: BOM is read, garbage means unconfigured", () => {
  const ud = mk("ud7"); const ws = mk("ws7");
  fs.writeFileSync(path.join(ud, "app-config.json"), "\uFEFF" + JSON.stringify({ values: { workspaceRoot: ws } }));
  assert.strictEqual(make(ud).get("workspaceRoot"), ws);
  fs.writeFileSync(path.join(ud, "app-config.json"), "{not json");
  const c = make(ud); assert.strictEqual(c.get("workspaceRoot"), null); assert.ok(c.reload().error);
  fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify({ values: { workspaceRoot: "relative" } }));
  assert.strictEqual(make(ud).get("workspaceRoot"), null, "an invalid stored value is ignored");
});
t("onChange fires once per write with the keys; unsubscribe works", () => {
  const c = make(mk("ud8")); const ws = mk("ws8"); const seen = [];
  const off = c.onChange((e) => seen.push(e));
  c.set("workspaceRoot", ws); assert.strictEqual(seen.length, 1); assert.deepStrictEqual(seen[0].keys, ["workspaceRoot"]);
  c.set("workspaceRoot", "relative"); assert.strictEqual(seen.length, 1, "a refused write emits nothing");
  off(); c.set("planTier", "pro"); assert.strictEqual(seen.length, 1);
});
t("features: ready after setup, off when disabled, needs-attention when a configured folder disappears", () => {
  const ud = mk("ud9"), ws = mk("ws9"); const c = make(ud);
  assert.strictEqual(c.feature("argus").state, "needs-setup");
  assert.strictEqual(c.setFeature("argus", { enabled: true, values: { workspaceRoot: ws, sharedReports: path.join(ws, "shared_reports") } }, { create: true }).ok, true);
  assert.strictEqual(c.feature("argus").state, "ready"); assert.ok(c.isReady("argus"));
  fs.rmSync(path.join(ws, "shared_reports"), { recursive: true });
  assert.strictEqual(c.feature("argus").state, "needs-attention");
  assert.strictEqual(c.setFeature("argus", { enabled: false }).ok, true);
  assert.strictEqual(c.feature("argus").state, "off");
  assert.strictEqual(c.setFeature("nope", { enabled: true }).ok, false);
  assert.strictEqual(c.setFeature("argus", { values: { workspaceRoot: "relative" } }).ok, false);
});
t("a root chosen at run time (nothing about D: or E: is assumed) works end to end", () => {
  const ws = mk("ws10"); const c = make(mk("ud10"), { AGENT_DESKTOP_WORKSPACE_ROOT: ws });
  fs.mkdirSync(path.join(ws, "shared_reports"));
  assert.ok(c.isReady("research"));
});
t("lists: env uses the platform delimiter; derived lists default to the agents folder; get returns a copy", () => {
  const a = mk("l1"), b = mk("l2"); const c = make(mk("ud11"), { AGENT_DESKTOP_OUTPUT_ROOTS: a + path.delimiter + b, AGENT_DESKTOP_AGENTS_ROOT: a });
  assert.deepStrictEqual(c.get("outputRoots"), [a, b]);
  assert.deepStrictEqual(c.get("documentRoots"), [a]);
  const l = c.get("outputRoots"); l.push("x"); assert.strictEqual(c.get("outputRoots").length, 2);
});
t("memoryKeyPrefix is derived from the agents folder, not typed", () => {
  const c = createAppConfig({ env: { AGENT_DESKTOP_AGENTS_ROOT: "D:\\Some Place\\Stuff" }, pathMod: path.win32 });
  assert.strictEqual(c.get("memoryKeyPrefix"), "D--Some-Place-Stuff-");
});
t("every key has a kind, a label and a derive function", () => { for (const k of Object.keys(KEYS)) { assert.ok(KEYS[k].kind && KEYS[k].label, k); assert.strictEqual(typeof KEYS[k].derive, "function", k); } });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(n - fails + "/" + n + " passed");
process.exit(fails ? 1 : 0);
