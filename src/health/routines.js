// My Health stage 1b: routines and challenges (small chunks through the day). The app's OWN file: <store root>\routines.json
// {schema:1, quiet:{start,end}, snoozeUntil|null, items:[Routine]}. Pure logic plus a small atomic file IO.
// Motivation first: skipping and pausing never break a streak, wording is never guilt-based, targets are small.
// PRIVACY: nothing here logs. Reminder text is neutral and lives in reminders.js; it never names a routine.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AT = require("./atomic");

const TEMPLATES = [
  { id: "pushups", title: "Push-ups", unit: "push-ups", chunk: 10, perDay: 5 },
  { id: "pullups", title: "Pull-ups", unit: "pull-up", chunk: 1, perDay: 8 },
  { id: "squats", title: "Squats", unit: "squats", chunk: 15, perDay: 4 },
  { id: "stretch", title: "Stretch", unit: "min stretch", chunk: 5, perDay: 3 },
  { id: "water", title: "Water", unit: "glass", chunk: 1, perDay: 8 },
  { id: "walk", title: "Walk", unit: "min walk", chunk: 10, perDay: 3 },
  { id: "breathing", title: "Breathing", unit: "min breathing", chunk: 2, perDay: 3 },
];
const KEEP_DAYS = 120;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const addDays = (key, n) => { const d = new Date(key + "T12:00:00"); d.setDate(d.getDate() + n); return dayKey(d); };
const clean = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "").trim().slice(0, max) : "");
const int = (v, lo, hi) => { const n = Math.round(Number(v)); return isFinite(n) && n >= lo && n <= hi ? n : null; };

function defaultState() { return { schema: 1, quiet: { start: "22:00", end: "07:00" }, snoozeUntil: null, items: [] }; }

function normalizeTimes(list) {
  const out = []; for (const t of Array.isArray(list) ? list.slice(0, 12) : []) if (typeof t === "string" && TIME_RE.test(t) && out.indexOf(t) < 0) out.push(t);
  return out.sort();
}
function normalizeRoutine(input) {
  if (!input || typeof input !== "object") return null;
  const title = clean(input.title, 40), unit = clean(input.unit, 24), chunk = int(input.chunk, 1, 1000), perDay = int(input.perDay, 1, 24);
  if (!title || !unit || chunk == null || perDay == null) return null;
  const id = typeof input.id === "string" && /^r_[a-f0-9]{16}$/.test(input.id) ? input.id : "r_" + crypto.randomBytes(8).toString("hex");
  const log = {};
  if (input.log && typeof input.log === "object") for (const k of Object.keys(input.log).sort().slice(-KEEP_DAYS)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue; const e = input.log[k]; if (!e || typeof e !== "object") continue;
    const done = int(e.done, 0, 200); log[k] = { done: done == null ? 0 : done, skipped: e.skipped === true };
  }
  const rem = input.reminders && typeof input.reminders === "object" ? input.reminders : {};
  return { id, title, unit, chunk, perDay, template: typeof input.template === "string" && /^[a-z]{3,12}$/.test(input.template) ? input.template : null,
    paused: input.paused === true, pausedAt: input.paused === true && /^\d{4}-\d{2}-\d{2}$/.test(input.pausedAt || "") ? input.pausedAt : null,
    created: /^\d{4}-\d{2}-\d{2}$/.test(input.created || "") ? input.created : dayKey(new Date()), reminders: { enabled: rem.enabled === true, times: normalizeTimes(rem.times) }, log };
}
function normalizeState(raw) {
  const s = defaultState();
  if (!raw || typeof raw !== "object") return s;
  if (raw.quiet && TIME_RE.test(raw.quiet.start) && TIME_RE.test(raw.quiet.end)) s.quiet = { start: raw.quiet.start, end: raw.quiet.end };
  if (typeof raw.snoozeUntil === "string" && isFinite(Date.parse(raw.snoozeUntil))) s.snoozeUntil = raw.snoozeUntil;
  for (const it of (Array.isArray(raw.items) ? raw.items : []).slice(0, 30)) { const r = normalizeRoutine(it); if (r) s.items.push(r); }
  return s;
}

