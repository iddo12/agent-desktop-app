// Run: node tests/duplicateCopies.test.js - v1.135.0 duplicate live copies: transcript inspection, the manual close rules (keep one, busy needs
// confirmation, never the last copy), the automatic old-idle-copy rule after a planned handoff resume, config, and the dialog's pure helpers.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const DC = require("../src/duplicateCopies");

let n = 0, fails = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const MIN = 60 * 1000;
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dupcopies-"));
const line = (o) => JSON.stringify(o);
const iso = (ms) => new Date(ms).toISOString();

// writes a transcript: first user prompt, then an assistant answer (clean end_turn unless `unfinished`)
function transcript(name, { firstPrompt, lastAt, unfinished, mtimeAgoMs }) {
  const f = path.join(tmp, name + ".jsonl");
  const lines = [
    line({ type: "user", timestamp: iso(lastAt - 5 * MIN), origin: { kind: "human" }, message: { content: firstPrompt || "hello" } }),
    unfinished
      ? line({ type: "assistant", timestamp: iso(lastAt), message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash" }] } })
      : line({ type: "assistant", timestamp: iso(lastAt), message: { stop_reason: "end_turn", content: [{ type: "text", text: "Handoff written, all done." }] } }),
  ];
  fs.writeFileSync(f, lines.join("\n") + "\n");
  const m = new Date(NOW - (mtimeAgoMs == null ? NOW - lastAt : mtimeAgoMs));
  fs.utimesSync(f, m, m);
  return f;
}
function copy(id, startedAgoMin, trFile, status) {
  return { id, sessionId: id, startedAt: NOW - startedAgoMin * MIN, status: status || "idle", state: "blocked", _file: trFile };
}
const describe = (rows) => DC.describeCopies(rows, (r) => DC.inspectTranscript(r._file), NOW);

// ---- inspection ----
t("inspectTranscript reads preview, finished turn and the handoff-resume tag from the first prompt", () => {
  const f = transcript("resume", { firstPrompt: "[[HANDOFF-RESUME]] C:\\agents\\X\\handoff_history\\handoff_1.md\nContinue.", lastAt: NOW - 30 * MIN });
  const r = DC.inspectTranscript(f);
  assert.strictEqual(r.hasTranscript, true);
  assert.strictEqual(r.handoffResume, true);
  assert.strictEqual(r.handoffPath, "C:\\agents\\X\\handoff_history\\handoff_1.md");
  assert.strictEqual(r.unfinished, false);
  assert.ok(/^Agent: Handoff written/.test(r.preview));
});
t("a prompt that merely mentions the tag later is not a handoff resume; missing/empty file = no transcript", () => {
  const f = transcript("plain", { firstPrompt: "please explain [[HANDOFF-RESUME]] to me", lastAt: NOW - 30 * MIN });
  assert.strictEqual(DC.inspectTranscript(f).handoffResume, false);
  assert.strictEqual(DC.inspectTranscript(path.join(tmp, "nope.jsonl")).hasTranscript, false);
  const e = path.join(tmp, "empty.jsonl"); fs.writeFileSync(e, "");
  assert.strictEqual(DC.inspectTranscript(e).hasTranscript, false);
});
t("an unfinished tool turn is reported; an interrupted turn counts as finished", () => {
  const f = transcript("unf", { lastAt: NOW - 30 * MIN, unfinished: true });
  assert.strictEqual(DC.inspectTranscript(f).unfinished, true);
  const g = path.join(tmp, "int.jsonl");
  fs.writeFileSync(g, [line({ type: "user", timestamp: iso(NOW - 40 * MIN), message: { content: "go" } }), line({ type: "user", timestamp: iso(NOW - 39 * MIN), message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } })].join("\n") + "\n");
  assert.strictEqual(DC.inspectTranscript(g).unfinished, false);
});

// ---- describeCopies ----
t("describeCopies: oldest first, idle/busy, idle minutes", () => {
  const oldF = transcript("o1", { lastAt: NOW - 25 * MIN });
  const newF = transcript("n1", { firstPrompt: "[[HANDOFF-RESUME]] C:\\h.md", lastAt: NOW - 1 * MIN });
  const rows = describe([copy("new11111", 20, newF), copy("old11111", 200, oldF)]);
  assert.deepStrictEqual(rows.map((r) => r.id), ["old11111", "new11111"]);
  assert.strictEqual(rows[0].busy, false);
  assert.strictEqual(Math.round(rows[0].idleMs / MIN), 25);
  assert.strictEqual(rows[1].handoffResume, true);
  assert.strictEqual(rows[0].shortId, "old11111");
});
t("describeCopies: a working status, or an unfinished turn written moments ago, is busy", () => {
  const a = transcript("b1", { lastAt: NOW - 30 * MIN });
  const b = transcript("b2", { lastAt: NOW - 20 * 1000, unfinished: true });
  const c = transcript("b3", { lastAt: NOW - 30 * MIN, unfinished: true }); // unfinished but quiet for 30 min (waiting on approval): not busy
  const rows = describe([copy("aaaaaaaa", 100, a, "working"), copy("bbbbbbbb", 90, b), copy("cccccccc", 80, c)]);
  assert.strictEqual(rows[0].busy, true);
  assert.strictEqual(rows[1].busy, true);
  assert.strictEqual(rows[2].busy, false);
  assert.strictEqual(rows[2].unfinished, true);
});

// ---- manual close rules ----
const row = (id, o) => Object.assign({ id, shortId: id.slice(0, 8), startedAt: 0, busy: false, unfinished: false, idleMs: 60 * MIN, handoffResume: false }, o || {});
t("validateClose: keep one, close the rest", () => {
  const v = DC.validateClose([row("a", { startedAt: 1 }), row("b", { startedAt: 2 }), row("c", { startedAt: 3 })], "c");
  assert.deepStrictEqual(v, { ok: true, toClose: ["a", "b"] });
});
t("validateClose: refuses a keep id that is not running, a closing of the kept copy, an unknown close id, and never closes the last copy", () => {
  const cs = [row("a"), row("b")];
  assert.strictEqual(DC.validateClose(cs, "zzz").ok, false);
  assert.strictEqual(DC.validateClose(cs, "a", ["a"]).ok, false);
  assert.strictEqual(DC.validateClose(cs, "a", ["nope"]).ok, false);
  assert.strictEqual(DC.validateClose([row("a")], "a").ok, false, "single copy: nothing to close");
  assert.strictEqual(DC.validateClose([row("a")], "a", ["a"]).ok, false);
});
t("validateClose: a busy copy needs confirmation, then closes", () => {
  const cs = [row("a", { busy: true }), row("b")];
  const v = DC.validateClose(cs, "b");
  assert.strictEqual(v.ok, false); assert.strictEqual(v.needsConfirm, true); assert.deepStrictEqual(v.busy, ["a"]);
  assert.deepStrictEqual(DC.validateClose(cs, "b", null, { confirmBusy: true }), { ok: true, toClose: ["a"] });
});

// ---- auto rule ----
t("auto: old idle + newest is a handoff resume -> closes the OLD copy only", () => {
  const oldF = transcript("a-old", { lastAt: NOW - 30 * MIN });
  const newF = transcript("a-new", { firstPrompt: "[[HANDOFF-RESUME]] C:\\h.md", lastAt: NOW - 2 * MIN });
  const rows = describe([copy("oldoldol", 300, oldF), copy("newnewne", 25, newF)]);
  const p = DC.planAutoClose(rows, { now: NOW, idleMinutes: 10 });
  assert.deepStrictEqual(p.close, ["oldoldol"]);
  assert.strictEqual(p.keep, "newnewne");
});
t("auto: both busy -> nothing closed", () => {
  const oldF = transcript("b-old", { lastAt: NOW - 30 * MIN });
  const newF = transcript("b-new", { firstPrompt: "[[HANDOFF-RESUME]] C:\\h.md", lastAt: NOW - 2 * MIN });
  const rows = describe([copy("oldoldol", 300, oldF, "working"), copy("newnewne", 25, newF, "working")]);
  assert.deepStrictEqual(DC.planAutoClose(rows, { now: NOW }).close, []);
});
t("auto: old copy idle only 3 min (below the 10 min default) -> kept; configurable threshold changes that", () => {
  const oldF = transcript("c-old", { lastAt: NOW - 3 * MIN });
  const newF = transcript("c-new", { firstPrompt: "[[HANDOFF-RESUME]] C:\\h.md", lastAt: NOW - 1 * MIN });
  const rows = describe([copy("oldoldol", 300, oldF), copy("newnewne", 25, newF)]);
  assert.deepStrictEqual(DC.planAutoClose(rows, { now: NOW }).close, []);
  assert.deepStrictEqual(DC.planAutoClose(rows, { now: NOW, idleMinutes: 2 }).close, ["oldoldol"]);
});
t("auto: newest is NOT a handoff resume (two ordinary conversations) -> human banner, nothing closed", () => {
  const oldF = transcript("d-old", { lastAt: NOW - 60 * MIN });
  const newF = transcript("d-new", { firstPrompt: "do the thing", lastAt: NOW - 50 * MIN });
  const rows = describe([copy("oldoldol", 300, oldF), copy("newnewne", 25, newF)]);
  assert.deepStrictEqual(DC.planAutoClose(rows, { now: NOW }).close, []);
});
t("auto: old copy with an unfinished turn is not closed; the newest copy is never closed", () => {
  const oldF = transcript("e-old", { lastAt: NOW - 60 * MIN, unfinished: true });
  const newF = transcript("e-new", { firstPrompt: "[[HANDOFF-RESUME]] C:\\h.md", lastAt: NOW - 50 * MIN });
  const rows = describe([copy("oldoldol", 300, oldF), copy("newnewne", 25, newF)]);
  assert.deepStrictEqual(DC.planAutoClose(rows, { now: NOW }).close, []);
  // an idle OLDER copy that is the resume-started one does not get the NEWER one closed
  const rows2 = describe([copy("oldoldol", 300, transcript("e2-old", { firstPrompt: "[[HANDOFF-RESUME]] C:\\h.md", lastAt: NOW - 60 * MIN })), copy("newnewne", 25, transcript("e2-new", { firstPrompt: "hi", lastAt: NOW - 60 * MIN }))]);
  assert.deepStrictEqual(DC.planAutoClose(rows2, { now: NOW }).close, []);
});
t("auto: a single copy is never closed; three copies close both old idle ones and keep the newest", () => {
  const f = transcript("f1", { firstPrompt: "[[HANDOFF-RESUME]] C:\\h.md", lastAt: NOW - 60 * MIN });
  assert.deepStrictEqual(DC.planAutoClose(describe([copy("onlyonly", 25, f)]), { now: NOW }).close, []);
  assert.deepStrictEqual(DC.planAutoClose([], { now: NOW }).close, []);
  const rows = describe([copy("oldest11", 500, transcript("f2", { lastAt: NOW - 90 * MIN })), copy("middle11", 300, transcript("f3", { lastAt: NOW - 60 * MIN })), copy("newest11", 25, transcript("f4", { firstPrompt: "[[HANDOFF-RESUME]] C:\\h.md", lastAt: NOW - 1 * MIN }))]);
  const p = DC.planAutoClose(rows, { now: NOW });
  assert.deepStrictEqual(p.close.sort(), ["middle11", "oldest11"]);
  assert.ok(!p.close.includes("newest11"));
});


// ---- review fixes ----
const HR = "[[HANDOFF-RESUME]] C:\\h.md";
function pair(tag, newOpts, newStatus) {
  const oldF = transcript(tag + "-old", { lastAt: NOW - 60 * MIN });
  let newF;
  if (newOpts === "noassistant") {
    newF = path.join(tmp, tag + "-new.jsonl");
    fs.writeFileSync(newF, line({ type: "user", timestamp: iso(NOW - 25 * MIN), origin: { kind: "human" }, message: { content: HR } }) + "\n");
  } else newF = transcript(tag + "-new", { firstPrompt: HR, lastAt: NOW - 2 * MIN });
  return describe([copy("oldoldol", 300, oldF), copy("newnewne", 25, newF, newStatus)]);
}
t("fix1: newest copy must be healthy (not failed/stopped, has started working) before the old one is closed", () => {
  assert.deepStrictEqual(DC.planAutoClose(pair("h1"), { now: NOW }).close, ["oldoldol"]);
  assert.deepStrictEqual(DC.planAutoClose(pair("h2", null, "failed"), { now: NOW }).close, []);
  assert.deepStrictEqual(DC.planAutoClose(pair("h3", null, "stopped"), { now: NOW }).close, []);
  assert.deepStrictEqual(DC.planAutoClose(pair("h4", "noassistant"), { now: NOW }).close, [], "resume prompt only, no assistant reply, no later activity");
});
t("fix2: the copy the pane is attached to is never auto-closed; an attach in flight blocks the rule", () => {
  const rows = pair("a1");
  assert.deepStrictEqual(DC.planAutoClose(rows, { now: NOW, attachedId: "oldoldol" }).close, []);
  assert.deepStrictEqual(DC.planAutoClose(rows, { now: NOW, attachedId: "newnewne" }).close, ["oldoldol"]);
  assert.deepStrictEqual(DC.planAutoClose(rows, { now: NOW, attachedId: "?" }).close, []);
});
t("fix3: the plan is recomputed from fresh rows - a changed old copy (now busy / unfinished) drops out", () => {
  const before = pair("r1");
  assert.deepStrictEqual(DC.planAutoClose(before, { now: NOW }).close, ["oldoldol"]);
  const oldF = transcript("r1b-old", { lastAt: NOW - 20 * 1000, unfinished: true });
  const newF = transcript("r1b-new", { firstPrompt: HR, lastAt: NOW - 2 * MIN });
  const after = describe([copy("oldoldol", 300, oldF), copy("newnewne", 25, newF)]);
  assert.deepStrictEqual(DC.planAutoClose(after, { now: NOW }).close, []);
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf-8");
  assert.ok(/listLiveCopies\(shell, spawnEnv, sessionCwd, \{ fresh: true \}\);\s*const freshPlan/.test(src) && /auto-close of \$\{id\} ABORTED/.test(src), "main.js re-plans on a fresh list right before the stop");
});
t("fix4: an unfinished turn needs confirmation however old it is", () => {
  const cs = [row("a", { unfinished: true, busy: false, idleMs: 99 * 60 * MIN }), row("b")];
  const v = DC.validateClose(cs, "b");
  assert.strictEqual(v.ok, false); assert.strictEqual(v.needsConfirm, true);
  assert.strictEqual(DC.validateClose(cs, "b", null, { confirmBusy: true }).ok, true);
});
t("fix5: a copy with no readable transcript is 'unknown': needs confirmation, skipped by auto, labelled in the dialog", () => {
  const rows = describe([copy("unkunkun", 300, path.join(tmp, "missing.jsonl")), copy("goodgood", 25, transcript("u-new", { firstPrompt: HR, lastAt: NOW - 2 * MIN }))]);
  assert.strictEqual(rows[0].unknown, true);
  assert.deepStrictEqual(DC.planAutoClose(rows, { now: NOW }).close, []);
  const v = DC.validateClose(rows, "goodgood");
  assert.strictEqual(v.needsConfirm, true);
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "stuck-alert.js"), "utf-8");
  const win = { api: { onStuckState() {}, getStuckStates() { return Promise.resolve([]); } } };
  vm.runInNewContext(src, { window: win, document: { querySelectorAll: () => [], createElement: () => ({}), getElementById: () => null }, setInterval() {}, console });
  assert.ok(/state unknown/.test(win.StuckAlertPure.describeCopy(rows[0])));
});

