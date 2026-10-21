// Run: node tests/stuckEscalation.test.js - v1.134.0 stuck-failing loop detection, progress signal, escalation limits, state clearing,
// duplicate-copies surfacing, fleet-wide cap, guards, the open-questions writer, getLastRealProgressMs on real files and the renderer's pure label picker.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const SE = require("../src/stuckEscalation");

let n = 0, fails = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const MIN = 60 * 1000;
const P = "D:/agents/Software Engineering";

function harness(over) {
  const h = { t: 1000 * MIN, progress: 100 * MIN, notes: [], questions: [], resolved: [], emits: [], escalations: [], logs: [], escalateFails: false, handoff: "C:/agent/handoff_latest.md" };
  Object.assign(h, over || {});
  h.esc = SE.create({
    now: () => h.t,
    log: (l) => h.logs.push(l),
    progressMs: (p) => (h.progressMap && p in h.progressMap ? h.progressMap[p] : h.progress),
    stillExists: (p) => (h.gone ? !h.gone.has(p) : true),
    canEscalate: (p) => (h.guard ? h.guard(p) : { ok: true }),
    handoffPath: () => h.handoff,
    notify: (title, body) => h.notes.push({ title, body, at: h.t }),
    addQuestion: (agent, q, ctx) => h.questions.push({ agent, q, ctx }),
    resolveQuestion: (agent, q) => h.resolved.push({ agent, q }),
    emit: (p, snap) => h.emits.push(snap),
    escalate: async (p, prompt) => { if (h.escalateFails) throw new Error("dispatch failed"); h.escalations.push({ p, prompt, at: h.t }); return { agentId: "abc123" }; },
  });
  // one watchdog trigger: evaluate, and if not failing do the blind recovery bookkeeping (what main.js does)
  h.trigger = (p) => { const f = h.esc.evaluate(p, { name: "Software Engineering" }); if (!f) h.esc.recordRecovery(p); return f; };
  return h;
}
// three blind recoveries 4 min apart, then the fourth trigger declares the loop failing
function enterFailing(h) { for (let i = 0; i < 4; i++) { h.trigger(P); h.t += 4 * MIN; } }
const line = (o) => JSON.stringify(o);

