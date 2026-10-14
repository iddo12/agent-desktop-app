// My Health stage 1: importers. PURE functions: text or parsed JSON in, validated records out. No fs, no logging.
// Each returns { format, measurements:[], labs:[], skipped, rejected }:
//   measurements / labs  records already passed through the schema (ids, canonical units, local timestamps)
//   skipped              rows or entries with nothing usable (empty cell, unreadable date): counted, never described
//   rejected             rows that failed validation (implausible number, unknown unit): counted, never described
// Day-level aggregation (steps summed, heart rate averaged, sleep = main sleep) keeps the store small and fast.
//
// SHAPES ARE ASSUMPTIONS where noted. The Renpho export columns and the Health Connect CSV layout were NOT checked against a
// real file (no real data is used in stage 1); the readers are tolerant (header names matched loosely) and are covered by
// SYNTHETIC samples in tests/fixtures/health/. Adjust the header tables below when a real export is first seen.
//
// EXTENSION POINT, lab PDFs (stage 2, deliberately NOT built): a PDF reader must run BEHIND the identifier-stripping step
// (storage plan option A, 2026-10-07): code removes name, ID number, address, phone and clinic names first, and only the
// stripped extraction ({rows:[{test,value,unit,refLow,refHigh,date}], fileId}) may ever reach the store or a model.
// importLabPdf below is the placeholder; labsFromStrippedRows is the only function such a reader should call.
"use strict";
const S = require("./schema");

const result = (format) => ({ format, measurements: [], labs: [], skipped: 0, rejected: 0, warnings: [] });
const MAX_ROWS = 200000;
function pushM(res, input) { const r = S.normalizeMeasurement(input); if (r.ok) res.measurements.push(r.record); else res.rejected++; }
function pushL(res, input) { const r = S.normalizeLab(input); if (r.ok) res.labs.push(r.record); else res.rejected++; }

// ---------------------------------------------------------------- CSV
// RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF, a leading BOM, any single-character delimiter (review F9: "," or ";").
// At most MAX_ROWS rows are read (the array is flagged `truncated` beyond that).
function parseCsv(text, opts) {
  const delim = opts && opts.delimiter ? opts.delimiter : ",", max = opts && opts.maxRows ? opts.maxRows : MAX_ROWS;
  const rows = []; let row = [], f = "", q = false;
  const s = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(f); f = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; if (rows.length >= max) { rows.truncated = true; return rows; } }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}
