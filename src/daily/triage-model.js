// My Daily - Tasks tab triage, pure model (v1.79.0). No fs, no electron: task stores in, plain objects out.
// Groups: "needs" = open tasks flagged "needs the owner" (the only default view), "backlog" = agents' own open work, "ideas" = tag idea.
// Item id = "<agent folder>::<task id>" (same as Decisions; task ids are only unique per agent).
"use strict";
const D = require("./decisions-model");
const C = require("./contract");

const DAY = 86400000;
const MAX_TITLE = 300;
const MAX_DETAIL = 4000;
const BLOCK_MAX = 1500;
const PREVIEW = 600;
const OLD_DAYS = 7;

function clean(s, n) { return String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, n); }
const ts = (v) => { const n = Date.parse(v || ""); return Number.isFinite(n) ? n : 0; };
const prio = (t) => (Number.isInteger(t.priority) && t.priority >= 1 && t.priority <= 3 ? t.priority : 2);

// --- ASK / RECOMMEND / WHY IT MATTERS convention -------------------------------------------------
// The detail STARTS with labelled lines. A block runs from its label to the next label or the first blank line; whatever follows
// is "rest" (more detail, appended notes). Without a leading ASK: the detail is shown as plain text (first 600 characters).
const LABEL = /^\s*(ASK|RECOMMEND|WHY IT MATTERS)\s*:\s*(.*)$/i;
function parseDetail(detail) {
  const text = clean(detail, MAX_DETAIL);
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const first = i < lines.length ? LABEL.exec(lines[i]) : null;
  const out = { structured: false, ask: "", recommend: "", why: "", rest: "", preview: text.slice(0, PREVIEW), truncated: text.length > PREVIEW };
  if (!first || first[1].toUpperCase() !== "ASK") return out;
  const key = { ASK: "ask", RECOMMEND: "recommend", "WHY IT MATTERS": "why" };
  let cur = null;
  for (; i < lines.length; i++) {
    const m = LABEL.exec(lines[i]);
    if (m) { cur = key[m[1].toUpperCase()]; out[cur] = (out[cur] ? out[cur] + "\n" : "") + m[2].trim(); continue; }
    if (!lines[i].trim()) {
      // a blank line ends the current block; the next label (if any) starts a new one, anything else is "rest"
      let j = i; while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && LABEL.test(lines[j])) { i = j - 1; cur = null; continue; }
      i = j; break;
    }
    if (cur) out[cur] += "\n" + lines[i].trim(); else break;
  }
  out.rest = lines.slice(i).join("\n").trim().slice(0, 800);
  for (const k of ["ask", "recommend", "why"]) out[k] = out[k].trim().slice(0, BLOCK_MAX);
  out.structured = !!out.ask;
  out.preview = "";
  return out;
}

// --- yes/no detection ------------------------------------------------------------------------------
const NOT_YESNO = /^(?:who|what|which|when|where|how|why|whose)\b/i;
const YESNO_START = /^(?:should|shall|can|could|may|do|does|did|is|are|will|would|ok|okay|approve|allow|go ahead|proceed|merge|deploy|ship|publish|send|restart|install|start|run|buy|purchase)\b/i;
function isYesNoAsk(ask) {
  const a = String(ask || "").trim();
  if (!a) return false;
  if (/\byes\s*\/\s*no\b|\bgo\s*\/\s*no[\s-]?go\b/i.test(a)) return true;
  if (!/\?\s*$/.test(a) || NOT_YESNO.test(a)) return false;
  if (/\b[A-D]\s+(?:or|\/)\s+[A-D]\b|\boptions?\s+[A-D]\b/.test(a)) return false;   // a choice
  const sentence = a.split(/(?<=[.!?])\s+/).pop();
  if (/\bor\b/i.test(sentence) && !/\bor not\b/i.test(sentence)) return false;
  return YESNO_START.test(a) || /\bok to\b/i.test(a);
}
function isGoNoGo(task, parsed) {
  const tags = Array.isArray(task && task.tags) ? task.tags.map((t) => String(t).toLowerCase()) : [];
  if (tags.includes("decision:gonogo")) return true;
  if (tags.includes("decision:text")) return false;
  const p = parsed || parseDetail(task && task.detail);
  return !!(p.structured && isYesNoAsk(p.ask));
}

