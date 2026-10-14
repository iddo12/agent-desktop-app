// My Daily - Decisions tab, pure model (v1.78.0). No fs, no electron: stores in, plain objects out.
// Source: every open task flagged "needs the owner" (task field: see contract.js) in the fleet's task store (shared_reports/tasks/<agent>.json, schema agent-tasks/1).
// Item id = "<agent folder>::<task id>" (task ids are only unique per agent).
"use strict";

const C = require("./contract");
const MAX_ANSWER = 4000;
const MAX_TITLE = 300;
const MAX_DETAIL = 4000;

function clean(s, n) { return String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, n); }
const itemId = (agent, taskId) => String(agent) + "::" + String(taskId);
function splitId(id) { const s = String(id || ""); const i = s.indexOf("::"); return i < 0 ? null : { agent: s.slice(0, i), taskId: s.slice(i + 2) }; }

// --- kind inference (conservative: the user can always switch the item) ---
const STRONG = [
  /\bgo\s*[\/\\|-]?\s*no[\s-]?go\b/i, /\bno[\s-]go\b/i, /\bgo[\s-]ahead\b/i, /\bgreen[\s-]?light\b/i,
  /\bok(?:ay)?\s+to\s+(?:deploy|push|send|publish|ship|restart|merge|proceed|go|run|start|release|install|build)\b/i,
  /\b(?:approve|approval)\b/i, /\bsign[\s-]?off\b/i, /\b(?:merge|purchase|deploy(?:ment)?|release)\s+decision\b/i, /\bdecision:\s*(?:merge|deploy|release|purchase|buy|approve)\b/i,
];
const DETAIL_STRONG = [STRONG[0], STRONG[1], STRONG[2], STRONG[3], STRONG[4]];
// v1.78.2: revision stamp of what the card shows (title + detail as cleaned for display). The renderer sends it back with the answer.
function revOf(title, detail) {
  const str = String(title) + "\u0000" + String(detail);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + "-" + str.length.toString(36);
}
function inferKind(task) {
  const tags = Array.isArray(task && task.tags) ? task.tags.map((t) => String(t).toLowerCase()) : [];
  if (tags.includes("decision:gonogo")) return "gonogo";
  if (tags.includes("decision:text")) return "text";
  const title = String((task && task.title) || "");
  const det = String((task && task.detail) || "").slice(0, 600);
  // v1.78.2: a question mark or an "A or B" / "option X" choice is never a plain Go/No-go (only the explicit tag overrides this)
  if (title.includes("?") || CHOICE.test(title) || CHOICE.test(det)) return "text";
  if (STRONG.some((r) => r.test(title))) return "gonogo";
  if (DETAIL_STRONG.some((r) => r.test(det))) return "gonogo";
  return "text";
}

// --- grouping (v1.78.1): "questions" = a real decision/question for the owner; "other" = the remaining needs-owner to-dos (signups, installs, reviews)
const QUESTION_WORDS = /\b(?:approve|approval|go[\s-]?ahead|go\s*[\/\|-]?\s*no[\s-]?go|decide|decisions?|open questions|which option|pick|choose)\b|\bok(?:ay)?\s+to\b/i;
const DETAIL_Q = /\b(?:go[\s-]?ahead|go\s*[\/\\|-]?\s*no[\s-]?go|decide|decision|which option)\b|\bok(?:ay)?\s+to\b|\?(?:\s|$)/i;
const CHOICE = /\boptions?\s+[A-D]\b|\b[A-D]\s+(?:or|\/)\s+[A-D]\b/;
function inferGroup(task) {
  const tags = Array.isArray(task && task.tags) ? task.tags.map((t) => String(t).toLowerCase()) : [];
  if (tags.some((t) => t === "decision" || t.startsWith("decision:"))) return "questions";
  const title = String((task && task.title) || "").trim();
  const det = String((task && task.detail) || "");
  if (title.includes("?")) return "questions";   // ends in a question mark, or asks one mid-title
  if (QUESTION_WORDS.test(title) || DETAIL_Q.test(det.slice(0, 1500))) return "questions";
  if (CHOICE.test(title) || CHOICE.test(det)) return "questions";
  return "other";
}

const normTitle = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const prio = (t) => (Number.isInteger(t.priority) && t.priority >= 1 && t.priority <= 3 ? t.priority : 2);
const ts = (v) => { const n = Date.parse(v || ""); return Number.isFinite(n) ? n : 0; };