// First line without splitting the whole text (a 25 MB file is never turned into an array of lines to read one header).
function firstLine(text) { const s = String(text == null ? "" : text); const i = s.indexOf("\n"); return s.slice(0, i < 0 ? Math.min(s.length, 4000) : Math.min(i, 4000)).replace(/^\uFEFF/, "").replace(/\r$/, ""); }
function sniffDelimiter(text) { const l = firstLine(text); const sc = (l.match(/;/g) || []).length, cm = (l.match(/,/g) || []).length; return sc > cm ? ";" : ","; }
// Day-first or month-first, decided from the whole column (review F9). Slash dates only; ISO and month-name dates need no choice.
//   "dmy": some first part is above 12;  "mdy": some second part is above 12;  "ambiguous": slash dates, all parts 12 or less;
//   "mixed": both kinds of evidence;  "none": no slash dates.
function inferDateOrder(values) {
  let dmy = false, mdy = false, seen = 0;
  for (const v of values) { const m = /^\s*(\d{1,2})[/.](\d{1,2})[/.]\d{2,4}/.exec(String(v || "")); if (!m) continue; seen++; if (+m[1] > 12) dmy = true; if (+m[2] > 12) mdy = true; }
  return !seen ? "none" : dmy && mdy ? "mixed" : dmy ? "dmy" : mdy ? "mdy" : "ambiguous";
}
// opts.dateOrder ("dmy" | "mdy") is the user's explicit choice. Returns {dayFirst} or {needsChoice} or {mixed}.
function dateOrderFor(values, opts) {
  const o = opts && opts.dateOrder; if (o === "dmy" || o === "mdy") return { dayFirst: o === "dmy" };
  const g = inferDateOrder(values);
  return g === "dmy" ? { dayFirst: true } : g === "mdy" ? { dayFirst: false } : g === "mixed" ? { mixed: true } : g === "ambiguous" ? { needsChoice: true } : { dayFirst: true };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const p2 = (n) => String(n).padStart(2, "0");
const mk = (y, mo, d, h, mi, s) => S.normalizeTs(y + "-" + p2(mo) + "-" + p2(d) + "T" + p2(h || 0) + ":" + p2(mi || 0) + ":" + p2(s || 0));
function to24(h, ap) { h = +h; if (!ap) return h; ap = ap.toLowerCase(); return ap === "pm" ? (h % 12) + 12 : h % 12; }

// Tolerant date reader. ISO (with or without zone), "YYYY/MM/DD hh:mm", "Mar 01, 2024 7:30 AM", "01 Mar 2024", and
// slash dates "DD/MM/YYYY" (opts.dayFirst, default true: Israeli order) or "MM/DD/YYYY". Two-digit years are 20yy.
function parseDateTime(v, opts) {
  if (v instanceof Date) return S.normalizeTs(v);
  if (typeof v !== "string") return null;
  const s = v.trim(); if (!s) return null;
  const dayFirst = !opts || opts.dayFirst !== false;
  const iso = S.normalizeTs(s); if (iso) return iso;
  let m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?)?$/i.exec(s);
  if (m) return mk(+m[1], +m[2], +m[3], to24(m[4] || 0, m[7]), +(m[5] || 0), +(m[6] || 0));
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?)?$/i.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    let a = +m[1], b = +m[2];
    let day = dayFirst ? a : b, mon = dayFirst ? b : a;
    if (mon > 12 && day <= 12) { const t = day; day = mon; mon = t; }
    return mk(y, mon, day, to24(m[4] || 0, m[7]), +(m[5] || 0), +(m[6] || 0));
  }
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?)?$/i.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return mk(+m[3], MONTHS[m[1].toLowerCase()], +m[2], to24(m[4] || 0, m[7]), +(m[5] || 0), +(m[6] || 0));
  m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?)?$/i.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return mk(+m[3], MONTHS[m[2].toLowerCase()], +m[1], to24(m[4] || 0, m[7]), +(m[5] || 0), +(m[6] || 0));
  return null;
}

// "Weight(kg)" -> {name:"weight", unit:"kg"}; "Body Fat(%)" -> {name:"body fat", unit:"%"}
function splitHeader(h) {
  const s = String(h || "").trim(); const m = /^(.*?)\s*[([]([^)\]]*)[)\]]\s*$/.exec(s);
  return { name: (m ? m[1] : s).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim(), unit: m ? m[2].trim() : "" };
}

// ---------------------------------------------------------------- Renpho
// ASSUMED columns (Renpho app CSV export): a time column ("Time of Measurement"), "Weight(kg)", "BMI", "Body Fat(%)",
// "Body Water(%)", "Muscle Mass(kg)", "Bone Mass(kg)", "Visceral Fat", plus columns we ignore. "(lb)" headers are converted.
const RENPHO_COLS = { weight: "weight", bmi: "bmi", "body fat": "body_fat", "body water": "body_water", "muscle mass": "muscle_mass", "bone mass": "bone_mass", "visceral fat": "visceral_fat" };
function importRenphoCsv(text, opts) {
  const o = opts || {}; const res = result("renpho");
  const delim = sniffDelimiter(text), decimalComma = delim === ";";
  const rows = parseCsv(text, { delimiter: delim });
  if (rows.truncated) res.warnings.push("row-cap");
  if (rows.length < 2) return res;
  const head = rows[0].map(splitHeader);
  const timeCol = head.findIndex((h) => /time|date/.test(h.name));
  const cols = []; head.forEach((h, i) => { if (RENPHO_COLS[h.name]) cols.push({ i, metric: RENPHO_COLS[h.name], unit: h.unit }); });
  if (timeCol < 0 || !cols.length) { res.rejected = rows.length - 1; return res; }
  const order = dateOrderFor(rows.slice(1).map((r) => r[timeCol]), o);
  if (order.needsChoice) { res.needsChoice = "dateOrder"; return res; }
  if (order.mixed) { res.rejected = rows.length - 1; res.warnings.push("mixed-date-order"); return res; }
  for (const row of rows.slice(1)) {
    const ts = parseDateTime(row[timeCol], { dayFirst: order.dayFirst });
    if (!ts) { res.skipped++; continue; }
    for (const c of cols) {
      let raw = (row[c.i] || "").trim();
      if (!raw || raw === "--") continue;
      if (decimalComma) raw = raw.replace(",", ".");
      pushM(res, { metric: c.metric, value: raw, unit: c.unit && c.unit !== "%" ? c.unit : undefined, ts, source: "renpho", fileId: o.fileId });
    }
  }
  return res;
}

