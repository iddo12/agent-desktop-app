// THYRA "Questions for you": list filtering, the re-check against the ask file, the dock's renderer (trusted clicks only, 1 s settle) and the
// delivery order in answer-once.js (type into the asking agent -> seal -> resolve). Offline; no agent, no model.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const da = require("../src/dockAsks");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(JSON.parse(JSON.stringify(a === undefined ? null : a)), JSON.parse(JSON.stringify(b === undefined ? null : b)), m); n++; };
const NOW = Date.parse("2026-11-05T12:00:00+02:00"), DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const mk = (id, over) => Object.assign({ id, agent: "Security", question: "Merge it?", context: "ctx", quick: ["Yes", "No"], merav: false, created: iso(NOW - 3600000) }, over);

// ---- list filtering: 3 days, newest first, older flag ----
const fresh = mk("20261105-100000-aaaa"), twoD = mk("20261103-120000-bbbb", { created: iso(NOW - 2 * DAY) }), old = mk("20261101-120000-cccc", { created: iso(NOW - 4 * DAY) }), noQuick = mk("20261105-110000-dddd", { quick: [], created: iso(NOW - 600000) });
const rows = da.buildRows([old, twoD, fresh, noQuick], NOW);
eq(rows.map((r) => r.id), ["20261105-110000-dddd", "20261105-100000-aaaa", "20261103-120000-bbbb", "20261101-120000-cccc"], "newest first");
eq(rows.map((r) => r.older), [false, false, false, true], "3 days is the line");
eq(da.recentCount(rows), 3);
eq(rows[0].quick, [], "an ask without quick answers is listed (no buttons)");
eq(rows[1].ageMs, 3600000);
eq(da.buildRows([mk("20261105-090000-eeee", { created: iso(NOW - 3 * DAY - 1000) })], NOW)[0].older, true, "just past 3 days is older");
eq(da.buildRows([mk("20261105-090000-eeee", { created: iso(NOW - 3 * DAY + 1000) })], NOW)[0].older, false, "just inside 3 days is recent");
// created missing -> the id's timestamp (local time) decides
const noCreated = mk("20261105-110000-ffff", { created: "" });
ok(!da.buildRows([noCreated], new Date(2026, 10, 5, 12, 0, 0).getTime())[0].older, "id timestamp used when created is missing");
ok(da.buildRows([mk("zz-nothing", { created: "" })], NOW)[0].older, "no usable time -> older, never pretends to be new");
ok(da.listKey(rows) !== da.listKey(rows.slice(1)));
eq(da.listKey(rows), da.listKey(da.buildRows([old, twoD, fresh, noQuick], NOW + 5000)), "age is not part of the key");

// ---- reading the folder: bad files skipped, newest first, no 100 cap ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thyra-asks-"));
for (let i = 0; i < 150; i++) { const id = "20261001-0000" + String(i).padStart(2, "0") + "-" + i.toString(16).padStart(4, "0"); fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(mk(id))); }
fs.writeFileSync(path.join(dir, "20261105-100000-aaaa.json"), "﻿" + JSON.stringify(fresh));
fs.writeFileSync(path.join(dir, "broken.json"), "{ half");
fs.writeFileSync(path.join(dir, "notes.txt"), "x");
const all = da.readAll(dir);
eq(all.length, 151, "more than 100 asks are listed");
eq(all[0].id, "20261105-100000-aaaa", "newest first (BOM tolerated)");
eq(da.readOne(dir, "20261105-100000-aaaa").question, "Merge it?");
eq(da.readOne(dir, "../x"), null); eq(da.readOne(dir, "nope"), null);
eq(da.readOne(dir, "broken"), null, "a half-written file is not an ask");

