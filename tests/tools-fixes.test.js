// node tests/tools-fixes.test.js - TOOLS v1.83.1: tests for the independent review's fixes (trust pin, REPO regex, cache robustness,
// absolute system exes, single-flight, a11y, seed, process hints). Temp folders and dummy launchers only; no live GitHub.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const S = require("../src/tools/schema");
const L = require("../src/tools/launcher");
const ST = require("../src/tools/stats");
const M = require("../src/tools/model");
const SV = require("../src/tools/service");
const TR = require("../src/tools/trust");

let n = 0, fails = 0; const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tools-fix-"));
const SRC = path.join(__dirname, "..", "src");
const fx = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tools", f), "utf8"));
const base = (o) => Object.assign({ id: "demo", basket: "acmeco", name: "Demo", purpose: "Does a thing", status: "built" }, o || {});
const tool = (o) => S.validateTool(base(o)).entry;
const NOW = Date.parse("2026-10-07T12:00:00Z");
const H = (rem, etag) => Object.assign({ "x-ratelimit-remaining": String(rem), "x-ratelimit-limit": "60", "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 1800) }, etag ? { etag } : {});
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const py = (() => { for (const c of ["python", "py"]) { const r = cp.spawnSync(c, ["--version"], { encoding: "utf8" }); if (!r.error && r.status === 0) return c; } return null; })();
const SEED = "C:\\Example\\Workspace\\shared_tools\\tools\\seed_tools.py";

function world() {
  const ws = tmp(), cat = path.join(ws, "cat"), ud = path.join(ws, "ud"), root = path.join(ws, "root");
  for (const d of [cat, ud, root]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(root, "ok.vbs"), "rem original");
  const spawned = [], dialogs = [], state = { answer: true };
  const mk = (over) => SV.createService(Object.assign({ workspaceRoot: ws, userData: ud, testMode: true, env: { AGENT_DESKTOP_TOOLS_DIR: cat, AGENT_DESKTOP_TOOLS_ROOTS: root }, log: () => {},
    spawn: (e) => { spawned.push(e); return { pid: 1, on() {}, unref() {} }; }, confirm: async (d) => { dialogs.push(d); return state.answer; } }, over || {}));
  const put = (tools) => fs.writeFileSync(path.join(cat, "tools.json"), JSON.stringify({ schema: 1, tools }));
  return { ws, cat, ud, root, spawned, dialogs, state, mk, put };
}
const sandbox = () => { const root = tmp(); const sub = path.join(root, "T"); fs.mkdirSync(sub); for (const f of ["a.vbs", "b.bat", "c.cmd", "d.ps1", "e.exe"]) fs.writeFileSync(path.join(sub, f), "rem"); return { root, sub, opts: { roots: [root] } }; };

t("REPO rejects '.' and '..' segments in schema and stats, accepts normal names; nothing traversal-shaped is requested", async () => {
  for (const bad of ["../x", "x/..", "./y", "y/.", "../rate_limit", "owner/..", "a/b/c", "a b/c"]) { assert.ok(!S.REPO.test(bad), bad); assert.ok(!S.validateTool(base({ repo: bad })).ok, bad); }
  for (const good of ["example-user/agent-desktop", "a.b/c.d", "x/y..z", "o_r/n-m"]) assert.ok(S.REPO.test(good), good);
  let hit = 0; const r = await ST.refresh(null, ["../x", "x/.."], { fetchJson: async () => { hit++; return { status: 200, headers: {}, body: {} }; }, now: NOW });
  assert.strictEqual(hit, 0); assert.strictEqual(r.summary.failed, 2);
});
t("a damaged cache is rebuilt entry by entry; junk entries are dropped; the view never throws", () => {
  const junk = { schema: 1, fetchedAt: 5, rate: {}, calls: [], repos: { "o/r": { fetchedAt: 100, stars: "x", releasesKnown: true, releases: [{}, null, 5, { tag: "v1", assets: [{ name: 1, downloads: "9" }, null] }], etagRepo: 5 }, "../x": { fetchedAt: 1 }, "o/bad": 7 } };
  const c = ST.loadCache(junk); assert.deepStrictEqual(Object.keys(c.repos), ["o/r"]);
  assert.strictEqual(c.repos["o/r"].stars, 0); assert.strictEqual(c.repos["o/r"].etagRepo, null);
  const v = ST.view(junk, [{ id: "t", visibility: "public", repo: "o/r" }], NOW);
  for (const rel of v.byTool.t.releases) assert.ok(Array.isArray(rel.assets) && Number.isFinite(rel.downloads));
});
t("a 304 with no cached data behind it is not believed (ETag dropped, asked again)", async () => {
  const log = [];
  const net = async (url, h) => { log.push({ url, inm: h["If-None-Match"] }); if (h["If-None-Match"]) return { status: 304, headers: H(50), body: null }; return url.endsWith("per_page=10") ? { status: 200, headers: H(49, '"n2"'), body: fx("github_releases_two.json") } : { status: 200, headers: H(50, '"n1"'), body: fx("github_repo.json") }; };
  const poisoned = { schema: 1, fetchedAt: NOW - 1e7, rate: {}, calls: [], repos: { "o/r": { etagRepo: '"stale"', etagReleases: '"stale"', fetchedAt: null } } };
  const r = await ST.refresh(poisoned, ["o/r"], { fetchJson: net, now: NOW });
  assert.strictEqual(r.cache.repos["o/r"].stars, 1); assert.strictEqual(r.cache.repos["o/r"].downloadsTotal, 150); assert.strictEqual(r.cache.repos["o/r"].etagRepo, '"n1"');
  assert.ok(log.filter((x) => !x.inm).length >= 2, "asked again without the ETag");
});
t("when the call guard stops the releases call the card says 'release info not checked', never 'no public release yet'", async () => {
  const calls = []; for (let i = 0; i < 54; i++) calls.push(NOW - i * 1000);
  const r = await ST.refresh({ schema: 1, fetchedAt: null, rate: {}, calls, repos: {} }, ["o/r"], { fetchJson: async () => ({ status: 200, headers: H(30), body: fx("github_repo.json") }), now: NOW });
  const v = ST.view(r.cache, [{ id: "t", visibility: "public", repo: "o/r" }], NOW).byTool.t;
  assert.strictEqual(v.hasRelease, null);
  assert.match(M.toCard(tool({ visibility: "public", repo: "o/r" }), { stats: v }).releaseNote, /not checked/);
  const later = NOW + 3700000;
  const ok = await ST.refresh(r.cache, ["o/r"], { fetchJson: async (u) => (u.endsWith("per_page=10") ? { status: 200, headers: H(30), body: fx("github_releases_none.json") } : { status: 200, headers: H(30), body: fx("github_repo.json") }), now: later });
  assert.strictEqual(ST.view(ok.cache, [{ id: "t", visibility: "public", repo: "o/r" }], later).byTool.t.hasRelease, false);
});
t("cmd, wscript and powershell are started by absolute System32 paths (launcher and process list)", () => {
  for (const f of [L.SYS.cmd, L.SYS.wscript, L.SYS.powershell]) assert.ok(/^[A-Za-z]:\\.*System32\\.*\.exe$/i.test(f()), f());
  const s = sandbox();
  for (const f of ["a.vbs", "b.bat", "c.cmd", "d.ps1"]) { const r = L.check({ path: path.join(s.sub, f) }, s.opts); assert.ok(path.win32.isAbsolute(L.commandFor(r).exe), f); }
  const svc = strip(fs.readFileSync(path.join(SRC, "tools", "service.js"), "utf8")); assert.ok(!/execFile\(\s*["']/.test(svc), "no bare name in execFile");
});
t("Refresh is single-flight: two overlapping calls share one run and one set of GitHub calls", async () => {
  const w = world();
  const fixture = path.join(w.ws, "net.json"); fs.writeFileSync(fixture, JSON.stringify({}));
  w.put([base({ id: "ar", visibility: "public", repo: "example-user/copier" })]);
  const svc = w.mk({ env: { AGENT_DESKTOP_TOOLS_DIR: w.cat, AGENT_DESKTOP_TOOLS_ROOTS: w.root, AGENT_DESKTOP_TOOLS_TEST_FETCH: fixture } });
  const [a, b] = await Promise.all([svc.refreshStats(), svc.refreshStats()]);
  assert.strictEqual(a, b, "same result object");
  const doc = JSON.parse(fs.readFileSync(path.join(w.ud, "tools_stats.json"), "utf8")); assert.strictEqual(doc.calls.length, 1, "one repo call, not two");
});
t("TRUST: first Start shows the native confirm with the RESOLVED path and hash; approval pins it outside the catalogue folder; next Start is silent", async () => {
  const w = world(), lp = path.join(w.root, "ok.vbs");
  w.put([base({ id: "a", owner: "Own", launch: { path: lp } })]);
  const svc = w.mk(); const snap = await svc.load(), c0 = snap.groups[0].cards[0];
  assert.strictEqual(c0.trust, "new"); assert.strictEqual(c0.resolved.toLowerCase(), fs.realpathSync.native(lp).toLowerCase());
  assert.deepStrictEqual(await svc.start("a"), { ok: true }); assert.strictEqual(w.dialogs.length, 1);
  const d = w.dialogs[0]; assert.strictEqual(d.changed, false); assert.strictEqual(d.real.toLowerCase(), fs.realpathSync.native(lp).toLowerCase()); assert.match(d.sha256, /^[0-9a-f]{64}$/);
  const pin = JSON.parse(fs.readFileSync(path.join(w.ud, "tools_trust.json"), "utf8")).pins.a; assert.strictEqual(pin.sha256, d.sha256);
  assert.ok(!fs.existsSync(path.join(w.cat, "tools_trust.json")), "pin is not in the shared catalogue folder");
  assert.strictEqual((await svc.load()).groups[0].cards[0].trust, "trusted");
});
t("TRUST: changed launcher bytes, changed args, or a repointed path force the dialog again (marked CHANGED); cancel never spawns or stores", async () => {
  const w = world(), lp = path.join(w.root, "ok.vbs"), lp2 = path.join(w.root, "other.vbs"); fs.writeFileSync(lp2, "rem two");
  const put = (launch) => w.put([base({ id: "a", launch })]);
  put({ path: lp }); let svc = w.mk(); await svc.load(); assert.ok((await svc.start("a")).ok); assert.strictEqual(w.dialogs.length, 1);
  svc = w.mk(); await svc.load(); assert.ok((await svc.start("a")).ok); assert.strictEqual(w.dialogs.length, 1, "unchanged = silent");
  fs.writeFileSync(lp, "rem edited by someone"); svc = w.mk(); assert.strictEqual((await svc.load()).groups[0].cards[0].trust, "changed");
  assert.ok((await svc.start("a")).ok); assert.strictEqual(w.dialogs.length, 2); assert.strictEqual(w.dialogs[1].changed, true); assert.ok(w.dialogs[1].approvedAt);
  put({ path: lp, args: ["--x"] }); svc = w.mk(); await svc.load(); assert.ok((await svc.start("a")).ok); assert.strictEqual(w.dialogs.length, 3); assert.strictEqual(w.dialogs[2].changed, true, "args changed");
  put({ path: lp2, args: ["--x"] }); svc = w.mk(); await svc.load(); assert.ok((await svc.start("a")).ok); assert.strictEqual(w.dialogs.length, 4); assert.strictEqual(w.dialogs[3].changed, true, "path repointed");
  const before = w.spawned.length; w.state.answer = false; fs.writeFileSync(lp2, "rem again"); svc = w.mk(); await svc.load();
  assert.match((await svc.start("a")).reason, /Cancelled/); assert.strictEqual(w.spawned.length, before, "cancel never spawns");
  assert.strictEqual((await w.mk().load()).groups[0].cards[0].trust, "changed", "a cancelled approval is not stored");
});
t("TRUST: re-hash right before spawn (a swap while the dialog is open starts nothing); no dialog = refuse; throwing dialog = refuse", async () => {
  const w = world(), lp = path.join(w.root, "ok.vbs"); w.put([base({ id: "a", launch: { path: lp } })]);
  let svc = w.mk({ confirm: async () => { fs.writeFileSync(lp, "rem swapped during the dialog"); return true; } }); await svc.load();
  assert.match((await svc.start("a")).reason, /changed while confirming/); assert.strictEqual(w.spawned.length, 0);
  svc = w.mk({ confirm: null }); await svc.load(); assert.match((await svc.start("a")).reason, /No confirmation/); assert.strictEqual(w.spawned.length, 0);
  svc = w.mk({ confirm: async () => { throw new Error("x"); } }); await svc.load(); assert.match((await svc.start("a")).reason, /Cancelled/); assert.strictEqual(w.spawned.length, 0);
});
t("TRUST: Start refuses when tools.json's launch block changed since the page loaded; pin store survives junk; big files hash by size + head", async () => {
  const w = world(), lp = path.join(w.root, "ok.vbs"), lp2 = path.join(w.root, "z.vbs"); fs.writeFileSync(lp2, "z");
  w.put([base({ id: "a", launch: { path: lp } })]); const svc = w.mk(); await svc.load(); w.put([base({ id: "a", launch: { path: lp2 } })]);
  assert.match((await svc.start("a")).reason, /catalogue changed/); assert.strictEqual(w.spawned.length, 0); assert.strictEqual(w.dialogs.length, 0);
  const f = path.join(w.ws, "pins.json"); fs.writeFileSync(f, "{junk"); assert.deepStrictEqual(TR.load(f).pins, {});
  fs.writeFileSync(f, JSON.stringify({ schema: 1, pins: { a: { real: "x", sha256: "nothex", args: [] }, b: { real: "y", sha256: "a".repeat(64), args: ["q", 5] } } })); assert.deepStrictEqual(Object.keys(TR.load(f).pins), ["b"]);
  assert.strictEqual(TR.evaluate(undefined, { real: "x", args: [], sha256: "a" }), "new"); assert.strictEqual(TR.evaluate({ real: "X", args: [], sha256: "a" }, { real: "x", args: [], sha256: "a" }), "trusted");
  const big = path.join(w.ws, "big.bin"); const fd = fs.openSync(big, "w"); fs.ftruncateSync(fd, TR.BIG + 10); fs.closeSync(fd);
  const h = TR.hashFile(big); assert.strictEqual(h.partial, true); assert.match(h.sha256, /^[0-9a-f]{64}$/);
});
t("TRUST: the confirm is a native main-process dialog (static): opened in main-tools.js with Cancel as default, no renderer path to it", () => {
  const mt = fs.readFileSync(path.join(SRC, "tools", "main-tools.js"), "utf8");
  assert.ok(/dialog\.showMessageBox/.test(mt) && /defaultId: 0/.test(mt) && /cancelId: 0/.test(mt) && /launcher file only, not the program/.test(mt));
  assert.ok(!/api\.(trust|approve|confirm|pin)|\.(approve|pin)\(/i.test(fs.readFileSync(path.join(SRC, "renderer", "tools.js"), "utf8")), "the page cannot approve anything");
  const pre = fs.readFileSync(path.join(SRC, "preload.js"), "utf8"); assert.ok(!/tools-trust|tools-confirm|tools-approve/.test(pre));
});
t("generic process hints are refused (bare electron.exe, short fragments); specific ones pass", () => {
  for (const p of [{ name: "electron.exe" }, { name: "node.exe", cmd: "app" }, { cmd: "app" }, { name: "cmd.exe", cmd: "" }]) assert.ok(!S.validateTool(base({ process: p })).ok, JSON.stringify(p));
  for (const p of [{ name: "electron.exe", cmd: "Copier\\app" }, { name: "JUMPER-Portable-1.0.0.exe" }, { cmd: "Launch-Copier" }]) assert.ok(S.validateTool(base({ process: p })).ok, JSON.stringify(p));
});
t("process listing is cached 10 s (one listing per Start/load burst) and an unreadable list means 'unknown'", async () => {
  const w = world(), procs = path.join(w.ws, "procs.json"); fs.writeFileSync(procs, "[]");
  w.put([base({ id: "d", launch: { path: path.join(w.root, "ok.vbs") }, process: { name: "electron.exe", cmd: "demo\\app" } })]);
  const svc = w.mk({ env: { AGENT_DESKTOP_TOOLS_DIR: w.cat, AGENT_DESKTOP_TOOLS_ROOTS: w.root, AGENT_DESKTOP_TOOLS_TEST_PROCS: procs } });
  assert.strictEqual((await svc.load()).groups[0].cards[0].start.state, "ready");
  fs.writeFileSync(procs, JSON.stringify([{ name: "electron.exe", cmd: "x\\demo\\app" }]));
  assert.strictEqual((await svc.load()).groups[0].cards[0].start.state, "ready", "second load inside 10 s did not list again");
  assert.strictEqual(M.toCard(tool({ process: { name: "a.exe", cmd: "abcdef" } }), { procs: null, procsUnknown: true }).runningUnknown, true);
});
t("a11y: Enter/Space on cards, dialog role + focus handling, toast live region, :focus-visible, renderStats cannot blank the view", () => {
  const js = fs.readFileSync(path.join(SRC, "renderer", "tools.js"), "utf8"), css = fs.readFileSync(path.join(SRC, "renderer", "styles-tools.css"), "utf8");
  assert.ok(/ev\.key === "Enter" \|\| ev\.key === " "/.test(js)); assert.ok(/setAttribute\("role", "dialog"\)/.test(js)); assert.ok(/\.focus\(\)/.test(js) && /S\.focus = "opener"/.test(js));
  assert.ok(/aria-live", "polite"/.test(js) && /"role", "status"/.test(js)); assert.ok(/:focus-visible/.test(css));
  assert.ok(/Launcher file \(resolved\)/.test(js) && /Launcher trust/.test(js), "drawer shows resolved path and trust state");
  assert.ok(/function renderStats\(card\) \{\s*try/.test(js));
});
t("seed: a deleted launch key is not re-added, backups keep their own timestamp, --check enforces the app's rules", () => {
  if (!py || !fs.existsSync(SEED)) { console.log("  (skipped: python or seed script not available)"); return; }
  const ws = tmp(), out = path.join(ws, "tools.json"); fs.mkdirSync(path.join(ws, "shared_registry"));
  fs.mkdirSync(path.join(ws, "Acmeco Tools", "Copier"), { recursive: true }); fs.writeFileSync(path.join(ws, "Acmeco Tools", "Copier", "Launch-Copier.vbs"), "'");
  const run = (...a) => cp.spawnSync(py, [SEED, "--workspace", ws, "--out", out, ...a], { encoding: "utf8" });
  assert.strictEqual(run().status, 0);
  let doc = JSON.parse(fs.readFileSync(out, "utf8")); delete doc.tools.find((x) => x.id === "copier").launch; delete doc.tools.find((x) => x.id === "cutter").upcoming; fs.writeFileSync(out, JSON.stringify(doc));
  assert.strictEqual(run().status, 0); doc = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.ok(!("launch" in doc.tools.find((x) => x.id === "copier")), "launch stays removed"); assert.deepStrictEqual(doc.tools.find((x) => x.id === "cutter").upcoming, []);
  const baks = () => fs.readdirSync(ws).filter((f) => f.startsWith("tools.json.bak_")); const n1 = baks().length; assert.ok(n1 >= 1);
  delete doc.tools.find((x) => x.id === "echo").upcoming; fs.writeFileSync(out, JSON.stringify(doc)); cp.spawnSync(py, ["-c", "import time;time.sleep(1.2)"]);
  assert.strictEqual(run().status, 0); assert.ok(baks().length > n1, "second backup did not overwrite the first");
  const good = JSON.parse(fs.readFileSync(out, "utf8"));
  const muts = [["launch outside", (x) => { x.launch = { path: "C:\\Windows\\x.exe" }; }], ["repo", (x) => { x.repo = "../x"; }], ["process", (x) => { x.process = { name: "electron.exe" }; }],
    ["args", (x) => { x.launch = { path: ws + "\\a.vbs", args: ["a b"] }; }], ["url", (x) => { x.release = { url: "http://x" }; }]];
  for (const [label, mut] of muts) { const d2 = JSON.parse(JSON.stringify(good)); mut(d2.tools[0]); fs.writeFileSync(out, JSON.stringify(d2)); assert.notStrictEqual(run("--check").status, 0, label); }
  fs.writeFileSync(out, JSON.stringify(good)); assert.strictEqual(run("--check").status, 0);
  fs.rmSync(ws, { recursive: true, force: true });
});

(async () => {
  for (const q of queue) {
    n++;
    try { await q.fn(); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); }
  }
  console.log(fails ? fails + " of " + n + " FAILED" : "tools-fixes: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
