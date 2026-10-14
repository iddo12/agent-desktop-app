// node tests/depsPolicy.test.js - dependency policy (v1.119.1).
//
// WHY: an Agent Desktop that is already installed runs ITS OWN (old) updater when the person presses "Update". Updaters
// older than v1.119.1 refuse to update when origin/main's package.json `dependencies` lists a package that is missing
// from node_modules ("Can't update yet ... run npm install first") - that is what stranded Sarah's v1.114.0 on
// imapflow/libmime. They only look at `dependencies`. So NEW packages must go in `optionalDependencies` and be
// required LAZILY (inside try/catch, degrading gracefully): the in-app dep-doctor installs them after the update.
// Changing the allow-list below is a deliberate decision: it means every installed copy older than v1.119.1 will be
// blocked until someone runs `npm install` by hand.
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert"), Module = require("module");
const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ALLOW = ["@xterm/addon-fit", "@xterm/xterm", "node-pty", "tweetnacl"];
let n = 0, fails = 0;
const t = (name, fn) => { try { fn(); n++; console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };

t("`dependencies` equals the allow-list (new packages go to optionalDependencies, loaded lazily)", () => {
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), ALLOW.slice().sort());
});
t("imapflow and libmime are optionalDependencies, not dependencies", () => {
  for (const k of ["imapflow", "libmime"]) { assert.ok(pkg.optionalDependencies[k], k); assert.ok(!(k in pkg.dependencies), k); }
});
t("no package is listed in both dependencies and optionalDependencies", () => {
  for (const k of Object.keys(pkg.optionalDependencies || {})) assert.ok(!(k in pkg.dependencies), k);
});
t("package-lock.json root entry matches package.json", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8")).packages[""];
  assert.deepStrictEqual(lock.dependencies, pkg.dependencies);
  assert.deepStrictEqual(lock.optionalDependencies, pkg.optionalDependencies);
});

// Every module in src/ must load with the optional packages absent. A require hook makes imapflow/libmime (and their
// sub-paths) fail exactly like a missing package; `electron` is stubbed because the modules are loaded under plain node.
t("every module in src/ loads with imapflow and libmime absent", () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== "renderer") walk(p); } else if (/\.c?js$/.test(e.name)) files.push(p); } };
  walk(SRC);
  // Not loadable under plain node for reasons unrelated to dependencies: main.js starts the whole app, usageWorker.js is a
  // worker_threads entry, demo/runtime.js insists on an agent-desktop-demo folder. None of them require imapflow/libmime.
  const SKIP = ["main.js", "usageWorker.js", path.join("demo", "runtime.js")].map((x) => path.join(SRC, x));
  for (const s of SKIP) { const i = files.indexOf(s); if (i >= 0) files.splice(i, 1); }
  assert.ok(!/imapflow|libmime/.test(SKIP.map((x) => fs.readFileSync(x, "utf8")).join(" ")), "skipped files must not need the optional packages");
  const origResolve = Module._resolveFilename, origLoad = Module._load;
  const blocked = [];
  Module._resolveFilename = function (request, ...rest) {
    if (/^(imapflow|libmime)(\/|$)/.test(request)) { blocked.push(request); const e = new Error("Cannot find module '" + request + "'"); e.code = "MODULE_NOT_FOUND"; throw e; }
    return origResolve.call(this, request, ...rest);
  };
  const stub = new Proxy(function () {}, { get: (_, k) => (k === "then" ? undefined : stub), apply: () => stub, construct: () => stub });
  Module._load = function (request, ...rest) { return request === "electron" ? stub : origLoad.call(this, request, ...rest); };
  const failures = [];
  try {
    for (const f of files) {
      delete require.cache[f];
      try { require(f); } catch (e) { failures.push(path.relative(ROOT, f) + ": " + e.message.split("\n")[0]); }
    }
  } finally { Module._resolveFilename = origResolve; Module._load = origLoad; }
  assert.deepStrictEqual(failures, []);
  assert.ok(files.length > 50, "scanned " + files.length + " files");
});
t("imap.js degrades to a clear message (not a crash) when imapflow is missing", () => {
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) { if (/^(imapflow|libmime)(\/|$)/.test(request)) { const e = new Error("nope"); e.code = "MODULE_NOT_FOUND"; throw e; } return origResolve.call(this, request, ...rest); };
  try {
    const imap = require("../src/daily/imap");
    const svc = imap.create({ dataDir: fs.mkdtempSync(path.join(require("os").tmpdir(), "imapdep-")), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }, log: () => {} });
    return Promise.resolve(svc.testConnection({ email: "a@gmail.com", password: "x" })).then((r) => {
      assert.strictEqual(r.ok, false); assert.ok(/e-mail component/.test(r.reason), r.reason);
    }).then(() => { console.log("ok   (async) imap degrades"); n++; }).catch((e) => { fails++; console.log("FAIL imap degrade " + e.stack); }).then(done);
  } finally { Module._resolveFilename = origResolve; }
});
function done() { console.log(`\n${n} passed, ${fails} failed`); process.exit(fails ? 1 : 0); }
if (!process.exitCode) setTimeout(() => {}, 0);
