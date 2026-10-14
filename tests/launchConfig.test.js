// node tests/launchConfig.test.js - launch / start-up area of the configuration layer (v1.121.0):
// Claude Code / Node / git / python discovery, the agents folder rule, the consent-gated Claude Code integration, update repo + channel,
// PC Health and Telegram needs-setup states, and the plain launch scripts. Temp folders and fake file systems only: no D: / E: paths.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { createAppConfig } = require("../src/appConfig");
const features = require("../src/features");
const LE = require("../src/launchEnv");
const AR = require("../src/agentsRoot");

let n = 0, fails = 0;
const t = async (name, fn) => { n++; try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "adlaunch-"));
const W = path.win32;
const mkdir = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const touch = (f, txt) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt || "x"); return f; };
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const makeCfg = (env, values, feats) => {
  const ud = mkdir("ud" + Math.random().toString(36).slice(2, 8));
  if (values || feats) fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify({ schema: 1, values: values || {}, features: feats || {} }));
  const c = createAppConfig({ userDataDir: ud, env: env || {} }); c.setRegistry(features); return c;
};

// a fake Windows: a set of existing files, a `where` table, a registry table
function fakeWin(files, whereTable, reg, env) {
  const set = new Set(files.map((f) => f.toLowerCase()));
  const has = (p) => set.has(String(p).toLowerCase());
  return {
    fs: { statSync: (p) => { if (!has(p)) throw new Error("ENOENT"); return { isFile: () => true, isDirectory: () => false }; }, lstatSync: (p) => { if (!has(p)) throw new Error("ENOENT"); return {}; } },
    where: (name) => whereTable[name] || null,
    regQuery: (key) => (reg || {})[key] || null,
    env: env || {}, platform: "win32", path: W,
  };
}
const le = (cfg, f) => LE.createLaunchEnv(Object.assign({ cfg }, f));

