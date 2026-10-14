// MY RESEARCH magazine view (v1.91.0): deterministic figure parser for the small bar charts on article cards. PURE: no I/O, no clock.
// A chart is drawn ONLY from numbers that appear in the finding's own text, and only when the text holds at least two comparable numbers
// (same unit class) in ONE sentence, in one of these shapes:
//   A  change pair      "from 790 to 1,316", "(26.4K to 39.5K)", "4,000 -> 8,000", "4,000 → 8,000"
//   B  new vs now       "8,000 watch hours/365d (now 4,000)"
//   C  flat value       "engagedViews stayed flat (~20K/month ...)"      (only joins a chart, never alone)
//   D  moved to         "views rose to 39.5K in Sep"                     (only joins a chart, never alone)
// Anything else ("2.2% vs ~6%", ranges like "20-40%", "up to 50%", dates, years, ids like KB5122878 / v25 / 30A) gives NO chart: when the
// parse is uncertain we skip rather than guess. Unit classes: plain count, abbreviated count (K/M/B), percent, each currency; never mixed.
// Used in main (service.normFinding attaches finding.chart); tests: tests/research-figures.test.js.
"use strict";

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December";
// one number token: optional ~ / ≈, optional currency, digits (1,234 or 12.5), optional K/M/B, optional %; not glued to letters or ids
const NUM = "(?<![\\w.,/#-])(?:~|≈)?[$€£₪]?(?:\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)(?:[KMB](?![A-Za-z&])|k(?![A-Za-z]))?%?(?![\\w])";
const UNIT = "(watch hours|engaged views|views|hours|sessions|subscribers|subs|users|visits|clicks|followers|impressions|messages|emails|NIS|ILS|USD|EUR|per (?:day|week|month|year|28 days))";
const ARROW = "(to|->|→|=>)";
const MAX_BARS = 6;

const STOP = new Set(("is are was were be been stayed remained stays remains flat jump jumps jumped rise rises rose fell fall falls grew grow went go step steps stepped stepping " +
  "from the a an our its their his her my of by at on in up down and or while with to changed moved dropped drop increased decreased climbed climb shows show showed " +
  "says said reports reported that which so but own also now new only about roughly around than as for per this these those there it they we you").split(" "));

// "26.4K" -> { value: 26400, text: "26.4K", cls: "x" }; null for a year-like bare integer or anything unparsable
function parseNum(tok) {
  const t = String(tok || "").trim();
  const m = t.match(/^(~|≈)?([$€£₪])?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([KMBk])?(%)?$/);
  if (!m) return null;
  const hasComma = m[3].indexOf(",") >= 0;
  let v = Number(m[3].replace(/,/g, ""));
  if (!Number.isFinite(v)) return null;
  if (!m[2] && !m[4] && !m[5] && !hasComma && Number.isInteger(v) && v >= 1900 && v <= 2100) return null;   // a year, not a figure
  const mult = m[4] ? { K: 1e3, k: 1e3, M: 1e6, B: 1e9 }[m[4]] : 1;
  v *= mult;
  const cls = (m[2] || "") + (m[5] ? "%" : "") + (m[4] ? "x" : "");
  return { value: v, text: t.replace(/\s+/g, ""), approx: !!m[1], cls, big: hasComma || !!m[4] || !!m[5] || !!m[2] || v >= 100 };
}

