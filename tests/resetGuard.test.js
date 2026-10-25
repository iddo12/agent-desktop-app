// Run: node tests/resetGuard.test.js - v1.141.1 one reset = one live copy (incident 2026-10-24 06:13, Software Engineering copies
// b2991d0f + dc0d25f0): the per-agent reset lock + idempotency window, the strict "old copy confirmed gone before the new one"
// stop, and source checks that main.js / guards.js / renderer.js really use them at the reset choke points. Fails on v1.141.0.
"use strict";
const assert = require("assert"), fs = require("fs"), path = require("path");
const RG = require("../src/resetGuard");

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const S = 1000;

function clock(start) {
  let ms = start || 1000000;
  return { now: () => ms, advance: (d) => { ms += d; }, sleep: async (d) => { ms += d; } };
}

// ---- reset lock / idempotency window ----
t("a second reset while the first is running joins it: fn runs once, both get the same copy, the second is marked deduped", async () => {
  const c = clock(); const logs = [];
  const g = RG.create({ now: c.now });
  let calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  const p1 = g.run("k", "auto-handoff", async () => { calls++; await gate; return { ok: true, agentId: "dc0d25f0" }; }, (m) => logs.push(m));
  const p2 = g.run("k", "handoff-reset-button", async () => { calls++; return { ok: true, agentId: "SECOND" }; }, (m) => logs.push(m));
  assert.strictEqual(g.isBusy("k"), true);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(calls, 1);
  assert.strictEqual(r1.agentId, "dc0d25f0"); assert.strictEqual(r1.deduped, false);
  assert.strictEqual(r2.agentId, "dc0d25f0"); assert.strictEqual(r2.deduped, true); assert.strictEqual(r2.firstTrigger, "auto-handoff");
  assert.ok(logs.some((l) => /IGNORED second reset \(trigger=handoff-reset-button\)/.test(l)), logs.join("\n"));
  assert.ok(logs.some((l) => /START \(trigger=auto-handoff\)/.test(l)));
});

t("a second reset within the 90 s window after a good one is ignored; after the window it runs", async () => {
  const c = clock();
  const g = RG.create({ now: c.now });
  let calls = 0;
  const fn = async () => ({ ok: true, agentId: "id" + (++calls) });
  await g.run("k", "a", fn);
  c.advance(RG.RESET_IDEMPOTENCY_MS - 1 * S);
  const r2 = await g.run("k", "b", fn);
  assert.strictEqual(calls, 1); assert.strictEqual(r2.deduped, true); assert.strictEqual(r2.agentId, "id1");
  c.advance(2 * S);
  const r3 = await g.run("k", "c", fn);
  assert.strictEqual(calls, 2); assert.strictEqual(r3.deduped, false); assert.strictEqual(r3.agentId, "id2");
});

t("a FAILED reset never blocks the next try, and other agents are independent", async () => {
  const c = clock();
  const g = RG.create({ now: c.now });
  await assert.rejects(g.run("k", "a", async () => { throw new Error("stop timed out"); }), /stop timed out/);
  assert.strictEqual(g.isBusy("k"), false);
  const r = await g.run("k", "b", async () => ({ ok: true, agentId: "x" }));
  assert.strictEqual(r.deduped, false);
  const o = await g.run("other", "a", async () => ({ ok: true, agentId: "y" }));
  assert.strictEqual(o.deduped, false); assert.strictEqual(o.agentId, "y");
});

t("isBusy: true while running and for the settle window after, then false; busyKeys lists them", async () => {
  const c = clock();
  const g = RG.create({ now: c.now });
  await g.run("k", "a", async () => ({ agentId: "x" }));
  assert.strictEqual(g.isBusy("k"), true);
  assert.deepStrictEqual(g.busyKeys(), ["k"]);
  c.advance(RG.RESET_SETTLE_MS + 1);
  assert.strictEqual(g.isBusy("k"), false);
  assert.deepStrictEqual(g.busyKeys(), []);
});

