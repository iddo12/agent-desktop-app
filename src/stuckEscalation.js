"use strict";
// v1.134.0 stuck-failing escalation (Security, 2026-10-21).
//
// Why: checkForStuckTurns()/recoverStuckSession() in main.js restarts an agent whose turn shows no transcript growth for ~3 min. That
// is right for a one-off wedge, but on 2026-10-20 it re-dispatched the SAME hung conversation of Software Engineering 74 times in 5 hours
// and nobody was told. This module is the pure decision logic (no electron, no fs apart from the open-questions writer) so it can be
// unit-tested:
//   * lastRealProgressFromLines(): the progress signal. Only real assistant output and tool results count. queue-operation lines
//     (messages the owner queued while the agent hangs), attachments, snapshots and human prompts do NOT, because they bump the file's mtime
//     without the agent having done anything.
//   * evaluate(): >= 3 recoveries inside the window and no real progress after any of them = "stuck-failing". Blind re-dispatch stops.
//   * tick(): for a stuck-failing agent, re-notify every 30 min, escalate ONCE per episode (fresh session in the agent's folder, no --resume)
//     at most once per 30 min per agent and never when the transcript showed real progress in the last 10 min, clear itself on real progress.
//   * setDuplicates(): the "N live copies WITH conversations" condition, surfaced the same way (one plain line).
// Everything with side effects is injected (notify, addQuestion, resolveQuestion, emit, progressMs, escalate, log, now).

const fs = require("fs");
const path = require("path");

const WINDOW_MS = 15 * 60 * 1000;           // recoveries counted inside this window
const MIN_RECOVERIES = 3;                   // this many recoveries without progress = failing
const RENOTIFY_MS = 30 * 60 * 1000;         // OS notification repeat while the state lasts
const ESCALATE_MIN_GAP_MS = 30 * 60 * 1000; // at most one fresh-session escalation per agent per 30 min
const NO_PROGRESS_BEFORE_ESCALATE_MS = 10 * 60 * 1000; // never close a session that progressed in the last 10 min
const FRESH_GRACE_MS = 10 * 60 * 1000;      // a fresh session gets this long to show real progress before it is called failed too

// Parse transcript lines (any order is fine; scanned from the end) and return the timestamp (ms) of the newest REAL progress entry, or 0.
// Real = an assistant message, or a user entry carrying a tool_result block. Everything else (queue-operation, attachment, system, summary,
// file-history-snapshot, a human prompt, an interrupt note) is ignored.
function lastRealProgressFromLines(lines) {
  let best = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o || !o.timestamp) continue;
    let real = false;
    if (o.type === "assistant") real = true;
    else if (o.type === "user" && o.message && Array.isArray(o.message.content)) real = o.message.content.some((b) => b && b.type === "tool_result");
    if (!real) continue;
    const ts = new Date(o.timestamp).getTime();
    if (ts > best) best = ts;
    // lines are chronological, so the first real entry from the end is the newest unless timestamps are out of order; keep scanning a few
    // more lines is not needed.
    break;
  }
  return best;
}

function humanDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60), rest = m % 60;
  return h < 3 && rest ? h + " h " + rest + " min" : h + " h";
}

function stuckLabel(sinceMs, now) { return "STUCK " + humanDuration(now - sinceMs) + " - auto-restart failed"; }

// One line, no double quotes (the dispatcher flattens both anyway).
function freshPrompt(agentName, handoffPath) {
  const head = "This is a fresh session started automatically by Agent Desktop because your previous session for " + agentName +
    " froze and automatic restarts did not help. Do NOT try to resume the old conversation. ";
  if (handoffPath) {
    return head + "Read " + handoffPath + " and continue from its EXACT NEXT STEP. Then tell the owner in one line that you were restarted and what you resumed.";
  }
  return head + "There is no handoff_latest.md in your agent folder, so say so plainly to the owner, read your CLAUDE.md and master_state.md (if present) and ask what to continue with.";
}

