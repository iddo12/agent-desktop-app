// node tests/triage.test.js - My Daily Tasks triage (v1.79.0): ASK/RECOMMEND parsing, yes/no detection, ordering, counts, snooze, service
// (Yes/No/text delivery, needs-Alex cleared only after a confirmed delivery, ask-for-recommendation, bulk close/snooze), IPC wiring.
"use strict";
const LK = require("../src/legacyKeys").KEYS;
const assert = require("assert");
const { cfgFor } = require("./helpers/dailyCfg");
const fs = require("fs");
const os = require("os");
const path = require("path");
const T = require("../src/daily/triage-model");
const S = require("../src/daily/triage-main");
const D = require("../src/daily/main-daily");
const M = require("../src/daily/model");
const W = { name: "Alex", poss: "Alex's", by: "Alex", subj: "he", obj: "him", reads: "reads" };   // what the owner's migration config reproduces
let fails = 0, n = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const NOW = Date.parse("2026-10-07T10:00:00");
const iso = (d) => new Date(NOW - d * 86400000).toISOString();
const task = (id, title, o) => Object.assign({ id, title, detail: "", status: "open", [LK.needs]: true, priority: 2, tags: [], created: iso(2), updated: iso(2) }, o || {});
const STRUCT = "ASK: Should we deploy v1.79?\nRECOMMEND: Yes, tests pass.\nWHY IT MATTERS: Unblocks the tab.";

t("parseDetail: three labelled blocks, multi-line blocks, rest after a blank line", () => {
  const p = T.parseDetail(STRUCT + "\n\nNotes below.\nMore.");
  assert.strictEqual(p.structured, true); assert.strictEqual(p.ask, "Should we deploy v1.79?"); assert.strictEqual(p.recommend, "Yes, tests pass."); assert.strictEqual(p.why, "Unblocks the tab.");
  assert.strictEqual(p.rest, "Notes below.\nMore.");
  const q = T.parseDetail("ask: Which plan?\nBasic is cheap.\nPro has staging.\nrecommend: Pro\n\nwhy it matters: Launch.");
  assert.strictEqual(q.ask, "Which plan?\nBasic is cheap.\nPro has staging."); assert.strictEqual(q.recommend, "Pro"); assert.strictEqual(q.why, "Launch.");
  const r = T.parseDetail("\n\nASK: Only ask here");
  assert.strictEqual(r.structured, true); assert.strictEqual(r.recommend, "");
});
t("parseDetail: no leading ASK -> plain preview of the first 600 characters, not structured", () => {
  const long = "x".repeat(900);
  const p = T.parseDetail(long);
  assert.strictEqual(p.structured, false); assert.strictEqual(p.preview.length, 600); assert.strictEqual(p.truncated, true);
  assert.strictEqual(T.parseDetail("Some text\nASK: later").structured, false, "ASK must start the detail");
  assert.strictEqual(T.parseDetail("RECOMMEND: x\nASK: y").structured, false);
  assert.strictEqual(T.parseDetail("").structured, false); assert.strictEqual(T.parseDetail(null).preview, "");
});
t("parseDetail: Hebrew and control characters survive/are cleaned", () => {
  const p = T.parseDetail("ASK: האם לפרסם?\u0001\nRECOMMEND: כן");
  assert.strictEqual(p.ask, "האם לפרסם?"); assert.strictEqual(p.recommend, "כן");
});
t("isYesNoAsk: yes/no questions yes, choices and open questions no", () => {
  for (const a of ["Should we deploy v1.79?", "OK to send the policy to the site team?", "Approve the merge?", "Is the price acceptable?", "Go/no-go on the release", "Do you want to keep the mirror?"]) assert.strictEqual(T.isYesNoAsk(a), true, a);
  for (const a of ["Which plan do you want, Basic or Pro?", "What name should we use?", "Option A or B?", "Should we use Kit or Mailchimp?", "Run the script", "Who covers e-commerce law?", ""]) assert.strictEqual(T.isYesNoAsk(a), false, a);
  assert.strictEqual(T.isYesNoAsk("Should we deploy or not?"), true);
});
t("isGoNoGo: tag decision:gonogo wins, decision:text vetoes, yes/no ASK counts, plain title does not", () => {
  assert.strictEqual(T.isGoNoGo({ tags: ["decision:gonogo"], detail: "" }), true);
  assert.strictEqual(T.isGoNoGo({ tags: ["decision:text"], detail: STRUCT }), false);
  assert.strictEqual(T.isGoNoGo({ tags: [], detail: STRUCT }), true);
  assert.strictEqual(T.isGoNoGo({ tags: [], detail: "ASK: Which plan, Basic or Pro?\nRECOMMEND: Pro" }), false);
  assert.strictEqual(T.isGoNoGo({ tags: [], detail: "Should we deploy?" }), false, "unstructured detail is not guessed");
});

