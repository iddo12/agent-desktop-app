// My Health stage 1 (scope extension): the FILE CONTRACT between the app and the future Health & Longevity agent.
// Everything lives in ONE folder, <store root>\agent\ (inside the vault, so EFS-encrypted and outside Dropbox):
//
//   insights\YYYY-MM-DD.json   written by the AGENT  {schema:1, date, cards:[insight...]}          (app: read only)
//   plan.json                  written by the AGENT  {schema:1, items:[planItem...]}                 (app: read only)
//   trend_notes.json           written by the AGENT  {schema:1, notes:{<metric id|lab key>:{text,date}}} (app: read only)
//   worldview.md               written by the AGENT  "How the owner thinks about health" summary, plain text (app: read only)
//   state.json                 written by the APP    {schema:1, insights:{id:status}, plan:{id:status}} (atomic rewrite)
//   experiments.json           written by the APP    {schema:1, items:[experiment...]}                 (atomic rewrite; the agent may read it)
//   feedback.jsonl             APPENDED by the app   one JSON object per line: what the owner pressed, so the agent can learn
//
// The app never sends any of this to a model or another agent in stage 1. Text the owner types (experiment notes) stays in these files.
// PRIVACY: validators return {field, code} errors only, never the offending text. Nothing here logs.
// "Why this is for you" refs point at things in the store by id/label (metric id, lab key, med id, or a short history label such as
// "family-heart-disease"): slug-shaped only, so free identifiers (names, ID numbers) cannot ride along.
"use strict";
const fs = require("fs");
const path = require("path");
const S = require("./schema");
const DF = require("./dosefilter");
const LP = require("./linkpolicy");
const AT = require("./atomic");

const EVIDENCE = ["guideline", "meta-analysis", "single-study", "preclinical", "traditional", "anecdote"];
const EVIDENCE_LABEL = { guideline: "Guideline", "meta-analysis": "Meta-analysis", "single-study": "Single study", preclinical: "Preclinical", traditional: "Traditional / historical", anecdote: "Anecdote" };
const TRADITIONS = ["western", "ayurveda", "tcm", "south-american", "mediterranean-egyptian", "other"];
const TRADITION_LABEL = { western: "Western", ayurveda: "Ayurveda", tcm: "TCM", "south-american": "South American", "mediterranean-egyptian": "Mediterranean / Egyptian", other: "Other" };
const TOPICS = ["sleep", "nutrition", "supplement", "medicine", "exercise", "practice", "labs", "stress", "other"];
const INTERVENTION_TOPICS = ["sleep", "nutrition", "supplement", "medicine", "exercise", "practice", "stress"];   // anything a reader might DO: the doctor line is always shown (only "labs" and "other" are exempt unless flagged)
const INSIGHT_STATUS = ["new", "saved", "tried", "dismissed"];
const PLAN_GROUPS = ["vitamins", "exercise", "practice"];
const PLAN_STATUS = ["considering", "discussing", "trying", "stopped"];
const EXP_STATUS = ["running", "kept", "dropped"];
const FEEDBACK_TYPES = ["useful", "not-for-me", "try-it", "save", "dismiss", "plan-status", "experiment-note", "experiment-verdict", "reading-read", "reading-note", "cooked", "recipe-save", "recipe-dismiss", "recipe-shop"];
const DOCTOR_LINE = "Discuss with your doctor before trying this.";

const MAX_AGENT_FILE = 2 * 1024 * 1024;   // bytes; every agent-written JSON file
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// A dose-looking amount. The app never recommends a dose, so plan items that carry one are refused (the agent keeps doses out).
const DOSE_RE = /\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|ug|iu|g|ml|mmol|units?)\b/i;
const bad = (...f) => ({ ok: false, errors: f.map(([field, code]) => ({ field, code })) });
const str = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").replace(/\p{Cf}/gu, (c) => (c === "\u200e" || c === "\u200f" ? c : "")).trim().slice(0, max) : "");
// Amount scrubber: every agent text that could carry a supplement or medicine amount goes through c(); removed counts the neutralised sentences.
function scrubber() { let removed = 0; return { c(t, strict) { const r = DF.clean(t, { strict: !!strict }); removed += r.removed; return r.text; }, get removed() { return removed; } }; }

