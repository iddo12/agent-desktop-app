// node tests/outboxRaces.test.js - v1.101.0 outbox review fixes (REVIEW.md, independent review of v1.100.0).
// R1-R6 are the reviewer's race tests (ad-reattach-review/scratch/outboxRaces.test.js), kept as written: each asserts the
// SAFE behaviour. The rest cover the other review items: B1 across a restart, "!" commands and the CLI's command markup,
// S5 save failures, S6 "cannot tell", S7 an open dialog, N2 identical messages, N3 eviction, and the new labels.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const L = require("../src/outbox");
const NOW = 1_800_000_000_000;

function makeApp(o) {
  o = o || {};
  let clock = o.now || NOW;
  let mono = 1000;                                 // performance.now() (only exposed with o.mono: real elapsed time)
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } }
  const log = [], sends = [], saves = [];
  const seenMap = new Map();
  const sessions = new Map();
  const ctxObj = {
    console: { log() {}, warn() {}, error() {} }, Promise, Map, Set, Array, Object, JSON, Math, String, Number, RegExp, Error, Date: FakeDate,
    setInterval: (fn) => { ctxObj.__tick = fn; return 1; }, setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {},
    terminals: sessions, activeAgentPath: "D:\\A",
    renderQueue: () => {}, renderChatBlocks: () => {},
    // like the real setBusy(false): drains one queued message
    setBusy: (ap, se) => { if (se.sendQueue.length && se.started && !se.busy) { const x = se.sendQueue.shift(); ctxObj.sendOrHold(ap, se, x, null); } },
    // like the real path: submitToAgent strips C0/C1 before the bubble is drawn
    sendOrHold: async (ap, se, text) => { sends.push({ ap, text, at: clock }); se.pendingSent.push({ text: L.clean(text), addedAt: clock, sentAt: clock, written: true, provisional: false }); return "sent"; },
  };
  ctxObj.window = ctxObj; ctxObj.globalThis = ctxObj;
  ctxObj.api = {
    outboxSave: (json) => { saves.push(json); return Promise.resolve(ctxObj.__saveFails ? { ok: false, error: "EPERM" } : { ok: true }); },
    outboxLoad: () => Promise.resolve({ ok: true, json: o.disk || "{}" }),
    outboxSeen: (ap, text) => Promise.resolve({ seen: seenMap.has(text) ? seenMap.get(text) : "none" }),
    agentInputHoldsText: () => Promise.resolve(false),
    agentDialogOpen: () => Promise.resolve(!!ctxObj.__dialog),
    // v1.110.0 (B1): main's answer = the disk. Defaults to what the test's agent list says; tests set ctx.__mainPaused to diverge.
    agentIsPaused: (ap) => Promise.resolve(ctxObj.__mainPaused !== undefined ? ctxObj.__mainPaused : !!((ctxObj.agents || []).find((x) => x && x.path === ap) || {}).paused),
    onAgentPausedChanged: (cb) => { ctxObj.__pausedCb = cb; },
    getTranscriptQuietMs: () => Promise.resolve(60000),
    logGuard: (l) => log.push(l),
  };
  ctxObj.guardsParkedState = () => [];
  ctxObj.guardsAgentInFlow = () => false;
  ctxObj.connHealth = { _states: new Map(), holding: () => false };
  ctxObj.agents = o.agents || [];
  if (o.mono) ctxObj.performance = { now: () => mono };
  vm.createContext(ctxObj);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "outbox.js"), "utf8"), ctxObj);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "outbox.js"), "utf8"), ctxObj);
  const app = {
    ctx: ctxObj, log, sends, saves, seen: seenMap,
    get now() { return clock; },
    advance(ms) { clock += ms; if (ms > 0) mono += ms; },
    jumpWall(ms) { clock += ms; },                 // a wall-clock change only (NTP / by hand): real time does not move
    session(ap, s) { const se = Object.assign({ started: true, busy: false, transcriptWorking: false, sendQueue: [], pendingSent: [], lastBlocks: [] }, s || {}); sessions.set(ap, se); return se; },
    async settle() { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); },
    async tick() { ctxObj.__tick && ctxObj.__tick(); await app.settle(); },
    async run(ms, step) { const s = step || 2000; for (let x = 0; x < ms; x += s) { await app.tick(); clock += s; mono += s; } await app.tick(); },
    get outbox() { return ctxObj.outbox; },
    items() { return ctxObj.outbox._state(); },
  };
  return app;
}
const AP = "D:\\A";
const TXT = "please run the full NAS backup check and report back";
const tests = [];
const t = (n, f) => tests.push({ n, f });
const failedBubble = (app, text, id) => ({ text: L.clean(text), addedAt: app.now, sentAt: app.now, written: true, provisional: false, failed: true, obId: id });