// ---- checkAnswer: stale, changed, label not in quick ----
const shown = da.shownOf(fresh);
ok(da.checkAnswer({ id: fresh.id, label: "Yes", shown }, fresh).ok);
ok(/already answered or withdrawn/.test(da.checkAnswer({ id: fresh.id, label: "Yes", shown }, null).error), "stale: file gone (answered or withdrawn)");
ok(/changed/.test(da.checkAnswer({ id: fresh.id, label: "Yes", shown }, mk(fresh.id, { question: "Delete everything?" })).error), "changed question");
ok(/changed/.test(da.checkAnswer({ id: fresh.id, label: "Yes", shown }, mk(fresh.id, { quick: ["Yes", "No", "Maybe"] })).error), "changed quick answers");
ok(/changed/.test(da.checkAnswer({ id: fresh.id, label: "Yes", shown }, mk(fresh.id, { agent: "Someone else" })).error), "changed agent");
ok(/changed/.test(da.checkAnswer({ id: fresh.id, label: "Yes", shown }, mk(fresh.id, { context: "new context" })).error), "changed context");
ok(/quick answers/.test(da.checkAnswer({ id: fresh.id, label: "Delete it", shown }, fresh).error), "label not in the ask's quick");
ok(/quick answers/.test(da.checkAnswer({ id: fresh.id, label: "yes", shown }, fresh).error), "label is matched exactly");
ok(!da.checkAnswer({ id: fresh.id, label: "Yes", shown: Object.assign({}, shown, { quick: ["Yes", "No", "Delete it"] }) }, fresh).ok, "the dock's own (forged) quick list is not trusted");
ok(!da.checkAnswer({ id: fresh.id, label: "Yes" }, fresh).ok, "no displayed question, no answer");
ok(!da.checkAnswer({ id: "../x", label: "Yes", shown }, fresh).ok); ok(!da.checkAnswer({ id: fresh.id, label: "", shown }, fresh).ok); ok(!da.checkAnswer(null, fresh).ok);
ok(!da.checkAnswer({ id: noQuick.id, label: "Yes", shown: da.shownOf(noQuick) }, noQuick).ok, "no quick answers: nothing can be sent");

