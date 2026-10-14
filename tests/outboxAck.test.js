// node tests/outboxAck.test.js - v1.100.0 message outbox with acknowledgement (src/outbox.js, src/renderer/outbox.js,
// the outbox IPCs in src/guards-main.js). Pure logic first, then the renderer glue in a vm with fake app globals
// (crash/restart, duplicate suppression, handoff hold/release, dead link, long message, Hebrew), then main's IPCs on
// real temp files.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const L = require("../src/outbox");

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
const NOW = 1_800_000_000_000;
const iso = (ms) => new Date(ms).toISOString();
const userLine = (text, ms) => JSON.stringify({ type: "user", message: { role: "user", content: text }, timestamp: iso(ms) });
const enqLine = (text, ms) => JSON.stringify({ type: "queue-operation", operation: "enqueue", content: text, timestamp: iso(ms) });
const remLine = (text, ms) => JSON.stringify({ type: "queue-operation", operation: "remove", content: text, timestamp: iso(ms) });
const qcLine = (text, ms) => JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: text }, timestamp: iso(ms) });
const LONG_REF = 'This message was too long to paste directly, so it was saved to a file - please read it: "E:\\Tmp\\agent-desktop-messages\\msg-1800000000000-ab12cd.md"';
const HEB = "שלום, תבדוק בבקשה את הדוח של אתמול ותגיד לי מה חסר";

// ---------------------------------------------------------------- pure logic: needles and the transcript ack -----
t("needle: long-message reference matches by its unique file name, never by the path text", () => {
  const nd = L.needleFor(LONG_REF);
  assert.ok(nd.ref && nd.strong); assert.strictEqual(nd.fp, "msg-1800000000000-ab12cd.md");
});
t("needle: short text is weak (never re-sent automatically), 20+ chars is strong; Hebrew counts characters", () => {
  assert.strictEqual(L.needleFor("yes").strong, false);
  assert.strictEqual(L.needleFor("here?").strong, false);
  assert.strictEqual(L.needleFor("please continue with the shorts").strong, true);
  assert.strictEqual(L.needleFor(HEB).strong, true);
});
t("ack: a user entry AFTER the send = seen; the same text BEFORE the send does not count", () => {
  assert.strictEqual(L.scanTranscripts([{ lines: [userLine("deploy it now please, all four sites", NOW + 3000)], current: true }], "deploy it now please, all four sites", NOW), "user");
  assert.strictEqual(L.scanTranscripts([{ lines: [userLine("deploy it now please, all four sites", NOW - 60000)], current: true }], "deploy it now please, all four sites", NOW), "none");
});
t("ack: queued_command attachment = seen (mid-turn message read at the next step)", () => {
  assert.strictEqual(L.scanTranscripts([{ lines: [qcLine("check the NAS snapshots again please", NOW + 1000)], current: true }], "check the NAS snapshots again please", NOW), "user");
});
t("ack: CLI enqueue receipt counts only in the CURRENT transcript; a remove cancels it", () => {
  const txt = "look at the render queue when you can";
  assert.strictEqual(L.scanTranscripts([{ lines: [enqLine(txt, NOW + 1000)], current: true }], txt, NOW), "queued");
  assert.strictEqual(L.scanTranscripts([{ lines: [], current: true }, { lines: [enqLine(txt, NOW + 1000)], current: false }], txt, NOW), "none", "receipt died with the old process");
  assert.strictEqual(L.scanTranscripts([{ lines: [enqLine(txt, NOW + 1000), remLine(txt, NOW + 2000)], current: true }], txt, NOW), "none");
});
t("ack: a message delivered to the OLD session before a reset still counts as seen (never sent twice)", () => {
  const txt = "write the summary for Alex before the reset";
  assert.strictEqual(L.scanTranscripts([{ lines: [], current: true }, { lines: [userLine(txt, NOW + 500)], current: false }], txt, NOW), "user");
});
t("ack: long message by file reference; Hebrew text; pasted_content wrapper", () => {
  assert.strictEqual(L.scanTranscripts([{ lines: [userLine(LONG_REF, NOW + 900)], current: true }], LONG_REF, NOW), "user");
  assert.strictEqual(L.scanTranscripts([{ lines: [userLine(HEB, NOW + 900)], current: true }], HEB, NOW), "user");
  assert.strictEqual(L.scanTranscripts([{ lines: [userLine('<pasted_content id="1">' + HEB + "</pasted_content>", NOW + 900)], current: true }], HEB, NOW), "user");
});
t("ack: short text merged with a leftover in the input box (10-07 UI-UX '/remote-controlhere?') = seen", () => {
  assert.strictEqual(L.scanTranscripts([{ lines: [userLine("/remote-controlhere?", NOW + 6000)], current: true }], "here?", NOW), "user");
  assert.strictEqual(L.scanTranscripts([{ lines: [userLine("is it there?", NOW + 120000)], current: true }], "here?", NOW), "other", "only right after the send (later: another message, never 'seen')");
});
t("ack: a cut tail that does not reach back to the send time cannot prove 'not there' (null)", () => {
  const txt = "the message we are looking for here";
  assert.strictEqual(L.scanTranscripts([{ lines: [userLine("[Agent Desktop] session restarted", NOW + 90000)], current: true, truncated: true }], txt, NOW), null);
  assert.strictEqual(L.scanTranscripts([{ lines: [userLine("older", NOW - 5000), userLine("[[KEEPGOING]] carry on", NOW + 9000)], current: true, truncated: true }], txt, NOW), "none");
  assert.strictEqual(L.scanTranscripts([{ lines: [userLine("something else entirely", NOW + 90000)], current: true, truncated: true }], txt, NOW), "other", "a later message of his decides it even on a cut tail");
});

