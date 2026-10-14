// My Health (HYGIEIA) stage 1: the typed data model. Pure: no fs, no Electron, no logging.
//
// PRIVACY: validation errors are {field, code} pairs only. They NEVER contain the offending value, so an error that
// reaches a log, a toast or a test failure cannot leak a number, a name or a dose.
//
// Timestamps are LOCAL ISO strings without a zone ("2026-10-07T07:30:00"): one person, one timezone. Anything with a
// zone (Z or +hh:mm) is converted to local time on the way in. Date-only input becomes T00:00:00.
"use strict";
const crypto = require("crypto");

const SCHEMA_VERSION = 1;

// Canonical units; importers convert to these. min/max are plausibility limits (a typo guard, not a medical rule).
const METRICS = {
  weight: { label: "Weight", unit: "kg", min: 20, max: 400, decimals: 1 },
  body_fat: { label: "Body fat", unit: "%", min: 1, max: 80, decimals: 1 },
  bmi: { label: "BMI", unit: "kg/m2", min: 8, max: 90, decimals: 1 },
  muscle_mass: { label: "Muscle mass", unit: "kg", min: 5, max: 150, decimals: 1 },
  body_water: { label: "Body water", unit: "%", min: 20, max: 85, decimals: 1 },
  bone_mass: { label: "Bone mass", unit: "kg", min: 0.5, max: 10, decimals: 1 },
  visceral_fat: { label: "Visceral fat", unit: "level", min: 0, max: 60, decimals: 0 },
  bp_systolic: { label: "BP systolic", unit: "mmHg", min: 50, max: 300, decimals: 0 },
  bp_diastolic: { label: "BP diastolic", unit: "mmHg", min: 30, max: 200, decimals: 0 },
  heart_rate: { label: "Heart rate", unit: "bpm", min: 25, max: 250, decimals: 0 },
  resting_hr: { label: "Resting heart rate", unit: "bpm", min: 25, max: 200, decimals: 0 },
  hrv: { label: "HRV", unit: "ms", min: 1, max: 400, decimals: 0 },
  spo2: { label: "Blood oxygen", unit: "%", min: 50, max: 100, decimals: 0 },
  steps: { label: "Steps", unit: "steps", min: 0, max: 200000, decimals: 0 },
  sleep_minutes: { label: "Sleep", unit: "min", min: 0, max: 1440, decimals: 0 },
  grip_strength: { label: "Grip strength", unit: "kg", min: 1, max: 120, decimals: 1 },
  vo2max: { label: "VO2max", unit: "ml/kg/min", min: 10, max: 95, decimals: 1 },
};

// from-unit (lower case) -> [canonical unit it can become, multiplier]
const CONVERT = {
  grip_strength: { kg: 1, kgs: 1, lb: 0.45359237, lbs: 0.45359237 },
  weight: { kg: 1, kgs: 1, lb: 0.45359237, lbs: 0.45359237, g: 0.001 },
  muscle_mass: { kg: 1, lb: 0.45359237, lbs: 0.45359237 },
  bone_mass: { kg: 1, lb: 0.45359237, lbs: 0.45359237 },
  sleep_minutes: { min: 1, mins: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hours: 60, s: 1 / 60, ms: 1 / 60000 },
};

const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const FILEID_RE = /^[a-f0-9]{8,64}$/;
const MED_KINDS = ["med", "supplement", "prescription"];

