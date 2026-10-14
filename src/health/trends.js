// My Health stage 1 (scope extension): trends, the "worth attention" list and the experiment before/after, all by SIMPLE CODE RULES
// (no model). Wording is neutral: it states what the numbers did, never what to do about it. Pure functions.
"use strict";
const S = require("./schema");
const C = require("./compare");
const VM = require("./view-model");

const DAY = 86400000;
const tms = (ts) => new Date(ts).getTime();
const pct = (a, b) => (b ? ((a - b) / Math.abs(b)) * 100 : 0);

// Series per marker: measurements by metric, labs by key. Daily-ish values only; same-timestamp duplicates collapse.
function series(measurements, labs) {
  const out = new Map();
  const put = (id, kind, label, unit, rec, extra) => { if (!out.has(id)) out.set(id, Object.assign({ id, kind, label, unit, recs: [] }, extra || {})); out.get(id).recs.push(rec); };
  for (const m of measurements) put(m.metric, "metric", S.METRICS[m.metric].label, S.METRICS[m.metric].unit, m);
  for (const l of labs) put(l.key, "lab", l.test, l.unit, l);
  return out;
}

// Rules. Each returns {id, rule, rank, text} or null. rank: lower = sooner in the list.
function attention(s, now) {
  const items = [];
  const recs = C.lastN(s.recs, 400);
  const last = recs[recs.length - 1]; if (!last) return items;
  const fmtV = (v) => VM.fmt(s.kind === "metric" ? s.id : "", v) || String(Math.round(v * 100) / 100);
  const val = (v) => (s.kind === "metric" ? VM.fmt(s.id, v) : String(Math.round(v * 100) / 100) + (s.unit ? " " + s.unit : ""));
  // sustained drift: the last N readings keep going the same way
  const need = s.kind === "lab" ? 3 : 5;
  if (recs.length >= need) {
    const tail = recs.slice(-need); let up = true, down = true;
    for (let i = 1; i < tail.length; i++) { if (!(tail[i].value > tail[i - 1].value)) up = false; if (!(tail[i].value < tail[i - 1].value)) down = false; }
    const net = Math.abs(pct(tail[tail.length - 1].value, tail[0].value));
    if ((up || down) && net >= (s.kind === "lab" ? 10 : 2)) items.push({ id: s.id, rule: "drift", rank: 1, text: s.label + " has gone " + (up ? "up" : "down") + " in each of the last " + need + " readings (" + val(tail[0].value) + " to " + val(tail[tail.length - 1].value) + ")." });
  }
  if (s.kind === "metric") {
    // outside your own normal band three readings running, same side
    const band = C.normalBand(recs.slice(0, -3), { now: tms(recs[recs.length - 3] ? recs[recs.length - 3].ts : last.ts) });
    if (band && recs.length >= 3) {
      const t3 = recs.slice(-3).map((r) => C.position(r.value, band));
      if (t3.every((p) => p === "above") || t3.every((p) => p === "below")) items.push({ id: s.id, rule: "outside-normal", rank: 1, text: s.label + " has been " + t3[0] + " your own normal range (" + val(band.low) + " to " + val(band.high) + ") for the last 3 readings." });
    }
    // gone quiet: it was recorded regularly, then nothing for 14+ days
    const age = Math.floor((now - tms(last.ts)) / DAY);
    const before = recs.filter((r) => tms(r.ts) >= tms(last.ts) - 60 * DAY).length;
    if (age >= 14 && before >= 5) items.push({ id: s.id, rule: "stale", rank: 3, text: "No " + s.label.toLowerCase() + " reading for " + age + " days (it was recorded regularly before)." });
  } else {
    const st = C.labStatus(last);
    if (st === "outside-lab") items.push({ id: s.id, rule: "lab-outside-range", rank: 0, text: s.label + " (" + val(last.value) + ") is outside the lab's own range" + (C.lastAndPrevious(recs).previous ? ", previous " + val(C.lastAndPrevious(recs).previous.value) : "") + "." });
    else if (st === "outside-optimal") items.push({ id: s.id, rule: "lab-outside-optimal", rank: 2, text: s.label + " (" + val(last.value) + ") is inside the lab range but outside the optimal zone you entered." });
  }
  return items;
}

