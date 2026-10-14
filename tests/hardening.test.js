// node tests/hardening.test.js - hardening of the configuration layer (v1.121.0, review round): PATH-lookup speed, executable / role key validation,
// consent file merge + deploy tool, claudeIntegration grandfather rule, atomic settings.json edits, feature states, health marker retry,
// create-folders guard, test-mode isolation, launchEnv caching, parity dedupe. Temp folders and fakes only: no D: / E: paths.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), vm = require("vm");
const { createAppConfig, KEYS } = require("../src/appConfig");
const features = require("../src/features");
const setupMain = require("../src/setupMain");

let n = 0, fails = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adhard-"));
let seq = 0;
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const fresh = (tag) => mk((tag || "d") + (++seq));
const touch = (f, txt) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt === undefined ? "x" : txt); return f; };
const W = path.win32;
const WIN = process.platform === "win32";
const exe = (n2) => (WIN ? n2 + ".exe" : n2);
const quiet = (fn) => { const l = console.log, e = console.error; const out = []; console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => out.push(a.join(" ")); try { return { r: fn(), out }; } finally { console.log = l; console.error = e; } };
const withCfg = (values, env, extra) => {
  const ud = fresh("ud"); if (values) fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify(Object.assign({ schema: 1, values, features: {} }, extra || {})));
  const c = createAppConfig({ userDataDir: ud, env: env || {} }); c.setRegistry(features); c.__ud = ud; return c;
};
// a fake Windows config object: Windows path rules on any host
const winCfg = (values, env) => createAppConfig({ env: env || {}, platform: "win32", pathMod: W, initialDoc: { values: values || {}, features: {} } });

