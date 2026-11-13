// THYRA tabs (v1.156.0): Task list + Ideas. Data rules (src/thyraTabs.js), the dock UI (src/renderer/thyra-tabs.js, with a tiny fake DOM),
// the My Tools "opens THYRA" hook (src/tools/internalOpen.js) and the wiring (dock-only IPC, preload, config keys). Offline; no agent, no model.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const T = require("../src/thyraTabs"); require("../src/renderer/thyra-tabs"); const UI = globalThis.ThyraTabs;   // renderer script: it publishes on the global (window in the dock)
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const NOW = Date.parse("2026-11-13T12:00:00Z"), iso = (d) => new Date(NOW - d * 86400000).toISOString();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thyra-tabs-"));
const wr = (dir, name, obj) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), typeof obj === "string" ? obj : JSON.stringify(obj)); };
const task = (id, over) => Object.assign({ id, title: "Task " + id, status: "open", created: iso(3), tags: [] }, over);

// ---- stores -> per-agent groups ----
const tdir = path.join(tmp, "tasks");
wr(tdir, "Security.json", { items: [task("a1", { needsIddo: true, created: iso(1) }), task("a2", { status: "blocked" }), task("a3", { startedAt: iso(0), progress: "half done" }), task("a4", { status: "done" })] });
wr(tdir, "COO Agent.json", { items: [task("c1"), task("c2", { created: iso(9) })] });
wr(tdir, "Empty Agent.json", { items: [] });
wr(tdir, "COO Agent (DESKTOP-X's conflicted copy 2026-11-11).json", { items: [task("zz")] });
wr(tdir, "COO Agent.json.lock", "");
wr(tdir, "Broken.json", "{not json");
const stores = T.readStores(tdir);
eq(stores.map((s) => s.agent).sort(), ["COO Agent", "Empty Agent", "Security"], "conflicted copies, locks and unreadable stores are skipped");
const groups = T.buildTaskGroups(stores, NOW);
eq(groups[0].agent, "Security", "agent that needs the owner comes first");
eq([groups[0].open, groups[0].needs, groups[0].stuck, groups[0].working], [3, 1, 1, 1], "finished tasks are not counted as open");
eq(groups[0].newest.title, "Task a1", "newest task by creation time");
eq(groups[1].agent, "COO Agent", "then most open tasks");
eq(groups[2].open, 0, "an agent with nothing open stays as a quiet last line");
eq(T.taskTotals(groups), { open: 5, needs: 1, agents: 2 }, "totals");
ok(groups[0].tasks.every((t) => t.title && t.group), "task rows carry title and group");
ok(T.buildTaskGroups([{ agent: "X", items: Array.from({ length: 120 }, (_, i) => task("t" + i)) }], NOW)[0].more === 40, "per-agent rows are capped (the rest is counted)");
ok(T.buildTaskGroups([{ agent: "X", items: [task("q", { title: "a‮b\u0007c" })] }], NOW)[0].tasks[0].title === "abc", "control and bidi characters are stripped");

// ---- ideas: tagged open tasks + registry stage idea; built ideas never stay ----
const rdir = path.join(tmp, "reg");
wr(rdir, "i1.json", { id: "i1", type: "project", title: "Reg idea", description: "A reg detail", agent: "Product Development Agent", topic: "gear", stage: "idea", status: "active", createdAt: iso(2) });
wr(rdir, "p1.json", { id: "p1", type: "project", title: "Past idea", stage: "active", status: "active" });
wr(rdir, "a1.json", { id: "a1", type: "project", title: "Archived idea", stage: "idea", status: "archived" });
const reg = T.readRegistryIdeas(rdir);
eq(reg.map((r) => r.id), ["i1"], "only registry projects still at stage idea");
const st2 = [{ agent: "Security", items: [task("s1", { tags: ["idea", "x"], detail: "Long detail ".repeat(5), created: iso(1) }), task("s2", { tags: ["Idea"], status: "done" }), task("s3", { tags: ["other"] }), task("s4", { tags: ["idea"], plain: "Plain words" })] }];
let ideas = T.collectIdeas(st2, reg, null, NOW);
eq(ideas.map((i) => i.id).sort(), ["i1", "s1", "s4"], "open tagged tasks + registry ideas; a closed (done) task and an untagged task are not ideas");
eq(ideas.find((i) => i.id === "s4").title, "Plain words", "plain wording wins over title");
const led = { moved: { "task:Security:s1": { to: "My Tools", at: "x" } }, sent: { "reg:i1": { to: "COO Agent", at: "t", text: "go" } } };
ideas = T.collectIdeas(st2, reg, led, NOW);
eq(ideas.map((i) => i.id).sort(), ["i1", "s4"], "a task idea marked moved disappears");
eq(ideas.find((i) => i.id === "i1").sent.to, "COO Agent", "a sent record is shown on the row");
ideas = T.collectIdeas(st2, [], null, NOW);
ok(!ideas.some((i) => i.id === "s2"), "closing the task removes the idea");
ok(T.collectIdeas(st2, [], { moved: { "reg:i1": {} }, sent: {} }, NOW).length === 2 && T.collectIdeas([], reg, { moved: { "reg:i1": {} }, sent: {} }, NOW).length === 0, "a registry idea marked moved disappears");