// Open items from raw store objects. `answers` = decisions.json answers map (id -> record), `overrides` = id -> "gonogo"|"text".
function openItems(stores, answers, overrides) {
  const ans = answers && typeof answers === "object" ? answers : {};
  const ov = overrides && typeof overrides === "object" ? overrides : {};
  const out = [];
  for (const s of stores || []) {
    if (!s || !Array.isArray(s.items) || !s.agent) continue;
    for (const it of s.items) {
      if (!it || !C.needs(it) || it.status === "done" || it.id == null) continue;
      const id = itemId(s.agent, it.id);
      const a = ans[id];
      if (a && String(a.taskUpdated || "") === String(it.updated || "")) continue;   // answered; the task has not changed since
      const group = inferGroup(it);
      // Go/No-go is offered for "other" items only when the user switched them
      const kind = ov[id] === "gonogo" || ov[id] === "text" ? ov[id] : group === "questions" ? inferKind(it) : "text";
      out.push({
        id, agent: String(s.agent), taskId: String(it.id), title: clean(it.title, MAX_TITLE), detail: clean(it.detail, MAX_DETAIL),
        rev: revOf(clean(it.title, MAX_TITLE), clean(it.detail, MAX_DETAIL)),
        priority: prio(it), created: ts(it.created), updated: ts(it.updated), updatedRaw: String(it.updated || ""),
        tags: (Array.isArray(it.tags) ? it.tags : []).map(String).slice(0, 10), status: String(it.status || "open"),
        group, kind, kindInferred: group === "questions" ? inferKind(it) : "text", kindOverridden: !!ov[id],
      });
    }
  }
  // de-duplicate: same agent + same title -> keep the highest priority, then the newest
  const best = new Map();
  for (const x of out) {
    const k = x.agent + "|" + normTitle(x.title);
    const cur = best.get(k);
    if (!cur || x.priority < cur.priority || (x.priority === cur.priority && Math.max(x.updated, x.created) > Math.max(cur.updated, cur.created))) best.set(k, x);
  }
  const list = [...best.values()];
  list.sort((a, b) => (a.group === b.group ? 0 : a.group === "questions" ? -1 : 1) || sortOpen(a, b));
  return list;
}
// high priority first (1 = high), then newest, then stable by id
function sortOpen(a, b) {
  return a.priority - b.priority || Math.max(b.updated, b.created) - Math.max(a.updated, a.created) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Archive = answered records, newest answer first.
function archiveItems(answers) {
  const out = [];
  for (const [id, a] of Object.entries(answers && typeof answers === "object" ? answers : {})) {
    if (!a || typeof a !== "object") continue;
    out.push({
      id, agent: String(a.agent || ""), title: clean(a.title, MAX_TITLE), kind: a.kind === "gonogo" ? "gonogo" : "text",
      answer: a.answer === "go" || a.answer === "nogo" ? a.answer : "text", text: clean(a.text, MAX_ANSWER),
      answeredAt: Number(a.answeredAt) || 0, delivery: a.delivery === "queued" ? "queued" : "sent",
      taskNote: a.taskNote === "failed" ? "failed" : "ok",
    });
  }
  out.sort((x, y) => y.answeredAt - x.answeredAt);
  return out;
}

// --- messages sent to the agent ---
function validateAnswer(kind, answer, text) {
  if (kind === "gonogo") { if (answer !== "go" && answer !== "nogo") return { ok: false, reason: "Choose Go or No-go." }; return { ok: true }; }
  if (answer !== "text") return { ok: false, reason: "Unknown answer." };
  const t = String(text == null ? "" : text);
  if (!t.trim()) return { ok: false, reason: "Write your answer first." };
  if (t.length > MAX_ANSWER) return { ok: false, reason: `That is ${t.length} characters; the limit is ${MAX_ANSWER}. Shorten it (nothing was sent).` };
  return { ok: true };
}
// `who` = the person's display names (dailyConfig.who(): name, poss); only wording comes from it, never an id or a path.
function messageFor(item, answer, text, who) {
  const w = who || { name: "The user", poss: "The user's" };
  const title = clean(item.title, MAX_TITLE).replace(/\n+/g, " ");
  const head = answer === "go" ? `${w.name} answered GO to: ${title}` : answer === "nogo" ? `${w.name} answered NO-GO to: ${title}` : `${w.poss} answer to: ${title}\n\n${String(text).replace(/\r\n?/g, "\n").trim()}`;
  return head + `\n\n(Sent from Agent Desktop > My Daily > Decisions. Task id: ${item.taskId}. Act on it, then update or close the task.)`;
}
const noteFor = (answer) => (answer === "go" ? "GO" : answer === "nogo" ? "NO-GO" : "text answer, see the agent's chat");
const taskNoteText = (answer, text, delivery, who) => ((who && who.name) || "The user") + " answered via My Daily" + (delivery === "queued" ? " (queued, not yet confirmed)" : "") + ": " + (answer === "text" ? "text - " + String(text).replace(/\s+/g, " ").trim().slice(0, 600) : noteFor(answer));

// v1.78.2: append the note to the old task detail inside `max` characters. The note is never cut (<= ~900 chars); when the old detail
// is too long its HEAD is cut and the newest part (the tail) is kept, with a visible marker. Returns { detail, oldLen, keptOld, cut }.
const DETAIL_MAX = 6000;
function buildTaskDetail(oldDetail, note, max) {
  const lim = max || DETAIL_MAX;
  const nt = String(note).slice(0, 900);
  const old = String(oldDetail == null ? "" : oldDetail);
  const sep = "\n\n";
  if (old.length + sep.length + nt.length <= lim) return { detail: (old ? old + sep : "") + nt, oldLen: old.length, keptOld: old.length, cut: false };
  const mark = (n) => `[... ${n} earlier characters cut by My Daily ...]\n`;
  let keep = Math.max(0, lim - nt.length - sep.length - mark(old.length).length);
  keep = Math.min(keep, old.length);
  const cutN = old.length - keep;
  return { detail: mark(cutN) + old.slice(old.length - keep) + sep + nt, oldLen: old.length, keptOld: keep, cut: true };
}

module.exports = { DETAIL_MAX, buildTaskDetail, revOf, MAX_ANSWER, inferGroup, itemId, splitId, inferKind, openItems, archiveItems, sortOpen, validateAnswer, messageFor, noteFor, taskNoteText, normTitle };