// The same small .json file the shared_tools ask_iddo.py writes (one per question), so the "waiting for you" bar lists it.
function openQuestionsStore(dir, nowFn) {
  const nowIso = () => new Date(nowFn ? nowFn() : Date.now()).toISOString();
  const readAll = () => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const out = [];
    for (const f of names) {
      if (!/^[\w.-]+\.json$/.test(f)) continue;
      try { const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8").replace(/^﻿/, "")); if (d && d.id) out.push(d); } catch (e) { /* half-written */ }
    }
    return out;
  };
  const same = (d, agent, question) => String(d.agent || "").toLowerCase() === String(agent).toLowerCase() && d.question === question;
  return {
    add(agent, question, context) {
      question = String(question).replace(/\s+/g, " ").trim().slice(0, 600);
      fs.mkdirSync(dir, { recursive: true });
      const have = readAll().find((d) => same(d, agent, question));
      if (have) return have.id;
      const id = nowIso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-") + "-" + Math.random().toString(16).slice(2, 6);
      const tmp = path.join(dir, id + ".tmp");
      fs.writeFileSync(tmp, JSON.stringify({ id, agent: String(agent), question, context: String(context || "").slice(0, 1500), quick: [], merav: false, created: nowIso() }, null, 1), "utf-8");
      fs.renameSync(tmp, path.join(dir, id + ".json"));
      return id;
    },
    // resolve by (agent, question) so it still works after an app restart lost the in-memory id
    resolve(agent, question) {
      question = String(question).replace(/\s+/g, " ").trim().slice(0, 600);
      let n = 0;
      for (const d of readAll()) {
        if (!same(d, agent, question)) continue;
        try { fs.mkdirSync(path.join(dir, "answered"), { recursive: true }); fs.renameSync(path.join(dir, d.id + ".json"), path.join(dir, "answered", d.id + ".json")); n++; } catch (e) { /* next time */ }
      }
      return n;
    },
  };
}