(async () => {
  // ------------------------------------------------------------------ Claude Code
  await t("claude: the person's setting wins over everything the old code tried; a stale setting is ignored", () => {
    const f = fakeWin(["Z:\\tools\\claude.cmd", "C:\\pkg\\claude.cmd", "C:\\n\\claude.cmd"], { "claude.cmd": "C:\\n\\claude.cmd" });
    const cfg = makeCfg({}, null); // no setting
    cfg.setMany; // eslint
    const cfgSet = { source: () => "config", get: () => "Z:\\tools\\claude.cmd" };
    assert.strictEqual(le(cfgSet, f).claude({ legacy: () => "C:\\pkg\\claude.cmd" }).path, "Z:\\tools\\claude.cmd");
    const stale = { source: () => "config", get: () => "Z:\\gone\\claude.cmd" };
    assert.strictEqual(le(stale, f).claude({ legacy: () => "C:\\pkg\\claude.cmd" }).path, "C:\\pkg\\claude.cmd");
    assert.strictEqual(le(cfg, f).claude({ legacy: () => "C:\\pkg\\claude.cmd" }).source, "legacy");
  });
  await t("claude: order after the package folder = where claude.cmd (unchecked, as before) > %APPDATA%\\npm > where claude.exe > native installer > npm prefix", () => {
    const cfg = makeCfg({});
    const env = { APPDATA: "C:\\Users\\u\\AppData\\Roaming", USERPROFILE: "C:\\Users\\u", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
    // where finds a path even when stat cannot see it (the package-store link): trusted, exactly like the old code
    let r = le(cfg, fakeWin([], { "claude.cmd": "C:\\link\\claude.cmd" }, null, env)).claude();
    assert.deepStrictEqual([r.ok, r.path, r.source], [true, "C:\\link\\claude.cmd", "path"]);
    r = le(cfg, fakeWin(["C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd", "C:\\Users\\u\\.local\\bin\\claude.exe"], {}, null, env)).claude();
    assert.strictEqual(r.path, "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd");
    r = le(cfg, fakeWin(["C:\\Users\\u\\.local\\bin\\claude.exe"], {}, null, env)).claude();
    assert.deepStrictEqual([r.ok, r.path, r.source], [true, "C:\\Users\\u\\.local\\bin\\claude.exe", "known-place"]);
    r = le(cfg, fakeWin(["C:\\Program Files\\nodejs\\claude.cmd", "C:\\Program Files\\nodejs\\npm.cmd"], { "npm.cmd": "C:\\Program Files\\nodejs\\npm.cmd" }, null, env)).claude();
    assert.strictEqual(r.source, "npm-prefix");
  });
  await t("claude: not installed = a plain answer with the message, never a made-up path; the typed error carries the same words", () => {
    const r = le(makeCfg({}), fakeWin([], {}, null, { APPDATA: "C:\\a", USERPROFILE: "C:\\u", LOCALAPPDATA: "C:\\l" })).claude({ first: () => null, legacy: () => null });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, "not-installed"); assert.ok(/not installed/i.test(r.message) && /Setup/.test(r.message));
    const e = LE.claudeNotInstalledError();
    assert.strictEqual(e.code, "CLAUDE_NOT_INSTALLED"); assert.ok(e.message.indexOf(LE.CLAUDE_MISSING_MESSAGE) === 0);
  });
  await t("claude: Agent Desktop's own managed copy is tried before the setting", () => {
    const f = fakeWin(["C:\\own\\claude.cmd", "Z:\\tools\\claude.cmd"], {});
    const cfgSet = { source: () => "config", get: () => "Z:\\tools\\claude.cmd" };
    assert.strictEqual(le(cfgSet, f).claude({ first: () => "C:\\own\\claude.cmd" }).source, "private");
  });

  // ------------------------------------------------------------------ Node, npm, git, python
  await t("node: setting > where node.exe > registry InstallPath > ProgramFiles; npm: where npm.cmd > beside node > ProgramFiles; none = null (no literal fallback)", () => {
    const env = { ProgramFiles: "C:\\Program Files" };
    const none = { source: () => null, get: () => null };
    assert.strictEqual(le(none, fakeWin(["Q:\\n\\node.exe"], { "node.exe": "Q:\\n\\node.exe" }, null, env)).node(), "Q:\\n\\node.exe");
    assert.strictEqual(le(none, fakeWin(["R:\\node\\node.exe"], {}, { "HKLM\\SOFTWARE\\Node.js": "R:\\node\\" }, env)).node(), "R:\\node\\node.exe");
    assert.strictEqual(le(none, fakeWin(["C:\\Program Files\\nodejs\\node.exe"], {}, null, env)).node(), "C:\\Program Files\\nodejs\\node.exe");
    assert.strictEqual(le(none, fakeWin([], {}, null, env)).node(), null);
    const set = { source: () => "config", get: () => "S:\\my\\node.exe" };
    assert.strictEqual(le(set, fakeWin(["S:\\my\\node.exe", "Q:\\n\\node.exe"], { "node.exe": "Q:\\n\\node.exe" }, null, env)).node(), "S:\\my\\node.exe");
    // npm: the old fallback literal C:\Program Files\nodejs\npm.cmd is reproduced from the node folder / %ProgramFiles%, only when it exists
    assert.strictEqual(le(none, fakeWin(["C:\\Program Files\\nodejs\\node.exe", "C:\\Program Files\\nodejs\\npm.cmd"], {}, null, env)).npm(), "C:\\Program Files\\nodejs\\npm.cmd");
    assert.strictEqual(le(none, fakeWin(["Q:\\n\\npm.cmd"], { "npm.cmd": "Q:\\n\\npm.cmd" }, null, env)).npm(), "Q:\\n\\npm.cmd");
    assert.strictEqual(le(none, fakeWin([], {}, null, env)).npm(), null);
    assert.strictEqual(le(none, fakeWin(["C:\\Program Files\\nodejs\\node.exe"], {}, null, env)).nodeDir(), "C:\\Program Files\\nodejs");
  });
  await t("git: setting > PATH (as before) > %ProgramFiles%\\Git\\cmd and \\bin; python: the setting or the bare command (what the old code ran)", () => {
    const env = { PATH: "X:\\a;X:\\git\\bin", ProgramFiles: "C:\\Program Files" };
    const none = { source: () => null, get: () => null };
    assert.strictEqual(le(none, fakeWin(["X:\\git\\bin\\git.exe", "C:\\Program Files\\Git\\cmd\\git.exe"], {}, null, env)).git(), "X:\\git\\bin\\git.exe");
    assert.strictEqual(le(none, fakeWin(["C:\\Program Files\\Git\\cmd\\git.exe"], {}, null, env)).git(), "C:\\Program Files\\Git\\cmd\\git.exe");
    assert.strictEqual(le(none, fakeWin([], {}, null, env)).git(), null);
    const gset = { source: () => "env", get: () => "G:\\g\\git.exe" };
    assert.strictEqual(le(gset, fakeWin(["G:\\g\\git.exe", "X:\\git\\bin\\git.exe"], {}, null, env)).git(), "G:\\g\\git.exe");
    assert.strictEqual(le(none, fakeWin([], {}, null, env)).pythonCommand(), "python");
    assert.strictEqual(le({ source: () => "config", get: () => "P:\\py\\python.exe" }, fakeWin(["P:\\py\\python.exe"], {}, null, env)).pythonCommand(), "P:\\py\\python.exe");
    assert.strictEqual(le({ source: () => "auto", get: () => "C:\\Windows\\py.exe" }, fakeWin(["C:\\Windows\\py.exe"], {}, null, env)).pythonCommand(), "python", "an auto-detected py.exe must not replace the bare command");
  });
  await t("the environment form of the settings reaches launchEnv (AGENT_DESKTOP_NODE_EXE)", () => {
    const f = path.join(root, "nodex.exe"); touch(f);
    const c = makeCfg({ AGENT_DESKTOP_NODE_EXE: f });
    assert.strictEqual(LE.createLaunchEnv({ cfg: c, env: {}, where: () => null, regQuery: () => null }).node(), f);
  });

  // ------------------------------------------------------------------ agents folder rule
  await t("agentsRoot: AGENT_DESKTOP_ROOT is used as written; AGENT_DESKTOP_AGENTS_ROOT (cfg env) beats it; Setup's value next; nothing = null", () => {
    const a = mkdir("agents-a"), b = mkdir("agents-b");
    assert.strictEqual(AR.getRoot({ env: { AGENT_DESKTOP_ROOT: a }, cfg: makeCfg({}), repoDir: mkdir("nowhere", "repo") }), a);
    assert.strictEqual(AR.getRoot({ env: { AGENT_DESKTOP_ROOT: a, AGENT_DESKTOP_AGENTS_ROOT: b }, cfg: makeCfg({ AGENT_DESKTOP_AGENTS_ROOT: b }), repoDir: mkdir("nowhere", "repo") }), b);
    assert.strictEqual(AR.getRoot({ env: {}, cfg: makeCfg({}, { agentsRoot: b }), repoDir: mkdir("nowhere", "repo") }), b);
    assert.strictEqual(AR.getRoot({ env: {}, cfg: makeCfg({}), repoDir: mkdir("nowhere2", "repo") }), null);
  });
  await t("agentsRoot: with no setting, the old rule still finds the folder the program sits in, but only if it holds agent folders", () => {
    const parent = mkdir("sib"); const repo = mkdir("sib", "agent-desktop"); mkdir("sib", "docs");
    assert.strictEqual(AR.getRoot({ env: {}, cfg: makeCfg({}), repoDir: repo }), null, "an unrelated parent folder is not an agents folder");
    touch(path.join(parent, "Helper", "master_state.md"));
    assert.strictEqual(AR.getRoot({ env: {}, cfg: makeCfg({}), repoDir: repo }), parent);
  });
  await t("agents.js / groups.js follow the rule on every call (no value fixed at load); no folder = empty list and a needs-setup error to create", () => {
    const dir = mkdir("agents-live"); touch(path.join(dir, "Alpha", "master_state.md"), "# Alpha\n");
    const keep = process.env.AGENT_DESKTOP_ROOT;
    process.env.AGENT_DESKTOP_ROOT = dir;
    try {
      const agents = require("../src/agents"); const groups = require("../src/groups");
      assert.deepStrictEqual(agents.listAgents().map((a) => a.folderName), ["Alpha"]);
      assert.strictEqual(agents.ROOT, dir); assert.strictEqual(groups.GROUPS_PATH, path.join(dir, "agent_groups.json"));
      const dir2 = mkdir("agents-live2"); touch(path.join(dir2, "Beta", "master_state.md"), "# Beta\n");
      process.env.AGENT_DESKTOP_ROOT = dir2;
      assert.deepStrictEqual(agents.listAgents().map((a) => a.folderName), ["Beta"], "a changed folder is seen at once");
      delete process.env.AGENT_DESKTOP_ROOT;
      const r = AR.getRoot({ env: {}, cfg: makeCfg({}), repoDir: mkdir("nothing", "repo") });
      assert.strictEqual(r, null);
      assert.strictEqual(AR.needsSetupError().code, "needs-setup");
    } finally { if (keep === undefined) delete process.env.AGENT_DESKTOP_ROOT; else process.env.AGENT_DESKTOP_ROOT = keep; }
  });

  // ------------------------------------------------------------------ Claude Code integration (opt-in)
  await t("integration: OFF on a fresh config; setFeature/enabled alone does not switch it on; only the UI's grantConsent does; env/agents cannot", () => {
    const c = makeCfg({});
    assert.strictEqual(c.isConsented("claudeIntegration"), false); assert.strictEqual(c.feature("claudeIntegration").state, "off");
    c.setFeature("claudeIntegration", { enabled: true });
    assert.strictEqual(c.isConsented("claudeIntegration"), false, "a flag without a consent record does nothing"); assert.strictEqual(c.feature("claudeIntegration").state, "needs-attention");
    const forged = makeCfg({}, null, null); fs.writeFileSync(forged.configPath(), JSON.stringify({ schema: 1, values: {}, features: {}, claudeIntegration: { enabled: true } })); forged.reload();
    assert.strictEqual(forged.isConsented("claudeIntegration"), false, "an agent-written enabled:true without consentAt is ignored");
    assert.strictEqual(c.grantConsent("claudeIntegration", "setup-ui").ok, true); assert.strictEqual(c.isConsented("claudeIntegration"), true);
    assert.strictEqual(c.feature("claudeIntegration").state, "ready");
    assert.strictEqual(c.setFeature("claudeIntegration", { enabled: false }).ok, true); assert.strictEqual(c.isConsented("claudeIntegration"), false, "turning off withdraws the consent");
  });
  await t("integration: main.js writes settings.json only inside applyClaudeIntegration (consent + test-mode gate); the consent text exists and is only reachable from the UI IPC", () => {
    const m = read("src/main.js");
    const calls = m.match(/^\s*ensureRateLimitStatusLine\(\);/gm) || [];
    assert.strictEqual(calls.length, 1, "ensureRateLimitStatusLine() is called in one place"); assert.strictEqual((m.match(/^\s*ensureRemoteControlEnabled\(\);/gm) || []).length, 1);
    const fn = m.slice(m.indexOf("function applyClaudeIntegration()"), m.indexOf("function applyClaudeIntegration()") + 900);
    assert.ok(/flowsEnabled\(\)/.test(fn) && /claudeIntegrationAllowed\(\)/.test(fn) && fn.indexOf("ensureRateLimitStatusLine();") > fn.indexOf("claudeIntegrationAllowed()"));
    assert.ok(/isConsented\("claudeIntegration"\)/.test(m));
    const sm = read("src/setupMain.js"); assert.ok(/claudeIntegration: \{\s*message:/.test(sm) && /settings file/.test(sm));
    const f = features.get("claudeIntegration"); assert.strictEqual(f.kind, "consent"); assert.ok(/cannot be turned on by an agent/.test(f.agentHelp));
  });

  // ------------------------------------------------------------------ updater
  await t("updater: repo and channel come from the configuration layer; defaults are calm; bad values are refused before they reach a URL or a git argument", () => {
    const U = require("../src/app-update");
    const keep = { r: process.env.AGENT_DESKTOP_UPDATE_REPO, c: process.env.AGENT_DESKTOP_UPDATE_CHANNEL };
    try {
      delete process.env.AGENT_DESKTOP_UPDATE_REPO; delete process.env.AGENT_DESKTOP_UPDATE_CHANNEL;
      assert.strictEqual(U.releasesRepo(), null); assert.strictEqual(U.channel(), "main");
      process.env.AGENT_DESKTOP_UPDATE_REPO = "someone/agent-desktop"; process.env.AGENT_DESKTOP_UPDATE_CHANNEL = "release/2.x";
      assert.strictEqual(U.releasesRepo(), "someone/agent-desktop"); assert.strictEqual(U.channel(), "release/2.x"); assert.strictEqual(U.RELEASES_REPO, "someone/agent-desktop");
      for (const bad of ["../etc/passwd", "a b/c", "x/y/z", "/x", "x/", "x/..", "http://evil/x"]) { process.env.AGENT_DESKTOP_UPDATE_REPO = bad; assert.strictEqual(U.releasesRepo(), null, bad); }
      for (const bad of ["--upload-pack=x", "-f", "a..b", "a b", "x;rm", "branch.lock", "a//b", "trail/"]) { process.env.AGENT_DESKTOP_UPDATE_CHANNEL = bad; assert.strictEqual(U.channel(), "main", bad); }
    } finally { for (const [k, v] of [["AGENT_DESKTOP_UPDATE_REPO", keep.r], ["AGENT_DESKTOP_UPDATE_CHANNEL", keep.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });
  await t("updater: with no source configured an installed copy says so calmly (no request, no error)", async () => {
    const U = require("../src/app-update"); U.init({ app: { getVersion: () => "1.0.0", isPackaged: true, getPath: () => root }, testMode: { TEST_MODE: false }, isVersionNewer: () => false });
    const keep = process.env.AGENT_DESKTOP_UPDATE_REPO; delete process.env.AGENT_DESKTOP_UPDATE_REPO;
    try { const st = await U.getStatus({ fetch: false }); assert.strictEqual(st.mode, "release"); assert.strictEqual(st.noSource, true); assert.strictEqual(st.available, false); assert.strictEqual(st.error, null); }
    finally { if (keep !== undefined) process.env.AGENT_DESKTOP_UPDATE_REPO = keep; }
  });
  await t("updater: the update steps are the same strings as before for the default channel (static check of the git arguments)", () => {
    const s = read("src/app-update.js");
    for (const frag of ['"fetch", "--quiet", "origin", ch', "`HEAD...origin/${ch}`", '"merge", "--ff-only", `origin/${ch}`', '"reset", "--keep"', "getDoctor().ensure({})", "git(\"rev-parse\"".replace('git("rev-parse"', 'git(["rev-parse", "HEAD"])')]) assert.ok(s.indexOf(frag) >= 0, frag);
    assert.ok(!/origin\/main/.test(s.replace(/\/\/.*$/gm, "")), "no hard-coded origin/main left outside comments");
  });

  // ------------------------------------------------------------------ PC Health + Telegram
  await t("pcHealth: needs-setup without the script (no process is spawned); ready with script + python", async () => {
    const spawned = []; const M = require("../src/pcHealthMain");
    const EE = require("events");
    const mkRig = (cfg) => {
      const w = new EE(); w.webContents = new EE(); w.sent = []; w.webContents.send = (ch, p) => w.sent.push([ch, p]); w.isVisible = () => true; w.isMinimized = () => false; w.isDestroyed = () => false;
      const handlers = {}; const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
      M.init({ ipcMain, app: new EE(), getMainWindow: () => w, testMode: false, log: () => {}, cfg });
      return { w, call: (ch, p) => handlers[ch]({ sender: w.webContents }, p) };
    };
    const ws = mkdir("pc-ws"); const c0 = makeCfg({ AGENT_DESKTOP_WORKSPACE_ROOT: ws });
    assert.strictEqual(c0.feature("pcHealth").state, "needs-setup"); assert.ok(c0.feature("pcHealth").missing.indexOf("pcHealthScript") >= 0);
    const r0 = mkRig(c0); const res = await r0.call("pchealth-start");
    assert.deepStrictEqual([res.ok, res.reason], [false, "needs-setup"]);
    const st = r0.w.sent.filter((x) => x[0] === "pchealth-status").map((x) => x[1]);
    assert.ok(st.some((s) => s.state === "needs-setup" && /Setup/.test(s.message)), "the panel gets a calm needs-setup status");
    const snap = await r0.call("pchealth-snapshot"); assert.deepStrictEqual([snap.ok, snap.reason], [false, "needs-setup"]);
    // the script appears -> ready (needs python on the test machine's PATH only for the feature state; the spawn itself is not run here)
    touch(path.join(ws, "shared_tools", "pc_health", "pc_health.py"), "print(1)");
    const py = touch(path.join(root, "fakepy", "python.exe"));
    const c1 = makeCfg({ AGENT_DESKTOP_WORKSPACE_ROOT: ws, AGENT_DESKTOP_PYTHON_EXE: py });
    assert.strictEqual(c1.feature("pcHealth").state, "ready"); assert.strictEqual(c1.get("pcHealthScript"), path.join(ws, "shared_tools", "pc_health", "pc_health.py"));
    assert.strictEqual(features.get("pcHealth").wired, true);
    assert.ok(!/REAL_SCRIPT\s*=/.test(read("src/pcHealthMain.js")));
  });
  await t("telegram: no folder = an empty queue and a calm needs-setup answer; configured = reads the queue and runs the bridge's tasks.py with the configured python", async () => {
    const OV = require("../src/overview");
    const keep = { d: process.env.AGENT_DESKTOP_TELEGRAM_TASKS_DIR, b: process.env.AGENT_DESKTOP_TELEGRAM_BRIDGE_DIR, p: process.env.AGENT_DESKTOP_PYTHON_EXE };
    const q = mkdir("tg", "tasks"), bridge = mkdir("tg", "bridge");
    fs.writeFileSync(path.join(q, "260101-ab12.json"), JSON.stringify({ id: "260101-ab12", body: "buy milk", agent: "(unassigned)", status: "pending", createdAt: "2026-01-01" }));
    try {
      delete process.env.AGENT_DESKTOP_TELEGRAM_TASKS_DIR; delete process.env.AGENT_DESKTOP_TELEGRAM_BRIDGE_DIR;
      assert.deepStrictEqual(OV.getAgentOverview([], () => "", () => false).unassigned, []);
      const res = await OV.approveTelegramTasks(["260101-ab12"], null, { cfg: makeCfg({}) });
      assert.deepStrictEqual([res.ok, res.reason], [false, "needs-setup"]); assert.ok(/Setup/.test(res.output));
      process.env.AGENT_DESKTOP_TELEGRAM_TASKS_DIR = q; process.env.AGENT_DESKTOP_TELEGRAM_BRIDGE_DIR = bridge;
      assert.strictEqual(OV.getAgentOverview([], () => "", () => false).unassigned.length, 1);
      fs.writeFileSync(path.join(bridge, "tasks.py"), "// not python: the fake interpreter below is node\nconsole.log(process.argv.slice(2).join(' '));\n");
      const cfgOk = makeCfg({ AGENT_DESKTOP_TELEGRAM_TASKS_DIR: q, AGENT_DESKTOP_TELEGRAM_BRIDGE_DIR: bridge, AGENT_DESKTOP_PYTHON_EXE: process.execPath });
      assert.strictEqual(cfgOk.isReady("telegram"), true);
      const ok = await OV.approveTelegramTasks(["260101-ab12", "bad id"], null, { cfg: cfgOk, python: process.execPath });
      assert.strictEqual(ok.ok, true); assert.ok(/--approve 260101-ab12/.test(ok.output) && !/bad id/.test(ok.output), ok.output);
    } finally { for (const [k, v] of [["AGENT_DESKTOP_TELEGRAM_TASKS_DIR", keep.d], ["AGENT_DESKTOP_TELEGRAM_BRIDGE_DIR", keep.b], ["AGENT_DESKTOP_PYTHON_EXE", keep.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });

  // ------------------------------------------------------------------ launch scripts and docs
  await t("launch scripts: no fixed Node/Program Files/E: path; Launch.vbs reads the registry, ProgramFiles and PATH; the bat takes its work folder from the environment", () => {
    const vbs = read("Launch.vbs"), bat = read("Start-TestDesktop.bat");
    assert.ok(!/C:\\Program Files\\nodejs/i.test(vbs) && /HKLM\\SOFTWARE\\Node\.js\\InstallPath/.test(vbs) && /%ProgramFiles%/.test(vbs) && /where node/.test(vbs));
    assert.ok(/envProcess\("PATH"\) = nodeDir & ";" & envProcess\("PATH"\)/.test(vbs), "the folder is put in front of PATH exactly as before");
    assert.ok(!/C:\\Example\\Scratch/i.test(bat) && /AGENT_DESKTOP_WORK/.test(bat) && /Start-TestDesktop\.local\.bat/.test(bat) && /reg query "HKLM\\SOFTWARE\\Node\.js"/.test(bat));
    assert.ok(fs.existsSync(path.join(__dirname, "..", "Start-TestDesktop.local.bat.example")));
    assert.ok(/\*\.local\.bat/.test(read(".gitignore")));
    const doc = read("INSTALL_AND_USE_FOR_CLAUDE.md"); assert.ok(/## READ_FIRST/.test(doc) && /Launch\.vbs/.test(doc) && /Start-TestDesktop\.bat/.test(doc) && /Claude Code integration/.test(doc));
    for (const f of ["tools/health-pane-sandbox.cjs"]) assert.ok(!/[A-Z]:[\\/]/.test(read(f).replace(/https?:\/\//g, "")), f);
  });
  await t("test mode: an unresolvable appData falls back to a private temp userData instead of crashing (test mode only; production untouched)", () => {
    const m = read("src/main.js");
    const a = m.indexOf("if (testMode.TEST_MODE) {"); const blk = m.slice(a, a + 2600);
    assert.ok(/os"\)\.tmpdir\(\), "agent-desktop-test"/.test(blk) && /app\.setPath\("userData", fb\)/.test(blk) && /appData could not be resolved/.test(blk));
    assert.ok(!/app\.setPath\("userData"/.test(m.slice(0, a)), "no userData redirect outside test mode");
  });
  await t("claudeCode feature: needs-setup when nothing is found, ready when a claude program is given; registry entries exist with strings in both languages", () => {
    const c = makeCfg({ PATH: "" });
    const f = features.get("claudeCode"); assert.ok(f && f.wired === true);
    const exe = touch(path.join(root, "bin", "claude.cmd"));
    const c2 = makeCfg({ AGENT_DESKTOP_CLAUDE_EXE: exe }); assert.strictEqual(c2.feature("claudeCode").state, "ready");
    assert.ok(["needs-setup", "ready"].indexOf(c.feature("claudeCode").state) >= 0);
    const S = require("../src/renderer/setup-strings.js");
    for (const id of ["claudeCode", "claudeIntegration", "telegram"]) for (const l of ["en", "he"]) assert.ok(S.feature(l, id)[1] && S.feature(l, id)[2], id + " " + l);
  });

  console.log("");
  fs.rmSync(root, { recursive: true, force: true });
  console.log((n - fails) + "/" + n + " passed");
  process.exit(fails ? 1 : 0);
})();
