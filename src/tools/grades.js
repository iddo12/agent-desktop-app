// TOOLS v1.160.0 "All programs" tab: pure logic over grades.json (schema mytools-grades/1, written by Security's grade.py).
// No I/O, no DOM. Unknown fields are ignored; a bad row is dropped, a bad file gives an empty state, never a crash.
"use strict";

const SCHEMA = "mytools-grades/1";
const MAX_TOOLS = 300, MAX_TASKS = 60, MAX_CRITERIA = 24;
const CANDIDATES = ["yes", "maybe", "no"];
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v, lo, hi, d) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const round1 = (v) => Math.round(v * 10) / 10;

function cleanTask(t) {
  if (!isObj(t)) return null;
  const title = str(t.title, 200).trim();
  if (!title) return null;
  return { title, pct: Math.round(num(t.pct, 0, 100, 0)), points: round1(num(t.points, 0, 100, 0)), hours: round1(num(t.hours, 0, 999, 0)),
    needsIddo: t.needsIddo === true, zotac: t.zotac === true, model: str(t.model, 20), criterion: str(t.criterion, 30), optional: t.optional === true };
}
const cleanTasks = (a) => (Array.isArray(a) ? a.slice(0, MAX_TASKS).map(cleanTask).filter(Boolean) : []);

// doc -> { ok:true, generated, target, weights, summary, tools:[row] } | { ok:false, reason }
function parse(doc) {
  if (!isObj(doc) || doc.schema !== SCHEMA || !Array.isArray(doc.tools)) return { ok: false, reason: "No grading yet - run grade.py" };
  const target = Math.round(num(doc.target, 1, 100, 90));
  const weights = {};
  if (isObj(doc.weights)) Object.keys(doc.weights).slice(0, MAX_CRITERIA).forEach((k) => { weights[str(k, 30)] = num(doc.weights[k], 0, 100, 0); });
  const seen = new Set(), tools = [];
  doc.tools.slice(0, MAX_TOOLS).forEach((raw) => {
    if (!isObj(raw) || typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.id) || seen.has(raw.id)) return;
    seen.add(raw.id);
    const score = num(raw.score, 0, 100, 0);
    const crit = isObj(raw.criteria) ? raw.criteria : {}, ev = isObj(raw.evidence) ? raw.evidence : {};
    const criteria = Object.keys(crit).slice(0, MAX_CRITERIA).map((k) => ({ key: str(k, 30), points: round1(num(crit[k], 0, 100, 0)), max: round1(num(weights[k], 0, 100, 0)), evidence: str(ev[k], 400) }));
    const tasks = cleanTasks(raw.tasks), later = cleanTasks(raw.laterTasks);
    tools.push({
      id: raw.id, name: str(raw.name, 80) || raw.id, owner: str(raw.owner, 80), kind: raw.kind === "service" ? "service" : "app", folder: str(raw.folder, 400),
      rank: Number.isInteger(raw.rank) && raw.rank >= 1 ? raw.rank : null, score: Math.round(score), target: Math.round(num(raw.target, 1, 100, target)),
      gap: Math.round(num(raw.gap, 0, 100, Math.max(0, target - score))),
      candidate: CANDIDATES.includes(raw.lensvidCandidate) ? raw.lensvidCandidate : "no", candidateWhy: str(raw.candidateWhy, 400),
      hoursTo90: round1(num(raw.hoursTo90, 0, 9999, tasks.reduce((s, t) => s + t.hours, 0))),
      hoursTo90NoIddo: round1(num(raw.hoursTo90NoIddo, 0, 9999, tasks.filter((t) => !t.needsIddo).reduce((s, t) => s + t.hours, 0))),
      needsIddo: tasks.some((t) => t.needsIddo), criteria, tasks, laterTasks: later,
      testRunToday: typeof raw.testRunToday === "string" ? raw.testRunToday.slice(0, 300) : "",
    });
  });
  const s = isObj(doc.summary) ? doc.summary : {};
  const mean = typeof s.mean === "number" && isFinite(s.mean) ? round1(s.mean) : tools.length ? round1(tools.reduce((a, t) => a + t.score, 0) / tools.length) : 0;
  return { ok: true, generated: /^\d{4}-\d{2}-\d{2}/.test(str(doc.generated, 30)) ? doc.generated.slice(0, 10) : "", target, weights, mean,
    atOrAbove: tools.filter((t) => t.score >= target).length, tools };
}

// Header numbers with a comparison (standing rule): prev = a previous parse() result of an OLDER grades file, or null.
function headerLine(g, prev) {
  const was = prev && prev.ok && prev.generated !== g.generated ? prev : null;
  return { generated: g.generated, tools: g.tools.length, mean: g.mean, meanWas: was ? was.mean : null, atOrAbove: g.atOrAbove, atOrAboveWas: was ? was.atOrAbove : null, target: g.target };
}

const SORTS = ["score", "name", "hours", "lensvid"];
const cmpName = (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });
const candRank = { yes: 0, maybe: 1, no: 2 };
function sortRows(rows, key) {
  const f = key === "name" ? cmpName
    : key === "hours" ? (a, b) => a.hoursTo90 - b.hoursTo90 || cmpName(a, b)
      : key === "lensvid" ? (a, b) => candRank[a.candidate] - candRank[b.candidate] || b.score - a.score || cmpName(a, b)
        : (a, b) => b.score - a.score || cmpName(a, b);
  return rows.slice().sort(f);
}
// filters: array of "yes" | "maybe" | "internal" | "needsIddo"; candidate chips are OR-ed, "needsIddo" narrows on top.
function filterRows(rows, filters) {
  const f = Array.isArray(filters) ? filters : [];
  const cands = f.filter((x) => x === "yes" || x === "maybe" || x === "internal");
  return rows.filter((r) => (!cands.length || cands.some((c) => (c === "internal" ? r.candidate === "no" : r.candidate === c))) && (!f.includes("needsIddo") || r.needsIddo));
}

module.exports = { SCHEMA, parse, headerLine, sortRows, filterRows, SORTS };