const pad = (n) => String(n).padStart(2, "0");
function localIso(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

// Accepts a Date, "YYYY-MM-DD", "YYYY-MM-DDTHH:mm[:ss]" (local) or any of those with Z / +hh:mm. Returns the local ISO or null.
// Bounds (review F10): nothing before 1990, and nothing more than a day in the future unless opts.allowFuture (planned stop dates, agent dates).
function normalizeTs(v, opts) {
  const r = normalizeTsRaw(v);
  if (!r) return null;
  if (+r.slice(0, 4) < 1990) return null;
  if (!(opts && opts.allowFuture) && new Date(r).getTime() > Date.now() + 86400000) return null;
  return r;
}
function normalizeTsRaw(v) {
  if (v instanceof Date) return isFinite(v.getTime()) ? localIso(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return validParts(+m[1], +m[2], +m[3], 0, 0, 0) ? m[1] + "-" + m[2] + "-" + m[3] + "T00:00:00" : null;
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return null;
  const sec = m[6] ? +m[6] : 0;
  if (!validParts(+m[1], +m[2], +m[3], +m[4], +m[5], sec)) return null;
  if (m[7]) { const d = new Date(s.replace(" ", "T")); return isFinite(d.getTime()) ? localIso(d) : null; }
  return m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + pad(sec);
}
function validParts(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const dim = new Date(y, mo, 0).getDate();
  return d <= dim;
}
const dateKey = (ts) => String(ts).slice(0, 10);

function hashId(prefix, parts) {
  return prefix + "_" + crypto.createHash("sha1").update(parts.map((p) => String(p == null ? "" : p)).join("|")).digest("hex").slice(0, 16);
}
const randomId = (prefix) => prefix + "_" + crypto.randomBytes(8).toString("hex");

// Numbers: "12,345" and "1,234.5" are thousands separators, "12,5" is a decimal comma (a single comma followed by 1 or 2 digits).
function num(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ""));
  if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  if (/^-?\d+,\d{1,2}$/.test(t)) return parseFloat(t.replace(",", "."));
  return null;
}
const str = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").replace(/\p{Cf}/gu, (c) => (c === "\u200e" || c === "\u200f" ? c : "")).trim().slice(0, max) : "");   // bidi overrides and zero-width characters are removed; LRM/RLM are kept for Hebrew
const bad = (...fields) => ({ ok: false, errors: fields.map(([field, code]) => ({ field, code })) });
const round = (v, d) => { const p = Math.pow(10, d); return Math.round(v * p) / p; };

// ---- measurement: {id, kind, metric, value, unit, ts, source, fileId?, note?}
const isMetric = (m) => typeof m === "string" && Object.prototype.hasOwnProperty.call(METRICS, m);   // "constructor" and friends are not metrics (review F6)
function normalizeMeasurement(input) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  const metric = typeof input.metric === "string" ? input.metric : "";
  const def = isMetric(metric) ? METRICS[metric] : null;
  if (!def) return bad(["metric", "unknown"]);
  let value = num(input.value);
  if (value == null) return bad(["value", "not-a-number"]);
  const unit = input.unit == null || input.unit === "" ? def.unit : String(input.unit).trim();
  if (unit.toLowerCase() !== def.unit.toLowerCase()) {
    const f = Object.prototype.hasOwnProperty.call(CONVERT, metric) && Object.prototype.hasOwnProperty.call(CONVERT[metric], unit.toLowerCase()) ? CONVERT[metric][unit.toLowerCase()] : null;
    if (!f) return bad(["unit", "unsupported"]);
    value = value * f;
  }
  value = round(value, Math.max(def.decimals, 2));
  if (value < def.min || value > def.max) return bad(["value", "implausible"]);
  const ts = normalizeTs(input.ts);
  if (!ts) return bad(["ts", "bad-date"]);
  const source = input.source == null ? "manual" : String(input.source);
  if (!SOURCE_RE.test(source)) return bad(["source", "bad-source"]);
  if (input.fileId != null && !FILEID_RE.test(String(input.fileId))) return bad(["fileId", "bad-file-id"]);
  const rec = { id: "", kind: "measurement", metric, value, unit: def.unit, ts, source };
  if (input.fileId != null) rec.fileId = String(input.fileId);
  if (Number.isInteger(input.n) && input.n >= 1 && input.n <= 10000000) rec.n = input.n;   // coverage: how many samples the day was built from
  const note = str(input.note, 200); if (note) rec.note = note;
  rec.id = input.id && /^m_[a-f0-9]{16}$/.test(input.id) ? input.id : source === "manual" ? randomId("m") : hashId("m", [metric, ts, source]);
  return { ok: true, record: rec };
}

