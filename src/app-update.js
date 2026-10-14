// In-app "Update & restart" (v1.58.0). 2026-09-25 request: Agent Desktop should
// notice a newer version of itself and restart onto it from inside the app,
// instead of an agent asking the person to restart it by hand.
//
// Two install shapes, two sources of "newer":
//
//  - Unpackaged (`electron .` from a git checkout - the original author's own install). Two
//    things can be newer than what is running:
//      1. the code on disk: an agent committed or pulled, but the app was not
//         restarted (app.getVersion() is read once at start, package.json on
//         disk is current);
//      2. origin/main: commits pushed that this checkout does not have yet.
//    Applying = fast-forward-only merge of origin/main (only on a clean main
//    that has no local commits of its own), then restart. It refuses rather
//    than guesses: a dirty tree, another branch, a diverged main, or a new
//    runtime dependency that is not in node_modules all stop it with the
//    reason. v1.119.1 (the owner's rule: updating must be ONE click, never `npm install`
//    by hand): an ordinary missing JS package no longer blocks. After the
//    fast-forward, src/dep-doctor.js installs exactly the packages the new
//    package.json needs; if that fails the merge is rolled back
//    (`git reset --keep <previous HEAD>`; the tree is re-checked clean right
//    before the merge, and --keep refuses rather than destroy an edit) and the error says the update was undone - never a
//    half-updated checkout. Only a changed node-pty (native module) or
//    Electron version still blocks, with a plain "needs a full reinstall".
//    The same doctor also runs a delayed check at every app start (see
//    startupDepCheck), for code that arrived by a pull done outside the app.
//    New packages must go in package.json `optionalDependencies` (loaded
//    lazily): updaters installed before v1.119.1 block on new `dependencies`.
//
//  - Packaged (the installer SE is building). Newer = the latest GitHub
//    Release. For now that is a notice plus a Download button that opens the
//    release page; a silent electron-updater install needs signing and
//    publish config agreed with SE first, so it is deliberately not here yet.
//
// Git runs through the async child_process.execFile (the sync variants are
// the ones confirmed unreliable in this app's launch chain - see the
// native-agent block in main.js), and falls back to the pty runner main.js
// already uses for claude/npm if execFile cannot even start the process.
//
// Test mode never touches git and never relaunches: set
// AGENT_DESKTOP_TEST_FAKE_UPDATE=1 in the sandbox to get a fake "update
// available" and exercise the whole overlay without side effects.

const path = require("path");
const fs = require("fs");
const https = require("https");
const { execFile } = require("child_process");
const depDoctor = require("./dep-doctor");

// v1.121.0: where updates come from is configuration, not code: appConfig "updateRepo" (GitHub owner/name, used by installed copies to look
// up the latest Release; unset = no update source, the check says so calmly) and "updateChannel" (the branch a checkout follows, default
// "main"). Both are validated before they go into a URL or a git argument. The update steps themselves are unchanged.
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const CHANNEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
function cfgValue(key) {
  try { return require("./appConfig").get(key); } catch (e) { return null; }
}
function releasesRepo() {
  const v = cfgValue("updateRepo");
  return typeof v === "string" && REPO_RE.test(v) && !/\.\./.test(v) ? v : null;
}
function channel() {
  const v = cfgValue("updateChannel");
  return typeof v === "string" && CHANNEL_RE.test(v) && !/\.\.|\/\/|\/$|\.lock$/.test(v) ? v : "main";
}
const GIT_TIMEOUT_MS = 60 * 1000;

let deps = null; // { app, runClaudeCommand, stripTerminalCodes, testMode, isVersionNewer, onDepStatus?, npmRun? }
let doctor = null;

function getDoctor() {
  if (!doctor) {
    let statusFile = null;
    try {
      statusFile = path.join(deps.app.getPath("userData"), "dep-doctor.json");
    } catch (e) {}
    doctor = depDoctor.create({
      repoDir: repoDir(),
      statusFile,
      testMode: !!(deps.testMode && deps.testMode.TEST_MODE),
      run: deps.npmRun, // tests inject a fake npm; undefined = the real one
      ptyRun: deps.runClaudeCommand,
      onStatus: (s) => {
        if (deps.onDepStatus) deps.onDepStatus(s);
      },
    });
  }
  return doctor;
}

function init(d) {
  deps = d;
  doctor = null;
}

