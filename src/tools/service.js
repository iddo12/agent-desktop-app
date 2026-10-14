// TOOLS v1 service (main process, created on the first IPC call). Reads tools.json (shared catalogue), the registry for the
// "Coming up" strip, the live process list (only when some tool has a process hint), and tools_stats.json (our own cache, in userData).
// Starts tools only through launcher.js. Refreshes GitHub stats only when asked. No timers.
"use strict";
const fs = require("fs");
const path = require("path");
const schema = require("./schema");
const launcher = require("./launcher");
const model = require("./model");
const stats = require("./stats");
const shots = require("./shots");
const trust = require("./trust");

const todayStr = (d) => { const x = d || new Date(); const p = (n) => String(n).padStart(2, "0"); return x.getFullYear() + "-" + p(x.getMonth() + 1) + "-" + p(x.getDate()); };

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (e) { return null; } }
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  const fd = fs.openSync(tmp, "w"); try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function createService(o) {
  const env = o.env || process.env;
  const say = typeof o.log === "function" ? o.log : () => {};
  const test = !!o.testMode;
  // v1.121.0: every location comes from the configuration layer (toolsCatalogue, toolsAllowedRoots, workspaceRoot). The test-mode env
  // overrides stay as they were (they point the service at a temp folder).
  const cfg = o.cfg || require("../appConfig");
  const testCat = test && env.AGENT_DESKTOP_TOOLS_DIR ? path.join(env.AGENT_DESKTOP_TOOLS_DIR, "tools.json") : null;
  // Read on every use (not cached here): Setup can change them while the app runs and this service lives for the whole session.
  const getCatFile = () => testCat || cfg.get("toolsCatalogue");
  const getCatDir = () => { const f = getCatFile(); return f ? path.dirname(f) : null; };
  const getRegDir = () => { const b = test && o.workspaceRoot ? o.workspaceRoot : cfg.get("workspaceRoot"); return (test && env.AGENT_DESKTOP_TOOLS_REGISTRY) || (b ? path.join(b, "shared_registry") : null); };
  const getRoots = () => (test && env.AGENT_DESKTOP_TOOLS_ROOTS ? String(env.AGENT_DESKTOP_TOOLS_ROOTS).split(";").filter(Boolean) : (cfg.get("toolsAllowedRoots") || launcher.DEFAULT_ROOTS));
  const needsSetup = () => !testCat && !cfg.isReady("tools");
  const statsFile = path.join(o.userData, "tools_stats.json");
  const spawn = o.spawn || null;
  const thumbDir = path.join(o.userData, "tools_thumbs");              // thumbnails are made once, here, never next to the shared files
  const getNativeImage = () => { if (o.nativeImage) return o.nativeImage; try { return require("electron").nativeImage; } catch (e) { return null; } };
  const trustFile = path.join(o.userData, "tools_trust.json");
  let confirm = typeof o.confirm === "function" ? o.confirm : null;      // native main-process dialog; tests inject one
  if (test && env.AGENT_DESKTOP_TOOLS_TEST_CONFIRM) confirm = async () => env.AGENT_DESKTOP_TOOLS_TEST_CONFIRM === "yes";
  let inflight = null;                                                  // single-flight Refresh
  let procCache = { at: 0, list: null };                                // process listing, 10 s
  let tools = [];                     // validated entries of the last load
  const lastStart = new Map();

  function loadCatalogue() {
    const catFile = getCatFile();
    const doc = catFile ? readJson(catFile) : null;
    if (!doc) return { tools: [], rejected: [], fileError: catFile && fs.existsSync(catFile) ? "unreadable" : "missing" };
    return schema.validateCatalogue(doc);
  }

  function listProcs(needed) {
    if (!needed) return Promise.resolve([]);
    if (procCache.list && Date.now() - procCache.at < 10000) return Promise.resolve(procCache.list);
    return listProcsRaw().then((l) => { if (l) procCache = { at: Date.now(), list: l }; return l; });
  }
  function listProcsRaw() {
    if (test && env.AGENT_DESKTOP_TOOLS_TEST_PROCS) { const j = readJson(env.AGENT_DESKTOP_TOOLS_TEST_PROCS); return Promise.resolve(Array.isArray(j) ? j : []); }
    if (process.platform !== "win32") return Promise.resolve([]);
    return new Promise((resolve) => {
      try {
        require("child_process").execFile(launcher.SYS.powershell(), ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object Name,CommandLine | ConvertTo-Json -Compress"],
          { windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
            if (err) return resolve(null);                      // unknown, not "nothing running"
            try { const j = JSON.parse(String(out)); resolve((Array.isArray(j) ? j : [j]).map((p) => ({ name: p.Name || "", cmd: p.CommandLine || "" }))); } catch (e) { resolve(null); }
          });
      } catch (e) { resolve(null); }
    });
  }

  function registryEntries() {
    let files = [];
    const regDir = getRegDir();
    if (!regDir) return [];
    try { files = fs.readdirSync(regDir).filter((f) => f.endsWith(".json") && !f.startsWith(".")); } catch (e) { return []; }
    const out = [];
    for (const f of files) {
      const j = readJson(path.join(regDir, f));
      if (j && j.type === "project" && (j.stage === "idea" || j.stage === "researched")) out.push({ id: j.id, type: j.type, title: j.title, stage: j.stage, status: j.status, updatedAt: j.updatedAt, createdAt: j.createdAt });
    }
    return out;
  }

  async function load() {
    if (needsSetup()) return { ok: false, reason: "needs-setup" };
    const cat = loadCatalogue();
    tools = cat.tools;
    const needProcs = tools.some((t) => !t.self && t.process);
    const procs = await listProcs(needProcs);
    const today = todayStr();
    const sv = stats.view(readJson(statsFile), tools, Date.now());
    const pins = trust.load(trustFile).pins;
    const shotsBad = [];
    const budget = { left: shots.NEW_THUMBS_PER_LOAD };       // new thumbnails per snapshot; the rest fill in on the next refresh
    const cards = tools.map((t) => {
      const rs = shots.resolveShots(getCatDir(), t.id, t.screenshots);
      const nBad = (t.shotsBad ? t.shotsBad.length : 0) + rs.rejected.length;
      if (nBad) shotsBad.push({ id: t.id, count: nBad, codes: [...new Set(rs.rejected.map((r) => r.code).concat(t.shotsBad && t.shotsBad.length ? ["bad-entry"] : []))] });
      const shotCards = rs.shots.length ? shots.describe(rs.shots, t, thumbDir, getNativeImage(), budget) : [];
      const lc = t.self || !t.launch ? null : launcher.check(t.launch, { roots: getRoots() });
      let tr = "n/a";
      if (lc && lc.ok) { try { tr = trust.evaluate(pins[t.id], { real: lc.real, args: lc.args, sha256: trust.hashFile(lc.real).sha256 }); } catch (e) { tr = "new"; } }
      return model.toCard(t, { launchCheck: lc, procs, procsUnknown: needProcs && !Array.isArray(procs), stats: sv.byTool[t.id], today, trust: tr, pinnedAt: pins[t.id] && pins[t.id].approvedAt, screenshots: shotCards });
    });
    return {
      ok: true, today, groups: model.groupCards(cards, { acmeco: cfg.get("toolsBasketLabel") }), tabs: model.groupByKind(cards, { acmeco: cfg.get("toolsBasketLabel") }), count: cards.length, thumbsPending: cards.some((c) => c.screenshots.some((s) => s.pending)),
      catalogue: { file: cat.fileError, rejected: cat.rejected.map((r) => ({ id: r.id, fields: r.errors.map((e) => e.field) })), shots: shotsBad, kinds: cat.tools.filter((t) => t.kindBad).map((t) => ({ id: t.id, code: "bad-kind" })) }, // field names and codes only
      coming: model.comingUp(registryEntries(), tools, 24),
      stats: { asOf: sv.asOf, callsLeft: sv.callsLeft, guard: sv.guard, rateRemaining: sv.rateRemaining, rateLimit: sv.rateLimit, anyRepo: stats.eligible(tools).length },
    };
  }

  async function start(id) {
    if (needsSetup()) return { ok: false, reason: "needs-setup" };
    const snap = tools.find((x) => x.id === id);
    const t = loadCatalogue().tools.find((x) => x.id === id);   // always the file as it is NOW
    if (!t) return { ok: false, reason: "Unknown tool." };
    if (snap && JSON.stringify(snap.launch) !== JSON.stringify(t.launch)) return { ok: false, reason: "The catalogue changed since this page loaded. Close and reopen Tools." };
    if (t.self) return { ok: false, reason: "Agent Desktop is already running." };
    const now = Date.now();
    if (now - (lastStart.get(id) || 0) < 5000) return { ok: false, reason: "Just started; give it a few seconds." };
    if (t.process) { const procs = await listProcs(true); if (model.isRunning(t, procs)) return { ok: false, reason: "Already running." }; }
    const c = launcher.check(t.launch, { roots: getRoots() });
    if (!c.ok) { say("tools-start: id=" + id + " ok=false reason=" + c.reason); return { ok: false, reason: model.reasonText(c.reason) }; }
    let h;
    try { h = trust.hashFile(c.real); } catch (e) { return { ok: false, reason: "Could not read the launcher." }; }
    const doc = trust.load(trustFile), pin = doc.pins[id];
    const state = trust.evaluate(pin, { real: c.real, args: c.args, sha256: h.sha256 });
    if (state !== "trusted") {
      if (!confirm) { say("tools-start: id=" + id + " pinned=" + state + " ok=false reason=no-dialog"); return { ok: false, reason: "No confirmation dialog available." }; }
      let yes = false;
      try { yes = await confirm({ id, name: t.name, owner: t.owner, real: c.real, args: c.args, sha256: h.sha256, partial: h.partial, changed: state === "changed", approvedAt: pin && pin.approvedAt }); } catch (e) { yes = false; }
      if (!yes) { say("tools-start: id=" + id + " pinned=" + state + " ok=false reason=cancelled"); return { ok: false, reason: "Cancelled." }; }
      doc.pins[id] = { real: c.real, args: c.args, sha256: h.sha256, size: h.size, partial: h.partial, approvedAt: new Date().toISOString().slice(0, 10) };
      try { trust.save(trustFile, doc); } catch (e) { say("tools-trust: write failed code=" + (e && e.code)); }
    }
    // re-check right before spawning: the file must still be exactly what was approved (closes the dialog-time swap)
    let h2;
    try { h2 = trust.hashFile(c.real); } catch (e) { return { ok: false, reason: "Could not read the launcher." }; }
    if (h2.sha256 !== h.sha256) { say("tools-start: id=" + id + " ok=false reason=changed-while-confirming"); return { ok: false, reason: "The launcher changed while confirming. Nothing was started." }; }
    lastStart.set(id, now);
    const r = launcher.start(t.launch, { roots: getRoots(), spawn });
    say("tools-start: id=" + id + " pinned=" + state + " ok=" + r.ok + (r.ok ? "" : " reason=" + r.reason));
    if (r.ok) procCache = { at: 0, list: null };
    return r.ok ? { ok: true } : { ok: false, reason: model.reasonText(r.reason) };
  }

  function refreshStats() { if (inflight) return inflight; inflight = refreshStatsOnce().then((r) => { inflight = null; return r; }, (e) => { inflight = null; throw e; }); return inflight; }
  async function refreshStatsOnce() {
    const cat = loadCatalogue(); tools = cat.tools;
    const repos = stats.eligible(tools);
    if (!repos.length) return { ok: true, summary: { fetched: 0, notModified: 0, failed: 0, skipped: 0, offline: false, limited: false, notFound: 0 }, none: true };
    let fetchJson = stats.realFetchJson;
    if (test && env.AGENT_DESKTOP_TOOLS_TEST_FETCH) {
      const fx = readJson(env.AGENT_DESKTOP_TOOLS_TEST_FETCH) || {};
      fetchJson = async (url) => { if (fx.__offline) throw new Error("offline"); const r = fx[url]; if (!r) return { status: 404, headers: {}, body: null }; return r; };
    } else if (test) fetchJson = async () => { throw new Error("offline"); };   // test mode never reaches GitHub unless a fixture is given
    const r = await stats.refresh(readJson(statsFile), repos, { fetchJson });
    try { writeAtomic(statsFile, JSON.stringify(r.cache)); } catch (e) { say("tools-stats: write failed code=" + (e && e.code)); }
    const s = r.summary;
    say("tools-stats: repos=" + repos.length + " fetched=" + s.fetched + " notModified=" + s.notModified + " failed=" + s.failed + " offline=" + s.offline + " limited=" + s.limited);
    return { ok: true, summary: s };
  }

  function openLink(id, kind) {
    const t = tools.find((x) => x.id === id);
    if (!t || t.visibility !== "public" || !t.repo) return { ok: false, reason: "No public link." };
    let url = "https://github.com/" + t.repo;
    if (kind === "releases") url += "/releases";
    else if (kind === "release" && t.release && t.release.url && t.release.url.indexOf(url + "/") === 0) url = t.release.url;
    else if (kind !== "repo") return { ok: false, reason: "No public link." };
    try { o.openExternal(url); } catch (e) { return { ok: false, reason: "Could not open it." }; }
    return { ok: true };
  }

  return { load, start, refreshStats, openLink, _files: { get catFile() { return getCatFile(); }, statsFile } };
}

module.exports = { createService };