// ---------------------------------------------------------------- pure logic: the retry decision ------------------
const item = (o) => Object.assign(L.create("D:\\A", "please re-run the backup check on the NAS", NOW - 120000), { written: true, attempts: 1, firstSentAt: NOW - 120000, lastSentAt: NOW - 120000, state: "failed" }, o);
const ctx = (o) => Object.assign({ now: NOW, seen: "none", where: "pendingFailed", started: true, connected: true, inFlow: false, queueEmpty: true, idleForMs: 60000, boxHolds: false }, o);
t("decide: provably missing, idle, connected -> retry; seen -> seen", () => {
  assert.strictEqual(L.decide(item(), ctx()), "retry");
  assert.strictEqual(L.decide(item(), ctx({ seen: "user" })), "seen");
});
t("decide (no duplicates): unknown, CLI-queued, in flight, in the app queue or held -> wait", () => {
  for (const c of [{ seen: null }, { seen: "queued" }, { where: "pending" }, { where: "queue" }, { where: "held" }]) assert.strictEqual(L.decide(item(), ctx(c)), "wait", JSON.stringify(c));
});
t("decide: handoff in progress, link down, session not started -> wait (held, released later)", () => {
  assert.strictEqual(L.decide(item(), ctx({ inFlow: true })), "wait");
  assert.strictEqual(L.decide(item(), ctx({ connected: false })), "wait");
  assert.strictEqual(L.decide(item(), ctx({ started: false })), "wait");
});
t("decide: busy / not idle long enough / earlier messages queued / text in the input box / backoff -> wait", () => {
  assert.strictEqual(L.decide(item(), ctx({ idleForMs: 5000 })), "wait");
  assert.strictEqual(L.decide(item(), ctx({ queueEmpty: false })), "wait");
  assert.strictEqual(L.decide(item(), ctx({ boxHolds: true })), "wait");
  assert.strictEqual(L.decide(item({ nextRetryAt: NOW + 1000 }), ctx()), "wait");
});
t("decide: never written + gone from the app -> requeue (no duplicate possible); short text -> manual; 3 sends -> give-up", () => {
  assert.strictEqual(L.decide(item({ written: false, attempts: 0, state: "queued" }), ctx({ where: "absent" })), "requeue");
  assert.strictEqual(L.decide(item({ text: "yes" }), ctx()), "manual");
  assert.strictEqual(L.decide(item({ attempts: 3, state: "sent" }), ctx()), "give-up");
  assert.strictEqual(L.decide(item({ attempts: 3, state: "failed" }), ctx()), "give-up", "stays given up (the glue reports it once)");
});
t("backoff: 30 s, 60 s, 120 s, capped at 5 min", () => {
  assert.deepStrictEqual([1, 2, 3, 9].map(L.backoffMs), [30000, 60000, 120000, 300000]);
});
t("labels: waiting reasons, retrying, given up, short message; never the file path", () => {
  const q = { state: "queued", attempts: 0, text: LONG_REF };
  assert.ok(/new session/.test(L.label(q, { where: "queue", reason: "handoff" })));
  assert.ok(/reconnect/.test(L.label(q, { where: "held", reason: "reconnect" })));
  assert.ok(/busy/.test(L.label(q, { where: "queue", reason: "busy" })));
  assert.ok(/sends it again automatically, once/.test(L.label(item({ lastSeen: "none" }), {})));
  assert.ok(/Not delivered after 2 tries/.test(L.label(item({ attempts: 2, lastSeen: "none" }), {})), "F2: one automatic re-send, then given up");
  assert.ok(/checking the conversation/.test(L.label(item(), {})) && !/automatically/.test(L.label(item(), {})), "S6: no promise until the check could tell");
  assert.ok(/Not delivered after 3 tries/.test(L.label(item({ attempts: 3 }), {})));
  assert.ok(/check the conversation/.test(L.label(item({ text: "ok" }), {})));
  for (const s of ["queued", "sent", "failed", "seen"]) assert.ok(!/msg-1800/.test(L.label({ state: s, attempts: 1, text: LONG_REF }, { where: "queue" })));
});
t("dead link notice: reconnecting first, Restart session after two failed automatic attempts or degraded", () => {
  assert.strictEqual(L.connectionNotice({ state: "connected" }), null);
  assert.strictEqual(L.connectionNotice({ state: "reconnecting", attempts: 0 }, 1).restart, false);
  assert.ok(/1 message is kept/.test(L.connectionNotice({ state: "reconnecting", attempts: 0 }, 1).text));
  assert.strictEqual(L.connectionNotice({ state: "reconnecting", attempts: 2 }, 0).restart, true);
  assert.strictEqual(L.connectionNotice({ state: "degraded", attempts: 0 }, 2).restart, true);
  assert.strictEqual(L.connectionNotice({ state: "restarting" }, 0).restart, false);
});

