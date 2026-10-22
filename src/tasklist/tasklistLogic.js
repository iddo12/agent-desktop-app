// Task List: pure rules, no I/O. Turns the fleet task-store items (shared_tools\tasks\tasks.py) into plain-language rows and groups.
// Groups (in the order they are shown): needs_you, stuck, working, not_started, finished. Wording is for a non-technical reader.
"use strict";

const GROUPS = ["needs_you", "stuck", "working", "not_started", "finished"];
const LABEL = { needs_you: "Needs you", stuck: "Stuck", working: "Working on it", not_started: "Not started", finished: "Finished" };
const clip = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "").slice(0, n) : "");
const ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const AGENT_OK = /^[^\\/:*?"<>|\u0000-\u001f]{1,120}$/;

function groupOf(i) {
  if (i.status === "done") return "finished";
  if (i.needsIddo === true) return "needs_you";
  if (i.status === "blocked") return "stuck";
  return i.startedAt ? "working" : "not_started";
}

// one store item -> a row the view can draw. Text is clipped and stripped of control/bidi characters (agents write it).
function toRow(agent, i) {
  const group = groupOf(i);
  return {
    agent: clip(agent, 120), id: clip(String(i.id || ""), 120), group,
    title: clip(String(i.plain || i.title || ""), 300),
    line: group === "working" ? clip(String(i.progress || ""), 300) : "",
    priority: i.priority === 1 || i.priority === 3 ? i.priority : 2,
    order: typeof i.order === "number" ? i.order : null,
    startedAt: clip(String(i.startedAt || ""), 40), closedAt: clip(String(i.closedAt || ""), 40), updated: clip(String(i.updated || ""), 40),
    plainMissing: !i.plain, needs: i.needsIddo === true, created: clip(String(i.created || ""), 40),
  };
}

// same order tasks.py uses for its board: manual order first, then needs-you, priority, creation time
const orderKey = (r) => [r.order === null ? 1 : 0, r.order === null ? 0 : r.order, r.needs ? 0 : 1, r.priority, r.created];
function cmp(a, b) {
  const x = orderKey(a), y = orderKey(b);
  for (let k = 0; k < x.length; k++) { if (x[k] < y[k]) return -1; if (x[k] > y[k]) return 1; }
  return 0;
}

const dayOf = (iso) => String(iso || "").slice(0, 10);
const addDays = (day, n) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// stores: [{agent, items:[], archive?:[]}] -> { rows (sorted, grouped order), counts }
function summarize(stores, todayIso) {
  const today = dayOf(todayIso), yesterday = addDays(today, -1);
  const rows = [], counts = { needs_you: 0, stuck: 0, working: 0, not_started: 0, finished: 0, doneToday: 0, doneYesterday: 0 };
  for (const s of stores) {
    for (const i of Array.isArray(s.items) ? s.items : []) {
      if (!i || typeof i !== "object") continue;
      const r = toRow(s.agent, i); rows.push(r); counts[r.group]++;
    }
    for (const i of [].concat(Array.isArray(s.items) ? s.items : [], Array.isArray(s.archive) ? s.archive : [])) {
      if (!i || i.status !== "done") continue;
      const d = dayOf(i.closedAt); if (d === today) counts.doneToday++; else if (d === yesterday) counts.doneYesterday++;
    }
  }
  const rank = (r) => GROUPS.indexOf(r.group);
  rows.sort((a, b) => rank(a) - rank(b) || (a.group === "finished" ? (b.closedAt > a.closedAt ? 1 : -1) : cmp(a, b)));
  return { rows, counts };
}

// Reorder inside ONE agent's not-finished rows. Up/down swap with the neighbour in the SAME group (what the person sees). -> tasks.py arguments or null.
function moveArgs(rowsOfAgent, id, dir) {
  const live = rowsOfAgent.filter((r) => r.group !== "finished" && ID_OK.test(r.id)).sort(cmp);
  if (typeof id !== "string" || !ID_OK.test(id)) return null;
  const at = live.findIndex((r) => r.id === id);
  if (at < 0) return null;
  if (dir === "top") return at === 0 ? null : ["--move", id, "--top"];
  if (dir === "bottom") return at === live.length - 1 ? null : ["--move", id, "--bottom"];
  const g = live[at].group;
  if (dir === "up") {
    for (let k = at - 1; k >= 0; k--) if (live[k].group === g) return ["--move", id, "--before", live[k].id];
    return null;
  }
  if (dir === "down") {
    let nx = -1; for (let k = at + 1; k < live.length; k++) if (live[k].group === g) { nx = k; break; }
    if (nx < 0) return null;
    return nx + 1 < live.length ? ["--move", id, "--before", live[nx + 1].id] : ["--move", id, "--bottom"];
  }
  return null;
}

module.exports = { GROUPS, LABEL, AGENT_OK, ID_OK, groupOf, toRow, summarize, moveArgs, clip };
