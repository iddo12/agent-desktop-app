// node tests/irisConsent.test.js - IRIS is OFF until the person consents (v1.121.0): consent record, grandfather rule, IPC, migration tool.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { createAppConfig } = require("../src/appConfig");
const features = require("../src/features");
const gate = require("../src/irisGate");
const setupMain = require("../src/setupMain");
let n = 0, fails = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adiris-"));
let seq = 0;
const mkUd = () => { const d = path.join(tmp, "ud" + (++seq)); fs.mkdirSync(d, { recursive: true }); return d; };
const make = (ud, env) => { const c = createAppConfig({ userDataDir: ud, env: env || {} }); c.setRegistry(features); return c; };
const writeCfg = (ud, doc) => fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify(doc));
const writePeers = (ud, text) => { fs.mkdirSync(path.join(ud, "iris"), { recursive: true }); fs.writeFileSync(path.join(ud, "iris", "peers.json"), text); };
const PEER = JSON.stringify({ abc123: { id: "abc123", name: "Other PC", pub: "x" } });

t("default: IRIS is off, not consented, the listener may not start", () => {
  const c = make(mkUd());
  assert.strictEqual(c.feature("iris").state, "off"); assert.strictEqual(c.isConsented("iris"), false);
});
t("env, set() and the generic config cannot enable IRIS", () => {
  const c = make(mkUd(), { AGENT_DESKTOP_IRIS_ENABLED: "1", AGENT_DESKTOP_IRIS: "1", AGENT_DESKTOP_IRIS_CONSENT_AT: "2026-01-01" });
  assert.strictEqual(c.isConsented("iris"), false);
  assert.strictEqual(c.set("iris", true).ok, false);
  assert.strictEqual(c.setMany({ iris: { enabled: true, consentAt: "2026-01-01" } }).ok, false);
  assert.strictEqual(c.isConsented("iris"), false);
});
t("setFeature('iris', enabled) from agent paths sets only the flag: state needs-attention 'consent needed', listener off", () => {
  const ud = mkUd(); const c = make(ud);
  assert.strictEqual(c.setFeature("iris", { enabled: true }).ok, true);
  const f = c.feature("iris"); assert.strictEqual(f.state, "needs-attention"); assert.strictEqual(f.reason, "consent needed");
  assert.strictEqual(c.isConsented("iris"), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ud, "app-config.json"), "utf8")).iris.consentAt, undefined);
});
t("hand-edited app-config.json: enabled without consentAt (or with a junk date) is not consent", () => {
  for (const sec of [{ enabled: true }, { enabled: true, consentAt: "not a date" }, { enabled: true, consentAt: 5 }, { consentAt: "2026-01-01T00:00:00Z" }, { enabled: "true", consentAt: "2026-01-01T00:00:00Z" }]) {
    const ud = mkUd(); writeCfg(ud, { schema: 1, values: {}, iris: sec });
    assert.strictEqual(make(ud).isConsented("iris"), false, JSON.stringify(sec));
  }
  const ud = mkUd(); writeCfg(ud, { schema: 1, values: {}, iris: { enabled: true, consentAt: "2026-01-01T00:00:00Z" } });
  assert.strictEqual(make(ud).isConsented("iris"), true);
});
t("grantConsent only for consent features and known sources; revoke removes the record, re-enabling by flag does not restore it", () => {
  const c = make(mkUd());
  assert.strictEqual(c.grantConsent("argus", "setup-ui").ok, false);
  assert.strictEqual(c.grantConsent("iris", "agent").ok, false);
  const r = c.grantConsent("iris", "setup-ui"); assert.strictEqual(r.ok, true); assert.strictEqual(c.isConsented("iris"), true);
  assert.strictEqual(c.feature("iris").state, "needs-attention", "granted but agentsRoot not set -> attention, not ready"); // requires agentsRoot
  assert.strictEqual(c.setFeature("iris", { enabled: false }).ok, true);
  assert.strictEqual(c.isConsented("iris"), false);
  c.setFeature("iris", { enabled: true });
  assert.strictEqual(c.isConsented("iris"), false, "flag alone never brings the consent back");
});
t("(1) grandfather: paired userData + no config -> consent with source existing-pairing", () => {
  const ud = mkUd(); writePeers(ud, PEER); const c = make(ud);
  const g = gate.grandfather({ cfg: c, userDataDir: ud });
  assert.strictEqual(g.granted, true);
  assert.strictEqual(c.isConsented("iris"), true);
  assert.strictEqual(c.consentState("iris").source, "existing-pairing");
  assert.strictEqual(make(ud).isConsented("iris"), true, "persisted in app-config.json");
});
t("(2) grandfather: no peers (missing, empty object, empty file) -> off", () => {
  for (const peers of [null, "{}", "", "[]"]) {
    const ud = mkUd(); if (peers !== null) writePeers(ud, peers); const c = make(ud);
    assert.strictEqual(gate.grandfather({ cfg: c, userDataDir: ud }).granted, false, String(peers));
    assert.strictEqual(c.isConsented("iris"), false);
  }
});
t("(3) grandfather: corrupt or malformed peers.json -> off (fail closed)", () => {
  for (const peers of ["{not json", "\u0000\u0000", JSON.stringify({ a: 5 }), JSON.stringify({ a: { id: "other" } }), JSON.stringify([{ id: "a" }]), "null"]) {
    const ud = mkUd(); writePeers(ud, peers); const c = make(ud);
    assert.strictEqual(gate.grandfather({ cfg: c, userDataDir: ud }).granted, false, peers);
    assert.strictEqual(c.isConsented("iris"), false);
  }
});
t("(4) existing config with iris.enabled but no consentAt and no peers -> needs consent; grandfather never overrides an existing iris section", () => {
  const ud = mkUd(); writeCfg(ud, { schema: 1, values: {}, iris: { enabled: true } }); const c = make(ud);
  assert.strictEqual(gate.grandfather({ cfg: c, userDataDir: ud }).granted, false);
  assert.strictEqual(c.feature("iris").reason, "consent needed");
  const ud2 = mkUd(); writePeers(ud2, PEER); writeCfg(ud2, { schema: 1, values: {}, iris: { enabled: false } }); const c2 = make(ud2);
  assert.strictEqual(gate.grandfather({ cfg: c2, userDataDir: ud2 }).granted, false, "a person who turned it off stays off");
  assert.strictEqual(c2.isConsented("iris"), false);
});
t("grandfather does not run from env or agent input: the only inputs are the on-disk pairing and an absent iris section", () => {
  const ud = mkUd(); const c = make(ud, { AGENT_DESKTOP_IRIS_GRANDFATHER: "1" });
  assert.strictEqual(gate.grandfather({ cfg: c, userDataDir: ud }).granted, false);
});
t("IPC: config-consent works only from the main window, shows the dialog, writes consent only on 'Turn on'; set-feature cannot consent", async () => {
  const handlers = {}; const ipcMain = { handle: (c, f) => { handlers[c] = f; } };
  const ud = mkUd(); const c = make(ud); const win = { webContents: { id: 1 }, isDestroyed: () => false };
  const shown = []; let answer = 1;
  const dialog = { showMessageBox: async (w, o) => { shown.push(o); return { response: answer }; }, showOpenDialog: async () => ({ canceled: true }) };
  setupMain.register({ ipcMain, dialog, cfg: c, features, getMainWindow: () => win, isTestMode: () => false, env: {} });
  const main = { sender: win.webContents }, other = { sender: { id: 2 } };
  assert.strictEqual((await handlers["config-consent"](other, { featureId: "iris" })).error, "not-allowed");
  assert.strictEqual((await handlers["config-consent"](main, { featureId: "argus" })).error, "invalid-arguments");
  assert.strictEqual((await handlers["config-consent"](main, { featureId: "iris" })).declined, true);
  assert.strictEqual(c.isConsented("iris"), false);
  assert.ok(/local network/.test(shown[0].detail) && /one-time code/.test(shown[0].detail) && /encrypted/i.test(shown[0].detail) && /on its own/.test(shown[0].detail));
  const sf = await handlers["config-set-feature"](main, { featureId: "iris", enabled: true });
  assert.strictEqual(sf.ok, true); assert.strictEqual(c.isConsented("iris"), false, "set-feature cannot consent");
  answer = 0;
  const ok = await handlers["config-consent"](main, { featureId: "iris" });
  assert.strictEqual(ok.ok, true); assert.strictEqual(c.isConsented("iris"), true); assert.strictEqual(c.consentState("iris").source, "setup-ui");
});
t("IPC: in test mode the consent answer comes from AGENT_DESKTOP_TEST_CONSENT_ANSWER, never from a normal instance", async () => {
  const handlers = {}; const ipcMain = { handle: (c, f) => { handlers[c] = f; } };
  const c = make(mkUd()); const win = { webContents: {}, isDestroyed: () => false }; let asked = 0;
  const dialog = { showMessageBox: async () => { asked++; return { response: 1 }; } };
  setupMain.register({ ipcMain, dialog, cfg: c, features, getMainWindow: () => win, isTestMode: () => false, env: { AGENT_DESKTOP_TEST_CONSENT_ANSWER: "yes" } });
  await handlers["config-consent"]({ sender: win.webContents }, { featureId: "iris" });
  assert.strictEqual(c.isConsented("iris"), false); assert.strictEqual(asked, 1);
});
t("stubs: while IRIS is off its channels answer 'off' and can be removed before the real handlers register", () => {
  const reg = {}; const ipcMain = { handle: (c, f) => { reg[c] = f; }, removeHandler: (c) => { delete reg[c]; } };
  gate.registerStubs(ipcMain); assert.strictEqual(reg["iris-status"]().ok, false); assert.ok(/Setup/.test(reg["iris-status"]().reason));
  assert.strictEqual(Object.keys(reg).length, gate.CHANNELS.length);
  gate.removeStubs(ipcMain); assert.strictEqual(Object.keys(reg).length, 0);
});
t("main.js starts IRIS only through the consent gate (static check)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const i = src.indexOf("function startIrisIfAllowed");
  assert.ok(i > 0 && /isConsented\("iris"\)/.test(src.slice(i, i + 400)));
  assert.strictEqual((src.match(/main-iris"\)\.init\(/g) || []).length, 1, "exactly one IRIS init call");
  assert.ok(src.indexOf('main-iris").init(') > i, "the init call sits inside the gated function");
});
t("the agent instructions say IRIS cannot be enabled by an agent", () => {
  assert.ok(/cannot be enabled by an agent/.test(features.agentInstructions(null, { generic: true })));
});
(async () => {
  for (const [name, fn] of tests) { n++; try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(n - fails + "/" + n + " passed");
  process.exit(fails ? 1 : 0);
})();
