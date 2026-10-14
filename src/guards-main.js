// Main-process half of the "guards" feature (v1.23.0): handoff-reset support and
// usage-limit warnings. Deliberately isolated from main.js - main.js loads this
// inside try/catch, so a bug here can only disable the guards, never the app.
//
//  - guard-handoff-info      : does <agent>\handoff_latest.md exist / how fresh is it
//  - guard-archive-handoff   : copy it to <agent>\handoff_history\handoff_<stamp>.md
//                              (so the reset marker keeps showing THAT reset's lessons
//                              even after a later handoff overwrites handoff_latest.md)
//  - guard-limit-status      : real 5h / weekly % (Anthropic's own, via the statusline
//                              cache) + whether this agent's last turn was halted by a limit
//  - a 60 s poller that raises an OS notification when the 5h or weekly window crosses
//    80 / 90 / 95 % (once per threshold per window). The "limit actually hit" notification
//    already exists in main.js (notifyHalt) and is not duplicated here.
const fs = require("fs");
const path = require("path");

const THRESHOLDS = [80, 90, 95];
const POLL_MS = 60 * 1000;

function init({ ipcMain, Notification, getMainWindow, sessionCwdFor, archive, log, resolveClaudeExecutable }) {
  const say = typeof log === "function" ? log : () => {};

  // 2026-09-20 follow-up: the auth-broken banner used to just print
  // `claude auth login` as text - which then fails from a plain PowerShell
  // window on this machine (claude.cmd is a symlink Windows can't always
  // resolve, see memory claude-cmd-symlink-flakiness), forcing the owner to hunt
  // down the real claude.exe path by hand every time. This button reuses
  // main.js's own resolveClaudeExecutable() (the same lookup that already
  // handles that symlink) and opens a normal, visible console window running
  // it - not a fully hidden spawn - since the login flow's own behavior
  // (does it need a keypress after the browser step completes?) isn't
  // something to gamble on hiding from view.
  ipcMain.handle("guard-trigger-login", () => {
    try {
      const claudeExe = typeof resolveClaudeExecutable === "function" ? resolveClaudeExecutable() : "claude";
      const child = require("child_process").spawn("cmd.exe", ["/c", "start", '""', `"${claudeExe}"`, "auth", "login"], {
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
      });
      child.unref();
      say(`guard-trigger-login: launched ${claudeExe} auth login in a new console window`);
      return { ok: true };
    } catch (e) {
      say(`guard-trigger-login failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  });

  // v1.63.4: deliver a prompt over the agent's message channel (see agentChannel.js). Returns
  // {ok:false, reason} when the channel is unavailable so the renderer falls back to pty typing.
  ipcMain.handle("guard-channel-send", async (event, { agentPath, text }) => {
    try {
      return await require("./agentChannel").send(agentPath, String(text || ""));
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });

  ipcMain.handle("guard-channel-cancel", (event, { id }) => {
    try { return require("./agentChannel").cancel(id); } catch (e) { return { ok: false, reason: e.message }; }
  });

  // v1.67.1: user messages held until a handoff finishes survive an app restart (renderer guards.js parkedQueues).
  const heldPath = () => path.join(require("electron").app.getPath("userData"), "held-queues.json");
  ipcMain.handle("guard-held-save", (event, { json }) => {
    try {
      const tmp = heldPath() + ".tmp";
      fs.writeFileSync(tmp, String(json || "{}"), { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(tmp, heldPath());
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle("guard-held-load", () => {
    try { return { ok: true, json: fs.readFileSync(heldPath(), "utf-8") }; } catch (e) { return { ok: true, json: "{}" }; }
  });

  // v1.69.15: unsent-message ledger (renderer unsent-ledger.js): messages stay on disk until the transcript proves delivery.
  const ledgerPath = () => path.join(require("electron").app.getPath("userData"), "unsent-ledger.json");
  ipcMain.handle("ledger-save", (event, { json }) => {
    try {
      const tmp = ledgerPath() + ".tmp";
      fs.writeFileSync(tmp, String(json || "{}"), { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(tmp, ledgerPath());
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle("ledger-load", () => {
    try { return { ok: true, json: fs.readFileSync(ledgerPath(), "utf-8") }; } catch (e) { return { ok: true, json: "{}" }; }
  });

  // v1.100.0: message outbox with acknowledgement (renderer outbox.js, logic src/outbox.js). Atomic write, UTF-8 without
  // BOM, size-capped; a corrupt or oversized file loads as empty (never blocks sending).
  const outboxPath = () => path.join(require("electron").app.getPath("userData"), "outbox.json");
  // v1.101.0 (S5): the rename is retried once (AV / the indexer can hold the target for a moment: EPERM / EBUSY); a failure
  // is returned, and the renderer keeps the state in memory and saves again.
  ipcMain.handle("outbox-save", async (event, { json }) => {
    try {
      const s = String(json || "");
      if (s.length > 2 * 1024 * 1024) return { ok: false, error: "too big" };
      const tmp = outboxPath() + ".tmp";
      fs.writeFileSync(tmp, s.replace(/^﻿/, ""), { encoding: "utf-8", mode: 0o600 });
      try { fs.renameSync(tmp, outboxPath()); } catch (e) {
        await new Promise((r) => setTimeout(r, 200));
        fs.renameSync(tmp, outboxPath());
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle("outbox-load", () => {
    try {
      const st = fs.statSync(outboxPath());
      if (st.size > 2 * 1024 * 1024) return { ok: true, json: "{}" };
      return { ok: true, json: fs.readFileSync(outboxPath(), "utf-8") };
    } catch (e) { return { ok: true, json: "{}" }; }
  });
  // Ack: is `text` in this agent's transcript AFTER sinceMs? Reads the tails (2 MB) of the newest 3 transcript files that
  // changed since then. -> { seen: "user" | "queued" | "other" | "none" } or { seen: null } when it cannot tell.
  // v1.101.0 (S4): async I/O (never blocks the main process) and one memo per transcript file keyed by (size, mtime), so
  // several messages to the same agent, or a check repeated while nothing changed, re-use the parsed tail. Small cap: each
  // entry holds up to a 2 MB tail.
  const OUTBOX_TAIL = 2 * 1024 * 1024;
  const outboxTailMemo = new Map(); // full path -> { size, mtimeMs, lines, truncated }
  // re-review nit: the memo is dropped once it has not been used for 5 min (up to ~25 MB of line strings otherwise stays)
  const OUTBOX_MEMO_IDLE_MS = 5 * 60 * 1000;
  let outboxMemoUsedAt = 0;
  function outboxMemoSweep() { if (outboxTailMemo.size && Date.now() - outboxMemoUsedAt > OUTBOX_MEMO_IDLE_MS) outboxTailMemo.clear(); }
  { const t = setInterval(outboxMemoSweep, 60 * 1000); if (t && typeof t.unref === "function") t.unref(); }
  async function outboxTail(full, size, mtimeMs, windowBytes) {
    outboxMemoSweep();
    outboxMemoUsedAt = Date.now();
    const want = Math.min(size, windowBytes || OUTBOX_TAIL);
    const m = outboxTailMemo.get(full);
    if (m && m.size === size && m.mtimeMs === mtimeMs && m.window >= want) { outboxTailMemo.delete(full); outboxTailMemo.set(full, m); return m; }
    const len = want;
    const buf = Buffer.alloc(len);
    const fh = await fs.promises.open(full, "r");
    try { await fh.read(buf, 0, len, size - len); } finally { await fh.close(); }
    const lines = buf.toString("utf-8").split("\n");
    if (len < size) lines.shift(); // first line is cut
    const v = { size, mtimeMs, lines, truncated: len < size, window: len };
    outboxTailMemo.delete(full);
    if (len <= 4 * OUTBOX_TAIL) outboxTailMemo.set(full, v); // v1.114.1: a 32 MB read is never kept (memory); 2 and 8 MB reads are
    while (outboxTailMemo.size > 6) outboxTailMemo.delete(outboxTailMemo.keys().next().value);
    return v;
  }
  // v1.114.1: widen the window (2 -> 8 -> 32 MB, then give up) until the read reaches back to when the message was sent
  const OUTBOX_TAIL_STEPS = [OUTBOX_TAIL, 4 * OUTBOX_TAIL, 16 * OUTBOX_TAIL];
  const outboxNoReach = new Map(); // `${file}|${size}|${mtime}|${since}` -> true: even the biggest window did not reach back; do not read it again until the file changes
  async function outboxTailReaching(full, size, mtimeMs, sinceMs) {
    const key = full + "|" + size + "|" + mtimeMs + "|" + sinceMs;
    const steps = outboxNoReach.has(key) ? OUTBOX_TAIL_STEPS.slice(0, -1) : OUTBOX_TAIL_STEPS;
    let t = null;
    for (const w of steps) {
      t = await outboxTail(full, size, mtimeMs, w);
      if (require("./outbox").tailReachesBack(t.lines, t.truncated, sinceMs)) return t;
    }
    if (steps.length === OUTBOX_TAIL_STEPS.length) { outboxNoReach.set(key, true); while (outboxNoReach.size > 24) outboxNoReach.delete(outboxNoReach.keys().next().value); }
    return t;
  }
  ipcMain.handle("outbox-seen", async (event, { agentPath, text, sinceMs, lastSentMs }) => {
    try {
      if (!agentPath || !text || typeof sinceMs !== "number") return { seen: null };
      const dir = path.join(require("os").homedir(), ".claude", "projects", archive.encodeProjectPath(sessionCwdFor(agentPath)));
      const files = [];
      for (const f of await fs.promises.readdir(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const full = path.join(dir, f);
        const st = await fs.promises.stat(full);
        if (st.mtimeMs >= sinceMs - 60 * 1000) files.push({ full, mtimeMs: st.mtimeMs, size: st.size });
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const read = [];
      for (let i = 0; i < Math.min(3, files.length); i++) {
        const t = await outboxTailReaching(files[i].full, files[i].size, files[i].mtimeMs, sinceMs);
        read.push({ lines: t.lines, current: i === 0, truncated: t.truncated });
      }
      if (files.length > 3) read.push({ lines: [], current: false, truncated: true }); // more files than read: "none" is not provable

      return { seen: require("./outbox").scanTranscripts(read, String(text), sinceMs, lastSentMs || sinceMs) };
    } catch (e) {
      return { seen: null };
    }
  });

  ipcMain.handle("guard-handoff-info", (event, { agentPath }) => {
    try {
      const p = path.join(agentPath, "handoff_latest.md");
      const st = fs.statSync(p);
      // v1.67.1: `ready` = every required section heading is present, so the reset need not wait for the agent's reply.
      let ready = false;
      try { ready = require("./handoffLogic").fileReady(fs.readFileSync(p, "utf-8").slice(0, 200000)); } catch (e) {}
      return { exists: true, path: p, mtimeMs: st.mtimeMs, sizeBytes: st.size, ready };
    } catch (e) {
      return { exists: false };
    }
  });

  ipcMain.handle("guard-archive-handoff", (event, { agentPath }) => {
    try {
      const src = path.join(agentPath, "handoff_latest.md");
      const text = fs.readFileSync(src, "utf-8");
      const dir = path.join(agentPath, "handoff_history");
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const dest = path.join(dir, `handoff_${stamp}.md`);
      fs.writeFileSync(dest, text, "utf-8");
      return { ok: true, path: dest, lessons: archive.extractLessons(text) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Did `needle` reach this agent's NEWEST transcript (tail only)? Used to verify that a message
  // typed into the pty was really received by the CLI - 2026-09-19: after /clear on a large
  // session the CLI silently ignored everything typed, and the app had no way to notice.
  ipcMain.handle("guard-transcript-has", (event, { agentPath, needle }) => {
    try {
      if (!agentPath || !needle) return false;
      const dir = path.join(require("os").homedir(), ".claude", "projects", archive.encodeProjectPath(sessionCwdFor(agentPath)));
      let newest = null;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { full, mtimeMs: st.mtimeMs, size: st.size };
      }
      if (!newest) return false;
      // tail first (cheap); if the marker is not there, look in the last 1 MB (a busy agent can write
      // more than 256 KB of tool output between the prompt landing and our check)
      const fd = fs.openSync(newest.full, "r");
      try {
        for (const cap of [256 * 1024, 1024 * 1024]) {
          const len = Math.min(newest.size, cap);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, newest.size - len);
          if (buf.toString("utf-8").includes(needle)) return true;
          if (len >= newest.size) break;
        }
        return false;
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      return false;
    }
  });

  // 2026-09-20 incident: the shared ~/.claude/.credentials.json OAuth login
  // silently expired overnight (the CLI's own background daemon logged
  // "proactive refresh failed, signalling re-auth required" then just quietly
  // polled the keychain instead of surfacing anything). Every agent then
  // failed EVERY turn instantly with authentication_failed, which the old
  // code lumped in with "usage limit reached" - actively misleading, since
  // the real fix (re-login) is nothing like waiting out a rate limit.
  // Checked here (not just per-agent halt detection) so the banner shows on
  // ANY agent tab even one that hasn't tried and failed yet itself.
  function isAuthBroken() {
    try {
      const raw = fs.readFileSync(path.join(require("os").homedir(), ".claude", ".credentials.json"), "utf-8");
      const oauth = JSON.parse(raw).claudeAiOauth;
      return !oauth || !oauth.accessToken || !oauth.refreshToken;
    } catch (e) {
      return false; // file missing/unreadable isn't this signature - don't false-alarm
    }
  }

  ipcMain.handle("guard-limit-status", (event, { agentPath }) => {
    const out = { halt: null, fiveHour: null, sevenDay: null, authBroken: false };
    try {
      const c = archive.getConfirmedRateLimits();
      out.fiveHour = c.fiveHour;
      out.sevenDay = c.sevenDay;
    } catch (e) {}
    try {
      out.authBroken = isAuthBroken();
    } catch (e) {}
    try {
      if (agentPath) out.halt = archive.getHaltInfo(sessionCwdFor(agentPath));
    } catch (e) {}
    return out;
  });

  const notified = new Set(); // "<window>|<resetsAt>|<threshold>"
  function pollLimits() {
    let c;
    try {
      c = archive.getConfirmedRateLimits();
    } catch (e) {
      return;
    }
    for (const [key, label] of [["fiveHour", "5-hour"], ["sevenDay", "weekly"]]) {
      const w = c[key];
      if (!w || typeof w.usedPct !== "number") continue;
      // highest threshold crossed; only announce it once per window
      const crossed = THRESHOLDS.filter((t) => w.usedPct >= t).pop();
      if (!crossed) continue;
      const id = `${key}|${w.resetsAt}|${crossed}`;
      if (notified.has(id)) continue;
      THRESHOLDS.filter((t) => t <= crossed).forEach((t) => notified.add(`${key}|${w.resetsAt}|${t}`));
      const when = w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "unknown";
      try {
        if (Notification.isSupported()) {
          const n = new Notification({
            title: `Claude ${label} usage at ${Math.round(w.usedPct)}%`,
            body: `Resets ${when}. Agents will stop at 100% - consider pausing heavy work.`,
          });
          n.on("click", () => {
            const win = getMainWindow();
            if (win && !win.isDestroyed()) {
              if (win.isMinimized()) win.restore();
              win.show();
              win.focus();
            }
          });
          n.show();
        }
        say(`limit warning: ${label} ${Math.round(w.usedPct)}% (threshold ${crossed})`);
      } catch (e) {}
    }
  }
  const timer = setInterval(pollLimits, POLL_MS);
  if (timer.unref) timer.unref();
  setTimeout(pollLimits, 5000);
}

module.exports = { init };
