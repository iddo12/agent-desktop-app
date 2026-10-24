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
const STOP_POLL_MS = 500;
const STOP_STABLE_GAP_MS = 1000;        // "gone" must hold on two listings at least this far apart (a respawn lands ~150 ms after a kill)

function create(opts) {
  const o = opts || {};
  const now = o.now || (() => Date.now());
  const windowMs = o.idempotencyMs != null ? o.idempotencyMs : RESET_IDEMPOTENCY_MS;
  const settleMs = o.settleMs != null ? o.settleMs : RESET_SETTLE_MS;
  const state = new Map(); // key -> { trigger, startedAt, promise, doneAt, result }

  // Runs fn() as THE reset of `key`, unless one is in flight or finished well within the window.
  // Resolves { ...fn result, deduped:false } or, for an ignored second reset, { ...first result, deduped:true, firstTrigger }.
  function run(key, trigger, fn, log) {
    const say = (m) => { try { if (log) log(m); } catch (e) { /* logging never breaks a reset */ } };
    const cur = state.get(key);
    const t = now();
    if (cur && cur.promise) {
      say(`IGNORED second reset (trigger=${trigger}): a reset (trigger=${cur.trigger}) started ${Math.round((t - cur.startedAt) / 1000)} s ago is still running - joining it`);
      return cur.promise.then((r) => ({ ...r, deduped: true, firstTrigger: cur.trigger }));
    }
    if (cur && cur.doneAt && t - cur.doneAt < windowMs) {
      say(`IGNORED second reset (trigger=${trigger}): a reset (trigger=${cur.trigger}) finished ${Math.round((t - cur.doneAt) / 1000)} s ago (window ${Math.round(windowMs / 1000)} s) - reusing its copy ${cur.result && cur.result.agentId}`);
      return Promise.resolve({ ...(cur.result || {}), deduped: true, firstTrigger: cur.trigger });
    }
    const entry = { trigger, startedAt: t, promise: null, doneAt: 0, result: null };
    say(`START (trigger=${trigger})`);
    entry.promise = Promise.resolve()
      .then(fn)
      .then((r) => {
        entry.promise = null; entry.doneAt = now(); entry.result = r || {};
        say(`DONE (trigger=${trigger}) new copy ${entry.result.agentId || "?"} after ${Math.round((entry.doneAt - t) / 1000)} s`);
        return { ...entry.result, deduped: false };
      }, (e) => {
        if (state.get(key) === entry) state.delete(key); // a failed reset never blocks the next try
        say(`FAILED (trigger=${trigger}): ${e && e.message}`);
        throw e;
      });
    state.set(key, entry);
    return entry.promise;
  }

  // true while a reset of `key` runs and for settleMs after it finished
  function isBusy(key) {
    const cur = state.get(key);
    if (!cur) return false;
    if (cur.promise) return true;
    return !!cur.doneAt && now() - cur.doneAt < settleMs;
  }
  function busyKeys() { return Array.from(state.keys()).filter(isBusy); }

  return { run, isBusy, busyKeys };
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

module.exports = { create, stopAllAndConfirmGone, RESET_IDEMPOTENCY_MS, RESET_SETTLE_MS, STOP_CONFIRM_TIMEOUT_MS };
