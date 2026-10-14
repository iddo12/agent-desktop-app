// Dependency doctor (v1.119.1). The owner, 2026-10-13: updating Agent Desktop must work from inside the app with ONE
// click, never needing `npm install` by hand. The old updater refused whenever origin/main's package.json listed a
// package missing from node_modules (a partner's v1.114.0 stuck on imapflow/libmime). This module is the other half:
// it finds what package.json (dependencies + optionalDependencies) asks for that node_modules lacks, and installs
// exactly those packages, by itself, in the background.
//
// What it will NOT do (reports "needs a full reinstall" and touches nothing):
//  - a changed node-pty version, or node-pty missing: it is a native module (compiled against Electron's ABI);
//  - a changed devDependencies.electron: the app would run on another Electron than the one installed.
//
// How it installs: `npm install --no-save --no-package-lock --ignore-scripts --no-audit <name>@<range>...`
// -- ONLY the missing names, explicitly. A plain `npm install --omit=dev` was tried and rejected: it PRUNES every
// installed devDependency, i.e. it would delete node_modules/electron (the thing the app is running from).
// Explicit names leave everything else alone, never rewrite package.json or package-lock.json (so the git tree stays
// clean), and run no install scripts (pure-JS packages only; native ones are refused above).
//
// Everything is async (spawn, never the sync variants), at below-normal priority, with an 8 minute timeout whose
// expiry kills the whole npm process tree. npm is located with `where npm` (the app is often started without a
// shell that has Node on PATH); if the process cannot be spawned at all it falls back to the pty runner main.js uses
// for claude/git (`ptyRun`). The runner is injected so tests use a fake npm.
//
// Status goes to <userData>/dep-doctor.json: { state: idle|installing|done|failed, missing: [...], error, at }.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const INSTALL_TIMEOUT_MS = 8 * 60 * 1000;
const NATIVE = "node-pty";

// Which user-visible feature a package belongs to (only for the status text).
const FEATURES = { imapflow: "e-mail", libmime: "e-mail" };

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return null;
  }
}

// Pure-ish: {name: range} of everything the app should have installed (not devDependencies).
function wanted(pkg) {
  return Object.assign({}, (pkg && pkg.optionalDependencies) || {}, (pkg && pkg.dependencies) || {});
}

// Installed = package.json readable AND an entry point that can actually be loaded (a half-extracted package, e.g. after a
// killed npm, has package.json but not its files). Scoped names (@xterm/xterm) are two path segments.
function isInstalled(repoDir, name) {
  const dir = path.join(repoDir, "node_modules", ...String(name).split("/"));
  const pj = readJson(path.join(dir, "package.json"));
  if (!pj) return false;
  const ex = (f) => { try { return fs.statSync(path.join(dir, f)).isFile(); } catch (e) { return false; } };
  if (pj.main) {
    const m = String(pj.main);
    return ex(m) || ex(m + ".js") || ex(m + ".json") || ex(path.join(m, "index.js"));
  }
  if (pj.exports || pj.module) return true; // cannot cheaply resolve conditional exports; package.json readable is the best check
  return ex("index.js") || ex("index.json") || ex("index.node");
}

// ---- spec validation: nothing but a registry name and a plain semver range ever reaches npm / cmd.exe ----
const NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const RANGE_RE = /^[\^~<>=0-9a-zA-Z.\s*|-]+$/;
function specProblem(name, range) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.length > 214) return "unsupported spec (package name " + JSON.stringify(String(name).slice(0, 60)) + ")";
  const r = String(range == null ? "" : range).trim();
  if (!r || r.length > 100 || !RANGE_RE.test(r) || /[:\/@%!]/.test(r) || /^(git|http|https|file|npm|github|link|workspace)/i.test(r)) return "unsupported spec (" + name + "@" + JSON.stringify(r.slice(0, 40)) + ")";
  return null;
}

