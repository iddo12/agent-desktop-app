// TOOLS v1 catalogue schema (tools.json). Pure functions, no I/O. Agents edit tools.json by hand; this validates it.
// A bad entry is skipped and reported (never fatal). Errors name the field and code, never the value.
"use strict";

const STATUSES = ["built", "partial", "tested", "in-dev", "released"];
const STATUS_LABELS = { built: "built", partial: "partially built", tested: "tested, not released", "in-dev": "in development", released: "released" };
const BASKETS = ["acmeco", "other"];
const OLD_FIRST_BASKET = ["lens", "vid"].join(""); // stored name in catalogues written before v1.121.0
// v1.121.0: neutral defaults. The first group's heading can be set with the config key toolsBasketLabel (the basket id "acmeco" is a stored name in tools.json).
const BASKET_LABELS = { acmeco: "Tools", other: "Other tools" };
// v1.122.0: optional "kind": "app" (a program with an interface a person uses; the default) or "service" (background service, add-on, command-line helper, logger, sentinel).
const KINDS = ["app", "service"];
const KIND_LABELS = { app: "Programs", service: "Behind the scenes" };
const VISIBILITY = ["public", "private"];
const LAST_RUN = ["ok", "failed", "unknown"];
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REPO = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;   // no "." / ".." segments (URL path traversal)
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GENERIC_PROC = ["electron.exe", "node.exe", "python.exe", "pythonw.exe", "cmd.exe", "powershell.exe", "wscript.exe", "cscript.exe", "conhost.exe"];
const MAX = { name: 80, purpose: 200, version: 40, next: 200, description: 2000, notes: 2000, owner: 80, folder: 400, text: 400, list: 30 };

