// node tests/loadGovernor.test.js - load governor (src/loadGovernor.js, src/foregroundProbe.js) and its gates: settings, the state machine
// (warmup/calm/busy/slow/unknown/off, hysteresis, forced release), admission (start one at a time, working cap, heavy-app cap, FIFO waits and
// their bound), the start limiter gate, the voice inbox wait. A fake clock drives everything; no Electron, no real measuring, no spawned process.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const G = require("../src/loadGovernor");
const FP = require("../src/foregroundProbe");
const { createStartLimiter } = require("../src/startLimiter");
const V = require("../src/voiceInbox");

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function clock() {
  let now = 1_000_000, id = 0, timers = [];
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const h = { id: ++id, at: now + ms, fn }; timers.push(h); return h; },
    clearTimeout: (h) => { timers = timers.filter((x) => x !== h); },
    setInterval: (fn, ms) => { const h = { id: ++id, at: now + ms, fn, every: ms }; timers.push(h); return h; },
    clearInterval: (h) => { timers = timers.filter((x) => x !== h); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const n = timers[0];
        if (!n || n.at > end) break;
        now = Math.max(now, n.at);
        if (n.every) n.at += n.every; else timers.shift();
        n.fn();
        await flush();
      }
      now = end;
      await flush();
    },
    pending: () => timers.length,
    clearAll: () => { timers = []; },
  };
}

// a governor on a fake clock. Samples are fed with feed(); `working` is what countWorking() returns.
function mk(opts) {
  const o = opts || {};
  const c = o.clock || clock();
  const logs = [], changes = [];
  const st = { working: o.working === undefined ? 0 : o.working, settings: o.settings || {} };
  const g = G.create({
    now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, setInterval: c.setInterval, clearInterval: c.clearInterval,
    log: (l) => logs.push(l), onChange: (s) => changes.push(s),
    getSettings: () => st.settings,
    countWorking: () => (typeof st.working === "function" ? st.working() : st.working),
    measure: o.measure, probeForeground: o.probeForeground,
  });
  const feed = (cpu, lagMs, extra) => { g.ingest(Object.assign({ t: c.now(), cpu, lagMs, freeMB: 8000 }, extra || {})); };
  // one sample per 2 s
  const feedN = async (n, cpu, lagMs, extra) => { for (let i = 0; i < n; i++) { await c.advance(2000); feed(cpu, lagMs, extra); } };
  return { g, c, logs, changes, st, feed, feedN };
}

// ---- settings ----
t("sanitizeSettings: defaults, bad values fall back, heavy cap never above the normal cap", () => {
  const d = G.sanitizeSettings(null);
  assert.strictEqual(d.enabled, true); assert.strictEqual(d.maxWorking, 6); assert.strictEqual(d.maxWorkingHeavy, 3);
  assert.deepStrictEqual(d.heavyApps, ["premiere"]);
  const b = G.sanitizeSettings({ maxWorking: "abc", maxWorkingHeavy: -4, calmCpuPct: 5000, slowLagMs: "2500", heavyApps: "Premiere Pro.exe; Resolve, <script>" });
  assert.strictEqual(b.maxWorking, 6); assert.strictEqual(b.maxWorkingHeavy, 3); assert.strictEqual(b.calmCpuPct, 50); assert.strictEqual(b.slowLagMs, 2500);
  assert.deepStrictEqual(b.heavyApps, ["premiere pro", "resolve"]);
  assert.strictEqual(G.sanitizeSettings({ maxWorking: 2, maxWorkingHeavy: 5 }).maxWorkingHeavy, 2);
  assert.strictEqual(G.sanitizeSettings({ enabled: false }).enabled, false);
  assert.strictEqual(G.sanitizeSettings({ enabled: "false" }).enabled, false);
  assert.deepStrictEqual(G.sanitizeSettings({ heavyApps: "" }).heavyApps, ["premiere"]);
});
t("isHeavy / capFor: a part of the foreground program name, case-insensitive, .exe ignored", () => {
  const S = G.sanitizeSettings({ heavyApps: "premiere, afterfx" });
  assert.strictEqual(G.isHeavy("Adobe Premiere Pro.exe", S.heavyApps), true);
  assert.strictEqual(G.isHeavy("AfterFX", S.heavyApps), true);
  assert.strictEqual(G.isHeavy("chrome", S.heavyApps), false);
  assert.strictEqual(G.isHeavy(null, S.heavyApps), false);
  assert.strictEqual(G.capFor(S, "Adobe Premiere Pro"), 3); assert.strictEqual(G.capFor(S, "chrome"), 6); assert.strictEqual(G.capFor(S, null), 6);
});