// ---- ledger ----
const lf = path.join(tmp, "ud", "thyra-ideas.json");
eq(T.readLedger(lf), { moved: {}, sent: {} }, "missing ledger = empty");
ok(T.writeLedger(lf, { moved: { k: { to: "My Tools" } }, sent: {} }) && T.readLedger(lf).moved.k.to === "My Tools", "ledger round-trips (atomic write)");
fs.writeFileSync(lf, "garbage"); eq(T.readLedger(lf), { moved: {}, sent: {} }, "corrupt ledger = empty, never throws");

// ---- configurable lists ----
eq(T.destinations(""), ["My Tools", "Product Development", "Software Engineering", "LensVid tools"], "default destinations");
eq(T.destinations("A; B ;C"), ["A", "B", "C"], "configured destinations");
const folders = ["Security", "COO Agent", "Software Engineering Agent", "Product Development Agent", "Graphics Agent"];
eq(T.targets("Security;COO*;Software Engineering*;Product Development*;Nobody", [], folders), ["Security", "COO Agent", "Software Engineering Agent", "Product Development Agent"], "targets come from the config, resolved to real folders; unknown names dropped");
eq(T.targets("", ["Security", "COO*"], folders), ["Security", "COO Agent"], "unset = the security and lead roles");
eq(T.targets("", [], folders), [], "nothing configured = no targets (no guessing)");
// ---- the delivered message ----
const msg = T.ideaMessage({ source: "task", id: "s1", agent: "Security", title: "Big idea", detail: "Because\nreasons" }, "COO Agent", " build   it ", "Iddo");
ok(/^Iddo sent you an idea/.test(msg) && /Big idea/.test(msg) && /task s1 in Security/.test(msg) && /Instruction: "build it"/.test(msg) && !/\n/.test(msg), "message names the idea, its source and the one-line instruction, on one line");
ok(!T.validInstruction("") && !T.validInstruction("  ") && !T.validInstruction(5) && T.validInstruction("go"), "an empty instruction is refused");

// ---- renderer filters ----
const fg = UI.filterGroups(groups, "half");
eq(fg.map((x) => x.g.agent), ["Security"], "task search keeps only agents with a matching task");
eq(fg[0].open, true, "a search auto-expands the matching agent");
eq(UI.filterGroups(groups, "coo").map((x) => x.g.agent), ["COO Agent"], "agent name match");
eq(UI.filterGroups(groups, "coo")[0].tasks.length, 2, "an agent-name match keeps all its tasks");
eq(UI.filterGroups(groups, "").length, 3, "no search = every agent, collapsed");
eq(UI.filterIdeas(ideas, "plain").length, 1, "idea search");
eq(UI.ageText(0) + "|" + UI.ageText(1) + "|" + UI.ageText(5) + "|" + UI.ageText(90) + "|" + UI.ageText(null), "today|1 day|5 days|3 months|", "ages");