// ---------------------------------------------------------------- the reviewer's races (R1-R6) ------------------
t("R1 (B1) order inversion: a lost message is not auto-re-sent after a LATER message of his has landed", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const A = "go ahead and delete the old backups on the NAS";
  const B = "actually do NOT delete anything yet, wait for me";
  const idA = app.outbox.add(AP, A);
  const pA = { text: A, addedAt: app.now, sentAt: app.now, written: true, provisional: false, obId: idA };
  se.pendingSent.push(pA);
  await app.tick();
  app.advance(5000);
  const idB = app.outbox.add(AP, B);
  se.pendingSent.push({ text: B, addedAt: app.now, sentAt: app.now, written: true, provisional: false, obId: idB });
  await app.tick();
  app.seen.set(B, "user");
  se.pendingSent = se.pendingSent.filter((p) => p.text !== B);
  pA.failed = true; pA.superseded = true;
  await app.run(180000);
  assert.strictEqual(app.sends.filter((s) => s.text === A).length, 0, "A was auto-re-sent AFTER B had landed");
  assert.ok(/you sent other messages after it/.test(app.outbox.pendingLabel(pA)), app.outbox.pendingLabel(pA));
  app.outbox.retryNow(pA); await app.settle();
  assert.strictEqual(app.sends.filter((s) => s.text === A).length, 1, "his own Retry click still sends it");
});

t("R2 (S1) requeue race: an item whose Send is still in progress (no bubble yet) is not requeued", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT);
  await app.run(6000);
  se.sendQueue.push(TXT);                       // the original run reaches sendOrHold and queues it
  app.outbox.dispatched(id);
  await app.run(60000);
  const copies = se.sendQueue.filter((x) => x === TXT).length + app.sends.filter((s) => s.text === TXT).length;
  assert.strictEqual(copies, 1, "the message exists " + copies + "x (queued/sent)");
});

t("R3 (B2) stale: a 20-hour-old queued 'yes go ahead' is offered (Retry), never auto-delivered after a restart", async () => {
  const it = Object.assign(L.create(AP, "yes go ahead", NOW - 20 * 3600e3), { state: "queued" });
  const app = makeApp({ disk: L.serialize([it], NOW) }); await app.settle();
  const se = app.session(AP);
  await app.run(90000);
  assert.strictEqual(se.sendQueue.length + app.sends.length, 0, "requeued/sent automatically");
  const p = se.pendingSent.find((x) => x.obId === it.id);
  assert.ok(p && p.failed, "a visible bubble with Retry");
  assert.ok(/from before the restart/.test(app.outbox.pendingLabel(p)), app.outbox.pendingLabel(p));
  app.outbox.retryNow(p); await app.settle();
  assert.deepStrictEqual(app.sends.map((s) => s.text), ["yes go ahead"], "Retry delivers it once");
  await app.run(60000);
  assert.strictEqual(app.sends.length, 1);
});

t("R3 (B2) a written message older than 10 min is not re-sent automatically either (same session, no restart)", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP, { busy: true });
  const id = app.outbox.add(AP, TXT);
  se.pendingSent.push({ text: TXT, addedAt: app.now, sentAt: app.now, written: true, provisional: false, obId: id });
  await app.run(11 * 60000, 30000);              // busy for 11 min
  se.pendingSent[0].failed = true; se.busy = false;
  await app.run(120000);
  assert.strictEqual(app.sends.length, 0);
  assert.ok(/sent \d+ min ago/.test(app.outbox.pendingLabel(se.pendingSent[0])), app.outbox.pendingLabel(se.pendingSent[0]));
});

