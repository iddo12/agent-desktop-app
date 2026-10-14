// node tests/depDoctor.test.js - src/dep-doctor.js and the apply()/rollback path of src/app-update.js (v1.119.1).
// All against TEMP fixture repos and a FAKE npm; never the real node_modules, never the network.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), { execFileSync } = require("child_process");
const DD = require("../src/dep-doctor");
const appUpdate = require("../src/app-update");
let n = 0, fails = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "depdoctor-"));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} };
const writePkg = (dir, o) => fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(o, null, 2));
const install = (dir, name) => { const d = path.join(dir, "node_modules", ...name.split("/")); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" })); fs.writeFileSync(path.join(d, "index.js"), "module.exports = 1;"); };
process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "core.autocrlf"; process.env.GIT_CONFIG_VALUE_0 = "false"; // fixture repos: no CRLF conversion noise
const unq = (a) => a.replace(/^"|"$/g, "");
const specName = (a) => a.replace(/^"|"$/g, "").replace(/(?!^)@[^@]*$/, "");
// A fake npm: records its args, installs every `name@range` spec it was given (like the real one would), or fails.
const fakeNpm = (dir, behaviour) => {
  const f = async (args, opts) => {
    f.calls.push({ args, opts });
    if (behaviour === "partial" || behaviour === "partial-timeout") {
      for (const a of args.filter((x) => !x.startsWith("-") && x !== "install")) { const d = path.join(dir, "node_modules", ...specName(a).split("/")); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: specName(a), main: "index.js" })); }
      fs.mkdirSync(path.join(dir, "node_modules", ".staging", "x"), { recursive: true });
      return behaviour === "partial" ? { code: 1, out: "npm ERR! EBUSY" } : { code: -1, out: "", timedOut: true };
    }
    if (behaviour === "fail") return { code: 1, out: "npm ERR! network request failed\nnpm ERR! ECONNRESET" };
    if (behaviour === "timeout") return { code: -1, out: "", timedOut: true };
    if (behaviour === "noop") return { code: 0, out: "" };
    const ci = args.indexOf("--cache");
    for (const a of args.filter((x, i) => !x.startsWith("-") && x !== "install" && !(ci >= 0 && i === ci + 1))) install(dir, specName(a));
    return { code: 0, out: "added" };
  };
  f.calls = [];
  return f;
};
const mkDoc = (dir, run, extra) => DD.create(Object.assign({ repoDir: dir, statusFile: path.join(dir, "status", "dep-doctor.json"), run, testMode: false }, extra || {}));
const status = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "status", "dep-doctor.json"), "utf8"));
const PKG = { name: "x", version: "1.0.0", dependencies: { "@xterm/xterm": "^5.5.0", "node-pty": "^1.1.0" }, optionalDependencies: { imapflow: "^2.4.0", libmime: "^5.4.7" }, devDependencies: { electron: "~41.10.7" } };
const prep = (d) => { writePkg(d, PKG); install(d, "node-pty"); install(d, "@xterm/xterm"); };

