// node tests/cfgArgusArea.test.js - the configuration-layer conversion of ARGUS, Memory, Keep working and usage (v1.121.0).
// Everything runs in temp folders (no D:/E: paths from the owner's computer): what the data modules do when set up, when not set up, and that the
// owner's text/regex wording is byte-identical to the old literals when the owner name and task tool are configured (fixtures/keepgoing_legacy.json).
"use strict";
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createAppConfig } = require("../src/appConfig");
const features = require("../src/features");
const featureCtx = require("../src/featureCtx");
const argus = require("../src/argus-data");
const memory = require("../src/memory-data");
const K = require("../src/keepGoing");
const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "keepgoing_legacy.json"), "utf8"));

let n = 0, fails = 0;
const pending = [];
const t = (name, fn) => {
  n++;
  const bad = (e) => { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); };
  try { const r = fn(); if (r && typeof r.then === "function") pending.push(r.then(() => console.log("ok   " + name), bad)); else console.log("ok   " + name); } catch (e) { bad(e); }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adarea-"));
const put = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj)); };
// a computer: a workspace root, a userData folder, an optional config document
function computer(values, extraEnv) {
  const ud = fs.mkdtempSync(path.join(tmp, "ud-"));
  if (values) fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify({ schema: 1, values, features: {} }));
  const env = Object.assign({ PATH: "" }, extraEnv || {});
  const cfg = createAppConfig({ userDataDir: ud, env }); cfg.setRegistry(features);
  const guard = require("../src/testGuard");
  return { cfg, ctx: featureCtx.create({ cfg, guard, env }), ud };
}

// ---------- not set up ----------
t("an unconfigured computer: every area answers needs-setup, nothing throws, nothing is read", () => {
  const c = computer(null);
  assert.deepStrictEqual(c.ctx.argus(), { reports: null, builder: null, python: null });
  assert.strictEqual(c.ctx.memory().statsFile, null);
  assert.deepStrictEqual(argus.getDecisionCount(c.ctx.argus()), 0);
  return Promise.resolve(argus.getArgusData(c.ctx.argus(), { refresh: false })).then((r) => {
    assert.strictEqual(r.reason, "needs-setup"); assert.strictEqual(r.needsSetup, true);
    assert.strictEqual(memory.getMemoryData(c.ctx.memory()).reason, "needs-setup");
    assert.strictEqual(argus.setIdeaDecision(c.ctx.argus(), { week: "2026-W01", agent: "A", id: "x", verdict: "approved" }).reason, "needs-setup");
    assert.strictEqual(c.cfg.get("usageNowFile"), null);
    assert.strictEqual(c.cfg.get("planTier"), null);
    assert.strictEqual(c.ctx.keepGoing().ready, false);
  });
});

// ---------- set up on another root ----------
const ws = path.join(tmp, "Some Workspace");
const reports = path.join(ws, "shared_reports");
put(path.join(reports, "status", "alpha.json"), { agent: "alpha", alerts: [] });
put(path.join(reports, "status", "_decisions.json"), { items: [{ id: 1 }, { id: 2 }], builtBy: "test" });
put(path.join(reports, "recommendations", "2026-W41", "alpha.json"), { items: [{ id: "i1", title: "idea" }] });
put(path.join(reports, "research", "2026-W41", "alpha.json"), { agent: "alpha", findings: [{ title: "a", worthKnowing: true }, { title: "b", worthOwnerKnowing: true }, { title: "c" }] });
const mem = path.join(ws, "stats", "memory_stats.json");
const agentsRoot = path.join(ws, "Agents");
fs.mkdirSync(agentsRoot, { recursive: true });
put(mem, { generated: "2026-10-14T05:00:00", agents: [{ agent: "Prefix-Alpha--claude-session", l1_bytes: 100, l2_bytes: 1, l3_bytes: 2, l3_files: 1, l1_cap: 4096 }] });

