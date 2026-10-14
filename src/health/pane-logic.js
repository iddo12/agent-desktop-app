// My Health visual pane (v1.114.0): PURE logic, no DOM, no fs. UMD: required by the main process (src/health/pane-feed.js, feed validation)
// and loaded as window.healthPaneLogic by the renderer (health-visual.js). Tested by tests/health-pane.test.js.
// The pane does no medical logic: statuses come from the feed (computed by the Health Agent against the person's OWN range). The few rules
// here (goal percentages, steps "Behind after 20:00", sleep 7-9 h, quadrant) are the ones the owner approved in the mockups.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.healthPaneLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SCHEMA_VERSION = 1;
  const STALE_HOURS = 30;                         // the feed is written 16:30 and 18:30 daily; a missed day is stale
  const MAX_FEED_BYTES = 2 * 1024 * 1024;
  const GOALS = { sleep_min: 480, steps: 10000, hard_min_week: 150 };   // the owner, 2026-10-11 (feed.goals may override)
  const EFFORT_HIGH_MIN = 30;                     // a "hard" day = at least 30 min in hard zones (mockup page 5)
  const KNOWN_METRICS = ["steps", "resting_hr", "avg_hr", "hrv", "skin_temp", "weight", "body_fat", "sleep_min", "spo2", "breathing", "active_kcal", "distance_km", "active_min", "exercise_min"];
  const GOAL_RANGE = { sleep_min: [240, 720], steps: [1000, 60000], hard_min_week: [10, 1000] };   // sane limits, else the default
  const STAGES = ["deep", "light", "rem", "awake"];                                                // the only ids ever used as a class name
  const STATUS_IDS = ["ok", "watch", "alert", "none"];

  // ---------------------------------------------------------------- tolerant coercion (a missing or odd block never throws)
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max || 120) : null);
  const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max || 400) : []);
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const pair = (v) => (Array.isArray(v) ? [num(v[0]), num(v[1])] : [null, null]);
  const dateStr = (v) => { const s = str(v, 12); return s && /^\d{4}-\d{2}(-\d{2})?$/.test(s) ? s : null; };

  function normMetric(m) {
    if (!isObj(m)) return null;
    const mo = isObj(m.month) ? { avg: num(m.month.avg), best: dateStr(m.month.best), worst: dateStr(m.month.worst), in_normal: str(m.month.in_normal, 20) } : null;
    return {
      now: num(m.now), prev: num(m.prev), unit: str(m.unit, 16) || "",
      status: STATUS_IDS.indexOf(m.status) >= 0 ? m.status : "none",
      normal: pair(m.normal), baseline: pair(m.baseline),
      last7: arr(m.last7, 7).map(num),
      last30: arr(m.last30, 31).map(num),                                   // optional (not produced yet): the month chart
      month: mo,
      years: arr(m.years, 40).map((y) => (isObj(y) ? { year: str(y.year, 6), avg: num(y.avg), n: num(y.n) } : null)).filter((y) => y && y.year),
      daily: arr(m.daily, 400).map((d) => (isObj(d) && dateStr(d.date) ? { date: dateStr(d.date), v: num(d.v) } : null)).filter(Boolean),   // optional: calendar
    };
  }
  function normSection(s) {   // the three slow sections share headline / last_updated / next_due
    return isObj(s) ? { last_updated: dateStr(s.last_updated), next_due: dateStr(s.next_due) } : null;
  }

  // The ONLY thing the renderer ever receives: this normalised copy (unknown keys dropped, types forced, arrays capped).
  function normalizeFeed(raw) {
    if (!isObj(raw)) return { ok: false, code: "invalid", reason: "The health feed is not readable." };
    const sv = num(raw.schema_version);
    if (sv == null || sv < 1) return { ok: false, code: "invalid", reason: "The health feed has no version." };
    if (sv > SCHEMA_VERSION) return { ok: false, code: "newer", reason: "The health feed is newer than this app understands. Update Agent Desktop." };
    const t = typeof raw.generated_at === "string" ? Date.parse(raw.generated_at) : NaN;
    if (!isFinite(t)) return { ok: false, code: "invalid", reason: "The health feed has no valid time." };
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(raw.generated_at.trim())) return { ok: false, code: "invalid", reason: "The health feed time has no time zone, so it cannot be trusted." };
    const f = { schema_version: sv, generated_at: raw.generated_at.slice(0, 40), day: dateStr(raw.day), note: str(raw.note, 200), metrics: {} };
    f.dates_last7 = arr(raw.dates_last7, 7).map(dateStr).filter(Boolean);
    if (isObj(raw.metrics)) KNOWN_METRICS.forEach((k) => { const m = normMetric(raw.metrics[k]); if (m) f.metrics[k] = m; });
    f.goals = { sleep_min: GOALS.sleep_min, steps: GOALS.steps, hard_min_week: GOALS.hard_min_week };
    if (isObj(raw.goals)) Object.keys(GOALS).forEach((k) => { const v = num(raw.goals[k]), r = GOAL_RANGE[k]; if (v != null && v >= r[0] && v <= r[1]) f.goals[k] = v; });
    if (isObj(raw.sleep)) {
      f.sleep = { min: num(raw.sleep.min), score: num(raw.sleep.score), prev_score: num(raw.sleep.prev_score),
        stages: Array.isArray(raw.sleep.stages) ? arr(raw.sleep.stages, 8).map((s) => (isObj(s) && STAGES.indexOf(s.stage) >= 0 ? { stage: s.stage, min: num(s.min) } : null)).filter(Boolean) : null,
        from: str(raw.sleep.from, 5), until: str(raw.sleep.until, 5) };
    } else f.sleep = null;
    if (isObj(raw.activity)) {
      const a = raw.activity;
      f.activity = { steps_median: num(a.steps_median), zone1_min: num(a.zone1_min), zone2_min: num(a.zone2_min), zone3_min: num(a.zone3_min),
        effort_min_last7: arr(a.effort_min_last7, 14).map(num), week_effort: num(a.week_effort), prev_week_effort: num(a.prev_week_effort),
        labels: arr(a.labels, 20).map((l) => (isObj(l) && str(l.name, 60) ? { name: str(l.name, 60), date: dateStr(l.date), start: str(l.start, 5), regular: !!l.regular, detected: str(l.detected, 8) } : null)).filter(Boolean) };
    } else f.activity = null;
    // day detail (optional, not produced yet): what the "Day story" view draws on an hour axis
    if (isObj(raw.day_detail)) {
      const d = raw.day_detail;
      f.day_detail = { date: dateStr(d.date),
        sleep_blocks: arr(d.sleep_blocks, 80).map((b) => (isObj(b) && STAGES.indexOf(b.stage) >= 0 ? { stage: b.stage, from: str(b.from, 5), to: str(b.to, 5) } : null)).filter((b) => b && b.from && b.to),
        hr_points: arr(d.hr_points, 96).map((p) => (isObj(p) && str(p.t, 5) && num(p.bpm) != null ? { t: str(p.t, 5), bpm: num(p.bpm) } : null)).filter(Boolean),
        steps_hourly: arr(d.steps_hourly, 24).map(num),
        exercise: arr(d.exercise, 10).map((e) => (isObj(e) && str(e.name, 40) ? { name: str(e.name, 40), start: str(e.start, 5), end: str(e.end, 5), kcal: num(e.kcal), max_hr: num(e.max_hr) } : null)).filter(Boolean) };
    } else f.day_detail = null;
    // slow sections
    const bt = isObj(raw.blood_tests) ? raw.blood_tests : null;
    f.blood_tests = bt ? Object.assign(normSection(bt), {
      headline: isObj(bt.headline) ? { markers: num(bt.headline.markers), out_of_range: num(bt.headline.out_of_range) } : null,
      markers: arr(bt.markers, 80).map((m) => (isObj(m) && str(m.marker, 60) ? { marker: str(m.marker, 60), unit: str(m.unit, 20) || "",
        latest: isObj(m.latest) ? { date: dateStr(m.latest.date), value: num(m.latest.value) } : null,
        previous: isObj(m.previous) ? { date: dateStr(m.previous.date), value: num(m.previous.value) } : null,
        range: pair(m.range), in_range: ["in", "out", "none"].indexOf(m.in_range) >= 0 ? m.in_range : "none",
        trend: ["up", "down", "flat"].indexOf(m.trend) >= 0 ? m.trend : null,
        series: arr(m.series, 40).map((p) => (isObj(p) && num(p.value) != null ? { date: dateStr(p.date), value: num(p.value) } : null)).filter(Boolean) } : null)).filter((m) => m && m.latest) }) : null;
    const nu = isObj(raw.nutrition) ? raw.nutrition : null;
    f.nutrition = nu ? Object.assign(normSection(nu), {
      headline: isObj(nu.headline) ? { days_logged_14d: num(nu.headline.days_logged_14d) } : null,
      days: arr(nu.days, 31).map((d) => (isObj(d) && dateStr(d.date) ? { date: dateStr(d.date), entries: num(d.entries), usual: d.usual === true, fasting: d.fasting === true, photos: num(d.photos),
        slots: Array.isArray(d.slots) ? arr(d.slots, 12).map((s) => str(s, 24)).filter(Boolean) : null } : null)).filter(Boolean).sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0)),   // newest first whatever order the generator wrote
      weekly_highlights: arr(nu.weekly_highlights, 8).map((s) => str(s, 200)).filter(Boolean) }) : null;
    const cg = isObj(raw.cognitive) ? raw.cognitive : null;
    f.cognitive = cg ? Object.assign(normSection(cg), {
      headline: isObj(cg.headline) ? { last_score: num(cg.headline.last_score), test: str(cg.headline.test, 60) } : null,
      series: arr(cg.series, 60).map((p) => (isObj(p) && num(p.score) != null ? { date: dateStr(p.date), test: str(p.test, 60), score: num(p.score) } : null)).filter(Boolean) }) : null;
    f.sources = arr(raw.sources, 10).map((s) => (isObj(s) && str(s.id, 24) ? { id: str(s.id, 24), last_sync: num(s.last_sync) } : null)).filter(Boolean);
    return { ok: true, feed: f };
  }

  // ---------------------------------------------------------------- stale / sync
  function staleInfo(generatedAt, now, staleHours) {
    const t = Date.parse(generatedAt);
    if (!isFinite(t) || !isFinite(now)) return { stale: true, ageMs: null, text: "a long time ago" };
    if (t > now + 10 * 60000) return { stale: true, future: true, ageMs: null, text: "dated in the future" };   // a clock or feed error must never look fresh
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(String(generatedAt).trim())) return { stale: true, ageMs: null, text: "of unknown time (no time zone)" };
    const ageMs = Math.max(0, now - t), h = ageMs / 3600000, lim = staleHours || STALE_HOURS;
    const text = h < 1 ? "less than an hour ago" : h < 48 ? Math.floor(h) + (Math.floor(h) === 1 ? " hour ago" : " hours ago") : Math.floor(h / 24) + " days ago";
    return { stale: h > lim, ageMs, hours: h, text };
  }
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (n) => (n < 10 ? "0" : "") + n;
  const ymd = (d) => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
  function parseDay(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function dayLabel(s, withWd) { const d = parseDay(s); return d ? (withWd === false ? "" : WD[d.getDay()] + " ") + d.getDate() + " " + MON[d.getMonth()] : ""; }
  function syncText(generatedAt, now) {
    const t = new Date(generatedAt), n = new Date(now);
    if (isNaN(t.getTime())) return "Not synced yet";
    const hm = p2(t.getHours()) + ":" + p2(t.getMinutes());
    if (ymd(t) === ymd(n)) return "Synced " + hm + " today";
    const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
    if (ymd(t) === ymd(y)) return "Synced " + hm + " yesterday";
    return "Synced " + dayLabel(ymd(t)) + " " + hm;
  }

  // ---------------------------------------------------------------- numbers
  const fmtInt = (n) => (n == null ? "" : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
  function fmtNum(n, dec) {
    if (n == null || !isFinite(n)) return "";
    const d = dec || 0, s = Math.abs(n).toFixed(d);
    const parts = s.split("."); parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (n < 0 ? "−" : "") + parts.join(".");
  }
  const fmtDur = (min) => { if (min == null) return ""; const m = Math.round(min); return Math.floor(m / 60) + "h " + p2(m % 60); };
  const fmtDurShort = (min) => { if (min == null) return ""; const m = Math.round(min); return m < 60 ? m + " min" : m % 60 === 0 ? m / 60 + " h" : Math.floor(m / 60) + " h " + (m % 60) + " min"; };
  const fmtDurLong = (min) => { if (min == null) return ""; const m = Math.round(min); return Math.floor(m / 60) + " h " + (m % 60) + " min"; };

  // How wide a bold number is, in em. Conservative (digits 0.62em, separators 0.32em): used BEFORE layout, then checked by measuring.
  function emWidth(text) {
    let w = 0; String(text).split("").forEach((c) => { w += /[0-9]/.test(c) ? 0.62 : /[,.:  ]/.test(c) ? 0.32 : 0.66; }); return w;
  }
  // Largest font size (px, <= maxFont) at which `text` (plus a `labelPx`-high caption under it) sits inside the ring's inner circle.
  // The top corners of the number block are the points that reach furthest from the centre, so the allowed width is a chord:
  //   width <= 2 * sqrt(R^2 - (blockHeight / 2)^2) - margin, blockHeight = font + labelPx.
  function ringFit(text, diameter, stroke, opts) {
    const o = opts || {}, maxFont = o.maxFont || 52, minFont = o.minFont || 12, labelPx = o.labelPx == null ? 18 : o.labelPx, margin = o.margin == null ? 6 : o.margin;
    const R = Math.max(1, (diameter - 2 * stroke) / 2 - (o.pad == null ? 4 : o.pad)), em = emWidth(text);
    for (let fs = maxFont; fs >= minFont; fs--) {
      const h = fs + labelPx, half = R * R - (h / 2) * (h / 2);
      if (half <= 0) continue;
      if (em * fs <= 2 * Math.sqrt(half) - margin) return { fontPx: fs, widthPx: Math.round(em * fs), fits: true };
    }
    return { fontPx: minFont, widthPx: Math.round(em * minFont), fits: false };
  }
  function goalPct(value, goal) {
    if (value == null || !(goal > 0)) return { frac: 0, pct: null, over: false };
    const r = value / goal; return { frac: Math.max(0, Math.min(1, r)), pct: Math.round(r * 100), over: r > 1 };
  }

  // ---------------------------------------------------------------- comparison lines ("every number needs a comparison")
  const WORDS = { steps: ["more", "fewer"], active_kcal: ["more", "less"], distance_km: ["more", "less"], active_min: ["more", "less"], exercise_min: ["more", "less"] };
  const DEC = { skin_temp: 1, weight: 1, body_fat: 1, breathing: 1, distance_km: 1 };
  const decOf = (key) => DEC[key] || 0;
  function compare(key, now, prev, noun) {
    const dec = decOf(key), w = WORDS[key] || ["higher", "lower"], when = noun || "yesterday";
    if (now == null) return { dir: null, text: "" };
    if (prev == null) return { dir: null, text: "no earlier value to compare" };
    const diff = Math.round((now - prev) * Math.pow(10, dec)) / Math.pow(10, dec);
    if (diff === 0) return { dir: "same", text: "same as " + when + " (" + fmtNum(prev, dec) + ")" };
    return { dir: diff > 0 ? "up" : "down", text: fmtNum(Math.abs(diff), dec) + " " + (diff > 0 ? w[0] : w[1]) + " than " + when + " (" + fmtNum(prev, dec) + ")" };
  }

  // ---------------------------------------------------------------- status chips: glyph + word + colour class, never colour alone
  const CHIPS = { good: ["✓", "Good", "ok"], watch: ["▲", "Watch", "warn"], alert: ["✕", "Alert", "bad"], nodata: ["–", "No data", "none"],
    behind: ["▲", "Behind", "warn"], sofar: ["…", "So far", "info"], info: ["i", "Info", "info"], hard: ["✓", "Hard day", "ok"], over: ["✓", "Over target", "ok"], on: ["✓", "On target", "ok"], under: ["▲", "Below target", "warn"] };
  const chip = (id) => ({ id, glyph: CHIPS[id][0], word: CHIPS[id][1], cls: CHIPS[id][2] });
  function localHour(now) { return new Date(now).getHours(); }
  // ctx: {now (ms), day ("YYYY-MM-DD" of the feed), goals}
  function statusOf(key, m, ctx) {
    const c = ctx || {}, goals = c.goals || GOALS;
    if (!m || m.now == null) return chip("nodata");
    if (m.status === "alert") return chip("alert");
    if (key === "steps") {
      if (m.now >= goals.steps) return chip("good");
      const today = c.now != null && c.day && ymd(new Date(c.now)) === c.day;
      return today && localHour(c.now) < 20 ? chip("sofar") : chip("behind");     // "status only turns Behind after 20:00" (mockup page 7)
    }
    if (key === "sleep_min") return m.now >= 420 && m.now <= 540 ? chip("good") : chip("watch");       // "Good if 7-9 h"
    if (key === "body_fat") return m.prev != null && m.now > m.prev ? chip("watch") : chip("good");   // "Watch if rising"
    if (m.status === "watch") return chip("watch");
    if (m.status === "ok") return chip("good");
    return chip("info");
  }

  // ---------------------------------------------------------------- activity level: movement x effort
  // Two separate measures per day. effort = minutes in hard heart-rate zones. Dividers: the person's usual steps, 30 hard minutes.
  function classifyActivity(steps, effort, stepsUsual, effortHigh) {
    if (steps == null || effort == null) return null;
    const hiE = effort >= (effortHigh == null ? EFFORT_HIGH_MIN : effortHigh), hiS = steps >= (stepsUsual == null ? 9000 : stepsUsual);
    return hiE ? (hiS ? "high-high" : "high-effort-low-steps") : (hiS ? "easy-walking" : "quiet");
  }
  const QUADRANT_LABEL = { "high-effort-low-steps": "High effort, low steps", "high-high": "High effort, high steps", "quiet": "Quiet day", "easy-walking": "Easy walking day" };
  function weekChip(week, goal) { if (week == null) return chip("nodata"); return week > goal ? chip("over") : week === goal ? chip("on") : chip("under"); }
  // The seven-day points for the grid: only days that have BOTH numbers (a missing day is a dashed circle elsewhere, never a 0).
  function activityPoints(feed) {
    const dates = feed.dates_last7 || [], st = feed.metrics.steps ? feed.metrics.steps.last7 : [], ef = feed.activity ? feed.activity.effort_min_last7 : [];
    const usual = feed.activity && feed.activity.steps_median != null ? feed.activity.steps_median : 9000;
    const off = ef.length - dates.length;           // effort_min_last7 covers the same last days; align from the end
    return dates.map((d, i) => { const s = st[i - (dates.length - st.length)] == null ? null : st[i - (dates.length - st.length)], e = ef[i + off] == null ? null : ef[i + off];
      return { date: d, steps: s, effort: e, quadrant: classifyActivity(s, e, usual), today: i === dates.length - 1 }; });
  }

  // ---------------------------------------------------------------- bars (7 days): heights, which ones carry a number label
  function bars(values, opts) {
    const o = opts || {}, v = values.map(num), real = v.filter((x) => x != null);
    if (!real.length) return v.map(() => ({ v: null, h: 0, label: false, today: false }));
    const max = Math.max.apply(null, real), min = Math.min.apply(null, real), base = o.zeroBased ? 0 : Math.min(min, 0), top = max === base ? base + 1 : max;
    const todayIdx = v.length - 1;
    return v.map((x, i) => ({ v: x, h: x == null ? 0 : Math.max(6, Math.round(((x - base) / (top - base)) * 100)), label: x != null && (x === max || x === min || i === todayIdx), today: i === todayIdx }));
  }
  const wdShort = (s) => { const d = parseDay(s); return d ? WD[d.getDay()].slice(0, 2) : ""; };

  // ---------------------------------------------------------------- slow sections ("Periodic")
  function monthIndex(s) { const m = /^(\d{4})-(\d{2})/.exec(s || ""); return m ? +m[1] * 12 + (+m[2] - 1) : null; }
  function dueState(nextDue, now) {
    if (!nextDue) return { id: "none", text: "No date set" };
    const n = new Date(now), cur = n.getFullYear() * 12 + n.getMonth(), due = monthIndex(nextDue);
    if (due == null) return { id: "none", text: "No date set" };
    const full = /^\d{4}-\d{2}-\d{2}$/.test(nextDue);
    if (full) { const dd = parseDay(nextDue), days = Math.round((dd - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000); if (days < 0) return { id: "overdue", text: "Overdue by " + (-days) + (days === -1 ? " day" : " days") }; if (days <= 30) return { id: "soon", text: days === 0 ? "Due today" : "Due in " + days + (days === 1 ? " day" : " days") }; }
    const d = due - cur;
    if (d < 0) return { id: "overdue", text: "Overdue by " + (-d) + (d === -1 ? " month" : " months") };
    if (d <= 1) return { id: "soon", text: d === 0 ? "Due this month" : "Due next month" };
    return { id: "ok", text: "Due in " + d + " months" };
  }
  function whenText(s) { if (!s) return "never"; if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dayLabel(s, false) + " " + s.slice(0, 4); const m = /^(\d{4})-(\d{2})$/.exec(s); return m ? MON[+m[2] - 1] + " " + m[1] : s; }
  // blood tests: out-of-range markers first, then A to Z
  function bloodOrder(markers) { return (markers || []).slice().sort((a, b) => (b.in_range === "out") - (a.in_range === "out") || a.marker.localeCompare(b.marker)); }
  const TREND_GLYPH = { up: "▲", down: "▼", flat: "=" };
  function nutritionWeek(days) {   // how many of the last 7 logged days had entries
    const d = (days || []).slice(0, 7); return { logged: d.filter((x) => (x.entries || 0) > 0).length, of: Math.min(7, Math.max(d.length, 0)) };
  }

  return { SCHEMA_VERSION, STALE_HOURS, MAX_FEED_BYTES, GOALS, EFFORT_HIGH_MIN, KNOWN_METRICS, normalizeFeed, staleInfo, syncText, fmtInt, fmtNum, fmtDur, fmtDurShort, fmtDurLong, emWidth, ringFit, goalPct,
    compare, decOf, chip, statusOf, classifyActivity, QUADRANT_LABEL, weekChip, activityPoints, bars, wdShort, dayLabel, parseDay, dueState, whenText, bloodOrder, TREND_GLYPH, nutritionWeek, ymd };
});
