"use strict";
// v1.141.1 one reset = one live copy. Incident 2026-10-24 06:13 (Software Engineering, copies b2991d0f + dc0d25f0):
//   1. the auto-handoff reset (switch-conversation, newConversation) asked `claude stop` for the OLD copy b2991d0f, but the stop
//      helper (stopBackgroundAgentForCwd) gives up after a hard 5 s race. The PC was loaded (event-loop lag ~2 s), the stop took
//      ~8 s (requested 03:13:45, daemon "settled b2991d0f (killed)" 03:13:53.3), so the fresh copy dc0d25f0 was dispatched at
//      03:13:51.9 while the old one was still alive;
//   2. in that window the agent had no pty session, so keep-going's background attach (keepgoing-attach, 03:13:50, triggered by
//      the mission marker the same reset had just set) claimed it and attached a client to the OLD copy. When the late stop landed,
//      the daemon relaunched b2991d0f for that client ("bg spawned b2991d0f (fleet)", 150 ms after the kill).
// Both copies then read "started by a handoff reset" because b2991d0f had itself been started by the PREVIOUS reset (02:28).
//
// This module is the pure part of the fix (every side effect injected, unit-tested in tests/resetGuard.test.js):
//   * create(): a per-agent reset lock + idempotency window. A second reset of the same agent while one is in flight, or within
//     RESET_IDEMPOTENCY_MS of a successful one, is ignored (logged) and handed the first one's result; isBusy() tells other
//     starters/attachers (keep-going attach, keep-alive sweep) to keep their hands off the agent during and just after a reset.
//   * stopAllAndConfirmGone(): stop EVERY live copy of the folder and only resolve once two fresh listings in a row show none.
//     Throws if a copy is still there at the deadline: the caller must NOT start a new copy then (a failed reset beats two copies).

const RESET_IDEMPOTENCY_MS = 90 * 1000; // a second reset of the same agent inside this window after a good one is ignored
const RESET_SETTLE_MS = 30 * 1000;      // after a reset, attach/sweep paths keep off the agent this long (stale listings)
const STOP_CONFIRM_TIMEOUT_MS = 30 * 1000;
const RESET_WAIT_CAP_MS = 45 * 1000;    // an agent-tab open waits at most this long for a running reset before giving up (throws)
const RESET_PRUNE_MS = 10 * 60 * 1000;  // finished-reset records older than this are dropped
const STOP_POLL_MS = 500;
const STOP_STABLE_GAP_MS = 1000;        // "gone" must hold on two listings at least this far apart (a respawn lands ~150 ms after a kill)

function create(opts) {
  const o = opts || {};
  const now = o.now || (() => Date.now());
  const windowMs = o.idempotencyMs != null ? o.idempotencyMs : RESET_IDEMPOTENCY_MS;
  const settleMs = o.settleMs != null ? o.settleMs : RESET_SETTLE_MS;
  const pruneMs = o.pruneMs != null ? o.pruneMs : RESET_PRUNE_MS;
  const inflight = new Map();  // key -> { kind: "reset"|"serial", trigger, startedAt, promise }
  const lastReset = new Map(); // key -> { trigger, doneAt, result } of the last SUCCESSFUL reset

  function prune() {
    const t = now();
    for (const [k, v] of lastReset) if (t - v.doneAt > pruneMs) lastReset.delete(k);
  }

  // kind "reset" (default): runs fn() as THE reset of `key`, unless a reset is in flight (join it) or one finished within the
  //   window (reuse its copy). Resolves { ...fn result, deduped:false } or { ...first result, deduped:true, firstTrigger }.
  // kind "serial" (Restart Session's resume switch): never deduped, but waits for whatever runs on this key first, so a restart
  //   and a reset of one agent never overlap. A reset arriving while a serial job runs waits for it too, then decides.
  function run(key, trigger, fn, log, runOpts) {
    const kind = (runOpts && runOpts.kind) || "reset";
    const say = (m) => { try { if (log) log(m); } catch (e) { /* logging never breaks a reset */ } };
    prune();
    const cur = inflight.get(key);
    const t = now();
    if (cur) {
      if (kind === "reset" && cur.kind === "reset") {
        say(`IGNORED second reset (trigger=${trigger}): a reset (trigger=${cur.trigger}) started ${Math.round((t - cur.startedAt) / 1000)} s ago is still running - joining it`);
        return cur.promise.then((r) => ({ ...r, deduped: true, firstTrigger: cur.trigger }));
      }
      say(`WAITING (${kind}, trigger=${trigger}): a ${cur.kind} (trigger=${cur.trigger}) is still running on this agent`);
      return cur.promise.catch(() => {}).then(() => run(key, trigger, fn, log, runOpts));
    }
    const last = lastReset.get(key);
    if (kind === "reset" && last && t - last.doneAt < windowMs) {
      say(`IGNORED second reset (trigger=${trigger}): a reset (trigger=${last.trigger}) finished ${Math.round((t - last.doneAt) / 1000)} s ago (window ${Math.round(windowMs / 1000)} s) - reusing its copy ${last.result && last.result.agentId}`);
      return Promise.resolve({ ...(last.result || {}), deduped: true, firstTrigger: last.trigger });
    }
    const entry = { kind, trigger, startedAt: t, promise: null };
    say(`START (${kind === "reset" ? "" : kind + ", "}trigger=${trigger})`);
    entry.promise = Promise.resolve()
      .then(fn)
      .then((r) => {
        if (inflight.get(key) === entry) inflight.delete(key);
        const res = r || {};
        if (kind === "reset") lastReset.set(key, { trigger, doneAt: now(), result: res });
        say(`DONE (${kind === "reset" ? "" : kind + ", "}trigger=${trigger}) copy ${res.agentId || "?"} after ${Math.round((now() - t) / 1000)} s`);
        return kind === "reset" ? { ...res, deduped: false } : r;
      }, (e) => {
        if (inflight.get(key) === entry) inflight.delete(key); // a failed reset never blocks the next try
        say(`FAILED (${kind === "reset" ? "" : kind + ", "}trigger=${trigger}): ${e && e.message}`);
        throw e;
      });
    inflight.set(key, entry);
    return entry.promise;
  }

  // a reset / restart is running on `key` right now (not counting the settle window)
  function isRunning(key) { return inflight.has(key); }
  // true while something runs on `key` and for settleMs after a reset finished (attach paths: stale listings)
  function isBusy(key) {
    if (inflight.has(key)) return true;
    const last = lastReset.get(key);
    return !!last && now() - last.doneAt < settleMs;
  }
  function busyKeys() { prune(); return Array.from(new Set([...inflight.keys(), ...lastReset.keys()])).filter(isBusy); }
  function size() { return lastReset.size + inflight.size; } // tests: pruning

  return { run, isRunning, isBusy, busyKeys, size };
}