// ============================================================ 1 PERF
t("1 perf: with 40 PATH folders getAll < 300 ms, the second call is near-instant, and a PATH hit is remembered per name", async () => {
  const dirs = []; for (let i = 0; i < 40; i++) dirs.push(mk("path" + i));
  touch(path.join(dirs[39], exe("python"))); touch(path.join(dirs[38], exe("git"))); touch(path.join(dirs[37], exe("node")));
  const env = { PATH: dirs.join(path.delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC" };
  const ud = fresh("ud"); const c = createAppConfig({ userDataDir: ud, env }); c.setRegistry(features);
  c.setProbe("claudeCode", () => false); // (the real probe may start a process; this test measures the PATH lookup)
  const handlers = {}; const win = { webContents: {}, isDestroyed: () => false };
  setupMain.register({ ipcMain: { handle: (ch, f) => { handlers[ch] = f; } }, dialog: {}, cfg: c, features, getMainWindow: () => win, isTestMode: () => false, env: {} });
  const ev = { sender: win.webContents };
  let t0 = process.hrtime.bigint(); const a = await handlers["config-get-all"](ev); const ms1 = Number(process.hrtime.bigint() - t0) / 1e6;
  t0 = process.hrtime.bigint(); const b = await handlers["config-get-all"](ev); const ms2 = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log("     getAll with 40 PATH folders: first " + ms1.toFixed(1) + " ms, second " + ms2.toFixed(1) + " ms");
  assert.ok(a.ok && b.ok); assert.ok(ms1 < 300, "first getAll " + ms1); assert.ok(ms2 < 50, "second getAll " + ms2);
  assert.strictEqual(a.values.pythonExe, path.join(dirs[39], exe("python")));
  assert.strictEqual(c.source("pythonExe"), "auto");
  t0 = process.hrtime.bigint(); for (let i = 0; i < 200; i++) c.get("pythonExe"); const per = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  assert.ok(per < 1, "cfg.get('pythonExe') costs " + per + " ms per call");
});
t("1 perf: the PATH memory lives 60 s and is dropped on a configuration change or reload", () => {
  const d1 = mk("pm1"), d2 = mk("pm2"); let clock = 1000;
  const env = { PATH: d1 + path.delimiter + d2, PATHEXT: ".EXE" };
  const c = createAppConfig({ userDataDir: fresh("ud"), env, now: () => clock }); c.setRegistry(features);
  assert.strictEqual(c.get("pythonExe"), null);
  touch(path.join(d2, exe("python")));
  assert.strictEqual(c.get("pythonExe"), null, "remembered (not found) inside the 60 s");
  clock += 59000; assert.strictEqual(c.get("pythonExe"), null);
  clock += 2000; assert.strictEqual(c.get("pythonExe"), path.join(d2, exe("python")), "found after the memory expired");
  const d3 = mk("pm3"); const env3 = { PATH: d3, PATHEXT: ".EXE" }; const c3 = createAppConfig({ userDataDir: fresh("ud"), env: env3, now: () => clock }); c3.setRegistry(features);
  assert.strictEqual(c3.get("gitExe"), null); touch(path.join(d3, exe("git")));
  assert.strictEqual(c3.get("gitExe"), null); c3.reload(); assert.strictEqual(c3.get("gitExe"), path.join(d3, exe("git")), "reload forgets");
  const d4 = mk("pm4"); const c4 = createAppConfig({ userDataDir: fresh("ud"), env: { PATH: d4, PATHEXT: ".EXE" }, now: () => clock }); c4.setRegistry(features);
  assert.strictEqual(c4.get("nodeExe"), null); touch(path.join(d4, exe("node"))); assert.strictEqual(c4.get("nodeExe"), null);
  assert.strictEqual(c4.set("ownerName", "Ana").ok, true); assert.strictEqual(c4.get("nodeExe"), path.join(d4, exe("node")), "a change forgets");
});
t("1 perf: the PATH value is part of the memory key (a different PATH is a different answer)", () => {
  const d1 = mk("pk1"), d2 = mk("pk2"); touch(path.join(d2, exe("python")));
  const env = { PATH: d1, PATHEXT: ".EXE" }; const c = createAppConfig({ userDataDir: fresh("ud"), env }); c.setRegistry(features);
  assert.strictEqual(c.get("pythonExe"), null); env.PATH = d2; assert.strictEqual(c.get("pythonExe"), path.join(d2, exe("python")));
});
t("1 perf: snapshot() resolves each key once (a counting fs shows no repeated stat of the same file)", () => {
  const d1 = mk("ps1"); touch(path.join(d1, exe("python")));
  const counts = new Map(); const real = fs;
  const cfs = Object.assign({}, real, { statSync: (p, ...r) => { counts.set(p, (counts.get(p) || 0) + 1); return real.statSync(p, ...r); } });
  const c = createAppConfig({ userDataDir: fresh("ud"), env: { PATH: d1, PATHEXT: ".EXE" }, fs: cfs }); c.setRegistry(features);
  c.snapshot(() => { for (let i = 0; i < 5; i++) { c.get("pythonExe"); c.source("pythonExe"); c.usable("pythonExe"); c.feature("pcHealth"); } });
  const py = path.join(d1, exe("python"));
  assert.ok((counts.get(py) || 0) <= 2, "stat of python: " + counts.get(py));
});
t("1 perf: AppCfg reads after first paint and when idle (light getValues), never before; an early refresh still answers", async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "app-cfg.js"), "utf8");
  const timers = [], raf = [], idle = []; let calls = 0, valCalls = 0;
  const win = { setTimeout: (f) => { timers.push(f); return 1; }, requestAnimationFrame: (f) => { raf.push(f); return 1; }, requestIdleCallback: (f) => { idle.push(f); return 1; },
    api: { config: { getValues: () => { valCalls++; return Promise.resolve({ ok: true, values: { ownerName: "Ana" } }); }, getAll: () => { calls++; return Promise.resolve({ ok: true, values: {} }); } } } };
  const ctx = { window: win, Promise }; vm.createContext(ctx); vm.runInContext(src, ctx);
  assert.strictEqual(valCalls + calls, 0, "nothing is read while the page loads");
  assert.strictEqual(win.AppCfg.isLoaded(), false);
  raf.shift()(); raf.length && raf.shift()();       // the page painted twice
  assert.strictEqual(valCalls, 0, "still waiting for idle");
  idle.shift()(); await win.AppCfg.ready;
  assert.strictEqual(valCalls, 1); assert.strictEqual(calls, 0, "the heavy getAll is not used"); assert.strictEqual(win.AppCfg.owner(), "Ana");
  // the timer path (a hidden window never paints) also starts the read, once
  const win2 = Object.assign({}, win, { requestAnimationFrame: () => 1 }); let v2 = 0; const t2 = [], i2 = [];
  win2.setTimeout = (f) => { t2.push(f); return 1; }; win2.requestIdleCallback = (f) => { i2.push(f); return 1; };
  win2.api = { config: { getValues: () => { v2++; return Promise.resolve({ ok: true, values: { ownerName: "Bo" } }); } } };
  const ctx2 = { window: win2, Promise }; vm.createContext(ctx2); vm.runInContext(src, ctx2);
  t2.shift()(); i2.shift()(); await win2.AppCfg.ready; assert.strictEqual(v2, 1); assert.strictEqual(win2.AppCfg.owner(), "Bo");
  // refresh before the first read answers the first wait too
  const win3 = { setTimeout: () => 1, requestIdleCallback: () => 1, api: { config: { getValues: () => Promise.resolve({ ok: true, values: { ownerName: "Cy" } }) } } };
  const ctx3 = { window: win3, Promise }; vm.createContext(ctx3); vm.runInContext(src, ctx3);
  const first = win3.AppCfg.ready; await win3.AppCfg.refresh(); await first; assert.strictEqual(win3.AppCfg.owner(), "Cy");
});
t("1 perf: setup.js starts its first read from requestIdleCallback; preload exposes getValues; main answers config-get-values", () => {
  const rd = (...p) => fs.readFileSync(path.join(__dirname, "..", "src", ...p), "utf8");
  assert.ok(/requestIdleCallback\(startRead/.test(rd("renderer", "setup.js")));
  assert.ok(/getValues: \(\) => ipcRenderer\.invoke\("config-get-values"\)/.test(rd("preload.js")));
  assert.ok(/"config-get-values"/.test(rd("setupMain.js")));
});

// ============================================================ 2 SECURITY
t("2 security: executable keys must be .exe/.cmd/.bat, never UNC or device paths; scripts must be .py (Windows rules)", () => {
  const ok = (k, v) => assert.strictEqual(winCfg({ [k]: v }).get(k), v, k + " " + v);
  const no = (k, v) => assert.strictEqual(winCfg({ [k]: v }).get(k), null, k + " " + v);
  for (const k of ["pythonExe", "claudeExe", "nodeExe", "gitExe", "whisperExe"]) {
    ok(k, "C:\\Tools\\prog.exe"); ok(k, "C:\\Tools\\prog.CMD"); ok(k, "D:\\x y\\prog.bat");
    no(k, "C:\\Tools\\prog.txt"); no(k, "C:\\Tools\\prog.ps1"); no(k, "C:\\Tools\\prog"); no(k, "C:\\Tools\\prog.exe.txt");
    no(k, "\\\\server\\share\\prog.exe"); no(k, "//server/share/prog.exe"); no(k, "\\\\?\\C:\\Tools\\prog.exe"); no(k, "\\\\.\\pipe\\x.exe");
    no(k, "C:\\Tools\\CON.exe"); no(k, "C:\\Tools\\..\\prog.exe"); no(k, "prog.exe"); no(k, "C:\\NUL\\prog.exe");
  }
  for (const k of ["tasksTool", "pcHealthScript", "argusBuilder", "registryTool"]) {
    ok(k, "C:\\Tools\\s.py"); no(k, "C:\\Tools\\s.exe"); no(k, "C:\\Tools\\s.ps1"); no(k, "\\\\srv\\sh\\s.py"); no(k, "\\\\?\\C:\\s.py");
  }
});
t("2 security: the environment override gets the same validation (a bad one is ignored, not used)", () => {
  const c = winCfg({}, { AGENT_DESKTOP_PYTHON_EXE: "\\\\evil\\share\\python.exe", AGENT_DESKTOP_TASKS_TOOL: "C:\\x\\t.exe", AGENT_DESKTOP_ROLE_COO: "..\\x" });
  assert.strictEqual(c.get("pythonExe"), null); assert.strictEqual(c.get("tasksTool"), null); assert.strictEqual(c.get("roleCoo"), null);
  const g = winCfg({}, { AGENT_DESKTOP_PYTHON_EXE: "C:\\ok\\python.exe", AGENT_DESKTOP_ROLE_COO: "Chief Agent" });
  assert.strictEqual(g.get("pythonExe"), "C:\\ok\\python.exe"); assert.strictEqual(g.source("pythonExe"), "env"); assert.strictEqual(g.get("roleCoo"), "Chief Agent");
});
t("2 security: set() / setMany refuse the same values", () => {
  const dir = mk("sec1"); const py = touch(path.join(dir, exe("python"))); const txt = touch(path.join(dir, "python.txt"));
  const c = withCfg({}, {});
  assert.strictEqual(c.set("pythonExe", py).ok, true);
  assert.strictEqual(c.set("pythonExe", txt).error, "invalid-value");
  assert.strictEqual(c.set("roleSecurity", "..\\x").error, "invalid-value");
  assert.strictEqual(c.set("exchangeInboxName", "a/b").error, "invalid-value");
  assert.strictEqual(c.set("roleOptimization", "Opt*").ok, true);
});
t("2 security: role and mailbox names are ONE path segment (no \\ / : .. drive letters); a trailing * only for roles", () => {
  const c = withCfg({}, {});
  for (const k of ["roleCoo", "roleSecurity", "roleOptimization", "roleSeo"]) {
    for (const good of ["COO Agent", "Optimization*", "A", "x-y_z", "Agent 2"]) assert.strictEqual(c.clean(k, good), good, k + " " + good);
    for (const bad of ["a\\b", "a/b", "C:", "C:\\Agents", "..", "x..y", "*", "a*b", "*a", "a?", "a|b", "<a>", "../x", " ", ".", "name.", "x\0y"]) assert.strictEqual(c.clean(k, bad), null, k + " " + JSON.stringify(bad));
  }
  for (const k of ["exchangeInboxName", "exchangeOutboxName"]) {
    for (const good of ["to_me", "from me", "In-Box"]) assert.strictEqual(c.clean(k, good), good);
    for (const bad of ["to*", "..\\x", "a/b", "C:x", "a:b", "..", "x..", "", "con?"]) assert.strictEqual(c.clean(k, bad), null, k + " " + bad);
  }
  assert.strictEqual(c.clean("ownerName", "A. B / C"), "A. B / C", "free text keys are unchanged");
});
t("2 security (use time): wake-agent callerForSessionCwd and fleetMailbox.writeReply re-check the names", () => {
  const ac = require("../src/appConfig"); const real = ac.get;
  const wake = require("../src/wakeAgentMain");
  const ws = mk("wk"); const good = mk("wk", "Chief Agent"); mk("wk", "Chief Agent", "sess");
  try {
    ac.get = (k) => (k === "roleCoo" ? "Chief Agent" : null);
    assert.strictEqual(wake.callerForSessionCwd(ws, path.join(good, "sess")), "coo");
    for (const bad of ["..\\Chief Agent", "../wk/Chief Agent", "C:\\wk\\Chief Agent", "Chief Agent\\sub", "a/b", ".."]) {
      ac.get = (k) => (k === "roleCoo" ? bad : null);
      assert.strictEqual(wake.callerFolders().coo, null, "callerFolders " + bad);
      assert.strictEqual(wake.callerForSessionCwd(ws, path.join(good, "sess")), null, "callerForSessionCwd " + bad);
    }
  } finally { ac.get = real; }
  const fm = require("../src/fleetMailbox"); const before = fm.settings();
  fm.configure({ inbox: "..\\in", outbox: "a/b" }); assert.strictEqual(fm.settings().inbox, before.inbox); assert.strictEqual(fm.settings().outbox, before.outbox);
  const root = mk("mb"); mk("mb", "outgoing");
  fm.configure({ outbox: "outgoing" });
  const r = fm.writeReply(root, { text: "hello", recipient: "x", topic: "t" }); assert.strictEqual(r.ok, true); assert.ok(fs.existsSync(path.join(root, "outgoing", r.name)));
  const saved = fm.SIDES.owner; try {
    fm.SIDES.owner = "..\\escape"; mk("escape");
    assert.strictEqual(fm.writeReply(root, { text: "hello" }).ok, false, "a tampered side name is refused at use time");
    fm.SIDES.owner = "C:\\x"; assert.strictEqual(fm.writeReply(root, { text: "hello" }).ok, false);
  } finally { fm.SIDES.owner = saved; fm.configure({ outbox: before.outbox }); }
});

t("3 consent: SETUP.md says consent is an honour-system record", () => {
  const md = fs.readFileSync(path.join(__dirname, "..", "SETUP.md"), "utf8");
  assert.ok(/honou?r/i.test(md) && /consent/i.test(md));
});

// ============================================================ 4 + 5 settings.json
const CS = require("../src/claudeSettings");
const home = () => { const h = fresh("home"); mk(path.basename(h), ".claude"); return h; };
const settingsOf = (h) => path.join(h, ".claude", "settings.json");
const script = path.join(tmp, "app", "src", "statusline.cjs");
const fakeNode = touch(path.join(tmp, "nodebin", exe("node")));
const cs = (h, o) => CS.createClaudeSettings(Object.assign({ home: h, scriptPath: script, findNode: () => fakeNode }, o || {}));
const consentCfg = (extra) => withCfg({}, {}, extra);
const ourLine = () => ({ type: "command", command: '"' + fakeNode + '" "' + script + '"', refreshInterval: 60 });
t("4 grandfather: our status line in settings.json and no section -> consent 'existing-install', once", () => {
  const h = home(); fs.writeFileSync(settingsOf(h), JSON.stringify({ statusLine: ourLine(), other: 1 }));
  const c = consentCfg(); assert.strictEqual(c.isConsented("claudeIntegration"), false);
  const g = cs(h).grandfather(c);
  assert.strictEqual(g.granted, true); assert.strictEqual(c.isConsented("claudeIntegration"), true); assert.strictEqual(c.consentState("claudeIntegration").source, "existing-install");
  c.revokeConsent("claudeIntegration"); assert.strictEqual(cs(h).grandfather(c).granted, false, "a section now exists (revoked): never granted again");
  assert.strictEqual(c.isConsented("claudeIntegration"), false);
});
t("4 grandfather: remoteControlAtStartup:true alone -> granted; false, absent, a foreign status line -> not granted", () => {
  const h = home(); fs.writeFileSync(settingsOf(h), JSON.stringify({ remoteControlAtStartup: true }));
  const c = consentCfg(); assert.strictEqual(cs(h).grandfather(c).granted, true); assert.strictEqual(c.consentState("claudeIntegration").source, "existing-install");
  for (const body of [{ remoteControlAtStartup: false }, {}, { statusLine: { type: "command", command: "someone-elses-script" } }]) {
    const h2 = home(); fs.writeFileSync(settingsOf(h2), JSON.stringify(body)); const c2 = consentCfg();
    assert.strictEqual(cs(h2).grandfather(c2).granted, false, JSON.stringify(body)); assert.strictEqual(c2.isConsented("claudeIntegration"), false);
  }
  const h3 = home(); const c3 = consentCfg(); assert.strictEqual(cs(h3).grandfather(c3).granted, false, "no settings file at all");
});
t("4 grandfather: fails closed on a parse error (consent not written, file untouched), and with an existing consent section", () => {
  const h = home(); fs.writeFileSync(settingsOf(h), "{ remoteControlAtStartup: true "); const c = consentCfg();
  assert.strictEqual(cs(h).grandfather(c).granted, false); assert.strictEqual(c.hasSection("claudeIntegration"), false);
  assert.strictEqual(fs.readFileSync(settingsOf(h), "utf8"), "{ remoteControlAtStartup: true ");
  const h2 = home(); fs.writeFileSync(settingsOf(h2), JSON.stringify([1, 2])); assert.strictEqual(cs(h2).grandfather(consentCfg()).granted, false, "an array is not a settings object");
  const h3 = home(); fs.writeFileSync(settingsOf(h3), JSON.stringify({ remoteControlAtStartup: true }));
  const c3 = consentCfg({ claudeIntegration: { enabled: false } }); assert.strictEqual(cs(h3).grandfather(c3).granted, false, "the person said off"); assert.strictEqual(c3.isConsented("claudeIntegration"), false);
});
t("4 grandfather: a BOM in the file does not break the rule; the consent source is a known one", () => {
  const h = home(); fs.writeFileSync(settingsOf(h), "\uFEFF" + JSON.stringify({ statusLine: ourLine() })); const c = consentCfg();
  assert.strictEqual(cs(h).grandfather(c).granted, true);
  assert.strictEqual(c.grantConsent("claudeIntegration", "made-up").error, "invalid-source");
});
t("5 settings.json: written atomically (temp file + rename), other fields kept, one-time backup that is never overwritten", () => {
  const h = home(); const orig = JSON.stringify({ theme: "dark", permissions: { allow: ["x"] } }, null, 4);
  fs.writeFileSync(settingsOf(h), orig);
  const s = cs(h);
  assert.strictEqual(s.ensureStatusLine().changed, true);
  const a = JSON.parse(fs.readFileSync(settingsOf(h), "utf8")); assert.strictEqual(a.theme, "dark"); assert.deepStrictEqual(a.statusLine, ourLine());
  assert.strictEqual(fs.readFileSync(s.backupPath, "utf8"), orig, "backup = the original, byte for byte");
  assert.strictEqual(s.ensureRemoteControl().changed, true);
  const b = JSON.parse(fs.readFileSync(settingsOf(h), "utf8")); assert.strictEqual(b.remoteControlAtStartup, true);
  assert.strictEqual(fs.readFileSync(s.backupPath, "utf8"), orig, "the backup is not overwritten by the second change");
  assert.deepStrictEqual(fs.readdirSync(path.join(h, ".claude")).filter((x) => /\.tmp$/.test(x)), [], "no temp file left");
  assert.strictEqual(s.ensureStatusLine().changed, false); assert.strictEqual(s.ensureRemoteControl().changed, false);
  const h2 = home(); fs.writeFileSync(settingsOf(h2), orig); fs.writeFileSync(path.join(h2, ".claude", CS.BACKUP_NAME), "mine");
  cs(h2).ensureStatusLine(); assert.strictEqual(fs.readFileSync(path.join(h2, ".claude", CS.BACKUP_NAME), "utf8"), "mine", "an existing .bak is never overwritten");
});
t("5 settings.json: a failed write leaves the old file and no temp file; foreign status line, explicit remote-control choice and bad JSON are left alone", () => {
  const h = home(); const orig = JSON.stringify({ keep: 1 });
  fs.writeFileSync(settingsOf(h), orig);
  const failing = Object.assign({}, fs, { renameSync: () => { throw new Error("EPERM simulated"); } });
  const s = cs(h, { fs: failing });
  assert.strictEqual(s.ensureStatusLine().changed, false);
  assert.strictEqual(fs.readFileSync(settingsOf(h), "utf8"), orig, "old file intact");
  assert.deepStrictEqual(fs.readdirSync(path.join(h, ".claude")).filter((x) => /\.tmp$/.test(x)), []);
  const h2 = home(); const foreign = JSON.stringify({ statusLine: { type: "command", command: "mine" }, remoteControlAtStartup: false });
  fs.writeFileSync(settingsOf(h2), foreign); const s2 = cs(h2);
  assert.strictEqual(s2.ensureStatusLine().reason, "other-statusline"); assert.strictEqual(s2.ensureRemoteControl().reason, "already-chosen");
  assert.strictEqual(fs.readFileSync(settingsOf(h2), "utf8"), foreign); assert.ok(!fs.existsSync(s2.backupPath), "no change = no backup");
  const h3 = home(); fs.writeFileSync(settingsOf(h3), "{ bad"); const s3 = cs(h3);
  assert.strictEqual(s3.ensureStatusLine().reason, "error"); assert.strictEqual(s3.ensureRemoteControl().reason, "error"); assert.strictEqual(fs.readFileSync(settingsOf(h3), "utf8"), "{ bad");
  const h4 = home(); fs.writeFileSync(settingsOf(h4), "{}"); assert.strictEqual(cs(h4, { findNode: () => null }).ensureStatusLine().reason, "no-node"); assert.strictEqual(fs.readFileSync(settingsOf(h4), "utf8"), "{}");
});
t("5 settings.json: a BOM is stripped (Claude Code ignored such a file) and the old status line of ours is upgraded", () => {
  const h = home(); fs.writeFileSync(settingsOf(h), "\uFEFF" + JSON.stringify({ statusLine: { type: "command", command: '"' + fakeNode + '" "' + script + '"' }, a: 1 }));
  assert.strictEqual(cs(h).ensureStatusLine().changed, true);
  const raw = fs.readFileSync(settingsOf(h), "utf8"); assert.notStrictEqual(raw.charCodeAt(0), 0xfeff); assert.strictEqual(JSON.parse(raw).statusLine.refreshInterval, 60); assert.strictEqual(JSON.parse(raw).a, 1);
});
t("4/5 main.js delegates to claudeSettings and runs the grandfather rule before the consent check", () => {
  const m = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.ok(/require\("\.\/claudeSettings"\)/.test(m)); assert.ok(!/fs\.writeFileSync\(settingsPath/.test(m), "no direct settings.json write left in main.js");
  assert.ok(m.indexOf(".grandfather(") > 0 && m.indexOf(".grandfather(") < m.indexOf("claudeIntegrationAllowed())"));
});

// ============================================================ 6 features
t("6 features: library needs only the workspace (no unused registryTool) and is ready once it is set", () => {
  const f = features.get("library"); assert.deepStrictEqual(f.requires, ["workspaceRoot"]); assert.ok(!f.steps.some((s) => s.key === "registryTool"));
  const ws = mk("lib"); const c = withCfg({ workspaceRoot: ws }, {});
  assert.strictEqual(c.feature("library").state, "ready");
  assert.strictEqual(withCfg({}, {}).feature("library").state, "needs-setup");
});
t("6 features: claudeCode is ready when launchEnv finds claude (native / package / npm), not only when PATH did", () => {
  const f = features.get("claudeCode"); assert.strictEqual(typeof f.probe, "function");
  const c = withCfg({}, { AGENT_DESKTOP_CLAUDE_EXE: "" }); assert.strictEqual(c.get("claudeExe") === null || typeof c.get("claudeExe") === "string", true);
  let found = false; c.setProbe("claudeCode", () => found);
  const before = c.feature("claudeCode"); if (c.get("claudeExe") === null) assert.strictEqual(before.state, "needs-setup");
  found = true; assert.strictEqual(c.feature("claudeCode").state, "ready", "found through another place = ready even with no PATH-derived claudeExe");
  found = false; if (c.get("claudeExe") === null) assert.strictEqual(c.feature("claudeCode").state, "needs-setup");
  c.setProbe("claudeCode", () => { throw new Error("boom"); }); assert.ok(["needs-setup", "ready"].includes(c.feature("claudeCode").state), "a throwing probe never throws out");
  // the default probe uses launchEnv with the person's own setting
  const dir = mk("cc"); const cl = touch(path.join(dir, WIN ? "claude.cmd" : "claude"));
  const c2 = withCfg({ claudeExe: cl }, {}); assert.strictEqual(f.probe(c2), true); assert.strictEqual(c2.feature("claudeCode").state, "ready");
  assert.ok(/launchEnv/.test(fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8").split("setProbe(\"claudeCode\"")[1].slice(0, 300)), "main registers the full probe");
});

// ============================================================ 7 health
t("7 health: a vault made by Setup whose marker write failed is healed on the next start; any content or env override keeps it refused; message has no Security", () => {
  const SV = require("../src/health/service"); const roots = require("../src/health/roots");
  const parent = mk("hp1"); mk("hp1", "vault");
  assert.strictEqual(roots.resolveRoot({ env: {}, testMode: false, parent }).code, "marker");
  assert.ok(!/Security/.test(roots.resolveRoot({ env: {}, testMode: false, parent }).reason), "no 'Security creates it'");
  const svc = SV.createService({ env: {}, testMode: false, userData: fresh("ud"), parent });
  assert.ok(fs.existsSync(path.join(parent, "vault", ".health-root")), "marker written on retry"); assert.notStrictEqual(svc.root, null);
  const p2 = mk("hp2"); mk("hp2", "vault", "extracted"); SV.createService({ env: {}, testMode: false, userData: fresh("ud"), parent: p2 });
  assert.ok(!fs.existsSync(path.join(p2, "vault", ".health-root")), "a vault with content is never touched");
  const p3 = mk("hp3"); mk("hp3", "vault"); const s3 = SV.createService({ env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(p3, "vault", "x") }, testMode: false, userData: fresh("ud"), parent: p3 });
  assert.ok(!fs.existsSync(path.join(p3, "vault", ".health-root")), "an environment-chosen root is not healed"); assert.strictEqual(s3.root, null);
});
t("7 health: if the marker write fails right after mkdir(vault), the empty vault is removed so the next start is clean", () => {
  const SV = require("../src/health/service"); const parent = mk("hp4");
  const real = fs.writeFileSync; let armed = true;
  fs.writeFileSync = function (p, ...r) { if (armed && String(p).endsWith(".health-root")) { armed = false; throw new Error("disk full simulated"); } return real.call(this, p, ...r); };
  try { SV.createService({ env: {}, testMode: false, userData: fresh("ud"), parent }); } finally { fs.writeFileSync = real; }
  assert.ok(!fs.existsSync(path.join(parent, "vault")), "no half-made vault left");
  SV.createService({ env: {}, testMode: false, userData: fresh("ud"), parent }); assert.ok(fs.existsSync(path.join(parent, "vault", ".health-root")), "the next start works");
});

// ============================================================ 8 create-folders guard
t("8 create-folders: the workspace comes from the saved config only; UNC / traversal refused; set-feature create applies the same inside-workspace rule", async () => {
  const handlers = {}; const win = { webContents: {}, isDestroyed: () => false };
  const c = withCfg({}, {}); setupMain.register({ ipcMain: { handle: (ch, f) => { handlers[ch] = f; } }, dialog: {}, cfg: c, features, getMainWindow: () => win, isTestMode: () => false, env: {} });
  const ev = { sender: win.webContents }; const cf = (featureId, values) => handlers["config-create-folders"](ev, { featureId, values });
  const ws = path.join(tmp, "wsg"), other = path.join(tmp, "otherg");
  // nothing saved yet: a renderer-supplied workspace does not make other folders legal
  let r = await cf("argus", { workspaceRoot: ws, sharedReports: path.join(other, "x") }); assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.created, [ws], "only the workspace itself; the rest waits for the save");
  assert.ok(!fs.existsSync(path.join(other, "x")));
  r = await handlers["config-set-feature"](ev, { featureId: "argus", values: { workspaceRoot: ws, sharedReports: path.join(other, "x") }, create: true });
  assert.strictEqual(r.error, "outside-workspace"); assert.ok(!fs.existsSync(path.join(other, "x")), "set-feature create refuses it too");
  r = await handlers["config-set-feature"](ev, { featureId: "argus", values: { workspaceRoot: ws, sharedReports: path.join(ws, "shared_reports") }, create: true });
  assert.strictEqual(r.ok, true); assert.ok(fs.statSync(path.join(ws, "shared_reports")).isDirectory());
  // now saved: the saved root decides, whatever the renderer sends
  r = await cf("argus", { workspaceRoot: other, sharedReports: path.join(other, "x") }); assert.strictEqual(r.error, "outside-workspace"); assert.ok(!fs.existsSync(path.join(other, "x")));
  assert.strictEqual((await cf("argus", { sharedReports: "\\\\server\\share\\x" })).error, "invalid-value");
  assert.strictEqual((await cf("argus", { sharedReports: "//server/share/x" })).error, "invalid-value");
  assert.strictEqual((await cf("argus", { sharedReports: ws + path.sep + ".." + path.sep + "y" })).error, "invalid-value");
  assert.strictEqual((await cf("argus", { sharedReports: path.join(ws, "shared_reports", "deeper") })).ok, true);
  // appConfig itself
  assert.strictEqual(c.set("tasksDir", path.join(other, "t"), { create: true }).error, "outside-workspace");
  assert.strictEqual(c.set("tasksDir", path.join(ws, "t"), { create: true }).ok, true);
  if (WIN) assert.strictEqual(c.set("exchangeDir", "\\\\srv\\share\\x", { create: true }).ok, false, "never create a folder on a network share");
  if (WIN) assert.strictEqual(c.set("tasksDir", ws.toUpperCase() + "\\t2", { create: true }).ok, true, "inside check ignores case on Windows");
  assert.strictEqual(c.set("healthParent", path.join(other, "h"), { create: true }).ok, true, "the app's own folders (autoCreate) are exempt, as before");
});

