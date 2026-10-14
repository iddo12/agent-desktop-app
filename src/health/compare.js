// My Health stage 1: "previous value" comparison, "your normal" band, lab status. Pure functions over plain records.
// Every number the UI shows comes with the previous value and its date from here, so nothing is shown without a comparison.
"use strict";

const DAY = 86400000;
const t = (ts) => new Date(ts).getTime();

// records: measurement or lab records of ONE metric/test, any order. Returns {last, previous} (newest and the one before it),
// both null when absent. Records with the same timestamp count as one (the LAST ONE IN LIST ORDER wins, not the newest source).
function lastAndPrevious(records) {
  const byTs = new Map();
  for (const r of records || []) byTs.set(r.ts, r);
  const a = [...byTs.values()].sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0));
  return { last: a[0] || null, previous: a[1] || null };
}

// How the newest value changed against the one before it. flat = within 0.5 % of the previous (or exactly equal).
function change(last, previous) {
  if (!last || !previous) return null;
  const abs = last.value - previous.value;
  const pct = previous.value !== 0 ? (abs / Math.abs(previous.value)) * 100 : null;
  const dir = abs === 0 || (pct != null && Math.abs(pct) < 0.5) ? "flat" : abs > 0 ? "up" : "down";
  return { abs, pct, dir, days: Math.round((t(last.ts) - t(previous.ts)) / DAY) };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// "Your normal": the middle half (25th to 75th percentile) of your own values in the last `days` days up to `now`.
// null when there are fewer than `minPoints` values: no band is better than a band from three points.
function normalBand(records, opts) {
  const o = Object.assign({ days: 30, minPoints: 5, now: Date.now() }, opts || {});
  const from = o.now - o.days * DAY;
  const v = (records || []).filter((r) => { const x = t(r.ts); return x >= from && x <= o.now + DAY; }).map((r) => r.value).sort((a, b) => a - b);
  if (v.length < o.minPoints) return null;
  return { low: percentile(v, 0.25), high: percentile(v, 0.75), n: v.length, days: o.days };
}
function position(value, band) { return !band ? null : value < band.low ? "below" : value > band.high ? "above" : "within"; }

// The newest n records, oldest first (for the "last three values" and the sparkline).
function lastN(records, n) {
  const byTs = new Map();
  for (const r of records || []) byTs.set(r.ts, r);
  return [...byTs.values()].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0)).slice(-n);
}

// Lab status against the lab's own range and the optional optimal zone:
//   "outside-lab" (outside the lab range), "outside-optimal" (inside the lab range, outside the optimal zone),
//   "optimal" (inside the optimal zone), "in-range" (inside the lab range, no optimal zone given), "no-range".
function labStatus(lab) {
  if (!lab) return "no-range";
  const v = lab.value;
  const hasRef = lab.refLow != null || lab.refHigh != null;
  if (hasRef && ((lab.refLow != null && v < lab.refLow) || (lab.refHigh != null && v > lab.refHigh))) return "outside-lab";
  const hasOpt = lab.optLow != null || lab.optHigh != null;
  if (hasOpt) return (lab.optLow != null && v < lab.optLow) || (lab.optHigh != null && v > lab.optHigh) ? "outside-optimal" : "optimal";
  return hasRef ? "in-range" : "no-range";
}

module.exports = { lastAndPrevious, change, normalBand, position, lastN, labStatus, percentile };