function normalizeRelates(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list.slice(0, 12) : []) {
    if (!r || typeof r !== "object") continue;
    const type = ["metric", "lab", "med", "history"].indexOf(r.type) >= 0 ? r.type : null;
    const id = typeof r.id === "string" && SLUG.test(r.id) ? r.id : null;
    if (type && id) out.push({ type, id });
  }
  return out;
}
function normalizeSources(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list.slice(0, 8) : []) {
    if (!x || typeof x !== "object") continue;
    const p = LP.parse(typeof x.url === "string" ? x.url : ""); if (!p.ok) continue;
    out.push({ title: DF.clean(str(x.title, 160)).text || p.host, url: p.href, host: p.host, allowed: p.allowed });   // url is rebuilt from the parsed parts, query and fragment dropped
  }
  return out;
}
function normalizeEvidence(e) {
  if (!e || EVIDENCE.indexOf(e.level) < 0) return null;
  const strength = Number.isInteger(e.strength) && e.strength >= 1 && e.strength <= 5 ? e.strength : null;
  return { level: e.level, strength };
}

function normalizeInsight(input, fileDate) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  if (typeof input.id !== "string" || !SLUG.test(input.id)) return bad(["id", "bad-id"]);
  const title = str(input.title, 140); if (!title) return bad(["title", "missing"]);
  const summary = str(input.summary, 900); if (!summary) return bad(["summary", "missing"]);
  const evidence = normalizeEvidence(input.evidence); if (!evidence) return bad(["evidence", "bad-level"]);
  const tradition = input.tradition == null ? "western" : String(input.tradition);
  if (TRADITIONS.indexOf(tradition) < 0) return bad(["tradition", "unknown"]);
  const topic = input.topic == null ? "other" : String(input.topic);
  if (TOPICS.indexOf(topic) < 0) return bad(["topic", "unknown"]);
  const date = S.normalizeTs(fileDate || input.date, { allowFuture: true }); if (!date) return bad(["date", "bad-date"]);   // the FILE date wins: a card cannot fake "new today"
  const why = input.why && typeof input.why === "object" ? input.why : {};
  const m = scrubber(), strictMode = topic === "supplement" || topic === "medicine";
  const rec = { id: input.id, title: m.c(title, strictMode), summary: m.c(summary, strictMode), why: { text: m.c(str(why.text, 500), strictMode), relates: normalizeRelates(why.relates) }, evidence, tradition, topic,
    sources: normalizeSources(input.sources), date: date.slice(0, 10), intervention: INTERVENTION_TOPICS.indexOf(topic) >= 0 || input.intervention === true };
  rec.amountRemoved = m.removed > 0;
  return { ok: true, record: rec };
}
function normalizePlanItem(input) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  if (typeof input.id !== "string" || !SLUG.test(input.id)) return bad(["id", "bad-id"]);
  const group = String(input.group); if (PLAN_GROUPS.indexOf(group) < 0) return bad(["group", "unknown"]);
  const title = str(input.title, 140); if (!title) return bad(["title", "missing"]);
  const evidence = normalizeEvidence(input.evidence); if (!evidence) return bad(["evidence", "bad-level"]);
  const why = input.why && typeof input.why === "object" ? input.why : {};
  const note = str(input.note, 400), whyText = str(why.text, 500);
  const tradition = input.tradition == null ? "western" : String(input.tradition);
  if (TRADITIONS.indexOf(tradition) < 0) return bad(["tradition", "unknown"]);
  const m = scrubber(), strictMode = group === "vitamins";   // vitamins: any number that is not a year or a duration is neutralised
  return { ok: true, record: { id: input.id, group, title: m.c(title, strictMode), note: m.c(note, strictMode), why: { text: m.c(whyText, strictMode), relates: normalizeRelates(why.relates) }, evidence, tradition, sources: normalizeSources(input.sources), amountRemoved: m.removed > 0 } };
}
function normalizeExperiment(input) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  if (typeof input.id !== "string" || !/^e_[a-f0-9]{16}$/.test(input.id)) return bad(["id", "bad-id"]);
  const title = str(input.title, 140); if (!title) return bad(["title", "missing"]);
  const start = (S.normalizeTs(input.start, { allowFuture: true }) || "").slice(0, 10); if (!start) return bad(["start", "bad-date"]);
  const metricKind = input.metricKind === "lab" ? "lab" : "metric";
  const metric = input.metric == null || input.metric === "" ? null : String(input.metric);
  if (metric && (metricKind === "metric" ? !S.isMetric(metric) : !SLUG.test(metric))) return bad(["metric", "unknown"]);
  const status = input.status == null ? "running" : String(input.status); if (EXP_STATUS.indexOf(status) < 0) return bad(["status", "unknown"]);
  const notes = (Array.isArray(input.notes) ? input.notes : []).slice(-200).map((n) => ({ ts: S.normalizeTs(n && n.ts, { allowFuture: true }) || S.localIso(new Date()), text: str(n && n.text, 1000) })).filter((n) => n.text);
  const stop = input.stop ? (S.normalizeTs(input.stop, { allowFuture: true }) || "").slice(0, 10) || null : null;
  return { ok: true, record: { id: input.id, title, start, stop, metric, metricKind, status, verdictNote: str(input.verdictNote, 600), fromInsight: input.fromInsight && SLUG.test(input.fromInsight) ? input.fromInsight : null, notes } };
}
function normalizeFeedback(input) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  if (FEEDBACK_TYPES.indexOf(input.type) < 0) return bad(["type", "unknown"]);
  if (["insight", "plan", "experiment", "reading", "recipe"].indexOf(input.target) < 0) return bad(["target", "unknown"]);
  if (typeof input.id !== "string" || !(SLUG.test(input.id) || /^e_[a-f0-9]{16}$/.test(input.id))) return bad(["id", "bad-id"]);
  const rec = { ts: S.localIso(new Date(input.now || Date.now())), type: input.type, target: input.target, id: input.id };
  if (input.value != null) { const v = str(String(input.value), 40); if (v) rec.value = v; }
  const note = str(input.note, 1000); if (note) rec.note = note;
  return { ok: true, record: rec };
}