// ============================================================ 9 test-mode isolation
t("9 testGuard: in test mode usageNowPath is null unless AGENT_DESKTOP_THROTTLE_FILE is set; a sandbox config cannot read live folders unless allowed", () => {
  const ac = require("../src/appConfig"); const tg = require("../src/testGuard");
  const live = path.parse(os.tmpdir()).root + "ad-live-fixture-never-created" + path.sep + "reports";
  const sandbox = mk("sbx"); const inside = mk("sbx", "mine");
  const ud = fresh("ud"); fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify({ schema: 1, values: { workspaceRoot: path.dirname(live), sharedReports: live, sharedTools: inside, usageNowFile: path.join(path.dirname(live), "usage_now.json") } }));
  ac.init({ userDataDir: ud, env: {} });
  const E = { AGENT_DESKTOP_TEST_MODE: "1", AGENT_DESKTOP_ROOT: sandbox };
  assert.strictEqual(tg.usageNowPath(E), null, "no live usage file in a sandbox");
  assert.strictEqual(tg.usageNowPath(Object.assign({ AGENT_DESKTOP_THROTTLE_FILE: "X:\\t.json" }, E)), "X:\\t.json");
  assert.strictEqual(tg.workspaceDir("sharedReports", E), path.join(sandbox, "shared_reports"), "a config value outside the sandbox is not used");
  assert.strictEqual(tg.workspaceDir("sharedTools", E), inside, "a config value inside the sandbox is used");
  assert.strictEqual(tg.workspaceDir("sharedReports", Object.assign({ AGENT_DESKTOP_TEST_ALLOW_READ: path.dirname(live) }, E)), live, "explicitly allowed");
  assert.strictEqual(tg.explicit("argusBuilder", E), false);
  assert.strictEqual(tg.workspaceDir("sharedReports", {}), live, "outside test mode nothing changes");
});