const stores = () => [
  { agent: "A", items: [
    task("1", "text low old", { priority: 3, created: iso(30), updated: iso(30) }),
    task("2", "text high", { priority: 1, created: iso(5), updated: iso(1) }),
    task("3", "gonogo low", { priority: 3, tags: ["decision:gonogo"], created: iso(2) }),
    task("4", "gonogo high newer", { priority: 1, detail: STRUCT, created: iso(3) }),
    task("5", "gonogo high older", { priority: 1, tags: ["decision:gonogo"], created: iso(9), updated: iso(9) }),
    task("6", "backlog", { [LK.needs]: false, priority: 2 }),
    task("7", "idea", { [LK.needs]: false, tags: ["idea"] }),
    task("8", "done", { status: "done" }),
    task("9", "idea but needs owner", { tags: ["idea"], priority: 2 }),
  ] },
  { agent: "B", items: [task("1", "same id other agent", { priority: 2, created: iso(1) }), task("2", "b backlog", { [LK.needs]: false })] },
  null, { agent: "C" }, { items: [] },
];
t("buildView: groups, counts (needs vs backlog vs ideas vs open), done excluded, an idea that needs Alex is in needs", () => {
  const v = T.buildView(stores(), {}, NOW);
  assert.strictEqual(v.counts.needs, 7); assert.strictEqual(v.counts.backlog, 2); assert.strictEqual(v.counts.ideas, 1);
  assert.strictEqual(v.counts.open, 10); assert.strictEqual(v.counts.gonogo, 3);
  assert.ok(v.needs.some((x) => x.id === "A::9") && !v.ideas.some((x) => x.id === "A::9"));
  assert.ok(!v.needs.concat(v.backlog, v.ideas).some((x) => x.id === "A::8"));
});
t("ordering of needs-Alex: go/no-go first, then priority, then oldest created, then id", () => {
  const v = T.buildView(stores(), {}, NOW);
  assert.deepStrictEqual(v.needs.map((x) => x.id), ["A::5", "A::4", "A::3", "A::2", "A::9", "B::1", "A::1"]);
});
t("ordering: priority beats age among non-go/no-go", () => {
  const v = T.buildView([{ agent: "Z", items: [task("a", "p3 ancient", { priority: 3, created: iso(100) }), task("b", "p2 young", { priority: 2, created: iso(1) }), task("c", "p2 old", { priority: 2, created: iso(50) }), task("d", "p1", { priority: 1, created: iso(2) })] }], {}, NOW);
  assert.deepStrictEqual(v.needs.map((x) => x.id), ["Z::d", "Z::c", "Z::b", "Z::a"]);
});
t("ages and the Old (>7 d) rule use the last agent update, falling back to created", () => {
  const v = T.buildView([{ agent: "Z", items: [task("a", "old", { created: iso(30), updated: iso(8) }), task("b", "touched", { created: iso(30), updated: iso(2) }), task("c", "no update", { created: iso(9), updated: undefined })] }], {}, NOW);
  const m = Object.fromEntries(v.needs.map((x) => [x.taskId, x]));
  assert.strictEqual(m.a.old, true); assert.strictEqual(m.a.ageDays, 30); assert.strictEqual(m.a.updDays, 8);
  assert.strictEqual(m.b.old, false); assert.strictEqual(m.c.old, true); assert.strictEqual(m.c.updDays, null);
  assert.strictEqual(v.counts.needsOld, 2);
});
t("snoozed tasks leave the lists and the needs count until the time passes", () => {
  const sn = { "A::5": NOW + 3600000, "A::2": NOW - 1 };
  const v = T.buildView(stores(), { snoozes: sn }, NOW);
  assert.strictEqual(v.counts.needs, 6); assert.strictEqual(v.snoozed.length, 1); assert.strictEqual(v.snoozed[0].id, "A::5");
  assert.ok(v.needs.some((x) => x.id === "A::2"), "an expired snooze is back");
  assert.strictEqual(T.needsCount([{ agent: "A", id: "5", [LK.needs]: true }, { agent: "A", id: "2", [LK.needs]: true }, { agent: "A", id: "6", [LK.needs]: false }], sn, NOW), 1);
});
t("snoozeUntil: tomorrow = 08:00 next day, week = +7 d, unknown = 0; pruneSnoozes drops expired", () => {
  const tm = new Date(T.snoozeUntil(NOW, "tomorrow"));
  assert.strictEqual(tm.getHours(), 8); assert.strictEqual(tm.getMinutes(), 0); assert.strictEqual(tm.getDate(), new Date(NOW + 86400000).getDate());
  assert.strictEqual(T.snoozeUntil(NOW, "week"), NOW + 7 * 86400000); assert.strictEqual(T.snoozeUntil(NOW, "x"), 0);
  assert.deepStrictEqual(T.pruneSnoozes({ a: NOW + 5, b: NOW - 5 }, NOW), { a: NOW + 5 });
});
t("model.badge counts needs-Alex (not all open) and summarize skips snoozed tasks", () => {
  const tasks = [{ status: "needs", ageDays: 1, agent: "A" }, { status: "needs", snoozed: true, ageDays: 1, agent: "A" }, { status: "working", ageDays: 1, agent: "A" }];
  const s = M.summarize({ tasks, emails: { needAnswer: [], sentNoReply: [], top: [] }, dates: [], shopping: { lists: [] }, events: [] }, NOW);
  assert.strictEqual(s.tasksOpen, 3); assert.strictEqual(s.tasksNeed, 1);
  assert.deepStrictEqual(M.badge(s), { count: 1, blue: true });
  assert.strictEqual(M.mapTaskStores([{ agent: "A", items: [task("1", "x")] }], NOW)[0][LK.needs], true);
});
t("messages: yes/no names the ASK and the task id, text carries the note, request lists the three labels", () => {
  const v = T.buildView([{ agent: "A", items: [task("4", "Deploy tab", { detail: STRUCT })] }], {}, NOW).needs[0];
  assert.ok(/^Alex answered YES to: Should we deploy v1.79\? \(task: Deploy tab\)/.test(T.answerMessage(v, "yes", undefined, W)));
  assert.ok(/^Alex answered NO to:/.test(T.answerMessage(v, "no", undefined, W)) && T.answerMessage(v, "no", undefined, W).includes("Task id: 4"));
  assert.ok(T.answerMessage(v, "text", " Use Kit ", W).includes("\n\nUse Kit\n\n"));
  const r = T.recommendRequest(v, W); for (const l of ["ASK:", "RECOMMEND:", "WHY IT MATTERS:"]) assert.ok(r.includes(l));
  assert.strictEqual(T.validateText("   ", 4000).ok, false); assert.strictEqual(T.validateText("x".repeat(4001), 4000).ok, false); assert.strictEqual(T.validateText("ok", 4000).ok, true);
});
t("appendNote keeps the ASK head when the detail is too long; the note is never cut; short details just get the note", () => {
  const a = T.appendNote("short", "NOTE");
  assert.strictEqual(a.detail, "short\n\nNOTE"); assert.strictEqual(a.cut, false);
  const big = STRUCT + "\n" + "z".repeat(9000) + "\nTAILMARK";
  const b = T.appendNote(big, "N".repeat(900));
  assert.ok(b.cut && b.detail.length <= 6000); assert.ok(b.detail.startsWith("ASK: Should we deploy")); assert.ok(b.detail.includes("TAILMARK") && b.detail.endsWith("N".repeat(900)));
  assert.ok(T.parseDetail(b.detail).structured, "still parses as a card");
});