// ---------------------------------------------------------------- Fitbit (Google Takeout JSON)
// Takeout names: sleep-YYYY-MM-DD.json, heart_rate-YYYY-MM-DD.json, steps-YYYY-MM-DD.json, resting_heart_rate-YYYY-MM-DD.json.
// Each file is an array. Heart rate is aggregated to the day's mean, steps to the day's sum, sleep to the main sleep.
function fitbitKind(fileName) {
  const n = String(fileName || "").toLowerCase().replace(/^.*[\\/]/, "");
  if (/^resting[_ -]?heart[_ -]?rate/.test(n)) return "resting_hr";
  if (/^heart[_ -]?rate(?![_ -]?var)/.test(n)) return "heart_rate";
  if (/^sleep(?!.*score)/.test(n)) return "sleep";
  if (/^steps/.test(n)) return "steps";
  return null;
}
// Review F7: the Takeout sleep flag is `mainSleep` (the web API calls it isMainSleep; both are honoured); the minute series (steps, heart
// rate) carry no zone and are read as UTC and converted to local time unless opts.utc === false (verify with one real late-evening day);
// heart-rate readings with confidence 0 are dropped; every day gets a coverage count `n`, and the store never lets a day with fewer samples
// overwrite a fuller one (overlapping or partial Takeout windows).
function importFitbitTakeout(file, opts) {
  const o = opts || {}; const res = result("fitbit");
  const kind = fitbitKind(file && file.fileName);
  const arr = file && file.json;
  if (!kind || !Array.isArray(arr)) { res.rejected = 1; return res; }
  const useUtc = o.utc !== false && (kind === "steps" || kind === "heart_rate");
  if (useUtc) res.warnings.push("fitbit-utc");
  const days = new Map(); // date -> {sum, n}
  const add = (date, v) => { const d = days.get(date) || { sum: 0, n: 0 }; d.sum += v; d.n++; days.set(date, d); };
  for (const e of arr.slice(0, 2000000)) {
    if (!e || typeof e !== "object") { res.skipped++; continue; }
    if (kind === "sleep") {
      const date = S.normalizeTs(e.dateOfSleep) ? String(e.dateOfSleep).slice(0, 10) : null;
      const mins = S.num(e.minutesAsleep);
      if (!date || mins == null || e.mainSleep === false || e.isMainSleep === false) { res.skipped++; continue; }
      add(date, mins); continue;
    }
    let ts = parseDateTime(e.dateTime, { dayFirst: false });
    if (!ts) { res.skipped++; continue; }
    if (useUtc) { const loc = S.normalizeTs(new Date(ts + "Z")); if (!loc) { res.skipped++; continue; } ts = loc; }
    if (kind === "resting_hr" && e.value && typeof e.value.date === "string" && S.normalizeTs(e.value.date)) ts = e.value.date.slice(0, 10) + "T00:00:00";
    if (kind === "heart_rate" && e.value && e.value.confidence === 0) { res.skipped++; continue; }
    const raw = kind === "heart_rate" ? (e.value && e.value.bpm) : kind === "resting_hr" ? (e.value && e.value.value) : e.value;
    const v = S.num(raw);
    if (v == null || (kind !== "steps" && v <= 0)) { res.skipped++; continue; }
    add(ts.slice(0, 10), v);
  }
  const metric = kind === "sleep" ? "sleep_minutes" : kind;
  for (const [date, d] of days) {
    const value = kind === "steps" || kind === "sleep" ? d.sum : d.sum / d.n;
    if (kind === "steps" && value === 0) { res.skipped++; continue; }
    pushM(res, { metric, value, ts: date, source: "fitbit", fileId: o.fileId, n: d.n });
  }
  return res;
}