// Delayed start-up check (called by main.js ~20 s after the window loads). Installs whatever package.json needs
// that node_modules lacks. Resolves the doctor's result; never throws.
async function startupDepCheck() {
  try {
    return await getDoctor().ensure({});
  } catch (e) {
    return { ok: false, state: "failed", error: e.message };
  }
}

const depStatus = () => (doctor ? doctor.status() : { state: "idle", missing: [], error: null });

function repoDir() {
  return (deps && deps.repoDir) || path.join(__dirname, "..");
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return null;
  }
}

function diskVersion() {
  const pkg = readJson(path.join(repoDir(), "package.json"));
  return pkg && pkg.version ? String(pkg.version) : null;
}

// ---------------------------------------------------------------- git ----

let launchInst = null;
function resolveGit() {
  if (process.platform !== "win32") return "git";
  if (!launchInst) launchInst = require("./launchEnv").createLaunchEnv({ cfg: require("./appConfig") });
  return launchInst.git();
}

const GIT_ENV = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0", // never sit on a credential prompt
  GIT_PAGER: "cat",
  PAGER: "cat",
  LC_ALL: "C",
});

// Resolves { code, out } - code 0 on success. Never rejects.
function git(args) {
  const gitPath = resolveGit();
  if (!gitPath) return Promise.resolve({ code: -1, out: "git was not found on this computer" });
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        gitPath,
        ["--no-pager", ...args],
        { cwd: repoDir(), env: GIT_ENV(), windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && (err.code === "ENOENT" || err.code === "EINVAL" || err.errno === -4058)) {
            resolve(gitViaPty(gitPath, args));
            return;
          }
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolve({ code, out: String(stdout || "") + (code ? String(stderr || "") : "") });
        }
      );
    } catch (e) {
      resolve(gitViaPty(gitPath, args));
      return;
    }
    if (child && child.on) child.on("error", () => {}); // handled by the callback
  });
}

// Fallback only. The pty merges stdout and stderr and has no exit code, so a
// marker line carries it: the command runs under cmd.exe with a trailing
// `echo` of the delayed-expansion errorlevel.
async function gitViaPty(gitPath, args) {
  if (!deps || !deps.runClaudeCommand) return { code: -1, out: "no command runner available" };
  const comspec = process.env.ComSpec || path.join(process.env.SystemRoot || process.env.windir || "", "System32", "cmd.exe");
  const quoted = ['"' + gitPath + '"', "--no-pager", ...args.map((a) => (/[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a))];
  try {
    const out = await deps.runClaudeCommand(
      comspec,
      ["/d", "/v:on", "/c", quoted.join(" ") + " & echo __AD_RC=!errorlevel!"],
      { cwd: repoDir(), env: GIT_ENV(), timeoutMs: GIT_TIMEOUT_MS },
      1,
      0
    );
    const m = /__AD_RC=(\d+)/.exec(out);
    return { code: m ? Number(m[1]) : 1, out: out.replace(/__AD_RC=\d+\s*$/, "") };
  } catch (e) {
    return { code: -1, out: e.message };
  }
}

const firstLine = (s) => String(s || "").trim().split(/\r?\n/)[0].trim();

// 2026-09-28: the "already on disk, just restart" screen showed no
// changelog at all - only the git-pull path ever populated `commits` (raw
// commit subjects from origin/main). CLAUDE.md's own `## vX.Y.Z - <title>`
// headings are a better source than commit subjects (human-written summaries,
// not tracked by git in this repo so this reads it straight off disk) and
// work for both paths: whatever versions sit strictly between what is
// running and what is being applied. Best-effort - a missing/unparsable
// CLAUDE.md just yields an empty changelog, never blocks the update itself.
function changelogFromClaudeMd(fromVersion, toVersion) {
  try {
    const text = fs.readFileSync(path.join(repoDir(), "CLAUDE.md"), "utf-8");
    const out = [];
    for (const m of text.matchAll(/^## v(\d+\.\d+\.\d+)\s*-\s*(.+)$/gm)) {
      const version = m[1];
      if (!deps.isVersionNewer(version, fromVersion)) continue; // version <= fromVersion
      if (deps.isVersionNewer(version, toVersion)) continue; // version > toVersion
      const title = m[2].replace(/\s*\(\d{4}-\d{2}-\d{2}[^)]*\)\s*/g, " ").replace(/\s*\[[^\]]*\]\s*/g, " ").trim();
      out.push({ version, title });
    }
    out.sort((a, b) => (deps.isVersionNewer(a.version, b.version) ? -1 : deps.isVersionNewer(b.version, a.version) ? 1 : 0));
    return out;
  } catch (e) {
    return [];
  }
}