// ---------------------------------------------------------------- service
function mkService(over) {
  const root = (over && over.root) || fs.mkdtempSync(path.join(os.tmpdir(), "tri-"));
  const file = path.join(root, "daily", "triage.json");
  const st = [{ agent: "Security", items: [task("deploy", "Deploy tab", { detail: STRUCT, updated: iso(1) }), task("plain", "Free text one", { updated: iso(1) }), task("own", "Backlog work", { [LK.needs]: false })] }, { agent: "Legal Agent", items: [task("lic", "Licence?", { tags: ["decision:gonogo"] })] }];
  const sent = [], ran = [];
  const state = { delivery: { delivered: true, via: "channel", attempts: 1 } };
  const svc = S.createService(Object.assign({
    people: () => W, root, file, path, readStore: D.readStore, writeJsonAtomic: D.writeJsonAtomic, notices: [], now: () => NOW, say: () => {},
    loadStores: async () => ({ stores: JSON.parse(JSON.stringify(st)), skipped: 0 }),
    deliver: async (p, text) => { sent.push({ p, text }); if (state.throws) throw new Error(state.throws); return state.delivery; },
    knownAgent: () => true,
    run: async (a) => { ran.push(a); if (state.runFails) throw new Error("tasks.py exploded"); return "ok"; },
  }, over || {}));
  svc.ans = async (a) => { const v = await svc.view(); const it = v.needs.concat(v.backlog, v.ideas, v.snoozed).find((x) => x.id === a.id); return svc.answer(Object.assign({ rev: it && it.rev }, a)); };
  return { svc, root, file, st, sent, ran, state };
}
const revsOf = async (svc, ids) => { const v = await svc.view(); const o = {}; for (const x of v.needs.concat(v.backlog, v.ideas, v.snoozed)) if (ids.includes(x.id)) o[x.id] = x.rev; return o; };
const cleanup = (c) => fs.rmSync(c.root, { recursive: true, force: true });