// Top-level entries of node_modules (scoped packages as @scope/name), for "what did this run create".
function listModules(repoDir) {
  const out = new Set();
  const nm = path.join(repoDir, "node_modules");
  let top = [];
  try { top = fs.readdirSync(nm); } catch (e) { return out; }
  for (const e of top) {
    out.add(e);
    if (e.startsWith("@")) { try { for (const c of fs.readdirSync(path.join(nm, e))) out.add(e + "/" + c); } catch (err) {} }
  }
  return out;
}
// Remove what a FAILED run created (only entries that did not exist before it): half-extracted packages and npm's .staging.
function cleanNewModules(repoDir, before, log) {
  const after = listModules(repoDir);
  const nm = path.join(repoDir, "node_modules");
  for (const e of after) {
    if (before.has(e)) continue;
    if (e.startsWith("@") && !e.includes("/")) continue; // scope folder: removed below if empty
    try { fs.rmSync(path.join(nm, ...e.split("/")), { recursive: true, force: true }); log("dep-doctor: removed partial " + e); } catch (err) {}
  }
  for (const e of after) {
    if (e.startsWith("@") && !e.includes("/") && !before.has(e)) { try { fs.rmdirSync(path.join(nm, e)); } catch (err) {} }
  }
}

// v1.119.3: npm runs in a SCRATCH folder, never in the app folder. In the app folder npm re-checks every installed package and
// tried to rewrite node_modules/electron (locked by the running app: EBUSY on a second PC, 2026-10-13). Here the packages npm
// downloaded are copied in afterwards, only the ones the app folder does not have yet.
function adoptModules(scratch, repoDir, log) {
  const to = path.join(repoDir, "node_modules");
  const names = listModules(scratch);
  if (!names.size) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of names) {
    if (e.startsWith(".") || (e.startsWith("@") && !e.includes("/"))) continue;
    const src = path.join(scratch, "node_modules", ...e.split("/")), dest = path.join(to, ...e.split("/"));
    if (fs.existsSync(dest)) { log("dep-doctor: kept the installed " + e); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    n++;
  }
  return n;
}

function computeMissing(repoDir, pkg) {
  return Object.keys(wanted(pkg)).filter((n) => !isInstalled(repoDir, n));
}

// A change this module refuses to handle (returns a plain sentence, or null). `localPkg` may be null (start-up
// check: only a missing native module can be detected then).
function unsupportedChange(localPkg, newPkg, missing) {
  const msg = (what) => `This version changes ${what}, which cannot be installed from inside the app - it needs a full reinstall. Ask whoever maintains your copy of Agent Desktop.`;
  if (missing && missing.includes(NATIVE)) return msg("the terminal component (node-pty)");
  if (localPkg && newPkg) {
    const a = (localPkg.dependencies || {})[NATIVE];
    const b = (newPkg.dependencies || {})[NATIVE];
    if (a && b && a !== b) return msg("the terminal component (node-pty)");
    const ea = (localPkg.devDependencies || {}).electron;
    const eb = (newPkg.devDependencies || {}).electron;
    if (ea && eb && ea !== eb) return msg("the app engine (Electron " + eb + ")");
  }
  return null;
}

const featureText = (names) => {
  const f = [...new Set(names.map((n) => FEATURES[n] || n))];
  return f.join(", ");
};

// --------------------------------------------------------- real runner ----

function killTree(child) {
  try {
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    else child.kill("SIGKILL");
  } catch (e) {}
}

// Resolves { code, out, timedOut, spawnFailed }. Never rejects.
function spawnRun(file, args, { cwd, timeoutMs, verbatim, env }) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let timedOut = false;
    let child;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Object.assign({ out: out.slice(-4000), timedOut }, r));
    };
    let timer = null;
    try {
      child = spawn(file, args, { cwd, env: env || process.env, windowsHide: true, windowsVerbatimArguments: !!verbatim, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ code: -1, spawnFailed: true, out: e.message });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish({ code: -1 });
    }, timeoutMs);
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch (e) {}
    const add = (c) => {
      out += c;
      if (out.length > 16000) out = out.slice(-8000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.on("error", (e) => finish({ code: -1, spawnFailed: true, out: e.message }));
    child.on("close", (code) => finish({ code: code == null ? 1 : code }));
  });
}