// ============================================================ 10 launchEnv caching
t("10 launchEnv: `where` and the registry query run once per 5 minutes (also a miss), without a shell and with a 2 s timeout; clearCache and a config change forget", () => {
  const cp = require("child_process"); const LE = require("../src/launchEnv");
  const real = cp.execFileSync; const calls = [];
  cp.execFileSync = (cmd, args, o) => { calls.push({ cmd, args, o }); if (cmd === "where" && args[0] === "claude.cmd") return "C:\\found\\claude.cmd\r\nC:\\second\\claude.cmd\r\n"; const e = new Error("none"); throw e; };
  try {
    let clock = 0; const le = LE.createLaunchEnv({ cfg: null, platform: "win32", path: W, env: {}, fs: { statSync: () => { throw new Error("x"); }, lstatSync: () => { throw new Error("x"); } }, now: () => clock });
    for (let i = 0; i < 4; i++) assert.strictEqual(le.claude().path, "C:\\found\\claude.cmd");
    for (let i = 0; i < 3; i++) le.node();
    const wc = calls.filter((c) => c.args[0] === "claude.cmd").length; assert.strictEqual(wc, 1, "where claude.cmd ran once for four lookups");
    assert.strictEqual(calls.filter((c) => c.args[0] === "node.exe").length, 1, "a miss is remembered too");
    assert.strictEqual(calls.filter((c) => c.cmd === "reg").length, 3, "three registry keys, once each");
    assert.ok(calls.every((c) => c.o.timeout === 2000 && c.o.windowsHide === true), "2 s timeout"); assert.ok(calls.every((c) => c.cmd === "where" || c.cmd === "reg"), "no shell command line");
    const total = calls.length; clock += 4 * 60 * 1000; le.claude(); assert.strictEqual(calls.length, total, "still remembered at 4 minutes");
    clock += 2 * 60 * 1000; le.claude(); assert.ok(calls.length > total, "asked again after 5 minutes");
    const n2 = calls.length; le.clearCache(); le.claude(); assert.ok(calls.length > n2, "clearCache forgets");
    const c = withCfg({}, {}); const le2 = LE.createLaunchEnv({ cfg: c, platform: "win32", path: W, env: {}, fs: { statSync: () => { throw new Error("x"); }, lstatSync: () => { throw new Error("x"); } } });
    le2.claude(); const n3 = calls.length; le2.claude(); assert.strictEqual(calls.length, n3); c.set("ownerName", "Ana"); le2.claude(); assert.ok(calls.length > n3, "a configuration change forgets");
    // injected where / regQuery are used as given (not cached): the tests of the other areas rely on it
    let k = 0; const le3 = LE.createLaunchEnv({ cfg: null, platform: "win32", path: W, env: {}, fs: { statSync: () => { throw new Error("x"); }, lstatSync: () => { throw new Error("x"); } }, where: () => { k++; return null; }, regQuery: () => null });
    le3.node(); le3.node(); assert.ok(k >= 2);
  } finally { cp.execFileSync = real; }
});
t("10 launchEnv: prime() asks asynchronously (execFile) and the synchronous callers then find the answers waiting", async () => {
  const cp = require("child_process"); const LE = require("../src/launchEnv");
  const realSync = cp.execFileSync, realAsync = cp.execFile; let syncCalls = 0, asyncCalls = 0;
  cp.execFileSync = () => { syncCalls++; throw new Error("none"); };
  cp.execFile = (cmd, args, o, cb) => { asyncCalls++; setImmediate(() => (cmd === "where" && args[0] === "node.exe" ? cb(null, "C:\\n\\node.exe\r\n", "") : cb(new Error("none"), "", ""))); };
  try {
    const le = LE.createLaunchEnv({ cfg: null, platform: "win32", path: W, env: {}, fs: { statSync: (p) => { if (p === "C:\\n\\node.exe") return { isFile: () => true }; throw new Error("x"); }, lstatSync: () => { throw new Error("x"); } } });
    assert.strictEqual(await le.prime(), true); assert.ok(asyncCalls >= 4);
    assert.strictEqual(le.node(), "C:\\n\\node.exe"); le.claude(); assert.strictEqual(syncCalls, 0, "no process was started synchronously after priming");
  } finally { cp.execFileSync = realSync; cp.execFile = realAsync; }
});

