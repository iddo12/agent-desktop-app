// node tests/tools.test.js - TOOLS v1 (v1.83.0): catalogue schema, seed merge, launcher allow-list, GitHub stats (recorded fixtures,
// no live calls), card/status logic, service, IPC wiring, privacy and lightness guards. Only dummy launchers in a temp folder are run.
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
const MT = require("../src/tools/main-tools");

let n = 0, fails = 0; const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tools-test-"));
const SRC = path.join(__dirname, "..", "src");
const fx = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tools", f), "utf8"));
const base = (o) => Object.assign({ id: "demo", basket: "acmeco", name: "Demo", purpose: "Does a thing", status: "built" }, o || {});

// ------------------------------------------------------------------ schema
t("schema: a minimal entry is valid and gets safe defaults (private, no launcher)", () => {
  const r = S.validateTool(base());
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.entry.visibility, "private"); assert.strictEqual(r.entry.launch, null); assert.strictEqual(r.entry.self, false);
  assert.deepStrictEqual(r.entry.feedback, []); assert.strictEqual(r.entry.health.lastRun, "unknown");
});
t("schema: bad id, basket, status, repo, urls, dates and shapes are each rejected with a field name and no value", () => {
  for (const [patch, field] of [[{ id: "Bad Id" }, "id"], [{ basket: "x" }, "basket"], [{ status: "ready" }, "status"], [{ repo: "not a repo" }, "repo"],
    [{ name: "" }, "name"], [{ release: { url: "http://x.example/a" } }, "release.url"], [{ release: { date: "yesterday" } }, "release.date"],
    [{ visibility: "internal" }, "visibility"], [{ launch: { path: 5 } }, "launch"], [{ launch: { path: "a.vbs", args: "x" } }, "launch"],
    [{ process: {} }, "process"], [{ health: { lastRun: "maybe" } }, "health.lastRun"], [{ feedback: [{ text: 4 }] }, "feedback[0]"]]) {
    const r = S.validateTool(base(patch));
    assert.ok(!r.ok, field); assert.ok(r.errors.some((e) => e.field === field), field + " in " + JSON.stringify(r.errors));
    assert.ok(!JSON.stringify(r.errors).includes("x.example"), "errors carry no values");
  }
  assert.ok(!S.validateTool(null).ok); assert.ok(!S.validateTool([]).ok);
});
t("schema: unknown fields are dropped; every status has a label; the four chips exist", () => {
  const r = S.validateTool(base({ evil: "<script>", status: "partial" }));
  assert.ok(!("evil" in r.entry));
  assert.deepStrictEqual(["built", "partially built", "tested, not released", "in development"], ["built", "partial", "tested", "in-dev"].map((k) => S.STATUS_LABELS[k]));
});
t("schema: catalogue skips a bad or duplicate entry and reports it, keeps the rest; wrong file shape is a file error", () => {
  const r = S.validateCatalogue({ schema: 1, tools: [base(), base(), base({ id: "other", status: "zzz" }), base({ id: "ok2" })] });
  assert.deepStrictEqual(r.tools.map((x) => x.id), ["demo", "ok2"]);
  assert.deepStrictEqual(r.rejected.map((x) => x.errors[0].code), ["duplicate", "bad-status"]);
  assert.strictEqual(S.validateCatalogue({ schema: 2, tools: [] }).fileError, "bad-file");
  assert.strictEqual(S.validateCatalogue(null).fileError, "bad-file");
});

// ------------------------------------------------------------------ seed script
const py = (() => { for (const c of ["python", "py"]) { const r = cp.spawnSync(c, ["--version"], { encoding: "utf8" }); if (!r.error && r.status === 0) return c; } return null; })();
const SEED = "C:\\Example\\Workspace\\shared_tools\\tools\\seed_tools.py";
t("seed: proposes entries, marks guesses, merges by id, never overwrites a hand edit, adds only missing keys", () => {
  if (!py || !fs.existsSync(SEED)) { console.log("  (skipped: python or seed script not available)"); return; }
  const ws = tmp(), out = path.join(ws, "tools.json");
  fs.mkdirSync(path.join(ws, "shared_registry"));
  fs.mkdirSync(path.join(ws, "Acmeco Tools", "Copier"), { recursive: true });
  fs.writeFileSync(path.join(ws, "Acmeco Tools", "Copier", "Launch-Copier.vbs"), "' dummy");
  fs.writeFileSync(path.join(ws, "shared_registry", "r.json"), JSON.stringify({ id: "copier-verified-card-ingest", type: "project", title: "COPIER", description: "REGISTRY TEXT", agent: "Software Engineering Agent" }));
  const run = (...a) => cp.spawnSync(py, [SEED, "--workspace", ws, "--out", out, ...a], { encoding: "utf8" });
  let r = run(); assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  let doc = JSON.parse(fs.readFileSync(out, "utf8"));
  const ar = doc.tools.find((x) => x.id === "copier");
  assert.ok(ar.launch.path.endsWith("Launch-Copier.vbs")); assert.strictEqual(ar.description, "REGISTRY TEXT"); assert.ok(ar.uncertain.includes("status"));
  assert.ok(doc.tools.find((x) => x.id === "cutter").uncertain.includes("launch-missing"), "a launcher that is not on disk is flagged");
  assert.strictEqual(doc.tools.find((x) => x.id === "cutter").launch, null);
  assert.ok(S.validateCatalogue(doc).rejected.length === 0, "seeded catalogue validates");
  // hand edit + removed key + untouched second run
  ar.name = "COPIER hand-edited"; ar.status = "tested"; ar.uncertain = []; delete ar.upcoming;
  fs.writeFileSync(out, JSON.stringify(doc));
  r = run(); assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const doc2 = JSON.parse(fs.readFileSync(out, "utf8")), ar2 = doc2.tools.find((x) => x.id === "copier");
  assert.strictEqual(ar2.name, "COPIER hand-edited"); assert.strictEqual(ar2.status, "tested"); assert.deepStrictEqual(ar2.uncertain, []);
  assert.deepStrictEqual(ar2.upcoming, [], "a missing key is filled");
  assert.strictEqual(doc2.tools.length, doc.tools.length, "nothing added twice, nothing deleted");
  // a tool added by hand and unknown to the seed survives
  doc2.tools.push(base({ id: "mine" })); fs.writeFileSync(out, JSON.stringify(doc2));
  assert.strictEqual(run().status, 0); assert.ok(JSON.parse(fs.readFileSync(out, "utf8")).tools.some((x) => x.id === "mine"));
  assert.strictEqual(run("--check").status, 0);
  fs.rmSync(ws, { recursive: true, force: true });
});
t("seed: the real seeded catalogue (if present) validates and has both baskets and Agent Desktop as self", () => {
  const f = "C:\\Example\\Workspace\\shared_tools\\tools\\tools.json";
  if (!fs.existsSync(f)) return;
  const r = S.validateCatalogue(JSON.parse(fs.readFileSync(f, "utf8")));
  assert.strictEqual(r.rejected.length, 0, JSON.stringify(r.rejected));
  assert.ok(r.tools.some((x) => x.basket === "acmeco") && r.tools.some((x) => x.basket === "other"));
  assert.strictEqual(r.tools.find((x) => x.id === "agent-desktop").self, true);
});

