"use strict";
// v1.135.0 duplicate live copies: describe them, close the extras safely, and auto-close the OLD idle copy left behind by a planned handoff reset.
//
// Why: after "Save handoff & reset" the old session of an agent stays alive (idle) next to the new one. The sweep (main.js
// stopEmptyDuplicateAgents) only stops EMPTY copies, so two real conversations raised the "N live copies - needs a person" banner and the
// pane had no way to act on it. This module is the pure decision logic (fs only for reading transcript files; every side effect is injected):
//   * inspectTranscript(): what one copy's own transcript says (last message preview, unfinished turn, started by a handoff-resume prompt).
//   * describeCopies(): one row per live copy for the picker dialog.
//   * validateClose(): the safety rules for a manual "keep this one, close the others".
//   * planAutoClose(): the automatic rule. Closes only an IDLE, finished OLDER copy when the NEWEST copy was started by a planned handoff resume.
// The actual stop goes through Agent Desktop's own session-stop path (stopClaudeAgent in main.js), never a process kill.

const fs = require("fs");
const path = require("path");

const DEFAULT_IDLE_MINUTES = 10;
const BUSY_WINDOW_MS = 2 * 60 * 1000;   // a transcript written this recently with an unfinished turn = busy
const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 192 * 1024;
const RESUME_TAG = "[[HANDOFF-RESUME]]";

function readRange(file, start, len) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.slice(0, n).toString("utf-8");
  } finally { fs.closeSync(fd); }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.type === "text" ? b.text || "" : "")).join(" ");
  return "";
}
function oneLine(s, n) { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; }

// Pure: first real user prompt of a transcript (from its head lines) -> { handoffResume, handoffPath }.
function resumeInfoFromHead(headLines) {
  for (const line of headLines) {
    if (!line || !line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o || o.type !== "user" || o.isMeta || !o.message) continue;
    const t = textOf(o.message.content);
    if (!t.trim()) continue;
    const m = /^\s*\[\[HANDOFF-RESUME\]\]\s*(.*?\.md)?/m.exec(t);
    return { handoffResume: t.indexOf(RESUME_TAG) >= 0 && /^\s*\[\[HANDOFF-RESUME\]\]/.test(t), handoffPath: m && m[1] ? m[1].trim() : null };
  }
  return { handoffResume: false, handoffPath: null };
}