t("view: needs first with go/no-go ahead; backlog separate", async () => {
  const c = mkService(); const v = await c.svc.view();
  assert.strictEqual(v.ok, true); assert.deepStrictEqual(v.needs.map((x) => x.id).slice(0, 2).sort(), ["Legal Agent::lic", "Security::deploy"]);
  assert.strictEqual(v.counts.needs, 3); assert.strictEqual(v.backlog.length, 1); cleanup(c);
});
t("YES: delivered to the owning agent folder, task updated with a note and needs-Alex no (after confirmed delivery)", async () => {
  const c = mkService(); const r = await c.svc.ans({ id: "Security::deploy", answer: "yes" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.delivery, "sent"); assert.strictEqual(r.cleared, true);
  assert.strictEqual(c.sent.length, 1); assert.strictEqual(c.sent[0].p, path.join(c.root, "Security")); assert.ok(/answered YES/.test(c.sent[0].text));
  const a = c.ran[0]; assert.deepStrictEqual(a.slice(0, 4), ["--agent", "Security", "--update", "deploy"]);
  assert.ok(a.includes(LK.needsFlag) && a[a.indexOf(LK.needsFlag) + 1] === "no");
  const det = a[a.indexOf("--detail") + 1]; assert.ok(det.startsWith("ASK: Should we deploy") && /Alex answered via My Daily Tasks: YES/.test(det));
  cleanup(c);
});
t("queued delivery: the note is recorded but needs-Alex is NOT cleared; the card shows queued and refuses a second yes/no", async () => {
  const c = mkService(); c.state.delivery = { delivered: false, via: "channel", attempts: 3 };
  const r = await c.svc.ans({ id: "Security::deploy", answer: "yes" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.delivery, "queued"); assert.strictEqual(r.cleared, false);
  assert.ok(!c.ran[0].includes(LK.needsFlag)); assert.ok(/queued, not yet confirmed/.test(c.ran[0][c.ran[0].indexOf("--detail") + 1]));
  const v = await c.svc.view(); assert.ok(v.needs.find((x) => x.id === "Security::deploy").queuedAt > 0);
  cleanup(c);
});
t("failed delivery (not taken, throws, aborted, dry run): nothing recorded, task untouched", async () => {
  for (const mode of [{ delivery: { delivered: false, via: null } }, { throws: "pipe closed" }, { delivery: { delivered: false, via: "channel", aborted: true } }, { delivery: { delivered: false, dry: true } }]) {
    const c = mkService(); Object.assign(c.state, mode);
    const r = await c.svc.ans({ id: "Security::deploy", answer: "no" });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.delivery, "failed"); assert.strictEqual(c.ran.length, 0); assert.strictEqual(fs.existsSync(c.file), false); cleanup(c);
  }
});
t("yes/no refused on a task that is not a yes/no question; unknown answers, bad ids, stale or missing stamp are refused before delivery", async () => {
  const c = mkService();
  assert.strictEqual((await c.svc.ans({ id: "Security::plain", answer: "yes" })).ok, false);
  assert.strictEqual((await c.svc.ans({ id: "Security::deploy", answer: "maybe" })).ok, false);
  assert.strictEqual((await c.svc.answer({ id: "nope", answer: "yes", rev: "x" })).ok, false);
  const stale = await c.svc.answer({ id: "Security::deploy", answer: "yes", rev: "old" }); assert.strictEqual(stale.changed, true);
  assert.strictEqual((await c.svc.answer({ id: "Security::deploy", answer: "yes" })).changed, true);
  assert.strictEqual((await c.svc.ans({ id: "Security::own", answer: "yes" })).ok, false, "backlog task");
  assert.strictEqual((await c.svc.ans({ id: "Ghost::1", answer: "text", text: "x" })).ok, false);
  assert.strictEqual(c.sent.length, 0); cleanup(c);
});
t("unknown agent folder: refused, nothing sent", async () => {
  const c = mkService({ knownAgent: () => false }); const r = await c.svc.ans({ id: "Security::deploy", answer: "yes" });
  assert.strictEqual(r.ok, false); assert.strictEqual(c.sent.length, 0); cleanup(c);
});
t("text reply: delivered, noted; clears needs-Alex by default, keeps it when 'clear' is unticked", async () => {
  const c = mkService(); const r = await c.svc.ans({ id: "Security::plain", answer: "text", text: "Use Kit" });
  assert.strictEqual(r.ok, true); assert.ok(c.sent[0].text.includes("Use Kit")); assert.ok(c.ran[0].includes(LK.needsFlag));
  const r2 = await c.svc.ans({ id: "Security::deploy", answer: "text", text: "Wait a day", clear: false });
  assert.strictEqual(r2.ok, true); assert.ok(!c.ran[1].includes(LK.needsFlag));
  assert.strictEqual((await c.svc.ans({ id: "Security::plain", answer: "text", text: "  " })).ok, false);
  assert.strictEqual((await c.svc.ans({ id: "Security::plain", answer: "text", text: "x".repeat(4001) })).ok, false);
  cleanup(c);
});
t("text reply on a backlog task is allowed and never touches needs-Alex", async () => {
  const c = mkService(); const r = await c.svc.ans({ id: "Security::own", answer: "text", text: "note" });
  assert.strictEqual(r.ok, true); assert.ok(!c.ran[0].includes(LK.needsFlag)); cleanup(c);
});
t("tasks.py failure after delivery: ok with a warning, nothing cleared", async () => {
  const c = mkService(); c.state.runFails = true; const r = await c.svc.ans({ id: "Security::deploy", answer: "yes" });
  assert.strictEqual(r.ok, true); assert.ok(r.warning && /could not be updated/.test(r.warning)); assert.strictEqual(r.cleared, false); cleanup(c);
});
t("double click: a second answer while the first is in flight is refused, one message delivered", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const c = mkService({ deliver: async (p, text) => { c.sent.push({ p, text }); await gate; return { delivered: true, via: "channel" }; } });
  const v = await c.svc.view(); const rev = v.needs.find((x) => x.id === "Security::deploy").rev;
  const p1 = c.svc.answer({ id: "Security::deploy", answer: "yes", rev });
  await new Promise((r) => setTimeout(r, 10));
  const r2 = await c.svc.answer({ id: "Security::deploy", answer: "yes", rev });
  assert.strictEqual(r2.ok, false); release(); assert.strictEqual((await p1).ok, true); assert.strictEqual(c.sent.length, 1); cleanup(c);
});
t("ask for a recommendation: delivered to the owning agent, task not changed, repeats refused for 10 minutes, refused when one exists", async () => {
  const c = mkService(); const r = await c.svc.askRecommendation({ id: "Security::plain" });
  assert.strictEqual(r.ok, true); assert.strictEqual(c.sent[0].p, path.join(c.root, "Security")); assert.ok(c.sent[0].text.includes("RECOMMEND:")); assert.strictEqual(c.ran.length, 0);
  assert.strictEqual((await c.svc.askRecommendation({ id: "Security::plain" })).ok, false);
  assert.ok((await c.svc.view()).needs.find((x) => x.id === "Security::plain").askedAt > 0);
  assert.strictEqual((await c.svc.askRecommendation({ id: "Security::deploy" })).ok, false, "already has a recommendation");
  c.state.delivery = { delivered: false, via: null }; assert.strictEqual((await c.svc.askRecommendation({ id: "Legal Agent::lic" })).ok, false);
  cleanup(c);
});
t("snooze / unsnooze: stored locally, the task leaves needs and the count, comes back after unsnooze; bad input refused", async () => {
  const c = mkService(); const r = await c.svc.snooze({ ids: ["Security::plain", "Security::plain", "bad"], kind: "tomorrow" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.count, 1);
  let v = await c.svc.view(); assert.strictEqual(v.counts.needs, 2); assert.strictEqual(v.snoozed.length, 1);
  assert.strictEqual(c.ran.length, 0, "snooze never touches the task store");
  await c.svc.unsnooze({ ids: ["Security::plain"] }); v = await c.svc.view(); assert.strictEqual(v.counts.needs, 3);
  assert.strictEqual((await c.svc.snooze({ ids: [], kind: "week" })).ok, false); assert.strictEqual((await c.svc.snooze({ ids: ["A::1"], kind: "month" })).ok, false);
  cleanup(c);
});
t("bulk close: tasks.py --close with the note per task, partial failure reported, snoozes of closed tasks dropped", async () => {
  const c = mkService(); await c.svc.snooze({ ids: ["Security::own"], kind: "week" });
  let calls = 0; const c2 = mkService({ root: c.root, run: async (a) => { calls++; c2.ran.push(a); if (a[3] === "plain") throw new Error("boom"); } });
  const r = await c2.svc.close({ ids: ["Security::deploy", "Security::plain", "Security::own", "Ghost::9"], note: "Not needed", revs: await revsOf(c2.svc, ["Security::deploy", "Security::plain", "Security::own"]) });
  assert.strictEqual(r.closed, 2); assert.strictEqual(r.failed, 2); assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(c2.ran[0], ["--agent", "Security", "--close", "deploy", "--note", "Closed by Alex via My Daily: Not needed"]);
  assert.strictEqual(calls, 3); assert.deepStrictEqual(r.results.map((x) => x.ok), [true, false, true, false]);
  assert.strictEqual(JSON.parse(fs.readFileSync(c.file, "utf8")).snoozes["Security::own"], undefined);
  assert.strictEqual((await c2.svc.close({ ids: [] })).ok, false); cleanup(c);
});
t("close refuses a task whose revision changed since shown (or has no stamp); unchanged ones close; mixed bulk reports skipped", async () => {
  const c = mkService(); const revs = await revsOf(c.svc, ["Security::deploy", "Security::plain", "Security::own"]);
  const one = await c.svc.close({ ids: ["Security::plain"], revs: { "Security::plain": "stale" } });
  assert.strictEqual(one.closed, 0); assert.strictEqual(one.skipped, 1); assert.strictEqual(c.ran.length, 0);
  assert.strictEqual((await c.svc.close({ ids: ["Security::plain"] })).skipped, 1, "no stamp");
  const ok = await c.svc.close({ ids: ["Security::plain"], revs }); assert.strictEqual(ok.closed, 1); assert.strictEqual(ok.skipped, 0);
  const mixed = await c.svc.close({ ids: ["Security::deploy", "Security::own"], revs: Object.assign({}, revs, { "Security::own": "old" }) });
  assert.strictEqual(mixed.closed, 1); assert.strictEqual(mixed.skipped, 1); assert.strictEqual(mixed.failed, 0); assert.strictEqual(mixed.results[1].skipped, true);
  assert.strictEqual(c.ran.length, 2); cleanup(c);
});
t("bulk is capped at 200 ids", async () => {
  const c = mkService(); const ids = Array.from({ length: 300 }, (_, i) => "Security::x" + i);
  const r = await c.svc.snooze({ ids, kind: "week" }); assert.strictEqual(r.count, 200); cleanup(c);
});
t("fixture mode: nothing real is touched; close and answer change only the in-memory view", async () => {
  const c = mkService({ fixtures: true, loadStores: async () => { throw new Error("must not read"); }, run: async () => { throw new Error("must not run"); } });
  const v = await c.svc.view(); assert.ok(v.counts.needs >= 5 && v.counts.backlog >= 2 && v.counts.ideas >= 2);
  assert.ok(v.needs[0].gonogo, "go/no-go first");
  const id = v.needs[0].id; const r = await c.svc.answer({ id, answer: "yes", rev: v.needs[0].rev });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.cleared, true);
  assert.strictEqual((await c.svc.view()).counts.needs, v.counts.needs - 1);
  const cl = await c.svc.close({ ids: [v.backlog[0].id], revs: { [v.backlog[0].id]: v.backlog[0].rev } }); assert.strictEqual(cl.closed, 1); assert.strictEqual((await c.svc.view()).counts.backlog, v.counts.backlog - 1 + 1, "closed one leaves; the answered task is now agent backlog");
  cleanup(c);
});

