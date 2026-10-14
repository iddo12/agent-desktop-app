// node tests/dailyConfig.test.js - My Daily on the configuration layer (v1.121.0): unconfigured state, a configured temp root, the old data
// location, the owner's migration config reproducing every old literal, wording of messages to agents, and the migration tool.
// All paths are temp folders; the only Windows paths are the parity fixture values (test data).
"use strict";
const LK = require("../src/legacyKeys").KEYS;
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { createAppConfig } = require("../src/appConfig");
const features = require("../src/features");
const dailyConfig = require("../src/daily/dailyConfig");
const D = require("../src/daily/main-daily");
const DM = require("../src/daily/decisions-model");
const TM = require("../src/daily/triage-model");
const M = require("../src/daily/model");
const { cfgFor } = require("./helpers/dailyCfg");

let n = 0, fails = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dailycfg-"));
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const WIN = { webContents: { id: 1 } }, EV = { sender: WIN.webContents };

// a configuration with nothing set, in its own userData folder, no environment
function bare(extraDoc) {
  const ud = mk("ud-" + Math.random().toString(36).slice(2));
  if (extraDoc) fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify(extraDoc));
  const c = createAppConfig({ userDataDir: ud, env: {} });
  c.setRegistry(features);
  return { c, ud };
}

t("unconfigured: nothing points anywhere, the task list says so calmly, the rest has sane neutral defaults", () => {
  const { c, ud } = bare();
  const dc = dailyConfig.create({ cfg: c, userDataDir: ud });
  assert.strictEqual(dc.dataDir(), path.join(ud, "daily"), "a fresh install keeps its data in userData");
  assert.strictEqual(dc.taskDir(), null);
  const ts = dc.tasks();
  assert.strictEqual(ts.read, false); assert.strictEqual(ts.edit, false); assert.ok(/Setup/.test(ts.reason));
  assert.strictEqual(dc.run(), null);
  assert.strictEqual(dc.mailFeedFile(), null); assert.strictEqual(dc.mailRulesFile(), null); assert.strictEqual(dc.gmailExportFile(), null);
  assert.strictEqual(dc.ownDomains(), null);
  assert.strictEqual(dc.hasPartner(), false); assert.strictEqual(dc.sharePartnerDefault(), false, "sharing is OFF for a fresh install");
  const w = dc.who();
  assert.strictEqual(w.name, "The user"); assert.strictEqual(w.by, "the user"); assert.strictEqual(w.obj, "them");
  assert.strictEqual(c.isReady("myDaily"), true, "My Daily needs no folder, so the tile is ready");
});

t("data folder: daily.dataDir wins, then an existing <userData>/daily, then the old <agents folder>/daily (nothing lost), then <userData>/daily", () => {
  const agents = mk("agents-a"); const ud = mk("ud-a"); mk("agents-a", "daily");
  fs.writeFileSync(path.join(agents, "daily", "settings.json"), "{}");
  const mkcfg = (daily) => { fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify({ schema: 1, values: { agentsRoot: agents, workspaceRoot: agents }, features: {}, daily })); const c = createAppConfig({ userDataDir: ud, env: {} }); c.setRegistry(features); return c; };
  assert.strictEqual(dailyConfig.create({ cfg: mkcfg(undefined), userDataDir: ud }).dataDir(), path.join(agents, "daily"), "old location is used while the new one is absent");
  mk("ud-a", "daily");
  assert.strictEqual(dailyConfig.create({ cfg: mkcfg(undefined), userDataDir: ud }).dataDir(), path.join(ud, "daily"), "the new one wins once it exists");
  const pinned = mk("pinned");
  assert.strictEqual(dailyConfig.create({ cfg: mkcfg({ dataDir: pinned }), userDataDir: ud }).dataDir(), pinned, "daily.dataDir pins it");
  assert.strictEqual(dailyConfig.create({ cfg: mkcfg({ dataDir: "relative/x" }), userDataDir: ud }).dataDir(), path.join(ud, "daily"), "a bad value is ignored");
});