function whereNpm() {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where" : "which";
    try {
      execFile(cmd, ["npm"], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        if (err) return resolve(null);
        const lines = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        resolve(lines.find((l) => /\.cmd$/i.test(l)) || lines[0] || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// Default runner used by the app: (npmArgs, {cwd, timeoutMs}) -> { code, out, timedOut }.
function makeDefaultRunner({ ptyRun } = {}) {
  return async function run(npmArgs, { cwd, timeoutMs }) {
    let npm = await whereNpm();
    if (!npm && process.platform === "win32") {
      const guess = "C:\\Program Files\\nodejs\\npm.cmd";
      if (fs.existsSync(guess)) npm = guess;
    }
    if (npm) {
      let r;
      if (process.platform === "win32") {
        const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
        const line = `"${npm}" ${npmArgs.join(" ")}`;
        r = await spawnRun(comspec, ["/d", "/s", "/c", `"${line}"`], { cwd, timeoutMs, verbatim: true });
      } else {
        r = await spawnRun(npm, npmArgs, { cwd, timeoutMs });
      }
      if (!r.spawnFailed) return r;
    }
    // Could not locate or start npm directly: try the pty runner (cmd.exe resolves PATH itself).
    if (ptyRun && process.platform === "win32") {
      const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
      try {
        const out = await ptyRun(comspec, ["/d", "/v:on", "/c", `npm ${npmArgs.join(" ")} & echo __AD_RC=!errorlevel!`], { cwd, timeoutMs }, 1, 0);
        const m = /__AD_RC=(\d+)/.exec(out);
        return { code: m ? Number(m[1]) : 1, out: String(out).replace(/__AD_RC=\d+\s*$/, "").slice(-4000), timedOut: false };
      } catch (e) {
        return { code: -1, out: e.message, timedOut: false };
      }
    }
    return { code: -1, out: "npm (Node.js) was not found on this computer", timedOut: false, notFound: true };
  };
}

// --------------------------------------------------------------- doctor ----

// create({ repoDir, statusFile, run, ptyRun, timeoutMs, testMode, log })
function create(opts) {
  const repoDir = opts.repoDir;
  const statusFile = opts.statusFile || null;
  const timeoutMs = opts.timeoutMs || INSTALL_TIMEOUT_MS;
  const testMode = !!opts.testMode;
  const log = opts.log || (() => {});
  const run = opts.run || makeDefaultRunner({ ptyRun: opts.ptyRun });
  let current = { state: "idle", missing: [], error: null, at: Date.now() };
  let inflight = null;

  function set(state, missing, error) {
    current = { state, missing: missing || [], error: error || null, at: Date.now() };
    if (statusFile) {
      try {
        fs.mkdirSync(path.dirname(statusFile), { recursive: true });
        fs.writeFileSync(statusFile, JSON.stringify(current, null, 2), "utf-8");
      } catch (e) {}
    }
    try {
      if (opts.onStatus) opts.onStatus(Object.assign({}, current, { feature: featureText(current.missing) }));
    } catch (e) {}
    return current;
  }

  // Check, and install what is missing. `pkg` = the package.json to satisfy (default: the one on disk);
  // `localPkg` = the one the running install had, to detect engine/native changes (optional).
  // Resolves { ok, state, missing, error?, needsReinstall? }. Never rejects.
  function ensure({ pkg, localPkg } = {}) {
    if (testMode) return Promise.resolve({ ok: true, state: "idle", missing: [], testMode: true });
    if (inflight) return inflight;
    inflight = (async () => {
      let scratch = null;
      try {
        const p = pkg || readJson(path.join(repoDir, "package.json"));
        if (!p) {
          const err = "package.json could not be read";
          set("failed", [], err);
          return { ok: false, state: "failed", missing: [], error: err };
        }
        const missing = computeMissing(repoDir, p);
        const bad = unsupportedChange(localPkg || null, p, missing);
        if (bad) {
          set("failed", missing, bad);
          return { ok: false, state: "failed", missing, error: bad, needsReinstall: true };
        }
        if (!missing.length) {
          set("idle", [], null);
          return { ok: true, state: "idle", missing: [] };
        }
        const ranges = wanted(p);
        for (const nme of missing) {
          const prob = specProblem(nme, ranges[nme]);
          if (prob) { set("failed", missing, prob); return { ok: false, state: "failed", missing, error: prob }; }
        }
        set("installing", missing, null);
        const before = listModules(repoDir);
        const specs = missing.map((n) => `${n}@${ranges[n]}`);
        // Quote for cmd.exe: a range like ">=1 <2" has spaces and shell characters.
        const q = (s) => (/[\s<>|&^"]/.test(s) ? `"${s.replace(/"/g, "")}"` : s);
        const args = ["install", "--no-save", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress", ...specs.map(q)];
        log("dep-doctor: installing " + specs.join(", "));
        let r;
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-desktop-dep-"));
        try { fs.writeFileSync(path.join(scratch, "package.json"), '{"name":"agent-desktop-dep-scratch","version":"1.0.0","private":true}'); } catch (e) {}
        try {
          r = await run(args, { cwd: scratch, timeoutMs });
        } catch (e) {
          r = { code: -1, out: e.message };
        }
        // A damaged npm cache (seen for real on this PC: ENOENT on a _cacache content file) fails every install; retry once with a
        // private cache folder so the person's own npm cache is not touched.
        if (r && r.code !== 0 && !r.timedOut && /_cacache|EINTEGRITY|ECACHE/i.test(String(r.out))) {
          cleanNewModules(repoDir, before, log);
          log("dep-doctor: npm cache looks damaged, retrying with a private cache");
          try { r = await run([...args, "--cache", q(path.join(os.tmpdir(), "agent-desktop-npm-cache"))], { cwd: scratch, timeoutMs }); } catch (e) { r = { code: -1, out: e.message }; }
        }
        if (r && r.code === 0) {
          try { adoptModules(scratch, repoDir, log); } catch (e) { r = { code: -1, out: "could not copy the installed packages: " + e.message }; }
        }
        const still = computeMissing(repoDir, p);
        if (r && r.code === 0 && !still.length) {
          set("done", missing, null);
          return { ok: true, state: "done", missing, installed: missing };
        }
        let why;
        if (r && r.timedOut) why = `the install did not finish within ${Math.round(timeoutMs / 60000)} minutes`;
        else if (r && r.code === 0) why = "npm finished but " + still.join(", ") + " is still missing";
        else {
          const tail = String((r && r.out) || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ").slice(0, 300);
          why = "npm could not install " + missing.join(", ") + (tail ? " (" + tail + ")" : "");
        }
        cleanNewModules(repoDir, before, log);
        set("failed", missing, why);
        return { ok: false, state: "failed", missing, error: why };
      } catch (e) {
        set("failed", [], e.message);
        return { ok: false, state: "failed", missing: [], error: e.message };
      } finally {
        if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {} }
        inflight = null;
      }
    })();
    return inflight;
  }

  return { ensure, status: () => Object.assign({}, current), computeMissing: (pkg) => computeMissing(repoDir, pkg || readJson(path.join(repoDir, "package.json")) || {}) };
}

module.exports = { specProblem, isInstalled, spawnRun, create, computeMissing, unsupportedChange, wanted, makeDefaultRunner, featureText, INSTALL_TIMEOUT_MS, FEATURES };