// Waits while isRunning() is true (poll pollMs, cap capMs). Resolves true once it cleared, false if still running at the cap.
async function waitWhileRunning(deps, opts) {
  const o = opts || {};
  const capMs = o.capMs != null ? o.capMs : RESET_WAIT_CAP_MS;
  const pollMs = o.pollMs != null ? o.pollMs : 1000;
  const now = deps.now || (() => Date.now());
  const t0 = now();
  while (deps.isRunning()) {
    if (now() - t0 >= capMs) return false;
    await deps.sleep(pollMs);
  }
  return true;
}

// deps: listCopies() -> Promise<[{id}]> (FRESH listing of the live copies of this one folder), stop(id) -> Promise,
//       sleep(ms), now(), log(msg). Resolves { stopped: [ids], waitedMs }. Throws when a copy is still alive at the deadline.
async function stopAllAndConfirmGone(deps, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs != null ? o.timeoutMs : STOP_CONFIRM_TIMEOUT_MS;
  const pollMs = o.pollMs != null ? o.pollMs : STOP_POLL_MS;
  const gapMs = o.stableGapMs != null ? o.stableGapMs : STOP_STABLE_GAP_MS;
  const now = deps.now || (() => Date.now());
  const log = (m) => { try { if (deps.log) deps.log(m); } catch (e) { /* never */ } };
  const t0 = now();
  const stopped = new Set();
  let goneSince = null;
  let rounds = 0;
  for (;;) {
    let live;
    try { live = await deps.listCopies(); } catch (e) {
      // an unreadable listing is "unknown", never "gone": keep polling until the deadline
      log(`listing failed: ${e && e.message}`);
      goneSince = null;
      if (now() - t0 >= timeoutMs) throw new Error(`could not confirm the old copy is gone (listing failed: ${e && e.message}) - not starting a second copy`);
      await deps.sleep(pollMs);
      continue;
    }
    if (!live.length) {
      if (goneSince === null) goneSince = now();
      if (now() - goneSince >= gapMs) return { stopped: Array.from(stopped), waitedMs: now() - t0 };
    } else {
      goneSince = null;
      // stop each copy we have not asked yet; ask again for any still there after a few polls (a stop can be lost or a copy respawned)
      const again = rounds > 0 && rounds % 10 === 0; // about every 5 s
      for (const c of live) {
        if (!stopped.has(c.id) || again) {
          log(`stopping copy ${c.id}${stopped.has(c.id) ? " again (still alive)" : ""}`);
          stopped.add(c.id);
          try { await deps.stop(c.id); } catch (e) { log(`stop ${c.id} failed: ${e && e.message}`); }
        }
      }
      rounds++;
    }
    if (now() - t0 >= timeoutMs && live.length) {
      const ids = live.map((c) => c.id).join(", ");
      throw new Error(`old copy (${ids}) still running ${Math.round((now() - t0) / 1000)} s after stop - not starting a second copy`);
    }
    await deps.sleep(pollMs);
  }
}

module.exports = { create, stopAllAndConfirmGone, waitWhileRunning, RESET_IDEMPOTENCY_MS, RESET_SETTLE_MS, STOP_CONFIRM_TIMEOUT_MS, RESET_WAIT_CAP_MS, RESET_PRUNE_MS };
