// node tests/cfgRoles.test.js - the cast of agent roles (v1.121.0): roleCoo / roleSecurity / roleOptimization / roleSeo, argusJobPrefixes, argusShortNames.
// Three computers: nothing configured, the original owner's roster, and a neutral two-agent roster with other folder names. Everything in temp folders.
"use strict";
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const { createAppConfig, KEYS } = require("../src/appConfig");
const features = require("../src/features");
const ROOT = path.join(__dirname, "..");
let n = 0, fails = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adroles-"));

const OWNER = { roleCoo: "COO Agent", roleSecurity: "Security", roleOptimization: "System Optimization*", roleSeo: "SEO Agent",
  argusJobPrefixes: "SEC_=security;OPT_=optimization;COO_=coo", argusShortNames: "System Optimization*=Optimization;Master_Context=Acmeco context" };
const NEUTRAL = { roleCoo: "Chief", roleSecurity: "Guard Dog", argusJobPrefixes: "GD_=security;CH_=coo", argusShortNames: "Guard Dog=Guard" };

function computer(values) {
  const ud = fs.mkdtempSync(path.join(tmp, "ud-"));
  if (values) fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify({ schema: 1, values, features: {} }));
  const c = createAppConfig({ userDataDir: ud, env: {} }); c.setRegistry(features); return c;
}
// the renderer's AppCfg, loaded exactly as the page loads it, fed by a fake getAll()
function appCfg(cfg) {
  const values = {}; for (const k of cfg.allKeys()) values[k] = cfg.get(k);
  const win = { api: { config: { getAll: () => Promise.resolve({ ok: true, values }) } } };
  const ctx = { window: win, Promise }; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/renderer/app-cfg.js"), "utf8"), ctx);
  return win.AppCfg.ready.then(() => win.AppCfg);
}
const ASYNC = [];
const ta = (name, fn) => { n++; ASYNC.push(fn().then(() => console.log("ok   " + name), (e) => { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); })); };

