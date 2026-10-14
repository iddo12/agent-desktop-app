#!/usr/bin/env node
// SYNTHETIC My Health sample files. Invented numbers from a seeded generator: no real person, no real reading, no identifiers.
// Used by tests/health.test.js and for testing a build by hand:
//   node tools/health-synthetic.js <outFolder> [endDate YYYY-MM-DD]
// then use "Import file" in My Health and choose the files (in a sandbox or test-mode instance, never to fill the real vault).
"use strict";
const fs = require("fs");
const path = require("path");

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const p2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };

function makeSamples(endDate, days) {
  const r = rng(20261007);
  const end = endDate ? new Date(endDate + "T12:00:00") : new Date();
  const N = days || 45;
  const out = {};

  // Renpho-style scale CSV (columns assumed, see importers.js)
  let w = 83.4;
  const rows = ["Time of Measurement,Weight(kg),BMI,Body Fat(%),Body Water(%),Muscle Mass(kg),Bone Mass(kg),Visceral Fat,Remarks"];
  for (let i = N - 1; i >= 0; i -= 1) {
    if (r() < 0.2) continue;
    w += (r() - 0.55) * 0.35;
    const d = addDays(end, -i);
    rows.push([ymd(d) + " 07:" + p2(10 + Math.floor(r() * 40)) + ":00", w.toFixed(1), (w / 3.1).toFixed(1), (21 + r() * 1.2).toFixed(1), (55 + r()).toFixed(1), (36.5 + r() * 0.6).toFixed(1), "3.1", "8", ""].join(","));
  }
  out["synthetic_renpho.csv"] = rows.join("\r\n") + "\r\n";

  // Fitbit Takeout JSON: 4 files, last 30 days each; heart rate and steps use the US "MM/DD/YY HH:mm:ss" stamp
  const us = (d, h, m, s) => p2(d.getMonth() + 1) + "/" + p2(d.getDate()) + "/" + String(d.getFullYear()).slice(2) + " " + p2(h) + ":" + p2(m) + ":" + p2(s);
  const hr = [], steps = [], sleep = [], rest = [];
  for (let i = 29; i >= 0; i--) {
    const d = addDays(end, -i);
    for (const h of [8, 12, 16, 20]) hr.push({ dateTime: us(d, h, 0, 5), value: { bpm: Math.round(66 + r() * 22), confidence: 2 } });
    for (let k = 0; k < 6; k++) steps.push({ dateTime: us(d, 7 + k * 2, 0, 0), value: String(Math.round(300 + r() * 1400)) });
    const asleep = Math.round(380 + r() * 90);
    sleep.push({ logId: 1000 + i, dateOfSleep: ymd(d), startTime: ymd(addDays(d, -1)) + "T23:30:00.000", duration: (asleep + 30) * 60000, minutesAsleep: asleep, minutesAwake: 30, isMainSleep: true, type: "stages" });
    if (r() < 0.2) sleep.push({ logId: 5000 + i, dateOfSleep: ymd(d), minutesAsleep: 25, isMainSleep: false });
    rest.push({ dateTime: us(d, 0, 0, 0), value: { date: ymd(d), value: Math.round((56 + r() * 5) * 10) / 10, error: 0.5 } });
  }
  const s0 = ymd(addDays(end, -29));
  out["heart_rate-" + s0 + ".json"] = JSON.stringify(hr);
  out["steps-" + s0 + ".json"] = JSON.stringify(steps);
  out["sleep-" + s0 + ".json"] = JSON.stringify(sleep);
  out["resting_heart_rate-" + s0 + ".json"] = JSON.stringify(rest);

  // Health Connect style CSV (layout assumed, see importers.js): blood pressure pairs, SpO2, a sleep session
  const hc = ["time,type,value,unit,end_time"];
  for (let i = 20; i >= 0; i -= 2) {
    const d = addDays(end, -i);
    const t = ymd(d) + " 08:15:00";
    hc.push(t + ",BloodPressureSystolic," + Math.round(118 + r() * 10) + ",mmHg,");
    hc.push(t + ",BloodPressureDiastolic," + Math.round(74 + r() * 8) + ",mmHg,");
    hc.push(t + ",OxygenSaturation," + Math.round(96 + r() * 3) + ",%,");
    hc.push(ymd(addDays(d, -1)) + " 23:20:00,SleepSession,,," + ymd(d) + " 06:40:00");
  }
  hc.push(ymd(end) + " 07:30:00,Steps,3200,count,");
  hc.push(ymd(end) + " 15:30:00,Steps,4100,count,");
  out["synthetic_healthconnect.csv"] = hc.join("\n") + "\n";

  // Labs: three results each over a year, lab range and (for some) an optional optimal zone
  const L = (test, unit, vals, refLow, refHigh, optLow, optHigh) => vals.map((v, k) => ({ test, unit, value: v, refLow, refHigh, optLow, optHigh, date: ymd(addDays(end, -(365 - k * 150))) }));
  out["synthetic_labs.json"] = JSON.stringify({ format: "lab-entries", entries: [].concat(
    L("LDL cholesterol", "mg/dL", [128, 121, 118], 0, 130, 0, 100),
    L("HbA1c", "%", [5.3, 5.4, 5.4], 4.0, 5.6, 4.6, 5.3),
    L("Vitamin D", "ng/mL", [18, 22, 24], 20, 100, 40, 60),
    L("Ferritin", "ng/mL", [92, 88, 85], 30, 400, 50, 150),
    L("hs-CRP", "mg/L", [0.8, 1.4, 3.6], 0, 3.0, 0, 1.0),
    L("TSH", "mIU/L", [1.9, 2.0, 2.1], 0.4, 4.0)) });
  // Nutrition-related labs (invented): B12 and zinc drifting down, ferritin steady
  const NL = (d, vals) => vals.map(([test, unit, v, rl, rh, ol, oh]) => ({ test, unit, value: v, refLow: rl, refHigh: rh, optLow: ol, optHigh: oh, date: ymd(addDays(end, -d)) }));
  out["synthetic_labs_nutrition.json"] = JSON.stringify({ format: "lab-entries", entries: [].concat(
    NL(200, [["Vitamin B12", "pg/mL", 410, 200, 900, 400, 900], ["Zinc", "ug/dL", 84, 70, 120]]), NL(100, [["Vitamin B12", "pg/mL", 340, 200, 900, 400, 900], ["Zinc", "ug/dL", 76, 70, 120]]), NL(14, [["Vitamin B12", "pg/mL", 262, 200, 900, 400, 900], ["Zinc", "ug/dL", 66, 70, 120]]))});
  // Blood panel for the biological-age dial: two complete nine-marker panels (invented numbers)
  const B = (d, vals) => vals.map(([test, unit, v]) => ({ test, unit, value: v, date: ymd(addDays(end, -d)) }));
  out["synthetic_labs_blood.json"] = JSON.stringify({ format: "lab-entries", entries: [].concat(
    B(150, [["Albumin", "g/dL", 4.5], ["Creatinine", "mg/dL", 0.95], ["Glucose", "mg/dL", 92], ["CRP", "mg/L", 1.2], ["Lymphocytes", "%", 31], ["MCV", "fL", 90], ["RDW", "%", 13.2], ["Alkaline phosphatase", "U/L", 68], ["WBC", "10^3/uL", 5.6]]),
    B(10, [["Albumin", "g/dL", 4.6], ["Creatinine", "mg/dL", 0.92], ["Glucose", "mg/dL", 89], ["CRP", "mg/L", 0.8], ["Lymphocytes", "%", 32], ["MCV", "fL", 90], ["RDW", "%", 12.9], ["Alkaline phosphatase", "U/L", 64], ["WBC", "10^3/uL", 5.4]])) });
  return out;
}