// ---- answerFromDock: refuses before delivering; delivers the file's own question ----
(async () => {
  let calls = [];
  const deps = (ask) => ({ readOne: () => ask, deliver: async (d) => { calls.push(d); return { ok: true }; } });
  let r = await da.answerFromDock(deps(null), { id: fresh.id, label: "Yes", shown }); ok(!r.ok && calls.length === 0, "stale ask: nothing delivered");
  r = await da.answerFromDock(deps(mk(fresh.id, { question: "other" })), { id: fresh.id, label: "Yes", shown }); ok(!r.ok && calls.length === 0, "changed ask: nothing delivered");
  r = await da.answerFromDock(deps(fresh), { id: fresh.id, label: "Nope", shown }); ok(!r.ok && calls.length === 0, "label not in quick: nothing delivered");
  r = await da.answerFromDock(deps(fresh), { id: fresh.id, label: "No", shown }); ok(r.ok && calls.length === 1, "ok: delivered once");
  eq(calls[0], { id: fresh.id, label: "No", shown }, "delivered what the file says");
  r = await da.answerFromDock({ readOne: () => fresh, deliver: async () => ({ ok: false, error: "agent is paused", retry: true }) }, { id: fresh.id, label: "Yes", shown }); ok(!r.ok && r.error === "agent is paused" && r.retry === true, "delivery failure is reported");
  r = await da.answerFromDock({ readOne: () => fresh, deliver: async () => { throw new Error("boom"); } }, { id: fresh.id, label: "Yes", shown }); ok(!r.ok && /boom/.test(r.error));

  // ---- delivery order in the real renderer file: type -> seal -> resolve; refusals send nothing ----
  const order = [];
  function loadAO(over) {
    const win = { api: Object.assign({ listOpenQuestions: async () => [fresh], resolveOpenQuestion: async (id) => { order.push("resolve:" + id); return true; }, sealAnswer: async (id, text, via, sh) => { order.push("seal:" + id + ":" + text + ":" + via + ":" + (sh && sh.question)); return { ok: true }; },
      onAnswerOnceDeliver() {}, onDockAskDeliver: (cb) => { win._dock = cb; }, answerOnceResult: async (x) => { win._result = x; } }, over && over.api),
      queueSendToAgent: async (p, text) => { order.push("type:" + p + ":" + text); return { ok: true }; }, addEventListener() {}, dispatchEvent() {} };
    const doc = { querySelectorAll: (sel) => (sel === "#agent-list .agent-item" ? [{ dataset: { folderName: "Security", agentPath: "/a/Security" }, querySelector: () => ({ textContent: "Security & Infrastructure Agent" }) }] : []), querySelector: () => null };
    const ctx = { window: win, document: doc, CustomEvent: function (t, o) { this.type = t; this.detail = o.detail; }, setInterval() {}, Promise, console };
    vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "answer-once.js"), "utf8"), ctx);
    return win;
  }
  let win = loadAO();
  win._dock({ reqId: "d1", id: fresh.id, label: "Yes", shown }); await new Promise((res) => setTimeout(res, 30));
  eq(order, ["type:/a/Security:Iddo answers YES to your question: \"Merge it?\" (ask " + fresh.id + ", context: ctx). He agrees to: Merge it.", "seal:" + fresh.id + ":Yes:button:Merge it?", "resolve:" + fresh.id], "type into the ASKING agent, then seal (button, bound to the shown question), then resolve");
  eq(win._result, { reqId: "d1", ok: true, error: "", retry: false });
  order.length = 0; win = loadAO();
  win._dock({ reqId: "d2", id: fresh.id, label: "Yes", shown: Object.assign({}, shown, { question: "Something I never saw" }) }); await new Promise((res) => setTimeout(res, 30));
  eq(order, [], "the file differs from what the dock showed: nothing typed, sealed or resolved"); ok(win._result.ok === false && /changed/.test(win._result.error));
  win = loadAO({ api: { listOpenQuestions: async () => [] } });
  win._dock({ reqId: "d3", id: fresh.id, label: "Yes", shown }); await new Promise((res) => setTimeout(res, 30));
  eq(order, [], "answered meanwhile: nothing typed"); ok(!win._result.ok);
  win = loadAO(); win._dock({ reqId: "d4", id: fresh.id, label: "Delete it", shown }); await new Promise((res) => setTimeout(res, 30));
  eq(order, [], "label not in quick: nothing typed"); ok(!win._result.ok);

  // ---- the dock renderer (thyra-asks.js) with a tiny fake DOM ----
  const E = (tag, cls, text) => { const e = { tag, className: cls || "", textContent: text == null ? "" : text, children: [], listeners: {}, disabled: false, title: "", append(...k) { this.children.push(...k); }, addEventListener(t, f) { this.listeners[t] = f; } }; return e; };
  const walk = (e, f) => { f(e); e.children.forEach((c) => walk(c, f)); };
  const find = (e, pred) => { const out = []; walk(e, (x) => { if (pred(x)) out.push(x); }); return out; };
  let clock = NOW, timers = [];
  const answers = [];
  let listReply = rows;
  const api = { dockAsksList: async () => ({ ok: true, rows: listReply }), dockAskAnswer: async (req) => { answers.push(req); return api._reply || { ok: true }; } };
  const ctx2 = { window: {}, Promise, setTimeout, console }; ctx2.globalThis = ctx2; vm.createContext(ctx2);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "thyra-asks.js"), "utf8"), ctx2);
  const draws = []; let changes = 0;
  const A = ctx2.window.ThyraAsks.create({ api, el: E, fmt: (ms) => Math.round(ms / 1000) + "s", onChange: () => { changes++; }, now: () => clock, later: (f, ms) => timers.push([f, ms]) });
  await A.refresh();
  const paint = () => { const p = E("div"); const c = A.render(p); return { p, c }; };
  let { p, c } = paint();
  eq(c, 3, "header count = recent asks");
  const sec = find(p, (x) => x.className === "ap-sec")[0]; eq(sec.textContent, "Questions for you (3)");
  eq(find(p, (x) => x.className.indexOf("ap-ask") >= 0).length, 3, "the older ask is hidden by default");
  const older = find(p, (x) => x.className === "ap-older")[0]; eq(older.textContent, "Show older (1)");
  eq(find(p, (x) => x.className === "ap-qbtn").length, 4, "one button per quick answer (2 + 2 + 0)");
  ok(find(p, (x) => /answer in the agent's chat/.test(x.textContent)).length === 1, "no-quick ask: note, no buttons");
  ok(find(p, (x) => x.className === "ap-q").every((x) => x.title.length > 0), "full text on hover");
  ok(find(p, (x) => x.className === "ap-qbtn").every((b) => b.disabled), "buttons are disabled for 1 s after the list changed");
  // settle
  clock += 1100; ({ p } = paint());
  const btns = find(p, (x) => x.className === "ap-qbtn"); ok(btns.every((b) => !b.disabled), "enabled after 1 s");
  // an untrusted (scripted) click is ignored
  const first = btns[0];
  eq(A.click({ isTrusted: false }, A.rows()[1], "Yes"), null, "untrusted click ignored"); eq(A.click(null, A.rows()[1], "Yes"), null); eq(A.click({}, A.rows()[1], "Yes"), null);
  first.listeners.click({ isTrusted: false }); eq(answers.length, 0, "scripted click on the button sends nothing");
  // a trusted click while the list is still settling is ignored too
  A.setShowOlder(false); listReply = rows.slice(); await A.refresh(); // same list: no new settle
  const row = A.rows().filter((r) => r.id === fresh.id)[0];
  const pr = A.click({ isTrusted: true }, row, "Yes"); ok(pr !== null);
  eq(A.click({ isTrusted: true }, row, "Yes"), null, "a second click while sending is ignored");
  listReply = rows.filter((r) => r.id !== fresh.id);
  const res = await pr; ok(res.ok);
  eq(answers.length, 1); eq(answers[0], { id: fresh.id, label: "Yes", shown: { question: "Merge it?", agent: "Security", quick: ["Yes", "No"], context: "ctx", merav: false, created: fresh.created } }, "the click carries exactly what was drawn");
  ({ p } = paint());
  ok(find(p, (x) => /Answered: Yes \(sent to Security\)/.test(x.textContent)).length === 1, "short 'Answered: <label>' note");
  eq(A.rows().filter((r) => r.id === fresh.id).length, 0, "the row disappears once answered");
  // a refusal shows the reason and keeps the row
  clock += 1100; api._reply = { ok: false, error: "the question changed since it was shown" };
  const row3 = A.rows().filter((r) => r.quick.length)[0]; clock += 1100; await A.click({ isTrusted: true }, row3, row3.quick[0]);
  ({ p } = paint()); ok(find(p, (x) => /Not answered: the question changed/.test(x.textContent)).length >= 1, "refusal is shown");
  eq(answers.length, 2, "the refused click still went through main for the re-check");
  // refused because the ask vanished (answered elsewhere): the reason stays visible although the row is gone
  listReply = rows; api._reply = null; await A.refresh(); clock += 1100;
  const gone = A.rows().filter((r) => r.quick.length)[0]; api._reply = { ok: false, error: "that question is already answered or withdrawn" }; listReply = rows.filter((r) => r.id !== gone.id);
  await A.click({ isTrusted: true }, gone, gone.quick[0]); ({ p } = paint());
  ok(find(p, (x) => x.className.indexOf("ap-fail") >= 0 && /Not answered \(.*\): that question is already answered/.test(x.textContent)).length === 1, "stale click: reason shown although the row is gone");
  // show older toggle
  listReply = rows; api._reply = null; await A.refresh(); clock += 1100;
  ({ p } = paint()); const tg = find(p, (x) => x.className === "ap-older")[0]; tg.listeners.click({ isTrusted: false }); ({ p } = paint());
  eq(find(p, (x) => x.className.indexOf("ap-ask") >= 0).length > 0, true);
  const before = find(p, (x) => x.className.indexOf("ap-ask") >= 0).length;
  tg.listeners.click({ isTrusted: true }); ({ p } = paint());
  eq(find(p, (x) => x.className.indexOf("ap-ask") >= 0).length, before + 1, "Show older reveals the older ask");
  eq(find(p, (x) => x.className === "ap-older")[0].textContent, "Hide older (1)");
  // empty list draws nothing
  timers.forEach(([f]) => f()); listReply = []; await A.refresh(); ({ p, c } = paint()); eq(c, 0); eq(p.children.length, 0, "no asks, no section");
  // a failing list never throws
  api.dockAsksList = async () => { throw new Error("x"); }; await A.refresh(); eq(A.recentCount(), 0);

  // ---- wiring ----
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
  ok(/dock-asks-list/.test(rd("main.js")) && /dock-ask-answer/.test(rd("main.js")) && /dock-ask-deliver/.test(rd("main.js")), "main has the narrow IPC");
  ok(/isApprovalsSender\(event\)\) return \{ ok: false, error: "not from the main window" \};\s*\r?\n\s*const r = await dockAsks/.test(rd("main.js")), "the answer IPC refuses other senders");
  ok(/dockAsksList/.test(rd("approvals-window-preload.js")) && /dockAskAnswer/.test(rd("approvals-window-preload.js")) && !/queueSend|listOpenQuestions|resolveOpenQuestion|sealAnswer/.test(rd("approvals-window-preload.js")), "dock preload: only the narrow calls");
  ok(/onDockAskDeliver/.test(rd("preload.js")) && /dockAskAnswer/.test(rd("preload.js")));
  ok(/thyra-asks\.js[\s\S]*approvals-popup\.js/.test(rd("renderer/approvals-window.html")) && /thyra-asks\.js[\s\S]*approvals-popup\.js/.test(rd("renderer/index.html")), "both pages load thyra-asks.js before the popup script");
  ok(/waiting\(\)/.test(rd("renderer/approvals-popup.js")) && /asks\.recentCount\(\)/.test(rd("renderer/approvals-popup.js")), "chip count = prompts + recent asks");
  ok(!/slice\(0, 100\)/.test(rd("main.js").split('ipcMain.handle("list-open-questions"')[1].split("resolve-open-question")[0]), "list-open-questions has no 100 cap");
  // THYRA's own look: no second taskbar button, own amber icons (not the Agent Desktop logo)
  const mainSrc = rd("main.js"), bd = path.join(__dirname, "..", "build");
  ok(/title: "THYRA - Approvals".*skipTaskbar: true/.test(mainSrc), "dock window is skipTaskbar");
  ok(/new Tray\(thyraIcon\(false\)\)/.test(mainSrc) && /icon: thyraIcon\(false\)/.test(mainSrc), "tray and dock window use the THYRA icon");
  for (const f of ["icon-thyra.ico", "icon-thyra-badge.ico", "icon-thyra.png", "icon-thyra-badge.png", "make-thyra-icon.py"]) ok(fs.existsSync(path.join(bd, f)), f + " exists");
  ok(!fs.readFileSync(path.join(bd, "icon-thyra.ico")).equals(fs.readFileSync(path.join(bd, "icon.ico"))), "not the Agent Desktop icon");
  const ico = fs.readFileSync(path.join(bd, "icon-thyra.ico")); const sizes = []; for (let i = 0; i < ico.readUInt16LE(4); i++) sizes.push(ico[6 + i * 16] || 256);
  ok(sizes.includes(16) && sizes.includes(32), "ico has 16 and 32 px images");
  // ---- v1.154.1: age text, "No longer needed" (no answer, no seal), wrapping/scrollbar CSS, always-on-top ----
  const AT = ctx2.window.ThyraAsks.ageText;
  eq([AT(10000), AT(5 * 60000), AT(2 * 3600000), AT(40 * 3600000), AT(2 * DAY), AT(2 * DAY + 3600000)], ["now", "5 min", "2 h", "40 h", "2 days", "2 days"], "age text");
  eq(AT(47 * 3600000), "47 h", "just under 2 days stays hours");
  const qdir = fs.mkdtempSync(path.join(os.tmpdir(), "thyra-dismiss-")); fs.mkdirSync(path.join(qdir, "answered"));
  const put = (a) => fs.writeFileSync(path.join(qdir, a.id + ".json"), JSON.stringify(a));
  const dd = (extra) => Object.assign({ readOne: (id) => da.readOne(qdir, id), resolve: (id) => { fs.renameSync(path.join(qdir, id + ".json"), path.join(qdir, "answered", id + ".json")); return true; } }, extra);
  put(fresh); put(noQuick);
  let dr = da.dismissFromDock(dd(), { id: fresh.id, shown: da.shownOf(mk(fresh.id, { question: "other" })) }); ok(!dr.ok && /changed/.test(dr.error) && fs.existsSync(path.join(qdir, fresh.id + ".json")), "dismiss refuses a changed ask");
  dr = da.dismissFromDock(dd(), { id: "20269999-000000-zzzz", shown }); ok(!dr.ok && /already answered or withdrawn/.test(dr.error), "dismiss refuses a missing/stale ask");
  dr = da.dismissFromDock(dd(), { id: fresh.id }); ok(!dr.ok, "dismiss needs the displayed question");
  dr = da.dismissFromDock(dd(), { id: "../x", shown }); ok(!dr.ok, "bad id");
  dr = da.dismissFromDock(dd(), { id: fresh.id, shown }); ok(dr.ok, "dismiss ok");
  const moved = JSON.parse(fs.readFileSync(path.join(qdir, "answered", fresh.id + ".json"), "utf8"));
  ok(!fs.existsSync(path.join(qdir, fresh.id + ".json")) && !("seal" in moved) && !("answer" in moved), "file moved to answered\ with NO seal and NO answer written");
  dr = da.dismissFromDock(dd(), { id: noQuick.id, shown: da.shownOf(noQuick) }); ok(dr.ok, "an ask without quick answers can be cleared too");
  dr = da.dismissFromDock(dd({ resolve: () => { throw new Error("EPERM"); } }), { id: "x-1", shown }); ok(!dr.ok);
  fs.rmSync(qdir, { recursive: true, force: true });
  // renderer: untrusted ignored, trusted sends {id, shown} once and the row goes
  const dis = []; let dlist = rows.slice();
  const api3 = { dockAsksList: async () => ({ ok: true, rows: dlist }), dockAskAnswer: async () => ({ ok: true }), dockAskDismiss: async (r) => { dis.push(r); dlist = dlist.filter((x) => x.id !== r.id); return { ok: true }; } };
  let clock3 = NOW; const A3 = ctx2.window.ThyraAsks.create({ api: api3, el: E, fmt: String, onChange() {}, now: () => clock3, later() {} });
  await A3.refresh(); clock3 += 1100;
  const rowd = A3.rows()[1];
  eq(A3.dismiss({ isTrusted: false }, rowd), null, "untrusted dismiss ignored"); eq(dis.length, 0);
  const pdm = A3.dismiss({ isTrusted: true }, rowd); eq(A3.dismiss({ isTrusted: true }, rowd), null, "second click while sending ignored"); await pdm;
  eq(dis.length, 1); eq(dis[0], { id: rowd.id, shown: { question: rowd.question, agent: rowd.agent, quick: rowd.quick, context: rowd.context, merav: false, created: rowd.created } });
  eq(A3.rows().filter((r) => r.id === rowd.id).length, 0, "cleared row is gone");
  { const pp = E("div"); A3.render(pp); ok(find(pp, (x) => x.className === "ap-dismiss").length === A3.rows().filter((r) => !r.older).length, "every recent row has a No longer needed button"); ok(find(pp, (x) => x.className === "ap-wait").every((x) => /^(now|\d+ (min|h|days?))$/.test(x.textContent)), "age on every row"); }
  // CSS: wrapping, margin, visible scrollbar, header/buttons fixed above the list
  const css = rd("renderer/approvals-window.css");
  ok(/\.ap-btns \{[^}]*flex-wrap: wrap/.test(css) && /overflow-wrap: anywhere/.test(css) && /min-width: 0/.test(css), "wrapping rules");
  ok(/\.ap-list \{[^}]*overflow-y: scroll/.test(css) && /::-webkit-scrollbar \{/.test(css) && /::-webkit-scrollbar-track/.test(css) && /::-webkit-scrollbar-thumb/.test(css), "always-visible styled scrollbar");
  ok(/\.ap-list \{[^}]*padding: 0 12px 0 8px/.test(css), "right margin so nothing touches the edge");
  ok(/\.ap-head \{[^}]*flex: 0 0 auto/.test(css) && /\.ap-head \{[^}]*flex-wrap: wrap/.test(css), "header buttons wrap and stay above the list");
  // main: narrow IPC for dismiss, top level that holds
  ok(/dock-ask-dismiss/.test(rd("main.js")) && /dockAskDismiss/.test(rd("approvals-window-preload.js")) && /dockAskDismiss/.test(rd("preload.js")));
  ok(/isApprovalsSender\(event\)\) return \{ ok: false, error: "not from the main window" \};\s*const r = dockAsks\.dismissFromDock/.test(rd("main.js").replace(/\r/g, "")), "dismiss IPC refuses other senders");
  ok(!/getSealer|sealAnswer|sealIntoFile|seal-answer/.test(rd("main.js").split('ipcMain.handle("dock-ask-dismiss"')[1].split("v1.152.0 ANSWER ONCE")[0]), "dismiss path never touches the sealer");
  const mj = rd("main.js");
  ok(/setAlwaysOnTop\(true, "screen-saver"\)/.test(mj) && /moveTop\(\)/.test(mj) && /setInterval\(\(\) => \{ if \(w\.isDestroyed\(\)\) clearInterval\(topTimer\); else reassert\(\); \}, 1000\)/.test(mj) && /w\.on\("blur"/.test(mj), "always-on-top re-asserted on blur and every 1 s");
  ok(!/parent:/.test(mj.split("function openApprovalsWindow()")[1].split("w.loadFile")[0]), "dock window has no parent/owner");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("thyraAsks: " + n + " checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
