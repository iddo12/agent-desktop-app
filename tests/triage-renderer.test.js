// node tests/triage-renderer.test.js - Tasks triage renderer (src/renderer/daily-triage.js): static guards, wiring in daily.js, and a behavioural
// run on a tiny fake DOM with fake timers (default view, Yes/No with undo, keys, expand blocks, write, triage mode, Old filter, bulk, live refresh).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const root = path.join(__dirname, "..", "src");
const src = fs.readFileSync(path.join(root, "renderer", "daily-triage.js"), "utf8");
const daily = fs.readFileSync(path.join(root, "renderer", "daily.js"), "utf8");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const css = fs.readFileSync(path.join(root, "renderer", "styles-daily.css"), "utf8");
let fails = 0, n = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

t("renderer compiles; textContent only; refresh interval is 60 s; listeners are removed when the tab is left", () => {
  new vm.Script(src, { filename: "daily-triage.js" });
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setInterval"]) assert.ok(!src.includes(bad), "uses " + bad);
  assert.ok(/REFRESH_MS = 60000/.test(src)); assert.ok(/removeEventListener\("focus"/.test(src) && /removeEventListener\("keydown"/.test(src));
  assert.ok((src.match(/setAttribute\("dir", "auto"\)/g) || []).length >= 8, "Hebrew-safe text");
});
t("wiring: script before daily.js, Tasks tab renders the triage view, badge + tab count use the needs-Alex number, force reload invalidates, preload channels", () => {
  assert.ok(html.indexOf("daily-triage.js") > 0 && html.indexOf("daily-triage.js") < html.indexOf('src="daily.js"'));
  assert.ok(/tab === "tasks"\) body\.append\(triView \? triView\.render\(\) : renderTasks\(\)\)/.test(daily));
  assert.ok(/triView\.needsCount\(\)/.test(daily) && /b\.count = tn/.test(daily) && /force && triView/.test(daily));
  assert.ok(/s\.tasksNeed/.test(daily) && !/tasks: \[s\.tasksOpen/.test(daily), "tab count is not the open total");
  for (const c of ["daily-triage-load", "daily-triage-answer", "daily-triage-ask", "daily-triage-snooze", "daily-triage-unsnooze", "daily-triage-close"]) assert.ok(preload.includes(c), c);
  for (const c of [".tri-row", ".tri-card", ".tri-modal", ".tri-undo", ".tri-yn.big"]) assert.ok(css.includes(c), c);
});

class FEl {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.className = ""; this._text = ""; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.value = ""; this.disabled = false; this.checked = false; this.parent = null; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  append(...k) { for (const c of k) { if (c) { c.parent = this; this.children.push(c); } } }
  replaceChildren() { this.children = []; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
  closest(sel) { let e = this; while (e) { if (sel.startsWith(".") && String(e.className).split(" ").includes(sel.slice(1))) return e; e = e.parent; } return null; }
  all(pred, out) { out = out || []; if (pred(this)) out.push(this); for (const c of this.children) c.all(pred, out); return out; }
  click() { if (this.disabled) return; for (const f of this.listeners.click || []) f({ preventDefault() {} }); }
  fire(ev, e) { for (const f of this.listeners[ev] || []) f(e || {}); }
}
const NOW = Date.now();
const it = (id, o) => Object.assign({ id, agent: id.split("::")[0], taskId: id.split("::")[1], title: "T " + id, rev: "r-" + id, priority: 2, created: NOW - 2 * 86400000, updated: NOW - 86400000, ageDays: 2, updDays: 1, old: false, structured: false, ask: "", recommend: "", why: "", rest: "", preview: "plain detail of " + id, previewCut: false, gonogo: false, group: "needs", snoozedUntil: 0, queuedAt: 0, askedAt: 0, tags: [] }, o || {});
function mkEnv(items, over) {
  const calls = [];
  const state = { items: items.slice() };
  const view = () => {
    const needs = state.items.filter((x) => x.group === "needs"), backlog = state.items.filter((x) => x.group === "backlog"), ideas = state.items.filter((x) => x.group === "ideas");
    return { ok: true, now: NOW, needs, backlog, ideas, snoozed: [], skipped: 0, max: 4000, counts: { needs: needs.length, backlog: backlog.length, ideas: ideas.length, snoozed: 0, open: state.items.length, needsOld: needs.filter((x) => x.old).length, gonogo: needs.filter((x) => x.gonogo).length } };
  };
  const api = Object.assign({
    calls, state,
    triageLoad: async () => { calls.push({ op: "load" }); return view(); },
    triageAnswer: async (id, answer, text, rev, clear) => { calls.push({ op: "answer", id, answer, text, rev, clear }); state.items = state.items.filter((x) => x.id !== id); return { ok: true, delivery: "sent", cleared: true }; },
    triageAsk: async (id) => { calls.push({ op: "ask", id }); return { ok: true, delivery: "sent" }; },
    triageSnooze: async (ids, kind) => { calls.push({ op: "snooze", ids, kind }); state.items = state.items.filter((x) => !ids.includes(x.id)); return { ok: true, count: ids.length }; },
    triageUnsnooze: async () => ({ ok: true }),
    triageClose: async (ids, note, revs) => { calls.push({ op: "close", ids, note, revs }); state.items = state.items.filter((x) => !ids.includes(x.id)); return { ok: true, closed: ids.length, failed: 0, results: ids.map((id) => ({ id, ok: true })) }; },
  }, over || {});
  const said = [], timers = [], docL = {}, winL = {};
  const doc = { activeElement: null, hidden: false, addEventListener: (e, f) => { docL[e] = f; }, removeEventListener: (e) => { delete docL[e]; } };
  const win = { addEventListener: (e, f) => { winL[e] = f; }, removeEventListener: (e) => { delete winL[e]; } };
  let active = true;
  const ctx = {
    el: (tag, cls, text) => { const e = new FEl(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; },
    btn: (label, cls, fn) => { const b = new FEl("button"); b.className = cls || ""; b.textContent = label; b.addEventListener("click", fn); return b; },
    say: (m) => said.push(m), api, emptyState: (a) => { const e = new FEl("div"); e.textContent = a; return e; },
    rerender: () => { ctx.redraws++; }, refreshTabs: () => { ctx.tabs++; }, isActive: () => active, redraws: 0, tabs: 0,
  };
  const sandbox = { window: win, document: doc, console, Date, setTimeout: (f, ms) => { const h = { f, ms, on: true }; timers.push(h); return h; }, clearTimeout: (h) => { if (h) h.on = false; } };
  vm.runInNewContext(src, sandbox, { filename: "daily-triage.js" });
  const v = sandbox.window.dailyTriage.create(ctx);
  return { v, ctx, api, said, timers, docL, winL, doc, setActive: (b) => { active = b; },
    fireTimer: async (ms) => { const hs = timers.filter((h) => h.on && h.ms === ms); for (const h of hs) { h.on = false; await h.f(); } await flush(); } };
}
const buttons = (r, label) => r.all((e) => e.tagName === "BUTTON" && e.textContent === label);
const flush = () => new Promise((r) => setTimeout(r, 15));
async function draw(v) { v.render(); await flush(); return v.render(); }
const key = (env, k, extra) => { let prevented = false; env.docL.keydown(Object.assign({ key: k, target: { tagName: "BODY" }, preventDefault() { prevented = true; } }, extra || {})); return prevented; };

const GN = (id, o) => it(id, Object.assign({ gonogo: true, structured: true, ask: "Should we ship " + id + "?", recommend: "Yes, ship " + id, why: "Because " + id }, o || {}));

t("default view: only needs-Alex rows with the count; backlog and ideas are collapsed groups with counts and their rows are not drawn", async () => {
  const env = mkEnv([GN("A::1"), it("B::2"), it("C::3", { group: "backlog", title: "Agent own chore" }), it("C::4", { group: "ideas", title: "An idea" })]);
  const w = await draw(env.v);
  const txt = w.textContent;
  assert.ok(txt.includes("2") && txt.includes("need you")); assert.ok(txt.includes("T A::1") && txt.includes("T B::2"));
  assert.ok(!txt.includes("Agent own chore") && !txt.includes("An idea"), "collapsed groups draw no rows");
  assert.strictEqual(buttons(w, "▸ Agents' own backlog").length, 1); assert.strictEqual(buttons(w, "▸ Ideas").length, 1);
  assert.strictEqual(env.v.tabCount()[0], 2); assert.strictEqual(env.v.needsCount(), 2);
  buttons(w, "▸ Agents' own backlog")[0].click();
  const w2 = env.v.render(); assert.ok(w2.textContent.includes("Agent own chore") && !w2.textContent.includes("An idea"));
  assert.ok(!w2.all((e) => e.className.includes("tri-yes")).some((e) => e.parent.parent.parent.dataset.id === "C::3"), "no Yes/No on backlog");
});
t("Yes / No buttons only on go/no-go needs rows; a click queues with Undo, nothing is sent until the undo window ends", async () => {
  const env = mkEnv([GN("A::1"), it("B::2")]);
  const w = await draw(env.v);
  assert.strictEqual(buttons(w, "Yes").length, 1); assert.strictEqual(buttons(w, "No").length, 1);
  buttons(w, "Yes")[0].click();
  assert.strictEqual(env.api.calls.filter((c) => c.op === "answer").length, 0, "held for the undo window");
  const w2 = env.v.render(); assert.ok(w2.textContent.includes("Undo (Z)")); assert.ok(!w2.textContent.includes("T A::1"), "the card left the list at once");
  env.v._state().pending === true || assert.fail("pending");
  await env.fireTimer(6000);
  const a = env.api.calls.find((c) => c.op === "answer"); assert.ok(a); assert.deepStrictEqual([a.id, a.answer, a.rev], ["A::1", "yes", "r-A::1"]);
  assert.ok(env.said.some((m) => /Sent and confirmed/.test(m)));
});
t("Undo cancels: nothing sent, the card is back", async () => {
  const env = mkEnv([GN("A::1")]);
  let w = await draw(env.v); buttons(w, "No")[0].click();
  buttons(env.v.render(), "Undo (Z)")[0].click();
  await env.fireTimer(6000);
  assert.strictEqual(env.api.calls.filter((c) => c.op === "answer").length, 0);
  assert.ok(env.v.render().textContent.includes("T A::1")); assert.ok(env.said.some((m) => /Undone/.test(m)));
});
t("a newer action flushes the older one at once (only the last action is undoable)", async () => {
  const env = mkEnv([GN("A::1"), GN("A::2")]);
  const w = await draw(env.v); buttons(w, "Yes")[0].click();
  buttons(env.v.render(), "No")[0].click(); await flush();
  assert.deepStrictEqual(env.api.calls.filter((c) => c.op === "answer").map((c) => c.answer), ["yes"], "first went out, second is still held");
});
t("keys: Y/N act on the selected row; ignored while typing; ignored on a non yes/no row; Z undoes", async () => {
  const env = mkEnv([GN("A::1"), it("B::2")]);
  let w = await draw(env.v);
  assert.strictEqual(key(env, "y"), false, "no row selected yet");
  w.all((e) => e.className.includes("tri-title"))[1].fire("click"); // select B::2 (not yes/no)
  w = env.v.render(); key(env, "y"); assert.strictEqual(env.v._state().pending, false);
  w.all((e) => e.className.includes("tri-title"))[0].fire("click");
  assert.strictEqual(key(env, "y", { target: { tagName: "TEXTAREA" } }), false); assert.strictEqual(env.v._state().pending, false, "typing");
  assert.strictEqual(key(env, "y"), true); assert.strictEqual(env.v._state().pending, true);
  key(env, "z"); assert.strictEqual(env.v._state().pending, false);
  key(env, "n"); await env.fireTimer(6000);
  assert.strictEqual(env.api.calls.find((c) => c.op === "answer").answer, "no");
});
t("expand: ASK is the headline and RECOMMEND / WHY IT MATTERS are labelled blocks; rest of the detail is shown", async () => {
  const env = mkEnv([GN("A::1", { rest: "extra notes" })]);
  let w = await draw(env.v); buttons(w, "▸ What is this?")[0].click(); w = env.v.render();
  const txt = w.textContent;
  assert.ok(w.all((e) => e.className.includes("tri-ask")).some((e) => e.textContent === "Should we ship A::1?"));
  assert.ok(txt.includes("RECOMMEND") && txt.includes("Yes, ship A::1") && txt.includes("WHY IT MATTERS") && txt.includes("Because A::1") && txt.includes("extra notes"));
  assert.ok(!txt.includes("No agent recommendation yet"));
});
t("expand without a recommendation: first-600 text, the note, and the Ask button delivers the request; asked state is disabled", async () => {
  const env = mkEnv([it("B::2", { previewCut: true })]);
  let w = await draw(env.v); buttons(w, "▸ What is this?")[0].click(); w = env.v.render();
  assert.ok(w.textContent.includes("plain detail of B::2") && w.textContent.includes("No agent recommendation yet") && w.textContent.includes("first 600"));
  buttons(w, "Ask the agent for a recommendation")[0].click(); await flush();
  assert.deepStrictEqual(env.api.calls.find((c) => c.op === "ask"), { op: "ask", id: "B::2" });
  assert.ok(env.said.some((m) => /Asked B/.test(m)));
});
t("write: free-text box + Send queues a text answer (with the clear flag); empty is refused; Ctrl+Enter sends; the draft survives a redraw and a failure", async () => {
  let fail = true;
  const env = mkEnv([it("B::2")], { triageAnswer: async (id, answer, text, rev, clear) => { env.api.calls.push({ op: "answer", id, answer, text, rev, clear }); return fail ? { ok: false, reason: "The agent did not take it" } : { ok: true, delivery: "sent", cleared: true }; } });
  let w = await draw(env.v); buttons(w, "▸ What is this?")[0].click(); w = env.v.render();
  const ta = w.all((e) => e.tagName === "TEXTAREA")[0];
  buttons(w, "Send")[0].click(); assert.ok(env.said.some((m) => /Write your note first/.test(m))); assert.strictEqual(env.v._state().pending, false);
  ta.value = "Use Kit"; ta.fire("input");
  assert.strictEqual(env.v.render().all((e) => e.tagName === "TEXTAREA")[0].value, "Use Kit", "draft kept across redraws");
  ta.fire("keydown", { key: "Enter", ctrlKey: true, preventDefault() {} });
  assert.strictEqual(env.v._state().pending, true);
  await env.fireTimer(6000);
  const a = env.api.calls.find((c) => c.op === "answer"); assert.deepStrictEqual([a.id, a.answer, a.text, a.clear], ["B::2", "text", "Use Kit", true]);
  w = env.v.render(); assert.ok(w.textContent.includes("The agent did not take it") && w.textContent.includes("T B::2"), "failure keeps the task and shows why");
  assert.strictEqual(w.all((e) => e.tagName === "TEXTAREA")[0].value, "Use Kit");
});
t("snooze and close-with-note on an expanded row: snooze is undoable; close asks for confirmation first, then calls close with the note", async () => {
  const env = mkEnv([it("B::2"), it("C::3")]);
  let w = await draw(env.v); buttons(w, "▸ What is this?")[0].click(); w = env.v.render();
  buttons(w, "Until tomorrow")[0].click(); await env.fireTimer(6000);
  assert.strictEqual(JSON.stringify(env.api.calls.find((c) => c.op === "snooze")), JSON.stringify({ op: "snooze", ids: ["B::2"], kind: "tomorrow" }));
  w = env.v.render(); buttons(w, "▸ What is this?")[0].click(); w = env.v.render();
  buttons(w, "Close with note...")[0].click(); w = env.v.render();
  assert.ok(w.textContent.includes("Close 1 task?") && w.textContent.includes("C: T C::3"));
  assert.strictEqual(env.api.calls.filter((c) => c.op === "close").length, 0, "nothing closed before the confirm");
  w.all((e) => e.tagName === "TEXTAREA").slice(-1)[0].fire("input"); // (modal note box)
  buttons(w, "Close task")[0].click(); await flush();
  assert.strictEqual(env.api.calls.find((c) => c.op === "close").ids[0], "C::3"); assert.strictEqual(env.api.calls.find((c) => c.op === "close").revs["C::3"], "r-C::3", "close carries the shown stamp");
});
t("Old (>7 d) filter shows only old rows; the count line reports how many", async () => {
  const env = mkEnv([it("A::1", { old: true, ageDays: 20, updDays: 9 }), it("B::2")]);
  let w = await draw(env.v); assert.ok(w.textContent.includes("1 old (>7 d)"));
  buttons(w, "Old (>7 d)")[0].click(); w = env.v.render();
  assert.ok(w.textContent.includes("T A::1") && !w.textContent.includes("T B::2")); assert.ok(w.textContent.includes("1 of 2"));
  assert.ok(w.textContent.includes("created 20 d ago") && w.textContent.includes("agent updated 9 d ago"), "age since created and since last agent update");
});
t("bulk: select rows, Close selected lists the titles in a confirm and closes only after confirming; Snooze selected the same", async () => {
  const env = mkEnv([it("A::1"), it("B::2"), it("C::3")]);
  let w = await draw(env.v);
  const boxes = w.all((e) => e.className.includes("tri-sel"));
  boxes[0].checked = true; boxes[0].fire("change"); w = env.v.render();
  w.all((e) => e.className.includes("tri-sel"))[2].checked = true; w.all((e) => e.className.includes("tri-sel"))[2].fire("change"); w = env.v.render();
  assert.ok(w.textContent.includes("2 selected"));
  buttons(w, "Close selected")[0].click(); w = env.v.render();
  assert.ok(w.textContent.includes("Close 2 tasks?") && w.textContent.includes("A: T A::1") && w.textContent.includes("C: T C::3") && !w.textContent.includes("B: T B::2"));
  assert.strictEqual(env.api.calls.filter((c) => c.op === "close").length, 0);
  buttons(w, "Cancel")[0].click(); assert.ok(!env.v.render().textContent.includes("Close 2 tasks?")); assert.strictEqual(env.api.calls.filter((c) => c.op === "close").length, 0);
  w = env.v.render(); buttons(w, "1 week")[0].click(); w = env.v.render();
  assert.ok(w.textContent.includes("Snooze 2 tasks for 1 week?")); buttons(w, "Snooze")[0].click(); await env.fireTimer(6000);
  assert.strictEqual(JSON.stringify(env.api.calls.find((c) => c.op === "snooze")), JSON.stringify({ op: "snooze", ids: ["A::1", "C::3"], kind: "week" }));
});
t("triage mode: first card = go/no-go ASK headline with RECOMMEND/WHY, 'n left'; Y answers, Space skips to the end, S snoozes, W opens the box, Z undoes, Esc leaves", async () => {
  const env = mkEnv([GN("A::1"), GN("A::2"), it("B::3")]);
  let w = await draw(env.v); buttons(w, "Triage")[0].click(); w = env.v.render();
  assert.ok(w.textContent.includes("3 left")); assert.ok(w.all((e) => e.className.includes("tri-ask big"))[0].textContent === "Should we ship A::1?");
  assert.ok(w.textContent.includes("Yes, ship A::1") && w.textContent.includes("Because A::1"));
  for (const l of ["Write (W)", "Snooze (S)", "Skip (Space)"]) assert.strictEqual(buttons(w, l).length, 1, l);
  assert.strictEqual(key(env, " "), true); w = env.v.render();
  assert.ok(w.all((e) => e.className.includes("tri-ask big"))[0].textContent === "Should we ship A::2?", "skipped card moved on");
  key(env, "s"); assert.ok(env.v.render().textContent.includes("snooze 1 task until tomorrow"));
  key(env, "z"); assert.strictEqual(env.v._state().pending, false); w = env.v.render();
  assert.ok(w.textContent.includes("3 left"), "undo restored the card");
  key(env, "y"); await env.fireTimer(6000);
  assert.deepStrictEqual(env.api.calls.find((c) => c.op === "answer").id, "A::2");
  w = env.v.render(); assert.ok(w.textContent.includes("2 left"));
  key(env, "w"); w = env.v.render(); assert.strictEqual(w.all((e) => e.tagName === "TEXTAREA").length, 1);
  key(env, "Escape", { target: { tagName: "BODY" } }); assert.strictEqual(env.v._state().triage, false);
});
t("triage on a non yes/no card: Yes and No are disabled and the keys do nothing; empty queue shows the empty state", async () => {
  const env = mkEnv([it("B::3")]);
  let w = await draw(env.v); buttons(w, "Triage")[0].click(); w = env.v.render();
  assert.ok(buttons(w, "Yes")[0].disabled && buttons(w, "No")[0].disabled); key(env, "y"); assert.strictEqual(env.v._state().pending, false);
  const env2 = mkEnv([]); w = await draw(env2.v); buttons(w, "Triage")[0].click(); assert.ok(env2.v.render().textContent.includes("Nothing is waiting on you"));
});
t("live refresh: one 60 s timer while the tab is on screen (re-reads and redraws), focus re-reads, nothing runs once the tab is left; no redraw while typing", async () => {
  const env = mkEnv([it("A::1")]);
  await draw(env.v); assert.strictEqual(env.v._state().live, true);
  assert.deepStrictEqual(env.timers.filter((h) => h.on).map((h) => h.ms), [60000]);
  const loads0 = env.api.calls.filter((c) => c.op === "load").length, r0 = env.ctx.redraws;
  await env.fireTimer(60000);
  assert.strictEqual(env.api.calls.filter((c) => c.op === "load").length, loads0 + 1); assert.ok(env.ctx.redraws > r0);
  env.doc.activeElement = { tagName: "TEXTAREA", closest: () => true };
  const r1 = env.ctx.redraws; await env.fireTimer(60000); assert.strictEqual(env.ctx.redraws, r1, "typing: data refreshed, no redraw"); env.doc.activeElement = null;
  assert.ok(env.winL.focus, "focus listener while live"); await new Promise((r) => setTimeout(r, 1));
  env.setActive(false); await env.fireTimer(60000);
  assert.strictEqual(env.v._state().live, false); assert.ok(!env.winL.focus && !env.docL.keydown, "listeners removed"); assert.strictEqual(env.timers.filter((h) => h.on).length, 0);
});
t("a closed task disappears on the next read (the view always shows what the store returned)", async () => {
  const env = mkEnv([it("A::1"), it("B::2")]);
  let w = await draw(env.v); assert.ok(w.textContent.includes("T B::2"));
  env.api.state.items = env.api.state.items.filter((x) => x.id !== "B::2");
  await env.fireTimer(60000);
  assert.ok(!env.v.render().textContent.includes("T B::2")); assert.strictEqual(env.v.needsCount(), 1);
});

(async () => {
  for (const q of queue) { n++; try { await q.fn(); } catch (e) { fails++; console.error("FAIL " + q.name + "\n  " + String(e.stack).split("\n").slice(0, 5).join("\n  ")); } }
  console.log(`triage-renderer: ${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
})();
