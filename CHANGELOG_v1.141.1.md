# v1.141.1 - (2026-10-24) One reset = one live copy: a handoff reset waits for the old copy to be gone, a second reset is ignored, every reset logs its trigger

## Incident (Iddo asked why it keeps recurring)
"Close a duplicate copy" for Software Engineering listed b2991d0f and dc0d25f0, both "started by a handoff reset". Evidence:
- `%APPDATA%\agent-desktop\stuck-turn-watchdog.log`: auto-handoff flow START 03:12:45Z (183K); keep-going mission marker set 03:13:45.396 (the reset); `keepgoing-attach: ... attached to the running agent b2991d0f` 03:13:50.326; "flow finished OK" 03:13:52.8; later `stopEmptyDuplicateAgents: ... 2 live copies WITH conversations (b2991d0f, dc0d25f0)`.
- `~\.claude\daemon.log`: `bg spawned dc0d25f0 (shell)` 03:13:51.940, `bg settled b2991d0f (killed)` 03:13:53.332, `bg spawned b2991d0f (fleet)` 03:13:53.483. (The previous, correct reset at 02:28: `settled 998ad935 (killed)` THEN `spawned b2991d0f`.)
- Transcripts: b2991d0f's first prompt is the HANDOFF-RESUME of the 02:28 handoff (so it is the OLD copy, started by the previous reset); dc0d25f0's is the 06:13 handoff.

## Root cause (two triggers, no mutual exclusion)
1. The reset (`switch-conversation`, newConversation) stopped the old copy through `stopBackgroundAgentForCwd`, which gives up after a hard 5 s race. The PC was loaded (event-loop lag up to 2 s), the stop took ~8 s, so the race returned with b2991d0f still alive and the new copy dc0d25f0 was dispatched next to it.
2. During the reset the agent had no pty session, so keep-going's background attach (keepgoing-attach; it fired because the same reset had just set the "mission in progress" marker) attached a client to the still-listed OLD copy. When the late stop killed it, the daemon relaunched it for that client ("(fleet)" spawn 150 ms after the kill). Nothing told keepgoing-attach a reset was running.

## Fix
- `src/resetGuard.js` (new, pure): per-agent reset lock + idempotency window. `RESET_IDEMPOTENCY_MS` = 90 s, `RESET_SETTLE_MS` = 30 s, `STOP_CONFIRM_TIMEOUT_MS` = 30 s.
- `switchConversationImpl` (main.js) is the choke point: a new-conversation switch runs under `resetLock.run(key, trigger, ...)`. A second reset while one runs joins it; within 90 s after a good one it is ignored and handed the first copy id (`deduped: true`). A failed reset never blocks the next. Log lines `reset: <agent> START/DONE/FAILED/IGNORED second reset (trigger=...)` in stuck-turn-watchdog.log.
- The old copy must be gone first: `stopAllAndConfirmGone` stops EVERY live copy of the folder (fresh listings, not the 8 s cache), re-stops a copy that is still (or again) alive about every 5 s, and continues only when two listings >= 1 s apart show none. Still alive after 30 s = the switch throws, no second copy (the handoff flow shows its normal failure). Applies to Restart Session's resume switch too.
- keepgoing-attach treats an agent under reset (and 30 s after) as "spawning" (skips it); `dispatchedRecently` (keep-alive sweep, attach waits) counts a running reset as a start.
- `escalateStuckAgent` (stuck escalation, also a fresh-session reset) takes the same lock (trigger `stuck-escalation`).
- Renderer: every reset passes a trigger (`auto-handoff <K>`, `handoff-reset-button`, `handoff-all`, `context-banner-button`, `use-existing-handoff-button`, `reset-session-button`); a second `startFlow` for an agent with a running flow is logged; `advanceFlow` runs one tick at a time per flow (the 3 s interval could re-enter while IPC awaits were slow) and `runReset` refuses a second reset of the same flow; Reset Session shows "Already reset" for a deduped reset.

## Tests
`tests/resetGuard.test.js` (14): lock/join, 90 s window, failure does not block, settle window, the 8 s stop is waited for, the 150 ms respawn is caught and re-stopped, all copies stopped, deadline throws, failed listing is not "gone", plus source checks of the choke points (fail on v1.141.0). Full suite: 129 files pass.

## Sandbox
Test mode, own userData (`AGENT_DESKTOP_TEST_SUFFIX=dupfix`), CDP 9341, a read-only `fake-agent-copies.json` copy that cannot be stopped. Two concurrent `switch-conversation` resets: log shows `START (trigger=sandbox-A)`, `IGNORED second reset (trigger=sandbox-B) ... joining it`, re-stops, then `NOT starting a new copy: old copy ... still running 30 s after stop`; both calls rejected at 30.2 s; no dispatch. App booted as v1.141.1 with no main-process errors.

## SE review fixes (same version)
- (A, must) `findOrDispatchBackgroundAgent` (opening an agent's tab) waited only 5x2 s for a recent dispatch. Mid-reset it could find the dying old copy (attach = relaunch) or nothing (dispatch = second copy). Now: while a reset/restart of that agent is RUNNING (`resetLock.isRunning`, no settle window) it waits, polling 1 s, up to `RESET_WAIT_CAP_MS` (45 s), then re-finds with a fresh listing (fresh also during the 30 s settle window); still running at the cap = throws, never dispatches. `resetGuard.waitWhileRunning()`.
- (B, should) Resume switches (Restart Session button, `restartAgentSession` placeholder path, trigger `restart-agent-session` / `resume-switch`) take the same per-agent lock as "serial" jobs: never deduped, but a restart waits for a running reset and a reset waits for a running restart (then applies its normal window rule; a restart never records a reset or opens the 90 s window).
- (C) `escalateStuckAgentCore` uses `stopAllAndConfirmGone` instead of its own 10x500 ms loop; `stuckEscalation.js` logs "joined existing reset copy" when its escalation was deduped. `tests/stuckEscalation.test.js` source check updated accordingly.
- (D) Known behaviour: a deduped reset drops the SECOND caller's `initialPrompt`. Only the first reset's first prompt reaches the new copy; the second handoff flow's `pendingResume` then verifies/sends its own resume text into the reused copy (tickResume). Finished-reset records older than 10 minutes (`RESET_PRUNE_MS`) are pruned.
- Tests: resetGuard.test.js now 19 (the 5 new ones fail on ce037ec). Full suite 129/129.
