// MY RESEARCH tab service (v1.87.0, main process). Reads the weekly research digests other agents write to
// <workspace>\shared_reports\research\<week>\ and keeps the owner's "interesting" marks in research\taste.json.
// LIGHT: loaded on the first call of a research-* channel; keeps nothing between calls (every call re-reads the files).
// SAFE: reads only inside the research folder (plus coo\weekly_<week>.json), only *.json, no symlinks, a size cap per file,
// strings clipped, URLs kept as text.
"use strict";
const fs = require("fs");
const LK = require("../legacyKeys");
const path = require("path");
const crypto = require("crypto");

const MAX_FILE_BYTES = 2 * 1024 * 1024;  // a digest bigger than this is skipped with a visible note (Security's own digest is ~100 KB)
const MAX_DIGESTS = 60, MAX_FINDINGS = 80, MAX_SOURCES = 12, MAX_TASTE_ITEMS = 500;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const STATUS_WORDS = {
  ok: "Ran", skipped: "Skipped", empty: "Empty digest", invalid: "Digest unreadable", "ran-no-digest": "Ran, no digest",
  "did-not-run": "Did not run", "not-due": "Not due yet", "too-big": "Too large to show", unreadable: "Digest unreadable",
};
const TIERS = { high: 1, normal: 1, low: 1 };

const stripBom = (s) => (typeof s === "string" && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);
// v1.91.0: bidi override/isolate characters are removed from every string shown (a title cannot reverse the reply button text)
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g;
const clip = (v, n) => (typeof v === "string" ? v.slice(0, n).replace(BIDI_RE, "") : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const norm = (v) => String(v || "").trim().toLowerCase();

// One JSON file -> {ok, value} | {ok:false, code}. Never throws. Codes: missing, too-big, not-file, unreadable.
function readJsonCapped(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return { ok: false, code: "missing" }; }
  if (!st.isFile()) return { ok: false, code: "not-file" };          // directories and symlinks are never followed
  if (st.size > MAX_FILE_BYTES) return { ok: false, code: "too-big", size: st.size };
  try { return { ok: true, value: JSON.parse(stripBom(fs.readFileSync(file, "utf8"))) }; } catch (e) { return { ok: false, code: "unreadable" }; }
}

function normFinding(f, i) {
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  const title = clip(f.title, 300) || clip(f.id, 300);
  if (!title) return null;
  const sources = (Array.isArray(f.sources) ? f.sources : []).slice(0, MAX_SOURCES).map((s) => {
    if (typeof s === "string") return { title: "", url: clip(s, 500), kind: "" };
    if (!s || typeof s !== "object") return null;
    return { title: clip(s.title, 200), url: clip(s.url, 500), kind: clip(s.kind, 30) };
  }).filter((s) => s && (s.url || s.title));
  return {
    id: clip(f.id, 120) || "n" + (i + 1),
    title,
    whatChanged: clip(f.whatChanged, 6000),
    soWhat: clip(f.soWhat, 6000),
    tier: TIERS[f.tier] ? f.tier : "normal",
    confidence: clip(f.confidence, 30),
    worth: LK.getWorthOwnerKnowing(f) === true,
    idea: f.couldBecomeIdea === true,
    topic: clip(f.topic, 300),
    sourceDate: clip(f.sourceDate, 60),   // v1.121.1: optional, when it happened / was published (ISO or free text)
    sources,
    chart: chartOf({ title, whatChanged: clip(f.whatChanged, 6000), soWhat: clip(f.soWhat, 6000) }),   // v1.91.0 magazine: figures from the text only
  };
}
function chartOf(f) { try { return require("./figures").chartFor(f); } catch (e) { return null; } }

