// My Research card dates (v1.121.1). Pure, no I/O, never throws.
//   sourceDate  optional finding field: when the thing happened or was published; ISO ("2026-08-10", "2026-08-10T09:00:00Z") or free text ("Aug 10 2026").
//   generatedAt digest field: when the agent produced the digest (ISO). Shown as "found 12 Oct".
// dateLine(sourceDate, generatedAt) -> "Aug 10 2026 · found 12 Oct" | "found 12 Oct" (no usable sourceDate) | "" (nothing usable).
"use strict";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MIN_YEAR = 1990, MAX_YEAR = 2100;

// -> { y, m (1-12), d } | null. ISO dates are read from the text (no time zone shift); anything else goes through Date.parse.
function parseDate(v) {
  try {
    if (typeof v !== "string" && typeof v !== "number") return null;
    const s = String(v).trim().slice(0, 80);
    if (!s) return null;
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
    let y, m, d;
    if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
    else {
      const t = Date.parse(s);
      if (!isFinite(t)) return null;
      const x = new Date(t); y = x.getFullYear(); m = x.getMonth() + 1; d = x.getDate();
    }
    if (!(y >= MIN_YEAR && y <= MAX_YEAR) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    const chk = new Date(Date.UTC(y, m - 1, d));
    if (chk.getUTCMonth() !== m - 1 || chk.getUTCDate() !== d) return null;     // 2026-02-31 is not a date
    return { y, m, d };
  } catch (e) { return null; }
}
const full = (p) => MONTHS[p.m - 1] + " " + p.d + " " + p.y;
const short = (p) => p.d + " " + MONTHS[p.m - 1];

function dateLine(sourceDate, generatedAt) {
  const s = parseDate(sourceDate), g = parseDate(generatedAt);
  const found = g ? "found " + short(g) : "";
  if (s) return full(s) + (found ? " · " + found : "");
  return found;
}

module.exports = { parseDate, dateLine, MONTHS };
