// node tests/setupPanel.test.js - Setup panel static checks (v1.121.0) plus the main-process IPC handlers with a fake ipcMain.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { createAppConfig } = require("../src/appConfig");
const features = require("../src/features");
const setupMain = require("../src/setupMain");
const SRC = path.join(__dirname, "..", "src");
const rd = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
let n = 0, fails = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const js = strip(rd("renderer", "setup.js"));
t("setup.js: no innerHTML / outerHTML / insertAdjacentHTML / document.write / eval", () => { assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(js)); });
t("setup.js: no timers, no polling, no observers", () => { assert.ok(!/setTimeout|setInterval|requestAnimationFrame|MutationObserver/.test(js)); });
t("setup.js: text and paths go in through textContent / value only; dir=auto on free text; paths are ltr", () => {
  assert.ok(/textContent/.test(js)); assert.ok(/"dir", "auto"/.test(js)); assert.ok(/"dir", "ltr"/.test(js));
});
t("setup.js: the renderer never builds a path (no path joins, no drive letters)", () => { assert.ok(!/path\.join|[A-Za-z]:\\\\|\\\\\\\\/.test(js)); });
t("setup.js: first-run welcome is gated by main's `welcome` flag only; Escape closes an open row", () => { assert.ok(/r\.welcome/.test(js)); assert.ok(/Escape/.test(js)); });
t("setup-strings.js: no innerHTML either, and a Hebrew block with rtl", () => { const s = rd("renderer", "setup-strings.js"); assert.ok(!/innerHTML/.test(s)); assert.ok(/dir: "rtl"/.test(s)); });
t("styles-setup.css: scoped to #setup-panel / the Setup tile / body.setup-open, no red state colours, primary #a94f30", () => {
  const css = strip(rd("renderer", "styles-setup.css"));
  const sel = css.split("}").map((b) => b.split("{")[0].trim()).filter(Boolean).join(",").split(",").map((x) => x.trim()).filter(Boolean);
  for (const s of sel) assert.ok(/#setup-panel|\.setup-nav|body\.setup-open|body\.lp-c #systems-group \.setup-nav-name/.test(s), "unscoped selector: " + s);
  assert.ok(/#a94f30/.test(css));
  assert.ok(!/#?(?:ff0000|e00|d00|c00|dc3545|f44)\b/i.test(css));
});
t("index.html wires the panel: stylesheet, strings before script, the Setup tile is a Systems entry", () => {
  const h = rd("renderer", "index.html");
  assert.ok(/styles-setup\.css/.test(h)); assert.ok(h.indexOf("setup-strings.js") > 0 && h.indexOf("setup-strings.js") < h.indexOf("setup.js"));
  assert.ok(/id="setup-nav"[^>]*data-system-nav="setup"/.test(h));
  assert.ok(/#setup-panel|setup-open/.test(rd("renderer", "styles-setup.css")));
  assert.ok(/"setup"/.test(rd("renderer", "viewmanager.js")));
});
t("preload exposes config.* with exactly the six IPC calls", () => {
  const p = rd("preload.js"); for (const c of ["config-get-all", "config-set-feature", "config-pick-folder", "config-create-folders", "config-agent-instructions", "config-consent"]) assert.ok(p.indexOf('"' + c + '"') > 0, c);
});

// ---- IPC ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsetup-"));
let seq = 0;
function rig(env, testMode) {
  const handlers = {}; const ipcMain = { handle: (c, f) => { handlers[c] = f; } };
  const ud = path.join(tmp, "ud" + (++seq)); fs.mkdirSync(ud, { recursive: true });
  const c = createAppConfig({ userDataDir: ud, env: env || {}, documentsDir: path.join(tmp, "Documents") }); c.setRegistry(features);
  const win = { webContents: {}, isDestroyed: () => false }; const picked = { path: null };
  const dialog = { showOpenDialog: async () => (picked.path ? { canceled: false, filePaths: [picked.path] } : { canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 1 }) };
  setupMain.register({ ipcMain, dialog, cfg: c, features, getMainWindow: () => win, isTestMode: () => !!testMode, env: {} });
  return { handlers, c, ud, main: { sender: win.webContents }, other: { sender: {} }, picked };
}
t("IPC: every handler refuses a sender that is not the main window", async () => {
  const r = rig();
  for (const ch of ["config-get-all", "config-set-feature", "config-pick-folder", "config-create-folders", "config-agent-instructions", "config-consent"])
    assert.strictEqual((await r.handlers[ch](r.other, { featureId: "argus", key: "workspaceRoot" })).error, "not-allowed", ch);
});
const CONVERTED = ["pcHealth", "claudeCode", "claudeIntegration", "telegram"]; // areas converted so far (see features.test.js)
t("IPC: get-all lists the 17 features with states, suggestions and the workspace card; welcome only when nothing exists and not test mode", async () => {
  const r = rig(); const all = await r.handlers["config-get-all"](r.main);
  assert.strictEqual(all.ok, true); assert.strictEqual(all.features.length, 17); assert.ok(all.workspace && all.workspace.id === "workspace");
  assert.strictEqual(all.welcome, true); assert.strictEqual(all.exists, false);
  assert.ok(all.features.every((f) => f.state && f.group && Array.isArray(f.suggestions) && typeof f.wired === "boolean"));
  const t2 = rig({}, true); assert.strictEqual((await t2.handlers["config-get-all"](t2.main)).welcome, false, "never in test mode");
  const ws = path.join(tmp, "wsx"); fs.mkdirSync(ws);
  const t3 = rig({ AGENT_DESKTOP_WORKSPACE_ROOT: ws }); assert.strictEqual((await t3.handlers["config-get-all"](t3.main)).welcome, false, "a detected workspace means no welcome");
  fs.writeFileSync(path.join(t3.ud, "app-config.json"), JSON.stringify({ schema: 1, values: {} })); t3.c.reload();
  const t4 = rig(); fs.writeFileSync(path.join(t4.ud, "app-config.json"), JSON.stringify({ schema: 1, values: {} })); t4.c.reload();
  assert.strictEqual((await t4.handlers["config-get-all"](t4.main)).welcome, false, "an existing config file means no welcome");
});
t("IPC: create-folders makes only the folders the feature's steps name, inside the workspace; refuses traversal and outside paths", async () => {
  const r = rig(); const ws = path.join(tmp, "wsa");
  let m = await r.handlers["config-create-folders"](r.main, { featureId: "workspace", values: { workspaceRoot: ws } });
  assert.strictEqual(m.ok, true); assert.ok(fs.statSync(ws).isDirectory());
  assert.strictEqual((await r.handlers["config-set-feature"](r.main, { featureId: "workspace", values: { workspaceRoot: ws } })).ok, true);
  m = await r.handlers["config-create-folders"](r.main, { featureId: "argus", values: { sharedReports: path.join(ws, "shared_reports") } });
  assert.deepStrictEqual(m.created, [path.join(ws, "shared_reports")]);
  assert.ok(!fs.existsSync(path.join(ws, "shared_tools")), "nothing else is created");
  assert.strictEqual((await r.handlers["config-create-folders"](r.main, { featureId: "argus", values: { sharedReports: path.join(tmp, "elsewhere", "x") } })).error, "outside-workspace");
  assert.strictEqual((await r.handlers["config-create-folders"](r.main, { featureId: "argus", values: { sharedReports: ws + path.sep + ".." + path.sep + "x" } })).error, "invalid-value");
  assert.strictEqual((await r.handlers["config-create-folders"](r.main, { featureId: "../x", values: {} })).error, "invalid-arguments");
  assert.strictEqual((await r.handlers["config-create-folders"](r.main, { featureId: "memory", values: { agentsRoot: path.join(ws, "Agents") } })).created.length, 0, "memory's step is not a create step");
});
t("IPC: set-feature validates ids and keys; a feature can only set its own keys; success returns the new state", async () => {
  const r = rig(); const ws = path.join(tmp, "wsb"); fs.mkdirSync(path.join(ws, "shared_reports"), { recursive: true });
  const h = r.handlers["config-set-feature"];
  assert.strictEqual((await h(r.main, { featureId: "nope", values: {} })).error, "invalid-arguments");
  assert.strictEqual((await h(r.main, { featureId: "argus", values: { tasksTool: path.join(ws, "x") } })).error, "key-not-part-of-feature");
  assert.strictEqual((await h(r.main, { featureId: "argus", values: { workspaceRoot: "relative" } })).error, "invalid-value");
  assert.strictEqual((await h(r.main, { featureId: "argus", enabled: "yes" })).error, "invalid-arguments");
  assert.strictEqual((await h(r.main, { featureId: "argus", values: [1] })).error, "invalid-arguments");
  const ok = await h(r.main, { featureId: "argus", values: { workspaceRoot: ws, sharedReports: path.join(ws, "shared_reports") }, enabled: true });
  assert.strictEqual(ok.ok, true); assert.strictEqual(ok.feature.state, "ready");
  assert.ok(fs.existsSync(path.join(r.ud, "app-config.json")), "app-config.json written into userData");
});
t("IPC: pick-folder returns only a path (writes nothing), only for a folder/file step of a real feature", async () => {
  const r = rig(); const p = path.join(tmp, "picked"); fs.mkdirSync(p); r.picked.path = p;
  assert.deepStrictEqual(await r.handlers["config-pick-folder"](r.main, { featureId: "argus", key: "sharedReports" }), { ok: true, path: p });
  assert.ok(!fs.existsSync(path.join(r.ud, "app-config.json")));
  assert.strictEqual((await r.handlers["config-pick-folder"](r.main, { featureId: "argus", key: "tasksTool" })).error, "invalid-arguments");
  assert.strictEqual((await r.handlers["config-pick-folder"](r.main, { featureId: "myDaily", key: "ownerName" })).error, "invalid-arguments");
  r.picked.path = null; assert.strictEqual((await r.handlers["config-pick-folder"](r.main, { featureId: "argus", key: "sharedReports" })).canceled, true);
});
t("IPC: agent instructions (all, and per feature) contain the config path, the keys and the feature help", async () => {
  const r = rig(); const all = await r.handlers["config-agent-instructions"](r.main);
  assert.ok(all.text.indexOf(r.c.configPath()) >= 0 || /app-config\.json/.test(all.text)); assert.ok(/### argus/.test(all.text));
  const one = await r.handlers["config-agent-instructions"](r.main, { featureId: "argus" });
  assert.ok(/argus/.test(one.text) && one.text.indexOf(r.c.configPath()) >= 0);
  assert.strictEqual((await r.handlers["config-agent-instructions"](r.main, { featureId: "zzz" })).error, "invalid-arguments");
});
(async () => {
  for (const [name, fn] of tests) { n++; try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(n - fails + "/" + n + " passed");
  process.exit(fails ? 1 : 0);
})();