// ---------------------------------------------------------------- IPC (real main-daily wiring, fake deliver)
const WIN = { webContents: { id: 1, mainFrame: { id: "main" } } };
const OWN = { sender: WIN.webContents, senderFrame: WIN.webContents.mainFrame };
t("IPC: load/answer/ask/snooze/unsnooze/close through main-daily; foreign callers refused; badge in the payload is the needs-Alex number and drops with a snooze", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tri-ipc-"));
  fs.mkdirSync(path.join(root, "shared_reports", "tasks"), { recursive: true });
  const items = [task("a", "Deploy", { detail: STRUCT }), task("b", "Own work", { [LK.needs]: false }), task("c", "Needs text")];
  fs.writeFileSync(path.join(root, "shared_reports", "tasks", "Security.json"), JSON.stringify({ agent: "Security", schema: "agent-tasks/1", items }));
  const h = {}, ran = [], delivered = [];
  D.init({ ipcMain: { handle: (c, f) => { h[c] = f; } }, getMainWindow: () => WIN, cfg: cfgFor(root, { values: { ownerName: "Alex", partnerName: "Sarah" }, daily: { ownerPronouns: "he", partnerPronouns: "she", sharePartnerDefault: true } }), testMode: false, log: () => {}, runPython: async (a) => { ran.push(a); return "ok"; }, deliverToAgent: async (p, text) => { delivered.push({ p, text }); return { delivered: true, via: "channel" }; }, knownAgent: () => true });
  for (const c of ["daily-triage-load", "daily-triage-answer", "daily-triage-ask", "daily-triage-snooze", "daily-triage-unsnooze", "daily-triage-close"]) for (const ev of [null, {}, { sender: { id: 2 } }]) { const r = await h[c](ev, {}); assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, "Not allowed."); }
  const v = await h["daily-triage-load"](OWN);
  assert.strictEqual(v.ok, true); assert.strictEqual(v.counts.needs, 2); assert.strictEqual(v.counts.open, 3); assert.strictEqual(v.needs[0].gonogo, true);
  const p0 = await h["daily-load"](OWN, false); assert.strictEqual(p0.badge.count, 2, "badge = needs-Alex (open is 3)");
  assert.strictEqual((await h["daily-triage-answer"](OWN, { id: "Security::a", answer: "yes", rev: v.needs[0].rev })).ok, true);
  assert.strictEqual(ran.length, 1); assert.strictEqual(delivered.length, 1);
  assert.strictEqual((await h["daily-triage-snooze"](OWN, { ids: ["Security::c"], kind: "week" })).ok, true);
  const p1 = await h["daily-load"](OWN, true); assert.strictEqual(p1.badge.count, 1, "snoozed task not counted (a is still flagged in the file, tasks.py is a fake here)");
  assert.strictEqual((await h["daily-triage-close"](OWN, { ids: ["Security::b"], note: "x", revs: { "Security::b": (await h["daily-triage-load"](OWN)).backlog.find((x) => x.id === "Security::b").rev } })).closed, 1);
  assert.deepStrictEqual(ran[1].slice(0, 4), ["--agent", "Security", "--close", "b"]);
  fs.rmSync(root, { recursive: true, force: true });
});

(async () => {
  for (const q of queue) { n++; try { await q.fn(); } catch (e) { fails++; console.error("FAIL " + q.name + "\n  " + String(e.stack).split("\n").slice(0, 5).join("\n  ")); } }
  console.log(`triage: ${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
})();
