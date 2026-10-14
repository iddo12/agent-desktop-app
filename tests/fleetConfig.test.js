// node tests/fleetConfig.test.js - Fleet + IRIS wording on the configuration layer (v1.121.0): src/fleetMain.js, fleetMailbox.configure, neutral and owner-computer settings.
// Temp folders only; no D:/E: paths, AGENT_DESKTOP_* unset.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
delete process.env.AGENT_DESKTOP_FLEET_DIR; delete process.env.AGENT_DESKTOP_IRIS_DIR;
const { createAppConfig } = require("../src/appConfig");
const features = require("../src/features");
const M = require("../src/fleetMailbox");
const fleetMain = require("../src/fleetMain");

let n = 0, fails = 0; const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleetcfg-"));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const day = () => { const x = new Date(), p = (v) => String(v).padStart(2, "0"); return x.getFullYear() + "-" + p(x.getMonth() + 1) + "-" + p(x.getDate()); };

// a cfg with an in-memory document (values/features) and the real registry
const mkCfg = (values, feats) => { const c = createAppConfig({ env: {}, initialDoc: { values: values || {}, features: feats || {} } }); c.setRegistry(features); return c; };
const mkIpc = (cfg, userData) => { const h = {}; fleetMain.register({ ipcMain: { handle: (ch, fn) => { h[ch] = fn; } }, cfg, userDataDir: userData, path }); return h; };

t("unconfigured: needs-setup everywhere, no listing, no reply, nothing touched", async () => {
  M.configure({}); const ud = tmp(), h = mkIpc(mkCfg(), ud);
  const s = await h["fleet-settings"]();
  assert.strictEqual(s.ok, true); assert.strictEqual(s.state, "needs-setup"); assert.strictEqual(s.role, ""); assert.strictEqual(s.deliveryMatch, "");
  for (const ch of ["fleet-list", "fleet-timeline", "fleet-read", "fleet-reply"]) { const r = await h[ch]({}, { text: "x" }); assert.strictEqual(r.ok, false, ch); assert.strictEqual(r.reason, "needs-setup", ch); }
  assert.deepStrictEqual(fs.readdirSync(ud), []); rm(ud);
});

t("neutral configuration on another root: default folder names, neutral wording, reply written without any person's name", async () => {
  const root = tmp(), ud = tmp();
  fs.mkdirSync(path.join(root, "to_me")); fs.mkdirSync(path.join(root, "from_me"));
  fs.writeFileSync(path.join(root, "to_me", day() + "_Helper_status-check.md"), "To: me. From: Helper.\n\nIs it done?\n");
  const h = mkIpc(mkCfg({ exchangeDir: root }), ud);
  const s = await h["fleet-settings"](); assert.strictEqual(s.state, "ready");
  const r = await h["fleet-timeline"]({}, { force: true }); assert.ok(r.ok && r.found && r.items.length === 1);
  assert.strictEqual(r.items[0].dir, "in");
  const w = await h["fleet-reply"]({}, { recipient: "", topic: "status check", text: "yes" });
  assert.ok(w.ok, JSON.stringify(w)); assert.ok(/^\d{4}-\d{2}-\d{2}_me_reply_status-check\.md$/.test(w.name), w.name);
  const txt = fs.readFileSync(path.join(root, "from_me", w.name), "utf8");
  assert.ok(txt.startsWith("To: the other side. From: this fleet (via Agent Desktop).\n"), txt);
  rm(root); rm(ud);
});

t("owner-computer settings reproduce the old behaviour (names, folders, file name, header, labels)", async () => {
  const root = tmp(), ud = tmp();
  const vals = { exchangeDir: root, exchangeInboxName: "to_Owner_fleet", exchangeOutboxName: "from_Owner_fleet", ownerName: "Alex", partnerName: "Sarah", leadRole: "COO", fleetLabel: "Sarah's side" };
  fs.mkdirSync(path.join(root, "to_Owner_fleet")); fs.mkdirSync(path.join(root, "from_Owner_fleet"));
  fs.writeFileSync(path.join(root, "to_Owner_fleet", day() + "_to-Security_check.md"), "To: Security. From: Sarah's COO.\n\nCan you confirm?\n");
  const h = mkIpc(mkCfg(vals), ud);
  const s = await h["fleet-settings"]();
  assert.deepStrictEqual([s.state, s.label, s.owner, s.partner, s.role], ["ready", "Sarah's side", "Alex", "Sarah", "COO"]);
  assert.ok(new RegExp(s.deliveryMatch, "i").test("COO Agent") && new RegExp(s.deliveryMatch, "i").test("coo") && !new RegExp(s.deliveryMatch, "i").test("Cooking"));
  const r = await h["fleet-list"]({}, { force: true }); assert.strictEqual(r.items[0].direction, "from Sarah");
  const w = await h["fleet-reply"]({}, { topic: "t", text: "ok" });
  assert.ok(/_Alex_reply_t\.md$/.test(w.name));
  assert.ok(fs.readFileSync(path.join(root, "from_Owner_fleet", w.name), "utf8").startsWith("To: Sarah's COO. From: Alex (via Agent Desktop).\n"));
  rm(root); rm(ud);
});

t("a feature turned off answers off; AGENT_DESKTOP_FLEET_DIR still works as the sandbox override", async () => {
  M.configure({}); const ud = tmp();
  const h = mkIpc(mkCfg({}, { fleet: { enabled: false } }), ud); assert.strictEqual((await h["fleet-settings"]()).state, "off");
  const root = tmp(); fs.mkdirSync(path.join(root, "to_me")); process.env.AGENT_DESKTOP_FLEET_DIR = root;
  try { const h2 = mkIpc(mkCfg(), ud); assert.strictEqual((await h2["fleet-settings"]()).state, "ready"); const r = await h2["fleet-list"]({}, { force: true }); assert.ok(r.ok); } finally { delete process.env.AGENT_DESKTOP_FLEET_DIR; }
  rm(root); rm(ud);
});

t("the fleet and iris features are wired and need only what they declare; IRIS stays consent-gated", () => {
  assert.strictEqual(features.get("fleet").wired, true); assert.strictEqual(features.get("iris").wired, true);
  const c = mkCfg({ exchangeDir: os.tmpdir() }); assert.strictEqual(c.feature("fleet").state, "ready");
  assert.strictEqual(features.get("iris").kind, "consent"); assert.strictEqual(mkCfg().feature("iris").state, "off");
});

t("renderer: needs-setup state offers Set up, nothing is requested while not set up", () => {
  const s = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "fleet-pane.js"), "utf8");
  assert.ok(/setupNote/.test(s) && /setupView\.open/.test(s) && /if \(!usable\(\)\) return Promise\.resolve\(false\)/.test(s) && /api\.settings/.test(s));
  const i = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "iris.js"), "utf8");
  assert.ok(/findLead/.test(i) && !/findCoo/.test(i) && /if \(!lead\.match\) return null/.test(i));
});

(async () => {
  for (const [name, fn] of tests) { n++; try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + (e && e.stack)); } }
  console.log(n - fails + "/" + n + " passed"); process.exit(fails ? 1 : 0);
})();