// --- ordering ---------------------------------------------------------------------------------------
// needs the owner: go/no-go first, then priority (1 = high), then age (oldest created first), then id (stable).
function sortNeeds(a, b) {
  return (b.gonogo ? 1 : 0) - (a.gonogo ? 1 : 0) || a.priority - b.priority || (a.created || Infinity) - (b.created || Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function sortBacklog(a, b) {
  return a.priority - b.priority || Math.max(b.updated, b.created) - Math.max(a.updated, a.created) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const dayDiff = (now, t) => (t ? Math.max(0, Math.floor((now - t) / DAY)) : null);

// stores = raw task stores; state = { snoozes: {id: untilMs}, queued: {id: {at, taskUpdated}}, asked: {id: at} }
function buildView(stores, state, now) {
  const st = state && typeof state === "object" ? state : {};
  const snoozes = st.snoozes && typeof st.snoozes === "object" ? st.snoozes : {};
  const queued = st.queued && typeof st.queued === "object" ? st.queued : {};
  const asked = st.asked && typeof st.asked === "object" ? st.asked : {};
  const needs = [], backlog = [], ideas = [], snoozed = [];
  let openTotal = 0;
  for (const s of stores || []) {
    if (!s || !Array.isArray(s.items) || !s.agent) continue;
    for (const it of s.items) {
      if (!it || it.id == null || it.status === "done") continue;
      openTotal++;
      const id = D.itemId(s.agent, it.id);
      const title = clean(it.title, MAX_TITLE);
      const detail = clean(it.detail, MAX_DETAIL);
      const p = parseDetail(detail);
      const tags = (Array.isArray(it.tags) ? it.tags : []).map(String).slice(0, 10);
      const created = ts(it.created), updated = ts(it.updated);
      const last = Math.max(created, updated);
      const q = queued[id];
      const x = {
        id, agent: String(s.agent), taskId: String(it.id), title, rev: D.revOf(title, detail),
        priority: prio(it), created, updated, updatedRaw: String(it.updated || ""), tags,
        ageDays: dayDiff(now, created), updDays: dayDiff(now, updated), staleDays: dayDiff(now, last), old: last > 0 && now - last > OLD_DAYS * DAY,
        structured: p.structured, ask: p.ask, recommend: p.recommend, why: p.why, rest: p.structured ? p.rest : "",
        preview: p.structured ? "" : p.preview, previewCut: p.structured ? false : p.truncated,
        gonogo: false, group: "backlog", snoozedUntil: 0,
        queuedAt: q && Number(q.at) > 0 && (!updated || updated <= Number(q.at) + 60000) ? Number(q.at) : 0,   // agent has not touched the task since (our own note lands within 60 s)
        askedAt: Number(asked[id]) || 0,
      };
      x.group = C.needs(it) ? "needs" : tags.some((t) => String(t).toLowerCase() === "idea") ? "ideas" : "backlog";
      if (x.group === "needs") x.gonogo = isGoNoGo({ tags, detail }, p);
      const until = Number(snoozes[id]) || 0;
      if (until > now) { x.snoozedUntil = until; snoozed.push(x); continue; }
      (x.group === "needs" ? needs : x.group === "ideas" ? ideas : backlog).push(x);
    }
  }
  needs.sort(sortNeeds); backlog.sort(sortBacklog); ideas.sort(sortBacklog); snoozed.sort((a, b) => a.snoozedUntil - b.snoozedUntil);
  const oldCount = (l) => l.filter((x) => x.old).length;
  return {
    now, needs, backlog, ideas, snoozed,
    counts: { needs: needs.length, backlog: backlog.length, ideas: ideas.length, snoozed: snoozed.length, open: openTotal, needsOld: oldCount(needs), gonogo: needs.filter((x) => x.gonogo).length },
  };
}

// Count that the sidebar badge and tab show: needs-owner, minus snoozed. `tasks` = mapTaskStores items (see contract.js for the flag) + snoozes map.
function needsCount(tasks, snoozes, now) {
  const sn = snoozes && typeof snoozes === "object" ? snoozes : {};
  let n = 0;
  for (const t of tasks || []) if (t && C.needs(t) && !((Number(sn[t.agent + "::" + t.id]) || 0) > now)) n++;
  return n;
}

// --- snooze -------------------------------------------------------------------------------------------
// "tomorrow" = 08:00 local next calendar day; "week" = 7 x 24 h from now.
function snoozeUntil(now, kind) {
  if (kind === "week") return now + 7 * DAY;
  if (kind === "tomorrow") { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.getTime(); }
  return 0;
}
function pruneSnoozes(snoozes, now, max) {
  const out = {};
  const keys = Object.keys(snoozes || {}).filter((k) => Number(snoozes[k]) > now).sort((a, b) => snoozes[b] - snoozes[a]).slice(0, max || 3000);
  for (const k of keys) out[k] = Number(snoozes[k]);
  return out;
}

// --- messages sent to the agent ---------------------------------------------------------------------------
function subject(item) { return clean(item.ask || item.title, MAX_TITLE).replace(/\n+/g, " "); }
const FOOT = (item) => `\n\n(Sent from Agent Desktop > My Daily > Tasks. Task id: ${item.taskId}. Act on it, then update or close the task.)`;
function answerMessage(item, answer, text, who) {
  const w = who || { name: "The user", poss: "The user's" };
  const title = clean(item.title, MAX_TITLE).replace(/\n+/g, " ");
  const q = item.ask && item.ask !== title ? `${subject(item)} (task: ${title})` : title;
  const head = answer === "yes" ? `${w.name} answered YES to: ${q}` : answer === "no" ? `${w.name} answered NO to: ${q}` : `${w.poss} reply about: ${q}\n\n${String(text).replace(/\r\n?/g, "\n").trim()}`;
  return head + FOOT(item);
}
function recommendRequest(item, who) {
  const w = who || { name: "The user", obj: "them", subj: "they", reads: "read" };
  const title = clean(item.title, MAX_TITLE).replace(/\n+/g, " ");
  return `${w.name} asks for your recommendation on this task that is waiting for ${w.obj}: ${title}\n\nPlease update the task detail so it STARTS with these three labelled lines, in plain language (${w.subj} ${w.reads} them as a card):\nASK: <the one question or action you need from ${w.obj}, one sentence>\nRECOMMEND: <what you suggest and why, one or two sentences>\nWHY IT MATTERS: <what happens if it waits / what it unlocks>\nKeep ${C.NEEDS_LABEL} set to yes. (Sent from Agent Desktop > My Daily > Tasks. Task id: ${item.taskId}.)`;
}
function validateText(text, max) {
  const t = String(text == null ? "" : text);
  if (!t.trim()) return { ok: false, reason: "Write your note first." };
  if (t.length > max) return { ok: false, reason: `That is ${t.length} characters; the limit is ${max}. Shorten it (nothing was sent).` };
  return { ok: true };
}
const noteFor = (answer, text, delivery, who) => ((who && who.name) || "The user") + " answered via My Daily Tasks" + (delivery === "queued" ? " (queued, not yet confirmed)" : "") + ": " + (answer === "yes" ? "YES" : answer === "no" ? "NO" : "text - " + String(text).replace(/\s+/g, " ").trim().slice(0, 600));

// Append a note to the task detail without losing the ASK/RECOMMEND head: when over `max`, the middle of the old detail is cut
// (first 1200 characters and the tail stay) with a visible marker. The note is never cut (<= 900). Returns { detail, cut }.
function appendNote(oldDetail, note, max) {
  const lim = max || D.DETAIL_MAX;
  const nt = String(note).slice(0, 900);
  const old = String(oldDetail == null ? "" : oldDetail);
  const sep = "\n\n";
  if (old.length + sep.length + nt.length <= lim) return { detail: (old ? old + sep : "") + nt, cut: false, oldLen: old.length };
  const headLen = Math.min(1200, old.length);
  const mark = (n) => `\n[... ${n} characters cut by My Daily ...]\n`;
  let tail = Math.max(0, lim - nt.length - sep.length - headLen - mark(old.length).length);
  tail = Math.min(tail, old.length - headLen);
  const cutN = old.length - headLen - tail;
  return { detail: old.slice(0, headLen) + mark(cutN) + (tail ? old.slice(old.length - tail) : "") + sep + nt, cut: true, oldLen: old.length };
}

module.exports = { DAY, OLD_DAYS, MAX_DETAIL, parseDetail, isYesNoAsk, isGoNoGo, sortNeeds, sortBacklog, buildView, needsCount, snoozeUntil, pruneSnoozes, answerMessage, recommendRequest, validateText, noteFor, appendNote };