t("the old location keeps working end to end: settings.json written by an older version is read, and written back to the same place", async () => {
  const agents = mk("agents-b"); const ud = mk("ud-b"); const old = mk("agents-b", "daily");
  fs.writeFileSync(path.join(old, "settings.json"), JSON.stringify({ [LK.shareSetting]: false }));
  fs.writeFileSync(path.join(old, "appointments.json"), JSON.stringify({ items: [{ id: "a1", title: "Dentist", who: "Dentist", start: Date.now() + 86400000, end: Date.now() + 90000000, [LK.shareItem]: false, cal: "owner", own: true }] }));
  fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify({ schema: 1, values: { agentsRoot: agents, workspaceRoot: agents }, features: {}, daily: { sharePartnerDefault: true }, ownerName: undefined }));
  const c = createAppConfig({ userDataDir: ud, env: {} }); c.setRegistry(features);
  const h = {};
  D.init({ ipcMain: { handle: (ch, f) => { h[ch] = f; } }, cfg: c, dataDir: ud, getMainWindow: () => WIN, testMode: false, log: () => {} });
  const r = await h["daily-load"](EV, {});
  assert.strictEqual(r.settings[LK.shareSetting], false, "the stored value beats the default");
  assert.strictEqual(r.data.events.filter((e) => e.own).length, 1, "the old appointment is still there");
  assert.strictEqual(r.data.events.find((e) => e.own).cal, "owner", "stored calendar id is untouched");
  await h["daily-settings-set"](EV, { [LK.shareSetting]: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(old, "settings.json"), "utf8"))[LK.shareSetting], true, "written back to the old place");
  assert.ok(!fs.existsSync(path.join(ud, "daily")), "no second copy was made in userData");
});

t("unconfigured through the IPC handlers: load works with the task list off, task writes answer needs-setup, nothing throws", async () => {
  const { c, ud } = bare();
  const h = {};
  D.init({ ipcMain: { handle: (ch, f) => { h[ch] = f; } }, cfg: c, dataDir: ud, getMainWindow: () => WIN, testMode: false, log: () => {} });
  const r = await h["daily-load"](EV, {});
  assert.ok(!r.error && r.data, "loads");
  assert.strictEqual(r.taskSource, "missing"); assert.deepStrictEqual(r.data.tasks, []);
  assert.strictEqual(r.capabilities.tasks.read, false); assert.strictEqual(r.capabilities.tasks.edit, false);
  assert.strictEqual(r.people.hasPartner, false); assert.strictEqual(r.people.partnerName, null);
  assert.strictEqual(r.settings[LK.shareSetting], false);
  const add = await h["daily-task-add"](EV, { title: "Call the plumber", agent: "Personal", area: "Personal", priority: 5 });
  assert.deepStrictEqual({ ok: add.ok, reason: add.reason }, { ok: false, reason: "needs-setup" });
  const dec = await h["daily-decisions-load"](EV, {});
  assert.strictEqual(dec.ok, true); assert.strictEqual(dec.open.length, 0);
  const tri = await h["daily-triage-load"](EV, {});
  assert.strictEqual(tri.ok, true);
  // the rest of My Daily still works: a shopping list and an appointment
  assert.strictEqual((await h["daily-shopping-create-list"](EV, { name: "Groceries" })).ok, true);
  const ap = await h["daily-appointment-save"](EV, { who: "Dentist", start: Date.now() + 86400000 });
  assert.strictEqual(ap.ok, true);
  const again = await h["daily-load"](EV, { force: true });
  assert.strictEqual(again.data.events.find((e) => e.own)[LK.shareItem], false, "no partner: an appointment is not shared by default");
  assert.ok(fs.existsSync(path.join(ud, "daily", "shopping.json")), "data landed in userData/daily");
});

t("a change made in Setup shows on the very next read (no 60 s wait): the task list turns on, the names appear", async () => {
  const { c, ud } = bare();
  const h = {};
  D.init({ ipcMain: { handle: (ch, f) => { h[ch] = f; } }, cfg: c, dataDir: ud, getMainWindow: () => WIN, testMode: false, log: () => {} });
  const before = await h["daily-load"](EV, {});
  assert.strictEqual(before.capabilities.tasks.read, false); assert.strictEqual(before.people.ownerName, null);
  const ws = mk("ws-live"); mk("ws-live", "shared_reports", "tasks"); mk("ws-live", "tools");
  fs.writeFileSync(path.join(ws, "tools", "py.exe"), ""); fs.writeFileSync(path.join(ws, "tools", "tasks.py"), "");
  assert.strictEqual(c.setMany({ workspaceRoot: ws, pythonExe: path.join(ws, "tools", "py.exe"), tasksTool: path.join(ws, "tools", "tasks.py"), ownerName: "Dana" }).ok, true);
  const after = await h["daily-load"](EV, {});
  assert.deepStrictEqual(after.capabilities.tasks, { read: true, edit: true, reason: "" });
  assert.strictEqual(after.people.ownerName, "Dana");
});