// A digest file -> the shape the view draws. `file` is the file name (never a path the renderer could reuse).
function normDigest(file, r, week) {
  const fallbackName = file.replace(/\.json$/i, "");
  if (!r.ok) {
    const state = r.code === "too-big" ? "too-big" : "unreadable";
    return { agent: fallbackName, file, state, label: STATUS_WORDS[state], note: r.code === "too-big" ? "This digest is " + Math.round(r.size / 1024) + " KB, over the 2 MB limit, so it is not shown. Open the file itself to read it." : "The file could not be read as JSON.", summary: "", findings: [] };
  }
  const d = r.value;
  if (!d || typeof d !== "object" || Array.isArray(d)) return { agent: fallbackName, file, state: "invalid", label: STATUS_WORDS.invalid, note: "The digest is not a JSON object.", summary: "", findings: [] };
  const agent = clip(d.agent, 120) || fallbackName;
  const list = Array.isArray(d.findings) ? d.findings : [];
  const findings = list.slice(0, MAX_FINDINGS).map(normFinding).filter(Boolean);
  const rank = { high: 0, normal: 1, low: 2 };
  findings.sort((a, b) => (rank[a.tier] - rank[b.tier]) || ((a.worth ? 0 : 1) - (b.worth ? 0 : 1)));   // high first, then "worth knowing" first within a tier; stable, so the agent's own order is kept otherwise
  const summary = clip(d.summary, 4000);
  const gen = clip(d.generatedAt, 40);
  for (const x of findings) x.dateLine = require("./dates").dateLine(x.sourceDate, gen);   // v1.121.1: "Aug 10 2026 · found 12 Oct" on every card
  let state = "ok", note = "";
  if (d.week && d.week !== week) { state = "invalid"; note = "The digest says it belongs to " + clip(d.week, 12) + ", not " + week + "."; }
  else if (d.skipped) { state = "skipped"; note = clip(typeof d.skipped === "string" ? d.skipped : d.summary, 300); }
  else if (d.findings !== undefined && !Array.isArray(d.findings)) { state = "invalid"; note = "The findings entry is not a list."; }
  else if (!summary && !findings.length) state = "empty";
  if (list.length > MAX_FINDINGS) note = (note ? note + " " : "") + "Showing the first " + MAX_FINDINGS + " of " + list.length + " findings.";
  return { agent, file, state, label: STATUS_WORDS[state], note, summary, generatedAt: clip(d.generatedAt, 40), findings };
}

