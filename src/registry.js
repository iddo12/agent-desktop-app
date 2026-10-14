// The Library: Projects / Documents / Images tabs over the shared workspace
// registry (v1.38.0).
//
// The registry is shared_tools\registry.py's store - one JSON file per entry
// in <workspace>\shared_registry\. It is a root CLAUDE.md standing order
// (2026-09-22) that every agent registers the documents it writes and the
// things the owner can open, so this view answers "what have we made, and where
// is it?" without him remembering links or asking an agent to dig one up.
//
// Read-only here. Adding and editing stays with registry.py, which owns the
// id scheme, the image copying and the confirmedAt clock.
//
// Opening goes by ENTRY ID, never by a path handed over from the renderer:
// the main process looks the link up itself, so this IPC cannot be used to
// open an arbitrary file or URL.

const fs = require("fs");
const { readJsonFile } = require("./jsonfile");
const path = require("path");
const crypto = require("crypto");
const { shell, clipboard, nativeImage } = require("electron");

const STALE_AFTER_DAYS = 90; // same as registry.py

function registryDir(workspaceRoot) {
  return path.join(workspaceRoot, "shared_registry");
}

// the owner, 2026-09-28: the Images tab was serving full-resolution originals
// (some multi-MB 1024px renders) as thumbnails - "make sure the resolution on
// these thumbnails is fairly low, otherwise... the database will just
// increase significantly." Downscale once per source file and cache the
// result; `link` (Open / Show in folder) always stays the real original, only
// the card preview uses the small cached copy. Uses Electron's built-in
// nativeImage instead of adding an image-processing dependency.
const THUMB_MAX_DIM = 480;

// v1.93.0: created once per process (it was a recursive mkdirSync per image entry on every list rebuild: 200 calls
// per rebuild on the 300-entry test set). A failed thumbnail write forgets it, so a deleted folder is re-created.
const thumbDirsMade = new Set();
function thumbCacheDir(workspaceRoot) {
  const dir = path.join(registryDir(workspaceRoot), ".thumb-cache");
  if (thumbDirsMade.has(dir)) return dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    thumbDirsMade.add(dir);
  } catch (e) {
    /* fall through - cachedThumbnail() below falls back to the original */
  }
  return dir;
}

function cachedThumbnail(workspaceRoot, sourcePath, knownStat) {
  try {
    const stat = knownStat || fs.statSync(sourcePath);
    // Keyed by path + mtime + size so an edited/replaced source regenerates
    // instead of serving a stale cached preview forever.
    const key = crypto.createHash("sha1").update(`${sourcePath}|${stat.mtimeMs}|${stat.size}`).digest("hex");
    // JPEG, not PNG: these are photographic renders, where lossless PNG barely
    // shrinks past a couple hundred KB even at 480px. JPEG at this size is
    // visually indistinguishable for a card preview and typically 5-10x smaller.
    const outPath = path.join(thumbCacheDir(workspaceRoot), `${key}.jpg`);
    if (fs.existsSync(outPath)) return outPath;
    const img = nativeImage.createFromPath(sourcePath);
    if (img.isEmpty()) return sourcePath; // unreadable/corrupt - show the original rather than nothing
    const { width, height } = img.getSize();
    const scale = Math.min(1, THUMB_MAX_DIM / Math.max(width, height, 1));
    const resized = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : img;
    try {
      fs.writeFileSync(outPath, resized.toJPEG(80));
    } catch (e) {
      thumbDirsMade.delete(path.dirname(outPath));
      throw e;
    }
    return outPath;
  } catch (e) {
    return sourcePath; // a thumbnail failure must never break the whole Library list
  }
}

function loadEntries(workspaceRoot) {
  const dir = registryDir(workspaceRoot);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  } catch (e) {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const e = readJsonFile(path.join(dir, f));
      if (e && e.id && e.type) out.push(e);
    } catch (err) {
      /* mid-write (registry.py writes via a temp file, but be safe) */
    }
  }
  return out;
}

function isUrl(link) {
  return /^https?:\/\//i.test(String(link || ""));
}

// v1.92.0 (review S2): a registry link that is not a plain local drive path (UNC \\host\share, //host, \\?\, \\.\) is
// never handed to fs - existsSync on an unreachable UNC host froze the main process ~48 s and sends NTLM credentials.
const { isPlainLocalPath } = require("./localPath");
const localFile = (p) => !!p && !isUrl(p) && isPlainLocalPath(p);

function viewablePath(e) {
  const candidates = [e.pdf, e.link].filter((p) => localFile(p));
  for (const p of candidates) {
    if (/\.(pdf|png|jpe?g|gif|webp|html?)$/i.test(p) && fs.existsSync(p)) return p;
  }
  return null;
}

