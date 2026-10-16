// Usage-bar reset time (v1.124.0). Pure: no DOM, no Electron, loads in Node (tests) and as a renderer script.
// Decides WHAT the 5h / 7d bars say about when the window resets: the elapsed-time tick position, the short label
// under the bar, the full tooltip sentence, and whether the reset is known at all. The DOM work is in header-tasks.js.
//
// Input per window (as produced by archive.js getUsageWindows().resetInfo):
//   { resetsAt: ISO string | null, resetKnown: boolean, lastReadingAt: ISO string | null, ageMin: number | null }
// A reset time is only ever shown when it is known, in the future and no further away than one window length;
// anything else is "unknown" and nothing precise is displayed (never a time we do not have).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.UsageReset = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const WINDOW_MS = { "5h": 5 * HOUR, "7d": 7 * DAY };
  const STALE_5H_AGE_MIN = 300;      // a 5h reading older than the window itself says nothing about this window
  const WARN_UNDER_MS = 15 * MIN;    // 5h label turns to the warning colour under this

  function parseMs(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Date.parse(String(v));
    return Number.isFinite(n) ? n : null;
  }

  // Age of the last real reading in minutes, from its timestamp when there is one (so it keeps growing between refreshes).
  function readingAgeMin(raw, now) {
    const at = parseMs(raw && raw.lastReadingAt);
    if (at !== null) return Math.max(0, (now - at) / MIN);
    const a = raw && raw.ageMin;
    return typeof a === "number" && Number.isFinite(a) && a >= 0 ? a : null;
  }

  // -> { kind, known, resetsAtMs, remainingMs, fraction, ageMin, readingTooOld, level }
  function describe(raw, kind, now) {
    const win = WINDOW_MS[kind];
    const ageMin = readingAgeMin(raw, now);
    const readingTooOld = ageMin !== null && ageMin * MIN > win;
    const resetsAtMs = raw && raw.resetKnown === true ? parseMs(raw.resetsAt) : null;
    let known = resetsAtMs !== null && resetsAtMs > now && resetsAtMs - now <= win + MIN;
    if (known && kind === "5h" && ageMin !== null && ageMin > STALE_5H_AGE_MIN) known = false;
    const out = { kind, known, resetsAtMs: known ? resetsAtMs : null, remainingMs: null, fraction: null, ageMin, readingTooOld };
    if (known) {
      out.remainingMs = resetsAtMs - now;
      out.fraction = elapsedFraction(resetsAtMs, now, kind);
    }
    return out;
  }

  // Share of the window that has already passed, 0..1; null when the reset time is not usable.
  function elapsedFraction(resetsAtMs, now, kind) {
    const win = WINDOW_MS[kind];
    if (!win || !Number.isFinite(resetsAtMs) || !Number.isFinite(now) || resetsAtMs <= now) return null;
    return Math.min(1, Math.max(0, (now - (resetsAtMs - win)) / win));
  }

  // Short span: "1h 50m", "42m", "1d 5h". Rounded DOWN to the minute so it never promises more time than there is.
  function formatSpan(ms) {
    const totalMin = Math.max(0, Math.floor(ms / MIN));
    if (totalMin < 1) return "<1m";
    const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
    if (d > 0) return h > 0 ? d + "d " + h + "h" : d + "d";
    if (h > 0) return m > 0 ? h + "h " + m + "m" : h + "h";
    return m + "m";
  }

  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  // Long span for the sentence: "1 day 5 hours", "1 hour 50 minutes", "42 minutes".
  function formatSpanLong(ms) {
    const totalMin = Math.max(0, Math.floor(ms / MIN));
    if (totalMin < 1) return "less than a minute";
    const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
    const parts = [];
    if (d > 0) { parts.push(plural(d, "day")); if (h > 0) parts.push(plural(h, "hour")); }
    else if (h > 0) { parts.push(plural(h, "hour")); if (m > 0) parts.push(plural(m, "minute")); }
    else parts.push(plural(m, "minute"));
    return parts.join(" ");
  }

  function formatAgo(ageMin) {
    if (ageMin === null || ageMin === undefined) return null;
    if (ageMin < 1) return "less than a minute ago";
    if (ageMin < 60) return Math.round(ageMin) + " min ago";
    if (ageMin < 48 * 60) return Math.round(ageMin / 60) + " h ago";
    return Math.round(ageMin / 1440) + " d ago";
  }

  // opts: { locale, timeZone } - both optional; defaults are the person's own locale and local time zone.
  function fmt(opts, o) {
    const x = Object.assign({}, o);
    if (opts && opts.timeZone) x.timeZone = opts.timeZone;
    return new Intl.DateTimeFormat(opts && opts.locale ? opts.locale : undefined, x);
  }
  function timeText(ms, opts) { return fmt(opts, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms)); }
  function weekdayText(ms, opts) { return fmt(opts, { weekday: "short" }).format(new Date(ms)); }
  function dayKey(ms, opts) { return fmt(opts, { year: "numeric", month: "numeric", day: "numeric" }).format(new Date(ms)); }
  function sameLocalDay(a, b, opts) { return dayKey(a, opts) === dayKey(b, opts); }

  // The label under the bar: { text, extra, warn, unknown }. `extra` is the optional "(in 1d 5h)" part so a narrow header can drop it.
  function label(d, now, opts) {
    if (!d.known) return { text: "reset unknown", extra: "", warn: false, unknown: true };
    if (d.kind === "5h") return { text: formatSpan(d.remainingMs), extra: "", warn: d.remainingMs < WARN_UNDER_MS, unknown: false };
    const when = sameLocalDay(d.resetsAtMs, now, opts) ? "today " + timeText(d.resetsAtMs, opts) : weekdayText(d.resetsAtMs, opts) + " " + timeText(d.resetsAtMs, opts);
    return { text: when, extra: "(in " + formatSpan(d.remainingMs) + ")", warn: false, unknown: false };
  }

  // The full sentence for the tooltip and the accessible name.
  function sentence(d, now, opts) {
    const ago = formatAgo(d.ageMin);
    const tail = ago ? " Last real reading " + ago + "." : "";
    if (!d.known) return "Reset time unknown." + tail;
    const date = weekdayText(d.resetsAtMs, opts) + " " + fmt(opts, { day: "numeric", month: "short" }).format(new Date(d.resetsAtMs));
    return "Resets " + date + ", " + timeText(d.resetsAtMs, opts) + " (in " + formatSpanLong(d.remainingMs) + ")." + tail;
  }

  return { WINDOW_MS, STALE_5H_AGE_MIN, WARN_UNDER_MS, parseMs, readingAgeMin, describe, elapsedFraction, formatSpan, formatSpanLong, formatAgo, label, sentence, sameLocalDay };
});