t("R3b (S2) paused: no automatic re-send to an agent he paused; label says so", async () => {
  const it = Object.assign(L.create(AP, TXT, NOW - 120000), { state: "sent", written: true, attempts: 1, firstSentAt: NOW - 120000 });
  const agents = [{ path: AP, paused: true }];
  const app = makeApp({ disk: L.serialize([it], NOW), agents }); await app.settle();
  const se = app.session(AP);
  await app.run(90000);
  assert.strictEqual(app.sends.length, 0, "re-sent to a paused agent");
  se.pendingSent.push(failedBubble(app, TXT, it.id)); await app.tick();
  assert.ok(/paused/.test(app.outbox.pendingLabel(se.pendingSent[0])));
  agents[0].paused = false;                      // resumed within the 10 min window -> it goes once
  await app.run(60000);
  assert.strictEqual(app.sends.length, 1);
});

t("R4 (N1) Retry clicked right after an automatic re-send does not send a second copy", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT);
  const p = failedBubble(app, TXT, id);
  se.pendingSent.push(p);
  for (let i = 0; i < 60 && app.sends.length === 0; i++) { await app.tick(); app.advance(2000); }
  assert.strictEqual(app.sends.length, 1, "setup: one automatic re-send");
  app.advance(1000);
  app.outbox.retryNow(p);
  await app.settle();
  assert.strictEqual(app.sends.length, 1, "Retry right after the auto re-send produced " + app.sends.length + " copies");
  assert.ok(app.log.some((l) => /waiting for the agent/.test(l)));
});

t("R5 (S3) a stripped control char: the re-sent copy is claimed and never marked delivered without transcript proof", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const RAW = "copied from a log line\u000c please check the render queue status";
  const id = app.outbox.add(AP, RAW);
  assert.strictEqual(app.items()[0].text, L.clean(RAW), "the outbox keeps what is really typed");
  se.pendingSent.push(failedBubble(app, RAW, id));
  for (let i = 0; i < 60 && app.sends.length === 0; i++) { await app.tick(); app.advance(2000); }
  await app.run(10000);
  const it = app.items()[0];
  assert.notStrictEqual(it.state, "seen");
  assert.ok(se.pendingSent.some((p) => p.obId === id && !p.failed), "the re-sent bubble is tagged with the item (N2)");
});

t("R6 (B3) a slash command that ran is found in the CLI's command markup and is never re-run", () => {
  const cmd = "/compact keep the NAS backup plan details";
  const line = JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>keep the NAS backup plan details</command-args>" }, timestamp: new Date(NOW + 800).toISOString() });
  const seen = L.scanTranscripts([{ lines: [line], current: true }], cmd, NOW, NOW);
  assert.strictEqual(seen, "user", "the ack understands <command-name> markup");
  const it = Object.assign(L.create(AP, cmd, NOW - 120000), { written: true, attempts: 1, firstSentAt: NOW - 120000, state: "failed" });
  for (const s of ["none", seen]) {
    const d = L.decide(it, { now: NOW, seen: s, where: "pendingFailed", started: true, connected: true, inFlow: false, queueEmpty: true, idleForMs: 60000 });
    assert.notStrictEqual(d, "retry", s);
  }
  assert.strictEqual(L.decide(Object.assign({}, it, { written: false, state: "queued" }), { now: NOW, seen: "none", where: "absent", started: true, connected: true, queueEmpty: true }), "manual", "not requeued either");
  assert.strictEqual(L.decide(Object.assign({}, it, { text: "!git status --short in the repo please" }), { now: NOW, seen: "none", where: "pendingFailed", started: true, connected: true, queueEmpty: true, idleForMs: 60000 }), "manual", "'!' shell lines too");
  assert.ok(/commands are not re-run/.test(L.label(Object.assign({}, it, { manual: true, why: "command" }), {})));
});

// ---------------------------------------------------------------- the other review items ----------------------
t("B1 across a restart: an older lost message stays manual when the newer one was already delivered before the restart", async () => {
  const A = Object.assign(L.create(AP, "go ahead and delete the old backups on the NAS", NOW - 180000), { state: "failed", written: true, attempts: 1, firstSentAt: NOW - 180000, newer: true });
  const B = Object.assign(L.create(AP, "actually do NOT delete anything yet, wait for me", NOW - 120000), { state: "seen", written: true, attempts: 1, seenAt: NOW - 100000 });
  const app = makeApp({ disk: L.serialize([A, B], NOW) }); await app.settle();
  app.session(AP);
  await app.run(120000);
  assert.strictEqual(app.sends.length, 0);
  assert.strictEqual(app.items().find((x) => x.id === A.id).why, "newer");
  const back = L.parse(L.serialize([A, B], NOW), NOW);
  assert.strictEqual(back.length, 2, "seen items are persisted and loaded (they mark what came after)");
  assert.strictEqual(back.find((x) => x.id === A.id).newer, true);
});

