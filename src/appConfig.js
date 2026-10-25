"use strict";
// Agent Desktop configuration layer (v1.121.0). ONE place that knows where things live on THIS computer.
//
//   const cfg = require("./appConfig");
//   cfg.get("workspaceRoot")      // resolved value or null  (strings; lists come back as arrays)
//   cfg.path("sharedReports")     // same as get() for path keys; extra args are sub-path segments: cfg.path("sharedReports", "coo", "brief.json")
//   cfg.feature("argus")          // { id, state: "ready"|"needs-setup"|"needs-attention"|"off", missing:[keys], reason, wired }
//   cfg.isReady("argus")          // boolean
//   cfg.set(key, value, opts) / cfg.setMany(obj, opts) / cfg.setFeature(id, { enabled })   // validate, write userData/app-config.json atomically, emit "config-changed"
//   cfg.onChange(fn)              // returns an unsubscribe function
//
// Resolution order for every key: environment AGENT_DESKTOP_<KEY_IN_SNAKE_CASE> > userData/app-config.json > auto-detect/derive > null.
// There is NO default that points at any person's folder. A missing value is `null`, never a throw; the feature then reports "needs-setup".
// The module never throws out of get/path/feature/isReady/set*: failures come back as { ok:false, error }.
//
// File format (schema 1):  { "schema": 1, "values": { "<key>": "<abs path>" | ["<abs path>", ...] | "<text>" }, "features": { "<id>": { "enabled": true|false } } }
// Unknown top-level fields and unknown value keys are preserved on write.
//
// Testable: createAppConfig({ userDataDir, env, pathMod, fs, documentsDir, platform }) - the tests use temp dirs.

const nodeFs = require("fs");
const nodePath = require("path");
const { EventEmitter } = require("events");

const SCHEMA = 1;
const FILE_NAME = "app-config.json";

