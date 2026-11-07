// THYRA DOCK "QUESTIONS FOR YOU" (v1.154.0, Security, 2026-11-05). The asks that agents register with shared_tools\ask_iddo.py (one .json per question in
// shared_state\open_questions) shown under the permission prompts in the THYRA dock window, so the owner has ONE box for everything that waits on him.
// Pure logic only (list, filter, check); main.js wires the IPC, src/renderer/thyra-asks.js draws it.
//
// RULES (read before changing):
//  1. A click delivers through the SAME path as the inline cards in answer-once.js: the label is typed into the ASKING agent's chat as the owner's own
//     message, sealed (sealedAnswers, via "button", bound to the question that was SHOWN), then the file moves to answered\. Nothing is invented here.
//  2. Before anything is sent, main re-reads the ask FILE and refuses if it is missing (answered/withdrawn), differs from what was drawn (question, agent,
//     quick answers, context, merav, created) or the label is not one of ITS quick answers. The dock's own copy is never trusted.
//  3. Only the owner's real (isTrusted) click reaches this; nothing is answered on a timer, and an ask with no quick answers has no button at all.
"use strict";
const fs = require("fs"), path = require("path");

const RECENT_MS = 3 * 24 * 3600 * 1000, MAX_ROWS = 1000, ID_RX = /^[\w-]+$/;

// 2026-10-14T00:13:22+03:00 -> ms; falls back to the id (YYYYMMDD-HHMMSS-xxxx, local time) when "created" is missing or unreadable; 0 when neither works
function createdMs(ask) {
  const t = Date.parse(String(ask && ask.created || ""));
  if (isFinite(t)) return t;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(ask && ask.id || ""));
  if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); if (isFinite(d)) return d; }
  return 0;
}
function quickOf(ask) { return Array.isArray(ask && ask.quick) ? ask.quick : []; }   // as in the file: the seal compares it as written
// exactly the fields the seal binds (sealedAnswers shown-binding), normalised the way answer-once.js builds them
function shownOf(ask) { return { question: String(ask.question), agent: String(ask.agent), quick: quickOf(ask), context: String(ask.context || ""), merav: !!ask.merav, created: String(ask.created || "") }; }

// Reads every open ask in dir (same file rule as the "waiting for you" list). Newest first, capped.
function readAll(dir) {
  const out = []; let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const f of names) {
    if (!/^[\w.-]+\.json$/.test(f)) continue;
    try { const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8").replace(/^﻿/, "")); if (d && d.id && d.agent && d.question && ID_RX.test(String(d.id))) out.push(d); } catch (e) { /* half-written or bad file: skip */ }
  }
  out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return out.slice(0, MAX_ROWS);
}
// One ask by id from its own file, or null (answered, withdrawn, unreadable).
// Read through a file descriptor ON PURPOSE: main.js installs src/syncGuard.js, whose readFileSync(path) may return a copy up to 10 s old (or older, refreshed in the
// background) for files under the agents folder, and an agent that edits or the owner who answers an ask elsewhere is written by ANOTHER process. The check that decides
// whether a click may be delivered must see the file as it is now; a numeric fd is never cached.
function readOne(dir, id) {
  if (!ID_RX.test(String(id || ""))) return null;
  let fd = null;
  try {
    fd = fs.openSync(path.join(dir, id + ".json"), "r");
    const d = JSON.parse(fs.readFileSync(fd, "utf-8").replace(/^﻿/, ""));
    return d && d.id === id && d.agent && d.question ? d : null;
  } catch (e) { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* closed */ } } }
}

// The rows the dock draws, newest first. older = created more than 3 days ago (hidden until the owner asks for them).
// opts.activityMs(agent) -> ms of the owner's last message to that agent (0 = none). maybeAnswered = he wrote to the agent after the ask was filed and has not said
// "still waiting" since (ask.still_waiting): such a row leaves the main list and the count, and the sweep archives it 24 h later. stale14 = no deadline and 14+ days old.
function buildRows(asks, now, opts) {
  const o = opts || {};
  const rows = (asks || []).map((a) => {
    const t = createdMs(a), s = shownOf(a);
    const act = typeof o.activityMs === "function" ? (o.activityMs(s.agent) || 0) : 0, sw = Date.parse(String(a.still_waiting || "")) || 0;
    return { id: String(a.id), agent: s.agent, question: s.question, context: s.context, quick: s.quick, merav: s.merav, created: s.created, ageMs: t ? Math.max(0, now - t) : 0, older: !t || now - t > RECENT_MS, _t: t,
      kind: a.kind === "note" ? "note" : "ask", maybeAnswered: !!(t && act > t && act > sw), stale14: !!(t && !a.deadline && now - t > 14 * 86400000) };
  });
  rows.sort((a, b) => b._t - a._t || (a.id < b.id ? 1 : -1));
  return rows.map((r) => { delete r._t; return r; });
}
function recentCount(rows) { return rows.filter((r) => !r.older).length; }   // maybeAnswered is only a hint on the row (critic B2): it stays in the list and the count
// repaint key: asks, their wording and which are older (age does not count)
function listKey(rows) { return rows.map((r) => [r.id, r.older ? 1 : 0, r.quick.join("\u0001")].join("|")).join("\n"); }

