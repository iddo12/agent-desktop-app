// node tests/areaHealth.test.js - My Health on the configuration layer (v1.121.0): the health folder comes from the configuration, live mode with none
// is refused, a folder made by Setup gets its vault + marker once, and every existing refusal (synced, outside, redirected, marker) still holds. Temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const roots = require("../src/health/roots");
const SV = require("../src/health/service");
const PF = require("../src/health/pane-feed");
let n = 0, fails = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "adhealth-")));
const mk = (...p) => { const d = path.join(base, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

t("no built-in health folder or vault constants are exported", () => {
  for (const k of ["HEALTH_PARENT", "DEFAULT_VAULT", "DEFAULT_ROOT"]) assert.strictEqual(roots[k], undefined, k);
  assert.strictEqual(SV.DEFAULT_ROOT, undefined); assert.strictEqual(PF.LIVE_FEED, undefined);
});

t("live mode with no configured folder is refused with code noparent (also with an empty or blank value)", () => {
  for (const p of [undefined, null, "", "   ", () => null]) assert.strictEqual(roots.resolveRoot({ env: {}, testMode: false, parent: p }).code, "noparent");
  assert.strictEqual(roots.resolveRoot({ env: { AGENT_DESKTOP_HEALTH_ROOT: mk("x") }, testMode: false }).code, "noparent");
});

t("the folder may be a function (read on every call); the vault is <folder>\\vault and the default root <vault>\\extracted", () => {
  const parent = mk("p1"); let cur = null;
  assert.strictEqual(roots.resolveRoot({ env: {}, testMode: false, parent: () => cur }).code, "noparent");
  cur = parent;
  const r = roots.resolveRoot({ env: {}, testMode: false, parent: () => cur });
  assert.ok(r.ok && r.isDefault && r.root === path.join(parent, "vault", "extracted") && r.vault === path.join(parent, "vault") && r.parent === parent, JSON.stringify(r));
});

t("Setup made the folder, the vault is not there: the service makes <folder>\\vault and its marker once, and works", () => {
  const parent = mk("p2");
  const svc = SV.createService({ env: {}, testMode: false, userData: mk("ud2"), parent });
  assert.ok(fs.existsSync(path.join(parent, "vault", ".health-root")), "marker written");
  assert.notStrictEqual(svc.root, null);
  assert.ok(svc.load().ok !== false);
});

t("the folder itself is missing: no vault is invented (state no-vault)", () => {
  const parent = path.join(base, "never-made");
  const svc = SV.createService({ env: {}, testMode: false, userData: mk("ud3"), parent });
  const r = svc.load(); assert.strictEqual(r.ok, false); assert.strictEqual(r.state, "no-vault");
  assert.ok(!fs.existsSync(parent));
});

t("an existing vault is never touched (no marker added where Security has not put one) and still needs its marker", () => {
  const parent = mk("p4"), vault = mk("p4", "vault"); mk("p4", "vault", "extracted");
  assert.strictEqual(roots.resolveRoot({ env: {}, testMode: false, parent }).code, "marker");
  SV.createService({ env: {}, testMode: false, userData: mk("ud4"), parent });
  assert.ok(!fs.existsSync(path.join(vault, ".health-root")), "an existing vault is left alone");
});

t("refusals still hold with a configured folder: outside, synced, relative, UNC, redirected", () => {
  const parent = mk("p5"), vault = mk("p5", "vault"); mk("p5", "vault", "extracted"); fs.writeFileSync(path.join(vault, ".health-root"), "");
  const o = (want) => ({ env: { AGENT_DESKTOP_HEALTH_ROOT: want }, testMode: false, parent });
  assert.strictEqual(roots.resolveRoot(o(mk("elsewhere"))).code, "outside");
  assert.strictEqual(roots.resolveRoot(o(path.join(base, "Dropbox", "h"))).code, "synced");
  assert.strictEqual(roots.resolveRoot(o("relative\\h")).code, "form");
  assert.strictEqual(roots.resolveRoot(o("\\\\nas\\share\\h")).code, "form");
  assert.ok(roots.resolveRoot({ env: {}, testMode: false, parent }).ok);
});

t("test mode still never uses the configured vault", () => {
  const parent = mk("p6"), vault = mk("p6", "vault");
  assert.strictEqual(roots.resolveRoot({ env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(vault, "extracted") }, testMode: true, parent }).code, "vault");
  const d = roots.resolveRoot({ env: {}, testMode: true, userData: mk("ud6"), parent });
  assert.ok(d.ok && d.root.indexOf("health-test") > 0);
});

t("the pane feed is <folder>\\vault\\pane_feed\\health_pane.json, refused with no folder", () => {
  const parent = mk("p7");
  assert.strictEqual(PF.resolveFeedPath({ testMode: false, env: {}, parent }).file, path.join(parent, "vault", "pane_feed", "health_pane.json"));
  assert.strictEqual(PF.resolveFeedPath({ testMode: false, env: {} }).code, "noparent");
  assert.strictEqual(PF.readFeed({ testMode: false, env: {} }).state, "blocked");
});

console.log((n - fails) + "/" + n + " passed");
process.exit(fails ? 1 : 0);
