// SKILLS & PLUGINS tab inside My Research (v1.139.0, main process, read-only, no electron import: everything is injected so tests can drive it).
// Shows what the weekly Skills & Plugins watch (Thursday job, shared_tools\agent_jobs\jobs\skills) will research and what it found. Files read:
//   <research>\skills_plugins_rotation.json            { week, agents[], reason, schedule, setAt, score_rule }   who researches this week
//   <research>\<YYYY-Www>\skills_<Agent>.json            { agent, week, generatedAt, spentUsd, summary, items[ITEM] }   what each agent found
//   <research>\sources\_skills_plugins.json              { updatedAt, sources[{ name, url, kind, score, lastUseful, barrenWeeks, note, ... }] }
//   <recommendations>\<week>\<Agent>.json                items[].decision.verdict (written by ARGUS's Install it / Park / Don't install buttons)
//   <sharedTools>\skills\<name>\README.md                pinned copies already adopted (vetted, hash-listed)
// The renderer only sends a week name; every folder is fixed in main. Every string is clipped and type-checked; a bad or oversized file is
// skipped (and counted), never fatal. Async on purpose: these files live in Dropbox, where one open can take seconds. Nothing is ever written.
"use strict";
const fsp = require("fs").promises;
const path = require("path");

const WEEK_RE = /^\d{4}-W\d{2}$/;
const MAX_FILE_BYTES = 512 * 1024, MAX_AGENT_FILES = 60, MAX_ITEMS = 60, MAX_SOURCES = 400, MAX_ADOPTED = 40, MAX_WEEKS = 26;
const BAD_NAME_RE = /[\\/:*?"<>|\u0000-\u001f]|\.\./;
const USE = { use_directly: 1, borrow_idea: 1, skip: 1 };
const VERDICT = { approved: 1, parked: 1, rejected: 1 };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const score = (v) => { const x = typeof v === "string" ? Number(v) : v; return Number.isFinite(x) ? Math.max(0, Math.min(10, Math.round(x))) : null; };
const strList = (v, n, len) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n).map((x) => x.trim().slice(0, len)) : []);
const safeUrl = (u) => { if (typeof u !== "string" || u.length > 1000) return ""; try { const p = new URL(u); return (p.protocol === "https:" || p.protocol === "http:") && !p.username && !p.password && p.hostname ? p.href : ""; } catch (e) { return ""; } };

async function readText(file, max) {
  let st;
  try { st = await fsp.lstat(file); } catch (e) { return { missing: true }; }
  if (!st.isFile()) return { bad: "not-a-file" };
  if (st.size > (max || MAX_FILE_BYTES)) return { bad: "too-big" };
  try { return { text: (await fsp.readFile(file, "utf8")).replace(/^﻿/, ""), mtime: st.mtimeMs }; } catch (e) { return { bad: "unreadable" }; }
}
async function readJson(file) {
  const r = await readText(file);
  if (r.text == null) return r;
  try { const j = JSON.parse(r.text); return j && typeof j === "object" && !Array.isArray(j) ? { json: j } : { bad: "unreadable" }; } catch (e) { return { bad: "unreadable" }; }
}
async function listDir(d) { try { return await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return []; } }

function cleanItem(it) {
  if (!it || typeof it !== "object" || Array.isArray(it)) return null;
  const id = clip(it.id, 116).trim(), title = clip(it.title, 300).trim();
  if (!id || !title) return null;
  return {
    id, title, use: USE[it.use] ? it.use : "", howItHelps: clip(it.how_it_helps, 3000), integration: clip(it.integration, 600), score: score(it.score),
    url: safeUrl(it.url), author: clip(it.author, 120), licence: clip(it.licence || it.license, 120), permissions: clip(it.permissions, 600),
    security: clip(it.security, 60), fitAgents: strList(it.fit_agents, 12, 80),
  };
}

