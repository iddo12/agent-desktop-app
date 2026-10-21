// MY RECOMMENDATIONS (main process, read-only, no electron import: everything is injected so tests can drive it).
// Data: <sharedReports>\recommendations\<week>\<agent>.json  { agent, week, generatedAt, headline, items[{ id, title, kind, why, impact, effort,
//       cost, needsIddo, firstStep, status }] }   and   <sharedReports>\coo\weekly_<week>.json  { topIdeas[{ rank, agent, ideaId, title, why }] }.
// The renderer only ever sends a week name, an agent name and an item id, never a path. Every string is clipped and type-checked; a malformed or
// oversized file is skipped (and counted), never fatal. Replies go through the My Research writer (research/write.js); "Replied" comes from its log.
"use strict";
const fsp = require("fs").promises;
const path = require("path");

const WEEK_RE = /^\d{4}-W\d{2}$/;
const DEFAULT_WEEKS = 8, MAX_WEEKS = 26, MAX_FILES_PER_WEEK = 60, MAX_ITEMS = 60, MAX_FILE_BYTES = 256 * 1024;
const BAD_NAME_RE = /[\\/:*?"<>|\u0000-\u001f]|\.\./;
const REC_PREFIX = "rec:";                                // finding id used in _writes.jsonl for a recommendation reply

const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(5, Math.round(v))) : 0);

// async on purpose: these files live in Dropbox, where one open can take ~2 s; nothing here may block the main thread
async function readJson(file) {
  let st;
  try { st = await fsp.lstat(file); } catch (e) { return { missing: true }; }
  if (!st.isFile()) return { bad: "not-a-file" };
  if (st.size > MAX_FILE_BYTES) return { bad: "too-big" };
  try { return { json: JSON.parse((await fsp.readFile(file, "utf8")).replace(/^﻿/, "")) }; } catch (e) { return { bad: "unreadable" }; }
}

// a "needs Iddo" text that is empty, or only says there is nothing to do, means he is not needed
function needsText(v) {
  const s = clip(v, 600).trim();
  if (!s) return "";
  if (/^(nothing|none|no\b|n\/a|not needed)/i.test(s)) return "";
  return s;
}

function cleanItem(it) {
  if (!it || typeof it !== "object" || Array.isArray(it)) return null;
  const id = clip(it.id, 116).trim(), title = clip(it.title, 300).trim();
  if (!id || !title) return null;
  return { id, title, kind: clip(it.kind, 20), why: clip(it.why, 3000), impact: num(it.impact), effort: clip(it.effort, 4), cost: clip(it.cost, 200),
    needsIddo: needsText(it.needsIddo), firstStep: clip(it.firstStep, 1500), status: clip(it.status, 40) };
}

function createService(o) {
  const recDir = o.recDir, cooDir = o.cooDir;
  const say = typeof o.log === "function" ? o.log : () => {};
  const listDirs = async (d) => { try { return (await fsp.readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory() && WEEK_RE.test(e.name)).map((e) => e.name); } catch (e) { return []; } };

  async function loadWeek(week) {
    const dir = path.join(recDir, week);
    let names = [];
    try { names = (await fsp.readdir(dir)).filter((n) => /\.json$/i.test(n) && !/\.bak/i.test(n) && !BAD_NAME_RE.test(n)).sort(); } catch (e) { names = []; }
    let skipped = 0;
    const agents = [];
    for (const n of names.slice(0, MAX_FILES_PER_WEEK)) {
      const r = await readJson(path.join(dir, n));
      if (!r.json || typeof r.json !== "object" || Array.isArray(r.json) || !Array.isArray(r.json.items)) { skipped++; continue; }
      const items = r.json.items.slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean);
      agents.push({ agent: n.replace(/\.json$/i, ""), headline: clip(r.json.headline, 800), generatedAt: clip(r.json.generatedAt, 40), items });
    }
    const top = [];
    const c = await readJson(path.join(cooDir, "weekly_" + week + ".json"));
    if (c.json && Array.isArray(c.json.topIdeas)) {
      for (const t of c.json.topIdeas.slice(0, 10)) {
        if (!t || typeof t !== "object") continue;
        const title = clip(t.title, 300).trim();
        if (!title) continue;
        top.push({ rank: num(t.rank) || top.length + 1, agent: clip(t.agent, 120), ideaId: clip(t.ideaId, 120), title, why: clip(t.why, 3000) });
      }
    }
    const headline = c.json && typeof c.json.headline === "string" ? clip(c.json.headline, 800) : "";
    agents.forEach((a) => a.items.forEach((i) => { i.needs = !!i.needsIddo; }));
    const total = agents.reduce((s, a) => s + a.items.length, 0), needs = agents.reduce((s, a) => s + a.items.filter((i) => i.needsIddo).length, 0);
    return { week, headline, top, agents, total, needs, skipped, cooMissing: !!c.missing };
  }

  // newest DEFAULT_WEEKS weeks; opts.all (the "older weeks" button) lifts the cap to MAX_WEEKS. `more` tells the screen older weeks exist.
  async function load(opts) {
    const all = !!(opts && opts.all), dirs = (await listDirs(recDir)).sort().reverse(), cap = all ? MAX_WEEKS : DEFAULT_WEEKS;
    const weeks = [];
    for (const w of dirs.slice(0, cap)) weeks.push(await loadWeek(w));
    return { ok: true, weeks, more: !all && dirs.length > cap };
  }

  // for the writer: the item must exist in that week's file for that agent. Returns { title } or null.
  async function findRef(week, agent, fid) {
    if (!WEEK_RE.test(week) || typeof agent !== "string" || BAD_NAME_RE.test(agent) || !agent.trim() || typeof fid !== "string" || !fid.startsWith(REC_PREFIX)) return null;
    const id = fid.slice(REC_PREFIX.length);
    const r = await readJson(path.join(recDir, week, agent.trim() + ".json"));
    if (!r.json || !Array.isArray(r.json.items)) return null;
    const it = r.json.items.map(cleanItem).find((x) => x && x.id === id);
    return it ? { title: "Recommendation: " + it.title } : null;
  }

  // "Replied" chips: last reply date per week|agent|itemId, read from the writer's log (research\_writes.jsonl), tail only.
  async function replied(logFile) {
    const out = {};
    let text = "";
    try {
      const st = await fsp.lstat(logFile);
      if (!st.isFile()) return out;
      const fh = await fsp.open(logFile, "r");
      try { const n = Math.min(st.size, 512 * 1024), buf = Buffer.alloc(n); await fh.read(buf, 0, n, st.size - n); text = buf.toString("utf8"); } finally { await fh.close(); }
    } catch (e) { return out; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch (e) { continue; }
      if (!j || typeof j !== "object" || Array.isArray(j) || typeof j.finding !== "string" || !j.finding.startsWith(REC_PREFIX)) continue;
      if (!WEEK_RE.test(j.week) || typeof j.agent !== "string" || typeof j.time !== "string" || j.delivery === "failed") continue;
      out[j.week + "|" + j.agent.toLowerCase() + "|" + j.finding.slice(REC_PREFIX.length)] = j.time.slice(0, 10);
    }
    return out;
  }

  return { load, findRef, replied };
}

module.exports = { createService, cleanItem, needsText, REC_PREFIX, WEEK_RE };