// ---------------------------------------------------------------- stage 1b: interactions, evidence map, weekly review, reading list
const SEVERITY = ["info", "timing", "caution", "serious"];
const SEVERITY_LABEL = { info: "For information", timing: "Timing note", caution: "Caution", serious: "Serious: ask before combining" };
const EVIDENCE_KINDS = ["supplement", "practice", "exercise", "therapy"];
const READING_KINDS = ["paper", "book", "historical", "article"];
const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const noDose = (...texts) => texts.every((t) => !DOSE_RE.test(t || ""));
const strList = (v, max, each) => (Array.isArray(v) ? v.slice(0, max).map((x) => str(x, each)).filter(Boolean) : []);

function normalizeInteraction(input) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  if (typeof input.id !== "string" || !SLUG.test(input.id)) return bad(["id", "bad-id"]);
  const a = str(input.a, 60), b = str(input.b, 60); if (!a || !b) return bad(["pair", "missing"]);
  const severity = String(input.severity); if (SEVERITY.indexOf(severity) < 0) return bad(["severity", "unknown"]);
  const summary = str(input.summary, 500); if (!summary) return bad(["summary", "missing"]);
  const m = scrubber();
  return { ok: true, record: { id: input.id, a: m.c(a), b: m.c(b), severity, summary: m.c(summary), sources: normalizeSources(input.sources), amountRemoved: m.removed > 0 } };
}
function normalizeEvidenceItem(input) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  if (typeof input.id !== "string" || !SLUG.test(input.id)) return bad(["id", "bad-id"]);
  const name = str(input.name, 80); if (!name) return bad(["name", "missing"]);
  const kind = String(input.kind); if (EVIDENCE_KINDS.indexOf(kind) < 0) return bad(["kind", "unknown"]);
  const tradition = input.tradition == null ? "western" : String(input.tradition); if (TRADITIONS.indexOf(tradition) < 0) return bad(["tradition", "unknown"]);
  const types = []; const seen = new Set();
  for (const e of Array.isArray(input.evidence) ? input.evidence.slice(0, 6) : []) {
    const n = normalizeEvidence(e); if (!n || !n.strength || seen.has(n.level)) continue; seen.add(n.level);
    types.push({ level: n.level, strength: n.strength, note: str(e.note, 200) });
  }
  if (!types.length) return bad(["evidence", "none"]);
  const summary = str(input.summary, 500);
  const m = scrubber();
  return { ok: true, record: { id: input.id, name: m.c(name), kind, tradition, summary: m.c(summary), evidence: types.map((t) => Object.assign({}, t, { note: m.c(t.note) })), max: Math.max(...types.map((t) => t.strength)), sources: normalizeSources(input.sources), amountRemoved: m.removed > 0 } };
}
function normalizeWeekly(input, fileWeek) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  const week = String(input.week || fileWeek); if (!WEEK_RE.test(week)) return bad(["week", "bad-week"]);
  const summary = str(input.summary, 1200);
  const pair = (l) => (Array.isArray(l) ? l.slice(0, 12).map((x) => ({ label: str(x && x.label, 60), text: str(x && x.text, 300) })).filter((x) => x.text) : []);
  const rec = { week, summary, changed: strList(input.changed, 10, 300), improved: pair(input.improved), worsened: pair(input.worsened), experiments: strList(input.experiments, 10, 300), questions: strList(input.questions, 8, 300) };
  const m = scrubber();
  rec.summary = m.c(rec.summary); rec.changed = rec.changed.map((x) => m.c(x)); rec.experiments = rec.experiments.map((x) => m.c(x)); rec.questions = rec.questions.map((x) => m.c(x));
  rec.improved = rec.improved.map((x) => ({ label: x.label, text: m.c(x.text) })); rec.worsened = rec.worsened.map((x) => ({ label: x.label, text: m.c(x.text) })); rec.amountRemoved = m.removed > 0;
  return { ok: true, record: rec };
}
function normalizeReading(input) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  if (typeof input.id !== "string" || !SLUG.test(input.id)) return bad(["id", "bad-id"]);
  const title = str(input.title, 200); if (!title) return bad(["title", "missing"]);
  const kind = input.kind == null ? "paper" : String(input.kind); if (READING_KINDS.indexOf(kind) < 0) return bad(["kind", "unknown"]);
  const points = strList(input.points, 8, 300); if (points.length < 3 || points.length > 6) return bad(["points", "need-3-to-6"]);
  const evidence = normalizeEvidence(input.evidence); if (!evidence) return bad(["evidence", "bad-level"]);
  const tradition = input.tradition == null ? "western" : String(input.tradition); if (TRADITIONS.indexOf(tradition) < 0) return bad(["tradition", "unknown"]);
  const src = normalizeSources(input.source ? [input.source] : [])[0] || null;
  const mins = Number.isInteger(input.minutes) && input.minutes >= 1 && input.minutes <= 600 ? input.minutes : null;
  const year = Number.isInteger(input.year) && input.year >= -3000 && input.year <= 2100 ? input.year : null;
  const m = scrubber();
  return { ok: true, record: { id: input.id, title: m.c(title), kind, authors: str(input.authors, 120), year, points: points.map((x) => m.c(x)), minutes: mins, evidence, tradition, source: src, relates: normalizeRelates(input.relates), amountRemoved: m.removed > 0 } };
}


