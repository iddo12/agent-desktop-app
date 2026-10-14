// My Health stage 1b: biological age by the OPEN PhenoAge formula (Levine et al., Aging 2018, "An epigenetic biomarker of aging for
// lifespan and healthspan"). Nine blood markers plus age. EXPERIMENTAL: a research estimate that differs between companies and
// studies, never a diagnosis. Pure functions; the formula is exported as text so the screen can show it.
// Coefficients are as published; verify them against the paper before anyone relies on the number (listed as a risk in the report).
"use strict";
const S = require("./schema");

const DAY = 86400000;
// Each marker: accepted lab keys (slug of the test name), the unit the formula wants, and conversions from common lab units.
const MARKERS = [
  { id: "albumin", label: "Albumin", want: "g/L", coef: -0.0336, keys: ["albumin", "serum-albumin", "alb"], conv: { "g/l": 1, "g/dl": 10 } },
  { id: "creatinine", label: "Creatinine", want: "umol/L", coef: 0.0095, keys: ["creatinine", "serum-creatinine", "creat"], conv: { "umol/l": 1, "µmol/l": 1, "mg/dl": 88.4 } },
  { id: "glucose", label: "Glucose (fasting)", want: "mmol/L", coef: 0.1953, keys: ["glucose", "fasting-glucose", "glucose-fasting", "blood-glucose"], conv: { "mmol/l": 1, "mg/dl": 1 / 18.016 } },
  { id: "crp", label: "C-reactive protein", want: "mg/dL (natural log used)", coef: 0.0954, keys: ["crp", "hs-crp", "c-reactive-protein", "hscrp"], conv: { "mg/dl": 1, "mg/l": 0.1 } },
  { id: "lymphocyte", label: "Lymphocytes", want: "% of white cells", coef: -0.012, keys: ["lymphocytes", "lymphocyte", "lymphocytes-percent", "lymphocyte-percent", "lymphocytes-%", "lymph"], conv: { "%": 1, "": 1 } },
  { id: "mcv", label: "Mean cell volume (MCV)", want: "fL", coef: 0.0268, keys: ["mcv", "mean-corpuscular-volume", "mean-cell-volume"], conv: { fl: 1, "": 1 } },
  { id: "rdw", label: "Red cell distribution width (RDW)", want: "%", coef: 0.3306, keys: ["rdw", "rdw-cv", "red-cell-distribution-width"], conv: { "%": 1, "": 1 } },
  { id: "alp", label: "Alkaline phosphatase", want: "U/L", coef: 0.00188, keys: ["alkaline-phosphatase", "alp", "alk-phos"], conv: { "u/l": 1, "iu/l": 1 } },
  { id: "wbc", label: "White blood cells", want: "10^3 cells/uL", coef: 0.0554, keys: ["wbc", "white-blood-cells", "white-blood-cell-count", "leukocytes", "wbc-count"], conv: { "10^3/ul": 1, "k/ul": 1, "10^9/l": 1, "x10^9/l": 1, "10e9/l": 1, "x10^3/ul": 1, "10*3/ul": 1, "": 1 } },
];
const INTERCEPT = -19.9067, AGE_COEF = 0.0804;
const FORMULA = [
  "xb = -19.9067 - 0.0336 x albumin(g/L) + 0.0095 x creatinine(umol/L) + 0.1953 x glucose(mmol/L)",
  "     + 0.0954 x ln(CRP mg/dL) - 0.0120 x lymphocytes(%) + 0.0268 x MCV(fL) + 0.3306 x RDW(%)",
  "     + 0.00188 x alkaline phosphatase(U/L) + 0.0554 x WBC(10^3/uL) + 0.0804 x age(years)",
  "M  = 1 - exp( -1.51714 x exp(xb) / 0.0076927 )",
  "PhenoAge = 141.50225 + ln( -0.00553 x ln(1 - M) ) / 0.090165",
];

function phenoAge(values, age) {
  let xb = INTERCEPT + AGE_COEF * age;
  for (const m of MARKERS) {
    const v = values[m.id];
    xb += m.coef * (m.id === "crp" ? Math.log(Math.max(v, 0.01)) : v);   // CRP floor 0.01 mg/dL keeps ln defined
  }
  const M = 1 - Math.exp((-1.51714 * Math.exp(xb)) / 0.0076927);
  if (!(M > 0 && M < 1)) return null;
  const pa = 141.50225 + Math.log(-0.00553 * Math.log(1 - M)) / 0.090165;
  return isFinite(pa) ? pa : null;
}

