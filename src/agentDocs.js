// Per-agent "Agent documents" side panel (v1.75.0 work, owner's green light 2026-10-05).
//
// Lists the finished files ONE agent produced: its registry entries (shared_registry, by owner) plus
// finished-looking files found under the agent's own folder and its configured output folder (outputRoots).
// Not code, not scratch. Read-only: it never writes to a registry or an agent folder.
//
// Light on purpose (weak PCs): nothing is scanned or thumbnailed until the panel is opened for that
// agent; the folder scan is async, shallow, capped and cached; thumbnails are made lazily, at most
// THUMB_CONCURRENCY at a time, and cached on disk.
//
// Opening goes by item id. The renderer never supplies a path: main keeps id -> path for the
// last listing of each agent and looks it up itself (same rule as registry.js).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PAGE_SIZE = 40;
const SCAN_MAX_DEPTH = 3;
const SCAN_MAX_VISITED = 4000; // directory entries looked at per root
const SCAN_MAX_MS = 1500; // wall-clock budget per root
const SCAN_CACHE_MS = 120000;
const THUMB_CONCURRENCY = 6;
const THUMB_MAX_DIM = 320;

// What counts as a finished document, and which group the filter pills show it under.
const TYPE_OF_EXT = {
  pdf: "pdf",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", svg: "image", tif: "image", tiff: "image", heic: "image",
  doc: "word", docx: "word", odt: "word", rtf: "word",
  xls: "sheet", xlsx: "sheet", csv: "sheet", ods: "sheet",
  mp4: "video", mov: "video", mkv: "video", webm: "video", avi: "video", m4v: "video",
  ppt: "other", pptx: "other", dwg: "other", dxf: "other", step: "other", stp: "other", stl: "other", mp3: "other", wav: "other", zip: "other",
};
// What the built-in viewer can show (the rest is "open externally").
// No html/md/svg-in-a-frame: anything that can run script goes to the default program instead (reviewed 2026-10-06).
const VIEWABLE_EXT = /^(pdf|png|jpe?g|gif|webp|bmp|svg|mp4|webm|m4v)$/i;
// v1.92.0 (review N4): what "Open externally" may hand to the OS default program. Narrower than what is LISTED:
// legacy macro/exploit-capable Office formats (.doc .xls .rtf), .svg (opens in the browser, with script) and .zip are
// listed and can be shown in their folder (svg also viewed in-app as an image), but never launched from here.
// Kept: PDF, raster images, modern Office (docx/xlsx/pptx, odt/ods), csv, text, video/audio and CAD (the owner's mockup:
// "Open externally is the primary choice for Word, spreadsheets and CAD").
const OPEN_EXT = /^(pdf|png|jpe?g|gif|webp|bmp|tiff?|heic|docx|odt|xlsx|ods|csv|pptx|txt|md|mp4|mov|mkv|webm|avi|m4v|mp3|wav|dwg|dxf|step|stp|stl)$/i;
const { isPlainLocalPath } = require("./localPath");
function canOpenExternally(p) {
  return OPEN_EXT.test(path.extname(String(p || "")).slice(1));
}

// Folders that hold code, environments, caches or scratch - never listed, never walked into.
const SKIP_DIR = new Set([
  "node_modules", ".git", "venv", ".venv", "env", "__pycache__", "dist", "build", "out", "tmp", "temp", "cache", ".cache",
  "backups", "backup", "logs", "log", "memory", "handoff_history", "shots", "screenshots", "test", "tests", "fixtures",
  "playwright-browsers", "hf-cache", "site-packages", "_holding", ".claude", ".claude-session", "sessions",
]);
// Folders that are themselves a code project or environment: skipped unless they are the root.
const PROJECT_MARKERS = ["pyvenv.cfg", "package.json", ".git"];
// Files that look like plumbing even when the extension matches.
const SKIP_FILE = /(^~\$|\.tmp$|\.bak|thumbs\.db$|desktop\.ini$|^\.|_thumb\.|\.thumb\.)/i;

