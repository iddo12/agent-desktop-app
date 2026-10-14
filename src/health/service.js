// My Health stage 1: the service behind the IPC handlers. Loaded LAZILY (first time the Health tile is opened).
// No timers, no polling: files are read only on open (load) and on import.
// PRIVACY: the only thing this module ever passes to `log` is a line of counts and ids ("import: format=renpho added=12 ...").
// It never logs a value, a test name, a medication name, a file name or a path.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createStore } = require("./store");
const IM = require("./importers");
const VM = require("./view-model");
const S = require("./schema");
const AF = require("./agentfiles");
const TR = require("./trends");
const LG = require("./longevity");
const RT = require("./routines");
const NU = require("./nutrition");
const AT = require("./atomic");
const LP = require("./linkpolicy");
const fsMod = fs;

const { resolveRoot, MARKER } = require("./roots");
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

function createService(deps) {
  const d = deps || {};
  const say = typeof d.log === "function" ? d.log : () => {};
  const resolveOpts = { env: d.env || process.env, testMode: !!d.testMode, userData: d.userData, parent: d.parent };
  let rr = d.resolved || resolveRoot(resolveOpts);
  // v1.121.0: if an earlier start made <health folder>\vault but could not write its marker file, the vault is empty and has no marker: the folder
  // Setup made is ours, so write the marker now (never over anything: wx) and look again. A vault with content, a vault the environment points to,
  // or any other refusal stays refused.
  if (!d.resolved && !rr.ok && rr.code === "marker" && !resolveOpts.env.AGENT_DESKTOP_HEALTH_ROOT && !resolveOpts.testMode) {
    try {
      const po = typeof d.parent === "function" ? d.parent() : d.parent;
      const parent = typeof po === "string" && po.trim() ? po.trim() : null;
      const vault = parent ? path.join(parent, "vault") : null;
      if (vault && fs.statSync(parent).isDirectory() && fs.statSync(vault).isDirectory() && fs.readdirSync(vault).length === 0) {
        fs.writeFileSync(path.join(vault, MARKER), "", { flag: "wx" });
        rr = resolveRoot(resolveOpts);
      }
    } catch (e) { /* stays refused */ }
  }
  let store = null, state = rr.ok ? "ok" : "refused";
  if (rr.ok && rr.isDefault && rr.vault && !fs.existsSync(rr.vault)) {
    // v1.121.0: the vault of the original owner is created by Security and is never made here. On another computer the health folder was made by
    // Setup (the person chose it), so the app makes <folder>\vault and its marker file once; if the folder itself is missing it stays "no-vault".
    let made = false;
    try { if (rr.parent && fs.statSync(rr.parent).isDirectory()) { fs.mkdirSync(rr.vault); fs.writeFileSync(path.join(rr.vault, MARKER), "", { flag: "wx" }); made = true; } } catch (e) { made = false; }
    if (!made) { state = "no-vault"; try { if (fs.existsSync(rr.vault) && fs.readdirSync(rr.vault).length === 0) fs.rmdirSync(rr.vault); } catch (e) { /* the retry above heals it next start */ } }
  }
  if (state === "ok") { store = createStore({ root: rr.root }); try { AT.cleanTmp(rr.root); } catch (e) { /* folder not there yet */ } }
  // Link host allow-list: the default, or Security's own file <store root>\link-allowlist.json {"hosts":[...]}
  if (store) { try { const j = JSON.parse(fs.readFileSync(path.join(store.root, "link-allowlist.json"), "utf8")); LP.configure(j && Array.isArray(j.hosts) ? j.hosts : null); } catch (e) { LP.configure(null); } }
  const now = () => (typeof d.now === "function" ? d.now() : Date.now());

  const unavailable = () => ({ ok: false, state, reason: state === "no-vault" ? "The health folder was not found. Choose it in Setup." : "The health store is not available here." });
  const guard = (fn) => (...a) => { if (!store) return unavailable(); try { return fn(...a); } catch (e) { say("health error: code=" + (e && e.code ? e.code : "unknown")); return { ok: false, reason: "That did not work (the store could not be written)." }; } };

  // "Week N in short" for the Today screen: the current week on a Sunday (it opens there), otherwise the week just finished.
  function weekShort() {
    const when = new Date(now()), cur = LG.isoWeek(when), sunday = when.getDay() === 0, wk = sunday ? cur : LG.prevWeek(cur);
    const st = LG.weekStats(wk, store.listMeasurements(), routineFile.load(), []);
    return st ? { week: wk, sunday, rows: st.rows.filter((r) => r.cur).slice(0, 4), routines: st.routines.slice(0, 3), range: LG.weekRange(wk) } : null;
  }
  function load() { return Object.assign(VM.buildSnapshot(store, now()), { state, nextChunk: RT.nextChunk(routineFile.load(), RT.dayKey(new Date(now()))), weekShort: weekShort() }); }

  const IMPORT_MSG = {
    pdf: "Lab PDF reading comes in a later stage. For now add a result with the Add result form.", "bad-json": "That file is not valid JSON.",
    unknown: "That file is not a format I can read yet (Renpho CSV, Fitbit Takeout JSON, a CSV from a Health Connect exporter app, or a lab-entries file).",
    zip: "That looks like a zip, database or archive. Health Connect's own export is a zip with a database inside, which is not supported yet: use a CSV from a Health Connect exporter app. For a Fitbit Takeout, unzip it first, then choose the JSON files or use Import folder.",
    binary: "That does not look like a text file, so it was not read.", big: "That file is too large (over 25 MB), so it was not read.", empty: "That file is empty.", link: "That is a shortcut or link, not a file.",
  };
  const NOTES = { "fitbit-utc": "Fitbit steps and heart rate were converted from UTC to local time: check one late evening to be sure the day is right.", "row-cap": "Only the first 200,000 rows of a large file were read.", "mixed-date-order": "A file mixed day-first and month-first dates, so it was not imported." };
  const tick = () => new Promise((r) => setImmediate(r));
  let pending = null, picking = false;

  // One chosen file: size cap, no links, no binary or archive, parsed here in main (yielding to the event loop between the steps). The file's
  // name and path pick the reader and are then forgotten (only a content hash is kept, in the vault ledger).
  async function loadFile(p, o) {
    let st;
    try { st = await fs.promises.lstat(p); } catch (e) { return { ok: false, reason: "That file could not be opened." }; }
    if (st.isSymbolicLink()) return { ok: false, reason: IMPORT_MSG.link };
    if (!st.isFile()) return { ok: false, reason: "That is not a file." };
    if (st.size > MAX_IMPORT_BYTES) return { ok: false, reason: IMPORT_MSG.big };
    if (st.size === 0) return { ok: false, reason: IMPORT_MSG.empty };
    let buf;
    try { buf = await fs.promises.readFile(p); } catch (e) { return { ok: false, reason: "That file could not be read." }; }
    const head = buf.subarray(0, 4096);
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return { ok: false, reason: IMPORT_MSG.zip };
    if (head.indexOf(0) >= 0) return { ok: false, reason: IMPORT_MSG.binary };
    const text = buf.toString("utf8");
    await tick();
    const det = IM.detect(path.basename(p), text);
    if (det.error) { say("import: refused reason=" + det.error); return { ok: false, reason: IMPORT_MSG[det.error] }; }
    const fileId = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
    let input = text;
    if (det.parsed) input = det.parsed;
    else if (det.needsJson) { try { input = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (e) { return { ok: false, reason: IMPORT_MSG["bad-json"] }; } }
    await tick();
    return { ok: true, format: det.format, fileId, res: det.run(input, { fileId, dateOrder: o && o.dateOrder }) };
  }

  // Several files, ONE write per kind (not one per file); a day built from fewer samples never replaces a fuller one (store rule on `n`).
  async function importPaths(paths, o) {
    if (!store) return unavailable();
    const loaded = []; const out = { ok: true, files: [], fileIds: [], added: 0, updated: 0, rejected: 0, skipped: 0, kept: 0, failed: 0, reasons: [], notes: [] };
    let needsChoice = false;
    for (const p of paths.slice(0, 3000)) {
      const r = await loadFile(p, o);
      if (!r.ok) { out.failed++; if (out.reasons.indexOf(r.reason) < 0) out.reasons.push(r.reason); continue; }
      if (r.res.needsChoice) { needsChoice = true; continue; }
      loaded.push(r);
    }
    if (needsChoice) {
      const token = crypto.randomBytes(8).toString("hex"); pending = { token, paths: paths.slice(0, 3000) };
      return { ok: true, needsChoice: true, token, reason: "The dates in this file are written like 03/04/2025 and could be day-first (3 April) or month-first (March 4). Choose how to read them." };
    }
    return guard(() => {
      const merged = new Map(), labs = [];
      for (const r of loaded) {
        for (const m of r.res.measurements) { const old = merged.get(m.id); if (old && old.n != null && m.n != null && m.n < old.n) continue; merged.set(m.id, m); }
        for (const l of r.res.labs) labs.push(l);
        out.files.push(r.format); out.fileIds.push(r.fileId); out.rejected += r.res.rejected; out.skipped += r.res.skipped;
        for (const w of r.res.warnings || []) if (NOTES[w] && out.notes.indexOf(NOTES[w]) < 0) out.notes.push(NOTES[w]);
      }
      const m = store.addMeasurements([...merged.values()]), l = store.addLabs(labs);
      out.added = m.added + l.added; out.updated = m.updated + l.updated; out.rejected += m.rejected + l.rejected; out.kept = m.kept || 0;
      for (const r of loaded) store.logImport({ format: r.format, fileId: r.fileId, counts: { records: r.res.measurements.length + r.res.labs.length, rejected: r.res.rejected, skipped: r.res.skipped } });
      say("import: files=" + loaded.length + " added=" + out.added + " updated=" + out.updated + " kept=" + out.kept + " rejected=" + out.rejected + " skipped=" + out.skipped + " failed=" + out.failed);
      return out;
    })();
  }

  // Single file, same checks (kept for tools and tests).
  async function importPath(p, o) {
    const r = await importPaths([p], o);
    if (!r.ok || r.needsChoice) return r;
    if (!r.files.length) return { ok: false, reason: r.reasons[0] || "Nothing was imported." };
    return { ok: true, format: r.files[0], fileId: r.fileIds[0], counts: { added: r.added, updated: r.updated, rejected: r.rejected, skipped: r.skipped }, notes: r.notes };
  }
  const refuseSecondDialog = () => (picking ? { ok: false, reason: "A file chooser is already open." } : null);
  async function importPick() {
    if (typeof d.pickFiles !== "function") return { ok: false, reason: "No file chooser here." };
    const busy = refuseSecondDialog(); if (busy) return busy;
    picking = true; let picked;
    try { picked = await d.pickFiles(); } finally { picking = false; }
    if (!picked || !picked.length) return { ok: true, canceled: true };
    return importPaths(picked.slice(0, 50));
  }
  // Folder import (review F19): chosen in the main process, walked recursively (depth 6, at most 5000 entries, hidden entries skipped),
  // only .csv .json .txt files are read, each under the same checks as a single file.
  async function walkFolder(root) {
    const files = []; const stack = [[root, 0]]; let seen = 0;
    while (stack.length && seen < 5000) {
      const [dir, depth] = stack.pop(); let ents;
      try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of ents) {
        if (++seen > 5000) break; if (e.name.startsWith(".")) continue;
        if (e.isSymbolicLink()) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 6) stack.push([full, depth + 1]); }
        else if (e.isFile() && /\.(csv|json|txt)$/i.test(e.name)) files.push(full);
      }
    }
    return files.sort();
  }
  async function importFolder() {
    if (typeof d.pickFolder !== "function") return { ok: false, reason: "No folder chooser here." };
    const busy = refuseSecondDialog(); if (busy) return busy;
    picking = true; let dir;
    try { dir = await d.pickFolder(); } finally { picking = false; }
    if (!dir) return { ok: true, canceled: true };
    const files = await walkFolder(dir);
    if (!files.length) return { ok: true, files: [], added: 0, updated: 0, rejected: 0, skipped: 0, failed: 0, reasons: ["No .csv, .json or .txt files were found in that folder."], notes: [] };
    return importPaths(files);
  }
  async function importChoose(p) {
    const q = p || {};
    if (!pending || q.token !== pending.token || (q.order !== "dmy" && q.order !== "mdy")) return { ok: false, reason: "That choice is no longer available. Pick the file again." };
    const paths = pending.paths; pending = null;
    return importPaths(paths, { dateOrder: q.order });
  }

  // ---- the agent-written screens (Insights, Trends, Plan, Experiments, worldview). Read on demand, never cached, no timers.
  const af = store ? AF.createAgentFiles(store.root) : null;
  let linkOk = new Set();
  function labelFor(r, trendRows, meds) {
    if (r.type === "metric") { const t = trendRows.find((x) => x.id === r.id); return { type: r.type, id: r.id, label: S.METRICS[r.id] ? S.METRICS[r.id].label : r.id, last: t ? t.valueText : "" }; }
    if (r.type === "lab") { const t = trendRows.find((x) => x.id === r.id); return { type: r.type, id: r.id, label: t ? t.label : r.id, last: t ? t.valueText : "" }; }
    if (r.type === "med") { const m = meds.find((x) => x.id === r.id); return { type: r.type, id: r.id, label: m ? m.name : r.id, last: "" }; }
    return { type: "history", id: r.id, label: r.id.replace(/[-_]+/g, " "), last: "" };
  }
  function agentLoad() {
    const when = now(), today = S.localIso(new Date(when)).slice(0, 10);
    const meas = store.listMeasurements(), labs = store.listLabs(), meds = store.listMeds();
    const trends = TR.buildTrends(meas, labs, af.readTrendNotes(), when);
    const ins = af.readInsights(14), plan = af.readPlan();
    const withRefs = (o) => Object.assign({}, o, { why: { text: o.why.text, relates: o.why.relates.map((r) => labelFor(r, trends.rows, meds)) } });
    const cards = ins.cards.map(withRefs), items = plan.items.map(withRefs);
    for (const c of cards.concat(items)) for (const x of c.sources) if (x.allowed) linkOk.add(x.url);
    const exps = af.readExperiments().map((e) => TR.experimentView(e, meas, labs, when)).sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) || (a.start < b.start ? 1 : -1));
    const wv = af.readWorldview();
    return { ok: true, today,
      insights: { cards, newToday: cards.filter((c) => c.status === "new" && c.date === today).length, rejected: ins.rejected, files: ins.files },
      trends, plan: { items, rejected: plan.rejected }, experiments: exps, worldview: wv, doctorLine: AF.DOCTOR_LINE,
      enums: { evidence: AF.EVIDENCE.map((k) => [k, AF.EVIDENCE_LABEL[k]]), traditions: AF.TRADITIONS.map((k) => [k, AF.TRADITION_LABEL[k]]), topics: AF.TOPICS, insightStatus: AF.INSIGHT_STATUS, planStatus: AF.PLAN_STATUS } };
  }
  const fb = (type, target, id, extra) => af.appendFeedback(Object.assign({ type, target, id, now: now() }, extra || {}));
  function agentAct(p) {
    const q = p || {};
    if (q.op === "insight") {
      const card = af.readInsights(14).cards.find((c) => c.id === q.id); if (!card) return { ok: false, reason: "That card is no longer there." };
      const map = { useful: ["useful", null], "not-for-me": ["not-for-me", "dismissed"], save: ["save", "saved"], dismiss: ["dismiss", "dismissed"], "try-it": ["try-it", "tried"] };
      const m = map[q.action]; if (!m) return { ok: false, reason: "Unknown action." };
      let expId = null;
      if (q.action === "try-it") {
        const rel = card.why.relates.find((r) => r.type === "metric" || r.type === "lab");
        const e = af.addExperiment({ title: card.title, start: S.localIso(new Date(now())).slice(0, 10), metric: rel ? rel.id : null, metricKind: rel && rel.type === "lab" ? "lab" : "metric", fromInsight: card.id });
        if (!e.ok) return { ok: false, reason: "Could not start the experiment." }; expId = e.id;
      }
      if (m[1]) af.setStatus("insights", card.id, m[1]);
      fb(m[0], "insight", card.id);
      return { ok: true, experiment: expId };
    }
    if (q.op === "plan") { const r = af.setStatus("plan", q.id, q.status); if (!r.ok) return { ok: false, reason: "Unknown status." }; fb("plan-status", "plan", q.id, { value: q.status }); return { ok: true }; }
    if (q.op === "exp-note") { const t = typeof q.text === "string" ? q.text.trim() : ""; if (!t) return { ok: false, reason: "Write a note first." }; const r = af.updateExperiment(q.id, { note: t }); if (!r.ok) return { ok: false, reason: "Not saved." }; fb("experiment-note", "experiment", q.id, { note: t }); return { ok: true }; }
    if (q.op === "exp-verdict") { if (AF.EXP_STATUS.indexOf(q.status) < 0) return { ok: false, reason: "Unknown verdict." }; const r = af.updateExperiment(q.id, { status: q.status, verdictNote: typeof q.note === "string" ? q.note : undefined }); if (!r.ok) return { ok: false, reason: "Not saved." }; fb("experiment-verdict", "experiment", q.id, { value: q.status, note: q.note }); return { ok: true }; }
    return { ok: false, reason: "Unknown action." };
  }

  // ---- stage 1b: Longevity, Interactions, Evidence map, Weekly review, Reading list, Routines
  const profileFile = store ? path.join(store.root, "profile.json") : null;
  const routineFile = store ? RT.createRoutineFile(store.root) : null;
  function readProfile() { try { const j = JSON.parse(fsMod.readFileSync(profileFile, "utf8")); return /^\d{4}-\d{2}$/.test(j.birthYM || "") ? j.birthYM : null; } catch (e) { return null; } }
  function setProfile(birth) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(birth || "")); const y = m ? +m[1] : 0, mo = m ? +m[2] : 0;
    const nowD = new Date(now());
    if (!m || y < 1900 || mo < 1 || mo > 12 || y * 12 + mo > nowD.getFullYear() * 12 + nowD.getMonth() + 1) return { ok: false, reason: "Use a year and month like 1980-05." };
    store.ensure(); AT.write(fsMod, profileFile, JSON.stringify({ schema: 1, birthYM: String(birth) }) + "\n"); return { ok: true };
  }
  const todayKey = () => RT.dayKey(new Date(now()));
  function routinesView() {
    const st = routineFile.load(), key = todayKey();
    return { items: st.items.map((i) => RT.summarize(i, key)), templates: RT.TEMPLATES, quiet: st.quiet, snoozeUntil: st.snoozeUntil, remindersOn: RT.enabledAny(st), today: key };
  }
  const withHosts = (list) => list;   // sources already carry their real host and allowed flag (linkpolicy.js)

  // ---- Nutrition (stage 1b): recipes written by the Health agent, focus strip from labs, shopping list (app-owned shopping.json)
  const shopFile = store ? path.join(store.root, "shopping.json") : null;
  const cleanStr = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").trim().slice(0, n) : "");
  function readShop() {
    const out = { lists: {}, checked: {} };
    try {
      const j = JSON.parse(fsMod.readFileSync(shopFile, "utf8"));
      for (const id of Object.keys(j.lists || {}).filter((k) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(k)).slice(0, 30)) { const l = j.lists[id]; out.lists[id] = { title: cleanStr(l && l.title, 140), ingredients: (Array.isArray(l && l.ingredients) ? l.ingredients : []).slice(0, 40).map((x) => ({ item: cleanStr(x && x.item, 80), amount: cleanStr(x && x.amount, 40) })).filter((x) => x.item) }; }
      for (const k of Object.keys(j.checked || {}).slice(0, 400)) if (j.checked[k] === true) out.checked[cleanStr(k, 80)] = true;
    } catch (e) { /* none yet */ }
    return out;
  }
  function writeShop(o) { store.ensure(); AT.write(fsMod, shopFile, JSON.stringify({ schema: 1, lists: o.lists, checked: o.checked }) + "\n"); }
  function shopView() {
    const sh = readShop(), items = NU.aggregate(sh.lists).map((i) => Object.assign({}, i, { checked: sh.checked[i.key] === true }));
    return { items, recipes: Object.keys(sh.lists).map((id) => ({ id, title: sh.lists[id].title })), left: items.filter((i) => !i.checked).length };
  }
  function nutritionLoad() {
    const r = af.readRecipes(14); let images = 0; const trendRows = TR.buildTrends(store.listMeasurements(), store.listLabs(), {}, now()).rows, medList = store.listMeds();
    const recipes = withHosts(r.recipes).map((x) => { const o = Object.assign({}, x); o.why = { text: x.why.text, relates: x.why.relates.map((q) => labelFor(q, trendRows, medList)) }; if (x.image && images < 8) { o.imageData = af.readRecipeImage(x.image); if (o.imageData) images++; } delete o.image; return o; });
    for (const x of recipes) for (const q of x.sources) if (q.allowed) linkOk.add(q.url);
    const focus = NU.coverage(NU.focusFor(store.listLabs()), recipes);
    const shop = shopView(); const inShop = new Set(shop.recipes.map((x) => x.id));
    return { ok: true, tab: "nutrition", recipes: recipes.map((x) => Object.assign(x, { inShop: inShop.has(x.id) })), rejected: r.rejected, focus, shopping: shop, doctorLine: AF.DOCTOR_LINE,
      enums: { evidence: AF.EVIDENCE.map((k) => [k, AF.EVIDENCE_LABEL[k]]) } };
  }
  function nutritionAct(q) {
    const op = q.op;
    const find = () => af.readRecipes(14).recipes.find((x) => x.id === q.id);
    const status = { "recipe-cooked": ["cooked", "cooked"], "recipe-not-for-me": ["dismissed", "recipe-dismiss"], "recipe-save": ["saved", "recipe-save"], "recipe-reset": ["new", null] }[op];
    if (status) { if (!find()) return { ok: false, reason: "That recipe is no longer there." }; const r = af.setRecipeStatus(q.id, status[0]); if (r.ok && status[1]) fb(status[1], "recipe", q.id); return r.ok ? { ok: true } : { ok: false, reason: "Not saved." }; }
    if (op === "recipe-shop") { const rc = find(); if (!rc) return { ok: false, reason: "That recipe is no longer there." }; const sh = readShop(); sh.lists[rc.id] = { title: rc.title, ingredients: rc.ingredients.map((x) => ({ item: x.item, amount: x.amount })) }; writeShop(sh); fb("recipe-shop", "recipe", rc.id); return { ok: true }; }
    if (op === "recipe-unshop") { const sh = readShop(); delete sh.lists[String(q.id)]; writeShop(sh); return { ok: true }; }
    if (op === "shop-check") { const sh = readShop(), k = cleanStr(q.key, 80); if (!k) return { ok: false, reason: "Bad item." }; if (q.checked === true) sh.checked[k] = true; else delete sh.checked[k]; writeShop(sh); return { ok: true }; }
    if (op === "shop-clear-checked") { const sh = readShop(); for (const id of Object.keys(sh.lists)) { sh.lists[id].ingredients = sh.lists[id].ingredients.filter((x) => !sh.checked[NU.keyOf(x.item)]); if (!sh.lists[id].ingredients.length) delete sh.lists[id]; } sh.checked = {}; writeShop(sh); return { ok: true }; }
    if (op === "shop-clear-all") { writeShop({ lists: {}, checked: {} }); return { ok: true }; }
    return null;
  }

  function extraLoad(p) {
    const q = p || {}, tab = q.tab, when = now();
    if (tab === "longevity") return Object.assign({ ok: true, tab }, LG.buildLongevity(store.listMeasurements(), store.listLabs(), readProfile(), when));
    if (tab === "routines") return Object.assign({ ok: true, tab }, routinesView());
    if (tab === "nutrition") return nutritionLoad();
    if (tab === "interactions") {
      const meds = store.listMeds().filter((m) => !(m.stop && m.stop <= todayKey())).map((m) => ({ name: m.name, medKind: m.medKind }));
      const names = meds.map((m) => m.name.toLowerCase());
      const on = (n) => { const x = n.toLowerCase(); return names.some((y) => y.indexOf(x) >= 0 || x.indexOf(y) >= 0); };
      const r = af.readInteractions(); const pairs = withHosts(r.pairs.map((x) => Object.assign({}, x, { onList: on(x.a) && on(x.b) })));
      for (const x of pairs) for (const s of x.sources) if (s.allowed) linkOk.add(s.url);
      const order = { serious: 0, caution: 1, timing: 2, info: 3 }; pairs.sort((a, b) => order[a.severity] - order[b.severity]);
      return { ok: true, tab, meds, pairs, checked: r.checked, rejected: r.rejected, severity: AF.SEVERITY.map((k) => [k, AF.SEVERITY_LABEL[k]]), doctorLine: "Ask your doctor or pharmacist." };
    }
    if (tab === "evidence") {
      const r = af.readEvidenceMap(); const items = withHosts(r.items); for (const x of items) for (const s of x.sources) if (s.allowed) linkOk.add(s.url);
      items.sort((a, b) => b.max - a.max || a.name.localeCompare(b.name));
      return { ok: true, tab, items, rejected: r.rejected, enums: { evidence: AF.EVIDENCE.map((k) => [k, AF.EVIDENCE_LABEL[k]]), traditions: AF.TRADITIONS.map((k) => [k, AF.TRADITION_LABEL[k]]), kinds: AF.EVIDENCE_KINDS }, doctorLine: AF.DOCTOR_LINE };
    }
    if (tab === "reading") {
      const r = af.readReading(); const items = r.items.map((i) => Object.assign({}, i, { host: i.source ? i.source.host : "", allowed: !!(i.source && i.source.allowed) })); for (const x of items) if (x.source && x.source.allowed) linkOk.add(x.source.url);
      return { ok: true, tab, items, rejected: r.rejected, worldview: af.readWorldview(), enums: { evidence: AF.EVIDENCE.map((k) => [k, AF.EVIDENCE_LABEL[k]]), traditions: AF.TRADITIONS.map((k) => [k, AF.TRADITION_LABEL[k]]) } };
    }
    if (tab === "weekly") {
      const cur = LG.isoWeek(new Date(when)), agentWeeks = af.listWeeks();
      const weeks = [...new Set([cur, LG.prevWeek(cur), LG.prevWeek(LG.prevWeek(cur)), LG.prevWeek(LG.prevWeek(LG.prevWeek(cur))), ...agentWeeks])].sort().reverse();
      const sel = weeks.indexOf(q.week) >= 0 ? q.week : (agentWeeks[0] || LG.prevWeek(cur));
      const exps = af.readExperiments();
      return { ok: true, tab, weeks: weeks.map((w) => ({ week: w, hasNote: agentWeeks.indexOf(w) >= 0, range: LG.weekRange(w) })), selected: sel, current: cur, note: af.readWeek(sel), stats: LG.weekStats(sel, store.listMeasurements(), routineFile.load(), exps) };
    }
    return { ok: false, reason: "Unknown screen." };
  }
  function extraAct(p) {
    const q = p || {}, op = String(q.op || "");
    if (op === "profile-set") return setProfile(q.birth);
    if (op.indexOf("recipe-") === 0 || op.indexOf("shop-") === 0) { const r = nutritionAct(q); return r || { ok: false, reason: "Unknown action." }; }
    if (op === "reading-read") { const r = af.setReading(q.id, { read: q.read === true }); if (r.ok) fb("reading-read", "reading", q.id, { value: q.read === true ? "read" : "unread" }); return r.ok ? { ok: true } : { ok: false, reason: "Not saved." }; }
    if (op === "reading-note") { const t = typeof q.text === "string" ? q.text.trim() : ""; const r = af.setReading(q.id, { note: t }); if (r.ok && t) fb("reading-note", "reading", q.id, { note: t }); return r.ok ? { ok: true } : { ok: false, reason: "Not saved." }; }
    if (op.indexOf("routine-") === 0) {
      const name = op.slice(8); if (!RT.OPS[name]) return { ok: false, reason: "Unknown action." };
      const r = routineFile.act(name, q, now());
      if (r.ok && ["reminders", "quiet", "snooze", "pause", "resume", "remove"].indexOf(name) >= 0 && d.reminders) d.reminders.rearm();
      return r;
    }
    return { ok: false, reason: "Unknown action." };
  }

  function openLink(url) {
    const pu = LP.parse(url);
    if (!pu.ok || !pu.allowed || !linkOk.has(pu.href)) return { ok: false, reason: "That link is not on the allow-list of shown sources." };
    if (typeof d.openExternal !== "function") return { ok: false, reason: "No browser here." };
    d.openExternal(pu.href); /* the rebuilt href, never the raw string */ say("link open: ok=true"); return { ok: true };
  }

  const stamp = () => S.localIso(new Date(now()));
  return {
    state, root: rr.ok ? rr.root : null,
    load: guard(load),
    agentLoad: guard(agentLoad),
    extraLoad: guard(extraLoad),
    extraAct: guard((p) => { const r = extraAct(p); say("extra act: ok=" + !!r.ok); return r; }),
    agentAct: guard((p) => { const r = agentAct(p); say("agent act: op=" + (["insight", "plan", "exp-note", "exp-verdict"].indexOf(p && p.op) >= 0 ? p.op : "unknown") + " ok=" + !!r.ok); return r; }),
    openLink: guard(openLink),
    importPath, importPaths, importPick, importFolder, importChoose,
    addLab: guard((payload) => { const res = IM.labFromForm(payload); if (res.rejected || !res.labs.length) return { ok: false, reason: "Check the test name, value and date." }; const r = store.addLabs(res.labs); say("lab add: added=" + r.added); return { ok: true }; }),
    addReading: guard((p) => { const r = store.addMeasurement({ metric: p && p.metric, value: p && p.value, ts: (p && p.date) || stamp(), source: "manual" }); say("reading add: ok=" + !!r.ok); return r.ok ? { ok: true } : { ok: false, reason: "Check the value and date." }; }),
    // default start date from the same clock stopMed uses (now()), not the schema's wall clock, so start <= stop always holds
    addMed: guard((p) => { const r = store.addMed(p && typeof p === "object" && (p.start == null || p.start === "") ? Object.assign({}, p, { start: stamp().slice(0, 10) }) : p);say("med add: ok=" + !!r.ok); return r.ok ? { ok: true } : { ok: false, reason: "Check the name and dates." }; }),
    stopMed: guard((p) => { const r = store.stopMed(p && p.id, p && p.date ? p.date : stamp().slice(0, 10)); say("med stop: ok=" + !!r.ok); return r.ok ? { ok: true } : { ok: false, reason: "That item could not be stopped." }; }),
    addNote: guard((p) => { const r = store.addNote(p); say("note add: ok=" + !!r.ok); return r.ok ? { ok: true } : { ok: false, reason: "Check the note." }; }),
  };
}

module.exports = { createService, resolveRoot, MAX_IMPORT_BYTES };