t("B1: two messages queued at a crash -> only the newest goes back to the queue; the older one gets Retry", async () => {
  const A = Object.assign(L.create(AP, "first queued message about the render", NOW - 90000), { state: "queued", newer: true });
  const B = Object.assign(L.create(AP, "second queued message about the render", NOW - 60000), { state: "queued" });
  const app = makeApp({ disk: L.serialize([A, B], NOW) }); await app.settle();
  const se = app.session(AP, { busy: true });
  await app.run(60000);
  assert.deepStrictEqual(se.sendQueue, [B.text]);
  assert.ok(se.pendingSent.some((p) => p.obId === A.id && p.failed));
});

t("S6: transcript cannot tell -> 'checking', then after 5 min 'cannot confirm', never sent automatically", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT);
  const p = failedBubble(app, TXT, id);
  se.pendingSent.push(p);
  app.seen.set(TXT, null);
  await app.run(60000);
  assert.ok(/checking the conversation/.test(app.outbox.pendingLabel(p)), app.outbox.pendingLabel(p));
  await app.run(6 * 60000, 5000);
  assert.ok(/Cannot confirm delivery/.test(app.outbox.pendingLabel(p)), app.outbox.pendingLabel(p));
  app.seen.set(TXT, "none");                     // even if it can tell later: once offered as Retry, never automatic
  await app.run(120000);
  assert.strictEqual(app.sends.length, 0);
});

t("S7: no automatic re-send while a dialog / approval prompt is open in the agent's CLI", async () => {
  const app = makeApp(); await app.settle();
  app.ctx.__dialog = true;
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT);
  se.pendingSent.push(failedBubble(app, TXT, id));
  await app.run(120000);
  assert.strictEqual(app.sends.length, 0);
  assert.ok(app.log.some((l) => /dialog/.test(l)));
  app.ctx.__dialog = false;
  await app.run(120000);
  assert.strictEqual(app.sends.length, 1);
});

t("S5: a failed save keeps the state in memory, warns once and saves again until it works", async () => {
  const app = makeApp(); await app.settle();
  app.session(AP, { busy: true });
  app.ctx.__saveFails = true;
  app.outbox.add(AP, TXT);
  await app.run(60000);
  const failed = app.saves.length;
  assert.ok(failed >= 2, "retried (" + failed + " saves)");
  assert.strictEqual(app.log.filter((l) => /could not save/.test(l)).length, 1, "warned once");
  assert.strictEqual(app.items().length, 1, "kept in memory");
  app.ctx.__saveFails = false;
  await app.run(30000);
  assert.ok(app.log.some((l) => /saving works again/.test(l)));
  assert.strictEqual(JSON.parse(app.saves[app.saves.length - 1]).items.length, 1);
});

t("N2: two identical long messages - the untagged bubble goes to the NEWEST item; the older is never requeued as a copy", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const a = app.outbox.add(AP, TXT); app.outbox.dispatched(a);
  se.pendingSent.push({ text: TXT, addedAt: app.now, sentAt: app.now, written: true, provisional: false, obId: a });
  await app.tick();
  se.pendingSent = [];                            // A settled
  app.seen.set(TXT, "user");
  app.advance(5000);
  const b = app.outbox.add(AP, TXT); app.outbox.dispatched(b);
  se.pendingSent.push({ text: TXT, addedAt: app.now, sentAt: app.now, written: true, provisional: false }); // untagged
  await app.tick();
  assert.strictEqual(se.pendingSent[0].obId, b, "claimed by the newer item");
  await app.run(30000);
  assert.strictEqual(app.sends.length + se.sendQueue.length, 0);
});

t("N3: over the cap, seen and sent items are dropped before unsent ones; dropping an unsent one is reported", () => {
  const list = [];
  for (let i = 0; i < L.MAX_ITEMS; i++) list.push(Object.assign(L.create(AP, "seen " + i, NOW - 5000 + i), { state: "seen", seenAt: NOW - 1000 }));
  const unsent = Object.assign(L.create(AP, "never written, oldest of all", NOW - 9000), { state: "queued" });
  list.push(unsent);
  const st = {};
  const back = L.parse(L.serialize(list, NOW, st), NOW);
  assert.ok(back.some((x) => x.id === unsent.id), "the unsent message survives");
  assert.strictEqual(st.droppedUnsent, 0);
  const all = []; for (let i = 0; i < L.MAX_ITEMS + 3; i++) all.push(L.create(AP, "unsent " + i, NOW - 5000 + i));
  const st2 = {};
  L.serialize(all, NOW, st2);
  assert.strictEqual(st2.droppedUnsent, 3, "reported, so the glue warns");
  const st3 = {};
  L.serialize([L.create(AP, "q".repeat(L.MAX_TEXT + 1), NOW)], NOW, st3);
  assert.strictEqual(st3.tooLong, 1);
});