function typeOfFile(name) {
  const ext = path.extname(String(name)).slice(1).toLowerCase();
  return TYPE_OF_EXT[ext] || null;
}

// "UI-UX Agent", "UI/UX Agent", "UI/UX" -> "uiux"; "Software Engineering Agent" -> "softwareengineering".
function normAgent(s) {
  return String(s || "").toLowerCase().replace(/\bagent\b/g, "").replace(/[^a-z0-9]/g, "");
}

function matchesAgent(entryAgent, names) {
  const n = normAgent(entryAgent);
  return !!n && names.some((x) => normAgent(x) === n);
}

function idForPath(p) {
  return "f-" + crypto.createHash("sha1").update(String(p).toLowerCase()).digest("hex").slice(0, 20);
}

// ---- folder scan -------------------------------------------------------------------------------

async function scanRoot(root, isRoot = true, depth = 0, budget = null) {
  const b = budget || { visited: 0, until: Date.now() + SCAN_MAX_MS };
  const out = [];
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  if (!isRoot && entries.some((d) => PROJECT_MARKERS.includes(d.name))) return out;
  for (const d of entries) {
    if (b.visited++ > SCAN_MAX_VISITED || Date.now() > b.until) break;
    if (b.visited % 200 === 0) await new Promise((r) => setImmediate(r)); // let the UI breathe
    const full = path.join(root, d.name);
    if (d.isDirectory()) {
      if (depth < SCAN_MAX_DEPTH && !SKIP_DIR.has(d.name.toLowerCase()) && !d.name.startsWith(".")) {
        out.push(...(await scanRoot(full, false, depth + 1, b)));
      }
    } else if (d.isFile() && typeOfFile(d.name) && !SKIP_FILE.test(d.name)) {
      try {
        const st = await fs.promises.stat(full);
        if (st.size > 0) out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
      } catch (e) { /* vanished mid-scan */ }
    }
  }
  return out;
}

// ---- building the list -------------------------------------------------------------------------

// Case-insensitive, slash-normalised key for comparing paths (review S1: 308 of 542 live registry links use "/").
function pathKey(p) {
  try { return path.resolve(String(p)).toLowerCase(); } catch (e) { return String(p).toLowerCase(); }
}
// Plain string prefix check: is `p` inside one of `roots`? No fs call, so it is safe on any input.
function underRootsPlain(p, roots) {
  if (!isPlainLocalPath(p)) return false;
  const pk = pathKey(p);
  return (roots || []).some((r) => {
    const rk = pathKey(r).replace(/[\\/]+$/, "") + path.sep;
    return pk.startsWith(rk);
  });
}