function cleanSource(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const url = safeUrl(s.url);
  // an entry with no name (agents sometimes append only a url) is still shown, named after its link
  const name = clip(s.name, 160).trim() || clip(s.id, 160).trim() || (url ? url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").slice(0, 160) : "");
  if (!name) return null;
  const bw = typeof s.barrenWeeks === "number" && Number.isFinite(s.barrenWeeks) ? Math.max(0, Math.min(999, Math.round(s.barrenWeeks))) : null;
  return { name, url, kind: clip(s.kind, 40), score: score(s.score), lastUseful: clip(s.lastUseful, 20), lastChecked: clip(s.lastChecked, 20),
    barrenWeeks: bw, note: clip(s.note, 1500), domains: strList(s.domains, 12, 30), addedOn: clip(s.addedOn, 20), addedBy: clip(s.addedBy, 80) };
}

// "Thursday ~17:00 Israel, ..." -> { day: 4, hour: 17, minute: 0 }; null when the text names no weekday and time
function parseSchedule(text) {
  const s = String(text || "").toLowerCase();
  const d = DAYS.findIndex((w) => new RegExp("\\b" + w + "\\b").test(s));
  const m = /(\d{1,2}):(\d{2})/.exec(s);
  if (d < 0 || !m || +m[1] > 23 || +m[2] > 59) return null;
  return { day: d, hour: +m[1], minute: +m[2] };
}
// the next time that weekday/hour comes round on this computer's clock (the PC's own time zone is the owner's; nothing assumed here)
function nextRun(sched, nowMs) {
  if (!sched) return null;
  const now = new Date(nowMs), t = new Date(nowMs);
  t.setHours(sched.hour, sched.minute, 0, 0);
  let add = (sched.day - now.getDay() + 7) % 7;
  if (add === 0 && t.getTime() <= nowMs) add = 7;
  t.setDate(t.getDate() + add);
  return t.getTime();
}
// ISO week name of a time ("2026-W43")
function isoWeek(ms) {
  const d = new Date(ms); const u = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = u.getUTCDay() || 7; u.setUTCDate(u.getUTCDate() + 4 - day);
  const y = u.getUTCFullYear(), w = Math.ceil(((u - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return y + "-W" + String(w).padStart(2, "0");
}

// a pinned copy's README: first "# " line is its name, "Source:" and "Vetted ..." lines are shown as written, sha256 lines are counted
function readAdopted(name, text, skillCount) {
  const lines = String(text || "").split(/\r?\n/);
  const head = lines.find((l) => /^#\s+/.test(l));
  const pick = (re) => { const l = lines.find((x) => re.test(x)); return l ? l.trim().slice(0, 400) : ""; };
  const hashes = lines.filter((l) => /^\s*[0-9a-f]{64}\s+\*?\S/.test(l)).length;
  return { name: clip(name, 80), title: head ? head.replace(/^#\s+/, "").trim().slice(0, 200) : name, source: pick(/^source:/i), vetted: pick(/^vetted\b/i), hashes, skills: skillCount };
}

function createService(o) {
  const researchDir = o.researchDir, recDir = o.recDir, skillsDir = o.skillsDir;
  const now = typeof o.now === "function" ? o.now : () => Date.now();
  const say = typeof o.log === "function" ? o.log : () => {};

  // weeks that hold at least one skills_*.json, newest first
  async function skillWeeks() {
    const out = [];
    const dirs = (await listDir(researchDir)).filter((e) => e.isDirectory() && WEEK_RE.test(e.name)).map((e) => e.name).sort().reverse().slice(0, MAX_WEEKS);
    for (const w of dirs) { const names = await listDir(path.join(researchDir, w)); if (names.some((e) => e.isFile() && /^skills_.+\.json$/i.test(e.name))) out.push(w); }
    return out;
  }

  async function verdicts(week, agent) {
    if (!recDir || BAD_NAME_RE.test(agent)) return {};
    const r = await readJson(path.join(recDir, week, agent + ".json"));
    const out = {};
    if (r.json && Array.isArray(r.json.items)) r.json.items.slice(0, 200).forEach((i) => {
      if (i && typeof i.id === "string" && i.decision && VERDICT[i.decision.verdict]) out[i.id] = { verdict: i.decision.verdict, at: clip(i.decision.at, 40) };
    });
    return out;
  }

  async function loadFound(week) {
    const dir = path.join(researchDir, week);
    const names = (await listDir(dir)).filter((e) => e.isFile() && /^skills_.+\.json$/i.test(e.name) && !/\.bak/i.test(e.name)).map((e) => e.name).sort();
    let skipped = 0;
    const agents = [];
    for (const n of names.slice(0, MAX_AGENT_FILES)) {
      const fromName = n.replace(/^skills_/i, "").replace(/\.json$/i, "");
      if (BAD_NAME_RE.test(fromName)) { skipped++; continue; }
      const r = await readJson(path.join(dir, n));
      if (!r.json || !Array.isArray(r.json.items)) { skipped++; continue; }
      const v = await verdicts(week, fromName);
      const items = r.json.items.slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean)
        .map((i) => Object.assign(i, { decision: v[i.id] || null }))
        .sort((a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score));
      const spent = typeof r.json.spentUsd === "number" && Number.isFinite(r.json.spentUsd) ? r.json.spentUsd : null;
      agents.push({ agent: clip(r.json.agent, 120).trim() || fromName, file: fromName, generatedAt: clip(r.json.generatedAt, 40), summary: clip(r.json.summary, 2000), spent, items });
    }
    if (names.length > MAX_AGENT_FILES) skipped += names.length - MAX_AGENT_FILES;
    agents.sort((a, b) => (b.items[0] ? b.items[0].score || 0 : -1) - (a.items[0] ? a.items[0].score || 0 : -1) || a.agent.localeCompare(b.agent));
    return { agents, skipped };
  }

  async function loadRotation() {
    const r = await readJson(path.join(researchDir, "skills_plugins_rotation.json"));
    if (!r.json) return { missing: !!r.missing, bad: r.bad || "" };
    const j = r.json, sched = parseSchedule(j.schedule);
    return { week: WEEK_RE.test(j.week) ? j.week : "", agents: strList(j.agents, 40, 120), reason: clip(j.reason, 2000), schedule: clip(j.schedule, 400),
      setAt: clip(j.setAt, 20), scoreRule: clip(j.score_rule, 400), nextRunAt: nextRun(sched, now()) };
  }

  async function loadSources() {
    const r = await readJson(path.join(researchDir, "sources", "_skills_plugins.json"));
    if (!r.json || !Array.isArray(r.json.sources)) return { missing: !!r.missing, bad: r.json ? "unreadable" : (r.bad || ""), list: [] };
    const list = r.json.sources.slice(0, MAX_SOURCES).map(cleanSource).filter(Boolean)
      .sort((a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score) || a.name.localeCompare(b.name));
    return { updatedAt: clip(r.json.updatedAt, 20), list };
  }

  async function loadAdopted() {
    if (!skillsDir) return [];
    const out = [];
    for (const e of (await listDir(skillsDir)).filter((x) => x.isDirectory() && !BAD_NAME_RE.test(x.name)).slice(0, MAX_ADOPTED)) {
      const d = path.join(skillsDir, e.name);
      const r = await readText(path.join(d, "README.md"), 128 * 1024);
      if (r.text == null) continue;                      // a folder without a README is not a pinned copy
      let skills = 0;
      for (const s of (await listDir(d)).filter((x) => x.isDirectory())) { const k = await readText(path.join(d, s.name, "SKILL.md"), 256 * 1024); if (k.text != null) skills++; }
      out.push(readAdopted(e.name, r.text, skills));
    }
    return out;
  }

  // load({week}) -> everything the tab shows. week: a week name (the picker), otherwise the newest week that has findings.
  async function load(opts) {
    const want = opts && typeof opts.week === "string" && WEEK_RE.test(opts.week) ? opts.week : "";
    const weeks = await skillWeeks();
    const week = want && weeks.indexOf(want) >= 0 ? want : (weeks[0] || "");
    const [rotation, found, sources, adopted] = await Promise.all([loadRotation(), week ? loadFound(week) : Promise.resolve({ agents: [], skipped: 0 }), loadSources(), loadAdopted()]);
    const total = found.agents.reduce((s, a) => s + a.items.length, 0);
    // the comparison for the "found" number: the week before the one shown (only when such a week has findings)
    const prevWeek = week ? weeks[weeks.indexOf(week) + 1] || "" : "";
    const prevTotal = prevWeek ? (await loadFound(prevWeek)).agents.reduce((s, a) => s + a.items.length, 0) : null;
    say("skills-load: week=" + (week || "none") + " agents=" + found.agents.length + " items=" + total);
    return { ok: true, thisWeek: isoWeek(now()), week, weeks, rotation, agents: found.agents, skipped: found.skipped, total, prevWeek, prevTotal, sources, adopted };
  }

  return { load };
}

module.exports = { createService, cleanItem, cleanSource, parseSchedule, nextRun, isoWeek, readAdopted, WEEK_RE };