// ---- progress signal ----
t("progress signal ignores queue-operation lines, counts assistant and tool_result entries", () => {
  const lines = [
    line({ type: "assistant", timestamp: "2026-10-20T22:50:00.000Z", message: { content: [] } }),
    line({ type: "user", timestamp: "2026-10-20T22:58:00.000Z", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-21T01:00:00.000Z", content: "are you there?" }),
    line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-21T02:00:00.000Z", content: "hello?" }),
    "",
  ];
  assert.strictEqual(SE.lastRealProgressFromLines(lines), Date.parse("2026-10-20T22:58:00.000Z"));
});
t("progress signal: a human prompt, an attachment and a broken line are not progress", () => {
  const lines = [
    line({ type: "assistant", timestamp: "2026-10-20T10:00:00.000Z", message: {} }),
    line({ type: "user", timestamp: "2026-10-20T11:00:00.000Z", origin: { kind: "human" }, message: { content: "next task please" } }),
    line({ type: "attachment", timestamp: "2026-10-20T12:00:00.000Z" }),
    "{not json",
  ];
  assert.strictEqual(SE.lastRealProgressFromLines(lines), Date.parse("2026-10-20T10:00:00.000Z"));
  assert.strictEqual(SE.lastRealProgressFromLines([line({ type: "queue-operation", timestamp: "2026-10-21T00:00:00.000Z" })]), 0);
  assert.strictEqual(SE.lastRealProgressFromLines([]), 0);
});

// ---- loop detection ----
t("three recoveries with no progress are allowed; the next trigger declares stuck-failing", () => {
  const h = harness();
  for (let i = 0; i < 3; i++) { assert.strictEqual(h.trigger(P), false, "recovery " + (i + 1) + " goes ahead"); h.t += 4 * MIN; }
  assert.strictEqual(h.esc.isFailing(P), false);
  assert.strictEqual(h.trigger(P), true);
  assert.strictEqual(h.esc.isFailing(P), true);
  assert.ok(h.logs.some((l) => /STUCK-FAILING/.test(l)));
});
t("no time window: a slow 6-8 min recovery cadence still declares stuck-failing after 3 recoveries", () => {
  const h = harness();
  for (let i = 0; i < 3; i++) { assert.strictEqual(h.trigger(P), false); h.t += 8 * MIN; }
  assert.strictEqual(h.trigger(P), true);
});
t("real progress between recoveries resets the count", () => {
  const h = harness();
  h.trigger(P); h.t += 4 * MIN; h.trigger(P); h.t += 4 * MIN;
  h.progress = h.t - MIN; // the redispatched session did real work
  h.trigger(P); h.t += 4 * MIN;
  assert.strictEqual(h.trigger(P), false);
  assert.strictEqual(h.esc.isFailing(P), false);
});
t("an unreadable or empty transcript (null / 0 = unknown) never declares a failure", () => {
  for (const unknown of [null, 0]) {
    const h = harness({ progress: unknown });
    for (let i = 0; i < 6; i++) { h.trigger(P); h.t += MIN; }
    assert.strictEqual(h.esc.isFailing(P), false);
  }
});
t("unknown -> known progress does not wipe the recovery history", () => {
  const h = harness({ progress: null });
  for (let i = 0; i < 3; i++) { h.esc.evaluate(P, {}); h.esc.recordRecovery(P); h.t += MIN; } // three recoveries recorded while the read failed
  h.progress = 100 * MIN; // the read works again
  assert.strictEqual(h.esc.evaluate(P, {}), true, "the three earlier recoveries still count");
  assert.strictEqual(h.esc._state.history.get(P).length, 3, "history kept");
});
t("unknown progress never escalates", async () => {
  const h = harness();
  enterFailing(h);
  h.progress = null;
  await h.esc.tick();
  assert.strictEqual(h.escalations.length, 0);
  h.progress = 0;
  await h.esc.tick();
  assert.strictEqual(h.escalations.length, 0);
});
t("entering the state notifies once, registers one question and emits a plain label", () => {
  const h = harness();
  enterFailing(h);
  assert.strictEqual(h.notes.length, 1);
  assert.strictEqual(h.questions.length, 1);
  const snap = h.emits[h.emits.length - 1];
  assert.ok(/^STUCK .+ - auto-restart failed$/.test(snap.stuck.label), snap.stuck.label);
});
t("label wording", () => {
  assert.strictEqual(SE.stuckLabel(0, 5 * 60 * MIN), "STUCK 5 h - auto-restart failed");
  assert.strictEqual(SE.stuckLabel(0, 90 * MIN), "STUCK 1 h 30 min - auto-restart failed");
  assert.strictEqual(SE.stuckLabel(0, 12 * MIN), "STUCK 12 min - auto-restart failed");
});

// ---- escalation limits ----
t("escalates once: a fresh session whose prompt points at handoff_latest.md and the EXACT NEXT STEP", async () => {
  const h = harness();
  enterFailing(h);
  await h.esc.tick();
  assert.strictEqual(h.escalations.length, 1);
  const pr = h.escalations[0].prompt;
  assert.ok(/handoff_latest\.md/.test(pr) && /EXACT NEXT STEP/.test(pr));
  assert.ok(!/resume the old/i.test(pr.replace(/Do NOT try to resume the old conversation/, "")), "no instruction to resume");
  assert.ok(!/"/.test(pr) && !/[\r\n]/.test(pr), "single line, no double quotes");
  assert.ok(h.logs.some((l) => /escalating/.test(l)) && h.logs.some((l) => /fresh session started/.test(l)));
  h.t += 20 * MIN; await h.esc.tick(); h.t += 60 * MIN; await h.esc.tick();
  assert.strictEqual(h.escalations.length, 1, "never a second escalation in the same episode");
});
t("prompt says so when the agent folder has no handoff_latest.md", () => {
  const p = SE.freshPrompt("Trade Show", null);
  assert.ok(/no handoff_latest\.md/i.test(p) && !/EXACT NEXT STEP/.test(p));
});
t("not escalated while the last real progress is under 10 min old, escalated once it is quiet that long", async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) { h.trigger(P); h.t += MIN; }
  h.progress = h.t - 2 * MIN; // newest real entry is 2 min old at the moment the loop is declared
  // history recorded progress 100*MIN earlier; progress is now NEWER than the first recovery's, so the history resets: build a loop at this progress value
  for (let i = 0; i < 4; i++) { h.trigger(P); h.t += MIN; }
  assert.strictEqual(h.esc.isFailing(P), true);
  await h.esc.tick();
  assert.strictEqual(h.escalations.length, 0, "recent progress: do not close the session");
  h.t += 9 * MIN; await h.esc.tick();
  assert.strictEqual(h.escalations.length, 1, "after 10 quiet minutes it escalates once");
});
t("at most one escalation per 30 min per agent, even across episodes", async () => {
  const h = harness();
  enterFailing(h); await h.esc.tick();
  assert.strictEqual(h.escalations.length, 1);
  h.progress = h.t + 1; await h.esc.tick(); // the fresh session worked: cleared
  assert.strictEqual(h.esc.isFailing(P), false);
  h.t += 5 * MIN; h.progress = h.t - 60 * MIN; // freezes again soon after, last real output now old
  enterFailing(h);
  assert.strictEqual(h.esc.isFailing(P), true);
  await h.esc.tick();
  assert.strictEqual(h.escalations.length, 1, "second episode inside 30 min is not escalated");
  h.t += 31 * MIN; await h.esc.tick();
  assert.strictEqual(h.escalations.length, 2, "allowed again after 30 min");
});
t("a fresh session that also shows no progress is not escalated again; the alert stays and re-notifies", async () => {
  const h = harness();
  enterFailing(h); await h.esc.tick();
  const before = h.notes.length;
  h.t += 11 * MIN; await h.esc.tick();
  assert.strictEqual(h.escalations.length, 1);
  assert.strictEqual(h.esc.isFailing(P), true);
  assert.ok(h.notes.length > before, "told again that the fresh session failed too");
  assert.strictEqual(h.emits[h.emits.length - 1].stuck.freshFailed, true);
});
t("failure to start the fresh session is logged, not retried, alert stays", async () => {
  const h = harness({ escalateFails: true });
  enterFailing(h); await h.esc.tick(); h.t += MIN; await h.esc.tick();
  assert.strictEqual(h.escalations.length, 0);
  assert.ok(h.logs.some((l) => /FAILED: dispatch failed/.test(l)));
  assert.strictEqual(h.esc.isFailing(P), true);
});
t("re-notifies every 30 min and not more often", async () => {
  const h = harness({ handoff: null });
  enterFailing(h);
  await h.esc.tick();
  h.t += 11 * MIN; await h.esc.tick(); // the fresh-session-failed notice
  const n1 = h.notes.length;
  h.t += 10 * MIN; await h.esc.tick();
  assert.strictEqual(h.notes.length, n1, "quiet inside 30 min of the last one");
  h.t += 25 * MIN; await h.esc.tick();
  assert.strictEqual(h.notes.length, n1 + 1);
});

// ---- clearing ----
t("recovery clears the state, resolves the question and emits null", async () => {
  const h = harness();
  enterFailing(h);
  assert.strictEqual(h.resolved.length, 0);
  h.progress = h.t + 1000; // real assistant output after entering the state
  await h.esc.tick();
  assert.strictEqual(h.esc.isFailing(P), false);
  assert.strictEqual(h.resolved.length, 1);
  assert.strictEqual(h.resolved[0].q, h.questions[0].q);
  assert.strictEqual(h.emits[h.emits.length - 1].stuck, null);
  assert.deepStrictEqual(h.esc.getAll(), []);
});
t("queued messages alone (no change in the real-progress signal) never clear it", async () => {
  const h = harness();
  enterFailing(h);
  h.t += 40 * MIN; await h.esc.tick();
  assert.strictEqual(h.esc.isFailing(P), true);
});

// ---- duplicate copies ----
t("duplicate live copies with conversations: one plain line, notified once, re-notified at 30 min, cleared when fixed", async () => {
  const h = harness();
  const ids = ["bf03fe1e", "0f585fa1", "ccb30ab3"];
  h.esc.setDuplicates(P, "Software Engineering Agent", ids);
  h.esc.setDuplicates(P, "Software Engineering Agent", ids);
  assert.strictEqual(h.notes.length, 1);
  assert.strictEqual(h.questions.length, 1);
  const snap = h.esc.getAll()[0];
  assert.strictEqual(snap.dup.count, 3);
  assert.ok(/3 live copies/.test(snap.dup.label));
  h.t += 31 * MIN; await h.esc.tick();
  assert.strictEqual(h.notes.length, 2);
  h.esc.setDuplicates(P, "Software Engineering Agent", ["bf03fe1e"]);
  assert.strictEqual(h.resolved.length, 1);
  assert.deepStrictEqual(h.esc.getAll(), []);
});

t("duplicate alert is debounced: one sighting raises nothing, a clean sweep in between resets it", () => {
  const h = harness();
  const ids = ["a1", "b2"];
  h.esc.setDuplicates(P, "SE", ids);
  assert.strictEqual(h.notes.length, 0); assert.deepStrictEqual(h.esc.getAll(), []);
  h.esc.setDuplicates(P, "SE", []);
  h.esc.setDuplicates(P, "SE", ids);
  assert.strictEqual(h.notes.length, 0, "the sighting counter restarted");
  h.esc.setDuplicates(P, "SE", ids);
  assert.strictEqual(h.notes.length, 1);
});

// ---- fleet-wide cap ----
const P2 = "D:/agents/Two", P3 = "D:/agents/Three", P4 = "D:/agents/Four";
function failMany(h, paths) { for (const p of paths) for (let i = 0; i < 4; i++) { h.trigger(p); h.t += MIN; } }
t("more than 2 agents stuck-failing at once: nobody is escalated, ONE fleet-wide alert", async () => {
  const h = harness();
  failMany(h, [P, P2, P3]);
  await h.esc.tick(); await h.esc.tick();
  assert.strictEqual(h.escalations.length, 0);
  const fleetQs = h.questions.filter((q) => /Several agents are frozen/.test(q.q));
  assert.strictEqual(fleetQs.length, 1, "one fleet question");
  assert.ok(h.notes.some((x) => /Fleet-wide freeze/.test(x.title)));
  assert.ok(h.logs.some((l) => /FLEET-WIDE FREEZE/.test(l)));
});
t("fleet alert clears when the count drops to 2, then escalation is possible again", async () => {
  const h = harness();
  failMany(h, [P, P2, P3]);
  await h.esc.tick();
  h.progressMap = { [P3]: h.t + 1 }; // P3 recovers
  await h.esc.tick(); // P3 cleared in this pass
  await h.esc.tick(); // the fleet alert sees 2 and clears
  assert.ok(h.resolved.some((r) => /Several agents are frozen/.test(r.q)));
  await h.esc.tick();
  assert.ok(h.escalations.length >= 1, "two stuck agents may be escalated (under the global cap)");
});
t("global cap: at most one escalation per 5 min and two per hour across ALL agents", async () => {
  const h = harness();
  failMany(h, [P, P2]);
  await h.esc.tick();
  assert.strictEqual(h.escalations.length, 1, "only one of the two in the same pass (5 min gap)");
  h.t += 2 * MIN; await h.esc.tick();
  assert.strictEqual(h.escalations.length, 1, "still inside 5 min");
  h.t += 4 * MIN; await h.esc.tick();
  assert.strictEqual(h.escalations.length, 2, "second agent after 5 min");
  h.progressMap = { [P]: h.t + 1, [P2]: h.t + 1 }; await h.esc.tick(); // both recovered
  failMany(h, [P3]);
  h.t += 6 * MIN; await h.esc.tick();
  assert.strictEqual(h.escalations.length, 2, "third inside the hour is refused");
  h.t += 61 * MIN; await h.esc.tick();
  assert.strictEqual(h.escalations.length, 3, "allowed once the hour has passed");
});

// ---- guards at escalation time, removed / paused agents ----
t("tick re-checks the guards: refused (no session / not working / approval-blocked) = skipped, logged once, alert stays", async () => {
  const h = harness({ guard: () => ({ ok: false, reason: "waiting on an approval prompt, not frozen" }) });
  enterFailing(h);
  await h.esc.tick(); await h.esc.tick();
  assert.strictEqual(h.escalations.length, 0);
  assert.strictEqual(h.logs.filter((l) => /escalation skipped/.test(l)).length, 1);
  assert.strictEqual(h.esc.isFailing(P), true);
  h.guard = null; await h.esc.tick();
  assert.strictEqual(h.escalations.length, 1, "once the guard passes it escalates");
});
t("a removed or paused agent loses its stuck and duplicate state", async () => {
  const h = harness();
  enterFailing(h);
  h.esc.setDuplicates(P2, "Two", ["a", "b"]); h.esc.setDuplicates(P2, "Two", ["a", "b"]);
  assert.strictEqual(h.esc.getAll().length, 2);
  h.gone = new Set([P, P2]);
  await h.esc.tick();
  assert.deepStrictEqual(h.esc.getAll(), []);
  assert.strictEqual(h.escalations.length, 0);
  assert.ok(h.resolved.length >= 2);
});
t("fresh prompt quotes the handoff path in single quotes (paths with spaces)", () => {
  const p = SE.freshPrompt("X", "D:/Dropbox/Claude stuff/X Agent/handoff_latest.md");
  assert.ok(p.includes("Read 'D:/Dropbox/Claude stuff/X Agent/handoff_latest.md' and continue"), p);
  assert.ok(!/"/.test(p));
});

// ---- getLastRealProgressMs on real files (HOME redirected to a temp dir) ----
t("getLastRealProgressMs: tail read, 1 MB -> 8 MB fallback, cut first line, queue-only newest file, max of newest two", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prog-home-"));
  const saved = { u: process.env.USERPROFILE, h: process.env.HOME };
  process.env.USERPROFILE = home; process.env.HOME = home;
  try {
    const archive = require("../src/archive");
    const mk = (name) => { const cwd = path.join(home, "work", name, ".claude-session"); const dir = path.join(home, ".claude", "projects", archive.encodeProjectPath(cwd)); fs.mkdirSync(dir, { recursive: true }); return { cwd, dir }; };
    const asst = (iso) => JSON.stringify({ type: "assistant", timestamp: iso, message: { content: [] } });
    const queue = (iso) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: iso, content: "hello?" });
    const setM = (f, secs) => { const d = new Date(Date.now() + secs * 1000); fs.utimesSync(f, d, d); };
    // 1. no transcript at all
    assert.strictEqual(archive.getLastRealProgressMs(mk("none").cwd), null);
    // 2. small file: last real entry, queue lines after it ignored
    let a = mk("small");
    fs.writeFileSync(path.join(a.dir, "s1.jsonl"), [asst("2026-10-20T22:58:00.000Z"), queue("2026-10-21T01:00:00.000Z"), ""].join("\n"));
    archive.invalidateStatCache();
    assert.strictEqual(archive.getLastRealProgressMs(a.cwd), Date.parse("2026-10-20T22:58:00.000Z"));
    // 3. 1 MB of queue lines after the last real entry: found by the 8 MB fallback
    a = mk("fallback");
    const filler = queue("2026-10-21T01:00:00.000Z");
    const many = new Array(Math.ceil((1.3 * 1024 * 1024) / filler.length)).fill(filler);
    fs.writeFileSync(path.join(a.dir, "f1.jsonl"), [asst("2026-10-20T10:00:00.000Z")].concat(many, [""]).join("\n"));
    archive.invalidateStatCache();
    assert.strictEqual(archive.getLastRealProgressMs(a.cwd), Date.parse("2026-10-20T10:00:00.000Z"));
    // 4. the 1 MB tail starts in the middle of a line: that cut line is skipped, a real entry later in the tail still found
    a = mk("cut");
    const big = JSON.stringify({ type: "user", timestamp: "2026-10-20T09:00:00.000Z", message: { content: "x".repeat(1100 * 1024) } });
    fs.writeFileSync(path.join(a.dir, "c1.jsonl"), [big, asst("2026-10-20T11:00:00.000Z"), ""].join("\n"));
    archive.invalidateStatCache();
    assert.strictEqual(archive.getLastRealProgressMs(a.cwd), Date.parse("2026-10-20T11:00:00.000Z"));
    // 5. newest file is queue-only: the older file's real progress is still reported (max of the newest two)
    a = mk("two");
    const older = path.join(a.dir, "old.jsonl"), newer = path.join(a.dir, "new.jsonl");
    fs.writeFileSync(older, [asst("2026-10-20T08:00:00.000Z"), ""].join("\n"));
    fs.writeFileSync(newer, [queue("2026-10-21T02:00:00.000Z"), ""].join("\n"));
    setM(older, -100); setM(newer, 0);
    archive.invalidateStatCache();
    assert.strictEqual(archive.getLastRealProgressMs(a.cwd), Date.parse("2026-10-20T08:00:00.000Z"));
    // 6. a queue-only transcript has no progress: 0 (unknown), never a made-up value
    a = mk("queueonly");
    fs.writeFileSync(path.join(a.dir, "q.jsonl"), [queue("2026-10-21T02:00:00.000Z"), ""].join("\n"));
    archive.invalidateStatCache();
    assert.strictEqual(archive.getLastRealProgressMs(a.cwd), 0);
  } finally {
    if (saved.u === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.u;
    if (saved.h === undefined) delete process.env.HOME; else process.env.HOME = saved.h;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- main.js wiring (source checks: escalateStuckAgent needs electron, so its guards are asserted by reading the source) ----
t("main.js escalateStuckAgent has the guards and does not use urgent / single-copy stop", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf-8");
  const body = src.slice(src.indexOf("async function escalateStuckAgent"), src.indexOf("async function recoverStuckSession"));
  for (const re of [/liveAgentsPermitted\(\)/, /existsSync\(agentPath\)/, /rec\.paused/, /live\.starting/, /fresh: true/, /remaining\.length/]) assert.ok(re.test(body), String(re));
  assert.ok(!/urgent:\s*true/.test(body), "escalation dispatch must not be urgent");
  assert.ok(!/stopBackgroundAgentForCwd/.test(body), "must stop ALL live copies, not just the first");
  assert.ok(/stillExists/.test(src) && /canEscalate/.test(src) && /approvalBlockedSince\.has\(agentPath\)/.test(src));
});

// ---- open questions writer ----
t("open-questions writer matches the ask_iddo file format, dedupes and resolves by text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oq-"));
  try {
    const s = SE.openQuestionsStore(dir, () => Date.UTC(2026, 9, 21, 12, 0, 0));
    const id = s.add("Software Engineering", "SE is stuck - open it.", "context text");
    assert.strictEqual(s.add("Software Engineering", "SE is stuck - open it.", "x"), id, "same agent + text = no duplicate");
    const d = JSON.parse(fs.readFileSync(path.join(dir, id + ".json"), "utf-8"));
    assert.ok(d.id === id && d.agent === "Software Engineering" && d.question && d.created && Array.isArray(d.quick) && d.context === "context text");
    assert.strictEqual(s.resolve("software engineering", "SE is stuck - open it."), 1);
    assert.ok(fs.existsSync(path.join(dir, "answered", id + ".json")) && !fs.existsSync(path.join(dir, id + ".json")));
    assert.strictEqual(s.resolve("Software Engineering", "SE is stuck - open it."), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- renderer pure picker + header takeover ----
t("renderer picks stuck over dup, null when fine, and takes over the header line", () => {
  const win = {};
  const ctx = { window: win, document: { querySelectorAll: () => [] }, setInterval() {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "stuck-alert.js"), "utf-8"), ctx);
  const pick = win.StuckAlertPure.pick;
  assert.strictEqual(pick(null), null);
  assert.strictEqual(pick({ stuck: null, dup: null }), null);
  const r = pick({ stuck: { label: "STUCK 5 h - auto-restart failed", detail: "No fresh session started yet." }, dup: { label: "x", count: 3 } });
  assert.strictEqual(r.kind, "stuck");
  assert.ok(/STUCK 5 h/.test(r.label) && /frozen/.test(r.title));
  assert.strictEqual(pick({ dup: { label: "SE has 3 live copies - needs a person", count: 3 } }).kind, "dup");
  const set = new Set(["hidden"]);
  const el = { classList: { add(...a) { a.forEach((x) => set.add(x)); }, remove(...a) { a.forEach((x) => set.delete(x)); }, toggle(c, on) { if (on) set.add(c); else set.delete(c); } }, textContent: "" };
  win.stuckAlert._states.p1 = { stuck: { label: "STUCK 5 h - auto-restart failed", detail: "" } };
  assert.strictEqual(win.stuckAlert.paint("p1", el), true);
  assert.ok(/STUCK 5 h/.test(el.textContent) && !set.has("hidden") && set.has("stuck-failing"));
  assert.strictEqual(win.stuckAlert.paint("other", el), false);
  assert.ok(!set.has("stuck-failing"));
});

(async () => {
  for (const [name, fn] of tests) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + (e.stack || e.message)); } }
  console.log(`stuckEscalation: ${n - fails}/${n} passed`);
  if (fails) process.exit(1);
})();