// ---------------------------------------------------------------- pure logic: persistence -----------------------
t("persist: round trip, no BOM, Hebrew intact, cancelled/expired/old-seen dropped, capped, corrupt -> empty", () => {
  const a = L.create("D:\\A", HEB, NOW - 1000), b = L.create("D:\\A", "x", NOW - L.TTL_MS - 1), c = Object.assign(L.create("D:\\A", "y", NOW - 1000), { state: "cancelled" });
  const d = Object.assign(L.create("D:\\A", "z", NOW - 1000), { state: "seen", seenAt: NOW - L.KEEP_SEEN_MS - 1 });
  const json = L.serialize([a, b, c, d], NOW);
  assert.notStrictEqual(json.charCodeAt(0), 0xfeff);
  const back = L.parse(json, NOW);
  assert.strictEqual(back.length, 1); assert.strictEqual(back[0].text, HEB); assert.strictEqual(back[0].id, a.id); assert.strictEqual(back[0].disk, true);
  assert.strictEqual(L.parse("\uFEFF" + json, NOW).length, 1, "a BOM written by someone else is tolerated");
  assert.deepStrictEqual(L.parse("{broken", NOW), []);
  const many = []; for (let i = 0; i < L.MAX_ITEMS + 50; i++) many.push(L.create("D:\\A", "m" + i, NOW - 1000 + i));
  assert.strictEqual(L.parse(L.serialize(many, NOW), NOW).length, L.MAX_ITEMS);
  assert.strictEqual(L.parse(L.serialize([L.create("D:\\A", "q".repeat(L.MAX_TEXT + 1), NOW)], NOW), NOW).length, 0, "oversized text is not persisted");
});