// ============================================================ 11 parity dedupe + daily.dataDir
t("11 parity: folder lists are de-duplicated by the layer", () => {
  const c = winCfg({ outputRoots: ["C:\\A", "c:\\a", "D:\\B", "C:\\A\\"] });
  assert.deepStrictEqual(c.get("outputRoots"), ["C:\\A", "D:\\B"]);
});
t("11 daily: with daily.dataDir pinned to the old <agents folder>/daily, a stray <userData>/daily does not win", () => {
  const dailyConfig = require("../src/daily/dailyConfig");
  const agents = mk("ag"); const legacy = mk("ag", "daily"); touch(path.join(legacy, "events.json"), "[]");
  const ud = mk("udd"); mk("udd", "daily");  // a stray empty folder made by a fresh start
  const mkcfg = (daily) => { const c = withCfg({ workspaceRoot: agents, agentsRoot: agents }, {}, daily ? { daily } : undefined); return c; };
  assert.strictEqual(dailyConfig.create({ cfg: mkcfg(undefined), userDataDir: ud }).dataDir(), path.join(ud, "daily"), "unpinned: the existing userData folder wins (as designed)");
  assert.strictEqual(dailyConfig.create({ cfg: mkcfg({ dataDir: legacy }), userDataDir: ud }).dataDir(), legacy, "pinned: the real data folder wins");
});

// ---------------------------------------------------------------- run
(async () => {
  for (const [name, fn] of queue) { n++; try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(n - fails + "/" + n + " passed");
  process.exit(fails ? 1 : 0);
})();
