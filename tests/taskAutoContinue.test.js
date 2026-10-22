// node tests/taskAutoContinue.test.js - the Task List "always continue" switch (src/taskAutoContinue.js) and its use by the keep-going glue.
// In-memory fake file system only: no real shared_tools / task store is touched.
"use strict";
const assert = require("assert");
const TA = require("../src/taskAutoContinue");
const K = require("../src/keepGoing");
const G = require("../src/keepGoingGlue");

let n = 0, fails = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

const TOOL = "X:\\ws\\shared_tools\\tasks\\tasks.py";
const GLOBAL = "X:\\ws\\shared_reports\\task_list_settings.json";
const STORE = (a) => "X:\\ws\\shared_reports\\tasks\\" + a + ".json";
const mkfs = (files) => ({ readFileSync: (f) => { if (!(f in files)) throw new Error("ENOENT " + f); return files[f]; } });
let clock = 1000;
const call = (files, agent, extra) => TA.autoContinueFor(Object.assign({ tasksTool: TOOL, agentName: agent || "Security", fsImpl: mkfs(files), now: () => clock }, extra || {}));
const fresh = () => { TA.clearCache(); clock += 1e6; };

t("workspace is derived from the task tool path, three levels up", () => {
  assert.strictEqual(TA.workspaceOf(TOOL), "X:\\ws");
  assert.strictEqual(TA.workspaceOf("/home/u/ws/shared_tools/tasks/tasks.py"), "/home/u/ws");
  assert.strictEqual(TA.workspaceOf("tasks.py"), null);
  assert.strictEqual(TA.workspaceOf(null), null);
});
t("agent name is the folder name (full path, either slash, trailing slash)", () => {
  assert.strictEqual(TA.folderName("D:\\a\\Security"), "Security");
  assert.strictEqual(TA.folderName("D:/a/Security/"), "Security");
  assert.strictEqual(TA.folderName("Security"), "Security");
  assert.strictEqual(TA.folderName(""), null);
});
t("agent switch on -> true; other agent -> false", () => {
  fresh(); const f = { [STORE("Security")]: JSON.stringify({ items: [], settings: { autoContinue: true } }) };
  assert.strictEqual(call(f, "Security"), true);
  assert.strictEqual(call(f, "Other"), false);
});
t("global switch on -> true for any agent", () => {
  fresh(); const f = { [GLOBAL]: JSON.stringify({ autoContinue: true }) };
  assert.strictEqual(call(f, "Anyone"), true);
});
t("both off / absent flag -> false", () => {
  fresh(); const f = { [GLOBAL]: JSON.stringify({ autoContinue: false }), [STORE("Security")]: JSON.stringify({ settings: { autoContinue: false } }) };
  assert.strictEqual(call(f), false);
  fresh(); assert.strictEqual(call({ [STORE("Security")]: "{}" }), false);
});
t("only a real boolean true counts (no truthy strings)", () => {
  fresh(); assert.strictEqual(call({ [GLOBAL]: JSON.stringify({ autoContinue: "yes" }) }), false);
  fresh(); assert.strictEqual(call({ [STORE("Security")]: JSON.stringify({ settings: { autoContinue: 1 } }) }), false);
});
t("missing files / corrupt JSON / non-object / bad inputs fail closed", () => {
  fresh(); assert.strictEqual(call({}), false);
  fresh(); assert.strictEqual(call({ [GLOBAL]: "{not json", [STORE("Security")]: "[1,2" }), false);
  fresh(); assert.strictEqual(call({ [GLOBAL]: "[true]", [STORE("Security")]: "null" }), false);
  fresh(); assert.strictEqual(TA.autoContinueFor({ tasksTool: null, agentName: "Security", fsImpl: mkfs({}) }), false);
  fresh(); assert.strictEqual(TA.autoContinueFor({ tasksTool: TOOL, agentName: "", fsImpl: mkfs({}) }), false);
  fresh(); assert.strictEqual(TA.autoContinueFor(), false);
  fresh(); assert.strictEqual(call({}, "Security", { fsImpl: { readFileSync: () => { throw new Error("boom"); } } }), false);
  fresh(); assert.strictEqual(call({}, "Security", { now: () => { throw new Error("clock"); } }), false);
});
t("a corrupt global file does not hide the agent's own switch", () => {
  fresh(); assert.strictEqual(call({ [GLOBAL]: "garbage", [STORE("Security")]: JSON.stringify({ settings: { autoContinue: true } }) }), true);
});
t("BOM is tolerated (tasks.py reads utf-8-sig)", () => {
  fresh(); assert.strictEqual(call({ [GLOBAL]: "\uFEFF" + JSON.stringify({ autoContinue: true }) }), true);
  fresh(); assert.strictEqual(call({ [STORE("Security")]: "\uFEFF" + JSON.stringify({ settings: { autoContinue: true } }) }), true);
});
t("cache: a change is not seen within the TTL, is seen after it", () => {
  fresh(); const files = { [GLOBAL]: JSON.stringify({ autoContinue: false }) };
  assert.strictEqual(call(files), false);
  files[GLOBAL] = JSON.stringify({ autoContinue: true });
  clock += TA.TTL_MS - 1000; assert.strictEqual(call(files), false, "cached");
  clock += 2000; assert.strictEqual(call(files), true, "expired");
});
t("cache: the disk is not read again within the TTL", () => {
  fresh(); let reads = 0; const fsImpl = { readFileSync: () => { reads++; throw new Error("ENOENT"); } };
  call({}, "Security", { fsImpl }); const first = reads; call({}, "Security", { fsImpl }); call({}, "Security", { fsImpl });
  assert.strictEqual(reads, first);
});

