// My Health stage 1: turns store records into what the three screens draw. Pure. The renderer only draws this.
"use strict";
const S = require("./schema");
const C = require("./compare");

// Today tiles in display order. "bp" pairs systolic and diastolic readings taken at the same moment.
const TILES = [
  { id: "weight", title: "Weight", metric: "weight" },
  { id: "body_fat", title: "Body fat", metric: "body_fat" },
  { id: "muscle_mass", title: "Muscle mass", metric: "muscle_mass" },
  { id: "bp", title: "Blood pressure", metric: "bp_systolic", pair: "bp_diastolic" },
  { id: "resting_hr", title: "Resting heart rate", metric: "resting_hr" },
  { id: "heart_rate", title: "Heart rate (day average)", metric: "heart_rate" },
  { id: "hrv", title: "HRV", metric: "hrv" },
  { id: "sleep", title: "Sleep", metric: "sleep_minutes" },
  { id: "steps", title: "Steps", metric: "steps" },
  { id: "spo2", title: "Blood oxygen", metric: "spo2" },
];

function fmt(metric, v) {
  if (v == null) return "";
  if (metric === "sleep_regularity") return Math.round(v) + " min";
  if (metric === "sleep_minutes") { const h = Math.floor(v / 60), m = Math.round(v - h * 60); return h + " h " + String(m).padStart(2, "0") + " min"; }
  const d = S.METRICS[metric] ? S.METRICS[metric].decimals : 1;
  const s = d === 0 ? Math.round(v).toLocaleString("en-US") : v.toFixed(d);
  const u = S.METRICS[metric] ? S.METRICS[metric].unit : "";
  return u === "steps" || u === "level" ? s : s + " " + u;
}
function fmtDelta(metric, abs) {
  if (abs == null) return "";
  const sign = abs > 0 ? "+" : abs < 0 ? "-" : "";
  const a = Math.abs(abs);
  if (metric === "sleep_minutes") { const h = Math.floor(a / 60), m = Math.round(a - h * 60); return sign + (h ? h + " h " : "") + String(m).padStart(2, "0") + " min"; }
  const d = S.METRICS[metric] ? S.METRICS[metric].decimals : 1;
  return sign + (d === 0 ? Math.round(a).toLocaleString("en-US") : a.toFixed(d));
}

const unitOf = (m) => (S.METRICS[m] ? S.METRICS[m].unit : m === "sleep_regularity" ? "min" : "");
const decOf = (m) => (S.METRICS[m] ? S.METRICS[m].decimals : 0);
function tileModel(def, byMetric, now) {
  const recs = byMetric[def.metric] || [];
  const { last, previous } = C.lastAndPrevious(recs);
  if (!last) return null;
  let valueText = fmt(def.metric, last.value), prevText = previous ? fmt(def.metric, previous.value) : "";
  if (def.pair) {
    const dia = (byMetric[def.pair] || []).find((r) => r.ts === last.ts);
    if (dia) valueText = Math.round(last.value) + "/" + Math.round(dia.value) + " mmHg";
    if (previous) { const pd = (byMetric[def.pair] || []).find((r) => r.ts === previous.ts); if (pd) prevText = Math.round(previous.value) + "/" + Math.round(pd.value) + " mmHg"; }
  }
  const ch = C.change(last, previous);
  const band = C.normalBand(recs.filter((r) => r.ts !== last.ts), { now });   // never includes the value being judged (review F12)
  const spark = C.lastN(recs, 14).map((r) => r.value);
  return {
    id: def.id, title: def.title, metric: def.metric,
    value: last.value, valueText, at: last.ts, source: last.source,
    previous: previous ? { value: previous.value, valueText: prevText, at: previous.ts, source: previous.source } : null,
    change: ch ? { dir: ch.dir, text: fmtDelta(def.metric, ch.abs), days: ch.days } : null,
    band: band ? { low: band.low, high: band.high, n: band.n, days: band.days, text: fmt(def.metric, band.low).replace(/ .*$/, "") + "-" + fmt(def.metric, band.high), position: C.position(last.value, band) } : null,
    spark, series: C.lastN(recs, 14).map((r) => ({ ts: r.ts, v: r.value, s: r.source })), unit: unitOf(def.metric), dec: decOf(def.metric), kind: def.metric === "sleep_minutes" ? "sleep" : "num",
    sparkBand: band ? { low: band.low, high: band.high } : null,
  };
}