// ---------------------------------------------------------------- stage 1b: recipes (Nutrition). FOOD amounts are normal here: the supplement dose filter is NOT applied.
const SEASONS = ["spring", "summer", "autumn", "winter", "all-year"];
const RECIPE_IMAGE_RE = /^images\/[a-z0-9_-]{1,60}\.(png|jpg|jpeg|webp)$/;
const ANIMAL_RE = /\b(milk|eggs?|honey|chicken|beef|pork|lamb|turkey|fish|salmon|tuna|shrimp|prawns?|cheese|butter|yogh?urt|cream|gelatin|whey|casein|lard|mayonnaise|ghee|bacon|anchov\w*)\b/i;
const PLANT_RE = /\b(coconut|almond|oat|soy|soya|rice|cashew|plant|vegan|peanut|nut|hemp|cocoa|shea|sunflower|dairy-free|egg-free|butter beans?|flax|chia|tofu|tempeh|aquafaba)\b/i;

function normalizeRecipe(input, fileDate) {
  if (!input || typeof input !== "object") return bad(["record", "not-an-object"]);
  if (typeof input.id !== "string" || !SLUG.test(input.id)) return bad(["id", "bad-id"]);
  const title = str(input.title, 140); if (!title) return bad(["title", "missing"]);
  if (input.vegan !== true) return bad(["vegan", "must-be-true"]);
  const ingredients = (Array.isArray(input.ingredients) ? input.ingredients.slice(0, 40) : []).map((x) => ({ item: str(x && x.item, 80), amount: str(x && x.amount, 40) })).filter((x) => x.item);
  if (!ingredients.length) return bad(["ingredients", "none"]);
  const steps = strList(input.steps, 20, 400); if (!steps.length) return bad(["steps", "none"]);
  const minutes = Number.isInteger(input.minutes) && input.minutes >= 1 && input.minutes <= 600 ? input.minutes : null;
  const servings = Number.isInteger(input.servings) && input.servings >= 1 && input.servings <= 50 ? input.servings : null;
  const nutrients = (Array.isArray(input.nutrients) ? input.nutrients.slice(0, 14) : []).map((n) => ({ name: str(n && n.name, 30), perServing: str(n && n.perServing, 40), note: str(n && n.note, 120) })).filter((n) => n.name && n.perServing);
  const why = input.why && typeof input.why === "object" ? input.why : {};
  const evidence = input.evidence && EVIDENCE.indexOf(input.evidence.level) >= 0 ? normalizeEvidence(input.evidence) : null;
  const season = SEASONS.indexOf(input.season) >= 0 ? input.season : "all-year";
  const image = typeof input.image === "string" && RECIPE_IMAGE_RE.test(input.image) ? input.image : null;
  const date = (S.normalizeTs(fileDate || input.date, { allowFuture: true }) || "").slice(0, 10); if (!date) return bad(["date", "bad-date"]);
  const veganCheck = ingredients.filter((x) => ANIMAL_RE.test(x.item) && !PLANT_RE.test(x.item)).map((x) => x.item).slice(0, 5);
  return { ok: true, record: { id: input.id, title, minutes, servings, vegan: true, ingredients, steps, nutrients, why: { text: str(why.text, 500), relates: normalizeRelates(why.relates) }, evidence,
    evidenceNote: str(input.evidenceNote, 300), sources: normalizeSources(input.sources), season, availability: str(input.availability, 80), image, medical: input.medical === true, date, veganCheck } };
}

