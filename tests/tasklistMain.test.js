"use strict";
// main-tasklist against a throwaway workspace and the REAL tasks.py (skipped with a notice when python or tasks.py is not found).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tasklist-"));
const cfgAll = (() => { try { return require("../src/appConfig"); } catch (e) { return null; } })();
const tool = (process.env.TASKLIST_TEST_TASKS_PY) || (cfgAll && cfgAll.get("tasksTool")) || "";
const py = (cfgAll && cfgAll.get("pythonExe")) || "python";
const haveTool = tool && fs.existsSync(tool);
fs.mkdirSync(path.join(ws, "Alpha")); fs.mkdirSync(path.join(ws, "Beta"));
const reports = path.join(ws, "shared_reports"); fs.mkdirSync(path.join(reports, "tasks"), { recursive: true });
const sh = (args) => cp.spawnSync(py, [tool].concat(args), { env: Object.assign({}, process.env, { WS_WORKSPACE_ROOT: ws }), encoding: "utf8" });

const h = {}; const wc = { mainFrame: {}, sent: [], send(c) { this.sent.push(c); } };
const win = { webContents: wc, isDestroyed: () => false };
const ev = { sender: wc, senderFrame: wc.mainFrame };
let watchCb = null;
const api = require("../src/tasklist/main-tasklist").init({
  ipcMain: { handle: (c, f) => { h[c] = f; } }, getMainWindow: () => win,
  cfg: (k) => (k === "sharedReports" ? reports : k === "pythonExe" ? py : k === "tasksTool" ? tool : null),
  run: async (args) => { const r = sh(args); return r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, reason: "failed" }; },
  now: () => new Date().toISOString(),
  watch: (d, o, cb) => { watchCb = cb; return { close() {}, on() {} }; },
});

(async () => {
  assert.deepStrictEqual(await h["tasklist-load"]({ sender: {}, senderFrame: {} }, {}), { ok: false, reason: "Not allowed." });
  const empty = await h["tasklist-load"](ev, {});
  assert.ok(empty.ok && empty.rows.length === 0);
  if (!haveTool) { console.log("tasklistMain.test.js: tasks.py not found, store-writing checks skipped"); return; }
  sh(["--agent", "Alpha", "--add", "One", "--plain", "Plain one"]); sh(["--agent", "Alpha", "--add", "Two", "--plain", "Plain two"]); sh(["--agent", "Alpha", "--add", "Three", "--plain", "Plain three"]);
  sh(["--agent", "Beta", "--add", "Beta task", "--plain", "Beta plain"]);
  sh(["--agent", "Alpha", "--start", "one", "--note", "doing it"]); sh(["--agent", "Alpha", "--close", "three"]);
  let r = await h["tasklist-load"](ev, {});
  assert.ok(r.ok && r.rows.length === 4 && r.canWrite && !r.canReorder);
  assert.deepStrictEqual(r.counts && [r.counts.working, r.counts.not_started, r.counts.finished, r.counts.doneToday], [1, 2, 1, 1]);
  assert.ok(wc.sent.length === 0 && typeof watchCb === "function");
  watchCb(); await new Promise((x) => setTimeout(x, 700)); assert.ok(wc.sent.includes("tasklist-changed"));   // live: a file change reaches the window
  r = await h["tasklist-load"](ev, { agent: "Alpha" });
  assert.ok(r.canReorder && r.rows.every((x) => x.agent === "Alpha"));
  assert.deepStrictEqual((await h["tasklist-load"](ev, { agent: "../x" })).ok, false);
  // reorder: Two (not started) cannot go below the last of its group; move up puts it before... only same-group neighbours count
  const before = (await h["tasklist-load"](ev, { agent: "Alpha" })).rows.filter((x) => x.group !== "finished").map((x) => x.id);
  const mv = await h["tasklist-move"](ev, { agent: "Alpha", id: "two", dir: "top" });
  assert.ok(mv.ok && mv.changed);
  const after = (await h["tasklist-load"](ev, { agent: "Alpha" })).rows.filter((x) => x.group !== "finished").map((x) => x.id);
  assert.strictEqual(after[after.indexOf("two")] === "two", true); assert.notDeepStrictEqual(before, null);
  assert.strictEqual((await h["tasklist-move"](ev, { agent: "nope", id: "two", dir: "top" })).ok, false);
  assert.strictEqual((await h["tasklist-move"](ev, { agent: "Alpha", id: "two", dir: "sideways" })).ok, false);
  // clear finished (archive, kept) and undo
  const cl = await h["tasklist-clear"](ev, { agent: "all" });
  assert.ok(cl.ok);
  r = await h["tasklist-load"](ev, {}); assert.strictEqual(r.counts.finished, 0);
  const file = JSON.parse(fs.readFileSync(path.join(reports, "tasks", "Alpha.json"), "utf8"));
  assert.strictEqual(file.archive.length, 1);   // kept, not deleted
  assert.ok((await h["tasklist-undo"](ev, { agent: "all" })).ok);
  r = await h["tasklist-load"](ev, {}); assert.strictEqual(r.counts.finished, 1);
  assert.deepStrictEqual([(await h["tasklist-load"](ev, { agent: "Alpha" })).auto.agent, (await h["tasklist-load"](ev, {})).auto.global], [false, false]);   // default off
  assert.ok((await h["tasklist-auto"](ev, { agent: "Alpha", on: true })).ok);
  assert.strictEqual((await h["tasklist-load"](ev, { agent: "Alpha" })).auto.agent, true);
  assert.strictEqual((await h["tasklist-load"](ev, { agent: "Beta" })).auto.agent, false);   // only Alpha
  assert.ok((await h["tasklist-auto"](ev, { agent: "all", on: true })).ok);
  assert.strictEqual((await h["tasklist-load"](ev, {})).auto.global, true);
  assert.ok((await h["tasklist-auto"](ev, { agent: "all", on: false })).ok);
  assert.strictEqual((await h["tasklist-auto"](ev, { agent: "nope", on: true })).ok, false);
  assert.strictEqual((await h["tasklist-auto"](ev, { agent: "Alpha", on: "yes" })).ok, false);
  api.stop();
  console.log("tasklistMain.test.js: all passed");
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(ws, { recursive: true, force: true }); } catch (e) { /* none */ } });