// ---------------------------------------------------------------- renderer glue in a vm ------------------------
function makeApp(opts) {
  const o = opts || {};
  let clock = o.now || NOW;
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } }
  const log = [], sends = [], saves = [];
  const seenMap = new Map(); // text -> "user"|"queued"|"none"|null
  const sessions = new Map();
  const ctxObj = {
    console, Promise, Map, Set, Array, Object, JSON, Math, String, Number, RegExp, Error, Date: FakeDate,
    setInterval: (fn) => { ctxObj.__tick = fn; return 1; }, setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {},
    terminals: sessions, activeAgentPath: o.active || "D:\\A",
    renderQueue: () => {}, renderChatBlocks: () => {},
    setBusy: (ap, se) => { if (se.sendQueue.length && se.started && !se.busy) { const x = se.sendQueue.shift(); ctxObj.sendOrHold(ap, se, x, null); } },
    // like the real path: submitToAgent strips C0/C1 before the bubble is drawn (S3 / N9)
    sendOrHold: async (ap, se, text) => { sends.push({ ap, text }); se.pendingSent.push({ text: L.clean(text), addedAt: clock, sentAt: clock, written: true, provisional: false }); return "sent"; },
  };
  ctxObj.window = ctxObj; ctxObj.globalThis = ctxObj;
  ctxObj.api = {
    outboxSave: (json) => { saves.push(json); return Promise.resolve({ ok: true }); },
    outboxLoad: () => Promise.resolve({ ok: true, json: o.disk || "{}" }),
    outboxSeen: (ap, text) => Promise.resolve({ seen: seenMap.has(text) ? seenMap.get(text) : "none" }),
    agentInputHoldsText: () => Promise.resolve(!!o.boxHolds),
    agentDialogOpen: () => Promise.resolve(!!ctxObj.__dialog),
    // v1.110.0 (B1): main's answer = the disk. Defaults to what the test's agent list says; tests set ctx.__mainPaused to diverge.
    agentIsPaused: (ap) => Promise.resolve(ctxObj.__mainPaused !== undefined ? ctxObj.__mainPaused : !!((ctxObj.agents || []).find((x) => x && x.path === ap) || {}).paused),
    onAgentPausedChanged: (cb) => { ctxObj.__pausedCb = cb; },
    getTranscriptQuietMs: () => Promise.resolve(o.quietMs == null ? 60000 : o.quietMs),
    logGuard: (l) => log.push(l),
  };
  ctxObj.guardsParkedState = () => Array.from((ctxObj.__parked || new Map()).entries());
  ctxObj.guardsAgentInFlow = (ap) => !!(ctxObj.__flow && ctxObj.__flow.has(ap));
  ctxObj.connHealth = { _states: new Map(), holding: (ap) => ctxObj.connHealth._states.has(ap) };
  ctxObj.agents = o.agents || [];
  vm.createContext(ctxObj);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "outbox.js"), "utf8"), ctxObj);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "outbox.js"), "utf8"), ctxObj);
  const app = {
    ctx: ctxObj, log, sends, saves, seen: seenMap,
    advance(ms) { clock += ms; },
    get now() { return clock; },
    session(ap, s) { const se = Object.assign({ started: true, busy: false, transcriptWorking: false, sendQueue: [], pendingSent: [], lastBlocks: [] }, s || {}); sessions.set(ap, se); return se; },
    async settle() { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); },
    async tick(n) { for (let i = 0; i < (n || 1); i++) { ctxObj.__tick && ctxObj.__tick(); await app.settle(); } },
    // tick, wait 3 s, tick again (the ack answer arrives between ticks), repeated
    async run(ms, step) { const s = step || 3000; for (let x = 0; x < ms; x += s) { await app.tick(); clock += s; } await app.tick(); },
    get outbox() { return ctxObj.outbox; },
    items() { return ctxObj.outbox._state(); },
  };
  return app;
}
const AP = "D:\\A";
const TXT = "please run the full NAS backup check and report back";

t("glue: Send creates an item on disk at once; bind swaps in the file reference of a long message", async () => {
  const app = makeApp(); await app.settle();
  app.session(AP);
  const id = app.outbox.add(AP, "x".repeat(900));
  assert.ok(id && app.saves.length >= 1, "saved at Send time, before any await");
  app.outbox.bind(id, LONG_REF);
  const last = JSON.parse(app.saves[app.saves.length - 1]);
  assert.strictEqual(last.items[0].text, LONG_REF, "the persisted text is what is actually sent (the reference), not 900 chars");
  assert.ok(!/E:\\\\Tmp/.test(app.outbox.queueLabel(AP, LONG_REF)), "queue label never shows the path");
});