// Files the future Health agent will write under <store root>\agent\ (see src/health/agentfiles.js for the contract). SYNTHETIC cards:
// invented placeholder text, example.org links, no real claims. Returns {relativePath: content}.
function makeAgentFiles(endDate) {
  const end = endDate ? new Date(endDate + "T12:00:00") : new Date();
  const day = ymd(end), yday = ymd(addDays(end, -1));
  const card = (id, title, summary, why, rel, level, strength, tradition, topic, date) => ({ id, title, summary, why: { text: why, relates: rel }, evidence: { level, strength }, tradition, topic, date,
    sources: [{ title: "Example source for " + id, url: "https://doi.org/10.1000/synthetic-" + id }] });
  const out = {};
  out["agent/insights/" + day + ".json"] = JSON.stringify({ schema: 1, date: day, cards: [
    card("syn-evening-light", "SYNTHETIC: dim the lights an hour before bed", "Placeholder card. Dimmer evening light is associated with earlier sleep onset in a few small studies.", "Your sleep duration has been shorter on later bedtimes.", [{ type: "metric", id: "sleep_minutes" }], "meta-analysis", 3, "western", "sleep", day),
    card("syn-ashwagandha", "SYNTHETIC: a traditional adaptogen for stress", "Placeholder card. Used for centuries in Ayurvedic practice; modern trials are small.", "Your resting heart rate is in the upper part of your own range.", [{ type: "metric", id: "resting_hr" }, { type: "history", id: "high-stress-job" }], "single-study", 2, "ayurveda", "supplement", day),
    card("syn-tai-chi", "SYNTHETIC: gentle tai chi after dinner", "Placeholder card. Slow movement practice with some evidence for blood pressure and sleep.", "Your blood pressure readings are normal but at the upper edge of your own band.", [{ type: "metric", id: "bp_systolic" }], "meta-analysis", 3, "tcm", "practice", day),
    card("syn-olive-oil", "SYNTHETIC: olive oil as the main cooking fat", "Placeholder card. A Mediterranean dietary pattern linked to lower cardiovascular risk.", "Your LDL cholesterol is above the optimal zone you entered, and heart disease runs in the family.", [{ type: "lab", id: "ldl-cholesterol" }, { type: "history", id: "family-heart-disease" }], "guideline", 4, "mediterranean-egyptian", "nutrition", day),
    card("syn-yerba", "SYNTHETIC: yerba mate as an afternoon drink", "Placeholder card. A traditional South American drink; caffeine content affects sleep.", "You asked for traditional ideas; note your sleep duration.", [{ type: "metric", id: "sleep_minutes" }], "traditional", 1, "south-american", "nutrition", day),
    card("syn-grounding", "SYNTHETIC: barefoot grounding for 20 minutes", "Placeholder card. Early, low-quality evidence; may simply be time outdoors.", "You are interested in cutting-edge ideas.", [{ type: "history", id: "worldview-curious" }], "preclinical", 1, "other", "practice", day),
  ] });
  out["agent/insights/" + yday + ".json"] = JSON.stringify({ schema: 1, date: yday, cards: [
    card("syn-vitd", "SYNTHETIC: check vitamin D again after the winter", "Placeholder card. Re-testing shows whether a change made a difference.", "Your vitamin D is inside the lab range but below the optimal zone you entered.", [{ type: "lab", id: "vitamin-d" }], "guideline", 3, "western", "labs", yday),
  ] });
  out["agent/plan.json"] = JSON.stringify({ schema: 1, items: [
    { id: "syn-plan-vitd", group: "vitamins", title: "Vitamin D (a topic to raise with your doctor)", note: "Placeholder. No amount is suggested by the app.", why: { text: "Your vitamin D result is below the optimal zone you entered.", relates: [{ type: "lab", id: "vitamin-d" }] }, evidence: { level: "guideline", strength: 3 }, tradition: "western" },
    { id: "syn-plan-magnesium", group: "vitamins", title: "Magnesium glycinate in the evening", note: "Placeholder.", why: { text: "Short sleep on several nights.", relates: [{ type: "metric", id: "sleep_minutes" }] }, evidence: { level: "single-study", strength: 2 }, tradition: "western" },
    { id: "syn-plan-zone2", group: "exercise", title: "Easy aerobic sessions (zone 2)", note: "Placeholder.", why: { text: "Resting heart rate in the upper part of your range.", relates: [{ type: "metric", id: "resting_hr" }] }, evidence: { level: "meta-analysis", strength: 3 }, tradition: "western" },
    { id: "syn-plan-breath", group: "practice", title: "Slow breathing before bed (pranayama)", note: "Placeholder.", why: { text: "You like traditional practices.", relates: [{ type: "history", id: "worldview-curious" }] }, evidence: { level: "traditional", strength: 2 }, tradition: "ayurveda" },
    { id: "syn-plan-dose", group: "vitamins", title: "Take 5000 IU daily", note: "This one has a dose and is refused on read.", why: { text: "x", relates: [] }, evidence: { level: "anecdote", strength: 1 } },
  ] });
  out["agent/trend_notes.json"] = JSON.stringify({ schema: 1, notes: { weight: { text: "Placeholder note from the agent: steady over the last weeks.", date: day }, "ldl-cholesterol": { text: "Placeholder note: three results, each a little lower.", date: day } } });
  out["agent/worldview.md"] = "# How you think about health (SYNTHETIC placeholder)\n\nYou prefer evidence first, but you are open to traditional practices when they are low risk.\nYou want ideas that fit a busy week, not a rebuild of your life.\nFamily history on record: heart disease (label only).\n\nTo change this, tell the Health agent what to update.\n";
  return out;
}