// request = { id, label, shown } as the dock drew it; current = the ask file as read just now (or null).
function checkAnswer(request, current) {
  const r = request || {};
  if (typeof r.id !== "string" || !ID_RX.test(r.id)) return { ok: false, error: "bad question id" };
  if (typeof r.label !== "string" || !r.label) return { ok: false, error: "no answer chosen" };
  if (!current) return { ok: false, error: "that question is already answered or withdrawn" };
  if (!r.shown || typeof r.shown !== "object") return { ok: false, error: "no displayed question to check against" };
  const now = shownOf(current), sh = r.shown;
  const same = String(sh.question) === now.question && String(sh.agent) === now.agent && JSON.stringify(Array.isArray(sh.quick) ? sh.quick : null) === JSON.stringify(now.quick) &&
    String(sh.context || "") === now.context && !!sh.merav === now.merav && String(sh.created || "") === now.created;
  if (!same) return { ok: false, error: "the question changed since it was shown" };
  if (now.quick.indexOf(r.label) < 0) return { ok: false, error: "not one of the question's quick answers" };
  return { ok: true, shown: now };
}
// deps = { readOne(id)->ask|null, deliver({id,label,shown})->Promise<{ok,error?,retry?}> }. The one entry point main.js calls on a click.
async function answerFromDock(deps, request) {
  const r = request || {};
  const c = checkAnswer(r, typeof r.id === "string" ? deps.readOne(r.id) : null);
  if (!c.ok) return { ok: false, error: c.error };
  let d;
  try { d = await deps.deliver({ id: r.id, label: r.label, shown: c.shown }); } catch (e) { d = { ok: false, error: String(e && e.message || e).slice(0, 200) }; }
  return d && d.ok ? { ok: true } : { ok: false, error: String(d && d.error || "unknown error").slice(0, 200), retry: !!(d && d.retry) };
}

// "No longer needed": clears an ask WITHOUT sending anything and WITHOUT a seal (the file just moves to answered\, like `ask_iddo.py resolve`).
// Same re-read rules as an answer: the file must still exist and still be what the dock drew. deps = { readOne(id), resolve(id)->bool }.
function checkDismiss(request, current) {
  const r = request || {};
  if (typeof r.id !== "string" || !ID_RX.test(r.id)) return { ok: false, error: "bad question id" };
  if (!current) return { ok: false, error: "that question is already answered or withdrawn" };
  const c = checkAnswer({ id: r.id, label: quickOf(current)[0] || "-", shown: r.shown }, current);
  if (!c.ok && !/quick answers/.test(c.error)) return c;    // a no-quick ask has no label to match; every other refusal stands
  return { ok: true };
}
function dismissFromDock(deps, request) {
  const r = request || {};
  const c = checkDismiss(r, typeof r.id === "string" ? deps.readOne(r.id) : null);
  if (!c.ok) return { ok: false, error: c.error };
  let done = false; try { done = !!deps.resolve(r.id); } catch (e) { done = false; }
  return done ? { ok: true } : { ok: false, error: "could not move the question file" };
}

