// THYRA TABS (v1.156.0): the Task list and Ideas tabs of the THYRA dock window. Main-process rules, no Electron here (testable).
// Read-only over the fleet task stores (<sharedReports>\tasks\<agent>.json) and the registry folder; the ONLY writes are our own ledger
// (userData\thyra-ideas.json: "moved to" and "sent to" records) and, for "Mark built" on a task-sourced idea, tasks.py --close (one writer logic).
// Nothing is polled: the dock asks when a tab is opened or Refresh is clicked.
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("./tasklist/tasklistLogic");

const MAX_STORE_BYTES = 4 * 1024 * 1024, MAX_AGENTS = 120, MAX_TASKS_PER_AGENT = 80, MAX_IDEAS = 400, MAX_REG_FILES = 3000, MAX_REG_BYTES = 200 * 1024;
const DEFAULT_DESTINATIONS = ["My Tools", "Product Development", "Software Engineering", "LensVid tools"];
const clip = L.clip;
const oneLine = (s, n) => clip(String(s == null ? "" : s), n * 2).replace(/\s+/g, " ").trim().slice(0, n);
const isConflict = (n) => /conflicted copy/i.test(n) || /\.(lock|tmp|bak)/i.test(n);
const readJson = (f, max) => { const st = fs.statSync(f); if (!st.isFile() || st.size > (max || MAX_STORE_BYTES)) return null; return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); };

// ---- task stores ----
function readStores(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f) && !isConflict(f)).map((f) => f.slice(0, -5)).filter((n) => L.AGENT_OK.test(n)).sort((a, b) => a.localeCompare(b)).slice(0, MAX_AGENTS); }
  catch (e) { return null; }
  const out = [];
  for (const agent of names) {
    try { const j = readJson(path.join(dir, agent + ".json")); if (j) out.push({ agent, items: Array.isArray(j.items) ? j.items : [] }); } catch (e) { /* unreadable store: skipped */ }
  }
  return out;
}
const ageDays = (iso, now) => { const t = Date.parse(iso); return isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : null; };
// -> [{agent, open, needs, stuck, working, newest:{title,created}, tasks:[...]}] : agents that need the owner first, then most open
function buildTaskGroups(stores, nowMs) {
  const groups = [];
  for (const s of stores) {
    const rows = L.summarize([s], new Date(nowMs).toISOString()).rows.filter((r) => r.group !== "finished");
    const needs = rows.filter((r) => r.group === "needs_you").length, stuck = rows.filter((r) => r.group === "stuck").length, working = rows.filter((r) => r.group === "working").length;
    const byNew = rows.slice().sort((a, b) => (b.created > a.created ? 1 : b.created < a.created ? -1 : 0))[0];
    groups.push({
      agent: oneLine(s.agent, 120), open: rows.length, needs, stuck, working,
      newest: byNew ? { title: oneLine(byNew.title, 160), created: byNew.created, age: ageDays(byNew.created, nowMs) } : null,
      tasks: rows.slice(0, MAX_TASKS_PER_AGENT).map((r) => ({ id: r.id, title: oneLine(r.title, 220), group: r.group, line: oneLine(r.line, 160), priority: r.priority, created: r.created, age: ageDays(r.created, nowMs) })),
      more: Math.max(0, rows.length - MAX_TASKS_PER_AGENT),
    });
  }
  groups.sort((a, b) => (b.needs > 0) - (a.needs > 0) || b.needs - a.needs || b.open - a.open || a.agent.localeCompare(b.agent));
  return groups;
}
function taskTotals(groups) { return groups.reduce((t, g) => ({ open: t.open + g.open, needs: t.needs + g.needs, agents: t.agents + (g.open ? 1 : 0) }), { open: 0, needs: 0, agents: 0 }); }

