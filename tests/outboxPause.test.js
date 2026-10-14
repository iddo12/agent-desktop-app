// node tests/outboxPause.test.js - v1.110.0 outbox blockers from the real-app run (TIER3_REPORT.md):
//  B1 "paused" must come from main (an event when main pauses/resumes + an ask right before any automatic send, failing closed)
//  B2 a written, unconfirmed message with no bubble (after Restart Session / app restart) is shown at once, calmly.
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

// a written, unconfirmed message whose bubble has gone because the session object was replaced (Restart Session)
async function lostBubble(app, text) {
  const se = app.session(AP);
  const id = app.outbox.add(AP, text);
  se.pendingSent.push({ text: L.clean(text), addedAt: app.now, sentAt: app.now, written: true, provisional: false, obId: id });
  await app.tick();
  app.outbox.dispatched(id);
  const se2 = app.session(AP);        // Restart Session: a new session object, the old bubble is gone
  return { id, se2 };
}

t("B1 stale list: the window's agent list says running, main says paused (budget guard): no automatic re-send", async () => {
  const app = makeApp({ agents: [{ path: AP, paused: false }] }); await app.settle();
  const { se2 } = await lostBubble(app, TXT);
  app.ctx.__mainPaused = true;                   // the disk / main process knows; the window's list does not
  await app.run(120000);
  assert.strictEqual(app.sends.length, 0, "re-sent into an agent main had paused");
  assert.ok(app.log.some((l) => /agent is paused \(or main could not say\)/.test(l)), app.log.join("\n"));
  assert.ok(se2.pendingSent.length >= 1);
});

t("B1 event: main announces the pause, the outbox knows at once; a resume event lets it go once", async () => {
  const app = makeApp({ agents: [{ path: AP, paused: false }] }); await app.settle();
  const { se2 } = await lostBubble(app, TXT);
  app.ctx.__mainPaused = true;
  app.ctx.__pausedCb({ agentPath: AP, paused: true });
  assert.strictEqual(app.ctx.outbox._paused(AP), true);
  assert.strictEqual(app.ctx.agents[0].paused, true, "the window's own agent list was updated too");
  await app.run(120000);
  assert.strictEqual(app.sends.length, 0);
  assert.ok(/paused/.test(app.outbox.pendingLabel(se2.pendingSent[0])), app.outbox.pendingLabel(se2.pendingSent[0]));
  app.ctx.__mainPaused = false;
  app.ctx.__pausedCb({ agentPath: AP, paused: false });
  await app.run(60000);
  assert.strictEqual(app.sends.length, 1, "after the resume it is sent once, got " + app.sends.length);
});

t("B1 fail closed: main errors, says null, or the call is missing -> no automatic re-send", async () => {
  for (const mode of ["throw", "null", "missing"]) {
    const app = makeApp({ agents: [{ path: AP, paused: false }] }); await app.settle();
    if (mode === "throw") app.ctx.api.agentIsPaused = () => Promise.reject(new Error("ipc down"));
    if (mode === "null") app.ctx.api.agentIsPaused = () => Promise.resolve(null);
    if (mode === "missing") delete app.ctx.api.agentIsPaused;
    await lostBubble(app, TXT);
    await app.run(120000);
    assert.strictEqual(app.sends.length, 0, mode + ": sent without a definite 'not paused'");
  }
});

t("B1 control: main says not paused -> the one automatic re-send still happens", async () => {
  const app = makeApp({ agents: [{ path: AP, paused: false }] }); await app.settle();
  await lostBubble(app, TXT);
  await app.run(120000);
  assert.strictEqual(app.sends.length, 1, "expected exactly one automatic re-send, got " + app.sends.length);
});