t("the six keys exist, are text, and default to null (nothing is assumed)", () => {
  const c = computer(null);
  for (const k of Object.keys(OWNER)) { assert.strictEqual(KEYS[k].kind, "text", k); assert.strictEqual(c.get(k), null, k); }
});
t("the owner's roster reads back exactly (parity values)", () => {
  const c = computer(OWNER);
  for (const [k, v] of Object.entries(OWNER)) assert.strictEqual(c.get(k), v, k);
});
t("ARGUS is wired and offers the role steps as optional", () => {
  const f = features.get("argus"); assert.strictEqual(f.wired, true);
  for (const k of Object.keys(OWNER)) { const s = f.steps.find((x) => x.key === k); assert.ok(s && s.optional, k); }
  assert.ok(!f.requires.some((k) => /^role/.test(k)), "roles never block ARGUS");
  assert.strictEqual(computer(null).feature("argus").state, "needs-setup");
});
ta("renderer, nothing configured: no role, no job prefix, no short name", async () => {
  const A = await appCfg(computer(null));
  for (const r of ["coo", "security", "optimization", "seo"]) { assert.strictEqual(A.role(r), null); assert.strictEqual(A.isRole(r, "COO Agent"), false); assert.strictEqual(A.roleFolder(r, ["COO Agent", "Security"]), null); }
  assert.strictEqual(A.jobRole("SEC_Daily"), null); assert.strictEqual(A.shortName("System Optimization & Maintenance Agent"), null);
});
ta("renderer, owner's roster: same matches as the old literals", async () => {
  const A = await appCfg(computer(OWNER));
  const folders = ["COO Agent", "Security", "System Optimization & Maintenance Agent", "SEO Agent", "Marketing Agent"];
  assert.strictEqual(A.roleFolder("coo", folders), "COO Agent"); assert.strictEqual(A.roleFolder("security", folders), "Security");
  assert.strictEqual(A.roleFolder("optimization", folders), "System Optimization & Maintenance Agent"); assert.strictEqual(A.roleFolder("seo", folders), "SEO Agent");
  assert.strictEqual(A.isRole("security", "Security Extra"), false, "an exact role is exact");
  assert.strictEqual(A.isRole("optimization", "System Optimization"), true);
  assert.strictEqual(A.jobRole("SEC_DailyReport"), "security"); assert.strictEqual(A.jobRole("opt_weekly"), "optimization"); assert.strictEqual(A.jobRole("COO_brief"), "coo"); assert.strictEqual(A.jobRole("WEEKLY_Recs_X"), null);
  assert.strictEqual(A.shortName("System Optimization & Maintenance Agent"), "Optimization"); assert.strictEqual(A.shortName("Master_Context"), "Acmeco context"); assert.strictEqual(A.shortName("Marketing Agent"), null);
});
ta("renderer, neutral two-agent roster: only the configured roles resolve, other folder names work", async () => {
  const A = await appCfg(computer(NEUTRAL));
  const folders = ["Chief", "Guard Dog", "Helper"];
  assert.strictEqual(A.roleFolder("coo", folders), "Chief"); assert.strictEqual(A.roleFolder("security", folders), "Guard Dog");
  assert.strictEqual(A.roleFolder("optimization", folders), null); assert.strictEqual(A.roleFolder("seo", folders), null);
  assert.strictEqual(A.jobRole("GD_scan"), "security"); assert.strictEqual(A.jobRole("SEC_scan"), null);
  assert.strictEqual(A.shortName("Guard Dog"), "Guard");
});
t("wake caller folders come from the roles; exact names only; unset = no caller accepted", () => {
  const WM = require("../src/wakeAgentMain");
  const keep = { c: process.env.AGENT_DESKTOP_ROLE_COO, s: process.env.AGENT_DESKTOP_ROLE_SECURITY };
  try {
    delete process.env.AGENT_DESKTOP_ROLE_COO; delete process.env.AGENT_DESKTOP_ROLE_SECURITY;
    assert.deepStrictEqual(WM.callerFolders(), { coo: null, security: null });
    assert.strictEqual(WM.callerForSessionCwd("C:\\ws", "C:\\ws\\COO Agent\\.claude-session"), null);
    process.env.AGENT_DESKTOP_ROLE_COO = "Chief"; process.env.AGENT_DESKTOP_ROLE_SECURITY = "Guard Dog*"; // a prefix role is not a precise caller folder
    assert.deepStrictEqual(WM.callerFolders(), { coo: "Chief", security: null });
    assert.strictEqual(WM.callerForSessionCwd("C:\\ws", "C:\\ws\\Chief\\.claude-session"), "coo");
    assert.strictEqual(WM.callerForSessionCwd("C:\\ws", "C:\\ws\\COO Agent\\.claude-session"), null);
    assert.strictEqual(WM.callerForSessionCwd("C:\\ws", "C:\\ws\\Guard Dog\\.claude-session"), null);
  } finally { for (const [k, v] of [["AGENT_DESKTOP_ROLE_COO", keep.c], ["AGENT_DESKTOP_ROLE_SECURITY", keep.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});
t("the optimization agent's notes-file alias follows the role, not a literal folder name", () => {
  const W = require("../src/research/write");
  const k = process.env.AGENT_DESKTOP_ROLE_OPTIMIZATION;
  try {
    delete process.env.AGENT_DESKTOP_ROLE_OPTIMIZATION;
    assert.strictEqual(W.pendingSlugs("System Optimization & Maintenance Agent")[0], "system_optimization_maintenance_agent");
    process.env.AGENT_DESKTOP_ROLE_OPTIMIZATION = "System Optimization*";
    assert.strictEqual(W.pendingSlugs("System Optimization & Maintenance Agent")[0], "optimization_agent");
    process.env.AGENT_DESKTOP_ROLE_OPTIMIZATION = "Tidy Bot";
    assert.strictEqual(W.pendingSlugs("Tidy Bot")[0], "optimization_agent"); assert.strictEqual(W.pendingSlugs("Chief Agent")[0], "chief_agent");
  } finally { if (k === undefined) delete process.env.AGENT_DESKTOP_ROLE_OPTIMIZATION; else process.env.AGENT_DESKTOP_ROLE_OPTIMIZATION = k; }
});
t("argus.js has no agent folder literal in its code", () => {
  const code = fs.readFileSync(path.join(ROOT, "src/renderer/argus.js"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).map((l) => l.replace(/\s\/\/ [^\r\n]*/, "")).join("\n");
  for (const lit of ['"COO Agent"', '"Security"', '"SEO Agent"', '"System Optimization', "Master_Context", "SEC_", "OPT_"]) assert.ok(code.indexOf(lit) < 0, lit);
});

Promise.all(ASYNC).then(() => { fs.rmSync(tmp, { recursive: true, force: true }); console.log(n - fails + "/" + n + " passed"); process.exit(fails ? 1 : 0); });
