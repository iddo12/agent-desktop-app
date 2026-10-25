// ssService.js: starts the service only when nothing answers, only when set up, once at a time, and says why when it cannot.
"use strict";
const assert = require("assert"), net = require("net"), fs = require("fs"), os = require("os"), path = require("path");
const S = require("../src/contacts/ssService");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssv-")); fs.mkdirSync(path.join(dir, "supersearch")); const db = path.join(dir, "i.sqlite"), py = path.join(dir, "py.exe"); fs.writeFileSync(db, "x"); fs.writeFileSync(py, "x");
  const free = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const cfgOf = (m) => (k) => m[k];

  let r = await S.createService(cfgOf({}), { port: free, wait: 500 }).ensure(); assert.ok(!r.running && /not set up/.test(r.reason), "nothing configured: nothing started");
  r = await S.createService(cfgOf({ superSearchDir: dir, superSearchDb: path.join(dir, "no.sqlite"), pythonExe: py }), { port: free, wait: 500 }).ensure(); assert.ok(!r.running && /not found/.test(r.reason));
  r = await S.createService(cfgOf({ superSearchDir: dir, superSearchDb: db, pythonExe: path.join(dir, "none.exe") }), { port: free, wait: 500 }).ensure(); assert.ok(!r.running && /Python/.test(r.reason));

  // already answering: no spawn
  const up = net.createServer().listen(0, "127.0.0.1"); await new Promise((r2) => up.once("listening", r2));
  let spawned = 0; const fake = () => { spawned++; return { on() {}, unref() {} }; };
  r = await S.createService(cfgOf({ superSearchDir: dir, superSearchDb: db, pythonExe: py }), { port: up.address().port, spawnFn: fake }).ensure(); assert.ok(r.running && !r.started && spawned === 0);
  up.close();

  // not answering: one spawn with the right arguments, shared by concurrent callers, answers once the port opens
  let args = null, srv = null;
  const spawnFn = (exe, a, o) => { spawned++; args = { exe, a, o }; setTimeout(() => { srv = net.createServer().listen(free, "127.0.0.1"); }, 300); return { on() {}, unref() {} }; };
  const svc = S.createService(cfgOf({ superSearchDir: dir, superSearchDb: db, pythonExe: py }), { port: free, spawnFn, wait: 5000 });
  const both = await Promise.all([svc.ensure(), svc.ensure()]);
  assert.ok(both.every((x) => x.running && x.started) && spawned === 1, "one start for two callers");
  assert.deepStrictEqual(args.a, ["-m", "supersearch", "serve", "--db", db]); assert.strictEqual(args.o.cwd, dir); assert.ok(args.o.detached && args.o.windowsHide);
  srv.close();

  // never answers: reports it, and does not retry for a minute
  spawned = 0; const dead = S.createService(cfgOf({ superSearchDir: dir, superSearchDb: db, pythonExe: py }), { port: free, spawnFn: fake, wait: 700 });
  r = await dead.ensure(); assert.ok(!r.running && /did not answer/.test(r.reason) && spawned === 1);
  r = await dead.ensure(); assert.ok(!r.running && spawned === 1, "no second try inside a minute");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("contactsService tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