function buildToday(measurements, now) {
  const byMetric = {};
  for (const m of measurements) (byMetric[m.metric] = byMetric[m.metric] || []).push(m);
  const tiles = [];
  for (const def of TILES) { const t = tileModel(def, byMetric, now); if (t) tiles.push(t); }
  return { tiles, hasData: tiles.length > 0 };
}

const SEVERITY = { "outside-lab": 0, "outside-optimal": 1, optimal: 2, "in-range": 3, "no-range": 4 };
function buildLabs(labs) {
  const byKey = new Map();
  for (const l of labs) { if (!byKey.has(l.key)) byKey.set(l.key, []); byKey.get(l.key).push(l); }
  const rows = [];
  for (const [key, recs] of byKey) {
    const { last, previous } = C.lastAndPrevious(recs);
    const hist = C.lastN(recs, 3);
    const nums = [last.value, last.refLow, last.refHigh, last.optLow, last.optHigh].filter((x) => x != null);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.15 || 1;
    const min = lo >= 0 ? Math.max(0, lo - pad) : lo - pad, max = hi + pad;
    rows.push({
      key, test: last.test, unit: last.unit, last: { value: last.value, ts: last.ts, source: last.source, fileId: last.fileId || null },
      refLow: last.refLow == null ? null : last.refLow, refHigh: last.refHigh == null ? null : last.refHigh,
      optLow: last.optLow == null ? null : last.optLow, optHigh: last.optHigh == null ? null : last.optHigh,
      status: C.labStatus(last), change: C.change(last, previous),
      history: hist.map((r) => ({ value: r.value, ts: r.ts, source: r.source })),
      scale: { min, max }, count: recs.length,
      series: C.lastN(recs, 24).map((r) => ({ ts: r.ts, v: r.value, s: r.source })), refBand: last.refLow != null && last.refHigh != null ? { low: last.refLow, high: last.refHigh, label: "lab range" } : null,
    });
  }
  rows.sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || a.test.localeCompare(b.test));
  return { rows, hasData: rows.length > 0 };
}

function buildMeds(meds, todayKey) {
  const active = [], stopped = [];
  for (const m of meds) {
    const row = { id: m.id, name: m.name, dose: m.dose, schedule: m.schedule, medKind: m.medKind, start: m.start, stop: m.stop, note: m.note || "" };
    (m.stop && m.stop <= todayKey ? stopped : active).push(row);
  }
  const order = ["morning", "noon", "afternoon", "evening", "night", "bedtime"];
  const rank = (s) => { const i = order.findIndex((o) => String(s).toLowerCase().indexOf(o) >= 0); return i < 0 ? 99 : i; };
  active.sort((a, b) => rank(a.schedule) - rank(b.schedule) || a.name.localeCompare(b.name));
  stopped.sort((a, b) => (a.stop < b.stop ? 1 : -1));
  return { active, stopped, hasData: active.length + stopped.length > 0 };
}

function buildSnapshot(store, now) {
  const when = now || Date.now();
  const todayKey = S.localIso(new Date(when)).slice(0, 10);
  const imports = store.listImports();
  return {
    ok: true, now: when, today: S.localIso(new Date(when)),
    metrics: Object.keys(S.METRICS).map((k) => ({ id: k, label: S.METRICS[k].label, unit: S.METRICS[k].unit })),
    todayView: buildToday(store.listMeasurements(), when),
    labsView: buildLabs(store.listLabs()),
    medsView: buildMeds(store.listMeds(), todayKey),
    counts: store.counts(),
    lastImport: imports.length ? { ts: imports[imports.length - 1].ts, format: imports[imports.length - 1].format } : null,
  };
}

module.exports = { TILES, unitOf, decOf, tileModel, fmt, fmtDelta, buildToday, buildLabs, buildMeds, buildSnapshot };