// ---- derived view of one routine
function entry(item, key) { return item.log[key] || { done: 0, skipped: false }; }
function streak(item, todayKey) {
  let n = 0, k = todayKey;
  const e0 = entry(item, k);
  if (!(e0.done >= item.perDay)) k = addDays(k, -1);   // today still open: do not count it against you
  for (let i = 0; i < KEEP_DAYS; i++, k = addDays(k, -1)) {
    if (k < item.created) break;
    const e = entry(item, k);
    if (e.done >= item.perDay) n++;
    else if (e.skipped) continue;                       // a skipped or paused day bridges the streak
    else break;
  }
  return n;
}
function summarize(item, todayKey) {
  const e = entry(item, todayKey);
  const week = []; for (let i = 6; i >= 0; i--) { const k = addDays(todayKey, -i), x = entry(item, k); week.push({ date: k, done: x.done, skipped: x.skipped, target: item.perDay, met: x.done >= item.perDay }); }
  return { id: item.id, title: item.title, unit: item.unit, chunk: item.chunk, perDay: item.perDay, template: item.template, paused: item.paused,
    done: e.done, skipped: e.skipped, target: item.perDay, pct: Math.min(100, Math.round((e.done / item.perDay) * 100)), complete: e.done >= item.perDay,
    streak: streak(item, todayKey), week, weekChunks: week.reduce((a, d) => a + d.done, 0), prevWeekChunks: Array.from({ length: 7 }, (_, i) => entry(item, addDays(todayKey, -7 - i)).done).reduce((a, b) => a + b, 0), reminders: item.reminders };
}
function cheer(done, target) {
  if (done >= target) return "All done for today. Nicely done!";
  if (done === 1) return "First chunk in. Good start.";
  if (done === Math.ceil(target / 2)) return "Halfway there.";
  return ["Nice.", "One more in the bag.", "Easy does it.", "Good rhythm."][done % 4];
}
function nextChunk(state, todayKey) {
  for (const it of state.items) { const e = entry(it, todayKey); if (!it.paused && !e.skipped && e.done < it.perDay) return { id: it.id, text: it.chunk + " " + it.unit, done: e.done, perDay: it.perDay }; }
  return null;
}

// ---- operations (mutate a normalized state, return {ok, ...})
function find(state, id) { return state.items.find((x) => x.id === id) || null; }
function setLog(it, key, patch) { it.log[key] = Object.assign({ done: 0, skipped: false }, it.log[key], patch); const keys = Object.keys(it.log).sort(); while (keys.length > KEEP_DAYS) delete it.log[keys.shift()]; }
const OPS = {
  add(state, p, todayKey) {
    if (state.items.length >= 30) return { ok: false, reason: "That is plenty of routines already." };
    const t = p.template ? TEMPLATES.find((x) => x.id === p.template) : null;
    const r = normalizeRoutine({ title: p.title || (t && t.title), unit: p.unit || (t && t.unit), chunk: p.chunk != null ? p.chunk : t && t.chunk, perDay: p.perDay != null ? p.perDay : t && t.perDay, template: t ? t.id : null, created: todayKey });
    if (!r) return { ok: false, reason: "Give it a name, a chunk size and how many chunks per day." };
    state.items.push(r); return { ok: true, id: r.id };
  },
  chunk(state, p, todayKey) { const it = find(state, p.id); if (!it) return { ok: false, reason: "That routine is gone." }; const e = entry(it, todayKey); const d = Math.max(0, Math.min(200, e.done + (p.delta === -1 ? -1 : 1))); setLog(it, todayKey, { done: d, skipped: false }); return { ok: true, done: d, target: it.perDay, cheer: p.delta === -1 ? "" : cheer(d, it.perDay) }; },
  skip(state, p, todayKey) { const it = find(state, p.id); if (!it) return { ok: false, reason: "That routine is gone." }; setLog(it, todayKey, { skipped: p.undo !== true }); return { ok: true }; },
  pause(state, p, todayKey) { const it = find(state, p.id); if (!it) return { ok: false, reason: "That routine is gone." }; it.paused = true; it.pausedAt = todayKey; return { ok: true }; },
  resume(state, p, todayKey) {
    const it = find(state, p.id); if (!it) return { ok: false, reason: "That routine is gone." };
    if (it.paused && it.pausedAt) for (let k = it.pausedAt, i = 0; k < todayKey && i < KEEP_DAYS; k = addDays(k, 1), i++) if (entry(it, k).done === 0) setLog(it, k, { skipped: true });   // paused days bridge the streak
    it.paused = false; it.pausedAt = null; return { ok: true };
  },
  remove(state, p) { const n = state.items.length; state.items = state.items.filter((x) => x.id !== p.id); return n === state.items.length ? { ok: false, reason: "That routine is gone." } : { ok: true }; },
  reminders(state, p) { const it = find(state, p.id); if (!it) return { ok: false, reason: "That routine is gone." }; const times = normalizeTimes(p.times); it.reminders = { enabled: p.enabled === true && times.length > 0, times }; return { ok: true, enabled: it.reminders.enabled }; },
  quiet(state, p) { if (!TIME_RE.test(p.start) || !TIME_RE.test(p.end)) return { ok: false, reason: "Use times like 22:00." }; state.quiet = { start: p.start, end: p.end }; return { ok: true }; },
  snooze(state, p, todayKey, now) { const m = int(p.minutes, 0, 24 * 60); if (m == null) return { ok: false, reason: "Bad snooze." }; state.snoozeUntil = m === 0 ? null : new Date(now + m * 60000).toISOString(); return { ok: true }; },
};