// where the newest value sits: "above" / "below" / "inside" (your own normal band for a metric, the lab range for a lab), or "none" when there is nothing to compare with
function posOf(s, last, band) {
  if (s.kind === "lab") { if (last.refLow != null && last.value < last.refLow) return "below"; if (last.refHigh != null && last.value > last.refHigh) return "above"; return last.refLow != null || last.refHigh != null ? "inside" : "none"; }
  return band ? (C.position(last.value, band) === "within" ? "inside" : C.position(last.value, band)) : "none";
}
function normalOf(s, last, band, V) {
  if (s.kind === "lab") return last.refLow != null && last.refHigh != null ? "lab range " + last.refLow + "-" + last.refHigh : last.refHigh != null ? "lab range up to " + last.refHigh : last.refLow != null ? "lab range from " + last.refLow : "";
  return band ? "your normal " + V.fmt(s.id, band.low).replace(/ .*$/, "") + "-" + V.fmt(s.id, band.high).replace(/ .*$/, "") : "";
}
function buildTrends(measurements, labs, notes, now) {
  const all = series(measurements, labs);
  const rows = [], attn = [];
  for (const s of all.values()) {
    const { last, previous } = C.lastAndPrevious(s.recs);
    const ch = C.change(last, previous);
    const band = s.kind === "metric" ? C.normalBand(s.recs.filter((r) => r.ts !== last.ts), { now }) : null;   // excludes the value being judged
    const spark = C.lastN(s.recs, 30).map((r) => r.value);
    const labLast = s.kind === "lab" ? last : null;
    rows.push({
      id: s.id, kind: s.kind, label: s.label, unit: s.unit,
      valueText: s.kind === "metric" ? VM.fmt(s.id, last.value) : String(Math.round(last.value * 100) / 100) + (s.unit ? " " + s.unit : ""),
      at: last.ts, source: last.source,
      previous: previous ? { valueText: s.kind === "metric" ? VM.fmt(s.id, previous.value) : String(Math.round(previous.value * 100) / 100), at: previous.ts } : null,
      change: ch ? { dir: ch.dir, text: s.kind === "metric" ? VM.fmtDelta(s.id, ch.abs) : (ch.abs > 0 ? "+" : "") + String(Math.round(ch.abs * 100) / 100), days: ch.days } : null,
      band: band ? { low: band.low, high: band.high, n: band.n, position: C.position(last.value, band) } : null,
      labStatus: labLast ? C.labStatus(labLast) : null,
      spark, series: C.lastN(s.recs, 120).map((r) => ({ ts: r.ts, v: r.value, s: r.source })), unit: s.unit, dec: s.kind === "metric" ? VM.decOf(s.id) : 2, kind: s.id === "sleep_minutes" ? "sleep" : "num",
      pos: posOf(s, last, band), normalText: normalOf(s, last, band, VM),
      refBand: s.kind === "lab" && last.refLow != null && last.refHigh != null ? { low: last.refLow, high: last.refHigh, label: "lab range" } : null, count: s.recs.length, note: notes && Object.prototype.hasOwnProperty.call(notes, s.id) ? notes[s.id] : null,
    });
    for (const a of attention(s, now)) attn.push(a);
  }
  const attIds = new Set(attn.map((a) => a.id)); for (const r of rows) r.needs = r.pos === "above" || r.pos === "below" || attIds.has(r.id);
  const order = (r) => (r.kind === "lab" ? 1 : 0);
  rows.sort((a, b) => (b.needs ? 1 : 0) - (a.needs ? 1 : 0) || order(a) - order(b) || a.label.localeCompare(b.label));   // markers that need a look come first
  attn.sort((a, b) => a.rank - b.rank || a.text.localeCompare(b.text));
  return { rows, attention: attn.slice(0, 30), hasData: rows.length > 0 };
}

// Before/after for one experiment: mean of the marker over the 14 days before the start vs from the start to the stop (or now).
function experimentView(exp, measurements, labs, now) {
  const recs = exp.metric ? (exp.metricKind === "lab" ? labs.filter((l) => l.key === exp.metric) : measurements.filter((m) => m.metric === exp.metric)) : [];
  const start = tms(exp.start + "T00:00:00"), end = exp.stop ? tms(exp.stop + "T23:59:59") : now;
  const mean = (a) => (a.length ? a.reduce((x, r) => x + r.value, 0) / a.length : null);
  const before = recs.filter((r) => { const x = tms(r.ts); return x >= start - 14 * DAY && x < start; });
  const after = recs.filter((r) => { const x = tms(r.ts); return x >= start && x <= end; });
  const mb = mean(before), ma = mean(after);
  const metricId = exp.metricKind === "metric" ? exp.metric : null;
  const f = (v) => (v == null ? "" : metricId ? VM.fmt(metricId, v) : String(Math.round(v * 100) / 100));
  return {
    id: exp.id, title: exp.title, start: exp.start, stop: exp.stop, status: exp.status, verdictNote: exp.verdictNote, metric: exp.metric, metricKind: exp.metricKind,
    metricLabel: metricId ? S.METRICS[metricId].label : (recs[0] ? recs[0].test : exp.metric || ""),
    days: Math.max(0, Math.round((end - start) / DAY)), notes: exp.notes, fromInsight: exp.fromInsight,
    before: { n: before.length, mean: mb, text: f(mb) }, after: { n: after.length, mean: ma, text: f(ma) },
    delta: mb != null && ma != null ? { abs: ma - mb, pct: pct(ma, mb), text: (ma - mb > 0 ? "+" : "") + (metricId ? VM.fmtDelta(metricId, ma - mb) : String(Math.round((ma - mb) * 100) / 100)) } : null,
    series: C.lastN(recs.filter((r) => tms(r.ts) >= start - 14 * DAY), 60).map((r) => ({ ts: r.ts, v: r.value, s: r.source, after: tms(r.ts) >= start })),
    unit: metricId ? S.METRICS[metricId].unit : (recs[0] ? recs[0].unit : ""), dec: metricId ? VM.decOf(metricId) : 2, kind: metricId === "sleep_minutes" ? "sleep" : "num",
    enough: before.length >= 3 && after.length >= 3,
  };
}

module.exports = { buildTrends, experimentView, attention, series };
