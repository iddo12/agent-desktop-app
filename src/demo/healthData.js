// Demo mode (v1.86.0): fills the My Health store from fixtures/health/health.json (a fictional person, invented numbers).
// The real My Health reads one folder (the "store root"); demo mode points it at <base>\health through AGENT_DESKTOP_HEALTH_ROOT
// (see runtime.js), so no other location is ever read. This module only WRITES that folder, through the app's own store code, so the
// records are validated exactly like real ones.
"use strict";
const fs = require("fs");
const path = require("path");

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n", "utf8"); };

// small deterministic generator, so every launch draws the same curves
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function build(P, F, now) {
  const specFile = path.join(F, "health", "health.json");
  if (!fs.existsSync(specFile)) return false;
  const spec = JSON.parse(fs.readFileSync(specFile, "utf8").replace(/^\uFEFF/, ""));
  const { createStore } = require("../health/store");
  const store = createStore({ root: P.health });
  store.ensure();

  // measurements: one value per metric per day, built from a base, a slow trend and a weekly rhythm
  const list = [];
  let seed = 11;
  for (const s of spec.series || []) {
    const r = rng(seed++);
    for (let d = s.days; d >= 0; d--) {
      if (s.skipEvery && d % s.skipEvery === 0) continue;
      const t = (s.days - d) / s.days;
      const week = Math.sin((d / 7) * Math.PI * 2) * (s.weekly || 0);
      let v = s.base + (s.trend || 0) * t + week + (r() - 0.5) * 2 * (s.noise || 0);
      v = Math.round(v * Math.pow(10, s.decimals || 0)) / Math.pow(10, s.decimals || 0);
      const day = new Date(now - d * DAY);
      day.setHours(s.hour || 7, s.minute || 30, 0, 0);
      list.push({ metric: s.metric, value: v, ts: dateStr(day.getTime()) + "T" + pad(day.getHours()) + ":" + pad(day.getMinutes()) + ":00", source: s.source || "watch" });
    }
  }
  // blood pressure pairs
  for (const bp of spec.bloodPressure || []) {
    const r = rng(bp.seed || 5);
    for (let d = bp.days; d >= 0; d -= bp.every || 3) {
      const ts = dateStr(now - d * DAY) + "T08:10:00";
      list.push({ metric: "bp_systolic", value: Math.round(bp.sys + (r() - 0.5) * bp.noise * 2), ts, source: "cuff" });
      list.push({ metric: "bp_diastolic", value: Math.round(bp.dia + (r() - 0.5) * bp.noise), ts, source: "cuff" });
    }
  }
  store.addMeasurements(list.filter((m) => new Date(m.ts).getTime() <= now));

  store.addLabs((spec.labs || []).map((l) => Object.assign({}, l, { ts: dateStr(now - l.daysAgo * DAY), source: "clinic" })));
  for (const m of spec.meds || []) store.addMed({ name: m.name, dose: m.dose || "", schedule: m.schedule || "", medKind: m.medKind || "supplement", start: dateStr(now - (m.startDaysAgo || 60) * DAY), note: m.note || "" });
  for (const n of spec.notes || []) store.addNote({ text: n.text, ts: dateStr(now - n.daysAgo * DAY) + "T20:00:00", tags: n.tags || [] });
  if (spec.profile) writeJson(path.join(P.health, "profile.json"), spec.profile);

  // the "agent" files (read only for the app): interactions, evidence map, insights, plan, weekly review, reading list, trend notes
  const agentDir = path.join(P.health, "agent");
  const a = spec.agent || {};
  const today = dateStr(now);
  if (a.interactions) writeJson(path.join(agentDir, "interactions.json"), { schema: 1, checked: today, pairs: a.interactions });
  if (a.evidence) writeJson(path.join(agentDir, "evidence.json"), { schema: 1, items: a.evidence });
  if (a.insights) writeJson(path.join(agentDir, "insights", today + ".json"), { schema: 1, date: today, cards: a.insights });
  if (a.plan) writeJson(path.join(agentDir, "plan.json"), { schema: 1, items: a.plan });
  if (a.trendNotes) writeJson(path.join(agentDir, "trend_notes.json"), { schema: 1, notes: Object.fromEntries(Object.entries(a.trendNotes).map(([k, v]) => [k, { text: v, date: today }])) });
  if (a.reading) writeJson(path.join(agentDir, "reading.json"), { schema: 1, items: a.reading });
  if (a.worldview) { fs.mkdirSync(agentDir, { recursive: true }); fs.writeFileSync(path.join(agentDir, "worldview.md"), a.worldview, "utf8"); }
  if (a.weekly) {
    const LG = require("../health/longevity");
    const wk = LG.prevWeek(LG.isoWeek(new Date(now)));
    writeJson(path.join(agentDir, "weekly", wk + ".json"), Object.assign({ week: wk }, a.weekly));
  }
  // routines (the app's own file; a couple of invented morning/evening routines)
  if (a.routines) writeJson(path.join(P.health, "routines.json"), a.routines);
  return true;
}

module.exports = { build };