// ---- UI with a tiny fake DOM: lazy load, expand, send, mark built, busy states ----
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ""; this.attrs = {}; this.ls = {}; this._text = ""; this.disabled = false; this.value = ""; this.parent = null; this.dataset = {}; }
  get classList() { const s = this; return { add: (c) => { if (!s.className.split(" ").includes(c)) s.className = (s.className + " " + c).trim(); }, remove: (c) => { s.className = s.className.split(" ").filter((x) => x && x !== c).join(" "); }, contains: (c) => s.className.split(" ").includes(c) }; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text; }
  set textContent(v) { this.children = []; this._text = String(v); }
  append(...k) { for (const c of k) { if (typeof c === "string") { const t = new Node("#text"); t._text = c; t.parent = this; this.children.push(t); } else { c.parent = this; this.children.push(c); } } }
  setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
  click() { for (const f of this.ls.click || []) f({ isTrusted: true }); }
  all(pred, out) { out = out || []; for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  querySelector(sel) { const id = sel[0] === "#" ? sel.slice(1) : null, cl = sel[0] === "." ? sel.slice(1) : null; return this.all((c) => (id && c.id === id) || (cl && c.classList.contains(cl)))[0] || null; }
  after(x) { const i = this.parent.children.indexOf(this); x.parent = this.parent; this.parent.children.splice(i + 1, 0, x); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  set type(v) { this._t = v; } set placeholder(v) { this._p = v; } set maxLength(v) {} set title(v) { this._title = v; }
}
global.document = { createTextNode: (t) => { const x = new Node("#text"); x._text = t; return x; } };
const el = (t, c, x) => { const e = new Node(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const byText = (root, cls, txt) => root.all((c) => c.classList.contains(cls) && c.textContent.indexOf(txt) >= 0)[0];
const flush = () => new Promise((r) => setTimeout(r, 5));
(async () => {
  const calls = { tasks: 0, ideas: 0, send: [], built: [] };
  let sendResult = { ok: true }, release = null;
  const api = {
    thyraTasksLoad: async () => { calls.tasks++; return { ok: true, groups, totals: T.taskTotals(groups) }; },
    thyraIdeasLoad: async () => { calls.ideas++; return { ok: true, ideas: T.collectIdeas(st2, reg, null, NOW), targets: ["Security", "COO Agent"], destinations: T.destinations("") }; },
    thyraIdeaSend: (r) => { calls.send.push(r); return new Promise((res) => { release = () => res(sendResult); if (!sendResult.hold) release(); }); },
    thyraIdeaBuilt: async (r) => { calls.built.push(r); return { ok: true, closed: true }; },
  };
  const changes = [];
  const tabs = UI.create({ api, el, onChange: (k) => changes.push(k) });
  eq([calls.tasks, calls.ideas], [0, 0], "nothing is read until a tab is opened (lazy)");
  const tp = tabs.show("tasks"); await flush();
  eq(calls.tasks, 1, "opening the Task list reads once");
  tabs.show("tasks"); await flush(); eq(calls.tasks, 1, "re-opening the tab does not re-read");
  const heads = tp.all((c) => c.classList.contains("tt-ahead"));
  eq(heads.length, 3, "one collapsed line per agent");
  ok(heads[0].textContent.indexOf("Security") >= 0 && /3 open/.test(heads[0].textContent) && /1 need you/.test(heads[0].textContent) && /Newest: Task a1/.test(heads[0].textContent), "line shows name, open count, needs-you and the newest task");
  eq(tp.all((c) => c.classList.contains("tt-task")).length, 0, "tasks are hidden while collapsed");
  heads[0].click();
  eq(tp.all((c) => c.classList.contains("tt-task")).length, 3, "click expands that agent only");
  ok(/Needs you/.test(tp.querySelector(".tt-legend").textContent) && /Stuck/.test(tp.querySelector(".tt-legend").textContent), "the colour legend is always on screen");
  ok(!tabs.counts().ideas && tabs.counts().tasks === 1, "tab counts: needs-you count known after load, ideas unknown until opened");

  const ip = tabs.show("ideas"); await flush();
  eq(calls.ideas, 1, "opening Ideas reads once");
  eq(ip.all((c) => c.classList.contains("tt-idea")).length, 3, "one row per open idea");
  const row = () => ip.all((c) => c.classList.contains("tt-idea") && /Big|Reg idea/.test(c.textContent))[0];
  const rr = ip.all((c) => c.classList.contains("tt-idea")).find((r) => /Reg idea/.test(r.textContent));
  ok(rr.querySelector(".tt-btns").children.length === 2, "every idea has a Send to and a Mark built button, visible without expanding");
  // Send: empty instruction refused with a message, nothing sent
  byText(rr, "tt-btn", "Send to").click();
  let form = ip.all((c) => c.classList.contains("tt-form"))[0]; ok(!!form, "Send to opens an inline form");
  const goOf = () => ip.all((c) => c.classList.contains("tt-form"))[0].all((c) => c.classList.contains("tt-btn"))[0];
  goOf().click(); await flush();
  eq(calls.send.length, 0, "empty instruction is not sent");
  ok(/one-line instruction/.test(ip.textContent), "and the refusal is written on screen");
  // type + send, busy state while in flight
  sendResult = { ok: true, hold: true };
  const inp = ip.all((c) => c.classList.contains("tt-in"))[0]; inp.value = "plan it please"; (inp.ls.input || []).forEach((f) => f({ isTrusted: true }));
  const sendBtn = goOf(); sendBtn.click();
  ok(sendBtn.disabled && /Sending/.test(sendBtn.textContent), "button is disabled and says Sending... at once");
  await flush(); eq(calls.send.length, 1, "one send call");
  eq(calls.send[0].text, "plan it please", "the typed instruction travels");
  sendResult = { ok: true }; release(); await flush(); await flush();
  ok(/Sent to/.test(ip.textContent) || calls.ideas >= 2, "after a successful send the list re-reads (the sent record shows)");
  // failure path keeps the form and says nothing was delivered
  const rr2 = ip.all((c) => c.classList.contains("tt-idea")).find((r) => /Plain words/.test(r.textContent));
  byText(rr2, "tt-btn", "Send to").click();
  const inp2 = ip.all((c) => c.classList.contains("tt-in"))[0]; inp2.value = "do x"; (inp2.ls.input || []).forEach((f) => f({ isTrusted: true }));
  sendResult = { ok: false, error: "agent not in list" }; goOf().click(); await flush(); await flush();
  ok(/Not sent: agent not in list\. Nothing was delivered/.test(ip.textContent), "a failed delivery is stated, never silent");
  // Mark built
  const rr3 = ip.all((c) => c.classList.contains("tt-idea")).find((r) => /Plain words/.test(r.textContent));
  byText(rr3, "tt-btn", "Mark built").click();
  const sel = ip.all((c) => c.classList.contains("tt-sel"))[0]; sel.value = "Product Development";
  ok(sel.children.map((c) => c._text).join("|") === "My Tools|Product Development|Software Engineering|LensVid tools", "the four destinations are offered");
  (sel.ls.change || []).forEach((f) => f()); byText(ip, "tt-btn", "Record and remove").click(); await flush(); await flush();
  eq(calls.built.length, 1, "Mark built sends one record call");
  eq(calls.built[0].dest, "Product Development", "with the chosen destination");
  // untrusted click does nothing
  const calls0 = calls.built.length; const fake = ip.all((c) => c.classList.contains("tt-btn"))[0]; (fake.ls.click || []).forEach((f) => f({ isTrusted: false }));
  eq(calls.built.length, calls0, "a scripted (untrusted) click does nothing");

  // ---- wiring ----
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const main = rd("src/main.js");
  for (const ch of ["thyra-tasks-load", "thyra-ideas-load", "thyra-idea-send", "thyra-idea-built"]) {
    const i = main.indexOf('ipcMain.handle("' + ch + '"'); ok(i > 0, ch + " is registered");
    ok(/isDockSender\(event\)/.test(main.slice(i, i + 300)), ch + " answers only the dock window");
  }
  ok(/openInternal: \(what\) => \{ if \(what === "thyra"\)/.test(main), "main supplies the My Tools open hook");
  const pre = rd("src/approvals-window-preload.js");
  ok(["thyraTasksLoad", "thyraIdeasLoad", "thyraIdeaSend", "thyraIdeaBuilt"].every((k) => pre.indexOf(k) > 0), "dock preload exposes the four calls and nothing else new");
  ok(/onThyraIdeaDeliver/.test(rd("src/preload.js")) && /onThyraIdeaDeliver/.test(rd("src/renderer/answer-once.js")), "delivery goes through the main window's queueSendToAgent path");
  ok(/thyra-tabs\.js/.test(rd("src/renderer/approvals-window.html")), "dock page loads the tabs script (CSP: same-origin script only)");
  ok(/thyraIdeaTargets/.test(rd("src/appConfig.js")) && /thyraIdeaDestinations/.test(rd("src/appConfig.js")), "targets and destinations come from the configuration");

  // ---- My Tools: THYRA card opens THYRA ----
  const io = require("../src/tools/internalOpen");
  eq(io.whatFor("thyra"), "thyra", "tool id thyra opens thyra"); eq(io.whatFor("toString"), null, "prototype names are not tool ids"); eq(io.whatFor("other"), null, "other ids launch normally");
  const card = io.decorate({ id: "thyra", start: { state: "disabled", label: "Start" }, dots: [{ id: "launcher", state: "bad", text: "No launcher set" }, { id: "lastRun", state: "unknown", text: "x" }] });
  eq([card.start.state, card.start.label, card.dots[0].state, card.dots[1].state], ["ready", "Open", "ok", "unknown"], "THYRA card: Open button, launcher dot ok, other dots untouched");
  const svcSrc = rd("src/tools/service.js"), st0 = svcSrc.indexOf("async function start(id)"); ok(st0 > 0 && svcSrc.indexOf("internalOpen.whatFor(t.id)", st0) > 0 && svcSrc.indexOf("internalOpen.whatFor(t.id)", st0) < svcSrc.indexOf("launcher.check(t.launch", st0), "start() handles the internal card before any launcher check");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("thyraTabs.test.js: " + n + " checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
