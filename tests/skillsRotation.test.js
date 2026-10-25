// node tests/skillsRotation.test.js - v1.141.0: editing WHO looks for skills/plugins this week (src/skills/rotationWrite.js, IPC skills-rotation-set)
// and the hidden-agent rule for "Discuss": a hidden agent never gets a live delivery, only its pending notes. Temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const RW = require("../src/skills/rotationWrite");
const W = require("../src/research/write");
let n = 0, fails = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "adrot-"));
const ROT = { week: "2026-W43", agents: ["Alpha", "Beta"], reason: "R", schedule: "Thursday ~17:00 Israel", setAt: "2026-10-20", score_rule: "S", extra: { keep: 1 } };
const KNOWN = [{ folderName: "Alpha", displayName: "Alpha" }, { folderName: "Beta", displayName: "Beta" }, { folderName: "Gamma Agent", displayName: "Gamma" }, { folderName: "Hidden One", displayName: "Hidden One", hidden: true }];
const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();
function setup(content) { const d = tmpDir(), f = path.join(d, "skills_plugins_rotation.json"); fs.writeFileSync(f, content === undefined ? "﻿" + JSON.stringify(ROT) : content); return { d, f, read: () => JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")) }; }

t("saves the new list: only agents and setAt change, every other field is kept; no BOM, no temp file left", async () => {
  const s = setup();
  const r = await RW.setAgents({ file: s.f, agents: ["Alpha", "Gamma Agent"], expected: ["Alpha", "Beta"], known: KNOWN, now: NOW });
  assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.agents, ["Alpha", "Gamma Agent"]); assert.deepStrictEqual(r.previous, ["Alpha", "Beta"]); assert.strictEqual(r.setAt, "2026-10-24");
  const j = s.read();
  assert.deepStrictEqual(j.agents, ["Alpha", "Gamma Agent"]); assert.strictEqual(j.setAt, "2026-10-24");
  for (const k of ["week", "reason", "schedule", "score_rule"]) assert.strictEqual(j[k], ROT[k]);
  assert.deepStrictEqual(j.extra, { keep: 1 });
  assert.notStrictEqual(fs.readFileSync(s.f, "utf8").charCodeAt(0), 0xFEFF);
  assert.deepStrictEqual(fs.readdirSync(s.d).filter((x) => /\.tmp$/.test(x)), []);
});
t("one backup per day: made before the first change, never overwritten by the second", async () => {
  const s = setup();
  await RW.setAgents({ file: s.f, agents: ["Alpha"], known: KNOWN, now: NOW });
  const bak = s.f + ".bak_2026-10-24";
  assert.ok(fs.existsSync(bak)); assert.deepStrictEqual(JSON.parse(fs.readFileSync(bak, "utf8").replace(/^﻿/, "")).agents, ["Alpha", "Beta"]);
  await RW.setAgents({ file: s.f, agents: ["Beta"], known: KNOWN, now: NOW + 1000 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(bak, "utf8").replace(/^﻿/, "")).agents, ["Alpha", "Beta"]);
  assert.deepStrictEqual(fs.readdirSync(s.d).filter((x) => /\.bak_/.test(x)).length, 1);
});
t("unknown agent is refused and nothing is written", async () => {
  const s = setup(); const before = fs.readFileSync(s.f, "utf8");
  const r = await RW.setAgents({ file: s.f, agents: ["Alpha", "Nobody"], known: KNOWN, now: NOW });
  assert.strictEqual(r.ok, false); assert.match(r.reason, /"Nobody" is not one of your agents/);
  assert.strictEqual(fs.readFileSync(s.f, "utf8"), before); assert.ok(!fs.existsSync(s.f + ".bak_2026-10-24"));
});
t("empty list is refused (at least one agent each week)", async () => {
  const s = setup();
  const r = await RW.setAgents({ file: s.f, agents: [], known: KNOWN, now: NOW });
  assert.strictEqual(r.ok, false); assert.match(r.reason, /At least one agent/); assert.deepStrictEqual(s.read().agents, ["Alpha", "Beta"]);
});
t("path characters, bad types and over-long names are refused", async () => {
  const s = setup();
  for (const bad of [["..\\Alpha"], ["a/b"], [42], ["x".repeat(121)], "Alpha"]) assert.strictEqual((await RW.setAgents({ file: s.f, agents: bad, known: KNOWN, now: NOW })).ok, false);
});
t("a display name maps to the folder name (the runner needs folders); duplicates dropped; case-insensitive", async () => {
  const s = setup();
  const r = await RW.setAgents({ file: s.f, agents: ["gamma", "Gamma Agent", "ALPHA"], known: KNOWN, now: NOW });
  assert.deepStrictEqual(r.agents, ["Gamma Agent", "Alpha"]);
});
t("hidden agents are valid rotation agents", async () => {
  const s = setup();
  assert.deepStrictEqual((await RW.setAgents({ file: s.f, agents: ["Hidden One"], known: KNOWN, now: NOW })).agents, ["Hidden One"]);
});
t("names already in the file stay allowed even when not in the agent list (a stale name never blocks a save)", async () => {
  const s = setup(JSON.stringify(Object.assign({}, ROT, { agents: ["Alpha", "Old Agent"] })));
  assert.deepStrictEqual((await RW.setAgents({ file: s.f, agents: ["Old Agent"], known: KNOWN, now: NOW })).agents, ["Old Agent"]);
});
t("changed elsewhere since the tab opened (expected differs): refused, nothing written", async () => {
  const s = setup();
  const r = await RW.setAgents({ file: s.f, agents: ["Alpha"], expected: ["Alpha", "Beta", "Gamma Agent"], known: KNOWN, now: NOW });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stale, true); assert.deepStrictEqual(s.read().agents, ["Alpha", "Beta"]);
});
t("missing or broken file: plain refusal", async () => {
  const d = tmpDir();
  assert.match((await RW.setAgents({ file: path.join(d, "none.json"), agents: ["Alpha"], known: KNOWN })).reason, /not there yet/);
  const s = setup("{not json"); assert.match((await RW.setAgents({ file: s.f, agents: ["Alpha"], known: KNOWN })).reason, /could not be read/);
  assert.strictEqual((await RW.setAgents({ file: "", agents: ["Alpha"] })).ok, false);
});
t("undo = saving the previous list with the current one as expected", async () => {
  const s = setup();
  const a = await RW.setAgents({ file: s.f, agents: ["Gamma Agent"], expected: ["Alpha", "Beta"], known: KNOWN, now: NOW });
  const b = await RW.setAgents({ file: s.f, agents: a.previous, expected: a.agents, known: KNOWN, now: NOW });
  assert.strictEqual(b.ok, true); assert.deepStrictEqual(s.read().agents, ["Alpha", "Beta"]);
});
t("the write module is async (no sync fs) and names no agent", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "skills", "rotationWrite.js"), "utf8");
  assert.ok(!/Sync\(/.test(src)); assert.ok(!/Security|COO|Software Engineering/.test(src));
});
t("wiring: IPC skills-rotation-set uses the research folder + the app's own agent list; preload; renderer has x, Add agent, Undo; reason paragraph gone", () => {
  const rd = (p) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");
  const mr = rd("research/main-research.js");
  assert.ok(/handle\("skills-rotation-set"/.test(mr)); assert.ok(/skills_plugins_rotation\.json/.test(mr)); assert.ok(/known: knownAgents\(\)/.test(mr));
  assert.ok(/listAgents: \(\) => listAgents\(\{ noAvatar: true \}\)/.test(rd("main.js")));
  assert.ok(/skillsSetRotation: \(agents, expected\) => ipcRenderer\.invoke\("skills-rotation-set"/.test(rd("preload.js")));
  const r = rd("renderer/skills.js");
  assert.ok(/sk-agentx/.test(r)); assert.ok(/\+ Add agent\.\.\./.test(r)); assert.ok(/"Undo"/.test(r)); assert.ok(/api\.skillsSetRotation\(agents, before\)/.test(r));
  assert.ok(!/Why these agents/.test(r)); assert.ok(!/Schedule as written/.test(r));
});

// ---- hidden agents: Discuss never delivers into the agent's Agent Desktop session
function writer(opts) {
  const root = tmpDir(), rd = path.join(root, "shared_reports", "research");
  fs.mkdirSync(rd, { recursive: true }); for (const a of ["Hidden One", "Alpha"]) fs.mkdirSync(path.join(root, a));
  const calls = [];
  const w = W.createWriter({
    owner: "Alex", researchDir: rd, root, now: () => NOW,
    findRef: async () => ({ title: "Recommendation: T" }),
    resolveAgent: (name) => { const p = path.join(root, name); return fs.existsSync(p) ? p : null; },
    isRunning: () => true,
    isHidden: opts.isHidden,
    deliver: async (p, text) => { calls.push({ p, text }); return { delivered: true, via: "channel" }; },
    classify: require("../src/daily/decisions-main").classifyDelivery,
  });
  return { root, w, calls };
}
t("hidden agent: running or not, the delivery path is never called; the pending-notes file gets the message; result says hidden", async () => {
  const x = writer({ isHidden: (f) => f === "Hidden One" });
  const r = await x.w.write({ week: "2026-W43", agent: "Hidden One", findingId: "rec:abc", text: "About T: hello" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.delivery, "pending"); assert.strictEqual(r.hidden, true);
  assert.strictEqual(x.calls.length, 0);
  const note = fs.readFileSync(path.join(x.root, r.file), "utf8");
  assert.ok(/hello/.test(note)); assert.ok(/outside Agent Desktop/.test(note));
});
t("non-hidden agent behaves as before (live delivery when running)", async () => {
  const x = writer({ isHidden: (f) => f === "Hidden One" });
  const r = await x.w.write({ week: "2026-W43", agent: "Alpha", findingId: "rec:abc", text: "About T: hi" });
  assert.strictEqual(r.ok, true); assert.notStrictEqual(r.hidden, true); assert.strictEqual(x.calls.length, 1);
});
t("main-research gives the writer an isHidden from the hiddenAgents setting; the tab and My Recommendations say 'reads it in the Claude desktop app'", () => {
  const rd = (p) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");
  assert.ok(/isHidden: require\("\.\.\/hiddenAgents"\)\.makeIsHidden\(\{ listAgents \}\)/.test(rd("research/main-research.js")));
  assert.ok(!/AGENT_DESKTOP_HIDDEN_AGENTS/.test(rd("research/main-research.js")));   // no second reader of the setting
  assert.ok(/reads it in the Claude desktop app, not here/.test(rd("renderer/skills.js"))); assert.ok(/reads it in the Claude desktop app, not here/.test(rd("renderer/recs.js")));
});

// ---- SE review (c): one shared reader for the setting; display names hide too; the env override is honoured by BOTH paths
const H = require("../src/hiddenAgents");
const { createAppConfig } = require("../src/appConfig");
const cfgWith = (env, fileValue) => { const d = tmpDir(); const c = createAppConfig({ userDataDir: d, env: env || {} }); if (fileValue) c.set("hiddenAgents", fileValue); return c; };
const AGENTS = [{ folderName: "Hidden One", displayName: "The Watcher" }, { folderName: "Alpha", displayName: "Alpha" }];
t("configured(): app-config value, and the AGENT_DESKTOP_HIDDEN_AGENTS env override wins", () => {
  assert.strictEqual(H.configured(cfgWith({}, "Alpha")), "Alpha");
  assert.strictEqual(H.configured(cfgWith({ AGENT_DESKTOP_HIDDEN_AGENTS: "The Watcher" }, "Alpha")), "The Watcher");
  assert.strictEqual(H.configured(cfgWith({}, null)), null);
  assert.strictEqual(H.configured({ get: () => { throw new Error("x"); } }), null);
});
t("a DISPLAY name in the setting hides the agent for the research writer (folder looked up in the agent list)", () => {
  const isHidden = H.makeIsHidden({ listAgents: () => AGENTS, cfg: cfgWith({}, "The Watcher") });
  assert.strictEqual(isHidden("Hidden One"), true); assert.strictEqual(isHidden("hidden one"), true); assert.strictEqual(isHidden("Alpha"), false);
  assert.strictEqual(H.makeIsHidden({ listAgents: () => { throw new Error("x"); }, cfg: cfgWith({}, "Hidden One") })("Hidden One"), true);   // folder still matches
});
t("env override is honoured by both paths: list marking (mark + configured) and the writer (makeIsHidden)", () => {
  const c = cfgWith({ AGENT_DESKTOP_HIDDEN_AGENTS: "The Watcher" }, null);
  assert.deepStrictEqual(H.mark(AGENTS, H.configured(c)).map((a) => a.hidden), [true, false]);
  assert.strictEqual(H.makeIsHidden({ listAgents: () => AGENTS, cfg: c })("Hidden One"), true);
  const m = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.ok(/const hiddenAgentsValue = \(\) => require\("\.\/hiddenAgents"\)\.configured\(\)/.test(m));
});
t("display-name entry: the writer routes to the pending note and never calls delivery", async () => {
  const isHidden = H.makeIsHidden({ listAgents: () => AGENTS, cfg: cfgWith({}, "The Watcher") });
  const x = writer({ isHidden });
  const r = await x.w.write({ week: "2026-W43", agent: "Hidden One", findingId: "rec:abc", text: "About T: by display name" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.hidden, true); assert.strictEqual(x.calls.length, 0);
  assert.ok(/by display name/.test(fs.readFileSync(path.join(x.root, r.file), "utf8")));
});
t("rename is retried once after a Dropbox-style lock (EPERM), and a second failure is reported, not thrown", async () => {
  const s = setup(); let n1 = 0;
  const flaky = async (a, b) => { n1++; if (n1 === 1) throw Object.assign(new Error("locked"), { code: "EPERM" }); return require("fs").promises.rename(a, b); };
  const r = await RW.setAgents({ file: s.f, agents: ["Alpha"], known: KNOWN, now: NOW, rename: flaky, retryMs: 5 });
  assert.strictEqual(r.ok, true); assert.strictEqual(n1, 2); assert.deepStrictEqual(s.read().agents, ["Alpha"]);
  const s2 = setup(); let n2 = 0;
  const r2 = await RW.setAgents({ file: s2.f, agents: ["Alpha"], known: KNOWN, now: NOW, rename: async () => { n2++; throw Object.assign(new Error("locked"), { code: "EBUSY" }); }, retryMs: 5 });
  assert.strictEqual(r2.ok, false); assert.strictEqual(n2, 2); assert.deepStrictEqual(s2.read().agents, ["Alpha", "Beta"]);
  assert.deepStrictEqual(fs.readdirSync(s2.d).filter((x) => /\.tmp$/.test(x)), []);
});
(async () => {
  for (const [name, fn] of queue) { n++; try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + ": " + e.message); } }
  console.log(n - fails + "/" + n + " passed"); process.exit(fails ? 1 : 0);
})();