// ---- config ----
t("readConfig: defaults, overrides, nonsense ignored", () => {
  assert.deepStrictEqual(DC.readConfig(path.join(tmp, "missing.json")), { autoClose: true, idleMinutes: 10 });
  const f = path.join(tmp, "cfg.json");
  fs.writeFileSync(f, JSON.stringify({ autoClose: false, idleMinutes: 25 }));
  assert.deepStrictEqual(DC.readConfig(f), { autoClose: false, idleMinutes: 25 });
  fs.writeFileSync(f, JSON.stringify({ idleMinutes: -3 }));
  assert.strictEqual(DC.readConfig(f).idleMinutes, 10);
  fs.writeFileSync(f, "{broken");
  assert.deepStrictEqual(DC.readConfig(f), { autoClose: true, idleMinutes: 10 });
});

// ---- glue (static checks: main.js is an Electron entry and cannot be required here) ----
t("main.js wires the auto rule and manual close through stopCopy -> stopClaudeAgent, and the fake-copies layer is TEST_MODE only", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf-8");
  assert.ok(/planAutoClose\(copies/.test(src) && /AUTO-CLOSED old idle copy/.test(src));
  assert.ok(/ipcMain\.handle\("close-duplicate-copies"/.test(src) && /ipcMain\.handle\("get-duplicate-copies"/.test(src));
  assert.ok(/validateClose\(copies, keepId, closeIds/.test(src));
  assert.ok(/return stopClaudeAgent\(shell, id, spawnEnv\)/.test(src));
  assert.ok(/function fakeCopiesFile\(\) \{ return testMode\.TEST_MODE \?/.test(src));
  assert.ok(!/taskkill|Stop-Process/.test(src.slice(src.indexOf("const dupCopies = require"), src.indexOf("const ENSURE_AGENTS_ALIVE_INTERVAL_MS"))), "no process-kill in the duplicate code");
});

// ---- renderer pure helpers ----
t("dialog helpers: default keep = newest, plain description", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "stuck-alert.js"), "utf-8");
  const win = { api: { onStuckState() {}, getStuckStates() { return Promise.resolve([]); } } };
  const doc = { querySelectorAll: () => [], createElement: () => ({}), getElementById: () => null };
  vm.runInNewContext(src, { window: win, document: doc, setInterval() {}, console });
  const P = win.StuckAlertPure;
  assert.strictEqual(P.defaultKeep([{ id: "a", startedAt: 5 }, { id: "b", startedAt: 9 }, { id: "c", startedAt: 1 }]), "b");
  assert.strictEqual(P.defaultKeep([]), null);
  const d = P.describeCopy({ shortId: "ab12cd34", startedAt: 0, busy: false, idleMs: 25 * MIN, unfinished: true, handoffResume: true });
  assert.ok(/copy ab12cd34/.test(d) && /idle for 25 min/.test(d) && /unfinished turn/.test(d) && /handoff reset/.test(d));
  assert.ok(/BUSY/.test(P.describeCopy({ shortId: "x", busy: true })));
  assert.strictEqual(typeof win.openDuplicateCloseDialog, "function");
});

(async () => {
  for (const [name, fn] of tests) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + (e.stack || e.message)); } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(`duplicateCopies: ${n - fails}/${n} passed`);
  if (fails) process.exit(1);
})();
