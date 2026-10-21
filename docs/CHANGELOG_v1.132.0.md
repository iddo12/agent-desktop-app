## v1.132.0 - Sync guard: Agent Desktop no longer freezes when Dropbox answers file opens slowly

- **Cause (found 2026-10-18):** a degraded Dropbox client made every file open on the synced folder cost a fixed ~2 s. Agent Desktop's main thread read about 60 agents' files with synchronous calls, so the whole window froze (stalls of up to 3.4 h were seen).
- **`src/syncGuard.js`**, installed first thing in `main.js` (main thread only; `AD_SYNCGUARD=0` turns it all off):
  - **Tracer:** every blocking sync call (`readFileSync`, `execSync`, `execFileSync`, `spawnSync`) records what and since when in shared memory; a worker thread appends to `%APPDATA%\agent-desktop\sync-stalls.log` when one is still running after 2 s, so a frozen main thread still leaves a trace.
  - **Read pool + cache:** reads of plain data files under the agents folder run in worker threads; the main thread waits at most 3 s and then throws `ETIMEDOUT` (callers already handle a missing file), while the late result is cached for next time. Cache is stale-while-revalidate and is dropped on any in-process write, rename or unlink. Locks, mailboxes, outboxes and tmp files are never cached.
  - **Exec timeouts:** sync exec calls with no timeout get a default one.
  - **Warming:** a cold read also warms its folder; agent folders are warmed at start. When reads are visibly slow a cold read waits only a short soft limit.
- **Review fix:** a timed-out read can no longer be written back as real config (`loadAgentConfig` catch-default-write path checked).
- Startup measured at 5 s (was 70+ s with the slow client). Full `npm test`: 0 failures; sandbox run ok. Needs a restart (live since 2026-10-18 21:10).
- Watch for 24 h: `%APPDATA%\agent-desktop\sync-stalls.log`, `stuck-turn-watchdog.log`.