t("B1 requeue: a never-written message restored from disk is not put back in the queue while main says paused; it is visible", async () => {
  const it = Object.assign(L.create(AP, TXT, NOW - 60000), { state: "queued" });
  const app = makeApp({ disk: L.serialize([it], NOW), agents: [{ path: AP, paused: false }] }); await app.settle();
  app.ctx.__mainPaused = true;
  const se = app.session(AP);
  await app.run(90000);
  assert.strictEqual(se.sendQueue.length, 0, "requeued into a paused agent");
  assert.strictEqual(app.sends.length, 0);
  const w = se.pendingSent.find((p) => p.outboxWaiting);
  assert.ok(w, "no visible bubble for the waiting message");
  assert.ok(/Not sent yet - waiting, the agent is paused/.test(app.outbox.pendingLabel(w)), app.outbox.pendingLabel(w));
});

t("B2 after Restart Session a sent-but-unconfirmed message is shown at once as 'Sent - waiting for confirmation' (once, calm)", async () => {
  const app = makeApp({ agents: [{ path: AP, paused: true }] }); await app.settle();
  const { se2 } = await lostBubble(app, TXT);
  await app.run(30000);
  const bubbles = se2.pendingSent.filter((p) => p.text === TXT);
  assert.strictEqual(bubbles.length, 1, "expected exactly one bubble, got " + bubbles.length);
  assert.strictEqual(bubbles[0].failed, false, "must not be the red failed bubble");
  assert.strictEqual(app.outbox.pendingLabel(bubbles[0]), "Sent - waiting for confirmation (the agent is paused)");
  assert.strictEqual(app.sends.length, 0);
});

t("B2 not paused but busy: label without the paused note; then the transcript confirms -> bubble removed", async () => {
  const app = makeApp({ agents: [{ path: AP, paused: false }] }); await app.settle();
  const { se2 } = await lostBubble(app, TXT);
  se2.busy = true;                                // busy: the outbox waits
  await app.run(10000);
  const w = se2.pendingSent.find((p) => p.outboxWaiting);
  assert.ok(w, "no waiting bubble");
  assert.strictEqual(app.outbox.pendingLabel(w), "Sent - waiting for confirmation");
  app.seen.set(TXT, "user");
  await app.run(40000);
  assert.strictEqual(se2.pendingSent.filter((p) => p.text === TXT).length, 0, "the waiting bubble stayed after delivery was confirmed");
  assert.strictEqual(app.sends.length, 0);
});

t("B2 still waiting after 10 minutes: the calm bubble becomes the normal 'Not delivered' bubble (one bubble)", async () => {
  const app = makeApp({ agents: [{ path: AP, paused: true }] }); await app.settle();
  const { se2 } = await lostBubble(app, TXT);
  await app.run(11 * 60000);
  const bubbles = se2.pendingSent.filter((p) => p.text === TXT);
  assert.strictEqual(bubbles.length, 1, "bubbles: " + bubbles.length);
  assert.strictEqual(bubbles[0].failed, true);
  assert.ok(/Not delivered/.test(app.outbox.pendingLabel(bubbles[0])), app.outbox.pendingLabel(bubbles[0]));
  assert.strictEqual(app.sends.length, 0);
});

t("B2 a normal delivery does not flash a waiting bubble", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT);
  const p = { text: TXT, addedAt: app.now, sentAt: app.now, written: true, provisional: false, obId: id };
  se.pendingSent.push(p);
  await app.tick(); app.outbox.dispatched(id);
  se.pendingSent = se.pendingSent.filter((x) => x !== p);   // the chat view matched it to the transcript
  app.seen.set(TXT, "user");
  await app.run(20000);
  assert.strictEqual(se.pendingSent.length, 0);
  assert.strictEqual(app.items()[0].state, "seen");
});

(async () => {
  let pass = 0;
  for (const x of tests) {
    try { await x.f(); pass++; } catch (e) { console.error("FAIL: " + x.n + "\n  " + (e && e.stack || e)); }
  }
  console.log("outboxPause: " + pass + "/" + tests.length + " passed");
  process.exit(pass === tests.length ? 0 : 1);
})();