// ---------------------------------------------------------------- Health Connect CSV (exporter apps)
// ASSUMED long layout, one reading per row: a time column (time/timestamp/start time/date), a type column
// (type/record type/data type/metric) and value + unit columns; sleep rows give start time and end time instead of a value.
// Type names are matched loosely ("HeartRate", "heart_rate", "Heart rate"). Steps are summed per day, heart rate averaged.
const HC_TYPES = { steps: "steps", "heart rate": "heart_rate", "resting heart rate": "resting_hr", weight: "weight", "body fat": "body_fat", "oxygen saturation": "spo2",
  "blood pressure systolic": "bp_systolic", "blood pressure diastolic": "bp_diastolic", systolic: "bp_systolic", diastolic: "bp_diastolic",
  "heart rate variability": "hrv", "vo2 max": "vo2max", vo2max: "vo2max", "heart rate variability rmssd": "hrv", "sleep session": "sleep", sleep: "sleep", "sleep duration": "sleep" };
const hcType = (s) => HC_TYPES[String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()] || null;
function importHealthConnectCsv(text, opts) {
  const o = opts || {}; const res = result("healthconnect");
  const delim = sniffDelimiter(text);
  const rows = parseCsv(text, { delimiter: delim });
  if (rows.truncated) res.warnings.push("row-cap");
  if (rows.length < 2) return res;
  const head = rows[0].map((h) => splitHeader(h).name);
  const find = (re) => head.findIndex((h) => re.test(h));
  const iTime = find(/^(time|timestamp|start time|start|date|datetime)$/), iEnd = find(/^(end time|end)$/);
  const iType = find(/^(type|record type|data type|metric)$/), iVal = find(/^(value|count|amount)$/), iUnit = find(/^unit/);
  if (iTime < 0 || iType < 0) { res.rejected = rows.length - 1; return res; }
  const order = dateOrderFor(rows.slice(1).map((r) => r[iTime]), o);
  if (order.needsChoice) { res.needsChoice = "dateOrder"; return res; }
  if (order.mixed) { res.rejected = rows.length - 1; res.warnings.push("mixed-date-order"); return res; }
  const po = { dayFirst: order.dayFirst };
  const days = new Map(); // "metric|date" -> {sum, n}
  for (const row of rows.slice(1)) {
    const type = hcType(row[iType]); const ts = parseDateTime(row[iTime], po);
    if (!type || !ts) { res.skipped++; continue; }
    if (type === "sleep") {
      let mins = null;
      const end = iEnd >= 0 ? parseDateTime(row[iEnd], po) : null;
      if (end) mins = (new Date(end) - new Date(ts)) / 60000;
      else if (iVal >= 0) { const v = S.num(delim === ";" ? String(row[iVal]).replace(",", ".") : row[iVal]); const u = iUnit >= 0 ? (row[iUnit] || "").toLowerCase() : "min"; mins = v == null ? null : /^h/.test(u) ? v * 60 : v; }
      if (mins == null || mins <= 0) { res.skipped++; continue; }
      const k = "sleep_minutes|" + (end || ts).slice(0, 10); const d = days.get(k) || { sum: 0, n: 0 }; d.sum += mins; d.n++; days.set(k, d); continue;
    }
    const v = iVal >= 0 ? S.num(delim === ";" ? String(row[iVal]).replace(",", ".") : row[iVal]) : null;
    if (v == null) { res.skipped++; continue; }
    if (type === "steps" || type === "heart_rate") { const k = type + "|" + ts.slice(0, 10); const d = days.get(k) || { sum: 0, n: 0 }; d.sum += v; d.n++; days.set(k, d); continue; }
    pushM(res, { metric: type, value: v, unit: iUnit >= 0 && /^(kg|kgs|lb|lbs|g)$/i.test(row[iUnit] || "") ? row[iUnit] : undefined, ts, source: "healthconnect", fileId: o.fileId });
  }
  for (const [k, d] of days) {
    const [metric, date] = k.split("|");
    pushM(res, { metric, value: metric === "heart_rate" ? d.sum / d.n : d.sum, ts: date, source: "healthconnect", fileId: o.fileId });
  }
  return res;
}