// FREE-TEXT REPLY (v1.155.0): the owner types his own words to the asking agent from the dock. Same re-read rules as an answer (file still there and still what
// was drawn); the text may be anything (1..1000 chars, one line, no control characters). keep=true sends WITHOUT closing the ask (no seal: a seal is final).
const MAX_REPLY = 600;   // = the seal limit (sealedAnswers MAX_ANSWER), so every reply can be sealed (critic S1)
function cleanReply(t) { return String(t == null ? "" : t).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REPLY); }
function checkReply(request, current) {
  const r = request || {};
  if (typeof r.id !== "string" || !ID_RX.test(r.id)) return { ok: false, error: "bad question id" };
  const text = cleanReply(r.text);
  if (!text) return { ok: false, error: "type something first" };
  if (/^[\/!#]/.test(text)) return { ok: false, error: "do not start with / ! or # (the agent would run it as a command): add a word first" };
  const c = checkAnswer({ id: r.id, label: quickOf(current || {})[0] || "-", shown: r.shown }, current);
  if (!c.ok && !/quick answers/.test(c.error)) return c;      // free text needs no quick answer; every other refusal stands
  return { ok: true, text, shown: shownOf(current) };
}
async function replyFromDock(deps, request) {
  const r = request || {};
  const c = checkReply(r, typeof r.id === "string" ? deps.readOne(r.id) : null);
  if (!c.ok) return { ok: false, error: c.error };
  let d;
  try { d = await deps.deliver({ id: r.id, text: c.text, keep: r.keep === true, shown: c.shown }); } catch (e) { d = { ok: false, error: String(e && e.message || e).slice(0, 200) }; }
  return d && d.ok ? { ok: true } : { ok: false, error: String(d && d.error || "unknown error").slice(0, 200), retry: !!(d && d.retry) };
}

// STILL WAITING / CLEARED AUTOMATICALLY (v1.155.0)
// keepWaiting: the owner says an ask flagged "maybe already answered" is still open: stamps ask.still_waiting (not part of the sealed binding) so it returns to the list.
// listCleared: asks the sweep archived in the last 7 days (answered\<id>.json with resolved_by "auto-sweep"), newest first, so he can see what vanished and Undo it.
// undoCleared: moves one back to the open folder, only if it really was auto-archived (never an owner answer, never a sealed one).
// read through an fd, never the syncGuard cache (see readOne)
function readJsonFd(p) { let fd = null; try { fd = fs.openSync(p, "r"); return JSON.parse(fs.readFileSync(fd, "utf-8").replace(/^﻿/, "")); } finally { if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* closed */ } } } }
const CLEARED_MS =7 * 24 * 3600 * 1000, MAX_CLEARED = 40;
function keepWaiting(dir, id, now) {
  if (!ID_RX.test(String(id || ""))) return { ok: false, error: "bad question id" };
  const file = path.join(dir, id + ".json"); let d;
  try { d = readJsonFd(file); } catch (e) { return { ok: false, error: "that question is already answered or withdrawn" }; }
  if (!d || d.id !== id) return { ok: false, error: "bad question file" };
  d.still_waiting = new Date(now || Date.now()).toISOString();
  try { const tmp = file + ".sw.tmp"; fs.writeFileSync(tmp, JSON.stringify(d, null, 1)); fs.renameSync(tmp, file); } catch (e) { return { ok: false, error: "could not save" }; }
  return { ok: true };
}
function listCleared(dir, now) {
  const base = path.join(dir, "answered"), out = []; let names = [];
  try { names = fs.readdirSync(base); } catch (e) { return out; }
  for (const f of names) {
    if (!/^[\w.-]+\.json$/.test(f)) continue;
    try {
      const p = path.join(base, f), st = fs.statSync(p); if (now - st.mtimeMs > CLEARED_MS) continue;
      const d = readJsonFd(p);
      if (d && d.id && ID_RX.test(String(d.id)) && d.resolved_by === "auto-sweep" && !d.seal) out.push({ id: String(d.id), agent: String(d.agent || ""), question: String(d.question || ""), reason: String(d.auto_reason || ""), at: String(d.auto_at || ""), _m: st.mtimeMs });
    } catch (e) { /* skip */ }
  }
  out.sort((a, b) => b._m - a._m); return out.slice(0, MAX_CLEARED).map((r) => { delete r._m; return r; });
}
function undoCleared(dir, id, now) {
  if (!ID_RX.test(String(id || ""))) return { ok: false, error: "bad question id" };
  const src = path.join(dir, "answered", id + ".json"), dst = path.join(dir, id + ".json"); let d;
  try { d = readJsonFd(src); } catch (e) { return { ok: false, error: "not in the cleared list" }; }
  if (!d || d.id !== id || d.resolved_by !== "auto-sweep" || d.seal || d.answer || d.answered || d.answered_by) return { ok: false, error: "only automatically cleared questions can be restored" };
  if (fs.existsSync(dst)) return { ok: false, error: "already open" };
  for (const k of ["resolved_by", "resolved_at", "auto_reason", "auto_at"]) delete d[k];
  d.restored_by_owner = true; d.still_waiting = new Date(now || Date.now()).toISOString();    // restored by hand: it must not be flagged "maybe answered" again
  try { const tmp = dst + ".undo.tmp"; fs.writeFileSync(tmp, JSON.stringify(d, null, 1)); fs.renameSync(tmp, dst); fs.unlinkSync(src); } catch (e) { return { ok: false, error: "could not restore" }; }
  return { ok: true };
}

module.exports = { keepWaiting, listCleared, undoCleared, CLEARED_MS, cleanReply, checkReply, replyFromDock, MAX_REPLY, checkDismiss, dismissFromDock, createdMs, readAll, readOne, buildRows, recentCount, listKey, checkAnswer, answerFromDock, shownOf, RECENT_MS, MAX_ROWS };