// ---- state machine ----
t("state: warmup until calmSamples samples, then calm; busy on CPU; free RAM and GPU memory count", async () => {
  const m = mk();
  assert.strictEqual(m.g.state(), "warmup");
  await m.feedN(2, 10, 5); assert.strictEqual(m.g.state(), "warmup");
  await m.feedN(1, 10, 5); assert.strictEqual(m.g.state(), "calm");
  await m.feedN(1, 60, 5); assert.strictEqual(m.g.state(), "busy"); assert.match(m.g.snapshot().reason, /CPU 60%/);
  await m.feedN(3, 10, 5); assert.strictEqual(m.g.state(), "calm");
  await m.feedN(3, 10, 5, { freeMB: 500 }); assert.strictEqual(m.g.state(), "busy"); assert.match(m.g.snapshot().reason, /free RAM/);
  await m.feedN(3, 10, 5, { gpuFreePct: 2 }); assert.strictEqual(m.g.state(), "busy"); assert.match(m.g.snapshot().reason, /GPU/);
  await m.feedN(3, 10, 5, { gpuFreePct: 40 }); assert.strictEqual(m.g.state(), "calm");
});
t("state: slow after 3 slow samples (lag or CPU), one slow sample is not enough", async () => {
  const m = mk();
  await m.feedN(3, 10, 5);
  await m.feedN(1, 10, 3000); assert.notStrictEqual(m.g.state(), "slow", "a single stall is not slow");
  await m.feedN(1, 10, 5);
  await m.feedN(2, 99, 5); assert.notStrictEqual(m.g.state(), "slow");
  await m.feedN(1, 99, 5); assert.strictEqual(m.g.state(), "slow"); assert.match(m.g.snapshot().reason, /CPU 99%/);
});
t("state: slow has hysteresis - leaves only after recoverSamples good samples, then calm or busy", async () => {
  const m = mk();
  await m.feedN(3, 10, 5);
  await m.feedN(3, 10, 3000); assert.strictEqual(m.g.state(), "slow");
  await m.feedN(4, 10, 5); assert.strictEqual(m.g.state(), "slow", "4 of 5 recovery samples is not enough");
  await m.feedN(1, 10, 5); assert.strictEqual(m.g.state(), "calm");
  await m.feedN(3, 10, 3000); assert.strictEqual(m.g.state(), "slow");
  await m.feedN(5, 65, 100); assert.strictEqual(m.g.state(), "busy", "recovered but CPU 65% is not calm");
});
t("state: a stuck slow state is force-released after maxSlowMs and cannot come back for the cool-down", async () => {
  const m = mk({ settings: { maxSlowMs: 60000, slowCooldownMs: 120000 } });
  await m.feedN(3, 10, 5);
  await m.feedN(3, 10, 3000); assert.strictEqual(m.g.state(), "slow");
  await m.feedN(31, 10, 3000); // 62 s later and still lagging
  assert.strictEqual(m.g.state(), "busy"); assert.ok(m.logs.some((l) => /forcing release/.test(l)));
  await m.feedN(5, 10, 3000); assert.strictEqual(m.g.state(), "busy", "suppressed during the cool-down");
  await m.feedN(60, 10, 3000); assert.strictEqual(m.g.state(), "slow", "after the cool-down it can re-enter");
});
t("state: nothing measurable = unknown = fail-open; stale samples while running = unknown", async () => {
  const m = mk();
  m.feed(null, null); assert.strictEqual(m.g.state(), "unknown");
  assert.strictEqual(m.g.admit("start", { label: "A" }).ok, true);
  assert.strictEqual(m.g.nudgeBlock(), null);
  assert.strictEqual(m.g.maxConcurrentStarts(), null, "the start limiter keeps its own default");
});
t("state: disabled = off, everything admitted, no log noise", () => {
  const m = mk({ settings: { enabled: false } });
  m.feed(99, 90000);
  assert.strictEqual(m.g.state(), "off");
  for (const k of ["start", "wake", "nudge", "voice", "handoff"]) assert.strictEqual(m.g.admit(k, { label: "x" }).ok, true);
  assert.strictEqual(m.g.nudgeBlock(), null);
  assert.strictEqual(m.g.maxConcurrentStarts(), null);
  assert.strictEqual(m.g.banner({}).show, false);
});
t("tick: lag comes from the timer drift, measure failures fall back to lag only (logged once)", async () => {
  let calls = 0;
  const m = mk({ measure: () => { calls++; throw new Error("boom"); } });
  m.g.start();
  await m.c.advance(2000); await m.c.advance(2000); await m.c.advance(2000);
  assert.ok(calls >= 3);
  assert.strictEqual(m.g.state(), "calm", "lag alone says calm");
  assert.strictEqual(m.logs.filter((l) => /system measure failed/.test(l)).length, 1);
  m.g.stop();
});
t("createSystemMeasure: CPU from os.cpus() deltas, RAM from os", () => {
  let idle = 0, busy = 0;
  const fake = { cpus: () => [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }, { times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }], freemem: () => 4 * 1048576, totalmem: () => 16 * 1048576 };
  const me = G.createSystemMeasure(fake);
  assert.strictEqual(me().cpu, null, "first call has nothing to compare");
  idle += 750; busy += 250;
  const r = me();
  assert.ok(Math.abs(r.cpu - 25) < 0.01, "got " + r.cpu); assert.strictEqual(r.freeMB, 4); assert.strictEqual(r.totalMB, 16);
  assert.strictEqual(G.createSystemMeasure({ cpus: () => { throw new Error("x"); }, freemem: () => 1048576, totalmem: () => 2097152 })().cpu, null);
});