function createService(o) {
  const dir = o.researchDir, tasteFile = o.tasteFile || path.join(dir, "taste.json");
  const say = typeof o.log === "function" ? o.log : () => {};
  // v1.91.0: the normalised digest is kept per file (name + mtime + size), so research-image / findFinding do not re-read and re-parse
  // the whole week on every call. A changed file is simply parsed again; the memo is dropped when it grows past 400 files.
  // v1.95.1: the signature is mtime (full ms precision) + size + a sha1 of the first and last 4 KB, so a same-size rewrite
  // inside one timestamp tick (or with its mtime restored) is still seen.
  const memo = new Map();
  function headTail(f, size) {
    let fd = null;
    try {
      fd = fs.openSync(f, "r");
      const n = Math.min(4096, size), a = Buffer.alloc(n), b = Buffer.alloc(n);
      fs.readSync(fd, a, 0, n, 0); fs.readSync(fd, b, 0, n, Math.max(0, size - n));
      return crypto.createHash("sha1").update(a).update(b).digest("hex");
    } catch (e) { return "x" + Date.now(); } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
  function digestOf(wdir, n, week) {
    const f = path.join(wdir, n);
    let st = null; try { st = fs.lstatSync(f); } catch (e) { /* missing: parsed below as missing */ }
    const key = f + "|" + week, sig = st && st.isFile() ? st.mtimeMs + ":" + st.size + ":" + headTail(f, st.size) : "none";
    const hit = memo.get(key);
    if (hit && hit.sig === sig) return hit.d;
    const d = normDigest(n, readJsonCapped(f), week);
    if (memo.size > 400) memo.clear();
    memo.set(key, { sig, d });
    return d;
  }

  function listWeeks() {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && WEEK_RE.test(e.name)).map((e) => e.name).sort().reverse().slice(0, 60); } catch (e) { return []; }
  }

  // ---- taste.json (format fixed with the COO, see RESEARCH_TAB_REPORT.md):
  // { "updated": ISO, "interesting": [{week, agent, finding, marked_at}], "not_interested": [same fields] }  UTF-8 without BOM, written atomically.
  // The tab only adds/removes "interesting"; "not_interested" is written by nobody yet and is kept untouched.
  const keyOf = (week, agent, finding) => week + "|" + norm(agent) + "|" + norm(finding);
  const cleanList = (l) => (Array.isArray(l) ? l : []).filter((x) => x && typeof x.week === "string" && typeof x.agent === "string" && typeof x.finding === "string").slice(-MAX_TASTE_ITEMS);
  function readTaste() {
    const r = readJsonCapped(tasteFile);
    if (r.ok && r.value && typeof r.value === "object" && !Array.isArray(r.value)) return { ok: true, interesting: cleanList(r.value.interesting), notInterested: cleanList(r.value.not_interested) };
    if (r.code === "missing") return { ok: true, interesting: [], notInterested: [] };
    return { ok: false, interesting: [], notInterested: [], code: r.code };       // exists but unreadable: never overwritten by a mark
  }
  function writeAtomic(file, text) {
    const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
    const fd = fs.openSync(tmp, "w");
    try { fs.writeSync(fd, Buffer.from(text, "utf8")); try { fs.fsyncSync(fd); } catch (e) { /* best effort */ } } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ } throw e; }
  }

  // a = {week, agent, finding (the title), interesting: true|false}.  interesting:false takes the mark off again.
  function mark(a) {
    const week = a && typeof a.week === "string" ? a.week : "", agent = clip(a && a.agent, 120), finding = clip(a && a.finding, 300);
    if (!WEEK_RE.test(week) || !agent || !finding) return { ok: false, reason: "Bad request." };
    const t = readTaste();
    if (!t.ok) return { ok: false, reason: "taste.json exists but cannot be read, so it was left untouched." };
    const key = keyOf(week, agent, finding);
    const list = t.interesting.filter((x) => keyOf(x.week, x.agent, x.finding) !== key);
    if (a.interesting === true) list.push({ week, agent, finding, marked_at: new Date().toISOString() });
    else if (list.length === t.interesting.length) return { ok: true, interesting: false, unchanged: true };
    try {
      fs.mkdirSync(path.dirname(tasteFile), { recursive: true });
      writeAtomic(tasteFile, JSON.stringify({ updated: new Date().toISOString(), interesting: list, not_interested: t.notInterested }, null, 1) + "\n");
    } catch (e) { say("research-mark failed: code=" + (e && e.code ? e.code : "unknown")); return { ok: false, reason: "Not saved." }; }
    return { ok: true, interesting: a.interesting === true };
  }

  // ---- the COO's five (format fixed with the COO):
  // _top5.json = { week, picked_by, picked_at, picks: [{agent, finding: "<exact title>", why}] }; extra fields ignored; title matched case-insensitively after trimming.
  function readTop5(week, digests) {
    const r = readJsonCapped(path.join(dir, week, "_top5.json"));
    const findDigest = (agent) => digests.find((x) => x.agent === agent) || digests.find((x) => norm(x.agent) === norm(agent));
    if (!r.ok && r.code === "missing") return { state: "missing", picks: fallbackPicks(digests) };
    const list = r.ok && r.value && typeof r.value === "object" && Array.isArray(r.value.picks) ? r.value.picks : null;
    if (!list) return { state: "invalid", note: r.code === "too-big" ? "The COO's file is over the 2 MB limit." : "The COO's file could not be read.", picks: fallbackPicks(digests) };
    const picks = list.slice(0, 5).map((p) => {
      if (!p || typeof p !== "object") return null;
      const agent = clip(p.agent, 120), title = clip(p.finding, 300), why = clip(p.why, 1200);
      if (!agent || !title) return null;
      const d = findDigest(agent);
      const f = d ? d.findings.find((x) => norm(x.title) === norm(title)) : null;
      return { agent: d ? d.agent : agent, title: f ? f.title : title, why, finding: f || null, found: !!f };
    }).filter(Boolean);
    if (!picks.length) return { state: "invalid", note: "The COO's file has no usable picks.", picks: fallbackPicks(digests) };
    return { state: "curated", pickedBy: clip(r.value.picked_by, 60), pickedAt: clip(r.value.picked_at, 40), picks };
  }
  // Not curated: the first finding of the first five agents (alphabetical) that have one. Always labelled "not yet curated" in the view.
  function fallbackPicks(digests) {
    return digests.filter((d) => d.findings.length).slice(0, 5).map((d) => ({ agent: d.agent, title: d.findings[0].title, why: "", finding: d.findings[0], found: true }));
  }

  // The COO's weekly digest (shared_reports\coo\weekly_<week>.json), only for its contradictions; absent for most weeks.
  function readCoo(week) {
    const r = readJsonCapped(path.join(path.dirname(dir), "coo", "weekly_" + week + ".json"));
    if (!r.ok || !r.value || typeof r.value !== "object") return null;
    const contradictions = (Array.isArray(r.value.contradictions) ? r.value.contradictions : []).slice(0, 10)
      .map((c) => (c && typeof c === "object" ? { between: (Array.isArray(c.between) ? c.between : []).slice(0, 4).map((x) => clip(x, 80)), about: clip(c.about, 1500) } : null)).filter((c) => c && c.about);
    return contradictions.length ? { contradictions } : null;
  }
  // last week's finding counts (totals and per agent), for the "last week N" figures; reads only counts from the next older week's digests. No money figures are read.
  function prevSpend(weeks, week) {
    const prev = weeks[weeks.indexOf(week) + 1];
    const out = {}, byAgent = {};
    const stats = { findings: 0, high: 0, worth: 0, idea: 0, ran: 0, skipped: 0 };
    if (!prev) return { week: null, spent: out, byAgent, stats: null };
    let names = [];
    try { names = fs.readdirSync(path.join(dir, prev)).filter((n) => /\.json$/i.test(n) && n[0] !== "_").slice(0, MAX_DIGESTS); } catch (e) { return { week: null, spent: out, byAgent, stats: null }; }
    for (const n of names) {
      const r = readJsonCapped(path.join(dir, prev, n));
      if (!r.ok || !r.value || typeof r.value.agent !== "string") continue;
      const fl = Array.isArray(r.value.findings) ? r.value.findings.filter((f) => f && typeof f === "object") : [];
      byAgent[r.value.agent] = fl.length;
      stats.findings += fl.length; stats.high += fl.filter((f) => f.tier === "high").length; stats.worth += fl.filter((f) => LK.getWorthOwnerKnowing(f) === true).length; stats.idea += fl.filter((f) => f.couldBecomeIdea === true).length;
      if (r.value.skipped) stats.skipped++; else stats.ran++;
    }
    return { week: prev, spent: out, byAgent, stats };
  }

  function load(arg) {
    const weeks = listWeeks();
    const want = arg && typeof arg.week === "string" && WEEK_RE.test(arg.week) && weeks.indexOf(arg.week) >= 0 ? arg.week : weeks[0];
    if (!want) return { ok: true, weeks: [], week: null, digests: [], top5: { state: "missing", picks: [] }, marked: [] };
    const wdir = path.join(dir, want);
    let names = [];
    try { names = fs.readdirSync(wdir).filter((n) => /\.json$/i.test(n) && n[0] !== "_").sort((a, b) => a.localeCompare(b)); } catch (e) { return { ok: false, reason: "Couldn't read the week file", weeks, week: want }; }
    const skippedFiles = Math.max(0, names.length - MAX_DIGESTS);
    let digests = names.slice(0, MAX_DIGESTS).map((n) => digestOf(wdir, n, want));
    // v1.107.0: findings the owner has not read are flagged (copies; the memoised digests stay untouched)
    const gated = typeof o.gate === "function" ? o.gate(want) : null;
    if (gated) {
      digests = digests.map((d) => {
        if (!d.findings || !d.findings.length) return d;
        const fl = d.findings.map((f) => (gated.unread.has(gated.keyOf(want, d.agent, f.id)) ? Object.assign({}, f, { unread: true }) : f));
        return fl.some((f, i) => f !== d.findings[i]) ? Object.assign({}, d, { findings: fl }) : d;
      });
    }
    const prev = prevSpend(weeks, want);
    digests.forEach((d) => { d.prevFindings = Object.prototype.hasOwnProperty.call(prev.byAgent, d.agent) ? prev.byAgent[d.agent] : null; });
    // run status written by shared_tools\agent_jobs\research_status.py: used for agents WITHOUT a digest, and for the "checked at" note.
    // An agent that has a digest is shown from the digest itself (the status file can be older than the digest).
    const sr = readJsonCapped(path.join(wdir, "_status.json"));
    const statusRows = [];
    let statusNote = "";
    if (sr.ok && sr.value && Array.isArray(sr.value.agents)) {
      for (const row of sr.value.agents.slice(0, 80)) {
        if (!row || typeof row.agent !== "string") continue;
        if (digests.some((d) => d.agent === row.agent)) continue;
        const st = STATUS_WORDS[row.status] ? row.status : "invalid";
        statusRows.push({ agent: clip(row.agent, 120), file: "", state: st, label: STATUS_WORDS[st], note: clip(row.note, 300), summary: "", findings: [], noDigest: true });
      }
      statusNote = sr.value.checkedAt ? "Run status checked " + clip(sr.value.checkedAt, 19).replace("T", " ") : "";
    } else if (!sr.ok && sr.code !== "missing") statusNote = "The run status file could not be read.";
    else if (!sr.ok) statusNote = "No run status file for this week.";
    const all = digests.concat(statusRows);
    const top5 = readTop5(want, digests);
    const t = readTaste();
    return { ok: true, unreadCount: gated ? gated.count : 0, weeks, week: want, prevWeek: prev.week, prevStats: prev.stats, digests: all, top5, coo: readCoo(want), statusNote, skippedFiles, marked: t.interesting.filter((x) => x.week === want).map((x) => keyOf(x.week, x.agent, x.finding)), tasteOk: t.ok, ideasAdded: readIdeas().ideas.filter((x) => x.week === want).map((x) => keyOf(x.week, x.agent, x.finding)) };
  }

  // ---- extras (remove if unwanted): ideas inbox and the week summary export
  // ideas_inbox.json = { updated, ideas: [{week, agent, finding, added_at}] } in the research folder (UTF-8, no BOM, atomic). The COO or a script turns entries into real ideas.
  const ideasFile = path.join(dir, "ideas_inbox.json");
  function readIdeas() {
    const r = readJsonCapped(ideasFile);
    if (r.ok && r.value && Array.isArray(r.value.ideas)) return { ok: true, ideas: cleanList(r.value.ideas.map((x) => (x && x.added_at ? Object.assign({}, x) : x))) };
    return r.code === "missing" ? { ok: true, ideas: [] } : { ok: false, ideas: [] };
  }
  function addIdea(a) {
    const week = a && typeof a.week === "string" ? a.week : "", agent = clip(a && a.agent, 120), finding = clip(a && a.finding, 300);
    if (!WEEK_RE.test(week) || !agent || !finding) return { ok: false, reason: "Bad request." };
    const t = readIdeas();
    if (!t.ok) return { ok: false, reason: "ideas_inbox.json exists but cannot be read, so it was left untouched." };
    const key = keyOf(week, agent, finding);
    if (t.ideas.some((x) => keyOf(x.week, x.agent, x.finding) === key)) return { ok: true, already: true };
    t.ideas.push({ week, agent, finding, added_at: new Date().toISOString() });
    try { writeAtomic(ideasFile, JSON.stringify({ updated: new Date().toISOString(), ideas: t.ideas.slice(-MAX_TASTE_ITEMS) }, null, 1) + "\n"); } catch (e) { say("research-idea failed: code=" + (e && e.code ? e.code : "unknown")); return { ok: false, reason: "Not saved." }; }
    return { ok: true };
  }
  function exportSummary(week) {
    if (typeof week !== "string" || !WEEK_RE.test(week)) return { ok: false, reason: "Bad request." };
    const snap = load({ week });
    if (!snap.ok || snap.week !== week) return { ok: false, reason: "Couldn't read the week file" };
    const file = path.join(dir, week, "_week_summary.md");
    try { writeAtomic(file, require("./summary").buildSummary(snap, { ownerName: (() => { try { return require("../appConfig").get("ownerName") || null; } catch (e) { return null; } })() })); } catch (e) { say("research-export failed: code=" + (e && e.code ? e.code : "unknown")); return { ok: false, reason: "Not saved." }; }
    return { ok: true, file };
  }

  // v1.89.0 "Write to <agent>": the finding's reference, read from the digest itself (never trusted from the renderer).
  // fid "_week" = the agent's whole digest for the week. Returns { agent, title } or null.
  function findRef(week, agent, fid) {
    if (typeof week !== "string" || !WEEK_RE.test(week) || listWeeks().indexOf(week) < 0) return null;
    const wdir = path.join(dir, week);
    let names = [];
    try { names = fs.readdirSync(wdir).filter((n) => /\.json$/i.test(n) && n[0] !== "_").slice(0, MAX_DIGESTS); } catch (e) { return null; }
    for (const n of names) {
      const d = digestOf(wdir, n, week);
      if (norm(d.agent) !== norm(agent) || d.state === "too-big" || d.state === "unreadable") continue;
      if (fid === "_week") return { agent: d.agent, title: "" };
      const f = d.findings.find((x) => x.id === fid);
      if (f) return { agent: d.agent, title: f.title };
    }
    return null;
  }
  // v1.91.0 magazine: the whole normalised finding (for its lead image source), read from the digest itself; null when unknown
  function findFinding(week, agent, fid) {
    if (typeof week !== "string" || !WEEK_RE.test(week) || typeof fid !== "string" || !fid || listWeeks().indexOf(week) < 0) return null;
    const wdir = path.join(dir, week);
    let names = [];
    try { names = fs.readdirSync(wdir).filter((n) => /\.json$/i.test(n) && n[0] !== "_").slice(0, MAX_DIGESTS); } catch (e) { return null; }
    for (const n of names) {
      const d = digestOf(wdir, n, week);
      if (norm(d.agent) !== norm(agent)) continue;
      const f = d.findings.find((x) => x.id === fid);
      if (f) return Object.assign({ agent: d.agent }, f);
    }
    return null;
  }

  // v1.107.0: every finding of every week as { week, agent, id } (for the unread badge); uses the same memoised digests
  function listAll() {
    const out = [];
    for (const week of listWeeks()) {
      const wdir = path.join(dir, week);
      let names = [];
      try { names = fs.readdirSync(wdir).filter((n) => /\.json$/i.test(n) && n[0] !== "_").sort((a, b) => a.localeCompare(b)).slice(0, MAX_DIGESTS); } catch (e) { continue; }
      for (const n of names) {
        const d = digestOf(wdir, n, week);
        if (d.state === "too-big" || d.state === "unreadable" || d.state === "invalid") continue;
        for (const f of d.findings) out.push({ week, agent: d.agent, id: f.id });
      }
    }
    return out;
  }

  return { listAll, load, mark, addIdea, exportSummary, findRef, findFinding, listWeeks, readTaste, constants: { MAX_FILE_BYTES, MAX_DIGESTS, STATUS_WORDS } };
}

module.exports = { createService, readJsonCapped, normDigest, normFinding, STATUS_WORDS, MAX_FILE_BYTES };