const isStr = (v) => typeof v === "string";
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const realDate = (s) => { if (!DATE.test(s)) return false; const d = new Date(s + "T00:00:00Z"); return !isNaN(d) && d.toISOString().slice(0, 10) === s; };
const httpsUrl = (v) => isStr(v) && v.length <= 400 && /^https:\/\/[^\s"'<>]+$/.test(v);

// Returns { ok, entry, errors:[{field, code}] }. entry is a cleaned copy (unknown fields dropped).
function validateTool(raw) {
  const errors = [];
  const bad = (field, code) => errors.push({ field, code });
  if (!isObj(raw)) return { ok: false, entry: null, errors: [{ field: "", code: "not-object" }] };
  const e = {};
  if (!isStr(raw.id) || !SLUG.test(raw.id)) bad("id", "bad-id"); else e.id = raw.id;
  if (raw.registryId != null) { if (isStr(raw.registryId) && raw.registryId.length <= 200) e.registryId = raw.registryId; else bad("registryId", "bad"); } else e.registryId = null;
  if (!BASKETS.includes(raw.basket) && raw.basket !== OLD_FIRST_BASKET) bad("basket", "bad-basket"); else e.basket = raw.basket === "other" ? "other" : BASKETS[0]; // catalogues written before v1.121.0 name the first group after the owner's business
  const text = (k, max, required) => {
    const v = raw[k];
    if (v == null || v === "") { if (required) bad(k, "missing"); else e[k] = ""; return; }
    if (!isStr(v) || v.length > max) { bad(k, "bad"); return; }
    e[k] = v;
  };
  text("name", MAX.name, true); text("purpose", MAX.purpose, true); text("version", MAX.version, false); text("next", MAX.next, false);
  text("description", MAX.description, false); text("notes", MAX.notes, false); text("owner", MAX.owner, false); text("folder", MAX.folder, false);
  if (!STATUSES.includes(raw.status)) bad("status", "bad-status"); else e.status = raw.status;
  // launch: null (no launcher) or { path, args[] }. The allow-list (launcher.js) is applied again at start time.
  if (raw.launch == null) e.launch = null;
  else if (!isObj(raw.launch) || !isStr(raw.launch.path) || raw.launch.path.length > 400 || (raw.launch.args != null && (!Array.isArray(raw.launch.args) || raw.launch.args.length > 8 || raw.launch.args.some((a) => !isStr(a) || a.length > 200)))) bad("launch", "bad-launch");
  else e.launch = { path: raw.launch.path, args: (raw.launch.args || []).slice() };
  // process: how to tell the tool is already running: { name: "wscript.exe", cmd: "substring of its command line" }
  if (raw.process == null) e.process = null;
  else if (!isObj(raw.process) || (raw.process.name != null && !isStr(raw.process.name)) || (raw.process.cmd != null && !isStr(raw.process.cmd)) || (!raw.process.name && !raw.process.cmd)) bad("process", "bad-process");
  else {
    const pn = raw.process.name ? String(raw.process.name).slice(0, 80) : "", pc = raw.process.cmd ? String(raw.process.cmd).slice(0, 200) : "";
    // a bare generic name ("electron.exe") or a very short command-line fragment matches unrelated processes and would disable Start forever
    if ((!pc || pc.length < 6) && GENERIC_PROC.includes(pn.toLowerCase())) bad("process", "too-generic");
    else if (!pn && pc.length < 6) bad("process", "too-generic");
    else e.process = { name: pn, cmd: pc };
  }
  // kind is a soft field: an unknown value does not reject the entry; it loads as "app" and kindBad lets the service report the code.
  e.kind = "app"; e.kindBad = false;
  if (raw.kind != null) { if (KINDS.includes(raw.kind)) e.kind = raw.kind; else e.kindBad = true; }
  e.self = raw.self === true;                       // Agent Desktop's own card: always Running, never launches itself
  if (raw.repo == null || raw.repo === "") e.repo = null; else if (isStr(raw.repo) && REPO.test(raw.repo)) e.repo = raw.repo; else bad("repo", "bad-repo");
  if (raw.release == null) e.release = { url: null, date: null, notes: null };
  else if (!isObj(raw.release)) bad("release", "bad");
  else {
    const r = { url: null, date: null, notes: null };
    if (raw.release.url != null) { if (httpsUrl(raw.release.url)) r.url = raw.release.url; else bad("release.url", "bad-url"); }
    if (raw.release.notes != null) { if (httpsUrl(raw.release.notes)) r.notes = raw.release.notes; else bad("release.notes", "bad-url"); }
    if (raw.release.date != null) { if (isStr(raw.release.date) && DATE.test(raw.release.date)) r.date = raw.release.date; else bad("release.date", "bad-date"); }
    e.release = r;
  }
  if (raw.visibility == null) e.visibility = "private"; else if (VISIBILITY.includes(raw.visibility)) e.visibility = raw.visibility; else bad("visibility", "bad-visibility");
  const h = raw.health == null ? {} : raw.health;
  if (!isObj(h)) bad("health", "bad");
  else {
    const out = { lastRun: "unknown", tested: false, lastTested: null, note: "" };
    if (h.lastRun != null) { if (LAST_RUN.includes(h.lastRun)) out.lastRun = h.lastRun; else bad("health.lastRun", "bad"); }
    if (h.tested != null) { if (typeof h.tested === "boolean") out.tested = h.tested; else bad("health.tested", "bad"); }
    if (h.lastTested != null) { if (isStr(h.lastTested) && DATE.test(h.lastTested)) out.lastTested = h.lastTested; else bad("health.lastTested", "bad-date"); }
    if (h.note != null) { if (isStr(h.note) && h.note.length <= MAX.text) out.note = h.note; else bad("health.note", "bad"); }
    e.health = out;
  }
  if (raw.feedback == null) e.feedback = [];
  else if (!Array.isArray(raw.feedback) || raw.feedback.length > 200) bad("feedback", "bad");
  else {
    e.feedback = [];
    raw.feedback.forEach((f, i) => {
      if (isObj(f) && isStr(f.text) && f.text.length <= MAX.text && (f.date == null || (isStr(f.date) && DATE.test(f.date))) && (f.source == null || (isStr(f.source) && f.source.length <= 80)))
        e.feedback.push({ date: f.date || null, source: f.source || "", text: f.text });
      else bad("feedback[" + i + "]", "bad");
    });
  }
  if (raw.upcoming == null) e.upcoming = [];
  else if (!Array.isArray(raw.upcoming) || raw.upcoming.length > MAX.list || raw.upcoming.some((u) => !isStr(u) || u.length > MAX.text)) bad("upcoming", "bad");
  else e.upcoming = raw.upcoming.slice();
  // screenshots: [{file, caption, taken}]. A malformed entry is dropped and its index kept in shotsBad (the tool itself stays valid).
  e.screenshots = []; e.shotsBad = [];
  if (raw.screenshots != null) {
    if (!Array.isArray(raw.screenshots)) bad("screenshots", "bad");
    else raw.screenshots.slice(0, 30).forEach((s, i) => {
      if (isObj(s) && isStr(s.file) && s.file.length <= 80 && isStr(s.caption) && s.caption.trim() && s.caption.length <= 200 && isStr(s.taken) && realDate(s.taken)) e.screenshots.push({ file: s.file, caption: s.caption, taken: s.taken });
      else e.shotsBad.push(i);
    });
  }
  // the seed script marks guessed fields here so a human can see what still needs confirming
  if (raw.uncertain != null) { if (Array.isArray(raw.uncertain) && raw.uncertain.every((u) => isStr(u) && u.length <= 40)) e.uncertain = raw.uncertain.slice(0, 20); else bad("uncertain", "bad"); } else e.uncertain = [];
  return { ok: errors.length === 0, entry: errors.length === 0 ? e : null, errors };
}

// Whole file: { schema:1, tools:[...] }. Returns { tools:[valid entries], rejected:[{index,id,errors}], fileError }.
function validateCatalogue(doc) {
  if (!isObj(doc) || doc.schema !== 1 || !Array.isArray(doc.tools)) return { tools: [], rejected: [], fileError: "bad-file" };
  const tools = [], rejected = [], seen = new Set();
  doc.tools.forEach((raw, index) => {
    const r = validateTool(raw);
    if (r.ok && seen.has(r.entry.id)) { rejected.push({ index, id: r.entry.id, errors: [{ field: "id", code: "duplicate" }] }); return; }
    if (r.ok) { seen.add(r.entry.id); tools.push(r.entry); } else rejected.push({ index, id: isObj(raw) && isStr(raw.id) ? raw.id.slice(0, 64) : null, errors: r.errors });
  });
  return { tools, rejected, fileError: null };
}

module.exports = { STATUSES, STATUS_LABELS, BASKETS, BASKET_LABELS, KINDS, KIND_LABELS, VISIBILITY, validateTool, validateCatalogue, SLUG, REPO };