// ---------------------------------------------------------------- IO
function createAgentFiles(root, opts) {
  const dir = path.join(root, "agent");
  const fsx = (opts && opts.fs) || fs;
  const p = (...a) => path.join(dir, ...a);
  function readJson(file) {
    // Size cap (review F4): a runaway agent or hostile file must not freeze the app with a gigabyte read and parse. Stat first.
    try { const st = fsx.statSync(file); if (!st.isFile() || st.size > MAX_AGENT_FILE) return { ok: false, tooBig: true }; } catch (e) { return { ok: false, missing: e.code === "ENOENT" }; }
    try { const raw = fsx.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); return { ok: true, json: JSON.parse(raw) }; }
    catch (e) { return { ok: false, missing: e.code === "ENOENT" }; }
  }
  function writeJson(file, obj) { AT.write(fsx, file, JSON.stringify(obj) + "\n"); }
  function readState() { const r = readJson(p("state.json")); const s = r.ok && r.json && typeof r.json === "object" ? r.json : {}; const o = (x) => Object.assign(Object.create(null), x && typeof x === "object" ? x : {}); return { schema: 1, insights: o(s.insights), plan: o(s.plan), reading: o(s.reading), recipes: o(s.recipes) }; }

  // Insight cards from the newest `days` day-files (default 14), newest first, each with its status from state.json.
  function readInsights(days) {
    let names = [];
    try { names = fsx.readdirSync(p("insights")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, days || 14); } catch (e) { /* none yet */ }
    const state = readState(); const cards = []; let rejected = 0, files = 0; const seen = new Set();
    for (const f of names) {
      const r = readJson(p("insights", f)); if (!r.ok || !r.json || !Array.isArray(r.json.cards)) { rejected++; continue; }
      files++;
      for (const c of r.json.cards.slice(0, 60)) {
        const n = normalizeInsight(c, f.slice(0, 10)); if (!n.ok) { rejected++; continue; }
        if (seen.has(n.record.id)) continue; seen.add(n.record.id);
        const st = state.insights[n.record.id]; n.record.status = INSIGHT_STATUS.indexOf(st) >= 0 ? st : "new";
        cards.push(n.record);
      }
    }
    return { cards, rejected, files };
  }
  function readPlan() {
    const r = readJson(p("plan.json")); const state = readState(); const items = []; let rejected = 0;
    if (r.ok && r.json && Array.isArray(r.json.items)) for (const it of r.json.items.slice(0, 200)) { const n = normalizePlanItem(it); if (!n.ok) { rejected++; continue; } n.record.status = PLAN_STATUS.indexOf(state.plan[n.record.id]) >= 0 ? state.plan[n.record.id] : "considering"; items.push(n.record); }
    return { items, rejected };
  }
  function readTrendNotes() {
    const r = readJson(p("trend_notes.json")); const out = Object.create(null);
    if (r.ok && r.json && r.json.notes && typeof r.json.notes === "object") for (const k of Object.keys(r.json.notes).slice(0, 200)) { const n = r.json.notes[k]; if (SLUG.test(k) && n && typeof n.text === "string") out[k] = { text: DF.clean(str(n.text, 800)).text, date: (S.normalizeTs(n.date, { allowFuture: true }) || "").slice(0, 10) }; }
    return out;
  }
  function readWorldview() {
    try { const st = fsx.statSync(p("worldview.md")); if (st.size > 40000) return { text: "", tooBig: true }; return { text: DF.clean(str(fsx.readFileSync(p("worldview.md"), "utf8").replace(/^\uFEFF/, ""), 40000)).text, mtime: S.localIso(st.mtime).slice(0, 10) }; }
    catch (e) { return { text: "" }; }
  }
  function readExperiments() {
    const r = readJson(p("experiments.json")); const items = [];
    if (r.ok && r.json && Array.isArray(r.json.items)) for (const it of r.json.items.slice(0, 200)) { const n = normalizeExperiment(it); if (n.ok) items.push(n.record); }
    return items;
  }


  // ---- stage 1b readers (agent files, read only) and the reading state (app-written, in state.json)
  function readList(file, key, norm, cap) {
    const r = readJson(file); const out = []; let rejected = 0; let meta = {};
    if (r.ok && r.json && Array.isArray(r.json[key])) { for (const it of r.json[key].slice(0, cap)) { const n = norm(it); if (n.ok) out.push(n.record); else rejected++; } meta = r.json; }
    return { items: out, rejected, meta };
  }
  function readInteractions() { const r = readList(p("interactions.json"), "pairs", normalizeInteraction, 300); return { pairs: r.items, rejected: r.rejected, checked: (S.normalizeTs(r.meta.checked, { allowFuture: true }) || "").slice(0, 10) }; }
  function readEvidenceMap() { const r = readList(p("evidence.json"), "items", normalizeEvidenceItem, 300); return { items: r.items, rejected: r.rejected }; }
  function readReading() {
    const r = readList(p("reading.json"), "items", normalizeReading, 300); const st = readState().reading;
    return { items: r.items.map((i) => { const e = st[i.id]; return Object.assign({}, i, { read: !!(e && e.read === true), note: e && typeof e.note === "string" ? e.note : "" }); }), rejected: r.rejected };
  }
  function listWeeks() { try { return fsx.readdirSync(p("weekly")).map((f) => f.replace(/\.json$/, "")).filter((w) => WEEK_RE.test(w)).sort().reverse().slice(0, 60); } catch (e) { return []; } }
  function readWeek(week) {
    if (!WEEK_RE.test(String(week))) return null;
    const r = readJson(p("weekly", week + ".json")); if (!r.ok) return null;
    const n = normalizeWeekly(r.json, week); return n.ok ? n.record : null;
  }
  function setReading(id, patch) {
    if (!SLUG.test(String(id))) return bad(["id", "bad-id"]);
    const s = readState(); const cur = s.reading[id] && typeof s.reading[id] === "object" ? s.reading[id] : {};
    const next = { read: patch.read != null ? patch.read === true : cur.read === true, note: patch.note != null ? str(String(patch.note), 1000) : (typeof cur.note === "string" ? cur.note : "") };
    s.reading[id] = next; writeJson(p("state.json"), s); return { ok: true };
  }


  // ---- recipes: newest 14 day-files, newest first, status from state.json
  const RECIPE_STATUS = ["saved", "cooked", "dismissed"];
  function readRecipes(days) {
    let names = [];
    try { names = fsx.readdirSync(p("recipes")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, days || 14); } catch (e) { /* none yet */ }
    const st = readState().recipes; const out = []; let rejected = 0; const seen = new Set();
    for (const f of names) {
      const r = readJson(p("recipes", f)); if (!r.ok || !r.json || !Array.isArray(r.json.recipes)) { rejected++; continue; }
      for (const it of r.json.recipes.slice(0, 30)) {
        const n = normalizeRecipe(it, f.slice(0, 10)); if (!n.ok) { rejected++; continue; }
        if (seen.has(n.record.id)) continue; seen.add(n.record.id);
        n.record.status = RECIPE_STATUS.indexOf(st[n.record.id]) >= 0 ? st[n.record.id] : "new"; n.record.fileDate = f.slice(0, 10); out.push(n.record);
      }
    }
    return { recipes: out, rejected };
  }
  function setRecipeStatus(id, status) {
    if (!SLUG.test(String(id)) || (status !== "new" && RECIPE_STATUS.indexOf(status) < 0)) return bad(["status", "unknown"]);
    const s = readState(); if (status === "new") delete s.recipes[id]; else s.recipes[id] = status; writeJson(p("state.json"), s); return { ok: true };
  }
  // A recipe image is a local file inside agent\recipes\images only, at most 400 KB, returned as a data URL (nothing remote is ever loaded).
  function readRecipeImage(rel) {
    if (typeof rel !== "string" || !RECIPE_IMAGE_RE.test(rel)) return null;
    try {
      const f = path.join(dir, "recipes", rel), st = fsx.lstatSync(f); if (!st.isFile() || st.size > 400000) return null;
      const ext = rel.split(".").pop().toLowerCase(); const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      return "data:" + mime + ";base64," + fsx.readFileSync(f).toString("base64");
    } catch (e) { return null; }
  }

  // Append ONE validated line with a single O_APPEND write (a line is far below the atomic-append size on NTFS; a torn line is skipped by readers).
  function appendFeedback(input) {
    const n = normalizeFeedback(input); if (!n.ok) return n;
    fsx.mkdirSync(dir, { recursive: true });
    fsx.appendFileSync(p("feedback.jsonl"), JSON.stringify(n.record) + "\n", { flag: "a" });
    return { ok: true };
  }
  function setStatus(kind, id, status) {
    const list = kind === "insights" ? INSIGHT_STATUS : PLAN_STATUS;
    if (list.indexOf(status) < 0 || !SLUG.test(String(id))) return bad(["status", "unknown"]);
    const s = readState(); s[kind][id] = status; writeJson(p("state.json"), s); return { ok: true };
  }
  function writeExperiments(items) { writeJson(p("experiments.json"), { schema: 1, items }); }
  function addExperiment(input) {
    const n = normalizeExperiment(Object.assign({ id: "e_" + require("crypto").randomBytes(8).toString("hex"), status: "running" }, input));
    if (!n.ok) return n;
    const items = readExperiments(); items.push(n.record); writeExperiments(items); return { ok: true, id: n.record.id };
  }
  function updateExperiment(id, patch) {
    const items = readExperiments(); const i = items.findIndex((e) => e.id === id); if (i < 0) return bad(["id", "unknown"]);
    const cur = items[i]; const next = Object.assign({}, cur);
    if (patch.note) next.notes = cur.notes.concat([{ ts: S.localIso(new Date()), text: patch.note }]);
    if (patch.status) { next.status = patch.status; if (patch.status !== "running") next.stop = S.localIso(new Date()).slice(0, 10); else next.stop = null; }
    if (patch.verdictNote != null) next.verdictNote = patch.verdictNote;
    const n = normalizeExperiment(next); if (!n.ok) return n;
    items[i] = n.record; writeExperiments(items); return { ok: true };
  }
  return { dir, readInsights, readPlan, readTrendNotes, readWorldview, readExperiments, readState, readRecipes, setRecipeStatus, readRecipeImage, readInteractions, readEvidenceMap, readReading, listWeeks, readWeek, setReading, appendFeedback, setStatus, addExperiment, updateExperiment };
}

module.exports = { MAX_AGENT_FILE, DF, LP, SEASONS, normalizeRecipe, SEVERITY, SEVERITY_LABEL, EVIDENCE_KINDS, READING_KINDS, WEEK_RE, normalizeInteraction, normalizeEvidenceItem, normalizeWeekly, normalizeReading, createAgentFiles, normalizeInsight, normalizePlanItem, normalizeExperiment, normalizeFeedback, EVIDENCE, EVIDENCE_LABEL, TRADITIONS, TRADITION_LABEL, TOPICS, INSIGHT_STATUS, PLAN_GROUPS, PLAN_STATUS, EXP_STATUS, FEEDBACK_TYPES, DOCTOR_LINE, DOSE_RE };