t("glue: delivered normally -> chat view settles the bubble -> ONE transcript check confirms -> seen, nothing re-sent", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT);
  se.pendingSent.push({ text: TXT, addedAt: app.now, sentAt: app.now, written: true, provisional: false, obId: id });
  await app.tick();
  app.seen.set(TXT, "user");
  se.pendingSent = []; // rebuildChatView matched it
  await app.run(120000);
  assert.strictEqual(app.sends.length, 0);
  assert.strictEqual(app.items().find((x) => x.id === id).state, "seen");
  assert.ok(app.log.some((l) => /transcript confirms/.test(l)));
});

t("glue (S3): the bubble left the chat but the time-filtered transcript does NOT have it -> not 'delivered'", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT);
  se.pendingSent.push({ text: TXT, addedAt: app.now, sentAt: app.now, written: true, provisional: false, obId: id });
  await app.tick();
  se.pendingSent = []; // the chat view "matched" an OLD identical message (no time filter there)
  await app.run(10000);
  const it = app.items().find((x) => x.id === id);
  assert.notStrictEqual(it.state, "seen", "no transcript proof -> never marked delivered");
  assert.ok(!app.log.some((l) => /delivered/.test(l)));
});

t("glue (crash/restart): a message that was only QUEUED when the app died goes back to the queue exactly once", async () => {
  const it = Object.assign(L.create(AP, TXT, NOW - 60000), { state: "queued" });
  const app = makeApp({ disk: L.serialize([it], NOW) }); await app.settle();
  const se = app.session(AP, { busy: true }); // busy: the requeued message waits in the queue
  await app.run(10000);
  assert.strictEqual(se.sendQueue.length, 0, "nothing during the startup grace");
  await app.run(60000);
  assert.deepStrictEqual(se.sendQueue, [TXT], "requeued once");
  await app.run(60000);
  assert.deepStrictEqual(se.sendQueue, [TXT], "never twice");
  assert.strictEqual(app.sends.length, 0);
});

t("glue (crash/restart): a WRITTEN message the transcript does not have is re-sent once the agent is idle; never twice", async () => {
  const it = Object.assign(L.create(AP, TXT, NOW - 60000), { state: "sent", written: true, attempts: 1, firstSentAt: NOW - 60000, lastSentAt: NOW - 60000 });
  const app = makeApp({ disk: L.serialize([it], NOW) }); await app.settle();
  app.session(AP);
  await app.run(90000);
  assert.strictEqual(app.sends.length, 1, "one re-send");
  assert.strictEqual(app.items()[0].attempts, 2);
  await app.run(20000);
  assert.strictEqual(app.sends.length, 1, "the new pending bubble is in flight: no second send");
  app.seen.set(TXT, "user"); app.ctx.terminals.get(AP).pendingSent = [];
  await app.run(30000);
  assert.strictEqual(app.items()[0].state, "seen");
  assert.strictEqual(app.sends.length, 1);
});

t("glue (no duplicate): restart, transcript HAS it -> seen without sending; CLI-queued -> no send", async () => {
  for (const ans of ["user", "queued"]) {
    const it = Object.assign(L.create(AP, TXT, NOW - 60000), { state: "sent", written: true, attempts: 1, firstSentAt: NOW - 60000 });
    const app = makeApp({ disk: L.serialize([it], NOW) }); await app.settle();
    app.seen.set(TXT, ans); app.session(AP);
    await app.run(120000);
    assert.strictEqual(app.sends.length, 0, ans);
    if (ans === "user") assert.strictEqual(app.items()[0].state, "seen");
  }
});

t("glue (no duplicate): a failed bubble whose text is in the transcript is cleared (false Not-confirmed), not re-sent", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT);
  se.pendingSent.push({ text: TXT, addedAt: app.now, sentAt: app.now, written: true, provisional: false, failed: true, obId: id });
  app.seen.set(TXT, "user");
  await app.run(60000);
  assert.strictEqual(app.sends.length, 0);
  assert.strictEqual(se.pendingSent.length, 0, "the red bubble is gone, the transcript shows the message");
});