function create(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const call = (fn, ...a) => { try { return fn ? fn(...a) : undefined; } catch (e) { log("stuckEscalation: side effect failed: " + e.message); return undefined; } };
  const history = new Map();   // agentPath -> [{ at, progressAt }]
  const failing = new Map();   // agentPath -> state
  const lastEscalate = new Map(); // agentPath -> ms (survives clearing: the 30 min limit is per agent, not per episode)
  const dups = new Map();      // agentPath -> { name, ids, since, lastNotifyAt }

  const stuckQuestion = (name) => name + " is stuck - it froze and automatic restarts did not help. Open it and check, or start a new chat.";
  const dupQuestion = (name, n) => name + " has " + n + " live copies with conversations and none is safe to stop automatically. Pick the one to keep and stop the others.";

  function snapshot(agentPath) {
    const st = failing.get(agentPath), d = dups.get(agentPath);
    const t = now();
    return {
      agentPath,
      stuck: st ? { since: st.since, label: stuckLabel(st.since, t), detail: st.detail(), escalatedAt: st.escalatedAt || null, freshFailed: !!st.freshFailed } : null,
      dup: d ? { count: d.ids.length, label: d.name + " has " + d.ids.length + " live copies - needs a person", ids: d.ids } : null,
    };
  }
  const emit = (agentPath) => call(deps.emit, agentPath, snapshot(agentPath));

  function notifyStuck(agentPath, st, why) {
    st.lastNotifyAt = now();
    call(deps.notify, st.name + ": " + stuckLabel(st.since, now()), why);
  }

  // Called by the watchdog when it WOULD recover an agent (before it does). Returns true when the agent is (or just became) stuck-failing,
  // in which case the caller must not re-dispatch. `windowMs` may be widened for huge sessions whose threshold is long.
  function evaluate(agentPath, opts) {
    opts = opts || {};
    if (failing.has(agentPath)) return true;
    const t = now(), windowMs = Math.max(WINDOW_MS, opts.windowMs || 0);
    const prog = deps.progressMs ? deps.progressMs(agentPath) : null;
    if (prog == null) return false; // cannot read the transcript: never declare a failure on a guess
    let h = (history.get(agentPath) || []).filter((e) => t - e.at <= windowMs);
    // real progress since the first recovery in the window: that recovery worked, forget the older ones
    if (h.length && prog > h[0].progressAt) h = [];
    history.set(agentPath, h);
    if (h.length < MIN_RECOVERIES) return false;
    const name = opts.name || path.basename(agentPath);
    const st = {
      name, enteredAt: t, baseProgress: prog, since: prog > 0 && prog <= t ? prog : h[0].at, lastNotifyAt: 0, escalated: false,
      detail() { return this.escalated ? "A fresh session was started at " + new Date(this.escalatedAt).toISOString() + (this.freshFailed ? " and it has not produced output either." : ".") : "No fresh session started yet."; },
    };
    failing.set(agentPath, st);
    log(`STUCK-FAILING ${agentPath}: ${h.length} auto-recoveries in ${Math.round(windowMs / 60000)} min, no real transcript progress since ${prog ? new Date(prog).toISOString() : "never"} - blind re-dispatch stopped`);
    notifyStuck(agentPath, st, "Frozen with no output; the automatic restarts did not help. Open it in Agent Desktop.");
    call(deps.addQuestion, name, stuckQuestion(name), "Last real output: " + (prog ? new Date(prog).toISOString() : "none") + ". Agent Desktop restarted its session " + h.length + " times in " + Math.round(windowMs / 60000) + " min with no result, so it stopped restarting the same conversation.");
    emit(agentPath);
    return true;
  }

  function recordRecovery(agentPath) {
    const prog = deps.progressMs ? deps.progressMs(agentPath) : null;
    const h = history.get(agentPath) || [];
    h.push({ at: now(), progressAt: prog == null ? 0 : prog });
    history.set(agentPath, h.slice(-20));
  }

  function clear(agentPath, why) {
    const st = failing.get(agentPath);
    if (!st) return;
    failing.delete(agentPath);
    history.delete(agentPath);
    log(`STUCK-FAILING cleared for ${agentPath}: ${why}`);
    call(deps.resolveQuestion, st.name, stuckQuestion(st.name));
    emit(agentPath);
  }

  async function tick() {
    for (const [agentPath, st] of Array.from(failing)) {
      const t = now();
      const prog = deps.progressMs ? deps.progressMs(agentPath) : null;
      if (prog != null && prog > st.baseProgress) { clear(agentPath, "real transcript progress at " + new Date(prog).toISOString()); continue; }
      if (st.escalated && !st.freshFailed && t - st.escalatedAt >= FRESH_GRACE_MS) {
        st.freshFailed = true;
        log(`STUCK-FAILING ${agentPath}: the fresh session showed no real progress within ${FRESH_GRACE_MS / 60000} min - not escalating again, alert stays up`);
        notifyStuck(agentPath, st, "The fresh session did not start working either. It needs a person.");
      } else if (t - st.lastNotifyAt >= RENOTIFY_MS) {
        notifyStuck(agentPath, st, "Still frozen. Open it in Agent Desktop.");
      }
      if (!st.escalated && prog != null && t - prog >= NO_PROGRESS_BEFORE_ESCALATE_MS && t - (lastEscalate.get(agentPath) || -Infinity) >= ESCALATE_MIN_GAP_MS) {
        st.escalated = true; st.escalatedAt = t; lastEscalate.set(agentPath, t);
        const handoff = deps.handoffPath ? deps.handoffPath(agentPath) : null;
        log(`STUCK-FAILING ${agentPath}: escalating - closing the doomed session and starting a FRESH one (no --resume), handoff ${handoff || "none found"}`);
        try {
          const r = await deps.escalate(agentPath, freshPrompt(st.name, handoff));
          log(`STUCK-FAILING ${agentPath}: fresh session started ${r && r.agentId ? "(id " + r.agentId + ")" : ""}`);
        } catch (e) {
          st.freshFailed = true;
          log(`STUCK-FAILING ${agentPath}: starting the fresh session FAILED: ${e.message} - not retrying, alert stays up`);
          notifyStuck(agentPath, st, "Could not start a fresh session: " + e.message);
        }
      }
      emit(agentPath);
    }
    for (const [agentPath, d] of dups) {
      if (now() - d.lastNotifyAt >= RENOTIFY_MS) { d.lastNotifyAt = now(); call(deps.notify, d.name + ": duplicate sessions", dupQuestion(d.name, d.ids.length)); }
      emit(agentPath);
    }
  }

  // ids = the live copies WITH conversations (empty when fine). Called by the duplicate sweep for every agent it checks.
  function setDuplicates(agentPath, name, ids) {
    const d = dups.get(agentPath);
    if (!ids || ids.length < 2) {
      if (d) { dups.delete(agentPath); log(`duplicate copies cleared for ${agentPath}`); call(deps.resolveQuestion, d.name, dupQuestion(d.name, d.ids.length)); emit(agentPath); }
      return;
    }
    if (d) { d.ids = ids.slice(); return; }
    const nd = { name, ids: ids.slice(), since: now(), lastNotifyAt: now() };
    dups.set(agentPath, nd);
    call(deps.notify, name + ": duplicate sessions", dupQuestion(name, ids.length));
    call(deps.addQuestion, name, dupQuestion(name, ids.length), "Live sessions with conversations: " + ids.join(", ") + ". Agent Desktop never stops a copy that holds a conversation.");
    emit(agentPath);
  }

  return {
    evaluate, recordRecovery, tick, setDuplicates, clear,
    isFailing: (p) => failing.has(p),
    getAll: () => Array.from(new Set([...failing.keys(), ...dups.keys()])).map(snapshot),
    _state: { history, failing, lastEscalate, dups },
  };
}

module.exports = { create, lastRealProgressFromLines, humanDuration, stuckLabel, freshPrompt, openQuestionsStore, WINDOW_MS, MIN_RECOVERIES, RENOTIFY_MS, ESCALATE_MIN_GAP_MS, NO_PROGRESS_BEFORE_ESCALATE_MS };