// ------------------------------------------------------------------ launcher allow-list
function sandbox() {
  const root = tmp(), outside = tmp();
  const sub = path.join(root, "Tools"); fs.mkdirSync(sub);
  for (const f of ["a.vbs", "b.bat", "c.cmd", "d.ps1", "e.exe", "f.txt", "g.js", "My Tool (v1).vbs"]) fs.writeFileSync(path.join(sub, f), "rem");
  fs.writeFileSync(path.join(outside, "evil.vbs"), "rem");
  return { root, outside, sub, opts: { roots: [root] } };
}
t("launcher: files under an allowed root with an allowed extension pass (vbs, bat, cmd, ps1, exe, spaces and parentheses)", () => {
  const s = sandbox();
  for (const f of ["a.vbs", "b.bat", "c.cmd", "d.ps1", "e.exe", "My Tool (v1).vbs"]) { const r = L.check({ path: path.join(s.sub, f), args: [] }, s.opts); assert.ok(r.ok, f + " " + r.reason); }
  assert.ok(L.check({ path: path.join(s.sub, "a.vbs").replace(/\\/g, "/") }, s.opts).ok, "forward slashes normalise");
});
t("launcher: extension allow-list (txt, js, lnk, double extension, none, case tricks)", () => {
  const s = sandbox();
  for (const f of ["f.txt", "g.js", "a.vbs.txt", "a.lnk", "noext"]) assert.strictEqual(L.check({ path: path.join(s.sub, f) }, s.opts).reason, f === "a.vbs.txt" || f === "f.txt" || f === "g.js" || f === "a.lnk" || f === "noext" ? "extension-not-allowed" : "", f);
  fs.writeFileSync(path.join(s.sub, "UP.VBS"), "rem"); assert.ok(L.check({ path: path.join(s.sub, "UP.VBS") }, s.opts).ok, "upper-case extension is fine");
});
t("launcher: path traversal, relative, drive-relative, UNC and device paths are refused", () => {
  const s = sandbox();
  const cases = { traversal: path.join(s.sub, "..", "..", path.basename(s.outside), "evil.vbs"), dot: s.sub + "\\.\\a.vbs", rel: "Tools\\a.vbs", drive: "C:a.vbs", unc: "\\\\server\\share\\a.vbs", uncSlash: "//server/share/a.vbs", device: "\\\\?\\" + path.join(s.sub, "a.vbs"), dev2: "\\\\.\\C:\\a.vbs", empty: "", dbl: s.sub + "\\\\a.vbs", trail: s.sub + "\\a.vbs." };
  for (const [k, p] of Object.entries(cases)) assert.ok(!L.check({ path: p }, s.opts).ok, k + " should be refused: " + p);
  assert.strictEqual(L.check({ path: cases.unc }, s.opts).reason, "unc-or-device-path");
  assert.strictEqual(L.check({ path: path.join(s.outside, "evil.vbs") }, s.opts).reason, "outside-allowed-folders");
  assert.strictEqual(L.check({ path: s.root + "-evil\\x.vbs" }, s.opts).reason, "outside-allowed-folders", "a sibling folder with the same prefix is outside");
  assert.ok(!L.check({ path: s.root }, s.opts).ok, "the root itself is not a launcher");
});
t("launcher: quote, shell and unicode characters in the path are refused (quote injection)", () => {
  const s = sandbox();
  for (const bad of ['a"b.vbs', "a'b.vbs", "a&calc.vbs", "a^b.vbs", "a%PATH%.vbs", "a;b.vbs", "a`b.vbs", "a$b.vbs", "a|b.vbs", "a<b.vbs", "a>b.vbs", "a!b.vbs", "a,b.vbs", "a\nb.vbs", "a\0b.vbs", "\u05d0.vbs", "a*.vbs", "a?.vbs"])
    assert.strictEqual(L.check({ path: s.sub + "\\" + bad }, s.opts).reason, "bad-characters", JSON.stringify(bad));
  assert.strictEqual(L.check({ path: s.sub + '\\x" & calc & ".vbs' }, s.opts).reason, "bad-characters");
});
t("launcher: arguments must be a few plain tokens (no quotes, spaces, metacharacters, switches or option injection)", () => {
  const s = sandbox(), p = path.join(s.sub, "a.vbs");
  for (const ok of [[], ["--demo"], ["mode=fast", "C:\\data\\x.txt", "a.b-c_d"], ["-v"]]) assert.ok(L.check({ path: p, args: ok }, s.opts).ok, JSON.stringify(ok));
  for (const bad of [["&calc"], ['"x"'], ["a b"], ["a;b"], ["$(x)"], ["`x`"], ["|more"], ["%TEMP%"], ["a\nb"], ["//E:vbscript"], ["/c"], ["/?"], ["-"], ["--"], ["--x y"], ["-1"], [5], [null], [""], ["x".repeat(201)], Array(9).fill("a"), ["..\\..\\x"].concat(["&"])]) {
    const r = L.check({ path: p, args: bad }, s.opts); assert.ok(!r.ok, JSON.stringify(bad)); assert.ok(/bad-argument|too-many-args/.test(r.reason), r.reason);
  }
  fs.mkdirSync(path.join(s.root, "Odd (dir)")); fs.writeFileSync(path.join(s.root, "Odd (dir)", "p.bat"), "rem");
  assert.ok(L.check({ path: path.join(s.root, "Odd (dir)", "p.bat"), args: [] }, s.opts).ok); assert.ok(!L.check({ path: path.join(s.root, "Odd (dir)", "p.bat"), args: ["x"] }, s.opts).ok, "bat in a parenthesised folder takes no args");
  assert.strictEqual(L.check({ path: p, args: "x" }, s.opts).ok, true, "a non-array args is treated as none");
});
t("launcher: a junction or symlink inside the root that points outside is refused (real path re-checked)", () => {
  const s = sandbox(), link = path.join(s.root, "jump");
  try { fs.symlinkSync(s.outside, link, "junction"); } catch (e) { console.log("  (skipped: cannot create a junction)"); return; }
  assert.strictEqual(L.check({ path: link + "\\evil.vbs" }, s.opts).reason, "resolves-outside-allowed-folders");
  const flink = path.join(s.sub, "alias.vbs");
  try { fs.symlinkSync(path.join(s.outside, "evil.vbs"), flink, "file"); assert.ok(!L.check({ path: flink }, s.opts).ok, "file symlink out of the root"); } catch (e) { if (e.code !== "EPERM") throw e; }
  assert.ok(L.check({ path: path.join(s.sub, "a.vbs") }, s.opts).ok, "the normal file still passes");
});
t("launcher: missing file, a directory named like a launcher, and an empty/odd launch object are refused", () => {
  const s = sandbox(); fs.mkdirSync(path.join(s.sub, "dir.vbs"));
  assert.strictEqual(L.check({ path: path.join(s.sub, "nope.vbs") }, s.opts).reason, "missing");
  assert.strictEqual(L.check({ path: path.join(s.sub, "dir.vbs") }, s.opts).reason, "not-a-file");
  for (const x of [null, undefined, {}, { path: 5 }, "a.vbs", []]) assert.ok(!L.check(x, s.opts).ok);
});
t("launcher: there are no built-in roots (they come from the configuration)", () => {
  assert.deepStrictEqual(L.DEFAULT_ROOTS, []);
  assert.deepStrictEqual(L.EXTS, [".vbs", ".bat", ".cmd", ".ps1", ".exe"]);
  assert.strictEqual(L.check({ path: "C:\\Windows\\System32\\cmd.exe" }).reason, "outside-allowed-folders");
});
t("launcher: start() spawns an ARGUMENT ARRAY, detached, hidden, no shell, cwd = launcher folder, per extension", () => {
  const s = sandbox(), calls = [];
  const spawn = (exe, argv, o) => { calls.push({ exe, argv, o }); return { pid: 4242, on() {}, unref() { calls.unref = true; } }; };
  const run = (f, args) => L.start({ path: path.join(s.sub, f), args }, { roots: [s.root], spawn });
  assert.deepStrictEqual(run("a.vbs", ["x1"]), { ok: true, reason: "", pid: 4242 });
  run("b.bat", ["mode=1"]); run("c.cmd", []); run("d.ps1", ["--k"]); run("e.exe", ["z"]); run("My Tool (v1).vbs", []);
  assert.strictEqual(calls[0].exe, L.SYS.wscript()); assert.deepStrictEqual(calls[0].argv, ["//B", "//Nologo", path.join(s.sub, "a.vbs"), "x1"]);
  assert.strictEqual(calls[1].exe, L.SYS.cmd()); assert.deepStrictEqual(calls[1].argv, ["/d", "/c", path.join(s.sub, "b.bat"), "mode=1"], "args as separate elements, no shell string");
  assert.deepStrictEqual(calls[2].argv, ["/d", "/c", path.join(s.sub, "c.cmd")]);
  assert.strictEqual(calls[3].exe, L.SYS.powershell()); assert.ok(calls[3].argv.includes("-File") && calls[3].argv.includes("Hidden") && calls[3].argv.slice(-2)[0] === path.join(s.sub, "d.ps1"));
  assert.strictEqual(calls[4].exe, path.join(s.sub, "e.exe")); assert.deepStrictEqual(calls[4].argv, ["z"]);
  for (const c of calls) { assert.ok(Array.isArray(c.argv)); assert.strictEqual(c.o.detached, true); assert.strictEqual(c.o.windowsHide, true); assert.strictEqual(c.o.shell, false); assert.strictEqual(c.o.stdio, "ignore"); assert.strictEqual(c.o.cwd, s.sub); }
  assert.ok(calls.unref, "unref'd so it outlives the app");
  const before = calls.length; assert.strictEqual(L.start({ path: path.join(s.sub, "f.txt") }, { roots: [s.root], spawn }).ok, false); assert.strictEqual(calls.length, before, "a refused launch never spawns");
  assert.strictEqual(L.start({ path: path.join(s.sub, "a.vbs") }, { roots: [s.root], spawn: () => { throw new Error("boom"); } }).reason, "spawn-failed");
});
t("launcher: a harmless dummy .bat in a temp folder really starts, with cwd and args as given (Windows only)", async () => {
  if (process.platform !== "win32") return;
  const s = sandbox(), marker = path.join(s.sub, "ran.txt");
  fs.writeFileSync(path.join(s.sub, "dummy tool.bat"), "@echo off\r\necho %1> \"%~dp0ran.txt\"\r\n");
  const r = L.start({ path: path.join(s.sub, "dummy tool.bat"), args: ["hello"] }, { roots: [s.root] });
  assert.ok(r.ok, r.reason);
  for (let i = 0; i < 40 && !fs.existsSync(marker); i++) await new Promise((x) => setTimeout(x, 100));
  assert.ok(fs.existsSync(marker), "the dummy launcher ran"); assert.strictEqual(fs.readFileSync(marker, "utf8").trim(), "hello");
});