// True when file `p` really lives under one of `roots` (symlinks/junctions resolved, case-insensitive).
// `roots` may be pre-resolved with realRoots() so a long list does not realpath every root once per file.
// v1.92.0 (review S2/N1): UNC and device paths are refused before any fs call, the cheap string-prefix check runs
// first (most entries belong to other roots or are refused here), and realpath uses the native call (~2 ms, not one
// lstat per path component).
function realRoots(roots) {
  const out = [];
  for (const r of roots || []) {
    if (!isPlainLocalPath(r)) continue;
    try { out.push(fs.realpathSync.native(r).toLowerCase()); } catch (e) { /* missing root: allows nothing */ }
  }
  out.resolved = true;
  out.plain = (roots || []).slice();
  return out;
}
function underRoots(p, roots) {
  if (!isPlainLocalPath(p)) return false;
  const plainRoots = roots && roots.resolved ? roots.plain : roots;
  if (!underRootsPlain(p, plainRoots)) return false;
  let real;
  try { real = fs.realpathSync.native(p).toLowerCase(); } catch (e) { return false; }
  const rr = roots && roots.resolved ? roots : realRoots(roots);
  return rr.some((r) => {
    const rel = path.relative(r, real);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

// v1.92.0: the file a registry entry stands for. Entries from registry.listRegistry() carry `path` (the local document,
// or the PDF copy of a web entry); raw entries only `link`. Web links with no local copy are not files, and neither is
// anything that is not a plain local drive path (UNC / device paths, review S2).
function entryFile(e) {
  const p = e && (e.path || e.link);
  return p && !/^https?:\/\//i.test(p) && isPlainLocalPath(p) ? p : null;
}

// Cheap per-agent count for the header badge (no stat, no realpath). v1.92.0 (review N8): the badge always counts
// this same population - REGISTERED documents of the agent - before and after the panel is opened, so it never jumps
// to the (possibly thousands of) unregistered folder files the panel also lists.
function registryCount(entries, names, roots) {
  let n = 0;
  const ids = [];
  for (const e of entries || []) {
    if (!e || !e.id || e.type === "project" || e.missing) continue;
    const f = entryFile(e);
    if (!f || !typeOfFile(f) || !matchesAgent(e.agent, names)) continue;
    if (!underRootsPlain(f, roots)) continue;
    n++;
    ids.push(String(e.id));
  }
  return { total: n, ids };
}

// The agent an IPC call names, by folder name only (the renderer never sends a path). null when unknown.
function resolveAgent(agents, key) {
  if (typeof key !== "string" || !key || key.length > 120) return null;
  return (agents || []).find((a) => a && a.folderName === key) || null;
}

function registryItems(entries, names, roots) {
  const out = [];
  const rr = realRoots(roots);
  for (const e of entries) {
    if (!e || !e.id || e.type === "project") continue;
    const file = entryFile(e);
    if (!file) continue;
    if (!matchesAgent(e.agent, names)) continue;
    if (!typeOfFile(file) || !underRoots(file, rr)) continue; // allow-list of types, confined to the known roots
    let st;
    try { st = fs.statSync(file); } catch (err) { continue; } // registry points at nothing: not a document we can show
    if (!st.isFile()) continue;
    // The registered original (e.g. the .docx) when `path` is its PDF copy: the folder scan must not list it again (S1).
    const link = e.link && e.link !== file && isPlainLocalPath(e.link) ? e.link : null;
    // The Library's own small cached preview (registry.js makes it for images); reused, never regenerated here.
    // Confined like the document itself (review N3): a plain local path under the roots, an image extension.
    const th = e.thumbnail;
    const thumb = typeof th === "string" && /\.(jpe?g|png|gif|webp|bmp)$/i.test(th) && underRoots(th, rr) ? th : null;
    out.push({
      id: String(e.id), path: file, link, title: e.title || path.basename(file), size: st.size,
      mtimeMs: Date.parse(e.updatedAt || e.createdAt || "") || st.mtimeMs,
      status: ["active", "draft", "superseded"].includes(e.status) ? e.status : e.status === "stale" ? "" : (e.status || ""),
      note: [e.description, e.topic].filter(Boolean).join(" "), source: "registry",
      thumb,
    });
  }
  return out;
}

// skipKeys: pathKey()s of every registered file (its path AND its link), so a scanned file that is already registered
// is never listed a second time as "unregistered", whatever slashes or letter case the registry used (review S1).
function scannedItems(files, skipKeys) {
  return files
    .filter((f) => !skipKeys.has(pathKey(f.path)))
    .map((f) => ({
      id: idForPath(f.path), path: f.path, title: path.basename(f.path, path.extname(f.path)).replace(/[_]+/g, " "),
      size: f.size, mtimeMs: f.mtimeMs, status: "", note: "", source: "folder",
    }));
}
function registeredKeys(reg) {
  const s = new Set();
  for (const r of reg) { s.add(pathKey(r.path)); if (r.link) s.add(pathKey(r.link)); }
  return s;
}

function finishItem(it) {
  const name = path.basename(it.path);
  const ext = path.extname(name).slice(1).toLowerCase();
  return { ...it, name, ext, type: TYPE_OF_EXT[ext] || "other", viewable: VIEWABLE_EXT.test(ext), openable: OPEN_EXT.test(ext) };
}

function dayGroup(ms, now) {
  const d = new Date(ms), n = new Date(now);
  const startToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (ms >= startToday) return "Today";
  if (ms >= startToday - 6 * 86400000) return "This week";
  return d.toLocaleString("en-US", { month: "long", year: d.getFullYear() === n.getFullYear() ? undefined : "numeric" });
}

// "Report_v2", "report draft5", "plan_FINAL", "x (1)", "x_2026-10-05" -> same stem "report"/"plan"/"x": versions of one document.
const VERSION_TAIL = /[\s_.-]*(\(\d+\)|v\d+(\.\d+)*|ver\d+|rev\d+|r\d+|draft\d*|final|new|copy|round\d+|\d{4}[-_]\d{2}[-_]\d{2}|\d{8}|[_ -]\d{1,3})$/i;
function stemKey(name) {
  let s = path.basename(String(name), path.extname(String(name))).toLowerCase();
  for (let i = 0; i < 4; i++) {
    const t = s.replace(VERSION_TAIL, "");
    if (t === s || !t.trim()) break;
    s = t;
  }
  return s.replace(/[\s_.-]+/g, " ").trim();
}

// The short word on a type tile (never colour alone): PDF, DOC, XLS, IMG, VID, PPT, ZIP, FILE.
function kindLabel(ext, type) {
  const e = String(ext || "").toLowerCase();
  if (type === "pdf") return "PDF";
  if (type === "word") return "DOC";
  if (type === "sheet") return e === "csv" ? "CSV" : "XLS";
  if (type === "image") return "IMG";
  if (type === "video") return "VID";
  if (e === "ppt" || e === "pptx") return "PPT";
  if (e === "zip") return "ZIP";
  if (e === "mp3" || e === "wav") return "AUD";
  return "FILE";
}

// v1.92.0: titles are stacked more strictly than file names: only explicit version words fold ("Plan v2", "Plan draft3",
// "Plan (FINAL)", "Plan (2)"); a plain number or date in a title is a different document ("Weekly audit 41", "Ops 2026-10-05").
const TITLE_VERSION_TAIL = /[\s_.,-]*(\(\s*(\d+|final|draft\s*\d*)\s*\)|v\d+(\.\d+)*|ver\.?\s*\d+|rev\.?\s*\d+|draft\s*\d*|final|copy|round\s*\d+)$/i;
function stemTitle(title) {
  let s = String(title || "").trim().toLowerCase();
  for (let i = 0; i < 4; i++) {
    const t = s.replace(TITLE_VERSION_TAIL, "").trim();
    if (t === s || !t) break;
    s = t;
  }
  return s.replace(/[\s_.,-]+/g, " ").trim();
}

// Pure: items (already finished) + a query -> one page. `read` maps id -> {at}.
// Read state lookups use own properties only, so ids like "constructor" or "toString" are never "read" by accident (N5).
function isRead(read, id) {
  return !!read && Object.prototype.hasOwnProperty.call(read, id) && !!read[id];
}

function query(items, q, read, now = Date.now()) {
  q = q || {};
  const search = String(q.search || "").trim().toLowerCase();
  const type = q.type && q.type !== "all" ? String(q.type) : null;
  const dir = q.sort === "oldest" ? 1 : -1;
  const counts = { all: 0, docs: 0, pdf: 0, image: 0, word: 0, sheet: 0, video: 0, other: 0 };
  let unread = 0;
  const matched = [];
  for (const it of items) {
    if (search && !(it.title.toLowerCase().includes(search) || it.name.toLowerCase().includes(search) || (it.note || "").toLowerCase().includes(search))) continue;
    counts.all++; counts[it.type]++;
    if (it.type !== "image") counts.docs++;
    if (!isRead(read, it.id)) unread++;
    if (!type || it.type === type || (type === "docs" && it.type !== "image")) matched.push(it);
  }
  matched.sort((a, b) => dir * (a.mtimeMs - b.mtimeMs) || a.name.localeCompare(b.name));
  const offset = Math.max(0, Number(q.offset) || 0);
  const row = (it) => ({
    id: it.id, title: it.title, name: it.name, ext: it.ext, type: it.type, size: it.size, mtimeMs: it.mtimeMs, status: it.status,
    viewable: it.viewable, openable: !!it.openable, unread: !isRead(read, it.id), group: dayGroup(it.mtimeMs, now), source: it.source,
    path: it.path, thumb: it.thumb || null, kind: kindLabel(it.ext, it.type),
  });
  let stacks = matched.map((it) => ({ head: it, older: [] }));
  if (q.stack) { // one stack per document: the newest version leads, older ones fold under it
    const by = new Map();
    stacks = [];
    for (const it of matched) {
      // v1.92.0: a registered document is stacked by its TITLE (agents name files img_01, img_02... while the titles
      // differ); an unregistered file by its file name. "+ '.x'" keeps a dotted title ("Plan v1.2") from losing a tail.
      const k = it.type + "|" + (it.source === "registry" ? stemTitle(it.title) : stemKey(it.name));
      if (by.has(k)) by.get(k).older.push(it);
      else { const st = { head: it, older: [] }; by.set(k, st); stacks.push(st); }
    }
  }
  const page = stacks.slice(offset, offset + PAGE_SIZE).map((st) => {
    const r = row(st.head);
    if (st.older.length) { r.versions = st.older.length + 1; r.older = st.older.map(row); r.selfUnread = r.unread; r.unread = r.unread || r.older.some((o) => o.unread); }
    return r;
  });
  return { total: stacks.length, counts, unread, offset, pageSize: PAGE_SIZE, items: page };
}

// ---- stateful part (electron-facing) -----------------------------------------------------------

// deps: { workspaceRoot, outputRoot, loadRegistry(): entries, libraryState, shell, nativeImage, thumbDir }
function create(deps) {
  // v1.121.0: outputRoot and roots may be functions (read on every use, so Setup changes apply at once).
  const outputRootNow = () => (typeof deps.outputRoot === "function" ? deps.outputRoot() : deps.outputRoot);
  const rootsNow = () => (typeof deps.roots === "function" ? deps.roots() : deps.roots);
  const lists = new Map(); // agentKey -> { at, items, byId }
  const pending = new Map(); // agentKey -> Promise (de-duplicates concurrent scans)

  function agentRoots(agent) {
    const roots = [];
    if (agent.path) roots.push(agent.path);
    try {
      const want = normAgent(agent.folderName || agent.displayName);
      const outRoot = outputRootNow();
      for (const d of outRoot ? fs.readdirSync(outRoot, { withFileTypes: true }) : []) {
        if (d.isDirectory() && normAgent(d.name) === want && want) roots.push(path.join(outRoot, d.name));
      }
    } catch (e) { /* no output folder for this agent */ }
    return roots;
  }

  async function build(agent) {
    const names = [agent.folderName, agent.displayName].filter(Boolean);
    const reg = registryItems(deps.loadRegistry(), names, rootsNow());
    const skip = registeredKeys(reg); // path AND link of every registered file, slash/case-normalised (S1)
    const files = [];
    for (const r of agentRoots(agent)) files.push(...(await scanRoot(r)));
    const items = [...reg, ...scannedItems(files, skip)].map(finishItem);
    const byId = new Map(items.map((i) => [i.id, i]));
    return { at: Date.now(), items, byId };
  }

  async function listing(agent, force) {
    const key = agent.path;
    const hit = lists.get(key);
    if (hit && !force && Date.now() - hit.at < SCAN_CACHE_MS) return hit;
    if (!pending.has(key)) {
      pending.set(key, build(agent).then((l) => { lists.set(key, l); return l; }).finally(() => pending.delete(key)));
    }
    return pending.get(key);
  }

  async function list(agent, q) {
    const l = await listing(agent, !!(q && q.refresh));
    return query(l.items, q, deps.libraryState.get().read);
  }

  // Counts for the header badge. v1.92.0 (review N8): ALWAYS the agent's registered documents (cheap: no stat, no
  // folder scan), before and after the panel was opened, so the number never jumps from ~20 to thousands of folder
  // files. `full` only says whether a full listing is cached.
  async function summary(agent) {
    const read = deps.libraryState.get().read;
    const hit = lists.get(agent.path);
    const names = [agent.folderName, agent.displayName].filter(Boolean);
    const c = registryCount(deps.loadRegistry(), names, rootsNow());
    return { total: c.total, unread: c.ids.filter((id) => !isRead(read, id)).length, full: !!(hit && Date.now() - hit.at < SCAN_CACHE_MS) };
  }

  function lookup(agent, id) {
    const l = lists.get(agent.path);
    return l && l.byId.get(String(id || "")) || null;
  }

  async function open(agent, id, how) {
    const it = lookup(agent, id);
    if (!it) return { ok: false, error: "That file is not in the list any more - refresh the panel." };
    if (!isPlainLocalPath(it.path) || !fs.existsSync(it.path)) return { ok: false, error: "The file is no longer at " + it.path };
    if (how === "reveal") { deps.shell.showItemInFolder(it.path); return { ok: true }; }
    if (how === "view") {
      if (!it.viewable) return { ok: false, error: "The built-in viewer cannot show ." + it.ext + " files - use Open externally." };
      const url = "file:///" + it.path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:");
      return { ok: true, url, title: it.title, type: it.type, ext: it.ext, path: it.path };
    }
    // Allow-list, not deny-list: only OPEN_EXT types ever reach shell.openPath (review N4: no doc/xls/rtf/svg/zip).
    if (!typeOfFile(it.path) || !canOpenExternally(it.path)) return { ok: false, error: "." + it.ext + " files are not opened from here - use Show in folder." };
    const err = await deps.shell.openPath(it.path);
    return err ? { ok: false, error: err } : { ok: true };
  }

  // ---- thumbnails: lazy, <= THUMB_CONCURRENCY at a time, cached on disk as small JPEGs ----
  let active = 0;
  const waiting = [];
  function slot() {
    return new Promise((res) => { if (active < THUMB_CONCURRENCY) { active++; res(); } else waiting.push(res); });
  }
  function release() { const next = waiting.shift(); if (next) next(); else active--; }

  async function thumbnail(agent, id) {
    const it = lookup(agent, id);
    if (!it || !["image", "pdf", "video", "word"].includes(it.type)) return { ok: false };
    if (it.thumb && fs.existsSync(it.thumb)) return { ok: true, path: it.thumb }; // the Library already made one
    let st;
    try { st = await fs.promises.stat(it.path); } catch (e) { return { ok: false }; }
    const key = crypto.createHash("sha1").update(`${it.path}|${st.mtimeMs}|${st.size}`).digest("hex");
    const out = path.join(deps.thumbDir, key + ".jpg");
    if (fs.existsSync(out)) return { ok: true, path: out };
    await slot();
    try {
      if (fs.existsSync(out)) return { ok: true, path: out };
      let img;
      if (it.type === "image" && it.ext !== "svg" && it.ext !== "heic") img = deps.nativeImage.createFromPath(it.path);
      if ((!img || img.isEmpty()) && deps.nativeImage.createThumbnailFromPath) {
        // Windows shell thumbnails: PDF, Word, video (and images the decoder could not read).
        img = await deps.nativeImage.createThumbnailFromPath(it.path, { width: THUMB_MAX_DIM, height: THUMB_MAX_DIM });
      }
      if (!img || img.isEmpty()) return { ok: false };
      const { width, height } = img.getSize();
      const scale = Math.min(1, THUMB_MAX_DIM / Math.max(width, height, 1));
      const small = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : img;
      fs.mkdirSync(deps.thumbDir, { recursive: true });
      fs.writeFileSync(out, small.toJPEG(75));
      return { ok: true, path: out };
    } catch (e) {
      return { ok: false };
    } finally {
      release();
    }
  }

  return { list, summary, open, thumbnail, lookup, _lists: lists };
}

module.exports = {
  create, query, isRead, pathKey, underRootsPlain, registeredKeys, canOpenExternally, stemKey, typeOfFile, normAgent, matchesAgent, idForPath, underRoots, realRoots, scanRoot, registryItems, scannedItems, finishItem, dayGroup,
  entryFile, registryCount, resolveAgent, kindLabel, stemTitle,
  PAGE_SIZE, THUMB_CONCURRENCY,
};