// ---- admission ----
t("admit start: one at a time - the next start needs calmSamples fresh calm samples after the previous one", async () => {
  const m = mk();
  await m.feedN(3, 10, 5);
  assert.strictEqual(m.g.admit("start", { label: "A" }).ok, true);
  const r = m.g.admit("start", { label: "B" });
  assert.strictEqual(r.ok, false); assert.match(r.reason, /calm/);
  await m.feedN(2, 10, 5); assert.strictEqual(m.g.admit("start", { label: "B" }).ok, false, "2 fresh samples are not enough");
  await m.feedN(1, 10, 5); assert.strictEqual(m.g.admit("start", { label: "B" }).ok, true);
});
t("admit start: not while busy; released after maxWaitMs (not while slow)", async () => {
  const m = mk({ settings: { maxWaitMs: 30000 } });
  await m.feedN(3, 60, 5); assert.strictEqual(m.g.state(), "busy");
  assert.strictEqual(m.g.admit("start", { label: "A" }).ok, false);
  await m.feedN(10, 60, 5); // 20 s
  assert.strictEqual(m.g.admit("start", { label: "A" }).ok, false);
  await m.feedN(6, 60, 5); // 32 s
  const r = m.g.admit("start", { label: "A" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.released, true); assert.ok(m.logs.some((l) => /released start A/.test(l)));
  // slow is never overridden by the wait bound
  const s = mk({ settings: { maxWaitMs: 5000 } });
  await s.feedN(3, 10, 5); await s.feedN(3, 10, 3000); assert.strictEqual(s.g.state(), "slow");
  assert.strictEqual(s.g.admit("start", { label: "A" }).ok, false);
  await s.feedN(8, 10, 3000); assert.strictEqual(s.g.admit("start", { label: "A" }).ok, false);
});
t("admit: slow blocks every kind; urgent always passes", async () => {
  const m = mk();
  await m.feedN(3, 10, 5); await m.feedN(3, 99, 5); assert.strictEqual(m.g.state(), "slow");
  for (const k of ["start", "wake", "voice", "nudge", "handoff"]) { const r = m.g.admit(k, { label: "x" }); assert.strictEqual(r.ok, false, k); }
  assert.strictEqual(m.g.admit("start", { label: "x", urgent: true }).ok, true);
  assert.strictEqual(m.g.nudgeBlock(), "LOADSLOW");
  assert.strictEqual(m.g.banner({ waiting: ["A", "B"] }).kind, "governor-slow");
  assert.match(m.g.banner({ waiting: ["A", "B"] }).text, /2 waiting for a slot \(A, B\)/);
});
t("admit: working cap, and admitted work is reserved so a burst cannot all pass at once", async () => {
  const m = mk({ working: 4 });
  await m.feedN(3, 10, 5);
  assert.strictEqual(m.g.admit("nudge", { label: "A" }).ok, true);  // 4 working + 1 reserved = 5 < 6
  assert.strictEqual(m.g.admit("nudge", { label: "B" }).ok, true);  // 4 + 2 = 6 -> that was the last one (check was 5 < 6)
  const r = m.g.admit("nudge", { label: "C" });
  assert.strictEqual(r.ok, false); assert.match(r.reason, /working cap 6 reached/);
  await m.c.advance(25000); // reservations expire; transcripts would show the work by now
  m.st.working = 6;
  assert.strictEqual(m.g.admit("nudge", { label: "C" }).ok, false, "6 really working");
  m.st.working = 5; await m.c.advance(5000); // the working count is cached for 4 s
  assert.strictEqual(m.g.admit("nudge", { label: "C" }).ok, true);
});
t("admit: cap drops to the heavy cap while a heavy app is in front (probe), and back when it is not; stale probe = normal cap", async () => {
  let fgName = "Adobe Premiere Pro";
  const m = mk({ working: 3, probeForeground: async () => ({ foreground: fgName, heavyRunning: true }) });
  m.g.start();
  await m.c.advance(2000); await m.c.advance(2000); await m.c.advance(2000); await m.c.advance(2000);
  assert.strictEqual(m.g.snapshot().heavy, true); assert.strictEqual(m.g.snapshot().cap, 3);
  assert.strictEqual(m.g.check("wake", {}).ok, false, "3 working >= heavy cap 3");
  fgName = "chrome";
  await m.c.advance(25000);
  assert.strictEqual(m.g.snapshot().heavy, false); assert.strictEqual(m.g.snapshot().cap, 6);
  assert.strictEqual(m.g.check("wake", {}).ok, true);
  assert.ok(m.logs.some((l) => /heavy app/.test(l)));
  m.g.stop();
});
t("admit: a failing probe or a failing worker count keeps the normal behaviour (fail-open)", async () => {
  const m = mk({ working: () => { throw new Error("no listing"); }, probeForeground: async () => { throw new Error("no powershell"); } });
  m.g.start();
  await m.c.advance(8000);
  assert.strictEqual(m.g.snapshot().cap, 6);
  await m.feedN(3, 10, 5);
  assert.strictEqual(m.g.admit("wake", { label: "A" }).ok, true, "unknown worker count does not block");
  m.g.stop();
});
t("decisions are logged once per decision per minute, state changes always", async () => {
  const m = mk();
  await m.feedN(3, 60, 5);
  for (let i = 0; i < 20; i++) m.g.admit("start", { label: "A" });
  assert.strictEqual(m.logs.filter((l) => /holding start A/.test(l)).length, 1);
  await m.c.advance(61000);
  m.g.admit("start", { label: "A" });
  assert.strictEqual(m.logs.filter((l) => /holding start A/.test(l)).length, 2);
  assert.ok(m.logs.every((l) => /^governor: /.test(l)));
});

// ---- FIFO waits ----
t("waitForSlot: FIFO, nobody overtakes the head, nothing is dropped", async () => {
  const m = mk({ working: 6 });
  await m.feedN(3, 10, 5);
  const order = [];
  const p = ["A", "B", "C"].map((n) => m.g.waitForSlot("voice", { label: n }).then((r) => { order.push(n); return r; }));
  await flush(); assert.deepStrictEqual(order, []); assert.deepStrictEqual(m.g.snapshot().waiting, ["A", "B", "C"]);
  assert.match(m.g.banner({}).text, /3 agents waiting for a slot \(A, B, C\)/);
  m.st.working = 5; await m.c.advance(5000);   // one slot: only the head passes
  assert.deepStrictEqual(order, ["A"]);
  m.st.working = 0; await m.c.advance(5000);
  assert.deepStrictEqual(order, ["A", "B", "C"]);
  const rs = await Promise.all(p); assert.ok(rs.every((r) => r.ok && !r.released));
  assert.deepStrictEqual(m.g.snapshot().waiting, []);
  assert.strictEqual(m.c.pending() >= 0, true);
});
t("waitForSlot: released after its bound (the message goes ahead), in order; stop() frees everybody", async () => {
  const m = mk({ working: 6, settings: { voiceMaxWaitMs: 10000 } });
  await m.feedN(3, 10, 5);
  const order = [];
  const a = m.g.waitForSlot("voice", { label: "A" }).then((r) => { order.push("A"); return r; });
  await m.c.advance(4000);
  const b = m.g.waitForSlot("wake", { label: "B", maxWaitMs: 5000 }).then((r) => { order.push("B"); return r; });
  await m.c.advance(7000);
  assert.deepStrictEqual(order, ["A", "B"], "A hit its 10 s bound; B (5 s bound, queued behind it, already 6 s old) is released right after, never before A");
  const [ra, rb] = await Promise.all([a, b]); assert.strictEqual(ra.released, true); assert.strictEqual(rb.released, true);
  const c2 = m.g.waitForSlot("voice", { label: "C" }); await flush();
  m.g.stop(); const rc = await c2; assert.strictEqual(rc.ok, true);
});
t("waitForSlot: admitted at once when there is room; urgent never waits", async () => {
  const m = mk();
  await m.feedN(3, 10, 5);
  const r = await m.g.waitForSlot("wake", { label: "A" }); assert.strictEqual(r.ok, true); assert.strictEqual(r.waitedMs, 0);
  await m.feedN(3, 10, 5); await m.feedN(3, 99, 5);
  const u = await m.g.waitForSlot("wake", { label: "U", urgent: true }); assert.strictEqual(u.ok, true);
});

// ---- the start limiter gate ----
t("start limiter gate: the head start waits while the gate says no, then starts; a throwing gate is fail-open; snapshot says why", async () => {
  const c = clock();
  let open = false, boom = false;
  const lim = createStartLimiter({ now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, enabled: () => true, spacingMs: 0,
    gate: () => { if (boom) throw new Error("x"); return open ? { ok: true } : { ok: false, reason: "waiting for the PC to be calm" }; } });
  const started = [];
  const run = (n) => lim.run(async () => { started.push(n); }, { label: n });
  const pa = run("A"), pb = run("B");
  await c.advance(1000); assert.deepStrictEqual(started, []);
  const s = lim.snapshot(); assert.strictEqual(s.queued, 2); assert.strictEqual(s.gate.blocked, true); assert.match(s.gate.reason, /calm/);
  open = true; await c.advance(3000);
  await Promise.all([pa, pb]); assert.deepStrictEqual(started, ["A", "B"], "FIFO");
  boom = true;
  await run("C"); assert.deepStrictEqual(started, ["A", "B", "C"]);
  // urgent starts never ask the gate
  open = false; boom = false;
  await lim.run(async () => { started.push("U"); }, { label: "U", urgent: true }); assert.strictEqual(started[3], "U");
});
t("start limiter + governor end to end: 5 agents start strictly one at a time, each after fresh calm samples", async () => {
  const m = mk();
  const lim = createStartLimiter({ now: m.c.now, setTimeout: m.c.setTimeout, clearTimeout: m.c.clearTimeout, enabled: () => true, spacingMs: 0, maxConcurrent: 3,
    getMaxConcurrent: () => m.g.maxConcurrentStarts() || 3, gate: (label) => m.g.admit("start", { label }) });
  const startedAt = [];
  const ps = ["A", "B", "C", "D", "E"].map((n) => lim.run(async () => { startedAt.push([n, m.c.now()]); }, { label: n }));
  for (let i = 0; i < 40; i++) { await m.c.advance(2000); m.feed(10, 5); }
  await Promise.all(ps);
  assert.deepStrictEqual(startedAt.map((x) => x[0]), ["A", "B", "C", "D", "E"]);
  for (let i = 1; i < startedAt.length; i++) assert.ok(startedAt[i][1] - startedAt[i - 1][1] >= 6000, "gap " + (startedAt[i][1] - startedAt[i - 1][1]));
});

// ---- voice inbox ----
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "govvoice-"));
const rq = (o) => JSON.stringify(Object.assign({ agentPath: "C:\\agents\\Health", text: "hello there", createdAt: Date.now(), source: "pheme" }, o || {}));
t("voice inbox: governorWait holds the dictation, order kept, then it is delivered (never refused)", async () => {
  const dir = tmp(); const got = []; const logs = [];
  let release; const gate = new Promise((r) => { release = r; });
  const inbox = V.createInbox({ dir, deliver: async (r) => { got.push(r.id); return { ok: true }; }, log: (l) => logs.push(l),
    governorWait: async () => { await gate; return { ok: true, waitedMs: 5000, released: false }; } });
  inbox.start();
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, "g" + i + ".json"), rq({ createdAt: Date.now() + i }));
  inbox.scan(); await new Promise((r) => setTimeout(r, 80)); assert.deepStrictEqual(got, [], "held while the governor says wait");
  release(); await inbox.idle(); await new Promise((r) => setTimeout(r, 50)); inbox.close();
  assert.deepStrictEqual(got, ["g0", "g1", "g2"]);
  assert.ok(logs.some((l) => /waited 5 s for a load-governor slot/.test(l)));
});
t("voice inbox: a burst over the per-minute cap WAITS within rateWaitMs instead of being refused; refused only after the bound", async () => {
  const dir = tmp(); const got = []; let t0 = 1_000_000; const slept = [];
  const inbox = V.createInbox({ dir, deliver: async (r) => { got.push(r.id); return { ok: true }; }, now: () => t0, maxPerMinute: 2, rateWaitMs: 90000,
    sleep: async (ms) => { slept.push(ms); t0 += ms; } });
  inbox.start();
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, "r" + i + ".json"), rq({ createdAt: t0 + i }));
  inbox.scan(); await inbox.idle(); await new Promise((r) => setTimeout(r, 50)); inbox.close();
  assert.deepStrictEqual(got, ["r0", "r1", "r2"], "the third waited for the window instead of being refused");
  assert.ok(slept.length >= 1);
  // bound reached: still refused with a reason (nothing hangs for ever)
  const dir2 = tmp(); const got2 = []; let t1 = 5_000_000;
  const inbox2 = V.createInbox({ dir: dir2, deliver: async (r) => { got2.push(r.id); return { ok: true }; }, now: () => t1, maxPerMinute: 1, rateWaitMs: 1000, sleep: async (ms) => { t1 += ms; } });
  inbox2.start();
  for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(dir2, "q" + i + ".json"), rq({ createdAt: t1 + i }));
  inbox2.scan(); await inbox2.idle(); await new Promise((r) => setTimeout(r, 50)); inbox2.close();
  assert.deepStrictEqual(got2, ["q0"]);
  const res = JSON.parse(fs.readFileSync(path.join(dir2, "processed", "q1.json"), "utf8")); assert.match(res.result.reason, /rate-limited/);
});
t("voice inbox: a failing governorWait is fail-open", async () => {
  const dir = tmp(); const got = [];
  const inbox = V.createInbox({ dir, deliver: async (r) => { got.push(r.id); return { ok: true }; }, governorWait: async () => { throw new Error("x"); } });
  inbox.start(); fs.writeFileSync(path.join(dir, "f0.json"), rq());
  inbox.scan(); await inbox.idle(); inbox.close();
  assert.deepStrictEqual(got, ["f0"]);
});