t("glue (no duplicate): a short message is never re-sent automatically; Retry re-checks the transcript first", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, "yes");
  const p = { text: "yes", addedAt: app.now, sentAt: app.now, written: true, provisional: false, failed: true, obId: id };
  se.pendingSent.push(p);
  await app.run(200000);
  assert.strictEqual(app.sends.length, 0);
  assert.ok(/check the conversation/.test(app.outbox.pendingLabel(p)));
  app.seen.set("yes", "user");
  assert.strictEqual(app.outbox.retryNow(p), true); await app.settle();
  assert.strictEqual(app.sends.length, 0, "Retry found it in the transcript: no duplicate");
  app.seen.set("yes", "none");
  const id2 = app.outbox.add(AP, "no");
  const p2 = { text: "no", addedAt: app.now, sentAt: app.now, written: true, provisional: false, failed: true, obId: id2 };
  se.pendingSent.push(p2); await app.tick();
  app.outbox.retryNow(p2); await app.settle();
  assert.deepStrictEqual(app.sends.map((s) => s.text), ["no"], "a real Retry click sends once");
});

t("glue (F2): failed long message is re-sent automatically ONCE (2 sends in total), then 'Not delivered' + Retry", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, "y".repeat(800)); app.outbox.bind(id, LONG_REF);
  se.pendingSent.push({ text: LONG_REF, addedAt: app.now, sentAt: app.now, written: true, provisional: false, failed: true, obId: id });
  for (let i = 0; i < 12; i++) { await app.run(30000); se.pendingSent.forEach((p) => { p.failed = true; }); }
  assert.strictEqual(app.sends.length, 1, "one automatic re-send, never more (an unrecognised CLI form would otherwise get 3 copies)");
  const it = app.items()[0];
  assert.strictEqual(it.attempts, 2);
  assert.ok(/Not delivered after 2 tries/.test(app.outbox.pendingLabel(se.pendingSent[0])));
  assert.ok(app.log.some((l) => /gave up after 2 attempts/.test(l)));
  app.advance(30000);
  app.outbox.retryNow(se.pendingSent[0]); await app.settle();
  assert.strictEqual(app.sends.length, 2, "his Retry click still sends (manual is not capped by F2)");
});

t("glue: text stuck in the CLI input box is never re-typed (the Enter ladder owns it)", async () => {
  const app = makeApp({ boxHolds: true }); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT);
  se.pendingSent.push({ text: TXT, addedAt: app.now, sentAt: app.now, written: true, provisional: false, failed: true, obId: id });
  await app.run(200000);
  assert.strictEqual(app.sends.length, 0);
});

t("glue (handoff hold/release): held while the flow runs, re-sent to the NEW session once it is attached and idle", async () => {
  const app = makeApp(); await app.settle();
  const old = app.session(AP);
  const id = app.outbox.add(AP, TXT);
  old.pendingSent.push({ text: TXT, addedAt: app.now, sentAt: app.now, written: true, provisional: false, obId: id });
  await app.tick();
  app.ctx.__flow = new Set([AP]);                       // auto-handoff starts; the reset drops the old session object
  app.ctx.terminals.delete(AP);
  await app.run(60000);
  assert.strictEqual(app.sends.length, 0, "nothing while the handoff runs");
  const fresh = app.session(AP, { busy: true });         // new session attached, still busy with its first turn
  await app.run(30000);
  assert.strictEqual(app.sends.length, 0, "flow still active");
  app.ctx.__flow = new Set();                            // flow done
  await app.run(10000);
  assert.strictEqual(app.sends.length, 0, "fresh session busy");
  fresh.busy = false;
  await app.run(60000);
  assert.strictEqual(app.sends.length, 1, "released to the fresh session once idle");
  assert.strictEqual(app.sends[0].text, TXT);
});

t("glue (handoff hold/release): a message parked by the flow is left to the flow's own restore (no double delivery)", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT);
  app.ctx.__parked = new Map([[AP, { items: [TXT], at: app.now }]]);
  app.ctx.__flow = new Set([AP]);
  await app.run(60000);
  assert.ok(/new session/.test(app.outbox.queueLabel(AP, TXT)), "visible 'waiting for the new session'");
  app.ctx.__parked = new Map(); app.ctx.__flow = new Set();
  se.sendQueue.push(TXT);                                  // restoreParkedQueues put it back in the queue
  await app.run(60000);
  assert.strictEqual(app.sends.length, 0, "the outbox never sends a message the app still holds");
  assert.deepStrictEqual(se.sendQueue, [TXT]);
  assert.strictEqual(app.items().find((x) => x.id === id).written, false);
});