// ---- strict stop: the old copy must be gone before the new one starts ----
// fake daemon: a copy that dies `dieAfterMs` after its stop is requested; optional respawn (the "fleet" relaunch for an attached client)
function fakeDaemon(c, copies) {
  const state = copies.map((x) => ({ ...x, stopAt: null }));
  return {
    state,
    listCopies: async () => {
      const t = c.now();
      for (const x of state) if (x.respawnAt && t >= x.respawnAt) { x.alive = true; x.respawnAt = null; x.stopAt = null; x.respawned = true; }
      for (const x of state) if (x.alive && x.stopAt !== null && t >= x.stopAt) {
        x.alive = false;
        if (x.respawnOnceAfterMs != null && !x.respawned) x.respawnAt = t + x.respawnOnceAfterMs;
      }
      return state.filter((x) => x.alive).map((x) => ({ id: x.id }));
    },
    stop: async (id) => { const x = state.find((s) => s.id === id); if (x && x.alive && x.stopAt === null) x.stopAt = c.now() + x.dieAfterMs; },
  };
}

t("INCIDENT: a stop that takes 8 s on a loaded PC is waited for (the old 5 s race gave up and dispatched next to it)", async () => {
  const c = clock();
  const d = fakeDaemon(c, [{ id: "b2991d0f", alive: true, dieAfterMs: 8 * S }]);
  const r = await RG.stopAllAndConfirmGone({ ...d, sleep: c.sleep, now: c.now });
  assert.deepStrictEqual(r.stopped, ["b2991d0f"]);
  assert.ok(r.waitedMs >= 8 * S, "returned after " + r.waitedMs + " ms, before the old copy died");
  assert.strictEqual(d.state[0].alive, false);
});

t("INCIDENT: an old copy relaunched ~150 ms after its kill (attached client) is caught and stopped again", async () => {
  const c = clock();
  const d = fakeDaemon(c, [{ id: "b2991d0f", alive: true, dieAfterMs: 2 * S, respawnOnceAfterMs: 150 }]);
  const logs = [];
  const r = await RG.stopAllAndConfirmGone({ ...d, sleep: c.sleep, now: c.now, log: (m) => logs.push(m) }, { pollMs: 100 });
  assert.strictEqual(d.state[0].respawned, true, "the respawn did happen in the fake");
  assert.strictEqual(d.state[0].alive, false, "returned while the relaunched copy was alive");
  assert.ok(logs.some((l) => /stopping copy b2991d0f again/.test(l)), logs.join("\n"));
  assert.ok(r.waitedMs >= 2 * S);
});

t("every live copy of the folder is stopped, not only the first one", async () => {
  const c = clock();
  const d = fakeDaemon(c, [{ id: "a", alive: true, dieAfterMs: 500 }, { id: "b", alive: true, dieAfterMs: 1500 }]);
  const r = await RG.stopAllAndConfirmGone({ ...d, sleep: c.sleep, now: c.now });
  assert.deepStrictEqual(r.stopped.sort(), ["a", "b"]);
  assert.ok(d.state.every((x) => !x.alive));
});

t("a copy still alive at the deadline throws (the caller must not start a second copy)", async () => {
  const c = clock();
  const d = fakeDaemon(c, [{ id: "stuck", alive: true, dieAfterMs: 10 * 60 * S }]);
  await assert.rejects(RG.stopAllAndConfirmGone({ ...d, sleep: c.sleep, now: c.now }, { timeoutMs: 5 * S }), /still running .* not starting a second copy/);
});

t("a failing listing is never read as 'gone'", async () => {
  const c = clock();
  await assert.rejects(RG.stopAllAndConfirmGone({ listCopies: async () => { throw new Error("timeout"); }, stop: async () => {}, sleep: c.sleep, now: c.now }, { timeoutMs: 3 * S }), /could not confirm/);
});

t("nothing running: returns at once (after the short stable check) without stopping anything", async () => {
  const c = clock();
  let stops = 0;
  const r = await RG.stopAllAndConfirmGone({ listCopies: async () => [], stop: async () => { stops++; }, sleep: c.sleep, now: c.now });
  assert.strictEqual(stops, 0); assert.deepStrictEqual(r.stopped, []);
  assert.ok(r.waitedMs <= 2 * S);
});