function splitSentences(text) {
  return String(text || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?;])\s+(?=[A-Z(~$€£₪0-9"'])/).filter(Boolean);
}

// the subject of a figure: up to 3 words just before position `end` in the sentence (stops at digits, punctuation or a stop word)
// COST: only the last 80 characters before the figure are looked at (a long prefix is never split).
// Returns the subject words and, when a month sits right before them ("Sep 2026 views jump"), that month as `when`.
function subjectInfo(s, end) {
  const before = s.slice(Math.max(0, end - 80), end).replace(/[(\s]+$/, "");
  const toks = before.split(/\s+/);
  const out = [];
  let when = "";
  let i = toks.length - 1;
  while (i >= 0 && STOP.has(toks[i].toLowerCase().replace(/[^a-z]/g, ""))) i--;           // trailing verbs / small words
  for (; i >= 0 && out.length < 3; i--) {
    const opener = /^[("“']/.test(toks[i]);
    const w = toks[i].replace(/^[("“']+/, "");
    if (!/^[A-Za-z][A-Za-z'’-]*$/.test(w)) break;                                          // digits or punctuation end the subject
    if (STOP.has(w.toLowerCase())) break;
    out.unshift(w.replace(/['’]s$/, ""));
    if (opener) { i = -2; break; }                                                          // "(daily views": the bracket starts the subject
  }
  if (out.length && i >= 0) {                                                               // "Sep 2026 views" / "Sep views": the month the figure is for
    let k = i; if (/^\d{4}$/.test(toks[k] || "")) k--;
    if (MONTH_RE.test(toks[k] || "")) when = toks[k].slice(0, 3);
  }
  return { subject: out.join(" "), when };
}
function subjectBefore(s, end) { return subjectInfo(s, end).subject; }
const MONTH_RE = new RegExp("^(?:" + MONTHS + ")$");
const AFTER_RE = new RegExp("^\\s*(?:\\w+\\s+)?(on|in|since|from)\\s+((?:\\d{1,2} )?(?:" + MONTHS + "))\\b");
const MAX_MATCHES = 12;                      // per shape per sentence: hostile text cannot make the parse slow
const lim = (it) => { const out = []; for (const m of it) { out.push(m); if (out.length >= MAX_MATCHES) break; } return out; };


// all figure groups in ONE sentence: [{ kind, start, end, subject, unit, bars:[{label, num}] }]
function groupsIn(s, fullText) {
  const groups = [];
  const used = [];
  const overlaps = (a, b) => used.some((u) => a < u[1] && b > u[0]);
  const take = (g) => { groups.push(g); used.push([g.start, g.end]); };
  // A: change pair
  const reA = new RegExp("([Ff]rom\\s+)?(" + NUM + ")\\s*" + ARROW + "\\s*(" + NUM + ")(?:\\s+" + UNIT + "\\b)?", "g");
  for (const m of lim(s.matchAll(reA))) {
    const a = parseNum(m[2]), b = parseNum(m[4]);
    if (!a || !b || a.cls !== b.cls) continue;
    const arrowWord = /^to$/i.test(m[3]);
    const pre = s.slice(Math.max(0, m.index - 40), m.index).replace(/\s+$/, "");
    if (arrowWord && !m[1] && !/\($/.test(pre) && !(a.big && b.big)) continue;           // "5 to 10 people" reads as a range: skip
    if (/\bup$/i.test(pre) || /\bbetween$/i.test(pre)) continue;
    if (!a.cls && !m[5] && /\./.test(a.text + b.text) && !/^~/.test(a.text + b.text)) continue;   // "9.7 to 11.1": bare decimals read as versions: skip
    const si = subjectInfo(s, m.index), subj = si.subject;
    // the "after" label from the words right after the pair ("on 27 Aug", "in Sep", "since 24 Aug") or a month just before the subject
    const aw = s.slice(m.index + m[0].length, m.index + m[0].length + 40).match(AFTER_RE);
    const after = aw ? (aw[1] === "in" ? aw[2] : "from " + aw[2]) : si.when || "after";
    take({ kind: "A", start: m.index, end: m.index + m[0].length, subject: subj, unit: m[5] || "", bars: [{ label: "before", num: a }, { label: after, num: b }] });
  }
  // B: new value with "(now X)"
  const reB = new RegExp("(" + NUM + ")((?:\\s+[A-Za-z][A-Za-z-]*){0,3})([^()]{0,12}?)\\(\\s*[Nn]ow\\s+(" + NUM + ")\\s*\\)", "g");
  for (const m of lim(s.matchAll(reB))) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const nu = parseNum(m[1]), now = parseNum(m[4]);
    if (!nu || !now || nu.cls !== now.cls) continue;
    const unit = m[2].trim();
    const d = (fullText || s).match(new RegExp("\\bfrom (\\d{1,2} (?:" + MONTHS + ") \\d{4})", "i"));
    take({ kind: "B", start: m.index, end: m.index + m[0].length, subject: unit, unit, bars: [{ label: "Now", num: now }, { label: d ? "From " + d[1] : "New", num: nu }] });
  }
  // C: flat value
  const reC = new RegExp("\\bflat\\s*\\(\\s*(" + NUM + ")", "g");
  for (const m of lim(s.matchAll(reC))) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const v = parseNum(m[1]); if (!v) continue;
    const subj = subjectBefore(s, m.index);
    if (!subj) continue;
    take({ kind: "C", start: m.index, end: m.index + m[0].length, subject: subj, unit: "", single: true, bars: [{ label: subj + ", flat", num: v }] });
  }
  // D: moved to a value
  const reD = new RegExp("\\b(rose|fell|grew|dropped|climbed|jumped|increased|decreased)\\s+to\\s+(" + NUM + ")(?:\\s+in\\s+(" + MONTHS + ")\\b)?", "g");
  for (const m of lim(s.matchAll(reD))) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const v = parseNum(m[2]); if (!v) continue;
    const subj = subjectBefore(s, m.index);
    if (!subj) continue;
    take({ kind: "D", start: m.index, end: m.index + m[0].length, subject: subj, unit: "", single: true, bars: [{ label: subj + (m[3] ? ", " + m[3] : ", after"), num: v }] });
  }
  return groups.sort((x, y) => x.start - y.start);
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// one sentence -> charts (one per unit class with >= 2 bars, at least one of them from a pair/now group)
function chartsInSentence(s, fullText) {
  const groups = groupsIn(s, fullText);
  const byCls = new Map();
  for (const g of groups) {
    const cls = g.bars[0].num.cls;
    if (!byCls.has(cls)) byCls.set(cls, []);
    byCls.get(cls).push(g);
  }
  const out = [];
  for (const [cls, gs] of byCls) {
    // a flat/moved value alone is not a chart; two of them (different subjects, same sentence, same unit) are
    if (!gs.some((g) => !g.single) && new Set(gs.map((g) => g.subject.toLowerCase())).size < 2) continue;
    const units = [...new Set(gs.map((g) => g.unit.toLowerCase()).filter(Boolean))];
    if (units.length > 1 && gs.filter((g) => g.unit).length > 1 && gs.every((g) => g.kind !== "B")) continue;   // two different named units: not comparable
    const multi = gs.length > 1;
    const bars = [];
    // the chart title already names the subject, so a one-subject chart's bars say only "Before" / "Sep" / "Now" (v1.95.1: the
    // title is not repeated in every label); with several subjects each bar names its own: "Daily views, before"
    const lab = (g, b) => (g.single ? b.label : multi && g.subject ? cap(g.subject) + ", " + b.label : cap(b.label));
    gs.forEach((g) => g.bars.forEach((b) => bars.push({ label: lab(g, b), value: b.num.value, text: b.num.text })));
    if (bars.length < 2 || bars.length > MAX_BARS || bars.some((b) => !(b.value > 0))) continue;
    const subjects = [...new Set(gs.map((g) => g.subject).filter(Boolean))];
    const unit = gs.map((g) => g.unit).find(Boolean) || "";
    let title = subjects.length ? cap(subjects.join(" and ")) : "Figures in this finding";
    if (unit && subjects.indexOf(unit) < 0 && title.toLowerCase().indexOf(unit.toLowerCase()) < 0) title += ", " + unit;
    out.push({ title, unitClass: cls, unit, bars, sentence: s.slice(0, 400) });
  }
  return out;
}

// finding -> every chart it supports, in reading order: the so-what first (it is what the card shows), then what changed, then the title.
function extractCharts(f) {
  if (!f || typeof f !== "object") return [];
  // COST CAP: only the first 800 characters of each text (what a card shows and a bit more); with <= 12 matches per shape per sentence
  const texts = [f.soWhat, f.whatChanged, f.title].map((t, i) => (typeof t === "string" ? t.slice(0, i === 2 ? 300 : 800) : ""));
  const all = texts.join(" ");
  const out = [], seen = new Set();
  for (const t of texts) for (const s of splitSentences(t)) for (const c of chartsInSentence(s, all)) {
    const key = c.bars.map((b) => b.text).join("|");
    if (seen.has(key)) continue;
    seen.add(key); out.push(c);
  }
  return out;
}

// the chart a card shows (or null), plus a short "big figure" for the data card: "4,000 → 8,000"
function chartFor(f) {
  const c = extractCharts(f)[0];
  if (!c) return null;
  const pair = c.bars.length === 2 ? c.bars[0].text + " → " + c.bars[1].text : c.bars.reduce((a, b) => (b.value > a.value ? b : a)).text;
  return Object.assign({}, c, { figure: pair, figureLine: c.title + (c.bars.length === 2 && /^From /.test(c.bars[1].label) ? ", " + c.bars[1].label.replace(/^From/, "from") : "") });
}

module.exports = { extractCharts, chartFor, parseNum, splitSentences, subjectBefore, subjectInfo };