t("missing detection: dependencies + optionalDependencies, scoped names, devDependencies ignored", () => {
  const d = tmp(); writePkg(d, PKG); install(d, "node-pty");
  assert.deepStrictEqual(DD.computeMissing(d, PKG).sort(), ["@xterm/xterm", "imapflow", "libmime"]);
  install(d, "@xterm/xterm"); install(d, "imapflow");
  assert.deepStrictEqual(DD.computeMissing(d, PKG), ["libmime"]);
  rm(d);
});
t("nothing missing: no npm run, state idle", async () => {
  const d = tmp(); writePkg(d, PKG); for (const k of ["node-pty", "@xterm/xterm", "imapflow", "libmime"]) install(d, k);
  const npm = fakeNpm(d, "ok"); const r = await mkDoc(d, npm).ensure({});
  assert.strictEqual(r.ok, true); assert.strictEqual(r.state, "idle"); assert.strictEqual(npm.calls.length, 0); assert.strictEqual(status(d).state, "idle"); rm(d);
});
t("install success: explicit names only, no --omit=dev, status file says done", async () => {
  const d = tmp(); prep(d);
  const npm = fakeNpm(d, "ok"); const seen = []; const r = await mkDoc(d, npm, { onStatus: (s) => seen.push(s.state + ":" + s.feature) }).ensure({});
  assert.strictEqual(r.ok, true); assert.strictEqual(r.state, "done"); assert.deepStrictEqual(r.installed.sort(), ["imapflow", "libmime"]);
  const a = npm.calls[0].args; assert.strictEqual(a[0], "install");
  for (const f of ["--no-save", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress"]) assert.ok(a.includes(f), f);
  assert.ok(!a.some((x) => /omit/.test(x)), "--omit=dev would prune electron from node_modules");
  assert.ok(a.some((x) => unq(x) === "imapflow@^2.4.0"), JSON.stringify(a));
  assert.notStrictEqual(npm.calls[0].opts.cwd, d); assert.ok(!fs.existsSync(npm.calls[0].opts.cwd), 'scratch folder removed afterwards'); assert.strictEqual(npm.calls[0].opts.timeoutMs, 8 * 60 * 1000); assert.strictEqual(DD.INSTALL_TIMEOUT_MS, 8 * 60 * 1000);
  assert.deepStrictEqual(seen, ["installing:e-mail", "done:e-mail"]);
  const s = status(d); assert.strictEqual(s.state, "done"); assert.deepStrictEqual(s.missing.sort(), ["imapflow", "libmime"]); assert.strictEqual(s.error, null); assert.ok(s.at);
  assert.deepStrictEqual(DD.computeMissing(d, PKG), []); rm(d);
});
t("npm runs in a scratch folder (never the app folder) and the new packages are copied in, existing ones kept", async () => {
  const d = tmp(); prep(d); install(d, "keepme"); writePkg(d, { dependencies: {}, optionalDependencies: { imapflow: "^1.0.0", libmime: "^5.0.0", keepme: "^1.0.0" } });
  fs.writeFileSync(path.join(d, "node_modules", "keepme", "marker.txt"), "mine");
  let cwd = null;
  const run = async (a, o) => { cwd = o.cwd; for (const x of ["imapflow", "libmime", "keepme", "dep-of-imapflow"]) install(o.cwd, x); return { code: 0, out: "added" }; };
  const r = await mkDoc(d, run).ensure({});
  assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.notStrictEqual(cwd, d);
  assert.ok(fs.existsSync(path.join(d, "node_modules", "dep-of-imapflow", "index.js")), "dependency copied");
  assert.strictEqual(fs.readFileSync(path.join(d, "node_modules", "keepme", "marker.txt"), "utf8"), "mine", "installed package untouched");
  assert.ok(!fs.existsSync(cwd)); rm(d);
});
t("scoped package is passed whole to npm and recognised afterwards", async () => {
  const d = tmp(); writePkg(d, { dependencies: {}, optionalDependencies: { "@scope/lib": "^1.2.0" } });
  const npm = fakeNpm(d, "ok"); const r = await mkDoc(d, npm).ensure({});
  assert.strictEqual(r.ok, true); assert.ok(npm.calls[0].args.map(unq).includes("@scope/lib@^1.2.0"), JSON.stringify(npm.calls[0].args));
  assert.ok(fs.existsSync(path.join(d, "node_modules", "@scope", "lib", "package.json"))); rm(d);
});
t("range with spaces/shell characters is quoted for cmd.exe", async () => {
  const d = tmp(); writePkg(d, { optionalDependencies: { foo: ">=1.0.0 <2" } }); const npm = fakeNpm(d, "noop");
  await mkDoc(d, npm).ensure({}); assert.ok(npm.calls[0].args.includes('"foo@>=1.0.0 <2"'), JSON.stringify(npm.calls[0].args)); rm(d);
});
t("install failure: state failed with a readable reason", async () => {
  const d = tmp(); prep(d);
  const r = await mkDoc(d, fakeNpm(d, "fail")).ensure({});
  assert.strictEqual(r.ok, false); assert.strictEqual(r.state, "failed"); assert.ok(/could not install imapflow, libmime/.test(r.error) && /ECONNRESET/.test(r.error), r.error);
  assert.strictEqual(status(d).state, "failed"); rm(d);
});
t("damaged npm cache (ENOENT in _cacache): retried once with a private --cache", async () => {
  const d = tmp(); prep(d); const ok = fakeNpm(d, "ok"); let first = true;
  const run = async (a, o) => { if (first) { first = false; ok.calls.push({ args: a, opts: o }); return { code: 1, out: "npm error enoent stat cache/_cacache/content-v2/sha512/e3" }; } return ok(a, o); };
  const r = await mkDoc(d, run).ensure({}); assert.strictEqual(r.ok, true); assert.strictEqual(ok.calls.length, 2); assert.ok(ok.calls[1].args.includes("--cache"), JSON.stringify(ok.calls[1].args)); assert.ok(!ok.calls[0].args.includes("--cache")); rm(d);
});
t("npm exits 0 but the package is still missing -> failed, not done", async () => {
  const d = tmp(); prep(d);
  const r = await mkDoc(d, fakeNpm(d, "noop")).ensure({}); assert.strictEqual(r.ok, false); assert.ok(/still missing/.test(r.error)); rm(d);
});
t("timeout reported as such", async () => {
  const d = tmp(); prep(d);
  const r = await mkDoc(d, fakeNpm(d, "timeout")).ensure({}); assert.strictEqual(r.ok, false); assert.ok(/did not finish within 8 minutes/.test(r.error), r.error); rm(d);
});
t("the real runner enforces the timeout (kills the process) and reports an unstartable program", async () => {
  const t0 = Date.now();
  const r = await DD.spawnRun(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { cwd: os.tmpdir(), timeoutMs: 400 });
  assert.strictEqual(r.timedOut, true); assert.ok(Date.now() - t0 < 10000);
  const r2 = await DD.spawnRun(path.join(os.tmpdir(), "definitely-not-a-program.exe"), [], { cwd: os.tmpdir(), timeoutMs: 5000 });
  assert.strictEqual(r2.spawnFailed, true);
});
t("runner that throws -> failed, never a rejection", async () => {
  const d = tmp(); prep(d);
  const r = await mkDoc(d, async () => { throw new Error("boom"); }).ensure({}); assert.strictEqual(r.ok, false); assert.ok(/boom/.test(r.error)); rm(d);
});
t("changed electron version is refused: needs full reinstall, npm never run", async () => {
  const d = tmp(); const remote = Object.assign({}, PKG, { devDependencies: { electron: "~42.0.0" } }); writePkg(d, remote); install(d, "node-pty");
  const npm = fakeNpm(d, "ok"); const r = await mkDoc(d, npm).ensure({ pkg: remote, localPkg: PKG });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.needsReinstall, true); assert.ok(/full reinstall/.test(r.error) && /Electron/.test(r.error)); assert.strictEqual(npm.calls.length, 0); rm(d);
});
t("changed node-pty version, or node-pty missing, is refused", async () => {
  const d = tmp(); const remote = Object.assign({}, PKG, { dependencies: Object.assign({}, PKG.dependencies, { "node-pty": "^2.0.0" }) }); writePkg(d, remote);
  let npm = fakeNpm(d, "ok"); let r = await mkDoc(d, npm).ensure({ pkg: remote, localPkg: PKG });
  assert.strictEqual(r.needsReinstall, true); assert.strictEqual(npm.calls.length, 0);
  npm = fakeNpm(d, "ok"); r = await mkDoc(d, npm).ensure({ pkg: PKG });     // start-up check, node-pty absent from node_modules
  assert.strictEqual(r.needsReinstall, true); assert.ok(/node-pty/.test(r.error)); assert.strictEqual(npm.calls.length, 0); rm(d);
});
t("test mode is a no-op (no npm, no status file)", async () => {
  const d = tmp(); writePkg(d, PKG); const npm = fakeNpm(d, "ok");
  const r = await mkDoc(d, npm, { testMode: true }).ensure({}); assert.strictEqual(r.testMode, true); assert.strictEqual(npm.calls.length, 0); assert.ok(!fs.existsSync(path.join(d, "status"))); rm(d);
});
t("concurrent ensure() calls share one install", async () => {
  const d = tmp(); prep(d); const npm = fakeNpm(d, "ok"); const doc = mkDoc(d, npm);
  await Promise.all([doc.ensure({}), doc.ensure({})]); assert.strictEqual(npm.calls.length, 1); rm(d);
});

t("unsupported specs are refused before npm runs (git/url/file/alias ranges, odd names, % and !)", async () => {
  for (const [name, range] of [["evil", "git+https://x/y.git"], ["evil", "http://x/y.tgz"], ["evil", "file:../x"], ["evil", "npm:other@1"], ["evil", "github:a/b"], ["evil", "^1.0.0 & calc"], ["evil", "%PATH%"], ["evil", "1!"], ["Evil Name", "^1.0.0"], ["a/b", "^1.0.0"], ["@x", "^1.0.0"]]) {
    const d = tmp(); writePkg(d, { optionalDependencies: { [name]: range } }); const npm = fakeNpm(d, "ok");
    const r = await mkDoc(d, npm).ensure({}); assert.strictEqual(r.ok, false, name + "@" + range); assert.ok(/unsupported spec/.test(r.error), r.error); assert.strictEqual(npm.calls.length, 0); rm(d);
  }
  for (const [name, range] of [["imapflow", "^2.4.0"], ["@scope/a-b.c", "~1.2.3"], ["x", ">=1.0.0 <2.0.0 || ^3"], ["x", "1.x"], ["x", "*"]]) assert.strictEqual(DD.specProblem(name, range), null, name + "@" + range);
});
t("failure/timeout removes half-extracted directories it created, keeps what existed before", async () => {
  for (const b of ["partial", "partial-timeout"]) {
    const d = tmp(); prep(d); install(d, "libmime"); fs.rmSync(path.join(d, "node_modules", "libmime", "index.js"));  // libmime: existing but broken -> counts as missing
    const keep = path.join(d, "node_modules", "node-pty", "index.js");
    const r = await mkDoc(d, fakeNpm(d, b)).ensure({}); assert.strictEqual(r.ok, false);
    assert.ok(!fs.existsSync(path.join(d, "node_modules", "imapflow")), "partial imapflow removed"); assert.ok(!fs.existsSync(path.join(d, "node_modules", ".staging")));
    assert.ok(fs.existsSync(path.join(d, "node_modules", "libmime", "package.json")), "pre-existing dir untouched"); assert.ok(fs.existsSync(keep)); rm(d);
  }
});
t("isInstalled needs package.json AND a loadable entry", () => {
  const d = tmp(); const mod = path.join(d, "node_modules", "half"); fs.mkdirSync(mod, { recursive: true });
  assert.strictEqual(DD.isInstalled(d, "half"), false); fs.writeFileSync(path.join(mod, "package.json"), '{"main":"lib/x.js"}'); assert.strictEqual(DD.isInstalled(d, "half"), false);
  fs.mkdirSync(path.join(mod, "lib")); fs.writeFileSync(path.join(mod, "lib", "x.js"), ""); assert.strictEqual(DD.isInstalled(d, "half"), true); rm(d);
});

// ---- app-update.js apply(): merge, install, rollback --------------------------------------------------------------
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", windowsHide: true, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" }) }).trim();
function gitFixture(newPkg) {
  const root = tmp(), origin = path.join(root, "origin"), work = path.join(root, "work");
  fs.mkdirSync(origin); git(origin, "init", "-q", "-b", "main"); git(origin, "config", "user.email", "t@t"); git(origin, "config", "user.name", "t"); git(origin, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(origin, ".gitignore"), "node_modules/\n");
  const base = { name: "x", version: "1.0.0", dependencies: { tweetnacl: "^1.0.3" }, devDependencies: { electron: "~41.10.7" } };
  writePkg(origin, base); git(origin, "add", "-A"); git(origin, "commit", "-qm", "one");
  git(root, "clone", "-q", origin, work); git(work, "config", "user.email", "t@t"); git(work, "config", "user.name", "t"); git(work, "config", "commit.gpgsign", "false");
  install(work, "tweetnacl");
  writePkg(origin, Object.assign({}, base, newPkg, { version: "1.0.1" })); git(origin, "add", "-A"); git(origin, "commit", "-qm", "two");
  return { root, work, first: git(work, "rev-parse", "HEAD"), second: git(origin, "rev-parse", "HEAD") };
}
const initUpdate = (work, npmRun) => appUpdate.init({
  app: { getVersion: () => "1.0.0", isPackaged: false, getPath: () => path.join(work, "..", "userdata") },
  runClaudeCommand: null, testMode: { TEST_MODE: false }, isVersionNewer: (a, b) => a.localeCompare(b, undefined, { numeric: true }) > 0, repoDir: work, npmRun,
});
t("apply(): new optional package -> merged, installed by dep-doctor, ok (old updater: blocked)", async () => {
  const f = gitFixture({ optionalDependencies: { "fake-mail": "^1.0.0" } }); const npm = fakeNpm(f.work, "ok"); initUpdate(f.work, npm);
  const st = await appUpdate.getStatus({ fetch: true }); assert.strictEqual(st.canApply, true, JSON.stringify(st.blockers));
  const r = await appUpdate.apply(); assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(git(f.work, "rev-parse", "HEAD"), f.second); assert.strictEqual(npm.calls.length, 1);
  assert.ok(fs.existsSync(path.join(f.work, "node_modules", "fake-mail", "package.json"))); rm(f.root);
});
t("apply(): ordinary new `dependencies` entry no longer blocks either", async () => {
  const f = gitFixture({ dependencies: { tweetnacl: "^1.0.3", "fake-dep": "^1.0.0" } }); initUpdate(f.work, fakeNpm(f.work, "ok"));
  const st = await appUpdate.getStatus({ fetch: true }); assert.strictEqual(st.canApply, true, JSON.stringify(st.blockers)); rm(f.root);
});
t("apply(): install fails -> merge ROLLED BACK, clean tree, clear message", async () => {
  const f = gitFixture({ optionalDependencies: { "fake-mail": "^1.0.0" } }); initUpdate(f.work, fakeNpm(f.work, "fail"));
  const r = await appUpdate.apply(); assert.strictEqual(r.ok, false); assert.strictEqual(r.rolledBack, true); assert.ok(/^The update was undone: /.test(r.error), r.error);
  assert.strictEqual(git(f.work, "rev-parse", "HEAD"), f.first); assert.strictEqual(git(f.work, "status", "--porcelain", "--untracked-files=no"), "");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(f.work, "package.json"), "utf8")).version, "1.0.0"); rm(f.root);
});
t("apply(): a tracked-file edit made while npm ran is NOT destroyed by the rollback (reset --keep refuses)", async () => {
  const f = gitFixture({ optionalDependencies: { "fake-mail": "^1.0.0" } }); const real = fakeNpm(f.work, "fail");
  initUpdate(f.work, async (a, o) => { fs.appendFileSync(path.join(f.work, "package.json"), " // my edit "); return real(a, o); });
  const r = await appUpdate.apply(); assert.strictEqual(r.ok, false); assert.strictEqual(r.rolledBack, false); assert.ok(/could NOT be undone/.test(r.error), r.error);
  assert.ok(/my edit/.test(fs.readFileSync(path.join(f.work, "package.json"), "utf8")), "edit survived"); rm(f.root);
});
t("apply(): a dirty tree appearing after the status check stops the update before the merge", async () => {
  const f = gitFixture({ optionalDependencies: { "fake-mail": "^1.0.0" } }); const npm = fakeNpm(f.work, "ok"); initUpdate(f.work, npm);
  fs.appendFileSync(path.join(f.work, "package.json"), " ");   // dirty before apply: status inside apply() blocks it
  const r = await appUpdate.apply(); assert.strictEqual(r.ok, false); assert.strictEqual(git(f.work, "rev-parse", "HEAD"), f.first); assert.strictEqual(npm.calls.length, 0); rm(f.root);
});
t("apply(): install timeout -> rolled back too", async () => {
  const f = gitFixture({ optionalDependencies: { "fake-mail": "^1.0.0" } }); initUpdate(f.work, fakeNpm(f.work, "timeout"));
  const r = await appUpdate.apply(); assert.strictEqual(r.ok, false); assert.ok(/undone/.test(r.error) && /8 minutes/.test(r.error)); assert.strictEqual(git(f.work, "rev-parse", "HEAD"), f.first); rm(f.root);
});
t("apply(): electron version change is a blocker - nothing merged, nothing installed", async () => {
  const f = gitFixture({ devDependencies: { electron: "~42.0.0" } }); const npm = fakeNpm(f.work, "ok"); initUpdate(f.work, npm);
  const st = await appUpdate.getStatus({ fetch: true }); assert.strictEqual(st.canApply, false); assert.ok(/full reinstall/.test(st.blockers.join(" ")));
  const r = await appUpdate.apply(); assert.strictEqual(r.ok, false); assert.strictEqual(git(f.work, "rev-parse", "HEAD"), f.first); assert.strictEqual(npm.calls.length, 0); rm(f.root);
});
t("apply(): nothing new to install -> no npm run at all", async () => {
  const f = gitFixture({}); const npm = fakeNpm(f.work, "ok"); initUpdate(f.work, npm);
  const r = await appUpdate.apply(); assert.strictEqual(r.ok, true); assert.strictEqual(npm.calls.length, 0); rm(f.root);
});
t("startupDepCheck(): installs what a pull done outside the app left missing", async () => {
  const f = gitFixture({ optionalDependencies: { "fake-mail": "^1.0.0" } }); git(f.work, "pull", "-q", "--ff-only");
  const npm = fakeNpm(f.work, "ok"); initUpdate(f.work, npm);
  const r = await appUpdate.startupDepCheck(); assert.strictEqual(r.state, "done"); assert.deepStrictEqual(r.installed, ["fake-mail"]);
  assert.strictEqual(appUpdate.depStatus().state, "done"); rm(f.root);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++; console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); }
  }
  console.log(`\n${n} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