function listRegistryRaw(workspaceRoot) {
  const now = Date.now();
  return loadEntries(workspaceRoot)
    .map((e) => {
      const local = localFile(e.link);
      const confirmed = Date.parse(e.confirmedAt || e.updatedAt || e.createdAt || "");
      const thumbRaw = e.thumbnail || (e.type === "image" ? e.link : null);
      const thumb = localFile(thumbRaw) ? thumbRaw : null;
      // v1.93.0: one stat of the link instead of two existsSync + a statSync, one viewablePath() instead of two, and the
      // thumbnail reuses the link's stat when it is the same file (most images). Same values as before. Only plain local
      // paths (localFile, v1.92.0) ever reach fs.
      let linkStat = null;
      if (local) { try { linkStat = fs.statSync(e.link); } catch (err) { linkStat = null; } }
      const viewable = viewablePath(e);
      let thumbStat = null;
      if (thumb) {
        if (thumb === e.link) thumbStat = linkStat;
        else { try { thumbStat = fs.statSync(thumb); } catch (err) { thumbStat = null; } }
      }
      return {
        id: e.id,
        type: e.type,
        title: e.title || e.id,
        description: e.description || "",
        agent: e.agent || "",
        topic: e.topic || "",
        link: e.link || "",
        isUrl: isUrl(e.link),
        // A local link that no longer exists is worth showing plainly - the
        // registry is only useful if it does not quietly point at nothing.
        missing: !!(local && !linkStat),
        thumbnail: thumbStat ? cachedThumbnail(workspaceRoot, thumb, thumbStat) : null,
        // the owner, 2026-09-28: wants an image's size and folder visible on its
        // card, not just its name. Computed here (main process) rather than
        // the renderer so the renderer never needs raw filesystem access.
        fileSize: linkStat ? linkStat.size : null,
        folder: local ? path.dirname(e.link) : null,
        // What the in-app viewer can show: the entry's PDF copy if it has one,
        // else a local PDF/image/HTML link. Web links open in the browser.
        viewable: !!viewable,
        // v1.64.0: the full local path of the document itself (its PDF copy for a web entry), for "send to an agent".
        path: viewable || (local ? e.link : ""),
        status: e.status || "active",
        // v1.60.0: pipeline stage (idea | researched | active) for the Projects
        // view. A project with no stage is active (every entry older than this).
        // An unrecognised value (a typo) falls back to active for projects so it never vanishes.
        stage: ["idea", "researched", "active"].includes(e.stage) ? e.stage : e.type === "project" ? "active" : "",
        updatedAt: e.updatedAt || e.createdAt || null,
        staleDays: Number.isFinite(confirmed) ? Math.floor((now - confirmed) / 86400000) : null,
        // Previous versions of this document (registry.py --update --link keeps them).
        // Only the display bits go to the renderer; opening is by index through main.
        olderVersions: (Array.isArray(e.olderVersions) ? e.olderVersions : []).map((v) => ({
          name: path.basename(String(v.link || "")), date: v.replacedAt || null, exists: !!(v.link && (isUrl(v.link) || (localFile(v.link) && fs.existsSync(v.link)))),
        })),
        _pdf: e.pdf || null,
      };
    })
    .map((e) => ({ ...e, stale: e.staleDays != null && e.staleDays > STALE_AFTER_DAYS }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// A document's web copy (a web link whose `pdf` is another entry's file) is one document,
// not two: fold it into the file's card as a "Web version" button.
function normLink(p) { return String(p || "").replace(/\\/g, "/").toLowerCase(); }
function mergeWebCopies(list) {
  const byLink = new Map(list.filter((e) => !e.isUrl && e.link).map((e) => [normLink(e.link), e]));
  const out = [];
  for (const e of list) {
    const host = e.isUrl && e._pdf ? byLink.get(normLink(e._pdf)) : null;
    if (host && host.type === e.type) { host.hasWebCopy = true; continue; }
    out.push(e);
  }
  return out.map(({ _pdf, ...rest }) => rest);
}
function webCopyOf(workspaceRoot, host) {
  const key = normLink(host.link);
  return loadEntries(workspaceRoot).find((x) => x.id !== host.id && isUrl(x.link) && x.pdf && normLink(x.pdf) === key) || null;
}

// v1.77.3: listRegistryRaw did ~5 sync fs calls per entry (448 entries, 551 ms of main-thread block) on every 30 s poll.
// The list is now cached keyed on the registry folder's signature (names + size/mtime of every entry file: one readdir and
// one stat each, a few ms) so a changed, added or removed entry rebuilds it at once; with an unchanged folder the answer
// is reused for up to EXISTS_MEMO_MS, which bounds how stale the per-entry "missing / thumbnail / file size / viewable"
// file-existence checks can be (a linked file that appears or vanishes on its own).
const EXISTS_MEMO_MS = 60 * 1000;
const listCache = new Map(); // workspaceRoot -> { sig, at, value }
function registrySignature(workspaceRoot) {
  const dir = registryDir(workspaceRoot);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort(); } catch (e) { return "none"; }
  const parts = [];
  for (const f of files) {
    try { const s = fs.statSync(path.join(dir, f)); parts.push(f + ":" + s.size + ":" + s.mtimeMs); } catch (e) { parts.push(f + ":-"); }
  }
  return parts.join("|");
}
function listRegistry(workspaceRoot) {
  const now = Date.now();
  const sig = registrySignature(workspaceRoot);
  const hit = listCache.get(workspaceRoot);
  if (hit && hit.sig === sig && now - hit.at < EXISTS_MEMO_MS) return hit.value;
  const value = mergeWebCopies(listRegistryRaw(workspaceRoot));
  listCache.set(workspaceRoot, { sig, at: now, value });
  return value;
}
function invalidateListCache() { listCache.clear(); }

function findEntry(workspaceRoot, id) {
  return loadEntries(workspaceRoot).find((e) => e.id === id) || null;
}

async function registryAction(workspaceRoot, id, action) {
  const e = findEntry(workspaceRoot, id);
  if (!e || !e.link) return { ok: false, error: "No such entry, or it has no link." };
  if (action === "copy") {
    clipboard.writeText(e.link);
    return { ok: true };
  }
  if (action === "openWeb") {
    const w = webCopyOf(workspaceRoot, e);
    if (!w) return { ok: false, error: "No web version registered for this document." };
    await shell.openExternal(w.link);
    return { ok: true };
  }
  const olderIdx = /^openOlder:(\d+)$/.exec(String(action));
  if (olderIdx) {
    const v = (Array.isArray(e.olderVersions) ? e.olderVersions : [])[Number(olderIdx[1])];
    if (!v || !v.link) return { ok: false, error: "No such older version." };
    if (isUrl(v.link)) { await shell.openExternal(v.link); return { ok: true }; }
    if (!localFile(v.link) || !fs.existsSync(v.link)) return { ok: false, error: "That older file is no longer at " + v.link };
    const err = await shell.openPath(v.link);
    return err ? { ok: false, error: err } : { ok: true };
  }
  if (action === "view") {
    // In-app viewer: returns a file:// URL for the renderer's viewer frame.
    // Still looked up by entry id only - the renderer never supplies a path.
    const p = viewablePath(e);
    if (!p) return { ok: false, error: "Nothing viewable inside the app for this entry." };
    return { ok: true, url: "file:///" + p.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:"), title: e.title };
  }
  if (action === "openPdf" && localFile(e.pdf) && fs.existsSync(e.pdf)) {
    const err = await shell.openPath(e.pdf);
    return err ? { ok: false, error: err } : { ok: true };
  }
  if (isUrl(e.link)) {
    if (action !== "open") return { ok: false, error: "That entry is a web link, not a file." };
    await shell.openExternal(e.link);
    return { ok: true };
  }
  if (!localFile(e.link)) return { ok: false, error: "Only local files are opened from here (network and device paths are refused)." };
  if (!fs.existsSync(e.link)) return { ok: false, error: "The file is no longer at " + e.link };
  if (action === "reveal") {
    shell.showItemInFolder(e.link);
    return { ok: true };
  }
  // v1.59.4: phone app packages can't be opened on Windows - shell.openPath
  // "succeeded" on the Show Contacts .apk and nothing happened (the owner, 2026-09-25).
  const NOT_FOR_WINDOWS = { ".apk": "an Android app", ".aab": "an Android app bundle", ".ipa": "an iPhone app" };
  const kind = NOT_FOR_WINDOWS[path.extname(e.link).toLowerCase()];
  if (action === "open" && kind) {
    return { ok: false, error: `This is ${kind} package - it installs on the phone, not on Windows. Use "Show in folder" and copy it to the phone.` };
  }
  const err = await shell.openPath(e.link); // "" on success
  return err ? { ok: false, error: err } : { ok: true };
}

module.exports = { listRegistry, registryAction, loadEntries, invalidateListCache, registrySignature, listRegistryRaw, mergeWebCopies };
