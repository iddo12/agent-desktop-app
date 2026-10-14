// My Health stage 1b: optional routine reminders. ONE timer handle, and it exists ONLY while at least one reminder is enabled:
// it is armed for the next reminder time, fires once, re-checks the rules at that moment (open today, not skipped, outside quiet
// hours, not snoozed) and is re-armed. Nothing is armed when no reminder is enabled (no timer, no polling).
// The notification text is NEUTRAL and fixed: it never names a routine or any health detail.
// The Electron Notification and the clock are injected, so this file needs neither Electron nor a real timer in tests.
"use strict";
const R = require("./routines");

const NEUTRAL_TEXT = "Routine: time for a chunk";
const MAX_DELAY = 2147000000;

function create(deps) {
  const d = deps || {};
  const say = typeof d.log === "function" ? d.log : () => {};
  const now = typeof d.now === "function" ? d.now : () => Date.now();
  const setT = d.setTimeout || setTimeout, clearT = d.clearTimeout || clearTimeout;
  let timer = null, dueAt = null;

  function stop() { if (timer != null) { clearT(timer); timer = null; } dueAt = null; }
  function rearm() {
    stop();
    let state; try { state = d.load(); } catch (e) { return { armed: false }; }
    if (!R.enabledAny(state)) return { armed: false };
    const t = R.nextDue(state, now()); if (t == null) return { armed: false };
    dueAt = t;
    timer = setT(fire, Math.min(Math.max(t - now(), 1000), MAX_DELAY));
    if (timer && typeof timer.unref === "function") timer.unref();
    return { armed: true, at: t };
  }
  function fire() {
    timer = null;
    let state; try { state = d.load(); } catch (e) { state = null; }
    if (state && R.shouldNotify(state, now())) { try { d.notify(NEUTRAL_TEXT); say("reminder: shown=1"); } catch (e) { say("reminder: shown=0"); } }
    rearm();
  }
  return { boot: rearm, rearm, stop, armed: () => timer != null, dueAt: () => dueAt, fire };
}

module.exports = { create, NEUTRAL_TEXT };