// ------------------------------------------------------------------ GitHub stats (recorded fixtures, injected network)
const NOW = Date.parse("2026-10-07T12:00:00Z");
const API = "https://api.github.com";
function fakeNet(routes, log) {
  return async (url, headers) => {
    (log || []).push({ url, headers });
    const r = routes[url]; if (typeof r === "function") return r(headers);
    if (!r) return { status: 404, headers: {}, body: null };
    return r;
  };
}
const H = (rem, etag) => Object.assign({ "x-ratelimit-remaining": String(rem), "x-ratelimit-limit": "60", "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 1800) }, etag ? { etag } : {});
t("stats: repo and release parsing keep numbers only, skip drafts, total the downloads, ignore bad shapes", () => {
  assert.deepStrictEqual(ST.parseRepo(fx("github_repo.json")), { stars: 1, forks: 0, watchers: 1, openIssues: 4, pushedAt: "2026-10-07", license: "MIT" });
  const r = ST.parseReleases(fx("github_releases_two.json"));
  assert.strictEqual(r.releases.length, 2, "draft skipped"); assert.strictEqual(r.downloadsTotal, 150);
  assert.deepStrictEqual(r.releases[0].assets, [{ name: "Copier-Setup-1.2.0.exe", downloads: 120 }, { name: "Copier-1.2.0-portable.zip", downloads: 30 }]);
  assert.strictEqual(r.releases[1].prerelease, true); assert.strictEqual(r.releases[0].date, "2026-10-01");
  assert.deepStrictEqual(ST.parseReleases([]), { releases: [], downloadsTotal: 0 });
  assert.strictEqual(ST.parseRepo("x"), null); assert.strictEqual(ST.parseReleases({}), null);
  assert.strictEqual(ST.parseReleases([{ tag_name: "v", html_url: "javascript:alert(1)", assets: [{ name: "a", download_count: -5 }] }]).releases[0].url, null, "non-github url dropped");
});
t("stats: only public tools with a repo are queried (private repos never)", () => {
  assert.deepStrictEqual(ST.eligible([{ visibility: "public", repo: "a/b" }, { visibility: "private", repo: "c/d" }, { visibility: "public", repo: null }, { visibility: "public", repo: "a/b" }]), ["a/b"]);
});
t("stats: refresh fetches repo + releases, caches ETags, and reports 'no public release yet' via view()", async () => {
  const log = [];
  const net = fakeNet({ [API + "/repos/example-user/agent-desktop"]: { status: 200, headers: H(58, '"r1"'), body: fx("github_repo.json") }, [API + "/repos/example-user/agent-desktop/releases?per_page=10"]: { status: 200, headers: H(57, '"l1"'), body: fx("github_releases_none.json") } }, log);
  const r = await ST.refresh(null, ["example-user/agent-desktop"], { fetchJson: net, now: NOW });
  assert.strictEqual(r.summary.fetched, 1); assert.strictEqual(log.length, 2); assert.strictEqual(r.cache.rate.remaining, 57); assert.strictEqual(r.cache.calls.length, 2);
  assert.ok(!log.some((c) => c.headers.Authorization), "unauthenticated");
  const v = ST.view(r.cache, [{ id: "ad", visibility: "public", repo: "example-user/agent-desktop" }, { id: "priv", visibility: "private", repo: "x/y" }], NOW + 60000);
  assert.strictEqual(v.byTool.ad.stars, 1); assert.strictEqual(v.byTool.ad.hasRelease, false); assert.strictEqual(v.byTool.ad.stale, false); assert.ok(!("priv" in v.byTool));
  assert.strictEqual(v.callsLeft, 53);
  assert.strictEqual(ST.view(r.cache, [{ id: "ad", visibility: "public", repo: "example-user/agent-desktop" }], NOW + 25 * 3600000).byTool.ad.stale, true, "older than 24 h is flagged");
});
t("stats: a second refresh sends If-None-Match and a 304 keeps the cached numbers", async () => {
  const route = (h) => (h["If-None-Match"] ? { status: 304, headers: H(50), body: null } : { status: 200, headers: H(51, '"e"'), body: fx("github_repo.json") });
  const rel = (h) => (h["If-None-Match"] ? { status: 304, headers: H(49), body: null } : { status: 200, headers: H(50, '"f"'), body: fx("github_releases_two.json") });
  const routes = { [API + "/repos/example-user/copier"]: route, [API + "/repos/example-user/copier/releases?per_page=10"]: rel };
  const a = await ST.refresh(null, ["example-user/copier"], { fetchJson: fakeNet(routes), now: NOW });
  const log = [];
  const b = await ST.refresh(a.cache, ["example-user/copier"], { fetchJson: fakeNet(routes, log), now: NOW + 3600000 * 0.5 });
  assert.ok(log.every((c) => c.headers["If-None-Match"]), "conditional requests"); assert.strictEqual(b.summary.notModified, 2);
  assert.strictEqual(b.cache.repos["example-user/copier"].downloadsTotal, 150, "data kept on 304"); assert.strictEqual(b.cache.fetchedAt, NOW + 1800000);
});
t("stats: 404 is 'not found', 403/429 is a limit message, offline keeps the old numbers and says so", async () => {
  const good = { [API + "/repos/o/r"]: { status: 200, headers: H(40, '"a"'), body: fx("github_repo.json") }, [API + "/repos/o/r/releases?per_page=10"]: { status: 200, headers: H(39), body: fx("github_releases_two.json") } };
  const a = await ST.refresh(null, ["o/r"], { fetchJson: fakeNet(good), now: NOW });
  const off = await ST.refresh(a.cache, ["o/r"], { fetchJson: async () => { throw new Error("ENOTFOUND"); }, now: NOW + 1000 });
  assert.strictEqual(off.summary.offline, true); assert.strictEqual(off.cache.repos["o/r"].stars, 1, "cache untouched");
  const nf = await ST.refresh(null, ["o/gone"], { fetchJson: fakeNet({}), now: NOW });
  assert.strictEqual(nf.summary.notFound, 1); assert.strictEqual(ST.view(nf.cache, [{ id: "g", visibility: "public", repo: "o/gone" }], NOW).byTool.g.notFound, true);
  for (const code of [403, 429]) { const lim = await ST.refresh(a.cache, ["o/r"], { fetchJson: fakeNet({ [API + "/repos/o/r"]: { status: code, headers: { "x-ratelimit-remaining": "0" }, body: { message: "rate limited" } } }), now: NOW + 2000 }); assert.strictEqual(lim.summary.limited, true); assert.strictEqual(lim.cache.repos["o/r"].stars, 1); }
});
t("stats: the 55-calls-per-hour guard stops before GitHub's 60, counts a rolling hour, and honours the remaining header", async () => {
  const calls = []; for (let i = 0; i < 54; i++) calls.push(NOW - i * 1000);
  const c0 = { schema: 1, fetchedAt: null, rate: {}, calls, repos: {} };
  let hit = 0;
  const net = async () => { hit++; return { status: 200, headers: H(5, '"x"'), body: fx("github_repo.json") }; };
  const r = await ST.refresh(c0, ["a/b", "c/d"], { fetchJson: net, now: NOW });
  assert.strictEqual(hit, 1, "only one call left in the budget"); assert.strictEqual(r.summary.limited, true); assert.strictEqual(ST.callsLeft(r.cache, NOW), 0);
  assert.strictEqual(ST.callsLeft(r.cache, NOW + 3601000), 55, "an hour later the budget is back");
  let hit2 = 0;
  const r2 = await ST.refresh({ schema: 1, fetchedAt: null, rate: { remaining: 0, limit: 60, reset: NOW + 600000 }, calls: [], repos: {} }, ["a/b"], { fetchJson: async () => { hit2++; return { status: 200, headers: {}, body: {} }; }, now: NOW });
  assert.strictEqual(hit2, 0); assert.strictEqual(r2.summary.limited, true);
});
t("stats: bad repo names are never requested; the real fetcher refuses any host but api.github.com; cache loader survives junk", async () => {
  let hit = 0;
  const r = await ST.refresh(null, ["../../x", "a b/c", "a/b/c", ""], { fetchJson: async () => { hit++; return { status: 200, headers: {}, body: {} }; }, now: NOW });
  assert.strictEqual(hit, 0); assert.strictEqual(r.summary.failed, 4);
  await assert.rejects(() => ST.realFetchJson("https://evil.example/repos/a/b", {}), /host/);
  await assert.rejects(() => ST.realFetchJson("http://api.github.com/x", {}), /host/);
  for (const junk of [null, 5, "x", { schema: 2 }, { schema: 1 }, { schema: 1, repos: null }]) assert.deepStrictEqual(ST.loadCache(junk).repos, {});
});

// ------------------------------------------------------------------ card / status logic
const tool = (o) => S.validateTool(base(o)).entry;
t("model: running detection by process name and command line; self is always running; no hint is never running", () => {
  const procs = [{ name: "electron.exe", cmd: "C:\\x\\Copier\\app" }, { name: "notepad.exe", cmd: "" }];
  assert.ok(M.isRunning(tool({ process: { name: "ELECTRON.exe", cmd: "copier\\app" } }), procs));
  assert.ok(!M.isRunning(tool({ process: { name: "electron.exe", cmd: "sorter" } }), procs));
  assert.ok(M.isRunning(tool({ process: { name: "notepad.exe" } }), procs)); assert.ok(M.isRunning(tool({ process: { cmd: "copier" } }), procs));
  assert.ok(!M.isRunning(tool(), procs)); assert.ok(!M.isRunning(tool({ process: { name: "x.exe" } }), null));
  assert.ok(M.isRunning(tool({ self: true }), []));
});
t("model: Start state - ready, running, no launcher, blocked launcher with a reason; Agent Desktop shows Running", () => {
  const ok = { ok: true };
  assert.strictEqual(M.toCard(tool({ launch: { path: "D:\\x.vbs" } }), { launchCheck: ok }).start.state, "ready");
  assert.strictEqual(M.toCard(tool({ launch: { path: "D:\\x.vbs" }, process: { name: "a.exe" } }), { launchCheck: ok, procs: [{ name: "a.exe" }] }).start.label, "Running");
  const none = M.toCard(tool(), { launchCheck: null }); assert.strictEqual(none.start.state, "disabled"); assert.match(none.start.reason, /No launcher/);
  const bad = M.toCard(tool({ launch: { path: "C:\\x.vbs" } }), { launchCheck: { ok: false, reason: "outside-allowed-folders" } }); assert.match(bad.start.reason, /outside the allowed/);
  const self = M.toCard(tool({ self: true, launch: { path: "D:\\x.vbs" } }), { launchCheck: ok }); assert.strictEqual(self.start.state, "running");
  assert.strictEqual(self.dots[0].text, "Running now");
});
t("model: health dots - launcher, last run, tested (with age warning after 30 days) each carry a word", () => {
  const d = M.healthDots(tool({ launch: { path: "a" }, health: { lastRun: "failed", tested: true, lastTested: "2026-07-01" } }), { ok: true }, "2026-10-07");
  assert.deepStrictEqual(d.map((x) => x.state), ["ok", "bad", "warn"]); assert.ok(d.every((x) => x.text && x.label)); assert.match(d[2].text, /98 days ago/);
  const e = M.healthDots(tool(), null, "2026-10-07"); assert.deepStrictEqual(e.map((x) => x.state), ["bad", "unknown", "unknown"]);
  assert.strictEqual(M.healthDots(tool({ health: { tested: true, lastTested: "2026-10-01" } }), null, "2026-10-07")[2].state, "ok");
});
t("model: PRIVACY - a private tool shows no repo link, no release link and no stats, even if the file names a repo", () => {
  const p = tool({ visibility: "private", repo: "example-user/secret", release: { url: "https://github.com/example-user/secret/releases/1", date: "2026-10-01" } });
  const c = M.toCard(p, { stats: { fetched: true, stars: 9 } });
  assert.strictEqual(c.repoUrl, null); assert.strictEqual(c.hasRepo, false); assert.strictEqual(c.release.url, null); assert.strictEqual(c.release.date, null); assert.strictEqual(c.stats, null);
  assert.ok(!JSON.stringify(c).includes("example-user/secret"), "the repo name is not in the card at all");
  const pub = M.toCard(tool({ visibility: "public", repo: "example-user/agent-desktop" }), {});
  assert.strictEqual(pub.repoUrl, "https://github.com/example-user/agent-desktop"); assert.strictEqual(pub.releaseNote, "no public release yet"); assert.deepStrictEqual(pub.stats, { fetched: false });
  const rel = M.toCard(tool({ visibility: "public", repo: "example-user/copier" }), { stats: { fetched: true, hasRelease: true } }); assert.strictEqual(rel.releaseNote, "");
});
t("kind: optional; missing is app, service is kept, an unknown value is flagged but the entry still loads as app", () => {
  assert.strictEqual(S.validateTool(base()).entry.kind, "app");
  assert.strictEqual(S.validateTool(base({ kind: "service" })).entry.kind, "service");
  assert.strictEqual(S.validateTool(base({ kind: "app" })).entry.kindBad, false);
  for (const bad of ["daemon", "", 3, {}, true]) { const r = S.validateTool(base({ kind: bad })); assert.ok(r.ok, "still loads"); assert.strictEqual(r.entry.kind, "app"); assert.strictEqual(r.entry.kindBad, true); }
  assert.doesNotThrow(() => S.validateTool(base({ kind: Symbol.iterator })));
  assert.deepStrictEqual(S.KINDS, ["app", "service"]);
});
t("model: tabs group by kind first, then by basket; counts per tab; a card with no kind is a program", () => {
  const cards = [M.toCard(tool({ id: "a" }), {}), M.toCard(tool({ id: "s1", kind: "service", basket: "other" }), {}), M.toCard(tool({ id: "s2", kind: "service" }), {}), M.toCard(tool({ id: "o", basket: "other" }), {})];
  assert.deepStrictEqual(cards.map((c) => c.kind), ["app", "service", "service", "app"]);
  const tabs = M.groupByKind(cards, { acmeco: "Acmeco tools" });
  assert.deepStrictEqual(tabs.map((x) => [x.kind, x.label, x.count]), [["app", "Programs", 2], ["service", "Behind the scenes", 2]]);
  assert.deepStrictEqual(tabs[0].groups.map((g) => [g.basket, g.label, g.cards.map((c) => c.id)]), [["acmeco", "Acmeco tools", ["a"]], ["other", "Other tools", ["o"]]]);
  assert.deepStrictEqual(tabs[1].groups.map((g) => [g.basket, g.cards.map((c) => c.id)]), [["acmeco", ["s2"]], ["other", ["s1"]]]);
  assert.deepStrictEqual(M.groupByKind([]).map((x) => x.count), [0, 0]);
  assert.deepStrictEqual(M.groupByKind([{ id: "x", basket: "acmeco" }])[0].groups[0].cards.length, 1, "kindless card -> Programs");
  assert.strictEqual(S.validateTool(base({ basket: ["lens", "vid"].join("") })).entry.basket, "acmeco", "old stored basket name still accepted");
});
t("service: snapshot carries per-tab groups, total count stays the total, bad kinds are reported by code only", async () => {
  const w = world([base({ id: "p1" }), base({ id: "s1", kind: "service" }), base({ id: "s2", kind: "service", basket: "other" }), base({ id: "weird", kind: "daemon" })]);
  const r = await w.svc.load();
  assert.strictEqual(r.count, 4); assert.deepStrictEqual(r.tabs.map((x) => x.count), [2, 2]);
  assert.deepStrictEqual(r.catalogue.kinds, [{ id: "weird", code: "bad-kind" }]); assert.ok(!JSON.stringify(r.catalogue).includes("daemon"));
  assert.strictEqual(r.groups.reduce((n, g) => n + g.cards.length, 0), 4, "flat groups still hold every card");
});
t("renderer: tab strip is a real tablist (roles, arrows, Home/End), remembered via prefs, empty tab message, no tabs in setup state", () => {
  const js = fs.readFileSync(path.join(SRC, "renderer", "tools.js"), "utf8"), css = fs.readFileSync(path.join(SRC, "renderer", "styles-tools.css"), "utf8");
  assert.ok(/function renderTabs\(/.test(js) && /"role", "tablist"/.test(js) && /"role", "tab"/.test(js) && /aria-selected/.test(js) && /"role", "tabpanel"/.test(js));
  assert.ok(/ArrowRight/.test(js.slice(js.indexOf("function renderTabs"))) && /"Home"/.test(js) && /"End"/.test(js));
  assert.ok(/Programs/.test(js) && /Behind the scenes/.test(js) && /setPrefs\(\{ tab: k \}\)/.test(js) && /p\.tab === "service"/.test(js));
  assert.ok(/Nothing behind the scenes yet/.test(js) && css.includes(".tl-tab {") && css.includes(".tl-tab:focus-visible"));
  assert.ok(/S\.snap\.ok && S\.snap\.count\) headHost\.appendChild\(renderTabs/.test(js), "tabs only when the catalogue loaded");
  assert.ok(/S\.snap\.count \+ " tools"/.test(js), "header count stays the total");
});
t("prefs: tab is saved beside card size as a patch (static contract), default is Programs", () => {
  const src = fs.readFileSync(path.join(SRC, "tools", "main-tools.js"), "utf8");
  assert.ok(/tab: j && j\.tab === "service" \? "service" : "app"/.test(src) && /a\.tab === "app" \|\| a\.tab === "service"/.test(src));
});
t("model: baskets are two headed groups in fixed order; Coming up lists only ideas/researched not already tools, newest first, capped", () => {
  const cards = [M.toCard(tool({ id: "a", basket: "other" }), {}), M.toCard(tool({ id: "b" }), {})];
  assert.deepStrictEqual(M.groupCards(cards, { acmeco: "Acmeco tools" }).map((g) => [g.label, g.cards.map((c) => c.id)]), [["Acmeco tools", ["b"]], ["Other tools", ["a"]]]);
  assert.deepStrictEqual(M.groupCards(cards).map((g) => g.label), ["Tools", "Other tools"], "neutral default heading");
  const reg = [{ id: "i1", type: "project", stage: "idea", title: "Idea one", updatedAt: "2026-10-01" }, { id: "r1", type: "project", stage: "researched", title: "Researched", updatedAt: "2026-09-01" }, { id: "act", type: "project", stage: "active", title: "Active" },
    { id: "demo", type: "project", stage: "idea", title: "Already a tool" }, { id: "old", type: "project", stage: "idea", title: "Old", status: "archived" }, { id: "doc", type: "document", stage: "idea", title: "Doc" }, { id: "i2", type: "project", stage: "idea", title: "Idea two", updatedAt: "2026-10-05" }];
  const c = M.comingUp(reg, [tool()], 2);
  assert.deepStrictEqual(c.items.map((x) => x.id), ["r1", "i2"]); assert.strictEqual(c.total, 3);
  assert.deepStrictEqual(M.comingUp(reg, [tool({ id: "z", registryId: "r1" })], 24).items.slice(0, 2).map((x) => x.id), ["i2", "i1"]);
});

// ------------------------------------------------------------------ service (temp folders only)
function world(tools, extraEnv) {
  const ws = tmp(), cat = path.join(ws, "cat"), ud = path.join(ws, "ud"), reg = path.join(ws, "reg"), root = path.join(ws, "root");
  for (const d of [cat, ud, reg, root]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(root, "ok.vbs"), "rem");
  fs.writeFileSync(path.join(cat, "tools.json"), JSON.stringify({ schema: 1, tools }));
  fs.writeFileSync(path.join(reg, "x.json"), JSON.stringify({ id: "x1", type: "project", stage: "idea", title: "Future thing" }));
  const spawned = [], opened = [], dialogs = [];
  const state = { answer: true };
  const env = Object.assign({ AGENT_DESKTOP_TOOLS_DIR: cat, AGENT_DESKTOP_TOOLS_REGISTRY: reg, AGENT_DESKTOP_TOOLS_ROOTS: root }, extraEnv || {});
  const svc = SV.createService({ workspaceRoot: ws, userData: ud, testMode: true, env, log: () => {}, spawn: (e, a, o) => { spawned.push({ e, a, o }); return { pid: 1, on() {}, unref() {} }; }, openExternal: (u) => opened.push(u), confirm: async (d) => { dialogs.push(d); return state.answer; } });
  return { ws, root, svc, spawned, opened, ud, cat, dialogs, state };
}
t("service: load builds baskets, launcher state, coming up, stats header; a missing catalogue is an empty state, not an error", async () => {
  const w = world([base({ id: "a", launch: { path: null } }), base({ id: "b", launch: { path: 5 } }), base({ id: "c", name: "C" })]);
  // the first two have invalid launch objects and are rejected; only c is valid
  let r = await w.svc.load(); assert.strictEqual(r.ok, true); assert.strictEqual(r.count, 1); assert.strictEqual(r.catalogue.rejected.length, 2); assert.deepStrictEqual(r.catalogue.rejected[0].fields, ["launch"]);
  assert.strictEqual(r.coming.total, 1); assert.strictEqual(r.groups[0].cards[0].start.state, "disabled");
  fs.rmSync(path.join(w.cat, "tools.json")); r = await w.svc.load(); assert.strictEqual(r.count, 0); assert.strictEqual(r.catalogue.file, "missing");
  fs.writeFileSync(path.join(w.cat, "tools.json"), "{broken"); r = await w.svc.load(); assert.strictEqual(r.catalogue.file, "unreadable");
});
t("service: start runs the catalogue's launcher through the allow-list; Agent Desktop is never launched; a double click is debounced; unknown ids refused", async () => {
  const lp = (f) => path.join(process.platform === "win32" ? "" : "", f);
  const w = world([]);
  const launch = { path: path.join(w.root, "ok.vbs"), args: [] };
  fs.writeFileSync(path.join(w.cat, "tools.json"), JSON.stringify({ schema: 1, tools: [base({ id: "a", launch }), base({ id: "ad", self: true, launch }), base({ id: "bad", launch: { path: "C:\\Windows\\notepad.exe" } })] }));
  await w.svc.load();
  assert.deepStrictEqual(await w.svc.start("a"), { ok: true }); assert.strictEqual(w.spawned.length, 1); assert.strictEqual(w.spawned[0].e, L.SYS.wscript());
  assert.match((await w.svc.start("a")).reason, /Just started/); assert.strictEqual(w.spawned.length, 1);
  assert.match((await w.svc.start("ad")).reason, /already running/); assert.strictEqual(w.spawned.length, 1);
  assert.match((await w.svc.start("bad")).reason, /outside the allowed/); assert.strictEqual(w.spawned.length, 1);
  assert.match((await w.svc.start("nope")).reason, /Unknown/); assert.match((await w.svc.start("")).reason, /Unknown/);
  void lp;
});
t("service: a tool already running (by its process hint) is not started again", async () => {
  const w = world([]);
  const procs = path.join(w.ws, "procs.json"); fs.writeFileSync(procs, JSON.stringify([{ name: "electron.exe", cmd: "C:\\a\\Demo\\app" }]));
  const svc = SV.createService({ workspaceRoot: w.ws, userData: w.ud, testMode: true, env: { AGENT_DESKTOP_TOOLS_DIR: w.cat, AGENT_DESKTOP_TOOLS_ROOTS: w.root, AGENT_DESKTOP_TOOLS_TEST_PROCS: procs }, log: () => {}, spawn: (e, a, o) => { w.spawned.push(e); return { pid: 1, on() {}, unref() {} }; } });
  fs.writeFileSync(path.join(w.cat, "tools.json"), JSON.stringify({ schema: 1, tools: [base({ id: "d", launch: { path: path.join(w.root, "ok.vbs") }, process: { name: "electron.exe", cmd: "demo\\app" } })] }));
  const r = await svc.load(); assert.strictEqual(r.groups[0].cards[0].start.state, "running");
  assert.match((await svc.start("d")).reason, /Already running/); assert.strictEqual(w.spawned.length, 0);
});
t("service: Refresh queries only public repos, writes tools_stats.json atomically, shows numbers; offline fixture keeps them; test mode never reaches GitHub on its own", async () => {
  const w = world([]);
  const fixture = path.join(w.ws, "net.json");
  fs.writeFileSync(fixture, JSON.stringify({ [API + "/repos/example-user/copier"]: { status: 200, headers: H(50, '"a"'), body: fx("github_repo.json") }, [API + "/repos/example-user/copier/releases?per_page=10"]: { status: 200, headers: H(49), body: fx("github_releases_two.json") } }));
  const mk = (env) => SV.createService({ workspaceRoot: w.ws, userData: w.ud, testMode: true, env: Object.assign({ AGENT_DESKTOP_TOOLS_DIR: w.cat, AGENT_DESKTOP_TOOLS_ROOTS: w.root }, env), log: () => {}, openExternal: (u) => w.opened.push(u) });
  fs.writeFileSync(path.join(w.cat, "tools.json"), JSON.stringify({ schema: 1, tools: [base({ id: "ar", visibility: "public", repo: "example-user/copier", release: { url: "https://github.com/example-user/copier/releases/tag/v1.2.0" } }), base({ id: "sg", visibility: "private", repo: "example-user/guidetool" })] }));
  const svc = mk({ AGENT_DESKTOP_TOOLS_TEST_FETCH: fixture });
  let r = await svc.refreshStats(); assert.strictEqual(r.summary.fetched, 1);
  assert.ok(fs.existsSync(path.join(w.ud, "tools_stats.json"))); assert.ok(!fs.readFileSync(path.join(w.ud, "tools_stats.json"), "utf8").includes("guidetool"), "private repo never queried or stored");
  const snap = await svc.load(), c = snap.groups[0].cards.find((x) => x.id === "ar");
  assert.strictEqual(c.stats.downloadsTotal, 150); assert.strictEqual(c.stats.releases[0].assets[0].downloads, 120); assert.strictEqual(snap.groups[0].cards.find((x) => x.id === "sg").stats, null);
  assert.strictEqual(snap.stats.callsLeft, 53);
  const off = path.join(w.ws, "off.json"); fs.writeFileSync(off, JSON.stringify({ __offline: true }));
  r = await mk({ AGENT_DESKTOP_TOOLS_TEST_FETCH: off }).refreshStats(); assert.strictEqual(r.summary.offline, true);
  assert.strictEqual((await svc.load()).groups[0].cards.find((x) => x.id === "ar").stats.downloadsTotal, 150, "still shows the saved numbers offline");
  r = await mk({}).refreshStats(); assert.strictEqual(r.summary.offline, true, "no fixture in test mode = offline, never GitHub");
  fs.writeFileSync(path.join(w.cat, "tools.json"), JSON.stringify({ schema: 1, tools: [base({ id: "p", visibility: "private", repo: "a/b" })] }));
  assert.strictEqual((await svc.refreshStats()).none, true);
});
t("service: openLink opens only the repo (or its releases / a release under it) of a PUBLIC tool, looked up by id", async () => {
  const w = world([]);
  fs.writeFileSync(path.join(w.cat, "tools.json"), JSON.stringify({ schema: 1, tools: [base({ id: "pub", visibility: "public", repo: "example-user/agent-desktop", release: { url: "https://github.com/example-user/agent-desktop/releases/tag/v1" } }), base({ id: "priv", visibility: "private", repo: "example-user/secret" }), base({ id: "evil", visibility: "public", repo: "example-user/x", release: { url: "https://evil.example/a" } })] }));
  await w.svc.load();
  assert.ok((await w.svc.openLink("pub", "repo")).ok); assert.ok((await w.svc.openLink("pub", "releases")).ok); assert.ok((await w.svc.openLink("pub", "release")).ok);
  assert.deepStrictEqual(w.opened, ["https://github.com/example-user/agent-desktop", "https://github.com/example-user/agent-desktop/releases", "https://github.com/example-user/agent-desktop/releases/tag/v1"]);
  w.opened.length = 0;
  assert.ok(!(await w.svc.openLink("priv", "repo")).ok); assert.ok(!(await w.svc.openLink("pub", "file:///c:/")).ok); assert.ok(!(await w.svc.openLink("nope", "repo")).ok);
  assert.ok(!(await w.svc.openLink("evil", "release")).ok, "a release url outside the repo is refused"); assert.deepStrictEqual(w.opened, []);
});

// ------------------------------------------------------------------ IPC wiring
t("ipc: only the main window's own frame may call; oversized argument refused; start receives only an id; a throwing handler is contained", async () => {
  const handlers = {}, logs = [];
  const wc = { mainFrame: {} }, win = { webContents: wc, isDestroyed: () => false };
  const w = world([base({ id: "a", launch: { path: path.join(os.tmpdir(), "x.vbs") } })]);
  MT.init({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, getMainWindow: () => win, userData: w.ud, workspaceRoot: w.ws, testMode: true, log: (l) => logs.push(l), env: { AGENT_DESKTOP_TOOLS_DIR: w.cat, AGENT_DESKTOP_TOOLS_ROOTS: w.root }, openExternal() {} });
  assert.deepStrictEqual(Object.keys(handlers).sort(), ["tools-load", "tools-open-link", "tools-prefs-get", "tools-prefs-set", "tools-refresh", "tools-start"]);
  const good = { sender: wc, senderFrame: wc.mainFrame };
  assert.strictEqual((await handlers["tools-load"](good)).ok, true);
  assert.strictEqual((await handlers["tools-load"]({ sender: {}, senderFrame: {} })).ok, false);
  assert.strictEqual((await handlers["tools-load"]({ sender: wc, senderFrame: {} })).ok, false, "a sub-frame is refused");
  assert.strictEqual((await handlers["tools-start"](good, { id: "x".repeat(5000) })).ok, false);
  assert.match((await handlers["tools-start"](good, { id: "../../evil", path: "C:\\x.exe", command: "calc" })).reason, /Unknown/, "path/command fields are ignored, id is only looked up");
  assert.ok(logs.some((l) => /refused/.test(l)));
});

// ------------------------------------------------------------------ privacy and lightness guards (static)
const files = () => fs.readdirSync(path.join(SRC, "tools")).map((f) => path.join(SRC, "tools", f)).concat(["tools.js", "tools-nav.js"].map((f) => path.join(SRC, "renderer", f)));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
t("guards: no console output, no shell execution, no eval, no clipboard/storage/title in the tools code", () => {
  for (const f of files()) {
    const s = strip(fs.readFileSync(f, "utf8")), name = path.basename(f);
    assert.ok(!/console\.(log|info|debug|warn|trace|dir|table)\s*\(/.test(s), "console output in " + name);
    for (const re of [/document\.title/, /clipboard/i, /localStorage/, /sessionStorage/, /indexedDB/, /\beval\s*\(/, /new Function/, /innerHTML/, /\.exec\s*\(\s*["'`]/, /execSync/, /shell:\s*true/, /crashReporter/]) assert.ok(!re.test(s), name + " matches " + re);
    if (name !== "launcher.js" && name !== "service.js") assert.ok(!/child_process/.test(s), name + " must not spawn");
  }
});
t("guards: only launcher.js spawns tools; service.js uses execFile (argument array) only for the process list; renderer never names a path or command", () => {
  const svc = strip(fs.readFileSync(path.join(SRC, "tools", "service.js"), "utf8"));
  assert.ok(!/\bspawn\s*\(/.test(svc.replace(/o\.spawn/g, "")) && /execFile\(/.test(svc) && !/\bexec\(/.test(svc));
  const la = strip(fs.readFileSync(path.join(SRC, "tools", "launcher.js"), "utf8"));
  assert.strictEqual((la.match(/\bsp\(/g) || []).length, 1, "one spawn call site"); assert.ok(/shell:\s*false/.test(la) && /detached:\s*true/.test(la) && /windowsHide:\s*true/.test(la));
  const pre = fs.readFileSync(path.join(SRC, "preload.js"), "utf8"), blk = pre.slice(pre.indexOf("tools: {"), pre.indexOf("tools: {") + 500);
  assert.ok(/start: \(id\)/.test(blk) && !/path|command/.test(blk.split("// v1.72.0")[0]), "preload.tools.start takes an id only");
});
t("guards: lightness - no setInterval/observers, view code and css load lazily, only the nav runs at startup, one lazy require in main.js", () => {
  for (const f of files()) { const s = strip(fs.readFileSync(f, "utf8")); assert.ok(!/setInterval|requestAnimationFrame|MutationObserver|IntersectionObserver/.test(s), path.basename(f)); }
  const view = strip(fs.readFileSync(path.join(SRC, "renderer", "tools.js"), "utf8"));
  assert.ok((view.match(/setTimeout/g) || []).length <= 3, "toast fade, one re-check after Start, one Library tab hop");
  const html = fs.readFileSync(path.join(SRC, "renderer", "index.html"), "utf8");
  assert.ok(html.includes("tools-nav.js") && html.includes("styles-tools-nav.css")); assert.ok(!/"tools\.js"/.test(html) && !html.includes("styles-tools.css"));
  const main = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
  assert.strictEqual((main.match(/require\("\.\/tools\//g) || []).length, 1);
  for (const f of ["registry.js", "daily/main-daily.js", "archive.js"]) assert.ok(!/tools\/(service|launcher|stats)/.test(fs.readFileSync(path.join(SRC, f), "utf8")));
});
t("guards: styling is tokens - styles-tools.css defines --tl-* tokens and the render functions are named", () => {
  const css = fs.readFileSync(path.join(SRC, "renderer", "styles-tools.css"), "utf8");
  assert.ok(/:root\s*\{[^}]*--tl-card-min/.test(css) && /--tl-ok/.test(css));
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css.replace(/#tools-view|#26241f|#fff(?![0-9a-fA-F])/g, "")), "no literal colours outside the toast");
  const js = fs.readFileSync(path.join(SRC, "renderer", "tools.js"), "utf8");
  for (const fn of ["renderHeader", "renderBasket", "renderCard", "renderChip", "renderDots", "renderStats", "renderDrawer", "renderComingUp", "renderEmpty"]) assert.ok(new RegExp("function " + fn + "\\(").test(js), fn);
});
t("leftpane: a tile with data-system-nav=tools replaces the dim soon tile", () => {
  const LP = require("../src/leftpane");
  const tiles = LP.planTiles(["argus"], ["health", "tools"]);
  assert.strictEqual(tiles.find((x) => x.id === "tools").kind, "live"); assert.ok(!tiles.some((x) => x.id === "tools" && x.kind === "soon"));
});

(async () => {
  for (const q of queue) {
    n++;
    try { await q.fn(); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); }
  }
  console.log(fails ? fails + " of " + n + " FAILED" : "tools: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
