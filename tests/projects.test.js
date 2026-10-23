// node tests/projects.test.js - PROJECTS tab (Project Autopilot, v1.138.0): the pure rules (faithful port of project.py derive, light/label/reason, burn-up
// and projection, sorting), disk reads (damaged files, retries on a transient failure, last-good cache, slug safety), the IPC handlers (main-window only,
// writes only through the tool, refusal wording), and the static privacy / wiring / design guards. Writes only into temp folders.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const L = require("../src/projects/projectsLogic");
const MP = require("../src/projects/main-projects");

let n = 0, fails = 0; const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const SRC = path.join(__dirname, "..", "src");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "projects-test-"));
const NOW = new Date(2026, 9, 23, 12, 0, 0);
const iso = (d) => new Date(d).toISOString();
const daysAgo = (k) => iso(NOW.getTime() - k * 86400000);

function proj(over) {
  return Object.assign({
    slug: "demo", name: "Demo project", owner: "Software Engineering Agent", status: "active", created: daysAgo(4), green_lit_at: daysAgo(4),
    budget: { pct_of_week: 2, signed_by: "System Optimization & Maintenance Agent", signed_at: daysAgo(4) },
    milestones: [
      { id: "M1", title: "First", planned_date: "2026-10-24", done_checklist: [{ text: "a", done: true, verified_by: "QA", verified_at: daysAgo(1) }, { text: "b", done: false }] },
      { id: "M2", title: "Second", planned_date: "2026-10-26", done_checklist: [] },
    ],
    tasks: [
      { id: "T1", title: "Build it", milestone: "M1", status: "done", done_ts: daysAgo(2), after: [] },
      { id: "T2", title: "Test it", milestone: "M2", status: "open", after: ["T1"] },
      { id: "T3", title: "Ship it", milestone: "M2", status: "open", after: ["T2"] },
    ],
    questions: [],
  }, over || {});
}
const EV = [{ ts: daysAgo(3), agent: "COO", kind: "progress", text: "started" }, { ts: daysAgo(1), agent: "Optimization", kind: "cost", text: "day 1", pct_week: 0.5 }];
function write(root, p, evs, raw) {
  const d = path.join(root, p.slug); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "project.json"), raw != null ? raw : JSON.stringify(p));
  if (evs) fs.writeFileSync(path.join(d, "events.jsonl"), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

// ------------------------------------------------------------------ rules
t("pyRound is Python's banker's rounding", () => {
  assert.strictEqual(L.pyRound(0.5, 0), 0); assert.strictEqual(L.pyRound(1.5, 0), 2); assert.strictEqual(L.pyRound(2.5, 0), 2); assert.strictEqual(L.pyRound(33.333, 0), 33); assert.strictEqual(L.pyRound(0.1234, 3), 0.123);
});
t("derive: milestone %, ready tasks, spend, light", () => {
  const d = L.derive(proj(), EV);
  assert.deepStrictEqual([d.tasks_total, d.tasks_done, d.ready, d.spent_pct_week, d.budget_pct_week, d.light], [3, 1, ["T2"], 0.5, 2, "green"]);
  assert.deepStrictEqual(d.milestones.map((m) => m.pct), [67, 0]);   // M1: 1 ticked + 1 task done of 3 units (round 66.67)
  assert.strictEqual(d.last_activity, EV[1].ts);
});
t("derive: red for a task that needs Iddo, an irreversible question, a used-up budget; amber for the rest", () => {
  const p1 = proj(); p1.tasks[1].status = "blocked"; p1.tasks[1].block_needs = "iddo"; p1.tasks[1].block_reason = "needs login"; p1.tasks[1].block_ts = daysAgo(1);
  assert.deepStrictEqual([L.derive(p1, []).light, L.derive(p1, []).red_reason], ["red", "needs login"]);
  const p2 = proj({ questions: [{ id: "Q1", text: "Spend?", status: "open", irreversible: true }] });
  assert.strictEqual(L.derive(p2, []).red_reason, "Spend?");
  assert.strictEqual(L.derive(proj({ questions: [{ id: "Q1", text: "x", status: "open" }] }), []).light, "amber");
  assert.strictEqual(L.derive(proj(), [{ ts: daysAgo(1), kind: "cost", pct_week: 2 }]).red_reason, "budget used up");
  const p3 = proj(); p3.tasks[1].status = "blocked"; p3.tasks[1].block_needs = "agent"; assert.strictEqual(L.derive(p3, []).light, "amber");
});
t("viewOf: labels and reasons", () => {
  const v = L.viewOf({ project: proj(), events: EV }, NOW);
  assert.ok(["MOVING", "LATE"].some((x) => v.card.label.startsWith(x)), v.card.label);
  assert.strictEqual(L.viewOf({ project: proj({ status: "draft" }), events: [] }, NOW).card.label, "DRAFT · NOT STARTED");
  assert.strictEqual(L.viewOf({ project: proj({ status: "done" }), events: [] }, NOW).card.label, "DONE");
  assert.strictEqual(L.viewOf({ project: proj({ status: "cancelled" }), events: [] }, NOW).card.light, "grey");
  const blocked = proj(); blocked.tasks[1].status = "blocked"; blocked.tasks[1].block_needs = "iddo"; blocked.tasks[1].block_reason = "needs login"; blocked.tasks[1].block_ts = daysAgo(2);
  const b = L.viewOf({ project: blocked, events: [] }, NOW);
  assert.deepStrictEqual([b.card.label, b.card.reason, b.card.stuckDays, b.detail.blockedTasks[0].id, b.detail.readyTasks.length], ["BLOCKED", "Blocked: needs login", 2, "T2", 0]);
});
t("viewOf: LATE when the plan date has passed with work left; ready and blocked lists in the detail", () => {
  const late = proj({ milestones: [{ id: "M1", title: "Old", planned_date: "2026-10-20", done_checklist: [{ text: "a", done: false }] }], tasks: [] });
  const v = L.viewOf({ project: late, events: [] }, NOW);
  assert.ok(/^LATE/.test(v.card.label) && v.detail.lateDays >= 3, v.card.label);
  const ok = L.viewOf({ project: proj(), events: EV }, NOW);
  assert.deepStrictEqual(ok.detail.readyTasks, [{ id: "T2", title: "Test it" }]);
});
t("viewOf: questions carry default, deadline and whether the default applies by itself", () => {
  const p = proj({ questions: [{ id: "Q1", text: "Use X?", default: "X", deadline: "2026-10-24T10:00:00", asked_by: "SE", status: "open", asked: daysAgo(1) }, { id: "Q2", text: "Pay?", status: "open", irreversible: true }, { id: "Q3", text: "old", status: "answered" }] });
  const v = L.viewOf({ project: p, events: [] }, NOW);
  assert.deepStrictEqual(v.detail.questions.map((q) => [q.id, q.autoApplies, q.irreversible]), [["Q1", true, false], ["Q2", false, true]]);
  assert.strictEqual(v.card.questions, 2);
});
t("spend is a percentage of the week, never dollars; numbers carry a list and an age", () => {
  const v = L.viewOf({ project: proj(), events: EV }, NOW).detail;
  assert.strictEqual(v.numbers.tokens.value, "25%");
  assert.ok(!/\$/.test(JSON.stringify(v.numbers)));
  for (const k of ["done", "open", "tokens"]) assert.ok(Array.isArray(v.numbers[k].what) && "at" in v.numbers[k], k);
  assert.strictEqual(v.numbers.done.what.length, 2);   // checklist item a + T1
});
t("burn-up: pace of the last 3 days, projection, done and empty states", () => {
  const b = L.viewOf({ project: proj(), events: [] }, NOW).detail.burnup;
  assert.strictEqual(b.total, 5); assert.ok(b.state === "projected" && b.finish > NOW.getTime() && b.projection.length === 2);
  const none = L.viewOf({ project: proj({ milestones: [], tasks: [] }), events: [] }, NOW).detail.burnup;
  assert.strictEqual(none.state, "empty");
  const all = proj(); all.tasks.forEach((x) => { x.status = "done"; x.done_ts = daysAgo(1); }); all.milestones[0].done_checklist.forEach((i) => { i.done = true; i.verified_at = daysAgo(1); });
  assert.strictEqual(L.viewOf({ project: all, events: [] }, NOW).detail.burnup.state, "done");
});
t("listView: red first, then amber, draft, green; finished last; counts exclude finished", () => {
  const red = proj({ slug: "r", name: "R" }); red.tasks[1].status = "blocked"; red.tasks[1].block_needs = "iddo"; red.tasks[1].block_reason = "x";
  const amber = proj({ slug: "a", name: "A", questions: [{ id: "Q1", text: "?", status: "open" }] });
  const lv = L.listView([{ project: proj({ slug: "done1", status: "done" }), events: [] }, { project: proj({ slug: "g", milestones: [{ id: "M1", title: "F", planned_date: "2026-12-01", done_checklist: [{ text: "a", done: true, verified_at: daysAgo(1) }, { text: "b", done: false }] }] }), events: EV }, { project: amber, events: [] }, { project: red, events: [] }, { project: proj({ slug: "d", status: "draft" }), events: [] }], NOW);
  assert.deepStrictEqual(lv.projects.map((p) => p.slug), ["r", "a", "d", "g", "done1"]);
  assert.deepStrictEqual([lv.counts.red, lv.counts.total, lv.counts.finished], [1, 4, 1]);
});
t("hostile text is clipped and stripped of control and bidi characters", () => {
  const evil = "A\u0000B\u202eC" + "x".repeat(900);
  const v = L.viewOf({ project: proj({ name: evil }), events: [{ ts: daysAgo(1), kind: "progress", agent: "a\u0007", text: evil }] }, NOW).card;
  assert.ok(v.name.length <= 120 && !/[\u0000\u202e]/.test(v.name) && v.lastText.length <= 140);
});

// ------------------------------------------------------------------ cross-check against the real project.py
t("derive matches project.py show on a real ledger (skipped when python or the tool is absent)", () => {
  const dir = tmp(), tool = path.resolve(__dirname, "..", "..", "shared_tools", "projects", "project.py");
  const toolPath = process.env.PROJECT_PY || tool;
  if (!fs.existsSync(toolPath)) { console.log("  (skipped: project.py not found)"); return; }
  const evs = EV.concat([{ ts: daysAgo(0.5), agent: "x", kind: "progress", text: "bad line follows" }]);
  const p = proj(); p.tasks[1].status = "blocked"; p.tasks[1].block_needs = "iddo"; p.tasks[1].block_reason = "r"; p.tasks[1].block_ts = daysAgo(1);
  write(dir, p, evs); fs.appendFileSync(path.join(dir, "demo", "events.jsonl"), "not json\n");
  const r = cp.spawnSync("python", [toolPath, "show", "demo"], { encoding: "utf8", env: Object.assign({}, process.env, { PROJECTS_DIR: dir }) });
  if (r.status !== 0) { console.log("  (skipped: python could not run project.py)"); return; }
  const py = JSON.parse(r.stdout).derived;
  const js = L.derive(p, L.readEvents(fs, path.join(dir, "demo", "events.jsonl")).events);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(js)), py);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ disk
t("readProject: damaged, wrong slug, bad slug, missing events", () => {
  const dir = tmp();
  write(dir, proj({ slug: "ok" }), null);
  assert.ok(L.readProject(fs, path, dir, "ok", { retries: 0 }));
  write(dir, proj({ slug: "bad" }), null, "{ not json");
  assert.strictEqual(L.readProject(fs, path, dir, "bad", { retries: 1, waitMs: 1 }), null);
  write(dir, proj({ slug: "liar" }), null, JSON.stringify(proj({ slug: "other" })));
  assert.strictEqual(L.readProject(fs, path, dir, "liar", { retries: 0 }), null);
  for (const s of ["../x", "a/b", "", "a b", null, "..", "C:\\x"]) assert.strictEqual(L.readProject(fs, path, dir, s), null, String(s));
  assert.deepStrictEqual(L.readProject(fs, path, dir, "ok").events, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
t("readProject retries a transient failure (Dropbox holding the file) and not a missing file", () => {
  const dir = tmp(); write(dir, proj({ slug: "ok" }), EV);
  let fails = 2, slept = 0; const flaky = Object.assign({}, fs, { readFileSync: (f, e) => { if (/project\.json$/.test(String(f)) && fails-- > 0) { const x = new Error("busy"); x.code = "EBUSY"; throw x; } return fs.readFileSync(f, e); } });
  const r = L.readProject(flaky, path, dir, "ok", { retries: 3, waitMs: 1, sleep: () => { slept++; } });
  assert.ok(r && r.project.slug === "ok" && slept === 2, "recovered after two failures, slept " + slept);
  let calls = 0; const gone = Object.assign({}, fs, { statSync: (f) => { calls++; const x = new Error("no"); x.code = "ENOENT"; throw x; } });
  assert.strictEqual(L.readProject(gone, path, dir, "ok", { retries: 3, waitMs: 1, sleep: () => {} }), null); assert.strictEqual(calls, 1);
  let evFails = 1; const evFlaky = Object.assign({}, fs, { readFileSync: (f, e) => { if (/events\.jsonl$/.test(String(f)) && evFails-- > 0) { const x = new Error("busy"); x.code = "EBUSY"; throw x; } return fs.readFileSync(f, e); } });
  assert.strictEqual(L.readProject(evFlaky, path, dir, "ok", { retries: 2, waitMs: 1, sleep: () => {} }).events.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
t("loadAll keeps the last good copy while a file cannot be read, drops it when the project is gone", () => {
  const dir = tmp(); write(dir, proj({ slug: "ok" }), EV); write(dir, proj({ slug: "two", name: "Two" }), null);
  const cache = new Map(), o = { retries: 0 };
  assert.strictEqual(L.loadAll(fs, path, dir, NOW, cache, o).projects.length, 2);
  fs.writeFileSync(path.join(dir, "two", "project.json"), "{ half synced");
  const mid = L.loadAll(fs, path, dir, NOW, cache, o); assert.deepStrictEqual(mid.projects.map((p) => p.slug).sort(), ["ok", "two"]);
  fs.rmSync(path.join(dir, "two"), { recursive: true, force: true });
  assert.deepStrictEqual(L.loadAll(fs, path, dir, NOW, cache, o).projects.map((p) => p.slug), ["ok"]);
  assert.strictEqual(L.loadAll(fs, path, path.join(dir, "nope"), NOW, cache, o), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
t("big events log: only the end is read and the view says so", () => {
  const dir = tmp(); write(dir, proj({ slug: "big" }), null);
  const line = JSON.stringify({ ts: daysAgo(1), agent: "a", kind: "progress", text: "x".repeat(900) }) + "\n";
  fs.writeFileSync(path.join(dir, "big", "events.jsonl"), line.repeat(Math.ceil((8 * 1024 * 1024 + 4096) / line.length)));
  const r = L.readProject(fs, path, dir, "big"); assert.ok(r.truncated && r.events.length > 1000);
  assert.ok(L.viewOf(r, NOW).detail.truncated);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ IPC
function boot(extra) {
  const dir = tmp(), h = {}, wc = { mainFrame: {}, sent: [], send(c) { this.sent.push(c); } }, ev = { sender: wc, senderFrame: wc.mainFrame }, ran = [], logs = [];
  const cfg = { workspaceRoot: "X", projectsDir: dir, projectsTool: "tool", pythonExe: "py" };
  const api = MP.init(Object.assign({ ipcMain: { handle: (c, f) => { h[c] = f; } }, getMainWindow: () => ({ webContents: wc, isDestroyed: () => false }), log: (l) => logs.push(l),
    cfg: (k) => cfg[k] || null, now: () => NOW.toISOString(), run: async (args) => { ran.push(args); return { ok: true, out: "" }; }, watch: () => ({ on() {}, close() {} }) }, extra || {}));
  return { dir, h, ev, ran, logs, wc, api };
}
t("IPC: list/detail work; non-main callers and oversized or array arguments are refused", async () => {
  const b = boot(); write(b.dir, proj(), EV);
  const l = await b.h["projects-list"](b.ev); assert.ok(l.ok && l.projects.length === 1 && l.canWrite);
  assert.ok((await b.h["projects-detail"](b.ev, { slug: "demo" })).ok);
  assert.strictEqual((await b.h["projects-detail"](b.ev, { slug: "../etc" })).ok, false);
  assert.deepStrictEqual(await b.h["projects-list"]({ sender: {}, senderFrame: {} }), { ok: false, reason: "Not allowed." });
  assert.strictEqual((await b.h["projects-detail"](b.ev, [1])).ok, false);
  assert.strictEqual((await b.h["projects-answer"](b.ev, { slug: "demo", qid: "Q1", text: "x".repeat(3000) })).ok, false);
  assert.strictEqual(b.ran.length, 0);
  b.api.stop(); fs.rmSync(b.dir, { recursive: true, force: true });
});
t("IPC: an empty or missing folder is an empty list, not an error", async () => {
  const b = boot(); fs.rmSync(b.dir, { recursive: true, force: true });
  const l = await b.h["projects-list"](b.ev); assert.ok(l.ok && l.empty && l.projects.length === 0);
  const unset = boot({ cfg: () => null }); const r = await unset.h["projects-list"](unset.ev); assert.strictEqual(r.ok, false); assert.ok(/workspace folder/i.test(r.reason));
  b.api.stop(); unset.api.stop();
});
t("IPC: answer goes through the tool with --by=Iddo, validated ids, option-looking text kept as text", async () => {
  const b = boot(); write(b.dir, proj(), null);
  assert.ok((await b.h["projects-answer"](b.ev, { slug: "demo", qid: "Q2", text: "-rf yes" })).ok);
  assert.deepStrictEqual(b.ran[0], ["answer", "demo", "Q2", "--text=-rf yes", "--by=Iddo"]);
  for (const bad of [{ slug: "demo", qid: "Q2; x", text: "a" }, { slug: "../x", qid: "Q1", text: "a" }, { slug: "demo", qid: "Q1", text: "   " }, { slug: "demo", qid: "Q1" }]) assert.strictEqual((await b.h["projects-answer"](b.ev, bad)).ok, false);
  assert.strictEqual(b.ran.length, 1);
  b.api.stop(); fs.rmSync(b.dir, { recursive: true, force: true });
});
t("IPC: Green light only for a signed draft; the tool's refusal words are plain", async () => {
  const b = boot(); write(b.dir, proj({ slug: "act" }), null); write(b.dir, proj({ slug: "unsigned", status: "draft", budget: {} }), null); write(b.dir, proj({ slug: "ready", status: "draft" }), null);
  for (const s of ["act", "unsigned", "nope"]) assert.strictEqual((await b.h["projects-green-light"](b.ev, { slug: s })).ok, false, s);
  assert.strictEqual(b.ran.length, 0);
  assert.ok((await b.h["projects-green-light"](b.ev, { slug: "ready" })).ok); assert.deepStrictEqual(b.ran[0], ["green-light", "ready", "--by=Iddo"]);
  const refuse = boot({ run: async () => ({ ok: false, reason: "The budget is not signed yet. System Optimization has to sign it first." }) }); write(refuse.dir, proj({ slug: "ready", status: "draft" }), null);
  assert.ok(/not signed/.test((await refuse.h["projects-green-light"](refuse.ev, { slug: "ready" })).reason));
  b.api.stop(); refuse.api.stop();
});
t("IPC: a failing handler never leaks project text into the log", async () => {
  const b = boot({ run: async () => { const e = new Error("SECRET project text"); e.code = "EBOOM"; throw e; } }); write(b.dir, proj(), null);
  const r = await b.h["projects-answer"](b.ev, { slug: "demo", qid: "Q1", text: "SECRET answer" });
  assert.strictEqual(r.ok, false); assert.ok(b.logs.length && !b.logs.join("\n").includes("SECRET"), b.logs.join("|"));
  b.api.stop();
});
t("IPC: the folder watcher tells the window once (debounced), ignores lock files", async () => {
  let cb = null; const b = boot({ watch: (d, o, f) => { cb = f; return { on() {}, close() {} }; } }); write(b.dir, proj(), null);
  await b.h["projects-list"](b.ev); assert.ok(cb);
  cb("change", "demo.lock"); cb("change", "x.tmp"); cb("change", "demo/events.jsonl"); cb("change", "demo/project.json");
  await new Promise((r) => setTimeout(r, 900)); assert.deepStrictEqual(b.wc.sent, ["projects-changed"]);
  b.api.stop(); fs.rmSync(b.dir, { recursive: true, force: true });
});


// ------------------------------------------------------------------ renderer smoke test on a tiny fake DOM (no browser needed)
function fakeDom() {
  class N {
    constructor(tag) { this.tag = tag; this.children = []; this._text = ""; this.attrs = {}; this.style = {}; this.handlers = {}; this.className = ""; this.disabled = false; this.value = ""; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get classList() { const o = this; const set = () => o.className.split(/\s+/).filter(Boolean); return { add: (c) => { if (!set().includes(c)) o.className = set().concat(c).join(" "); }, remove: (c) => { o.className = set().filter((x) => x !== c).join(" "); }, contains: (c) => set().includes(c), toggle: (c, on) => { const has = set().includes(c); if (on === undefined ? !has : on) { if (!has) o.className = set().concat(c).join(" "); } else o.className = set().filter((x) => x !== c).join(" "); } }; }
    append(...a) { for (const x of a) this.children.push(typeof x === "string" ? Object.assign(new N("#text"), { _text: x }) : x); }
    appendChild(x) { this.children.push(x); return x; }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k]; }
    addEventListener(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }
    click() { for (const f of this.handlers.click || []) f({}); }
    all(pred, out) { out = out || []; if (pred(this)) out.push(this); for (const c of this.children) c.all(pred, out); return out; }
    byClass(c) { return this.all((n) => n.className.split(/\s+/).includes(c)); }
    querySelector(sel) { return this.byClass(sel.replace(/^\./, ""))[0] || null; }
  }
  const main = new N("div"), doc = { body: new N("body"), hidden: false, createElement: (t) => new N(t), createElementNS: (ns, t) => new N(t), createTextNode: (x) => Object.assign(new N("#text"), { _text: x }),
    getElementById: (id) => (id === "main-panel" ? main : null), addEventListener() {}, removeEventListener() {} };
  return { N, main, doc };
}
t("renderer: list, detail, answer, Green light and close, on a fake DOM", async () => {
  const dir = tmp(), { main, doc } = fakeDom();
  const q = { id: "Q1", text: "Use the cheap model?", default: "cheap", deadline: "2026-10-24T10:00:00", asked_by: "SE", status: "open", asked: daysAgo(1) };
  write(dir, proj({ slug: "act", name: "Active one", questions: [q] }), EV); write(dir, proj({ slug: "dr", name: "Draft one", status: "draft" }), null);
  const calls = []; let changed = null;
  const api = { projects: {
    list: async () => Object.assign({ ok: true, canWrite: true }, L.loadAll(fs, path, dir, NOW)),
    detail: async (slug) => { const i = L.readProject(fs, path, dir, slug); const v = L.viewOf(i, NOW).detail; return { ok: true, project: v, intake: v.status === "draft" ? "chat so far" : "", canWrite: true }; },
    answer: async (s, id, text) => { calls.push(["answer", s, id, text]); return { ok: true }; }, greenLight: async (s) => { calls.push(["green", s]); return { ok: true }; },
    onChanged: (f) => { changed = f; return () => { changed = null; }; } } };
  const win = { api, viewManager: { closeAll() {} }, projectsNavCount: (c) => calls.push(["badge", c]) };
  const vm = require("vm"); const ctx = vm.createContext({ window: win, document: doc, location: { search: "" }, setTimeout, clearTimeout, Date, Math, Promise, JSON, String, Number, Array, Object, Set, Date });
  vm.runInContext(fs.readFileSync(path.join(SRC, "renderer", "projects.js"), "utf8"), ctx);
  const nav = new (fakeDom().N)("button"); win.projectsView.toggle(nav);
  const tick = () => new Promise((r) => setTimeout(r, 30));
  await tick(); const root = main.children[0];
  assert.ok(win.projectsView.isOpen() && doc.body.classList.contains("projects-open") && nav.classList.contains("active") && typeof changed === "function");
  assert.ok(root.textContent.includes("Active one") && root.textContent.includes("Draft one") && root.textContent.includes("1 question for you"), root.textContent.slice(0, 300));
  assert.deepStrictEqual(calls.find((c) => c[0] === "badge"), ["badge", 0]);
  const cards = root.byClass("pj-card"); assert.strictEqual(cards.length, 2);
  cards[0].click(); await tick();
  let txt = root.textContent; for (const w of ["Needs your answer", "Use the cheap model?", "default: cheap", "Progress against plan", "Milestones", "Ready to start", "Spend against budget", "Recent activity", "Blocked tasks"]) assert.ok(txt.includes(w), w);
  const tile = root.byClass("pj-tile")[2]; tile.click(); assert.ok(root.byClass("pj-what").length === 1 && root.textContent.includes("day 1"), "the token number opens what it counts");
  root.byClass("pj-input")[0].value = "ignored"; root.all((n) => n.tag === "button" && /^Yes/.test(n.textContent))[0].click(); await tick();
  assert.deepStrictEqual(calls.find((c) => c[0] === "answer"), ["answer", "act", "Q1", "Yes - use the default: cheap"]);
  root.byClass("pj-back")[0].click(); await tick();
  const draft = root.byClass("pj-card").find((c) => c.textContent.includes("Draft one")); draft.click(); await tick();
  assert.ok(root.textContent.includes("Waiting for your Green light") && root.textContent.includes("chat so far"));
  const glb = root.all((n) => n.tag === "button" && n.textContent === "Green light")[0];
  glb.click(); await tick();   // first press only arms it
  assert.ok(!calls.some((c) => c[0] === "green") && /confirm/.test(glb.textContent), "one click must not start the project");
  glb.click(); await tick();
  assert.deepStrictEqual(calls.find((c) => c[0] === "green"), ["green", "dr"]);
  win.projectsView.close(); assert.ok(!win.projectsView.isOpen() && !doc.body.classList.contains("projects-open") && changed === null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ static guards
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const FILES = () => ["projects/projectsLogic.js", "projects/main-projects.js", "renderer/projects.js", "renderer/projects-nav.js"].map((f) => path.join(SRC, f));
t("guards: no network, no console output, no eval, no innerHTML, no browser storage; the renderer never touches files", () => {
  for (const f of FILES()) {
    const s = strip(fs.readFileSync(f, "utf8")).replace("http://www.w3.org/2000/svg", ""), name = path.basename(f);   // the SVG namespace id is not a network address
    assert.ok(!/console\.(log|info|debug|warn|error|trace|dir|table)\s*\(/.test(s), "console output in " + name);
    for (const re of [/require\(["'](https?|net|tls|dgram|dns)["']\)/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /https?:\/\//, /\beval\s*\(/, /new Function/, /innerHTML/, /insertAdjacentHTML/, /localStorage/, /sessionStorage/, /indexedDB/, /shell:\s*true/, /password|passwd|apikey|api_key|credential/i, /writeFileSync|appendFileSync|unlinkSync|renameSync|writeFile\(/]) assert.ok(!re.test(s), name + " matches " + re);
  }
  assert.ok(!/require\(|openExternal|openPath|shell\./.test(strip(fs.readFileSync(path.join(SRC, "renderer", "projects.js"), "utf8"))));
  assert.ok(/execFile\(/.test(fs.readFileSync(path.join(SRC, "projects", "main-projects.js"), "utf8")) && !/\bexec\s*\(/.test(strip(fs.readFileSync(path.join(SRC, "projects", "main-projects.js"), "utf8"))), "the tool is run with execFile, never through a shell");
});
t("guards: wiring - lazy view and css, only the nav at startup, window.api.projects, view manager, main.js outside demo mode", () => {
  const html = fs.readFileSync(path.join(SRC, "renderer", "index.html"), "utf8");
  assert.ok(html.includes("projects-nav.js") && html.includes("styles-projects-nav.css") && !/"projects\.js"/.test(html) && !html.includes("styles-projects.css"));
  const nav = fs.readFileSync(path.join(SRC, "renderer", "projects-nav.js"), "utf8");
  assert.ok(/dataset\.systemNav = "projects"/.test(nav) && /link\[href="styles-projects\.css"\]/.test(nav) && /s\.src = "projects\.js"/.test(nav));
  assert.ok(/id: "projects"[^}]*projects-open/.test(fs.readFileSync(path.join(SRC, "renderer", "viewmanager.js"), "utf8")));
  assert.ok(/if \(!demo\.ON\) \{\s*try \{\s*require\("\.\/projects\/main-projects"\)\.init/.test(fs.readFileSync(path.join(SRC, "main.js"), "utf8")));
  const pre = fs.readFileSync(path.join(SRC, "preload.js"), "utf8");
  for (const c of ["projects-list", "projects-detail", "projects-answer", "projects-green-light", "projects-changed"]) assert.ok(pre.includes('"' + c + '"'), c);
  const view = strip(fs.readFileSync(path.join(SRC, "renderer", "projects.js"), "utf8"));
  assert.ok(!/setInterval|requestAnimationFrame|MutationObserver/.test(view), "no intervals in the view (timeouts chained, stopped on close)");
});
t("guards: design - three weights, nothing under 12 px, no literal colours outside the token blocks, big numbers print, dir=auto on agent text, status words", () => {
  const js = fs.readFileSync(path.join(SRC, "renderer", "projects.js"), "utf8"), css = fs.readFileSync(path.join(SRC, "renderer", "styles-projects.css"), "utf8"), navCss = fs.readFileSync(path.join(SRC, "renderer", "styles-projects-nav.css"), "utf8");
  for (const [name, c] of [["styles-projects.css", css], ["styles-projects-nav.css", navCss]]) {
    assert.ok(!/font-size:\s*([0-9]|1[01])(\.\d+)?px/.test(c), "nothing under 12 px in " + name);
    assert.ok(!/font-size:\s*[\d.]+(em|rem)/.test(c), "no em/rem sizes in " + name);
  }
  assert.deepStrictEqual([...new Set((css.match(/font-weight:\s*(\d+)/g) || []).map((x) => x.replace(/\D/g, "")))].sort(), ["400", "600", "700"], "three weights");
  const noTok = css.replace(/(:root|body\.dark, html\[data-theme="dark"\] body)\s*\{[^}]*\}/g, "");
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(noTok.replace(/#projects-view/g, "")), "no literal colours outside the token blocks");
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(navCss.replace(/:root\s*\{[^}]*\}/, "")), "no literal colours in the nav css outside its token line");
  assert.ok((js.match(/auto\(/g) || []).length >= 10, "Hebrew text gets dir=auto");
  for (const w of ["Blocked", "Needs your answer", "Ready to start", "Spend against budget", "Progress against plan", "Green light", "No projects yet"]) assert.ok(js.includes(w), w);
  assert.ok(!/textContent\s*=\s*[^;]*<\w/.test(js));
  assert.ok(!/\$/.test(js.replace(/\$\{/g, "")), "no dollar amounts in the view");
});

(async () => {
  for (const q of queue) {
    n++;
    try { await q.fn(); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); }
  }
  console.log(fails ? fails + " of " + n + " FAILED" : "projects: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