t("decide: the order of the safety rules (pure)", () => {
  const it = (o) => Object.assign(L.create(AP, TXT, NOW - 60000), { written: true, attempts: 1, state: "failed" }, o);
  const c = (o) => Object.assign({ now: NOW, seen: "none", where: "pendingFailed", started: true, connected: true, inFlow: false, queueEmpty: true, idleForMs: 60000 }, o);
  assert.strictEqual(L.decide(it(), c()), "retry");
  assert.strictEqual(L.decide(it({ newer: true }), c()), "manual");
  assert.strictEqual(L.decide(it({ createdAt: NOW - L.MAX_AUTO_AGE_MS - 1 }), c()), "manual");
  assert.strictEqual(L.decide(it(), c({ paused: true })), "wait");
  assert.strictEqual(L.decide(it({ written: false, attempts: 0 }), c({ where: "absent", dispatching: true })), "wait");
  assert.strictEqual(L.decide(it({ written: false, attempts: 0 }), c({ where: "absent" })), "requeue");
  assert.strictEqual(L.decide(it(), c({ seen: null, unknownForMs: L.UNKNOWN_MANUAL_MS })), "manual");
  assert.strictEqual(L.decide(it(), c({ seen: null, unknownForMs: 1000 })), "wait");
  assert.strictEqual(L.decide(it({ manual: true }), c()), "manual", "sticky");
  assert.strictEqual(L.decide(it({ manual: true }), c({ seen: "user" })), "seen", "still confirmed when the transcript shows it");
  assert.strictEqual(L.blockReason(it({ text: "/model opus please and keep going" }), c()), "command");
});

// ---------------------------------------------------------------- re-review (R7-R9, F1, F2, "other") -------------
// A lost compose message A, then a later message B by some other path. setup() returns the failed bubble of A.
async function lostThenLater(app) {
  const se = app.session(AP);
  const A = "go ahead and delete the old backups on the NAS";
  const idA = app.outbox.add(AP, A); app.outbox.dispatched(idA);
  const pA = { text: A, addedAt: app.now, sentAt: app.now, written: true, provisional: false, obId: idA };
  se.pendingSent.push(pA);
  await app.tick();
  app.advance(5000);
  return { se, A, pA };
}
const B = "actually do NOT delete anything yet, wait for me";

t("R7 (F1) PHEME: phemeSend calls outbox.noteSend -> a lost compose message is not auto-re-sent after the dictated one", async () => {
  const app = makeApp(); await app.settle();
  const { se, A, pA } = await lostThenLater(app);
  app.outbox.noteSend(AP, "a later PHEME message");            // what phemeSend does first
  se.pendingSent.push({ text: B, addedAt: app.now, sentAt: app.now, written: true, provisional: false });
  app.seen.set(B, "user"); await app.tick();
  se.pendingSent = se.pendingSent.filter((p) => p.text !== B);
  pA.failed = true;
  await app.run(180000);
  assert.strictEqual(app.sends.filter((s) => s.text === A).length, 0);
  assert.ok(/you sent other messages after it/.test(app.outbox.pendingLabel(pA)));
});

t("R7b (F1) any untagged bubble that is not an app prompt supersedes too (the reviewer's R7 as written: no noteSend)", async () => {
  const app = makeApp(); await app.settle();
  const { se, A, pA } = await lostThenLater(app);
  se.pendingSent.push({ text: B, addedAt: app.now, sentAt: app.now, written: true, provisional: false }); // PHEME / Library / tools
  await app.tick();
  app.seen.set(B, "user");
  se.pendingSent = se.pendingSent.filter((p) => p.text !== B);
  pA.failed = true;
  await app.run(180000);
  assert.strictEqual(app.sends.filter((s) => s.text === A).length, 0);
});