// ------------------------------------------------------------- status ----

async function unpackagedStatus({ fetch }) {
  const app = deps.app;
  const running = app.getVersion();
  const onDisk = diskVersion();
  const st = {
    mode: "git",
    running,
    onDisk,
    diskNewer: !!(onDisk && deps.isVersionNewer(onDisk, running)),
    behind: 0,
    ahead: 0,
    remoteVersion: null,
    branch: null,
    clean: null,
    canApply: false,
    blockers: [],
    commits: [],
    checkedAt: Date.now(),
    error: null,
  };

  if (!fs.existsSync(path.join(repoDir(), ".git"))) {
    st.mode = "none";
    return st;
  }

  const br = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  st.branch = br.code === 0 ? firstLine(br.out) : null;
  const ch = channel();

  if (fetch) {
    const f = await git(["fetch", "--quiet", "origin", ch]);
    if (f.code !== 0) st.error = "Could not reach GitHub: " + firstLine(f.out);
  }

  const counts = await git(["rev-list", "--left-right", "--count", `HEAD...origin/${ch}`]);
  const m = /(\d+)\s+(\d+)/.exec(counts.out || "");
  if (counts.code === 0 && m) {
    st.ahead = Number(m[1]);
    st.behind = Number(m[2]);
  } else if (!st.error) {
    st.error = `Could not compare with origin/${ch}: ` + firstLine(counts.out);
  }

  if (st.behind > 0) {
    const rp = await git(["show", `origin/${ch}:package.json`]);
    if (rp.code === 0) {
      try {
        st.remoteVersion = JSON.parse(rp.out.replace(/^\uFEFF/, "")).version || null;
      } catch (e) {}
    }
    const log = await git(["log", "--format=%s", "-n", "15", `HEAD..origin/${ch}`]);
    if (log.code === 0) st.commits = log.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  const status = await git(["status", "--porcelain", "--untracked-files=no"]);
  st.clean = status.code === 0 && status.out.trim() === "";

  if (st.behind > 0) {
    if (st.branch !== ch) st.blockers.push(`This checkout is on "${st.branch}", not ${ch}.`);
    if (!st.clean) st.blockers.push("There are uncommitted changes in the app's folder.");
    if (st.ahead > 0) st.blockers.push(`This checkout has ${st.ahead} commit(s) that are not on GitHub, so it cannot fast-forward.`);
    for (const why of await unsupportedChanges()) st.blockers.push(why);
    st.canApply = st.blockers.length === 0;
  }
  return st;
}

// What origin/main's package.json changes that cannot be installed from inside the app: the Electron version
// or the native node-pty module (see dep-doctor.js). Ordinary JS packages are NOT blockers any more - apply()
// installs them (and rolls back if it cannot).
async function unsupportedChanges() {
  const rp = await git(["show", `origin/${channel()}:package.json`]);
  if (rp.code !== 0) return ["package.json (could not read the new version's)"];
  let remote;
  try {
    remote = JSON.parse(rp.out.replace(/^﻿/, ""));
  } catch (e) {
    return ["package.json (the new version's could not be parsed)"];
  }
  const local = readJson(path.join(repoDir(), "package.json")) || {};
  const why = depDoctor.unsupportedChange(local, remote, []);
  return why ? [why] : [];
}

function packagedStatus() {
  const running = deps.app.getVersion();
  return new Promise((resolve) => {
    const base = { mode: "release", running, latest: null, url: null, updateAvailable: false, checkedAt: Date.now(), error: null };
    const repo = releasesRepo();
    if (!repo) return resolve({ ...base, noSource: true }); // no update source configured: nothing to check, not an error
    const req = https.get(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { headers: { "User-Agent": "agent-desktop", Accept: "application/vnd.github+json" }, timeout: 10000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            const latest = String(j.tag_name || "").replace(/^v/i, "") || null;
            resolve({ ...base, latest, url: j.html_url || null, updateAvailable: !!(latest && deps.isVersionNewer(latest, running)) });
          } catch (e) {
            resolve({ ...base, error: "Could not read GitHub's answer" });
          }
        });
      }
    );
    req.on("error", (e) => resolve({ ...base, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ...base, error: "GitHub did not answer in time" });
    });
  });
}

