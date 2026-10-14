// node tests/namesFinal.test.js - the "names final" round (v1.121.0): nothing user-visible or sent to a model names a person; wording comes from configuration.
// Covers predict's system prompt, the dep-doctor message, the research week summary, the tools group heading, ARGUS role wording,
// the Claude Code card (calm), the research needs-setup answer + F1 (test mode honours an explicit research folder) and the health sample being test-only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const ROOT = path.join(__dirname, "..");
let n = 0, fails = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).split("\n").map((l) => { const m = /(^|[^:])\/\/(?!\/)/.exec(l); return m ? l.slice(0, m.index + m[1].length) : l; }).join("\n");

t("C1 predict: the system prompt names nobody by default; a configured owner name is used when passed", () => {
  const P = require("../src/predict");
  assert.ok(!/Alex/.test(P.SYSTEM_PROMPT) && /busy user will type/.test(P.SYSTEM_PROMPT) && /written as the user/.test(P.SYSTEM_PROMPT));
  const a = P.buildContext({ assistantText: "Shall I go ahead with the plan?", userMessages: ["ok"] });
  assert.strictEqual(a.system, P.SYSTEM_PROMPT);
  const b = P.buildContext({ assistantText: "Shall I go ahead with the plan?", userMessages: ["ok"], ownerName: "Dana" });
  assert.ok(/busy user \(Dana\) will type/.test(b.system) && b.system.replace("(Dana) ", "") === P.SYSTEM_PROMPT);
});
t("C2 dep-doctor: the refusal message is neutral and still says full reinstall", () => {
  const src = code(read("src/dep-doctor.js"));
  assert.ok(!/Ask Alex/.test(src) && /Ask whoever maintains your copy of Agent Desktop/.test(src) && /full reinstall/.test(src));
});
t("C3 research summary: 'worth <name> knowing' uses the configured name, neutral without; the stored field is still read", () => {
  const S = require("../src/research/summary");
  const snap = { week: "2026-W41", top5: { state: "none", picks: [] }, coo: null, digests: [{ agent: "A", label: "A", state: "ok", findings: [{ tier: "high", worth: true, idea: false, title: "t", sources: [] }] }] };
  const neutral = S.buildSummary(snap), named = S.buildSummary(snap, { ownerName: "Dana" });
  assert.ok(/worth the user knowing/.test(neutral) && /Worth the user knowing/.test(neutral) && !/Alex/.test(neutral));
  assert.ok(/worth Dana knowing/.test(named) && /Worth Dana knowing/.test(named));
  assert.ok(/getWorthOwnerKnowing/.test(read("src/research/service.js")) && /worthOwnerKnowing/.test(read("src/legacyKeys.js")), "the finding flag is read through the legacy-key helper (old and new field name)");
});
t("C4 tools heading: neutral 'Tools' by default, the configured toolsBasketLabel wins (the basket id stays acmeco)", () => {
  const M = require("../src/tools/model"), S = require("../src/tools/schema");
  assert.strictEqual(S.BASKET_LABELS.acmeco, "Tools");
  assert.deepStrictEqual(M.groupCards([]).map((g) => g.label), ["Tools", "Other tools"]);
  assert.deepStrictEqual(M.groupCards([], { acmeco: "Acmeco tools" }).map((g) => g.label), ["Acmeco tools", "Other tools"]);
  assert.deepStrictEqual(M.groupCards([], { acmeco: "" }).map((g) => g.label), ["Tools", "Other tools"]);
});
t("C4 main.js: no code (strings, logs) names a person", () => {
  assert.ok(!/Alex/.test(code(read("src/main.js"))));
});
t("C4 ARGUS: role wording comes from the configured roles (leadWord / optWord), no literal 'the COO' / 'Optimization agent' in code", () => {
  const a = code(read("src/renderer/argus.js"));
  assert.ok(!/\bthe COO\b|\bThe COO\b|The Optimization agent|by the Optimization agent/.test(a), "literal role names left in argus.js");
  assert.ok(/leadWord\(\)/.test(a) && /optWord\(\)/.test(a));
  const m = /const shortAgent[^\n]*\n[\s\S]*?const optWord = [^\n]*\n/.exec(read("src/renderer/argus.js"));
  assert.ok(m, "helper block found");
  const body = m[0].replace(/const roleAgent[\s\S]*/, "");
  const roleMatch = (p, f) => { p = String(p || "").toLowerCase(); f = String(f || "").toLowerCase(); if (!p || !f) return false; return p.slice(-1) === "*" ? f.indexOf(p.slice(0, -1)) === 0 : f === p; };
  const run = (v, folders) => {
    const R = (r) => v["role" + r[0].toUpperCase() + r.slice(1)] || null;
    const Cfg = () => ({
      role: R,
      shortName: (f) => { const p = String(v.short || "").split(";").map((x) => x.split("=")).find((x) => x[1] && roleMatch(x[0], f)); return p ? p[1] : null; },
      roleFolder: (r, l) => (R(r) ? (l || []).find((f) => roleMatch(R(r), f)) || null : null),
    });
    return new Function("Cfg", "data", body + "; return { leadWord, leadAgent, optWord };")(Cfg, { agents: folders.map((x) => ({ agent: x })) });
  };
  const owner = run({ roleCoo: "COO Agent", roleOptimization: "System Optimization*", short: "System Optimization*=Optimization" }, ["COO Agent", "System Optimization & Maintenance Agent"]);
  assert.strictEqual(owner.leadWord(), "COO"); assert.strictEqual(owner.leadAgent(), "COO agent"); assert.strictEqual(owner.optWord(), "Optimization");
  const none = run({}, []);
  assert.strictEqual(none.leadWord(), "lead agent"); assert.strictEqual(none.leadAgent(), "lead agent"); assert.strictEqual(none.optWord(), "optimization");
});
t("Claude Code 'not installed' card is calm: amber/neutral class, no red", () => {
  assert.ok(/classList\.toggle\("calm", result\.reason === "not-installed"\)/.test(read("src/renderer/renderer.js")));
  const css = read("src/renderer/styles.css");
  const block = css.slice(css.indexOf("#claude-cli-warning.calm {"), css.indexOf("#interfering-service-warning .dismiss-btn,"));
  assert.ok(block.length > 50 && !/220, 38, 38|#dc2626|#b91c1c/i.test(block));
});
t("Library and Research show the shared needs-setup card (source wiring)", () => {
  assert.ok(/NeedsSetup\.card\("library"\)/.test(read("src/renderer/library.js")) && /libraryReady/.test(read("src/preload.js")) && /"library-ready"/.test(read("src/main.js")));
  assert.ok(/NeedsSetup\.card\("research"\)/.test(read("src/renderer/research.js")));
});
t("health pane sample is test-only and lazy (nothing reads tests/ at load or in live mode)", () => {
  const PF = require("../src/health/pane-feed");
  assert.strictEqual(typeof PF.sampleFile, "function");
  assert.strictEqual(PF.resolveFeedPath({ testMode: false, parent: null, env: {} }).file, null);
  assert.strictEqual(PF.readFeed({ testMode: true, env: {}, sample: path.join(os.tmpdir(), "no-such-sample-" + process.pid + ".json") }).state, "missing");
});

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adnames-"));
  const handlers = new Map();
  const win = { webContents: { mainFrame: {} }, isDestroyed: () => false };
  const ev = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const reports = path.join(tmp, "my_reports");
  fs.mkdirSync(path.join(reports, "research"), { recursive: true });
  const env = { AGENT_DESKTOP_TEST_MODE: "1", AGENT_DESKTOP_ROOT: tmp };
  const mk = (e) => { handlers.clear(); require("../src/research/main-research").init({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, getMainWindow: () => win, workspaceRoot: tmp, userData: tmp, testMode: true, env: e, log: () => {} }); };
  const call = (c, a) => handlers.get(c)(ev, a);
  n++;
  try {
    mk(env);
    const r = await call("research-load", {});
    assert.strictEqual(r.needsSetup, true, "no research folder given: needs-setup");
    assert.deepStrictEqual(await call("research-badge"), { ok: true, count: 0 });
    mk(Object.assign({ AGENT_DESKTOP_RESEARCH_DIR: path.join(reports, "research") }, env));
    const r2 = await call("research-load", {});
    assert.ok(r2.needsSetup !== true, "a research folder given on purpose counts in test mode");
    console.log("ok   F1 research: needs-setup without an explicit folder; with one it loads");
  } catch (e) { fails++; console.log("FAIL F1 research\n     " + (e && e.stack || e)); }
  console.log((n - fails) + "/" + n + " passed");
  process.exit(fails ? 1 : 0);
})();