// ---------------------------------------------------------------- manual lab entry
// The Labs form payload: {test, value, unit, refLow, refHigh, optLow, optHigh, date}. Returns the same shape as the file importers.
function labFromForm(payload) {
  const res = result("lab-form");
  const p = payload || {};
  pushL(res, { test: p.test, value: p.value, unit: p.unit, refLow: p.refLow, refHigh: p.refHigh, optLow: p.optLow, optHigh: p.optHigh, ts: p.date || p.ts, source: "manual" });
  return res;
}
// A JSON file {"format":"lab-entries","entries":[<form payloads>]}: the same payloads in bulk (used for synthetic samples and hand-made files).
function importLabEntries(json, opts) {
  const o = opts || {}; const res = result("lab-entries");
  const list = json && json.format === "lab-entries" && Array.isArray(json.entries) ? json.entries : null;
  if (!list) { res.rejected = 1; return res; }
  for (const p of list.slice(0, 5000)) pushL(res, { test: p && p.test, value: p && p.value, unit: p && p.unit, refLow: p && p.refLow, refHigh: p && p.refHigh, optLow: p && p.optLow, optHigh: p && p.optHigh, ts: p && (p.date || p.ts), source: "file", fileId: o.fileId });
  return res;
}

// Stage 2 hook: the ONLY entry point a lab-PDF reader may use. It takes rows that were ALREADY stripped of identifiers.
function labsFromStrippedRows(rows, opts) {
  const o = opts || {}; const res = result("lab-pdf");
  for (const p of Array.isArray(rows) ? rows : []) pushL(res, { test: p && p.test, value: p && p.value, unit: p && p.unit, refLow: p && p.refLow, refHigh: p && p.refHigh, ts: p && p.date, source: "labpdf", fileId: o.fileId });
  return res;
}
function importLabPdf() { return { ok: false, reason: "Lab PDF reading is not built yet (stage 2, behind the identifier-stripping step)." }; }

// ---------------------------------------------------------------- picking the importer for a chosen file
// Returns {format, run(text|json, opts)} or {error}. .pdf is refused with the stage-2 message.
function detect(fileName, text) {
  const ext = (String(fileName || "").toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
  if (ext === "pdf") return { error: "pdf" };
  if (ext === "zip" || ext === "db" || ext === "sqlite" || ext === "gz" || ext === "7z") return { error: "zip" };
  if (ext === "json") {
    const kind = fitbitKind(fileName);
    if (kind) return { format: "fitbit", needsJson: true, run: (json, o) => importFitbitTakeout({ fileName, json }, o) };
    let j = null; try { j = JSON.parse(String(text).replace(/^\uFEFF/, "")); } catch (e) { return { error: "bad-json" }; }
    if (j && j.format === "lab-entries") return { format: "lab-entries", parsed: j, run: (json, o) => importLabEntries(json, o) };
    return { error: "unknown" };
  }
  if (ext === "csv" || ext === "txt") {
    const first = firstLine(text).toLowerCase();
    if (/body fat|weight\s*\(|time of measurement/.test(first) && !/record type|data type/.test(first)) return { format: "renpho", run: importRenphoCsv };
    if (/(^|[,;])\s*"?(type|record[ _]type|data[ _]type|metric)"?\s*([,;]|$)/.test(first)) return { format: "healthconnect", run: importHealthConnectCsv };
    return { error: "unknown" };
  }
  return { error: "unknown" };
}

module.exports = { MAX_ROWS, firstLine, sniffDelimiter, inferDateOrder, dateOrderFor, parseCsv, parseDateTime, importRenphoCsv, importFitbitTakeout, importHealthConnectCsv, labFromForm, importLabEntries, labsFromStrippedRows, importLabPdf, fitbitKind, detect };