// Stage 1b agent files (SYNTHETIC, same rules as above) and the app's own routines.json.
function makeAgentFiles2(endDate) {
  const LG = require("../src/health/longevity");
  const end = endDate ? new Date(endDate + "T12:00:00") : new Date();
  const wk = LG.prevWeek(LG.isoWeek(end));
  const src = (id) => [{ title: "Example source " + id, url: "https://pubmed.ncbi.nlm.nih.gov/12345678/" }];
  const out = {};
  out["agent/interactions.json"] = JSON.stringify({ schema: 1, checked: ymd(end), pairs: [
    { id: "syn-ix-1", a: "Synthetic magnesium", b: "Synthetic multivitamin", severity: "timing", summary: "Placeholder: minerals can compete for absorption, so many people take them at different times of day.", sources: src("ix1") },
    { id: "syn-ix-2", a: "Synthetic vitamin D", b: "Synthetic omega", severity: "info", summary: "Placeholder: no known problem when taken together; fat-containing meals help absorption.", sources: src("ix2") },
    { id: "syn-ix-3", a: "Synthetic herb X", b: "Synthetic blood thinner", severity: "serious", summary: "Placeholder: a pair that needs a pharmacist before anyone combines them.", sources: [{ title: "Not on the allow-list", url: "https://example.org/x" }] },
    { id: "syn-ix-4", a: "Synthetic magnesium", b: "Synthetic antacid 300 mg", severity: "caution", summary: "Placeholder with an amount in the name: refused on read.", sources: [] },
  ] });
  const ev = (level, strength, note) => ({ level, strength, note });
  out["agent/evidence.json"] = JSON.stringify({ schema: 1, items: [
    { id: "syn-ev-vitd", name: "Vitamin D (synthetic)", kind: "supplement", tradition: "western", summary: "Placeholder summary.", evidence: [ev("guideline", 4, "for low levels"), ev("meta-analysis", 3, "mixed on other outcomes")], sources: src("vitd") },
    { id: "syn-ev-turmeric", name: "Turmeric (synthetic)", kind: "supplement", tradition: "ayurveda", summary: "Placeholder: used for centuries in India.", evidence: [ev("traditional", 5, "very long documented use"), ev("single-study", 2, "small trials"), ev("preclinical", 3, "")], sources: src("turmeric") },
    { id: "syn-ev-taichi", name: "Tai chi (synthetic)", kind: "practice", tradition: "tcm", summary: "Placeholder.", evidence: [ev("meta-analysis", 3, "balance and blood pressure"), ev("traditional", 4, "")], sources: [] },
    { id: "syn-ev-zone2", name: "Zone 2 training (synthetic)", kind: "exercise", tradition: "western", summary: "Placeholder.", evidence: [ev("guideline", 4, "general aerobic activity"), ev("anecdote", 2, "coaching practice")], sources: [] },
    { id: "syn-ev-sauna", name: "Heat bathing (synthetic)", kind: "therapy", tradition: "mediterranean-egyptian", summary: "Placeholder: ancient bathing traditions.", evidence: [ev("traditional", 4, "ancient baths"), ev("single-study", 3, "cohort data")], sources: [] },
    { id: "syn-ev-yerba", name: "Yerba mate (synthetic)", kind: "supplement", tradition: "south-american", summary: "Placeholder.", evidence: [ev("traditional", 3, ""), ev("preclinical", 2, "")], sources: [] },
  ] });
  out["agent/weekly/" + wk + ".json"] = JSON.stringify({ schema: 1, week: wk, summary: "Placeholder review: a steady week with a little more movement.", changed: ["Placeholder: you added a daily push-up routine.", "Placeholder: bedtime drifted later on two nights."],
    improved: [{ label: "Steps", text: "Placeholder: higher than the week before." }], worsened: [{ label: "Sleep", text: "Placeholder: a little shorter on average." }], experiments: ["Placeholder: the evening-light experiment is on day 6."], questions: ["Placeholder: would you like a second look at your vitamin D result with your doctor?"] });
  out["agent/reading.json"] = JSON.stringify({ schema: 1, items: [
    { id: "syn-read-1", title: "SYNTHETIC: a review of evening light and sleep", kind: "paper", authors: "A. Placeholder et al.", year: 2021, minutes: 7, evidence: { level: "meta-analysis", strength: 3 }, tradition: "western", source: { title: "Example paper", url: "https://pubmed.ncbi.nlm.nih.gov/12345678/" },
      points: ["Placeholder key point one: dim light before bed is linked to earlier sleep.", "Placeholder key point two: effects are small but consistent.", "Placeholder key point three: studies were short.", "Placeholder key point four: your own sleep log is the best test."], relates: [{ type: "metric", id: "sleep_minutes" }] },
    { id: "syn-read-2", title: "SYNTHETIC: a classical text on diet and seasons", kind: "historical", authors: "Ancient Placeholder", year: -300, minutes: 5, evidence: { level: "traditional", strength: 4 }, tradition: "mediterranean-egyptian", source: { title: "Example source", url: "https://doi.org/10.1000/synthetic" },
      points: ["Placeholder: moderation in meals is stressed.", "Placeholder: regular walking is recommended.", "Placeholder: the text is observation, not trial data."], relates: [] },
  ] });
  const rc = (id, title, extra) => Object.assign({ id, title, vegan: true, minutes: 30, servings: 4, season: "all-year", availability: "Available year-round in Israel", date: ymd(end), steps: ["Placeholder step one.", "Placeholder step two."], sources: [{ title: "Example source", url: "https://pubmed.ncbi.nlm.nih.gov/12345678/" }] }, extra);
  out["agent/recipes/" + ymd(end) + ".json"] = JSON.stringify({ schema: 1, date: ymd(end), recipes: [
    rc("syn-rc-lentil", "SYNTHETIC: red lentil and spinach stew", { minutes: 35, season: "winter", availability: "Spinach is in season in winter",
      ingredients: [{ item: "Red lentils", amount: "200 g" }, { item: "Spinach", amount: "150 g" }, { item: "Onion", amount: "1" }, { item: "Lemon", amount: "1" }, { item: "Olive oil", amount: "2 tbsp" }],
      nutrients: [{ name: "Protein", perServing: "18 g" }, { name: "Iron", perServing: "5 mg", note: "pair with the lemon (vitamin C)" }, { name: "Fibre", perServing: "11 g" }, { name: "Zinc", perServing: "2.4 mg" }],
      why: { text: "Your zinc has been drifting down and your iron markers are worth keeping steady.", relates: [{ type: "lab", id: "zinc" }, { type: "lab", id: "ferritin" }] }, evidence: { level: "guideline", strength: 3 }, evidenceNote: "Legumes are a standard plant source of iron and zinc; vitamin C helps iron absorption.", medical: false }),
    rc("syn-rc-b12", "SYNTHETIC: fortified oat porridge with seeds", { minutes: 10, servings: 2, season: "all-year",
      ingredients: [{ item: "Rolled oats", amount: "100 g" }, { item: "Fortified plant milk", amount: "300 ml" }, { item: "Pumpkin seeds", amount: "30 g" }, { item: "Ground flax", amount: "2 tbsp" }, { item: "Olive oil", amount: "1 tbsp" }],
      nutrients: [{ name: "B12", perServing: "1.2 ug", note: "from the fortified milk: check the label" }, { name: "Omega-3 (ALA)", perServing: "2.4 g" }, { name: "Zinc", perServing: "3.1 mg" }, { name: "Calcium", perServing: "240 mg" }],
      why: { text: "Your B12 has fallen in each of its last three results.", relates: [{ type: "lab", id: "vitamin-b12" }] }, evidence: { level: "single-study", strength: 2 }, evidenceNote: "Fortified foods are one route to B12 on a vegan diet; this is for you to review with your doctor.", medical: true }),
    rc("syn-rc-tahini", "SYNTHETIC: chickpea and tahini bowl with honey dressing", { minutes: 20, season: "summer", availability: "Cucumbers and tomatoes peak in summer",
      ingredients: [{ item: "Chickpeas, cooked", amount: "400 g" }, { item: "Tahini", amount: "3 tbsp" }, { item: "Cucumber", amount: "2" }, { item: "Honey", amount: "1 tsp" }, { item: "Lemon", amount: "1" }],
      nutrients: [{ name: "Protein", perServing: "14 g" }, { name: "Calcium", perServing: "180 mg" }, { name: "Fibre", perServing: "9 g" }],
      why: { text: "A simple high-fibre meal.", relates: [{ type: "lab", id: "ldl-cholesterol" }] }, evidence: { level: "meta-analysis", strength: 3 }, medical: false }),
    { id: "syn-rc-notvegan", title: "SYNTHETIC: refused, vegan flag false", vegan: false, ingredients: [{ item: "Cheese", amount: "100 g" }], steps: ["x"] },
  ] });
  return out;
}
function makeRoutines(endDate) {
  const end = endDate ? new Date(endDate + "T12:00:00") : new Date();
  const log = (perDay, doneList) => { const l = {}; doneList.forEach((d, i) => { l[ymd(addDays(end, -(doneList.length - i)))] = { done: d, skipped: d === -1 }; }); for (const k of Object.keys(l)) if (l[k].done === -1) l[k].done = 0; return l; };
  return JSON.stringify({ schema: 1, quiet: { start: "22:00", end: "07:00" }, snoozeUntil: null, items: [
    { id: "r_00000000000000a1", title: "Push-ups", unit: "push-ups", chunk: 10, perDay: 5, template: "pushups", paused: false, created: ymd(addDays(end, -20)), reminders: { enabled: false, times: [] }, log: log(5, [5, 5, 5, 3, 5, 5]) },
    { id: "r_00000000000000a2", title: "Water", unit: "glass", chunk: 1, perDay: 8, template: "water", paused: false, created: ymd(addDays(end, -20)), reminders: { enabled: false, times: [] }, log: log(8, [8, 6, -1, 8, 8, 8]) },
    { id: "r_00000000000000a3", title: "Pull-up", unit: "pull-up", chunk: 1, perDay: 8, template: "pullups", paused: false, created: ymd(addDays(end, -4)), reminders: { enabled: false, times: [] }, log: log(8, [2, 8]) },
  ] }) + "\n";
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write("usage: node tools/health-synthetic.js <outFolder> [endDate]\n"); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  const files = makeSamples(process.argv[3]);
  for (const f of Object.keys(files)) fs.writeFileSync(path.join(dir, f), files[f]);
  const af = Object.assign(makeAgentFiles(process.argv[3]), makeAgentFiles2(process.argv[3]), { "routines.json": makeRoutines(process.argv[3]) });
  for (const f of Object.keys(af)) { const t = path.join(dir, "agent-sample", f); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, af[f]); }
  process.stdout.write("wrote " + Object.keys(files).length + " synthetic files to " + dir + "\n");
}
module.exports = { makeSamples, makeAgentFiles, makeAgentFiles2, makeRoutines };