t("ARGUS reads the configured shared reports folder (any drive, any name)", () => {
  const c = computer({ workspaceRoot: ws, sharedReports: reports });
  const a = c.ctx.argus();
  assert.strictEqual(a.reports, reports);
  assert.strictEqual(argus.getDecisionCount(a), 2);
  return argus.getArgusData(a, { refresh: false }).then((d) => {
    assert.strictEqual(d.agents.length, 1); assert.strictEqual(d.decisions.length, 2);
    assert.strictEqual(d.recommendations.week, "2026-W41");
    assert.strictEqual(d.research.flagged.length, 2, "both the new worthKnowing and the old worthOwnerKnowing field are accepted");
    const w = argus.setIdeaDecision(a, { week: "2026-W41", agent: "alpha", id: "i1", verdict: "approved" });
    assert.strictEqual(w.ok, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(reports, "recommendations", "2026-W41", "alpha.json"), "utf8")).items[0].decision.verdict, "approved");
    assert.strictEqual(argus.setIdeaDecision(a, { week: "2026-W41", agent: "..\\x", id: "i1", verdict: "approved" }).ok, false);
  });
});
t("the status builder is found only when it exists, and a missing one is not an error screen", () => {
  const b = path.join(ws, "tools", "build_status.py");
  put(b, "print('x')");
  const none = computer({ workspaceRoot: ws, sharedReports: reports });
  assert.strictEqual(none.ctx.argus().builder, null);
  const set = computer({ workspaceRoot: ws, sharedReports: reports, argusBuilder: b });
  assert.strictEqual(set.ctx.argus().builder, b);
  return argus.getArgusData(none.ctx.argus(), { refresh: true }).then((d) => { assert.strictEqual(d.builtOk, false); assert.ok(d.agents.length === 1, "the files are still shown"); });
});
t("a feature turned off in Setup answers needs-setup without reading anything", () => {
  const c = computer({ workspaceRoot: ws, sharedReports: reports });
  c.cfg.setFeature("argus", { enabled: false });
  assert.strictEqual(c.ctx.argus().reports, null);
});
t("Memory: stats file + key prefix from the configuration, baseline optional", () => {
  const c = computer({ agentsRoot, memoryStatsFile: mem, memoryKeyPrefix: "Prefix-" });
  const m = c.ctx.memory();
  assert.strictEqual(m.statsFile, mem); assert.strictEqual(m.keyPrefix, "Prefix-"); assert.strictEqual(m.baselineFile, null);
  const d = memory.getMemoryData(m);
  assert.strictEqual(d.ok, true); assert.strictEqual(Object.keys(d.agents).length, 1);
  assert.strictEqual(c.cfg.feature("memory").state, "ready");
  assert.strictEqual(computer({ agentsRoot }).cfg.feature("memory").state, "needs-setup", "no stats file: needs setup, not an error");
});
t("the memory key prefix is derived from the agents folder the way Claude Code names project folders", () => {
  const c = computer({ agentsRoot });
  assert.strictEqual(c.cfg.get("memoryKeyPrefix"), agentsRoot.replace(/[^A-Za-z0-9]/g, "-") + "-");
});
t("usage and plan: usageNowFile and planTier come from the configuration; an unknown plan stays null", () => {
  const f = path.join(ws, "usage_now.json"); put(f, {});
  const c = computer({ usageNowFile: f, planTier: "max20x" });
  assert.strictEqual(c.cfg.get("usageNowFile"), f); assert.strictEqual(c.cfg.get("planTier"), "max20x");
  assert.strictEqual(c.cfg.feature("usage").state, "ready");
  assert.strictEqual(computer({ planTier: "gold" }).cfg.get("planTier"), null, "an unknown plan is rejected, not guessed");
});
t("the usage worker thread gets the usage file with each request (it cannot read the config itself)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "usageWorker.js"), "utf8");
  assert.ok(/msg\.usageNowFile/.test(src));
  assert.ok(/usageNowFile: testGuard\.usageNowPath\(\)/.test(fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8")));
});

// ---------- Keep working: wording ----------
const OWNER_CTX = { ownerName: "Alex", tasksTool: "C:\\Example\\Workspace\\shared_tools\\tasks\\tasks.py" };
t("with the owner's name and task tool configured the nudge texts are byte-identical to the old literals", () => {
  const T = K.texts(OWNER_CTX);
  assert.strictEqual(T.nudge, legacy.nudge);
  assert.strictEqual(T.nextProject, legacy.nextProject);
  assert.strictEqual(T.nextProjectQuestion, legacy.nextProjectQuestion);
  assert.strictEqual(K.resumePromptText("ARCH", null, true, OWNER_CTX), legacy.resumeRelentless);
  assert.strictEqual(K.resumePromptText("ARCH", { mission: true }, false, OWNER_CTX), legacy.resumeMission);
  assert.strictEqual(K.resumePromptText("ARCH", null, false, OWNER_CTX), legacy.resumePlain);
});
t("with the name configured the heuristics are the old regexes, exactly", () => {
  assert.strictEqual(K.OWN_SRC.wait.split("@OWN@").join("owner"), legacy.wait);
  assert.strictEqual(K.OWN_SRC.others.split("@OWN@").join("owner"), legacy.others);
  assert.strictEqual(K.OWN_SRC.waity.split("@OWN@").join("owner"), legacy.waity);
});
t("a different name and a computer without a task tool: neutral wording, no leftovers of the old literals", () => {
  const T = K.texts({ ownerName: "Dana", tasksTool: null });
  for (const x of [T.nudge, T.nextProject, T.nextProjectQuestion, K.resumePromptText("A", { mission: true }, false, { ownerName: "Dana" })]) {
    assert.ok(!/Alex|ALEX|Dropbox|Claude[ ]stuff/.test(x), x);
    assert.ok(/Dana/.test(x));
  }
  assert.ok(/NEEDS DANA/.test(T.nextProjectQuestion));
  assert.ok(!/python/.test(T.nextProject), "no task tool: no command to run");
  const U = K.texts(null);
  assert.ok(!/Alex|ALEX/.test(U.nextProject) && /the user/.test(U.nudge) && /NEEDS USER/.test(U.nextProject));
  assert.ok(K.NUDGE_TEXT === U.nudge);
});
t("setOwner: the 'waiting for the owner' heuristics follow the configured name (and special characters are safe)", () => {
  try {
    K.setOwner("Dana");
    assert.strictEqual(K.classify("I can go on once Dana approves. Waiting for Dana's approval to push.").verdict, "blocked");
    K.setOwner("O.Brien (x)");
    assert.doesNotThrow(() => K.classify("Waiting for O.Brien (x)'s ok."));
    K.setOwner(null);
    assert.strictEqual(K.classify("The next step belongs to the user: you should approve this.").verdict, "blocked");
  } finally { K.setOwner(null); }
});

// ---------- hard-coded wording left in the converted files ----------
t("wake note: the owner's name comes from the configuration (neutral when none)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "wakeAgent.js"), "utf8");
  assert.ok(/NOT typed by \$\{owner\}/.test(src));
});

Promise.all(pending).then(() => {
  console.log(n - fails + "/" + n + " passed");
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp cleanup is best effort */ }
  process.exit(fails ? 1 : 0);
});