t("R7c app prompts (handoff, keep-going, wake note, IRIS, [hid:]) do NOT supersede: A is still re-sent once", async () => {
  const app = makeApp(); await app.settle();
  const { se, A, pA } = await lostThenLater(app);
  for (const txt of ["[Agent-to-agent note relayed by Agent Desktop from the COO agent - NOT typed by Alex.] check X",
    "[IRIS] New message from linked peer p1. Read it ...", "Please carry on with the next step you announced, now, using tool calls.",
    "[hid:abc123] [Agent Desktop - planned context reset] ...", "[[HANDOFF-RESUME]] D:\\x.md"]) {
    se.pendingSent.push({ text: txt, addedAt: app.now, sentAt: app.now, written: true, provisional: false });
  }
  await app.tick();
  se.pendingSent = se.pendingSent.filter((p) => p === pA);
  pA.failed = true;
  await app.run(120000);
  assert.strictEqual(app.sends.filter((s) => s.text === A).length, 1);
});

t("R7d Raw Terminal / unknown form: an unexplained later user entry in the transcript ('other') -> Retry button, never automatic", async () => {
  const app = makeApp(); await app.settle();
  const { se, A, pA } = await lostThenLater(app);
  pA.failed = true;
  app.seen.set(A, "other");
  await app.run(180000);
  assert.strictEqual(app.sends.length, 0);
  const it = app.items()[0];
  assert.strictEqual(it.why, "later");
  assert.ok(/other messages arrived in this conversation after it/.test(app.outbox.pendingLabel(pA)), app.outbox.pendingLabel(pA));
  app.seen.set(A, "none");
  await app.run(60000);
  assert.strictEqual(app.sends.length, 0, "sticky");
  void se;
});

t("'other' rule (pure): later typed text -> other; the app's own prompts and markup -> none; ours -> user", () => {
  const iso = (ms) => new Date(ms).toISOString();
  const u = (text, ms, extra) => JSON.stringify(Object.assign({ type: "user", message: { role: "user", content: text }, timestamp: iso(ms) }, extra || {}));
  const mine = "please run the full NAS backup check and report back";
  const app = [
    u("[[HANDOFF-RESUME]] D:\\handoff.md\nContinue from the handoff", NOW + 1000),
    u("[Agent Desktop - planned context reset] Alex approved ...", NOW + 2000),
    u("[[KEEPGOING]] You ended your last turn announcing a next step ...", NOW + 3000),
    u("[Agent-to-agent note relayed by Agent Desktop from the COO agent - NOT typed by Alex.] ...", NOW + 4000),
    u("[IRIS] New note from linked peer p1 ...", NOW + 5000),
    u("[hid:abc] hello", NOW + 6000),
    u("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>", NOW + 7000),
    u("<local-command-stdout>ok</local-command-stdout>", NOW + 8000),
    u("<bash-input>git status</bash-input>", NOW + 9000),
    u("Caveat: The messages below were generated by the user while running local commands.", NOW + 10000),
    u("This session is being continued from a previous conversation that ran out of context.", NOW + 11000, { isCompactSummary: true }),
    u("[Request interrupted by user]", NOW + 12000),
    u("meta text the CLI adds", NOW + 13000, { isMeta: true }),
    u("an older message from before the send", NOW - 60000),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "done" }] }, timestamp: iso(NOW + 14000) }),
  ];
  assert.strictEqual(L.scanTranscripts([{ lines: app, current: true }], mine, NOW), "none");
  assert.strictEqual(L.scanTranscripts([{ lines: app.concat([u("no wait, stop the backup check", NOW + 20000)]), current: true }], mine, NOW), "other");
  assert.strictEqual(L.scanTranscripts([{ lines: app.concat([u("no wait", NOW + 20000), u(mine, NOW + 21000)]), current: true }], mine, NOW), "user", "found wins");
  assert.strictEqual(L.decide(Object.assign(L.create(AP, mine, NOW - 60000), { written: false }), { now: NOW, seen: "other", where: "absent", started: true, connected: true, queueEmpty: true }), "manual", "not requeued either");
});