t("glue (dead link): nothing is re-sent while connection health says not connected; it goes once connected", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, TXT);
  se.pendingSent.push({ text: TXT, addedAt: app.now, sentAt: app.now, written: true, provisional: false, failed: true, obId: id });
  app.ctx.connHealth._states.set(AP, { state: "reconnecting", attempts: 3 });
  await app.run(200000);
  assert.strictEqual(app.sends.length, 0);
  app.ctx.connHealth._states.delete(AP);
  await app.run(60000);
  assert.strictEqual(app.sends.length, 1);
});

t("glue: removing a queued message by hand cancels it for good; a user who gets the text back is not double-sent", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP, { busy: true });
  app.outbox.add(AP, TXT);
  se.sendQueue.push(TXT);
  await app.tick();
  assert.strictEqual(app.outbox.cancelQueued(AP, TXT), true);
  se.sendQueue.length = 0;
  se.busy = false;
  await app.run(120000);
  assert.strictEqual(se.sendQueue.length + app.sends.length, 0);
  const id2 = app.outbox.add(AP, "second message that failed before writing");
  app.outbox.cancel(id2);
  await app.run(120000);
  assert.strictEqual(app.sends.length, 0);
});

t("glue: Hebrew message end to end (failed, re-sent once, then seen)", async () => {
  const app = makeApp(); await app.settle();
  const se = app.session(AP);
  const id = app.outbox.add(AP, HEB);
  se.pendingSent.push({ text: HEB, addedAt: app.now, sentAt: app.now, written: true, provisional: false, failed: true, obId: id });
  await app.run(60000);
  assert.deepStrictEqual(app.sends.map((s) => s.text), [HEB]);
  app.seen.set(HEB, "user"); se.pendingSent = [];
  await app.run(30000);
  assert.strictEqual(app.items()[0].state, "seen");
  const saved = JSON.parse(app.saves[app.saves.length - 1]);
  assert.strictEqual(saved.items.length, 1);
  assert.strictEqual(saved.items[0].text, HEB, "Hebrew survives the save intact");
  assert.strictEqual(saved.items[0].state, "seen");
});