// ---- registry (read-only) ----
function readRegistryIdeas(regDir) {
  let files;
  try { files = fs.readdirSync(regDir).filter((f) => /\.json$/i.test(f) && !isConflict(f)).slice(0, MAX_REG_FILES); } catch (e) { return []; }
  const out = [];
  for (const f of files) {
    try {
      const j = readJson(path.join(regDir, f), MAX_REG_BYTES);
      if (j && j.stage === "idea" && j.status !== "archived" && j.status !== "retired") out.push(j);
    } catch (e) { /* skipped */ }
  }
  return out;
}
const hasIdeaTag = (i) => Array.isArray(i.tags) && i.tags.some((t) => String(t).toLowerCase() === "idea");
const keyOfTask = (agent, id) => "task:" + agent + ":" + id;
const keyOfReg = (id) => "reg:" + id;
// An idea lives only while its source says so: an open task tagged idea, or a registry project at stage idea. Closed task / stage past idea / "moved" = gone.
function collectIdeas(stores, regEntries, ledger, nowMs) {
  const led = ledger || { moved: {}, sent: {} }, out = [];
  for (const s of stores) {
    for (const i of s.items) {
      if (!i || typeof i !== "object" || i.status === "done" || !hasIdeaTag(i) || !i.id) continue;
      const key = keyOfTask(s.agent, i.id); if (led.moved && led.moved[key]) continue;
      out.push({ key, source: "task", agent: oneLine(s.agent, 120), id: oneLine(i.id, 120), title: oneLine(i.plain || i.title, 220), detail: clip(String(i.detail || ""), 4000), tags: (i.tags || []).map((t) => oneLine(t, 30)).slice(0, 8), created: oneLine(i.created, 40), age: ageDays(i.created, nowMs), sent: (led.sent && led.sent[key]) || null });
    }
  }
  for (const r of regEntries || []) {
    if (!r || !r.id) continue; const key = keyOfReg(r.id); if (led.moved && led.moved[key]) continue;
    out.push({ key, source: "registry", agent: oneLine(r.agent, 120), id: oneLine(r.id, 120), title: oneLine(r.title, 220), detail: clip(String(r.description || ""), 4000), tags: [oneLine(r.topic, 30)].filter(Boolean), created: oneLine(r.createdAt, 40), age: ageDays(r.createdAt, nowMs), sent: (led.sent && led.sent[key]) || null });
  }
  out.sort((a, b) => (b.created > a.created ? 1 : b.created < a.created ? -1 : 0));
  return out.slice(0, MAX_IDEAS);
}

// ---- ledger (userData\thyra-ideas.json) ----
function readLedger(file) {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return { moved: j && typeof j.moved === "object" && j.moved ? j.moved : {}, sent: j && typeof j.sent === "object" && j.sent ? j.sent : {} }; } catch (e) { return { moved: {}, sent: {} }; }
}
function writeLedger(file, led) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(led)); fs.renameSync(tmp, file); return true; } catch (e) { return false; }
}

// ---- configurable lists ----
const splitList = (s) => String(s || "").split(/[;\r\n]+/).map((x) => x.trim()).filter(Boolean).slice(0, 30);
function destinations(cfgText) { const l = splitList(cfgText).map((x) => oneLine(x, 40)); return l.length ? l : DEFAULT_DESTINATIONS.slice(); }
// Send-to targets: the configured names (thyraIdeaTargets) resolved against the real agent folders (a trailing * = "starts with"); unset = the security and lead roles.
function targets(cfgText, roleNames, folders) {
  const wanted = splitList(cfgText).length ? splitList(cfgText) : (roleNames || []).filter(Boolean);
  const out = [], seen = new Set();
  for (const w of wanted) {
    const star = /\*$/.test(w), base = w.replace(/\*$/, "").toLowerCase();
    for (const f of folders || []) {
      const lf = String(f).toLowerCase();
      if ((star ? lf.startsWith(base) : lf === base) && !seen.has(f)) { seen.add(f); out.push(f); break; }
    }
  }
  return out;
}

// ---- the message that is delivered to the chosen agent ----
function ideaMessage(idea, target, instruction, owner) {
  const who = owner || "The owner", ins = oneLine(instruction, 300);
  const src = idea.source === "task" ? "task " + idea.id + " in " + idea.agent + "'s task list" : "registry project " + idea.id;
  const det = oneLine(idea.detail, 900);
  return who + " sent you an idea from THYRA > Ideas: \"" + oneLine(idea.title, 200) + "\" (" + src + "). " + (det ? "Detail: " + det + " " : "") + "Instruction: \"" + ins + "\". You decide who runs it; reply when you have a plan.";
}
const validInstruction = (s) => typeof s === "string" && oneLine(s, 400).length >= 2;

module.exports = { readStores, buildTaskGroups, taskTotals, readRegistryIdeas, collectIdeas, readLedger, writeLedger, destinations, targets, ideaMessage, validInstruction, splitList, keyOfTask, keyOfReg, isConflict, DEFAULT_DESTINATIONS };