// Age in years at a date, from "YYYY-MM" (the vault stores only year and month of birth).
function ageAt(birthYM, dateStr) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(birthYM || ""); if (!m) return null;
  const b = new Date(+m[1], +m[2] - 1, 15).getTime(), d = new Date(String(dateStr).slice(0, 10) + "T12:00:00").getTime();
  return isFinite(d) ? (d - b) / (365.25 * DAY) : null;
}

function convert(marker, lab) {
  const u = String(lab.unit || "").toLowerCase().replace(/\s+/g, "");
  const f = marker.conv[u];
  return f == null ? null : lab.value * f;
}

// Panel as of a date: for each marker the newest result on or before `asOf`, no older than `window` days before `asOf`.
function panelAt(labs, asOf, windowDays) {
  const out = {}, inputs = [], missing = [];
  const end = new Date(asOf).getTime(), from = end - windowDays * DAY;
  for (const m of MARKERS) {
    const cand = labs.filter((l) => m.keys.indexOf(l.key) >= 0 && new Date(l.ts).getTime() <= end && new Date(l.ts).getTime() >= from).sort((a, b) => (a.ts < b.ts ? 1 : -1));
    let hit = null;
    for (const l of cand) { const v = convert(m, l); if (v != null && isFinite(v)) { hit = { l, v }; break; } }
    if (!hit) { missing.push({ id: m.id, label: m.label, want: m.want }); continue; }
    out[m.id] = hit.v;
    inputs.push({ id: m.id, label: m.label, shown: String(Math.round(hit.l.value * 100) / 100) + (hit.l.unit ? " " + hit.l.unit : ""), used: String(Math.round(hit.v * 1000) / 1000) + " " + m.want, date: hit.l.ts.slice(0, 10), source: hit.l.source });
  }
  return { values: out, inputs, missing };
}

// The newest complete panel and the one before it (at least 30 days earlier), with the age at each.
function buildBioAge(labs, birthYM, opts) {
  const o = Object.assign({ windowDays: 180, minGapDays: 30 }, opts || {});
  const res = { experimental: true, formula: FORMULA, markers: MARKERS.map((m) => ({ id: m.id, label: m.label, want: m.want, keys: m.keys.slice(0, 3) })), birthKnown: !!ageAt(birthYM, "2000-01-01") };
  const dates = [...new Set(labs.filter((l) => MARKERS.some((m) => m.keys.indexOf(l.key) >= 0)).map((l) => l.ts.slice(0, 10)))].sort().reverse();
  let first = null, second = null;
  for (const d of dates) {
    const p = panelAt(labs, d + "T23:59:59", o.windowDays);
    if (p.missing.length === 0) {
      if (!first) first = { date: d, p };
      else if ((new Date(first.date) - new Date(d)) / DAY >= o.minGapDays) { second = { date: d, p }; break; }
    } else if (!first && !res.partial) res.partial = { date: d, inputs: p.inputs, missing: p.missing };
  }
  if (!first) { res.state = res.partial ? "incomplete" : "no-labs"; res.history = []; return res; }
  if (!res.birthKnown) { res.state = "needs-birth"; res.inputs = first.p.inputs; res.date = first.date; return res; }
  const calc = (x) => { const age = ageAt(birthYM, x.date); const pa = phenoAge(x.p.values, age); return pa == null ? null : { date: x.date, age, phenoAge: pa, diff: pa - age, inputs: x.p.inputs }; };
  const cur = calc(first); if (!cur) { res.state = "incalculable"; return res; }
  res.state = "ok"; res.current = cur; res.previous = second ? calc(second) : null;
  // the estimate over time: every complete panel (newest 12), oldest first, against the calendar age today
  const hist = [];
  for (const d of dates) { const p = panelAt(labs, d + "T23:59:59", o.windowDays); if (p.missing.length) continue; const c = calc({ date: d, p }); if (c) hist.push({ ts: d + "T00:00:00", v: c.phenoAge, s: "blood panel" }); if (hist.length >= 12) break; }
  res.history = hist.reverse();
  return res;
}

module.exports = { MARKERS, FORMULA, phenoAge, ageAt, panelAt, buildBioAge };