t("R8 clock set back 1 h: in-run age and idle time come from performance.now(), so nothing goes out after 10 real minutes", async () => {
  const app = makeApp({ mono: true }); await app.settle();
  const se = app.session(AP, { busy: true });     // busy: no re-send is possible before the 10 real minutes are over
  const id = app.outbox.add(AP, TXT); app.outbox.dispatched(id);
  se.pendingSent.push({ text: TXT, addedAt: app.now, sentAt: app.now, written: true, provisional: false, failed: true, obId: id });
  await app.run(4 * 60000, 5000);
  app.jumpWall(-3600e3);                          // wall clock now says the message is from the future
  await app.run(7 * 60000, 5000);                 // 11 real minutes after Send
  se.busy = false;
  await app.run(3 * 60000);
  assert.strictEqual(app.sends.length, 0, "re-sent 11+ real minutes after Send");
  assert.strictEqual(app.items()[0].why, "old");
});

t("R8b idle time is monotonic: a wall clock set back does not delay a legitimate re-send by an hour", async () => {
  const app = makeApp({ mono: true }); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT); app.outbox.dispatched(id);
  se.pendingSent.push({ text: TXT, addedAt: app.now, sentAt: app.now, written: true, provisional: false, failed: true, obId: id });
  await app.tick();
  app.jumpWall(-3600e3);
  await app.run(90000);
  assert.strictEqual(app.sends.length, 1);
});

t("R9 a command behind RLM / LRM / zero-width / BOM / NBSP / newline / tab is still a command; '#' is not (CLI 2.1.273 stores it as text)", () => {
  for (const pre of ["\u200f", "\u200e", "\u200b", "\ufeff", "\u00a0", "\n\n  ", "\t", "\u2060"]) assert.ok(L.isCommand(pre + "/compact keep the NAS backup plan details"), "U+" + pre.charCodeAt(0).toString(16));
  assert.ok(!L.isCommand("# Heading of a pasted note with enough text"));
  assert.ok(!L.isCommand("שלום /compact"));
});

t("Retry on 'Cannot confirm delivery' asks first; No sends nothing, Yes sends once", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT); app.outbox.dispatched(id);
  const p = failedBubble(app, TXT, id);
  se.pendingSent.push(p);
  app.seen.set(TXT, null);
  await app.run(7 * 60000, 5000);
  assert.strictEqual(app.items()[0].why, "unknown");
  let asked = 0;
  app.ctx.confirm = () => { asked++; return false; };
  app.outbox.retryNow(p); await app.settle();
  assert.strictEqual(asked, 1); assert.strictEqual(app.sends.length, 0);
  app.ctx.confirm = () => { asked++; return true; };
  app.outbox.retryNow(p); await app.settle();
  assert.strictEqual(app.sends.length, 1);
});

t("wiring (F1): phemeSend and the Library send call noteSend; wake-agent passes origin 'wake' and does not", () => {
  const r = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf8");
  const ph = r.slice(r.indexOf("async function phemeSend("), r.indexOf("window.api.onPhemeRequest"));
  assert.ok(ph.indexOf("window.outbox.noteSend(agentPath") > 0 && ph.indexOf("window.outbox.noteSend(") < ph.indexOf("sendOrHold("));
  const lib = r.slice(r.indexOf("async send(agentPath, text, origin)"), r.indexOf("async dictate("));
  assert.ok(/if \(origin !== "wake"\)[^\n]*noteSend\(agentPath/.test(lib) && lib.indexOf("noteSend") < lib.indexOf("sendOrHold("));
  assert.ok(/libraryBridge\.send\(agent\.path, String\(req\.text \|\| ""\), "wake"\)/.test(r));
});

t("wiring: Send marks the outbox item dispatched after deliverChatMessage, in a finally (S1)", () => {
  const r = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf8");
  const send = r.slice(r.indexOf("async function sendChatInput()"), r.indexOf("async function deliverChatMessage("));
  const fin = send.indexOf("finally");
  assert.ok(fin > send.indexOf("await deliverChatMessage(") && send.indexOf("window.outbox.dispatched(obId)") > fin);
  const strip = /\[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\]/;
  assert.ok(strip.test(fs.readFileSync(path.join(__dirname, "..", "src", "outbox.js"), "utf8")), "same character class as pasteText.js / submitToAgent");
  assert.strictEqual(String(L.PASTE_UNSAFE_RE), String(require("../src/pasteText").PASTE_UNSAFE_RE));
});

(async () => {
  let fails = 0;
  for (const x of tests) {
    try { await x.f(); } catch (e) { fails++; console.error("FAIL " + x.n + "\n  " + (e && e.stack || e)); }
  }
  console.log(`outboxRaces: ${tests.length - fails}/${tests.length} passed`);
  process.exit(fails ? 1 : 0);
})();