// Pure: from the tail lines, last timestamp / last readable message / whether the last turn is unfinished.
function tailSummary(tailLines) {
  let lastTs = 0, preview = "", last = null;
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    if (!line || !line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o || !o.timestamp) continue;
    const ts = new Date(o.timestamp).getTime();
    if ((o.type === "assistant" || o.type === "user") && o.message) {
      if (!last) {
        const c = o.message.content;
        let done = false;
        if (o.type === "assistant") done = o.message.stop_reason === "end_turn" || o.message.stop_reason === "stop_sequence";
        else done = /^\s*\[Request interrupted by user/.test(textOf(c));
        last = { ts, done };
      }
      if (!preview) {
        const t = textOf(o.message.content);
        if (t.trim() && !/^\s*\[Request interrupted/.test(t)) preview = (o.type === "assistant" ? "Agent: " : "You: ") + oneLine(t, 160);
      }
    }
    if (ts > lastTs) lastTs = ts;
    if (last && preview) break;
  }
  return { lastTs, preview, unfinished: !!last && !last.done };
}

// Reads one transcript file (head + tail only, bounded). Never throws; a missing/empty file gives hasTranscript:false.
function inspectTranscript(file) {
  const out = { hasTranscript: false, size: 0, mtimeMs: 0, lastTs: 0, preview: "", unfinished: false, handoffResume: false, handoffPath: null };
  let st; try { st = fs.statSync(file); } catch (e) { return out; }
  if (!st.size) return out;
  out.hasTranscript = true; out.size = st.size; out.mtimeMs = st.mtimeMs;
  try {
    const head = readRange(file, 0, Math.min(st.size, HEAD_BYTES));
    const r = resumeInfoFromHead(head.split("\n"));
    out.handoffResume = r.handoffResume; out.handoffPath = r.handoffPath;
  } catch (e) { /* unreadable head: not a resume */ }
  try {
    const start = Math.max(0, st.size - TAIL_BYTES);
    let tail = readRange(file, start, st.size - start);
    if (start > 0) tail = tail.slice(tail.indexOf("\n") + 1); // drop the partial first line
    const s = tailSummary(tail.split("\n"));
    out.lastTs = s.lastTs; out.preview = s.preview; out.unfinished = s.unfinished;
  } catch (e) { /* unreadable tail */ }
  return out;
}

const IDLE_STATUSES = new Set(["idle", "done", "stopped", "failed", "completed"]);

// live = rows of `claude agents --json` (id, sessionId, startedAt, status, state). transcriptFor(row) -> inspectTranscript() result.
// Returns rows oldest-first.
function describeCopies(live, transcriptFor, now) {
  const rows = (live || []).map((a) => {
    const tr = transcriptFor(a) || inspectTranscript("");
    const lastAct = Math.max(tr.lastTs || 0, tr.mtimeMs || 0);
    const idleMs = lastAct ? Math.max(0, now - lastAct) : (a.startedAt ? Math.max(0, now - a.startedAt) : 0);
    const statusIdle = IDLE_STATUSES.has(String(a.status || "").toLowerCase());
    const recentWrite = !!tr.mtimeMs && now - tr.mtimeMs < BUSY_WINDOW_MS;
    // busy: the CLI says it is not idle, or its last turn is unfinished and it wrote moments ago
    const busy = !statusIdle || (tr.unfinished && recentWrite);
    return {
      id: a.id, shortId: String(a.id || "").slice(0, 8), sessionId: a.sessionId || a.id, startedAt: a.startedAt || 0,
      status: a.status || "", state: a.state || "", busy, idleMs, hasTranscript: !!tr.hasTranscript,
      unfinished: !!tr.unfinished, preview: tr.preview || "", handoffResume: !!tr.handoffResume, handoffPath: tr.handoffPath || null, lastActivityAt: lastAct || null,
    };
  });
  rows.sort((a, b) => a.startedAt - b.startedAt);
  return rows;
}

// Manual close: keep `keepId`, close `closeIds` (default = every other copy). Returns { ok, error?, needsConfirm?, toClose }.
function validateClose(copies, keepId, closeIds, opts) {
  const o = opts || {};
  const byId = new Map((copies || []).map((c) => [c.id, c]));
  if (!byId.has(keepId)) return { ok: false, error: "The copy to keep is not running any more. Refresh the list.", toClose: [] };
  let toClose = Array.isArray(closeIds) && closeIds.length ? closeIds.slice() : copies.filter((c) => c.id !== keepId).map((c) => c.id);
  toClose = Array.from(new Set(toClose));
  if (toClose.includes(keepId)) return { ok: false, error: "The copy to keep cannot also be closed.", toClose: [] };
  for (const id of toClose) if (!byId.has(id)) return { ok: false, error: "Copy " + String(id).slice(0, 8) + " is not running any more. Refresh the list.", toClose: [] };
  if (!toClose.length) return { ok: false, error: "Nothing to close.", toClose: [] };
  if (byId.size - toClose.length < 1) return { ok: false, error: "Refused: this would close the last copy.", toClose: [] };
  const busy = toClose.filter((id) => byId.get(id).busy);
  if (busy.length && !o.confirmBusy) return { ok: false, needsConfirm: true, busy, error: "Copy " + busy.map((b) => String(b).slice(0, 8)).join(", ") + " is busy (working or holding an unfinished turn). Confirm to close it anyway.", toClose: [] };
  return { ok: true, toClose };
}

// Automatic rule. Closes copy X only when ALL hold: there are 2+ copies; the NEWEST copy was started by a planned handoff resume;
// X is older than the newest; X is idle (not busy, no unfinished turn) and has been idle for >= idleMinutes. The newest is never closed,
// so at least one copy always stays. Everything else (e.g. both busy, newest not a handoff resume) = keep the human banner.
function planAutoClose(copies, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const idleMs = (o.idleMinutes == null ? DEFAULT_IDLE_MINUTES : o.idleMinutes) * 60 * 1000;
  const none = (reason) => ({ close: [], keep: null, reason });
  const list = (copies || []).slice().sort((a, b) => a.startedAt - b.startedAt);
  if (list.length < 2) return none("fewer than two copies");
  const newest = list[list.length - 1];
  if (!newest.handoffResume) return none("newest copy was not started by a handoff resume");
  const close = [];
  for (const c of list.slice(0, -1)) {
    if (!(c.startedAt < newest.startedAt)) continue;
    if (c.busy || c.unfinished) continue;
    if (c.idleMs < idleMs) continue;
    close.push(c.id);
  }
  if (!close.length) return none("no older copy is idle and finished for long enough");
  return { close, keep: newest.id, reason: "old idle copy after planned handoff resume" };
}

// userData\duplicate-copies.json  { "autoClose": true, "idleMinutes": 10 }  (same pattern as hardstop.json). Missing/bad file = defaults.
function readConfig(file) {
  const cfg = { autoClose: true, idleMinutes: DEFAULT_IDLE_MINUTES };
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf-8").replace(/^﻿/, ""));
    if (j && j.autoClose === false) cfg.autoClose = false;
    const m = Number(j && j.idleMinutes);
    if (m >= 1 && m <= 1440) cfg.idleMinutes = m;
  } catch (e) { /* defaults */ }
  return cfg;
}

module.exports = { inspectTranscript, describeCopies, validateClose, planAutoClose, readConfig, resumeInfoFromHead, tailSummary, DEFAULT_IDLE_MINUTES, RESUME_TAG };
