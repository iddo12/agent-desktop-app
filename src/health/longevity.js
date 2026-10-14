// My Health stage 1b: the longevity dashboard model (biological age dial + tiles) and the weekly code-computed stats. Pure.
"use strict";
const S = require("./schema");
const C = require("./compare");
const VM = require("./view-model");
const PA = require("./phenoage");
const RT = require("./routines");

const DAY = 86400000;
const LONGEVITY_TILES = [
  { id: "grip", title: "Grip strength", metric: "grip_strength" },
  { id: "vo2max", title: "VO2max", metric: "vo2max" },
  { id: "resting_hr", title: "Resting heart rate", metric: "resting_hr" },
  { id: "hrv", title: "HRV", metric: "hrv" },
  { id: "sleep_regularity", title: "Sleep regularity", metric: "sleep_regularity", note: "spread of sleep length over 7 nights, lower is steadier" },
  { id: "weight", title: "Weight", metric: "weight" },
  { id: "body_fat", title: "Body fat", metric: "body_fat" },
];

// Rolling 7-night standard deviation of sleep length (minutes): a duration-based regularity measure. A bedtime-based one needs bedtime
// data, which stage 1 does not collect.
function sleepRegularity(sleepRecs) {
  const a = C.lastN(sleepRecs, 400), out = [];
  for (let i = 6; i < a.length; i++) {
    const w = a.slice(i - 6, i + 1).map((r) => r.value), m = w.reduce((x, y) => x + y, 0) / w.length;
    out.push({ ts: a[i].ts, value: Math.sqrt(w.reduce((x, y) => x + (y - m) * (y - m), 0) / w.length), source: "computed" });
  }
  return out;
}

function buildLongevity(measurements, labs, birthYM, now) {
  const by = {};
  for (const m of measurements) (by[m.metric] = by[m.metric] || []).push(m);
  by.sleep_regularity = sleepRegularity(by.sleep_minutes || []);
  const tiles = [];
  for (const def of LONGEVITY_TILES) { const t = VM.tileModel(def, by, now); if (t) { if (def.note) t.note = def.note; tiles.push(t); } else tiles.push({ id: def.id, title: def.title, empty: true, hint: def.metric === "sleep_regularity" ? "needs 7 nights of sleep" : "no reading yet: add one on Today" }); }
  return { bio: PA.buildBioAge(labs, birthYM), tiles, birthKnown: !!PA.ageAt(birthYM, "2000-01-01") };
}

// ---------------------------------------------------------------- weekly
function pad(n) { return String(n).padStart(2, "0"); }
const ymd = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
function isoWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate()); const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3);
  const y = d.getFullYear(), jan4 = new Date(y, 0, 4), wk = 1 + Math.round(((d - jan4) / DAY - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return y + "-W" + pad(wk);
}
function weekRange(week) {
  const m = /^(\d{4})-W(\d{2})$/.exec(week); if (!m) return null;
  const jan4 = new Date(+m[1], 0, 4), mon = new Date(jan4.getFullYear(), 0, 4 - ((jan4.getDay() + 6) % 7) + (+m[2] - 1) * 7);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  return { start: ymd(mon), end: ymd(sun) };
}
function prevWeek(week) { const r = weekRange(week); const d = new Date(r.start + "T12:00:00"); d.setDate(d.getDate() - 7); return isoWeek(d); }
const WEEK_METRICS = ["weight", "body_fat", "resting_hr", "hrv", "sleep_minutes", "steps", "bp_systolic", "spo2", "vo2max", "grip_strength"];

function weekStats(week, measurements, routineState, experiments) {
  const r = weekRange(week), pr = weekRange(prevWeek(week)); if (!r) return null;
  const inR = (rec, range) => rec.ts.slice(0, 10) >= range.start && rec.ts.slice(0, 10) <= range.end;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y.value, 0) / a.length : null);
  const rows = [];
  for (const m of WEEK_METRICS) {
    const recs = measurements.filter((x) => x.metric === m), cur = recs.filter((x) => inR(x, r)), prev = recs.filter((x) => inR(x, pr));
    if (!cur.length && !prev.length) continue;
    const a = mean(cur), b = mean(prev), ch = a != null && b != null ? C.change({ ts: r.end, value: a }, { ts: pr.end, value: b }) : null;
    const total = m === "steps" ? cur.reduce((x, y) => x + y.value, 0) : null;
    rows.push({ metric: m, label: S.METRICS[m].label, cur: a == null ? "" : VM.fmt(m, a), prev: b == null ? "" : VM.fmt(m, b), n: cur.length, nPrev: prev.length,
      series: recs.filter((x) => inR(x, r) || inR(x, pr)).map((x) => ({ ts: x.ts, v: x.value, s: x.source })), unit: S.METRICS[m].unit, dec: S.METRICS[m].decimals, kind: m === "sleep_minutes" ? "sleep" : "num", startTs: r.start,
      change: ch ? { dir: ch.dir, text: VM.fmtDelta(m, ch.abs) } : null, total: total == null ? null : Math.round(total).toLocaleString("en-US") });
  }
  const routines = (routineState && routineState.items ? routineState.items : []).map((it) => {
    let chunks = 0, days = 0; for (let k = r.start, i = 0; k <= r.end && i < 8; k = RT.addDays(k, 1), i++) { const e = it.log[k]; if (e) { chunks += e.done; if (e.done >= it.perDay) days++; } }
    return { title: it.title, chunks, target: it.perDay * 7, daysMet: days };
  });
  const exp = { running: 0, kept: 0, dropped: 0 }; for (const e of experiments || []) if (exp[e.status] != null) exp[e.status]++;
  return { week, start: r.start, end: r.end, rows, routines, experiments: exp };
}

module.exports = { LONGEVITY_TILES, buildLongevity, sleepRegularity, isoWeek, weekRange, prevWeek, weekStats };