// ---- source checks: the reset choke points really use the guard ----
const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf-8").split("\r\n").join("\n");
function fnBody(text, header) {
  const i = text.indexOf(header);
  assert.ok(i >= 0, "missing: " + header);
  const j = text.indexOf("\n}\n", i);
  return text.slice(i, j);
}
t("main.js: switch-conversation (new conversation) goes through the reset lock and logs its trigger", () => {
  const m = src("main.js");
  const impl = fnBody(m, "function switchConversationImpl(");
  assert.ok(/resetLock\.run\(/.test(impl));
  assert.ok(/a\.trigger/.test(impl));
});
t("main.js: the switch waits for the old copy (stopAllAndConfirmGone), never the 5 s-race stopBackgroundAgentForCwd", () => {
  const m = src("main.js");
  const core = fnBody(m, "async function switchConversationCore(");
  assert.ok(/stopAllAndConfirmGone\(/.test(core));
  assert.ok(!/stopBackgroundAgentForCwd\(/.test(core));
  assert.ok(/fresh: true/.test(core), "the stop confirmation must use FRESH listings, not the 8 s cache");
});
t("main.js: keepgoing-attach and the keep-alive sweep keep off an agent during/just after its reset; escalation takes the lock", () => {
  const m = src("main.js");
  assert.ok(/spawningSet: \(\) => new Set\(\[\.\.\.attachSpawning\.keys\(\), \.\.\.resetBusyAgentPaths\(\)\]\)/.test(m));
  assert.ok(/if \(resetLock\.isBusy\(k\)\) return true;/.test(fnBody(m, "function dispatchedRecently(")));
  assert.ok(/resetLock\.run\(dispatchKey\(sessionCwd\), "stuck-escalation"/.test(fnBody(m, "function escalateStuckAgent(")));
  // the lock is created before any code that can use it at load time (no temporal-dead-zone ReferenceError)
  assert.ok(m.indexOf("const resetLock = resetGuard.create()") < m.indexOf("function dispatchedRecently("));
});
t("renderer: every reset passes a trigger; one handoff flow tick at a time; runReset refuses a second reset of the same flow", () => {
  const g = src("renderer/guards.js"), r = src("renderer/renderer.js");
  assert.ok(/if \(!flow \|\| flow\.phase !== "saving" \|\| flow\.advancing\) return;/.test(g));
  assert.ok(/second reset for the same handoff ignored/.test(g));
  assert.ok(/performSessionReset\(agentPath, \{ initialPrompt: resumeText, trigger:/.test(g));
  assert.ok(/startFlow\(a\.path, false, "auto-handoff/.test(g));
  assert.ok(/trigger: opts\.trigger \|\| "unspecified"/.test(r));
  assert.ok(/performSessionReset\(activeAgentPath, \{ trigger: "reset-session-button" \}\)/.test(r));
});

// ---- SE review fixes (same version) ----
t("serial (restart) waits for a running reset and is never deduped; a reset waits for a running restart, then runs", async () => {
  const c = clock(); const logs = [];
  const g = RG.create({ now: c.now });
  const order = [];
  let rel1; const gate1 = new Promise((r) => { rel1 = r; });
  const pReset = g.run("k", "auto-handoff", async () => { order.push("reset-start"); await gate1; order.push("reset-end"); return { agentId: "new" }; }, (m) => logs.push(m));
  const pRestart = g.run("k", "restart", async () => { order.push("restart"); return { ok: true, agentId: "resumed" }; }, (m) => logs.push(m), { kind: "serial" });
  await Promise.resolve(); await Promise.resolve();
  assert.deepStrictEqual(order, ["reset-start"], "the restart started while the reset ran");
  rel1();
  const [r1, r2] = await Promise.all([pReset, pRestart]);
  assert.deepStrictEqual(order, ["reset-start", "reset-end", "restart"]);
  assert.strictEqual(r1.agentId, "new"); assert.strictEqual(r2.agentId, "resumed"); assert.ok(!r2.deduped);
  assert.ok(logs.some((l) => /WAITING \(serial, trigger=restart\)/.test(l)), logs.join("\n"));
  // a reset arriving while a restart runs waits for it, and is not "joined" to the restart
  let rel2; const gate2 = new Promise((r) => { rel2 = r; });
  c.advance(RG.RESET_IDEMPOTENCY_MS + 1);
  const pR2 = g.run("k", "restart2", async () => { await gate2; return { agentId: "resumed2" }; }, null, { kind: "serial" });
  let resetRan = false;
  const pX = g.run("k", "button", async () => { resetRan = true; return { agentId: "fresh2" }; });
  await Promise.resolve();
  assert.strictEqual(resetRan, false);
  rel2();
  const [, rx] = await Promise.all([pR2, pX]);
  assert.strictEqual(resetRan, true); assert.strictEqual(rx.agentId, "fresh2"); assert.strictEqual(rx.deduped, false);
});

t("isRunning is only the in-flight part (no settle window); waitWhileRunning clears or gives up at the cap", async () => {
  const c = clock();
  const g = RG.create({ now: c.now });
  let rel; const gate = new Promise((r) => { rel = r; });
  const p = g.run("k", "a", async () => { await gate; return { agentId: "x" }; });
  assert.strictEqual(g.isRunning("k"), true);
  assert.strictEqual(await RG.waitWhileRunning({ isRunning: () => g.isRunning("k"), sleep: c.sleep, now: c.now }, { capMs: 5 * S }), false);
  rel(); await p;
  assert.strictEqual(g.isRunning("k"), false); assert.strictEqual(g.isBusy("k"), true);
  let polls = 0;
  const ok = await RG.waitWhileRunning({ isRunning: () => ++polls < 3, sleep: c.sleep, now: c.now });
  assert.strictEqual(ok, true); assert.strictEqual(polls, 3);
});

t("finished-reset records older than 10 minutes are pruned", async () => {
  const c = clock();
  const g = RG.create({ now: c.now });
  await g.run("a", "t", async () => ({ agentId: "1" }));
  await g.run("b", "t", async () => ({ agentId: "2" }));
  assert.strictEqual(g.size(), 2);
  c.advance(RG.RESET_PRUNE_MS + 1);
  g.busyKeys();
  assert.strictEqual(g.size(), 0);
});

t("main.js (SE review A): opening an agent mid-reset waits for the reset, re-finds fresh, throws instead of dispatching", () => {
  const m = src("main.js");
  const f = fnBody(m, "async function findOrDispatchBackgroundAgent(");
  const iWait = f.indexOf("resetGuard.waitWhileRunning(");
  assert.ok(/if \(resetRunning\(sessionCwd\)\)/.test(f) && iWait > 0, "no wait for a running reset");
  assert.ok(/if \(!cleared\) throw new Error/.test(f));
  assert.ok(iWait < f.indexOf("findAliveBackgroundAgent("), "must wait BEFORE the first find (else it finds the dying old copy)");
  assert.ok(iWait < f.indexOf("dispatchBackgroundAgent(shell"));
  assert.ok(/findAliveBackgroundAgent\(shell, spawnEnv, sessionCwd, \{ fresh: resetBusy\(sessionCwd\) \}\)/.test(f));
});
t("main.js (SE review B/C): resume switches take the lock as serial jobs; escalation uses the confirmed stop; deduped escalation logged", () => {
  const m = src("main.js");
  assert.ok(/\{ kind: a\.newConversation \? "reset" : "serial" \}/.test(fnBody(m, "function switchConversationImpl(")));
  assert.ok(!/if \(!args \|\| !args\.newConversation\) return switchConversationCore/.test(m));
  const esc = fnBody(m, "async function escalateStuckAgentCore(");
  assert.ok(/resetGuard\.stopAllAndConfirmGone\(/.test(esc));
  assert.ok(!/i < 10; i\+\+\) \{ await new Promise/.test(esc));
  assert.ok(/joined existing reset copy/.test(src("stuckEscalation.js")));
});

(async () => {
  let fails = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok   - " + name); } catch (e) { fails++; console.log("FAIL - " + name + "\n       " + (e && e.stack || e)); }
  }
  console.log(`\n${tests.length - fails}/${tests.length} passed`);
  process.exit(fails ? 1 : 0);
})();