t("switched off in Setup: daily-load answers needs-setup", async () => {
  const { c, ud } = bare();
  c.setFeature("myDaily", { enabled: false });
  const h = {};
  D.init({ ipcMain: { handle: (ch, f) => { h[ch] = f; } }, cfg: c, dataDir: ud, getMainWindow: () => WIN, testMode: false, log: () => {} });
  assert.deepStrictEqual(await h["daily-load"](EV, {}), { ok: false, reason: "needs-setup" });
});

t("configured temp root: tasks are read from sharedReports/tasks, and python plus tasks.py are found from configuration", async () => {
  const root = mk("root-c");
  mk("root-c", "shared_reports", "tasks");
  fs.writeFileSync(path.join(root, "shared_reports", "tasks", "Alpha.json"), JSON.stringify({ agent: "Alpha", items: [{ id: "1", title: "T", status: "open", priority: 2, [LK.needs]: true, created: new Date().toISOString() }] }));
  const c = cfgFor(root, { tools: true });
  const dc = dailyConfig.create({ cfg: c, userDataDir: null });
  assert.strictEqual(dc.taskDir(), path.join(root, "shared_reports", "tasks"));
  const ts = dc.tasks(); assert.strictEqual(ts.read, true); assert.strictEqual(ts.edit, true);
  assert.deepStrictEqual(Object.keys(dc.run()).sort(), ["python", "tool"]);
  const h = {};
  D.init({ ipcMain: { handle: (ch, f) => { h[ch] = f; } }, cfg: c, getMainWindow: () => WIN, testMode: false, log: () => {} });
  const r = await h["daily-load"](EV, {});
  assert.strictEqual(r.data.tasks.length, 1); assert.strictEqual(r.summary.tasksNeed, 1);
  assert.deepStrictEqual(r.capabilities.tasks, { read: true, edit: true, reason: "" });
  assert.strictEqual(r.badge.count, 1);
});

t("the neutral alias needsUser works as the stored flag too (stored name unchanged)", () => {
  const mapped = M.mapTaskStores([{ agent: "A", items: [{ id: "1", title: "x", status: "open", needsUser: true }, { id: "2", title: "y", status: "open", [LK.needs]: true }, { id: "3", title: "z", status: "open" }] }], Date.now());
  assert.deepStrictEqual(mapped.map((x) => x.status).sort(), ["needs", "needs", "working"]);
  assert.ok(mapped.every((x) => LK.needs in x), "mapped tasks keep the contract field name");
});

t("fresh install: the same messages are neutral (no name, they/them)", () => {
  const { c, ud } = bare();
  const w = dailyConfig.create({ cfg: c, userDataDir: ud }).who();
  const msg = TM.recommendRequest({ title: "X", taskId: "1" }, w);
  assert.ok(msg.startsWith("The user asks for your recommendation on this task that is waiting for them: X"));
  assert.ok(msg.includes("(they read them as a card)") && msg.includes("the one question or action you need from them"));
  assert.strictEqual(DM.messageFor({ title: "X", taskId: "1" }, "go", "", w).split("\n")[0], "The user answered GO to: X");
});
t("with a name and no pronouns the wording stays neutral but uses the name", () => {
  const { c, ud } = bare({ schema: 1, values: { ownerName: "Dana" }, features: {} });
  const w = dailyConfig.create({ cfg: c, userDataDir: ud }).who();
  assert.strictEqual(w.name, "Dana"); assert.strictEqual(w.poss, "Dana's");
  assert.ok(TM.noteFor("yes", "", "sent", w).startsWith("Dana answered via My Daily Tasks"));
});

t("appConfig keeps the daily block when it rewrites the file", () => {
  const { c, ud } = bare({ schema: 1, values: {}, features: {}, daily: { ownerPronouns: "he" } });
  assert.strictEqual(c.set("ownerName", "Dana").ok, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ud, "app-config.json"), "utf8")).daily.ownerPronouns, "he");
});

(async () => {
  for (const [name, fn] of queue) {
    n++;
    try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); }
  }
  console.log(n - fails + "/" + n + " passed");
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})();
