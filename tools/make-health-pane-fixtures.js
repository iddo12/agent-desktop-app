// Writes the SYNTHETIC My Health pane feeds used by tests and the sandbox (every number here is invented; no vault file is read).
//   node tools/make-health-pane-fixtures.js   ->  tests/fixtures/health_pane.sample.json (+ health_pane_variants/*.json)
// Shape = what the Health Agent's generator (Health Agent\tools\build_pane_feed.py) writes, plus the OPTIONAL blocks the pane can draw
// once the generator adds them (goals, day_detail, extra metrics, last30, daily); see the report for the differences.
"use strict";
const fs = require("fs");
const path = require("path");
const outDir = path.join(__dirname, "..", "tests", "fixtures");
const dates = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
const m = (now, unit, prev, status, normal, baseline, last7, month, years, extra) => Object.assign({ now, unit, prev, status, normal, baseline, last7, month, years }, extra || {});
const yrs = (a) => a.map((v, i) => ({ year: String(2020 + i), avg: v, n: 300 }));
const last30 = (base, amp) => Array.from({ length: 30 }, (_, i) => Math.round((base + Math.sin(i * 1.3) * amp + (i % 4)) * 10) / 10);
const daily = () => { const a = []; const d0 = new Date(2025, 9, 12); for (let i = 0; i < 365; i++) { const d = new Date(d0.getTime() + i * 86400000); const v = i % 23 === 7 ? null : 4000 + ((i * 937) % 9000); a.push({ date: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"), v }); } return a; };

function sample() {
  return {
    _comment: "SYNTHETIC numbers only (invented). Real file: vault pane_feed health_pane.json. Missing = null, never 0.",
    schema_version: 1, generated_at: "2026-10-11T16:30:00+03:00", day: "2026-10-11", dates_last7: dates,
    note: "status = vs own last 28 days (mean+/-2SD); synthetic",
    goals: { sleep_min: 480, steps: 10000, hard_min_week: 150 },
    metrics: {
      steps: m(8430, "steps", 9550, "ok", [null, null], [4000, 14000], [9100, 10400, 9550, 6200, 11800, 5400, 8430], { avg: 8700, best: "2026-10-09", worst: "2026-10-10", in_normal: null }, yrs([7200, 7900, 8400, 8100, 8600, 8700]), { daily: daily() }),
      resting_hr: m(58, "bpm", 60, "ok", [50, 65], [50, 65], [61, 60, 62, 59, 60, 60, 58], { avg: 60, best: "2026-09-20", worst: "2026-09-08", in_normal: "29/30" }, yrs([61, 63, 62, 60, 61, 59]), { last30: last30(60, 2) }),
      avg_hr: m(71, "bpm", 70, "ok", [null, null], [60, 80], [70, 72, 69, 71, 73, 70, 71], null, []),
      hrv: m(46, "ms", 42, "ok", [null, null], [38, 52], [40, 39, 47, 44, 45, 42, 46], { avg: 43, best: "2026-10-03", worst: "2026-09-14", in_normal: null }, yrs([40, 41, 44, 43, 42, 43])),
      skin_temp: m(-0.3, "C", -0.1, "ok", [null, null], [-1, 1], [0.1, 0, 0, 0.2, 0, 0, -0.3], null, []),
      weight: m(78.4, "kg", 78.6, "ok", [null, null], [77, 80], [78.9, 78.8, 78.7, 78.6, 78.5, 78.6, 78.4], { avg: 78.7, best: "2026-10-11", worst: "2026-09-21", in_normal: null }, yrs([80, 79.5, 79, 78.9, 78.7, 78.5])),
      body_fat: m(18.6, "%", 18.2, "watch", [null, null], [17, 19], [18.1, 18.1, 18.2, 18.2, 18.3, 18.3, 18.6], null, []),
      sleep_min: m(432, "min", 414, "ok", [null, null], [380, 500], [426, 444, 354, 420, 408, 414, 432], { avg: 420, best: "2026-10-06", worst: "2026-10-07", in_normal: null }, yrs([400, 410, 415, 420, 418, 420])),
      spo2: m(96, "%", 96, "ok", [null, null], [94, 98], [97, 96, 95, 96, 96, 96, 96], null, []),
      breathing: m(14.8, "per min", 15.1, "ok", [null, null], [13.5, 16.5], [14.6, 15, 15.3, 14.9, 15, 15.1, 14.8], null, []),
      active_kcal: m(540, "kcal", 420, "ok", [null, null], [200, 800], [610, 300, 480, 520, 450, 420, 540], null, []),
      distance_km: m(6.1, "km", 6.9, "ok", [null, null], [3, 10], [8.5, 3.9, 6.5, 7, 7.2, 6.9, 6.1], null, []),
      active_min: m(47, "min", 35, "ok", [null, null], [20, 70], [62, 25, 40, 44, 52, 35, 47], null, []),
      exercise_min: m(52, "min", null, "ok", [null, null], [0, 90], [0, 60, null, 45, 0, null, 52], null, []),
    },
    sleep: { min: 432, score: 82, prev_score: 77, from: "23:10", until: "06:25", stages: [{ stage: "deep", min: 84 }, { stage: "rem", min: 100 }, { stage: "light", min: 232 }, { stage: "awake", min: 16 }] },
    activity: { steps_median: 9000, zone1_min: 31, zone2_min: 21, zone3_min: 56, effort_min_last7: [12, 35, 0, 40, 22, 15, 77], week_effort: 201, prev_week_effort: 160,
      labels: [{ name: "Table tennis", date: "2026-10-11", start: "15:00", regular: true, detected: "15:04" }, { name: "Table tennis", date: "2026-10-07", start: "20:30", regular: true, detected: null }] },
    day_detail: { date: "2026-10-11",
      sleep_blocks: [["light", "23:10", "00:00"], ["deep", "00:00", "00:50"], ["light", "00:50", "02:00"], ["rem", "02:00", "02:40"], ["light", "02:40", "04:10"], ["deep", "04:10", "04:50"], ["rem", "04:50", "06:25"]].map((b) => ({ stage: b[0], from: b[1], to: b[2] })),
      hr_points: [["00:30", 52], ["02:00", 50], ["03:30", 49], ["05:00", 53], ["06:30", 58], ["08:00", 66], ["09:30", 72], ["11:00", 68], ["12:30", 70], ["14:00", 66], ["15:00", 118], ["16:00", 142]].map((p) => ({ t: p[0], bpm: p[1] })),
      steps_hourly: [0, 0, 0, 0, 0, 0, 40, 620, 1480, 380, 210, 540, 310, 1100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      exercise: [{ name: "Strength", start: "15:00", end: "15:52", kcal: 310, max_hr: 142 }] },
    blood_tests: { headline: { markers: 4, out_of_range: 1 }, last_updated: "2026-05", next_due: "2026-11",
      markers: [
        { marker: "LDL cholesterol", unit: "mg/dL", latest: { date: "2026-05", value: 128 }, previous: { date: "2025-11", value: 118 }, range: [null, 116], in_range: "out", trend: "up", series: [{ date: "2024-11", value: 110 }, { date: "2025-11", value: 118 }, { date: "2026-05", value: 128 }] },
        { marker: "Vitamin D", unit: "ng/mL", latest: { date: "2026-05", value: 38 }, previous: { date: "2025-11", value: 31 }, range: [30, 100], in_range: "in", trend: "up", series: [{ date: "2025-11", value: 31 }, { date: "2026-05", value: 38 }] },
        { marker: "HbA1c", unit: "%", latest: { date: "2026-05", value: 5.2 }, previous: { date: "2025-11", value: 5.2 }, range: [null, 5.7], in_range: "in", trend: "flat", series: [{ date: "2025-11", value: 5.2 }, { date: "2026-05", value: 5.2 }] },
        { marker: "Ferritin", unit: "ng/mL", latest: { date: "2026-05", value: 96 }, previous: null, range: [null, null], in_range: "none", trend: null, series: [{ date: "2026-05", value: 96 }] }] },
    nutrition: { headline: { days_logged_14d: 9 }, last_updated: "2026-10-10", next_due: null,
      days: [{ date: "2026-10-10", entries: 4, usual: false, fasting: false, photos: 3, slots: ["breakfast", "lunch", "dinner"] }, { date: "2026-10-09", entries: 2, usual: true, fasting: false, photos: 0, slots: ["lunch"] },
        { date: "2026-10-08", entries: 0, usual: false, fasting: true, photos: 0, slots: [] }, { date: "2026-10-07", entries: 3, usual: false, fasting: false, photos: 2, slots: ["breakfast", "dinner"] }],
      weekly_highlights: ["Protein about 62 g on logged days (previous week 51 g)", "One fasting day"] },
    cognitive: { headline: { last_score: 104, test: "Reaction time (synthetic)" }, last_updated: "2026-09-15", next_due: "2026-12-15",
      series: [{ date: "2025-09-15", test: "Reaction time (synthetic)", score: 96 }, { date: "2026-03-15", test: "Reaction time (synthetic)", score: 100 }, { date: "2026-09-15", test: "Reaction time (synthetic)", score: 104 }] },
    sources: [{ id: "fitbit", last_sync: 1760189400 }, { id: "renpho", last_sync: 1760103000 }],
  };
}
// month charts need last30 for a metric that has none in the generator: give steps one too
const s = sample(); s.metrics.steps.last30 = last30(8700, 1800); s.metrics.hrv.last30 = last30(44, 3);

function write(name, obj) { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, JSON.stringify(obj, null, 1) + "\n"); }
write(path.join(outDir, "health_pane.sample.json"), s);
const v = path.join(outDir, "health_pane_variants");
// 5-digit steps (ring fit) and a 5-digit sleep-free minimal-width test
const five = sample(); five.metrics.steps.now = 12430; five.metrics.steps.prev = 11980; five.metrics.steps.last7[6] = 12430; write(path.join(v, "five_digit_steps.json"), five);
const six = sample(); six.metrics.steps.now = 98765; six.metrics.steps.prev = 99999; six.metrics.steps.last7[6] = 98765; write(path.join(v, "max_digit_steps.json"), six);
const stale = sample(); stale.generated_at = "2026-10-08T16:30:00+03:00"; stale.day = "2026-10-08"; write(path.join(v, "stale.json"), stale);
// only the generator's own keys, several blocks missing: tolerant drawing
const min = { schema_version: 1, generated_at: "2026-10-11T16:30:00+03:00", day: "2026-10-11", dates_last7: dates, metrics: { steps: s.metrics.steps, resting_hr: s.metrics.resting_hr, hrv: { now: null, unit: "ms", prev: null, status: "none", normal: [null, null], baseline: [null, null], last7: [], month: null, years: [] } }, sleep: { min: null, score: null, stages: null } };
write(path.join(v, "minimal.json"), min);
write(path.join(v, "newer.json"), Object.assign({}, min, { schema_version: 2 }));
console.log("fixtures written to", outDir);
