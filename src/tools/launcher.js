// TOOLS v1 launcher allow-list and start. The ONLY code that starts a tool.
// Rules: the command comes from tools.json (never from the renderer, which sends only a tool id); the launcher file must lie under
// an allowed root (after resolving junctions/symlinks), have an allowed extension, exist, and use a plain character set; arguments
// are a short list of plain tokens; the process is spawned detached, hidden, with an argument ARRAY and no shell string.
"use strict";
const nodePath = require("path");
const nodeFs = require("fs");

const W = nodePath.win32;
// v1.121.0: no built-in folders. The allowed roots come from the configuration (toolsAllowedRoots); nothing configured = every launch is refused.
const DEFAULT_ROOTS = [];
const EXTS = [".vbs", ".bat", ".cmd", ".ps1", ".exe"];
// letters, digits, space, _ . ( ) - and path separators; no quotes, no & ^ % ! ; , ' $ ` < > | * ? and no non-ASCII
const PATH_RE = /^[A-Za-z]:\\[A-Za-z0-9 _.()\\-]+$/;
const ARG_RE = /^[A-Za-z0-9_.:=\\/-]{1,200}$/;       // no spaces, quotes or shell metacharacters
const FLAG_RE = /^-{1,2}[A-Za-z][A-Za-z0-9_-]{0,40}$/; // an argument may start with '-' only if it is a plain flag name
const MAX_ARGS = 8;
const sys32 = () => W.join(process.env.SystemRoot || process.env.windir || W.join(W.parse(process.execPath).root, "Windows"), "System32");
const SYS = { cmd: () => W.join(sys32(), "cmd.exe"), wscript: () => W.join(sys32(), "wscript.exe"), powershell: () => W.join(sys32(), "WindowsPowerShell", "v1.0", "powershell.exe") };

const inside = (root, p) => { const r = root.toLowerCase().replace(/\\+$/, ""); const q = p.toLowerCase(); return q.startsWith(r + "\\") && q.length > r.length + 1; };
const realOf = (fsx, p) => (fsx.realpathSync.native ? fsx.realpathSync.native(p) : fsx.realpathSync(p));

// check({path,args}, {roots, fs}) -> { ok, reason, file, real, args, ext }
function check(launch, opts) {
  const o = opts || {};
  const roots = (o.roots || DEFAULT_ROOTS).map((r) => W.normalize(r).replace(/\\+$/, ""));
  const fsx = o.fs || nodeFs;
  const no = (reason) => ({ ok: false, reason });
  if (!launch || typeof launch !== "object" || typeof launch.path !== "string" || !launch.path) return no("no-launcher");
  const p = launch.path.replace(/\//g, "\\");
  if (/^\\\\/.test(p)) return no("unc-or-device-path");
  if (!/^[A-Za-z]:\\/.test(p)) return no("relative-path");
  if (p.length > 400) return no("too-long");
  if (!PATH_RE.test(p)) return no("bad-characters");
  const segs = p.split("\\");
  if (segs.some((s) => s === ".." || s === ".")) return no("path-traversal");
  if (segs.slice(1).some((s) => s === "" || /^\s|\s$|\.$/.test(s))) return no("bad-path");   // empty segment, edge spaces, trailing dot
  const ext = W.extname(p).toLowerCase();
  if (!EXTS.includes(ext)) return no("extension-not-allowed");
  const file = W.normalize(p);
  if (!roots.some((r) => inside(r, file))) return no("outside-allowed-folders");
  const args = Array.isArray(launch.args) ? launch.args : [];
  if (args.length > MAX_ARGS) return no("too-many-args");
  for (const a of args) {
    if (typeof a !== "string" || !ARG_RE.test(a)) return no("bad-argument");
    if (a.startsWith("-") && !FLAG_RE.test(a)) return no("bad-argument");
    if (/^\/[A-Za-z?]/.test(a) || a.startsWith("//")) return no("bad-argument");   // cmd/wscript switches
  }
  // cmd.exe keeps the quotes round a path with spaces only when that is the whole command; a path with parentheses plus arguments would
  // be re-parsed, so that combination is refused rather than guessed at.
  if ((ext === ".bat" || ext === ".cmd") && args.length && /[()]/.test(file)) return no("bad-argument");
  // junctions / symlinks: the real location must also be inside an allowed root
  let real;
  try {
    const st = fsx.statSync(file);
    if (!st.isFile()) return no("not-a-file");
    real = W.normalize(realOf(fsx, file));
  } catch (e) { return no("missing"); }
  const realRoots = roots.map((r) => { try { return W.normalize(realOf(fsx, r)); } catch (e) { return r; } });
  if (!realRoots.some((r) => inside(r, real))) return no("resolves-outside-allowed-folders");
  if (W.extname(real).toLowerCase() !== ext) return no("extension-not-allowed");
  return { ok: true, reason: "", file, real, args, ext };
}

// How each extension is run. Argument ARRAYS only. cwd = the launcher's own folder.
function commandFor(c) {
  const dir = W.dirname(c.file);
  switch (c.ext) {
    case ".vbs": return { exe: SYS.wscript(), argv: ["//B", "//Nologo", c.file].concat(c.args), cwd: dir };
    case ".ps1": return { exe: SYS.powershell(), argv: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", c.file].concat(c.args), cwd: dir };
    case ".exe": return { exe: c.file, argv: c.args.slice(), cwd: dir };
    default: return { exe: SYS.cmd(), argv: ["/d", "/c", c.file].concat(c.args), cwd: dir };   // .bat/.cmd: full path (cmd does not search the cwd); Node quotes a path with spaces
  }
}

// start(launch, {roots, fs, spawn}) -> { ok, reason, pid? }. Never throws.
function start(launch, opts) {
  const o = opts || {};
  const c = check(launch, o);
  if (!c.ok) return { ok: false, reason: c.reason };
  const cmd = commandFor(c);
  try {
    const sp = o.spawn || require("child_process").spawn;
    const child = sp(cmd.exe, cmd.argv, { cwd: cmd.cwd, detached: true, windowsHide: true, stdio: "ignore", shell: false });
    if (child && typeof child.on === "function") child.on("error", () => {});
    if (child && typeof child.unref === "function") child.unref();
    return { ok: true, reason: "", pid: child && child.pid };
  } catch (e) { return { ok: false, reason: "spawn-failed" }; }
}

module.exports = { SYS, check, commandFor, start, DEFAULT_ROOTS, EXTS };