// ---------------------------------------------------------------- main IPCs on real files ----------------------
t("main: outbox-save is atomic and BOM-free; outbox-load survives a missing or oversized file; outbox-seen reads transcripts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-"));
  const home = path.join(tmp, "home");
  const handlers = {};
  const origLoad = Module._load;
  const origHome = os.homedir;
  Module._load = function (req, parent, isMain) {
    if (req === "electron") return { app: { getPath: () => tmp } };
    return origLoad.apply(this, arguments);
  };
  os.homedir = () => home;
  try {
    delete require.cache[require.resolve("../src/guards-main")];
    const gm = require("../src/guards-main");
    const realSetInterval = global.setInterval, realSetTimeout = global.setTimeout;
    global.setInterval = () => ({ unref() {} }); global.setTimeout = () => 0;
    try {
      gm.init({ ipcMain: { handle: (n, f) => { handlers[n] = f; } }, Notification: { isSupported: () => false }, getMainWindow: () => null,
        sessionCwdFor: (ap) => ap + "\\.claude-session", archive: { encodeProjectPath: (p) => p.replace(/[^A-Za-z0-9]/g, "-"), getConfirmedRateLimits: () => ({}) }, log: () => {} });
    } finally { global.setInterval = realSetInterval; global.setTimeout = realSetTimeout; }
    assert.ok(handlers["outbox-save"] && handlers["outbox-load"] && handlers["outbox-seen"]);
    assert.strictEqual(handlers["outbox-load"]().json, "{}", "missing file -> empty");
    const json = L.serialize([L.create(AP, HEB, Date.now())], Date.now());
    assert.strictEqual((await handlers["outbox-save"](null, { json: "\uFEFF" + json })).ok, true);
    const raw = fs.readFileSync(path.join(tmp, "outbox.json"));
    assert.ok(!(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf), "no BOM on disk");
    assert.ok(!fs.existsSync(path.join(tmp, "outbox.json.tmp")), "temp file renamed away");
    assert.strictEqual(L.parse(handlers["outbox-load"]().json, Date.now())[0].text, HEB);
    assert.strictEqual((await handlers["outbox-save"](null, { json: "x".repeat(2 * 1024 * 1024 + 1) })).ok, false, "oversized refused");
    // transcripts
    const agent = "C:\\Example\\Workspace\\Test Agent";
    const dir = path.join(home, ".claude", "projects", (agent + "\\.claude-session").replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now() - 10000;
    fs.writeFileSync(path.join(dir, "old.jsonl"), userLine("delivered to the old session before reset", t0 + 1000) + "\n");
    fs.utimesSync(path.join(dir, "old.jsonl"), new Date(t0 + 2000), new Date(t0 + 2000));
    fs.writeFileSync(path.join(dir, "new.jsonl"), enqLine("waiting in the cli queue right now ok", t0 + 3000) + "\n" + userLine(HEB, t0 + 4000) + "\n");
    const seen = async (text) => (await handlers["outbox-seen"](null, { agentPath: agent, text, sinceMs: t0 })).seen;
    assert.strictEqual(await seen("delivered to the old session before reset"), "user");
    assert.strictEqual(await seen("waiting in the cli queue right now ok"), "queued");
    assert.strictEqual(await seen(HEB), "user");
    assert.strictEqual(await seen("this one never arrived anywhere at all"), "other", "not there, and later user entries exist");
    assert.strictEqual((await handlers["outbox-seen"](null, { agentPath: agent, text: "this one never arrived anywhere at all", sinceMs: t0 + 5000 })).seen, "none", "nothing after the send");
    assert.strictEqual(await seen(HEB), "user", "memoised tail (same size + mtime) gives the same answer");
    fs.appendFileSync(path.join(dir, "new.jsonl"), userLine("appended after the first read of this file", Date.now()) + "\n");
    fs.utimesSync(path.join(dir, "new.jsonl"), new Date(), new Date(Date.now() + 5000));
    assert.strictEqual(await seen("appended after the first read of this file"), "user", "a changed file is read again (memo keyed by size + mtime)");
    assert.strictEqual((await handlers["outbox-seen"](null, { agentPath: "D:\\nope", text: "x", sinceMs: t0 })).seen, null, "no transcript folder -> cannot tell");
  } finally {
    Module._load = origLoad; os.homedir = origHome;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
});

// ---------------------------------------------------------------- wiring (source checks) -----------------------
t("wiring: Send registers the message BEFORE any await; Retry/Resend and queue removal go through the outbox; scripts loaded", () => {
  const r = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf8");
  const send = r.slice(r.indexOf("async function sendChatInput()"), r.indexOf("async function deliverChatMessage("));
  assert.ok(send.indexOf("window.outbox.add(agentPath, combined)") > 0 && send.indexOf("window.outbox.add(") < send.indexOf("await "), "add before the first await");
  assert.ok(/window\.outbox\.bind\(obId, toSend\)/.test(send));
  assert.ok(/window\.outbox\.retryNow\(pending\)/.test(r));
  assert.ok(/window\.outbox\.cancelQueued\(agentPath, text\)/.test(r));
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  assert.ok(html.indexOf('src="../outbox.js"') > html.indexOf('src="renderer.js"') && html.indexOf('src="outbox.js"') > html.indexOf('src="../outbox.js"'));
  const glue = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "outbox.js"), "utf8");
  assert.ok(!/sendInput\(/.test(glue), "the outbox never writes to the pty itself (same path as Send)");
  assert.ok(!/\[hid:/.test(glue), "nothing is added to what is typed");
  const ledger = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "unsent-ledger.js"), "utf8");
  assert.ok(/window\.outbox\.owns/.test(ledger), "the unsent ledger leaves outbox messages alone (no double recovery)");
});

(async () => {
  let fails = 0;
  for (const x of tests) {
    try { await x.fn(); } catch (e) { fails++; console.error("FAIL " + x.name + "\n  " + (e && e.stack || e)); }
  }
  console.log(`outboxAck: ${tests.length - fails}/${tests.length} passed`);
  process.exit(fails ? 1 : 0);
})();