function fakeStatus() {
  const running = deps.app.getVersion();
  return {
    mode: "git",
    running,
    onDisk: running,
    diskNewer: false,
    behind: 3,
    ahead: 0,
    remoteVersion: "99.0.0",
    branch: channel(),
    clean: true,
    canApply: true,
    blockers: [],
    commits: ["(test) fake commit one", "(test) fake commit two", "(test) fake commit three"],
    checkedAt: Date.now(),
    error: null,
    fake: true,
  };
}

// Normalised for the renderer: `available` + `target` + `summary` are all
// the banner needs; the rest is detail for the overlay.
async function getStatus({ fetch = true } = {}) {
  let st;
  if (deps.testMode.TEST_MODE) {
    st = process.env.AGENT_DESKTOP_TEST_FAKE_UPDATE === "1" ? fakeStatus() : { mode: "none", running: deps.app.getVersion() };
  } else if (deps.app.isPackaged) {
    st = await packagedStatus();
  } else {
    st = await unpackagedStatus({ fetch });
  }
  if (st.mode === "git") {
    st.available = st.behind > 0 || st.diskNewer;
    st.target = st.behind > 0 ? st.remoteVersion || "latest" : st.onDisk;
    st.needsPull = st.behind > 0;
    // A disk-only update needs nothing but a restart, so blockers that are
    // about pulling do not apply to it.
    st.canApply = st.behind > 0 ? st.canApply : st.diskNewer;
    st.changelog = st.available ? changelogFromClaudeMd(st.running, st.target) : [];
  } else if (st.mode === "release") {
    st.available = st.updateAvailable;
    st.target = st.latest;
    st.needsPull = false;
    st.canApply = false; // download only, for now (see top of file)
  } else {
    st.available = false;
  }
  return st;
}

// --------------------------------------------------------------- apply ----

// Pulls if needed. Returns { ok, error?, version? }. The caller restarts.
async function apply() {
  if (deps.testMode.TEST_MODE) {
    return { ok: true, version: process.env.AGENT_DESKTOP_TEST_FAKE_UPDATE === "1" ? "99.0.0" : deps.app.getVersion(), testMode: true };
  }
  if (deps.app.isPackaged) return { ok: false, error: "Installed copies update by downloading the new installer." };

  // Re-check from scratch: the overlay may have been open for a while.
  const st = await unpackagedStatus({ fetch: true });
  if (st.behind > 0) {
    if (!st.canApply) return { ok: false, error: st.blockers.join(" ") || st.error || "Cannot update right now." };
    const ch = channel();
    const target = await git(["rev-parse", `origin/${ch}`]);
    const prev = await git(["rev-parse", "HEAD"]);
    // The status check above can be seconds old (fetch + package.json reads): re-check the tree right before merging.
    const pre = await git(["status", "--porcelain", "--untracked-files=no"]);
    if (pre.code !== 0 || pre.out.trim() !== "") return { ok: false, error: "There are uncommitted changes in the app's folder, so the update was not started." };
    const m = await git(["merge", "--ff-only", `origin/${ch}`]);
    const head = await git(["rev-parse", "HEAD"]);
    if (m.code !== 0 || firstLine(head.out) !== firstLine(target.out)) {
      return { ok: false, error: "The update could not be applied: " + firstLine(m.out) };
    }
    // Install what the new package.json needs BEFORE reporting success. Failure = undo the merge.
    const d = await getDoctor().ensure({});
    if (!d.ok) {
      // `reset --keep` (not --hard): if a tracked file was edited while npm ran, it refuses instead of destroying the edit.
      let back = { code: -1, out: "previous commit unknown" };
      if (prev.code === 0 && firstLine(prev.out)) back = await git(["reset", "--keep", firstLine(prev.out)]);
      const undone = back.code === 0;
      return {
        ok: false,
        error: undone
          ? "The update was undone: " + (d.error || "the components it needs could not be installed") + " Nothing was changed."
          : "The update failed (" + (d.error || "install failed") + ") and could NOT be undone automatically: " + firstLine(back.out) + ". The app's folder is now on the new version's files without its components; nothing was reset so no edits are lost. Ask " + (cfgValue("ownerName") || "whoever set up this app") + ".",
        rolledBack: undone,
      };
    }
  } else if (!st.diskNewer) {
    return { ok: false, error: "Agent Desktop is already up to date." };
  }
  return { ok: true, version: diskVersion() };
}

module.exports = { init, getStatus, apply, startupDepCheck, depStatus, get RELEASES_REPO() { return releasesRepo(); }, releasesRepo, channel };