// kind: folder | file | folders (list of folders) | text | choice.   autoCreate: the app makes the folder itself when needed (no existence check).
// derive(ctx) returns the auto-detected value from other keys (ctx.get), or null.
const KEYS = {
  workspaceRoot: { kind: "folder", label: "Workspace folder", derive: (c) => c.autoWorkspace() },
  agentsRoot: { kind: "folder", label: "Agents folder", derive: (c) => c.envLegacy("AGENT_DESKTOP_ROOT") || c.sub("workspaceRoot", "Agents") },
  sharedReports: { kind: "folder", label: "Shared reports folder", derive: (c) => c.sub("workspaceRoot", "shared_reports") },
  sharedTools: { kind: "folder", label: "Shared tools folder", derive: (c) => c.sub("workspaceRoot", "shared_tools") },
  tasksDir: { kind: "folder", label: "Tasks folder", derive: (c) => c.sub("workspaceRoot", "tasks") },
  workDir: { kind: "folder", autoCreate: true, label: "Big and throwaway files folder", derive: (c) => c.userSub("work") },
  exchangeDir: { kind: "folder", label: "Fleet mailbox (Exchange) folder", derive: () => null },
  usageNowFile: { kind: "file", label: "Usage file (usage_now.json)", derive: () => null },
  tasksTool: { kind: "file", exec: true, exts: [".py"], label: "tasks.py", derive: (c) => c.sub("sharedTools", "tasks", "tasks.py") },
  registryTool: { kind: "file", exec: true, exts: [".py"], label: "registry.py", derive: (c) => c.sub("sharedTools", "registry.py") },
  pcHealthScript: { kind: "file", exec: true, exts: [".py"], label: "pc_health.py", derive: (c) => c.sub("sharedTools", "pc_health", "pc_health.py") },
  toolsCatalogue: { kind: "file", label: "Tools catalogue (tools.json)", derive: (c) => c.sub("sharedTools", "tools", "tools.json") },
  styleLibrary: { kind: "folder", label: "My Designs library folder (holds styles.json)", derive: (c) => c.sub("workspaceRoot", "shared_assets", "style_library") },
  toolsBasketLabel: { kind: "text", label: "Tools: heading of the first group of tools (the one your catalogue marks with basket \"acmeco\")", derive: () => null },
  financeVault: { kind: "folder", autoCreate: true, label: "Finance folder", derive: (c) => c.userSub("finance-vault") },
  // My Finance feed (v1.129.0): the read-only JSON the Accounting feed tool writes. Default: <work folder>/finance/feed/finance_feed.json. Never inside a cloud-synced folder (refused at read time).
  financeFeedPath: { kind: "file", label: "Finance feed file (finance_feed.json)", derive: (c) => c.sub("workDir", "finance", "feed", "finance_feed.json") },
  // Plain login links for the Home view: "sourceId=https://...;sourceId=https://..." (https only; empty = no link, nothing stored but the address)
  financeLoginLinks: { kind: "text", max: 1500, label: "Finance: login links per source (id=https://...;id=https://...)", derive: () => null },
  // Intake (phone app, PC side): the folder the phone watcher writes intake_index.jsonl in; this app appends only to intake_approvals.jsonl there.
  intakeDir: { kind: "folder", label: "Intake folder (holds intake_index.jsonl)", derive: (c) => c.sub("workDir", "intake") },
  // Contacts tab: the folder holding the Personal Assistant agent's contacts.json. Keep it outside cloud-synced folders (the tab refuses a synced folder).
  contactsDir: { kind: "folder", label: "Contacts folder (holds contacts.json from the Personal Assistant agent)", derive: (c) => c.sub("workDir", "contacts") },
  intakeDefaultAgent: { kind: "text", max: 80, label: "Intake: folder name of the agent the watcher delivers approved items to by default", derive: () => null },
  intakeRequireVerified: { kind: "text", max: 3, label: "Intake: type yes to refuse approving items the phone did not sign (phone signing is not live yet)", derive: () => null },
  healthParent: { kind: "folder", autoCreate: true, label: "Health folder", derive: (c) => c.userSub("health") },
  telegramTasksDir: { kind: "folder", label: "Telegram task queue folder", derive: () => null },
  telegramBridgeDir: { kind: "folder", label: "Telegram bridge folder (holds tasks.py)", derive: () => null },
  updateRepo: { kind: "text", label: "Where updates come from (owner/repository)", derive: () => null },
  updateChannel: { kind: "text", label: "Update channel (branch)", derive: () => "main" },
  outputRoots: { kind: "folders", label: "Folders where agents write big outputs", derive: () => null },
  documentRoots: { kind: "folders", label: "Folders scanned for agent documents", derive: (c) => c.listOf("agentsRoot") },
  openPathRoots: { kind: "folders", label: "Folders whose files can be opened from chat", derive: (c) => c.listOf("agentsRoot") },
  toolsAllowedRoots: { kind: "folders", label: "Folders tool launchers may live in", derive: (c) => c.listOf("agentsRoot") },
  memoryKeyPrefix: { kind: "text", label: "Memory folder key prefix", derive: (c) => c.memoryPrefix() },
  pythonExe: { kind: "file", exec: true, exts: [".exe", ".cmd", ".bat"], label: "Python", derive: (c) => c.onPath(["python", "py"]) },
  nodeExe: { kind: "file", exec: true, exts: [".exe", ".cmd", ".bat"], label: "Node.js", derive: (c) => c.onPath(["node"]) },
  gitExe: { kind: "file", exec: true, exts: [".exe", ".cmd", ".bat"], label: "Git", derive: (c) => c.onPath(["git"]) },
  claudeExe: { kind: "file", exec: true, exts: [".exe", ".cmd", ".bat"], label: "Claude Code (claude)", derive: (c) => c.onPath(["claude"]) },
  fleetLabel: { kind: "text", label: "Name of the fleet link in the sidebar", derive: () => null },
  exchangeInboxName: { kind: "text", segment: true, label: "Mailbox sub-folder for notes TO you", derive: () => "to_me" },
  exchangeOutboxName: { kind: "text", segment: true, label: "Mailbox sub-folder for notes FROM you", derive: () => "from_me" },
  leadRole: { kind: "text", label: "Role name of the agent that talks to the other side (for example COO)", derive: () => null },
  ownerName: { kind: "text", label: "Your name", derive: () => null },
  hiddenAgents: { kind: "text", max: 2000, label: "Agents hidden from the sidebar, pickers and fleet views (folder names, separated by ;). They keep running.", derive: () => null },   // v1.140.0 (src/hiddenAgents.js)
  partnerName: { kind: "text", label: "Partner's name (for the fleet and shared calendar)", derive: () => null },
  memoryStatsFile: { kind: "file", label: "Memory statistics file (memory_stats.json)", derive: () => null },
  memoryBaselineFile: { kind: "file", label: "Starting-context baseline file (baseline_context.json)", derive: () => null },
  argusBuilder: { kind: "file", exec: true, exts: [".py"], label: "ARGUS status builder (build_status.py)", derive: (c) => c.sub("sharedTools", "bridge", "build_status.py") },
  // The cast of agent roles (exact agent folder names under the agents folder; a trailing * means "starts with"). Unset = that role is not on this computer
  // and the links that need it are simply not shown.
  roleCoo: { kind: "text", segment: true, star: true, label: "Folder name of your lead / coordinating agent", derive: () => null },
  roleSecurity: { kind: "text", segment: true, star: true, label: "Folder name of your security agent", derive: () => null },
  roleOptimization: { kind: "text", segment: true, star: true, label: "Folder name of your maintenance / optimization agent (a trailing * matches the start)", derive: () => null },
  roleSeo: { kind: "text", segment: true, star: true, label: "Folder name of your SEO agent", derive: () => null },
  // ARGUS: which scheduled-job name prefix belongs to which role, "PREFIX=role;PREFIX=role" (roles: coo, security, optimization, seo), and short display names "folder=Short;folder=Short"
  argusJobPrefixes: { kind: "text", label: "ARGUS: scheduled-job prefixes per role (for example SEC_=security;OPT_=optimization)", derive: () => null },
  argusShortNames: { kind: "text", label: "ARGUS: short names for agent folders (for example Some Folder=Short)", derive: () => null },
  // Load governor (v1.127.0): optional text values (numbers as text; an unusable value falls back to the safe default inside src/loadGovernor.js)
  governorMaxWorking: { kind: "text", label: "Load governor: most agents working at once (default 6)", derive: () => null },
  governorMaxWorkingHeavy: { kind: "text", label: "Load governor: most agents working while a heavy app is in front (default 3)", derive: () => null },
  governorHeavyApps: { kind: "text", label: "Load governor: heavy apps, program names separated by commas (default premiere)", derive: () => null },
  governorCalmCpuPct: { kind: "text", label: "Load governor: CPU percent below which the PC counts as calm (default 50)", derive: () => null },
  governorSlowLagMs: { kind: "text", label: "Load governor: system lag in milliseconds that triggers the slow-down (default 1500)", derive: () => null },
  planTier: { kind: "choice", choices: ["pro", "max5x", "max20x"], label: "Claude plan", derive: () => null },
  // Voice (speech engine on this PC; nothing is auto-detected, so a fresh computer shows "needs setup")
  whisperExe: { kind: "file", exec: true, exts: [".exe", ".cmd", ".bat"], label: "Speech program (whisper-cli)", derive: () => null },
  whisperModel: { kind: "file", label: "Speech model (ggml .bin)", derive: () => null },
  whisperModelHe: { kind: "file", label: "Hebrew speech model (optional)", derive: () => null },
};

const NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const envName = (key) => "AGENT_DESKTOP_" + key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

function createAppConfig(opts) {
  const o = opts || {};
  const fs = o.fs || nodeFs;
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const P = o.pathMod || (platform === "win32" ? nodePath.win32 : nodePath.posix);
  const userDataDir = o.userDataDir ? String(o.userDataDir) : null;
  const documentsDir = o.documentsDir ? String(o.documentsDir) : null;
  const file = userDataDir ? P.join(userDataDir, FILE_NAME) : null;
  const ee = new EventEmitter();
  ee.setMaxListeners(50);
  let features = null; // set by setRegistry (features.js) so cfg.feature() works without a circular require
  let doc = null;      // cached parsed file ({schema, values, features}); null = not read yet
  let exists = false;
  let loadError = null;

  // ---------- file ----------
  function load(force) {
    if (doc && !force) return doc;
    doc = { schema: SCHEMA, values: {}, features: {} };
    exists = false; loadError = null;
    if (o.initialDoc && !file) { // tools and tests: an in-memory document instead of a file
      doc = { schema: SCHEMA, values: Object.assign({}, o.initialDoc.values), features: Object.assign({}, o.initialDoc.features) };
      exists = true; return doc;
    }
    if (!file) return doc;
    try {
      let txt = fs.readFileSync(file, "utf-8");
      if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
      const j = JSON.parse(txt);
      if (j && typeof j === "object" && !Array.isArray(j)) {
        doc = Object.assign({}, j, {
          schema: Number(j.schema) || SCHEMA,
          values: j.values && typeof j.values === "object" && !Array.isArray(j.values) ? j.values : {},
          features: j.features && typeof j.features === "object" && !Array.isArray(j.features) ? j.features : {},
        });
        exists = true;
      }
    } catch (e) { if (e && e.code !== "ENOENT") loadError = String(e.message || e); }
    return doc;
  }

  function writeDoc(next) {
    if (!file) return { ok: false, error: "no-user-data-dir" };
    const tmp = file + "." + process.pid + ".tmp";
    try {
      fs.mkdirSync(P.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean */ }
      return { ok: false, error: "write-failed: " + String(e.message || e) };
    }
    doc = next; exists = true; loadError = null; pathMemo = new Map();
    return { ok: true };
  }

  // ---------- validation ----------
  // strict = executable and script keys (and folders the app creates): never a network (UNC) share, never a device name (CON, NUL, COM1 ...).
  function cleanPath(v, strict) {
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (!s || s.length > 400 || /[\0\r\n]/.test(s)) return null;
    if (/^[\\/]{2}[?.][\\/]/.test(s)) return null;                 // device / extended-length prefixes
    if (strict) {
      if (/^[\\/]{2}/.test(s)) return null;                          // UNC share in any slash form
      if (s.split(/[\\/]+/).some((seg) => /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(seg.replace(/[ .]+$/, "")))) return null;
    }
    if (!P.isAbsolute(s)) return null;
    if (s.split(/[\\/]+/).some((seg) => seg === "..")) return null; // no traversal tricks
    let n = P.normalize(s);
    const root = P.parse(n).root;
    while (n.length > root.length && /[\\/]$/.test(n)) n = n.slice(0, -1);
    return n;
  }
  function cleanText(v) {
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s && s.length <= 200 && !/[\0-\x1f]/.test(s) ? s : null;
  }
  // Shape check only (used on read, never touches the disk).
  // One path segment (a folder name, not a path): no separators, no drive letter, no "..", no wildcard characters except one trailing * where the key allows it.
  function cleanSegment(v, star) {
    const t = cleanText(v);
    if (t === null) return null;
    const body = star && t.length > 1 && t.charAt(t.length - 1) === "*" ? t.slice(0, -1) : t;
    if (/[\\/:*?"<>|]/.test(body) || body.indexOf("..") >= 0 || /^[. ]+$/.test(body) || /[. ]$/.test(body)) return null;
    return t;
  }
  function hasExt(p, exts) {
    if (platform !== "win32") return true; // only Windows decides "runnable" by file extension; other systems use the execute bit
    const i = p.lastIndexOf("."), sep = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return i > sep && exts.indexOf(p.slice(i).toLowerCase()) >= 0;
  }
  function cleanValue(def, v) {
    if (def.kind === "file" && def.exec) { const p = cleanPath(v, true); return p !== null && hasExt(p, def.exts) ? p : null; }
    if (def.kind === "text" && def.segment) return cleanSegment(v, !!def.star);
    if (def.kind === "folder" || def.kind === "file") return cleanPath(v);
    if (def.kind === "folders") {
      if (!Array.isArray(v) || v.length > 50) return null;
      const out = v.map((x) => cleanPath(x));
      if (!out.every((x) => x)) return null;
      const seen = new Set();   // the same folder twice is the same folder: keep the first, in order
      return out.filter((x) => { const k = platform === "win32" ? x.toLowerCase() : x; if (seen.has(k)) return false; seen.add(k); return true; });
    }
    if (def.kind === "choice") return def.choices.indexOf(v) >= 0 ? v : null;
    if (def.kind === "text" && def.max) { const t = typeof v === "string" ? v.trim() : ""; return t && t.length <= def.max && !/[\0-\x1f]/.test(t) ? t : null; }
    return cleanText(v);
  }
  function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
  function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }

  // ---------- PATH lookup (memoized) ----------
  // A program found on PATH is remembered per (names, PATH value) for 60 s and forgotten whenever the configuration changes or reloads.
  // The scan lists each PATH folder ONCE (readdir) instead of one stat per folder x name x extension (about 1,000 stats on a normal PC).
  const PATH_TTL_MS = 60000;
  const nowMs = typeof o.now === "function" ? o.now : Date.now;
  let pathMemo = new Map();
  function scanPath(names, pathStr) {
    const dirs = pathStr.split(P.delimiter).filter(Boolean);
    const exts = platform === "win32" ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").map((x) => x.toLowerCase()).filter(Boolean) : [""];
    const ci = platform === "win32";
    const canList = typeof fs.readdirSync === "function";
    for (const d0 of dirs) {
      const d = d0.replace(/^"|"$/g, "");
      let listing = null;
      if (canList) { try { listing = new Set(fs.readdirSync(d).map((x) => (ci ? String(x).toLowerCase() : String(x)))); } catch (e) { continue; } }
      for (const n of names) for (const e of exts) {
        const leaf = n + e;
        if (listing && !listing.has(ci ? leaf.toLowerCase() : leaf)) continue;
        const f = P.join(d, leaf);
        if (isFile(f)) return f;
      }
    }
    return null;
  }
  function onPath(names) {
    const pathStr = String(env.PATH || env.Path || "");
    const key = names.join("|") + "@" + pathStr;
    const hit = pathMemo.get(key), t = nowMs();
    if (hit && t - hit.t < PATH_TTL_MS) return hit.v;
    const v = scanPath(names, pathStr);
    pathMemo.set(key, { t, v });
    if (pathMemo.size > 64) pathMemo = new Map([[key, { t, v }]]);
    return v;
  }
  // Short-lived cache used while one batch of reads runs (api.snapshot): every key is resolved and stat'ed once per batch.
  let snap = null;
  const probes = {};

  // ---------- resolution ----------
  const ctx = {
    get: (k) => resolve(k, new Set()).value,
    sub(k, ...segs) { const b = ctx.get(k); return b ? P.join(b, ...segs) : null; },
    userSub(...segs) { return userDataDir ? P.join(userDataDir, ...segs) : null; },
    listOf(k) { const v = ctx.get(k); return v ? [v] : null; },
    envLegacy(name) { return env[name] ? cleanPath(String(env[name])) : null; },
    autoWorkspace() {
      const a = env.AGENT_DESKTOP_ROOT ? cleanPath(String(env.AGENT_DESKTOP_ROOT)) : null;
      if (a) return P.dirname(a);
      if (documentsDir) { const d = P.join(documentsDir, "AgentDesktop"); if (isDir(d)) return d; }
      return null;
    },
    memoryPrefix() { const a = ctx.get("agentsRoot"); return a ? a.replace(/[^A-Za-z0-9]/g, "-") + "-" : null; },
    onPath,
    suggestDocuments() { return documentsDir ? P.join(documentsDir, "AgentDesktop") : null; },
  };

  function resolve(key, seen) {
    const def = KEYS[key];
    if (!def || seen.has(key)) return { value: null, source: null };
    seen.add(key);
    // 1. environment
    const ev = env[envName(key)];
    if (ev !== undefined && ev !== "") {
      const raw = def.kind === "folders" ? String(ev).split(P.delimiter).filter(Boolean) : String(ev);
      const v = cleanValue(def, raw);
      if (v !== null) return { value: v, source: "env" };
    }
    // 2. config file
    const d = load();
    if (Object.prototype.hasOwnProperty.call(d.values, key)) {
      const v = cleanValue(def, d.values[key]);
      if (v !== null) return { value: v, source: "config" };
    }
    // 3. auto-detect / derive
    let v = null;
    try {
      v = def.derive({
        get: (k) => resolve(k, seen).value, sub: (k, ...s) => { const b = resolve(k, seen).value; return b ? P.join(b, ...s) : null; },
        userSub: ctx.userSub, listOf: (k) => { const x = resolve(k, seen).value; return x ? [x] : null; },
        envLegacy: ctx.envLegacy, autoWorkspace: ctx.autoWorkspace, memoryPrefix: () => { const a = resolve("agentsRoot", seen).value; return a ? a.replace(/[^A-Za-z0-9]/g, "-") + "-" : null; }, onPath,
      });
    } catch (e) { v = null; }
    v = v === null || v === undefined ? null : cleanValue(def, v);
    return v === null ? { value: null, source: null } : { value: v, source: "auto" };
  }

  // ---------- public API ----------
  function top(key) {
    const k = String(key);
    if (snap) { let r = snap.res.get(k); if (!r) { r = resolve(k, new Set()); snap.res.set(k, r); } return r; }
    return resolve(k, new Set());
  }
  function get(key) {
    try { const r = top(key).value; return Array.isArray(r) ? r.slice() : r; } catch (e) { return null; }
  }
  function source(key) { try { return top(key).source; } catch (e) { return null; } }
  // Runs fn with every get/source/usable answered from a per-call cache (one resolution and one disk check per key). The Setup panel's
  // "read everything" call uses it; nothing stays cached afterwards.
  function snapshot(fn) {
    if (snap) return fn();
    snap = { res: new Map(), use: new Map(), probe: new Map() };
    try { return fn(); } finally { snap = null; }
  }
  function pathOf(key, ...segs) {
    try {
      const base = get(key);
      if (!base || typeof base !== "string") return null;
      if (!segs.length) return base;
      for (const s of segs) if (typeof s !== "string" || !s || /[\0]/.test(s) || P.isAbsolute(s) || s.split(/[\\/]+/).some((x) => x === "..")) return null;
      return P.join(base, ...segs);
    } catch (e) { return null; }
  }

  // Is the resolved value usable right now (exists on disk, unless the app creates it itself)?
  function usable(key) {
    if (snap && snap.use.has(key)) return snap.use.get(key);
    const r = usable1(key);
    if (snap) snap.use.set(key, r);
    return r;
  }
  function usable1(key) {
    const def = KEYS[key]; const v = get(key);
    if (v === null || !def) return false;
    if (def.kind === "folder") return def.autoCreate || isDir(v);
    if (def.kind === "file") return isFile(v);
    if (def.kind === "folders") return v.length > 0 && v.every((x) => isDir(x));
    return true;
  }

  // ---- consent (features of kind "consent", today only IRIS) ----
  // Stored as doc[<id>] = { enabled, consentAt, consentSource }. The listener may run only when enabled AND consentAt are both present.
  // setFeature()/set()/env/agent instructions can set `enabled` but never `consentAt`; only grantConsent() writes it, and it is called
  // from the UI IPC handler (after a confirmation dialog), the one-time grandfather rule, or the deploy tool - never from agent input.
  const CONSENT_SOURCES = ["setup-ui", "existing-pairing", "existing-install", "migration"];
  function isConsentFeature(id) { const f = features && features.get ? features.get(String(id)) : null; return !!(f && f.kind === "consent"); }
  function consentState(id) {
    if (!isConsentFeature(id)) return { exists: false, enabled: false, consentAt: null, source: null, granted: false };
    const d = load()[id];
    const sec = d && typeof d === "object" && !Array.isArray(d) ? d : null;
    const at = sec && typeof sec.consentAt === "string" && !Number.isNaN(Date.parse(sec.consentAt)) ? sec.consentAt : null;
    const enabled = !!(sec && sec.enabled === true);
    return { exists: !!sec, enabled, consentAt: at, source: at && typeof sec.consentSource === "string" ? sec.consentSource : null, granted: enabled && !!at };
  }
  function grantConsent(id, source) {
    try {
      if (!isConsentFeature(id)) return { ok: false, error: "not-a-consent-feature" };
      if (CONSENT_SOURCES.indexOf(source) < 0) return { ok: false, error: "invalid-source" };
      const next = JSON.parse(JSON.stringify(load()));
      next[id] = { enabled: true, consentAt: new Date().toISOString(), consentSource: source };
      next.schema = SCHEMA;
      const w = writeDoc(next); if (!w.ok) return w;
      ee.emit("config-changed", { keys: [], feature: id, consent: true });
      return { ok: true, feature: feature(id) };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }
  function revokeConsent(id) {
    try {
      if (!isConsentFeature(id)) return { ok: false, error: "not-a-consent-feature" };
      const next = JSON.parse(JSON.stringify(load()));
      next[id] = { enabled: false };
      const w = writeDoc(next); if (!w.ok) return w;
      ee.emit("config-changed", { keys: [], feature: id, consent: false });
      return { ok: true, feature: feature(id) };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  function feature(id) {
    try {
      const f = features && features.get ? features.get(String(id)) : null;
      if (!f) return { id: String(id), state: "needs-setup", missing: [], reason: "unknown feature", wired: false };
      if (f.kind === "consent") { // OFF until the person consents in the app's own UI; nothing else can switch it on
        const c = consentState(f.id);
        if (!c.enabled) return { id: f.id, state: "off", missing: [], reason: "Off. Turning it on needs your consent in Setup.", wired: !!f.wired, consent: false };
        if (!c.granted) return { id: f.id, state: "needs-attention", missing: [], reason: "consent needed", wired: !!f.wired, consent: false };
        const miss = f.requires.filter((k) => !usable(k));
        if (miss.length) return { id: f.id, state: "needs-attention", missing: miss, reason: "Needs: " + miss.map((k) => (KEYS[k] ? KEYS[k].label : k)).join(", "), wired: !!f.wired, consent: true };
        return { id: f.id, state: "ready", missing: [], reason: "", wired: !!f.wired, consent: true };
      }
      const en = load().features[f.id] && load().features[f.id].enabled;
      if (en === false) return { id: f.id, state: "off", missing: [], reason: "Turned off in Setup.", wired: !!f.wired };
      let missing = f.requires.filter((k) => !usable(k));
      // A feature may carry a probe: "is the real thing here?" (for Claude Code: the full search of launchEnv, which also knows the native, package and
      // npm places). When the probe says yes the feature is ready even if the PATH-derived key is empty; when it says no the requirements stay missing.
      const probe = probes[f.id] || f.probe;
      if (typeof probe === "function") {
        let ok = snap && snap.probe.has(f.id) ? snap.probe.get(f.id) : null;
        if (ok === null) { try { ok = !!probe(api); } catch (e) { ok = false; } if (snap) snap.probe.set(f.id, ok); }
        missing = ok ? [] : (missing.length ? missing : f.requires.slice());
      }
      if (missing.length && en === true && f.requires.some((k) => source(k) === "config")) return { id: f.id, state: "needs-attention", missing, reason: "It worked before, but something it needs is not available now: " + missing.map((k) => (KEYS[k] ? KEYS[k].label : k)).join(", "), wired: !!f.wired };
      if (missing.length) return { id: f.id, state: "needs-setup", missing, reason: "Needs: " + missing.map((k) => (KEYS[k] ? KEYS[k].label : k)).join(", "), wired: !!f.wired };
      return { id: f.id, state: "ready", missing: [], reason: "", wired: !!f.wired };
    } catch (e) { return { id: String(id), state: "needs-setup", missing: [], reason: "internal error", wired: false }; }
  }
  const isReady = (id) => feature(id).state === "ready";

  // is p the folder root or somewhere inside it? (case-insensitive on Windows)
  function insideRoot(p, root) {
    if (!p || !root) return false;
    const a = platform === "win32" ? p.toLowerCase() : p, b = platform === "win32" ? root.toLowerCase() : root;
    const r = P.relative(b, a);
    return r === "" || (!!r && r.split(/[\\/]+/)[0] !== ".." && !P.isAbsolute(r));
  }
  // batchVals = the values being written in the same call (so a new workspaceRoot and its sub-folders can be set together).
  function checkSet(key, value, so, batchVals) {
    const def = KEYS[key];
    if (!def) return { ok: false, error: "unknown-key" };
    if (value === null) return { ok: true, value: null };   // clear the override
    const v = cleanValue(def, value);
    if (v === null) return { ok: false, error: "invalid-value" };
    const doCreate = !!(so && so.create);
    const paths = def.kind === "folders" ? v : [v];
    if (def.kind === "folder" || def.kind === "folders") {
      for (const p of paths) {
        if (isDir(p)) continue;
        if (doCreate && cleanPath(p, true) === null) return { ok: false, error: "invalid-value" };   // never create a folder on a network share or device
        // creating a folder is allowed for the workspace itself, for the app's own folders, and inside the workspace; nowhere else
        if (doCreate && key !== "workspaceRoot" && !def.autoCreate) {
          const bw = batchVals && batchVals.workspaceRoot !== undefined && batchVals.workspaceRoot !== null ? cleanPath(batchVals.workspaceRoot, true) : null;
          const root = bw || get("workspaceRoot");
          if (!insideRoot(p, root)) return { ok: false, error: "outside-workspace" };
        }
        if (doCreate || def.autoCreate) { if (doCreate) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) { return { ok: false, error: "cannot-create-folder" }; } } continue; }
        if (def.kind === "folders" && !(so && so.mustExist)) continue;
        return { ok: false, error: "folder-missing" };
      }
    } else if (def.kind === "file" && !isFile(v)) return { ok: false, error: "file-missing" };
    return { ok: true, value: v };
  }

  function setMany(obj, so) {
    try {
      if (!obj || typeof obj !== "object") return { ok: false, error: "invalid-arguments" };
      const next = JSON.parse(JSON.stringify(load()));
      const changed = [];
      for (const k of Object.keys(obj)) {
        const r = checkSet(k, obj[k], so, obj);
        if (!r.ok) return { ok: false, error: r.error, key: k };
        if (r.value === null) delete next.values[k]; else next.values[k] = r.value;
        changed.push(k);
      }
      next.schema = SCHEMA;
      const w = writeDoc(next);
      if (!w.ok) return w;
      ee.emit("config-changed", { keys: changed });
      return { ok: true, keys: changed };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }
  const set = (key, value, so) => setMany({ [String(key)]: value }, so);

  function setFeature(id, patch, so) {
    try {
      const f = features && features.get ? features.get(String(id)) : null;
      if (!f) return { ok: false, error: "unknown-feature" };
      const p = patch || {};
      // values belonging to the feature are written in the same atomic write
      const vals = p.values && typeof p.values === "object" ? p.values : {};
      const next = JSON.parse(JSON.stringify(load()));
      const changed = [];
      for (const k of Object.keys(vals)) {
        const r = checkSet(k, vals[k], so, vals);
        if (!r.ok) return { ok: false, error: r.error, key: k };
        if (r.value === null) delete next.values[k]; else next.values[k] = r.value;
        changed.push(k);
      }
      if (typeof p.enabled === "boolean") {
        if (f.kind === "consent") {
          // turning it ON here only sets the flag (state becomes "needs-attention: consent needed", the listener stays off);
          // turning it OFF also withdraws the consent record, so switching it on again needs a fresh consent in the UI.
          const cur = next[f.id] && typeof next[f.id] === "object" ? next[f.id] : {};
          next[f.id] = p.enabled ? Object.assign({}, cur, { enabled: true }) : { enabled: false };
        } else next.features[f.id] = Object.assign({}, next.features[f.id], { enabled: p.enabled });
      }
      next.schema = SCHEMA;
      const w = writeDoc(next);
      if (!w.ok) return w;
      ee.emit("config-changed", { keys: changed, feature: f.id });
      return { ok: true, feature: feature(f.id) };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  function onChange(fn) {
    if (typeof fn !== "function") return () => {};
    ee.on("config-changed", fn);
    return () => ee.removeListener("config-changed", fn);
  }

  // Read-only copy of a plain top-level section of app-config.json (for example "wakeWatcher": { "enabled": true }); {} when absent.
  function section(id) {
    try { const v = load()[String(id)]; return v && typeof v === "object" && !Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : {}; } catch (e) { return {}; }
  }

  const api = {
    section, get, path: pathOf, source, feature, isReady, usable, consentState, isConsented: (id) => consentState(id).granted, grantConsent, revokeConsent, hasSection: (id) => consentState(id).exists, set, setMany, setFeature, onChange,
    reload: () => { pathMemo = new Map(); load(true); return { exists, error: loadError }; },
    snapshot,
    setProbe: (id, fn) => { if (typeof fn === "function") probes[String(id)] = fn; else delete probes[String(id)]; },
    hasConfigFile: () => { load(); return exists; },
    configPath: () => file,
    allKeys: () => Object.keys(KEYS),
    keyInfo: (k) => (KEYS[k] ? { kind: KEYS[k].kind, label: KEYS[k].label, choices: KEYS[k].choices || null, autoCreate: !!KEYS[k].autoCreate } : null),
    suggestWorkspace: () => ctx.suggestDocuments(),
    clean: (key, value) => (KEYS[key] ? cleanValue(KEYS[key], value) : null), // shape check only (absolute, no traversal), nothing is read from disk
    setRegistry: (r) => { features = r; },
    on: (n, fn) => ee.on(n, fn),
    envName,
    schema: SCHEMA,
  };
  return api;
}

// ---- default instance (the one the app uses) ----
let instance = null;
function init(opts) { instance = createAppConfig(opts); try { instance.setRegistry(require("./features")); } catch (e) { /* registry optional */ } return instance; }
function def() {
  if (instance) return instance;
  let ud = null;
  try { ud = require("electron").app.getPath("userData"); } catch (e) { /* not inside Electron: environment only */ }
  let docs = null;
  try { docs = require("electron").app.getPath("documents"); } catch (e) { /* none */ }
  return init({ userDataDir: ud, documentsDir: docs });
}
const proxy = { createAppConfig, init, KEYS, FILE_NAME, SCHEMA, envName };
for (const m of ["section", "get", "path", "source", "feature", "isReady", "usable", "consentState", "isConsented", "grantConsent", "revokeConsent", "hasSection", "set", "setMany", "setFeature", "onChange", "reload", "snapshot", "setProbe", "hasConfigFile", "configPath", "allKeys", "keyInfo", "suggestWorkspace", "clean", "on"]) {
  proxy[m] = (...a) => def()[m](...a);
}
module.exports = proxy;