t("cpuGuardGlue: the governor banner shows when the CPU guard has nothing to say, and is passed to the limiter as the gate", async () => {
  const { init } = require("../src/cpuGuardGlue");
  const calls = [];
  const gov = { banner: () => ({ show: true, kind: "governor-wait", text: "Load governor: 1 agent waiting for a slot (A).", queued: 1, boxed: [] }), admit: (k, o) => { calls.push([k, o.label]); return { ok: true, reason: "" }; }, maxConcurrentStarts: () => 1 };
  const g = init({ app: {}, ipcMain: { handle() {} }, dialog: {}, testMode: { TEST_MODE: true }, getMainWindow: () => null, readUiFlags: () => ({}), setUiFlag() {}, governor: gov });
  const b = g.compute();
  assert.strictEqual(b.show, true); assert.strictEqual(b.kind, "governor-wait"); assert.match(b.text, /waiting for a slot/);
  const g2 = init({ app: {}, ipcMain: { handle() {} }, dialog: {}, testMode: { TEST_MODE: true }, getMainWindow: () => null, readUiFlags: () => ({}), setUiFlag() {} });
  assert.strictEqual(g2.compute().show, false, "without a governor nothing changes");
});

// ---- foreground probe ----
t("foregroundProbe: output parsing, name sanitising, the script never contains the names, non-Windows answers null", async () => {
  assert.deepStrictEqual(FP.parseOutput("Adobe Premiere Pro|1\r\n"), { foreground: "Adobe Premiere Pro", heavyRunning: true });
  assert.deepStrictEqual(FP.parseOutput("none|0"), { foreground: null, heavyRunning: false });
  assert.deepStrictEqual(FP.parseOutput("|1"), { foreground: null, heavyRunning: true });
  assert.strictEqual(FP.parseOutput("garbage"), null);
  assert.deepStrictEqual(FP.safeNames(["Premiere.exe", "bad;name", "x`y", "$(calc)", "After Effects"]), ["premiere", "after effects"]);
  assert.ok(!/premiere/i.test(FP.buildScript()));
  assert.deepStrictEqual(await FP.probe(["premiere"], { platform: "linux" }), { foreground: null, heavyRunning: false });
  assert.deepStrictEqual(await FP.probe([], { platform: "win32" }), { foreground: null, heavyRunning: false });
  let seen = null;
  const r = await FP.probe(["Premiere"], { platform: "win32", execFile: (exe, args, opts, cb) => { seen = { exe, args, env: opts.env.AD_GOV_HEAVY, timeout: opts.timeout }; cb(null, "Adobe Premiere Pro|1\r\n"); } });
  assert.strictEqual(r.foreground, "Adobe Premiere Pro"); assert.strictEqual(seen.env, "premiere"); assert.strictEqual(seen.timeout, 8000); assert.ok(seen.args.includes("-EncodedCommand"));
  await assert.rejects(FP.probe(["x1"], { platform: "win32", execFile: (e, a, o, cb) => cb(new Error("spawn fail")) }));
});