// ---- reminders (pure scheduling helpers; the timer lives in reminders.js)
const hm = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
function inQuiet(quiet, date) {
  const m = date.getHours() * 60 + date.getMinutes(), s = hm(quiet.start), e = hm(quiet.end);
  return s === e ? false : s < e ? m >= s && m < e : m >= s || m < e;
}
function enabledAny(state) { return state.items.some((i) => i.reminders.enabled && !i.paused && i.reminders.times.length); }
// Earliest reminder time strictly after `now` (ms). Looks today and tomorrow. null when nothing is enabled.
function nextDue(state, now) {
  let best = null;
  for (const it of state.items) {
    if (!it.reminders.enabled || it.paused) continue;
    for (const t of it.reminders.times) for (const off of [0, 1]) {
      const d = new Date(now); d.setDate(d.getDate() + off); d.setHours(+t.slice(0, 2), +t.slice(3), 0, 0);
      const ms = d.getTime(); if (ms > now && (best == null || ms < best)) best = ms;
    }
  }
  return best;
}
// At a firing moment: is there a routine with a time in the last `graceMs`, still open today, outside quiet hours and not snoozed?
function shouldNotify(state, now, graceMs) {
  const g = graceMs == null ? 5 * 60000 : graceMs, date = new Date(now), today = dayKey(date);
  if (inQuiet(state.quiet, date)) return false;
  if (state.snoozeUntil && Date.parse(state.snoozeUntil) > now) return false;
  for (const it of state.items) {
    if (!it.reminders.enabled || it.paused) continue;
    const e = entry(it, today); if (e.skipped || e.done >= it.perDay) continue;
    for (const t of it.reminders.times) { const d = new Date(now); d.setHours(+t.slice(0, 2), +t.slice(3), 0, 0); const diff = now - d.getTime(); if (diff >= 0 && diff <= g) return true; }
  }
  return false;
}

// ---- file IO (atomic)
function createRoutineFile(root, opts) {
  const fsx = (opts && opts.fs) || fs, file = path.join(root, "routines.json");
  function load() { try { return normalizeState(JSON.parse(fsx.readFileSync(file, "utf8").replace(/^﻿/, ""))); } catch (e) { return defaultState(); } }
  function save(state) { AT.write(fsx, file, JSON.stringify(state) + "\n"); }
  function act(op, p, now) {
    const fn = OPS[op]; if (!fn) return { ok: false, reason: "Unknown action." };
    const state = load(), r = fn(state, p || {}, dayKey(new Date(now)), now);
    if (r.ok) save(state);
    return r;
  }
  return { file, load, save, act };
}

module.exports = { TEMPLATES, defaultState, normalizeState, normalizeRoutine, summarize, streak, cheer, nextChunk, OPS, inQuiet, enabledAny, nextDue, shouldNotify, createRoutineFile, dayKey, addDays };