// ---- glue integration
const iso = (ms) => new Date(ms).toISOString();
const asst = (ts, text) => JSON.stringify({ type: "assistant", timestamp: iso(ts), message: { content: [{ type: "text", text }] } });
const usr = (ts, text) => JSON.stringify({ type: "user", timestamp: iso(ts), message: { content: text } });
function world(extra) {
  const w = Object.assign({ t: Date.parse("2026-10-22T12:00:00Z"), lines: [], sent: [], auto: false, throttle: null, hard: false, saved: null }, extra || {});
  w.g = G.create({
    now: () => w.t, log: () => {}, emit: () => {}, agents: () => ["A"], ctx: () => ({ ownerName: "Alex", tasksTool: TOOL }),
    readTail: () => ({ text: w.lines.join("\n"), partialFirst: false, sig: "s" + w.lines.length + w.t }),
    isWorking: () => false, getHalt: () => null, isPaused: () => false,
    deliver: async (p, text) => { w.sent.push(text); return { delivered: true, via: "channel" }; },
    readThrottle: () => w.throttle, usageHardStop: () => w.hard, taskAutoContinue: (p) => w.auto, limits: { warmupMs: 0 },
    readFile: () => "", storage: { load: () => w.saved, save: (o) => { w.saved = JSON.parse(JSON.stringify(o)); } },
  });
  return w;
}
const tick = async (w) => { w.g.tick(); await new Promise((r) => setImmediate(r)); };
const DONE = "Finished item 1.\n\nDONE: item 1 is complete";

t("glue: Task List switch makes relentless true and a DONE gets the next-project nudge", async () => {
  const w = world({ auto: true });
  w.lines = [usr(w.t - 400000, "go"), asst(w.t - 300000, DONE)];
  assert.strictEqual(w.g.relentlessFor("A"), true);
  await tick(w);
  assert.strictEqual(w.sent.length, 1);
  assert.ok(/\[next-project\]/.test(w.sent[0]));
  const s = w.g.snapshot("A");
  assert.strictEqual(s.autoContinue, true); assert.strictEqual(s.relentless, true); assert.strictEqual(s.agentRelentless, false); assert.strictEqual(s.fleetRelentless, false);
});
t("glue: switch off -> plain mode, DONE is not nudged, autoContinue false", async () => {
  const w = world({ auto: false });
  w.lines = [usr(w.t - 400000, "go"), asst(w.t - 300000, DONE)];
  await tick(w);
  assert.strictEqual(w.sent.length, 0);
  assert.strictEqual(w.g.snapshot("A").autoContinue, false); assert.strictEqual(w.g.relentlessFor("A"), false);
});
t("glue: the app's own relentless toggle still works; OFF is overridden only while the Task List switch is on", () => {
  const w = world({ auto: false });
  w.g.setRelentless("A", true); assert.strictEqual(w.g.relentlessFor("A"), true);
  w.g.setRelentless("A", false); assert.strictEqual(w.g.relentlessFor("A"), false);
  w.auto = true; assert.strictEqual(w.g.relentlessFor("A"), true);
  assert.deepStrictEqual(w.g.getSettings().relentless, { fleet: false, agents: [] }); // nothing persisted by the Task List source
});
t("glue: a throwing dep fails closed", () => {
  const g = G.create({ now: Date.now, agents: () => [], taskAutoContinue: () => { throw new Error("x"); }, storage: { load: () => ({}), save() {} } });
  assert.strictEqual(g.relentlessFor("A"), false);
});
t("glue: usage hard stop still wins over the Task List switch", async () => {
  const w = world({ auto: true, hard: true });
  w.lines = [usr(w.t - 400000, "go"), asst(w.t - 300000, DONE)];
  await tick(w);
  assert.strictEqual(w.sent.length, 0);
});
t("glue: CPU guard hold still wins over the Task List switch", async () => {
  const w = world({ auto: true, throttle: "CPUHOLD" });
  w.lines = [usr(w.t - 400000, "go"), asst(w.t - 300000, DONE)];
  await tick(w);
  assert.strictEqual(w.sent.length, 0);
});
t("glue: usage-throttle HOLD alone does not stop relentless mode (v1.74.3 rule, unchanged)", async () => {
  const w = world({ auto: true, throttle: "HOLD" });
  w.lines = [usr(w.t - 400000, "go"), asst(w.t - 300000, DONE)];
  await tick(w);
  assert.strictEqual(w.sent.length, 1);
});
t("glue: resume text after a handoff is the relentless one when only the Task List switch is on", () => {
  const w = world({ auto: true });
  const r = w.g.resumeText("A", "P");
  assert.strictEqual(r.mission, true); assert.ok(/keep-working-regardless/.test(r.text));
});

// ---- text
t("mode paragraph has the --start / --working / --close / --board sentence when the task tool is known", () => {
  const p = K.texts({ ownerName: "Alex", tasksTool: TOOL }).nextProject;
  assert.ok(p.includes("--start <ID>")); assert.ok(p.includes("--working <ID> --note")); assert.ok(p.includes("--close")); assert.ok(p.includes("--board"));
  assert.ok(p.includes('"not started"')); assert.ok(p.includes("NOTHING-LEFT"));
});
t("no task tool: the sentence is absent and the neutral text is unchanged", () => {
  assert.ok(!K.NEXT_PROJECT_TEXT.includes("--start"));
  assert.ok(!K.texts({ ownerName: "Alex" }).nextProject.includes("--start"));
});

(async () => {
  for (const [name, fn] of queue) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } }
  console.log((n - fails) + "/" + n + " taskAutoContinue tests passed");
  process.exit(fails ? 1 : 0);
})();