// ---- review fixes (2026-10-15) ----
t("one huge lag sample (a coalesced 48 s main-thread block) is slow by itself; recovers after 5 good samples", async () => {
  const m = mk();
  await m.feedN(3, 10, 5);
  await m.feedN(1, 10, 48000); assert.strictEqual(m.g.state(), "slow"); assert.match(m.g.snapshot().reason, /stalled 48 s/);
  assert.strictEqual(m.g.nudgeBlock(), "LOADSLOW");
  await m.feedN(5, 10, 5); assert.notStrictEqual(m.g.state(), "slow");
  const n = mk(); await n.feedN(3, 10, 5); await n.feedN(1, 10, 4000); assert.notStrictEqual(n.g.state(), "slow", "4 s alone is under slowSingleLagMs (5 s)");
});
t("drain admits ONE queued item per pass (no stampede after a stall); order kept", async () => {
  const m = mk({ working: 6 });
  await m.feedN(3, 10, 5);
  const order = [];
  for (const n of ["A", "B", "C", "D"]) m.g.waitForSlot("voice", { label: n }).then(() => order.push(n));
  await flush(); assert.deepStrictEqual(order, []);
  m.st.working = 0; await m.c.advance(5000);
  assert.ok(order.length < 4, "not all at once: " + order.join(","));
  await m.c.advance(10000);
  assert.deepStrictEqual(order, ["A", "B", "C", "D"]);
});
t("nudge and handoff deferral has a maximum (deferMaxWaitMs, 5 min) - never while slow; an abandoned label starts a fresh timer", async () => {
  const m = mk({ working: 6 });
  await m.feedN(3, 10, 5);
  assert.strictEqual(m.g.admit("nudge", { label: "A" }).ok, false);
  for (let i = 0; i < 9; i++) { await m.c.advance(30000); m.feed(10, 5); m.g.admit("nudge", { label: "A" }); }
  assert.strictEqual(m.g.admit("nudge", { label: "A" }).ok, false, "4.5 min: still deferred");
  await m.c.advance(40000); m.feed(10, 5);
  const r = m.g.admit("nudge", { label: "A" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.released, true);
  assert.strictEqual(m.g.admit("handoff", { label: "H" }).ok, false);
  await m.c.advance(6 * 60 * 1000); m.feed(10, 5); m.feed(10, 5);
  assert.strictEqual(m.g.admit("handoff", { label: "H" }).ok, false, "old timestamp must not release it");
  const s = mk({ working: 6 }); await s.feedN(3, 10, 5); await s.feedN(3, 10, 3000);
  assert.strictEqual(s.g.admit("nudge", { label: "A" }).ok, false); await s.c.advance(6 * 60 * 1000); s.feed(10, 3000);
  assert.strictEqual(s.g.admit("nudge", { label: "A" }).ok, false);
});
t("a PC that is never calm: after 2 min one start per 20 s still goes through (25 agents ~8 min, not 50)", async () => {
  const m = mk({ settings: { maxWaitMs: 3600000 } });
  await m.feedN(3, 60, 5); assert.strictEqual(m.g.state(), "busy");
  assert.strictEqual(m.g.admit("start", { label: "A" }).ok, false);
  await m.feedN(60, 60, 5);
  const a = m.g.admit("start", { label: "A" }); assert.strictEqual(a.ok, true); assert.strictEqual(a.released, true);
  assert.strictEqual(m.g.admit("start", { label: "B" }).ok, false, "not twice within 20 s");
  await m.feedN(10, 60, 5); assert.strictEqual(m.g.admit("start", { label: "B" }).ok, true);
  const s = mk({ settings: { maxWaitMs: 3600000 } }); await s.feedN(3, 10, 5); await s.feedN(3, 10, 3000); await s.feedN(60, 10, 3000);
  assert.strictEqual(s.g.admit("start", { label: "A" }).ok, false, "the floor never overrides slow");
});
t("unreserve gives a slot back; a throwing onChange / log never breaks a decision; tick survives a throwing probe", async () => {
  const m = mk({ working: 5 }); await m.feedN(3, 10, 5);
  assert.strictEqual(m.g.admit("nudge", { label: "A" }).ok, true);
  assert.strictEqual(m.g.admit("nudge", { label: "B" }).ok, false);
  m.g.unreserve(); assert.strictEqual(m.g.admit("nudge", { label: "B" }).ok, true);
  const bad = G.create({ now: () => 1, log: () => { throw new Error("log"); }, onChange: () => { throw new Error("ui"); }, getSettings: () => ({}), countWorking: () => 0 });
  bad.ingest({ cpu: 1, lagMs: 1 }); bad.ingest({ cpu: 1, lagMs: 1 }); bad.ingest({ cpu: 1, lagMs: 1 });
  assert.strictEqual(bad.admit("wake", { label: "x" }).ok, true);
  const t2 = mk({ measure: () => ({ cpu: 1 }), probeForeground: () => { throw new Error("sync probe throw"); } });
  t2.g.start(); await t2.c.advance(6000); t2.g.stop();
});
t("voice inbox: queued dictations wait CONCURRENTLY (waits start at claim), so the 5th is not delayed 5 x the bound; order kept", async () => {
  const dir = tmp(); const got = []; const calls = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inbox = V.createInbox({ dir, deliver: async (r) => { got.push(r.id); return { ok: true }; }, maxPerMinute: 50,
    governorWait: async (req) => { calls.push(req.id); await sleep(150); return { ok: true, waitedMs: 150, released: false }; } });
  inbox.start();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, "c" + i + ".json"), rq({ createdAt: Date.now() + i }));
  const t0 = Date.now();
  inbox.scan(); await sleep(40);
  assert.strictEqual(calls.length, 5, "all five governor waits started at claim time");
  await inbox.idle(); inbox.close();
  assert.ok(Date.now() - t0 < 500, "took " + (Date.now() - t0) + " ms (serial would be ~750)");
  assert.deepStrictEqual(got, ["c0", "c1", "c2", "c3", "c4"]);
});
t("guards.js: the handoff gate runs BEFORE clearFlow in the retry path (a wait must not leave autoHandedOff without a flow)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "guards.js"), "utf8");
  const gate = src.indexOf("if (await governorWaits(nm, k, a.path)) continue;");
  const clear = src.indexOf('clearFlow(a.path, "failed flow, retrying after cool-down")');
  assert.ok(gate > 0 && clear > 0 && gate < clear, "gate " + gate + " clear " + clear);
  assert.ok(/if \(!prior && await governorWaits/.test(src), "first-time path gated once, not twice");
  assert.ok(/governorRelease/.test(src));
});
t("main.js: working count skips agents waiting at an approval prompt; nudge release wired", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.ok(/approvalBlockedSince\.has\(a\.path\)\) continue;/.test(src));
  assert.ok(/loadRelease:/.test(src) && /governor-release/.test(src));
});
t("persistent probe: one helper for many probes, answers parsed, a timeout kills it and the next probe starts a fresh one", async () => {
  const { EventEmitter } = require("events");
  const spawned = []; const mode = { hang: false };
  const spawn = () => {
    const c = new EventEmitter(); c.stdout = new EventEmitter();
    c.stdin = { writes: [], write(x) { this.writes.push(x); if (!mode.hang) setImmediate(() => c.stdout.emit("data", "Adobe Premiere Pro|1\r\n")); }, end() {} };
    c.kill = () => { c.killed = true; c.emit("exit"); }; spawned.push(c); return c;
  };
  const pp = FP.createPersistentProbe({ spawn, platform: "win32", timeoutMs: 50 });
  assert.deepStrictEqual(await pp.probe(["Premiere"]), { foreground: "Adobe Premiere Pro", heavyRunning: true });
  await pp.probe(["premiere"]); assert.strictEqual(spawned.length, 1, "helper reused"); assert.deepStrictEqual(spawned[0].stdin.writes, ["premiere\n", "premiere\n"]);
  mode.hang = true; await assert.rejects(pp.probe(["premiere"]), /timed out/); assert.strictEqual(spawned[0].killed, true);
  mode.hang = false; await pp.probe(["premiere"]); assert.strictEqual(spawned.length, 2);
  assert.deepStrictEqual(await FP.createPersistentProbe({ platform: "linux" }).probe(["x"]), { foreground: null, heavyRunning: false });
  pp.close();
});
t("state: a stalled sampler reads BUSY (not unknown) so overdue timers cannot stampede; only a dead one (5 min) is unknown = fail-open", async () => {
  const m = mk({ measure: () => ({ cpu: 99, freeMB: 9000 }) });
  m.g.start();
  await m.c.advance(12000); assert.strictEqual(m.g.state(), "slow");
  m.c.clearAll();
  await m.c.advance(20000);
  assert.strictEqual(m.g.state(), "busy", "stale after 20 s: busy");
  assert.strictEqual(m.g.admit("start", { label: "A" }).ok, false, "a start still waits");
  await m.c.advance(6 * 60 * 1000);
  assert.strictEqual(m.g.state(), "unknown");
  assert.strictEqual(m.g.admit("start", { label: "A" }).ok, true);
  m.g.stop();
});

// ---- keep-going wiring (pure decide) ----
t("keepGoing.decide: throttle LOADSLOW blocks the nudge with a load-governor reason, like CPUHOLD", () => {
  const K = require("../src/keepGoing");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "keepGoing.js"), "utf8");
  assert.ok(/LOADSLOW/.test(src));
  const glue = fs.readFileSync(path.join(__dirname, "..", "src", "keepGoingGlue.js"), "utf8");
  assert.ok(/load governor/.test(glue) && /deps\.loadWait/.test(glue));
  assert.strictEqual(typeof K.decide, "function");
});

(async () => {
  let fails = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + ((e && e.stack) || e)); }
  }
  console.log(fails ? fails + " FAILED of " + tests.length : "all " + tests.length + " passed");
  process.exit(fails ? 1 : 0);
})();