// ---- lab result: {id, kind, test, key, value, unit, refLow?, refHigh?, optLow?, optHigh?, ts, source, fileId?}
// An ASCII key (so the agent contract's slugs can name it). A name with no ASCII letters, or with letters outside ASCII (Hebrew), gets a short hash of the
// full normalised name appended; the display name stays in `test`. Names that differ only by punctuation share a key on purpose.
function testKey(name) {
  const n = String(name).toLowerCase().normalize("NFKC").replace(/[\p{Cf}]/gu, "");
  const ascii = n.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  const full = n.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!full) return "";
  if (/^[a-z0-9 ]+$/.test(full)) return ascii;
  return (ascii ? ascii + "-" : "lab-") + crypto.createHash("sha1").update(full).digest("hex").slice(0, 8);
}
function normalizeLab(input) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  const test = str(input.test, 80);
  if (!test) return bad(["test", "missing"]);
  const key = testKey(test);
  if (!key) return bad(["test", "missing"]);
  const value = num(input.value);
  if (value == null) return bad(["value", "not-a-number"]);
  const unit = str(input.unit == null ? "" : input.unit, 24);
  const out = { id: "", kind: "lab", test, key, value, unit };
  const errs = [];
  for (const f of ["refLow", "refHigh", "optLow", "optHigh"]) {
    if (input[f] == null || input[f] === "") continue;
    const n = num(input[f]);
    if (n == null) errs.push([f, "not-a-number"]); else out[f] = n;
  }
  if (out.refLow != null && out.refHigh != null && out.refLow > out.refHigh) errs.push(["refLow", "above-high"]);
  if (out.optLow != null && out.optHigh != null && out.optLow > out.optHigh) errs.push(["optLow", "above-high"]);
  if (errs.length) return bad(...errs);
  const ts = normalizeTs(input.ts);
  if (!ts) return bad(["ts", "bad-date"]);
  out.ts = ts;
  const source = input.source == null ? "manual" : String(input.source);
  if (!SOURCE_RE.test(source)) return bad(["source", "bad-source"]);
  out.source = source;
  if (input.fileId != null && input.fileId !== "") { if (!FILEID_RE.test(String(input.fileId))) return bad(["fileId", "bad-file-id"]); out.fileId = String(input.fileId); }
  out.id = input.id && /^l_[a-f0-9]{16}$/.test(input.id) ? input.id : source === "manual" ? randomId("l") : hashId("l", [key, ts, source, out.fileId || ""]);
  return { ok: true, record: out };
}

// ---- medication / supplement: {id, kind, name, dose, schedule, medKind, start, stop, note}
function normalizeMed(input) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  const name = str(input.name, 80);
  if (!name) return bad(["name", "missing"]);
  const medKind = input.medKind == null ? "supplement" : String(input.medKind);
  if (MED_KINDS.indexOf(medKind) < 0) return bad(["medKind", "unknown"]);
  const start = input.start == null || input.start === "" ? normalizeTs(new Date(), { allowFuture: true }).slice(0, 10) : (normalizeTs(input.start, { allowFuture: true }) || "").slice(0, 10);
  if (!start) return bad(["start", "bad-date"]);
  let stop = null;
  if (input.stop != null && input.stop !== "") { stop = (normalizeTs(input.stop, { allowFuture: true }) || "").slice(0, 10); if (!stop) return bad(["stop", "bad-date"]); if (stop < start) return bad(["stop", "before-start"]); }
  const rec = { id: "", kind: "med", name, dose: str(input.dose, 60), schedule: str(input.schedule, 60), medKind, start, stop };
  const note = str(input.note, 200); if (note) rec.note = note;
  rec.id = input.id && /^d_[a-f0-9]{16}$/.test(input.id) ? input.id : randomId("d");
  return { ok: true, record: rec };
}

// ---- note: {id, kind, ts, text, tags}
function normalizeNote(input) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  const text = str(input.text, 2000);
  if (!text) return bad(["text", "missing"]);
  const ts = normalizeTs(input.ts == null ? new Date() : input.ts);
  if (!ts) return bad(["ts", "bad-date"]);
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => str(t, 24).toLowerCase()).filter(Boolean).slice(0, 8) : [];
  return { ok: true, record: { id: input.id && /^n_[a-f0-9]{16}$/.test(input.id) ? input.id : randomId("n"), kind: "note", ts, text, tags } };
}

const NORMALIZERS = { measurement: normalizeMeasurement, lab: normalizeLab, med: normalizeMed, note: normalizeNote };

module.exports = { isMetric, SCHEMA_VERSION, METRICS, CONVERT, MED_KINDS, normalizeTs, localIso, dateKey, hashId, randomId, testKey, normalizeMeasurement, normalizeLab, normalizeMed, normalizeNote, NORMALIZERS, num, round };
