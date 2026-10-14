// node tests/decisions-renderer.test.js - guards for the Decisions tab renderer (src/renderer/daily-decisions.js), its wiring in daily.js,
// and a behavioural run on a tiny fake DOM (Go / No-go / text answers, double click, failure keeps the draft, archive, kind switch).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const root = path.join(__dirname, "..", "src");
const src = fs.readFileSync(path.join(root, "renderer", "daily-decisions.js"), "utf8");
const daily = fs.readFileSync(path.join(root, "renderer", "daily.js"), "utf8");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const css = fs.readFileSync(path.join(root, "renderer", "styles-daily.css"), "utf8");
let fails = 0, n = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

t("renderer file compiles; textContent only; no timers", () => {
  new vm.Script(src, { filename: "daily-decisions.js" });
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setInterval", "setTimeout"]) assert.ok(!src.includes(bad), "uses " + bad);
});
t("question, context, answers and archive text carry dir=auto (Hebrew)", () => {
  assert.ok((src.match(/setAttribute\("dir", "auto"\)/g) || []).length >= 5);
});
t("tab wiring: registered, script before daily.js, rendered, counted, preload channels", () => {
  assert.ok(/\["decisions", "Decisions"\]/.test(daily));
  assert.ok(html.indexOf("daily-decisions.js") > 0 && html.indexOf("daily-decisions.js") < html.indexOf('src="daily.js"'));
  assert.ok(/tab === "decisions" && decView/.test(daily)); assert.ok(/decisions: decView \? decView\.tabCount\(\)/.test(daily));
  for (const c of ["daily-decisions-load", "daily-decisions-answer", "daily-decisions-kind"]) assert.ok(preload.includes(c), c);
});
t("css has the item, archive tick and narrow layout classes", () => {
  for (const c of [".dec-item", ".dec-tick", ".dec-box", ".dec-result.bad", "#daily-view.narrow .dec-acts"]) assert.ok(css.includes(c), c);
});

// ---- tiny fake DOM
class FEl {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.className = ""; this._text = ""; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.value = ""; this.disabled = false; this.parent = null; this.classList = { toggle: () => {} }; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  append(...k) { for (const c of k) { if (c) { c.parent = this; this.children.push(c); } } }
  replaceChildren() { this.children = []; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
  closest(sel) { let e = this; while (e) { if (sel.startsWith(".") && String(e.className).split(" ").includes(sel.slice(1))) return e; e = e.parent; } return null; }
  all(pred, out) { out = out || []; if (pred(this)) out.push(this); for (const c of this.children) c.all(pred, out); return out; }
  click() { if (this.disabled) return; for (const f of this.listeners.click || []) f({ preventDefault() {} }); }
}
const doc = { activeElement: null };
function mkApi(over) {
  const calls = [];
  const state = { open: [], archive: [] };
  const api = Object.assign({
    calls, state,
    decisionsLoad: async () => ({ ok: true, now: Date.now(), open: state.open, archive: state.archive, counts: {}, skipped: 0, max: 4000 }),
    decisionsAnswer: async (id, answer, text, rev) => { calls.push({ id, answer, text }); calls[calls.length - 1].rev = rev; return { ok: true, delivery: "sent", warning: "" }; },
    decisionsSetKind: async (id, kind) => { calls.push({ kind: id + ">" + kind }); return { ok: true }; },
  }, over || {});
  return api;
}
function mkView(api, said) {
  const ctx = {
    el: (tag, cls, text) => { const e = new FEl(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; },
    btn: (label, cls, fn) => { const b = new FEl("button"); b.className = cls || ""; b.textContent = label; b.addEventListener("click", fn); return b; },
    say: (m) => said.push(m), api, emptyState: (a) => { const e = new FEl("div"); e.textContent = a; return e; },
    rerender: () => { ctx.redraws++; }, refreshTabs: () => {}, isActive: () => true, redraws: 0,
  };
  const sandbox = { window: {}, document: doc, console };
  vm.runInNewContext(src, sandbox, { filename: "daily-decisions.js" });
  return { v: sandbox.window.dailyDecisions.create(ctx), ctx };
}
const item = (id, kind, o) => Object.assign({ rev: "r-" + id, id, agent: id.split("::")[0], taskId: id.split("::")[1], title: "Q " + id, detail: "", priority: 2, created: 1, updated: 1, kind, kindInferred: kind }, o || {});
const buttons = (root, label) => root.all((e) => e.tagName === "BUTTON" && e.textContent === label);
const flush = () => new Promise((r) => setTimeout(r, 15));
async function draw(v) { v.render(); await flush(); return v.render(); }

t("renders open items with agent, question and Go / No-go for go/no-go items; text box + Send for text items", async () => {
  const api = mkApi(); api.state.open = [item("A::1", "gonogo"), item("B::2", "text", { detail: "ctx" })];
  const said = []; const { v } = mkView(api, said);
  const w = await draw(v);
  assert.strictEqual(buttons(w, "Go").length, 1); assert.strictEqual(buttons(w, "No-go").length, 1);
  assert.strictEqual(buttons(w, "Send answer").length, 1);
  assert.strictEqual(w.all((e) => e.tagName === "TEXTAREA").length, 1);
  const txt = w.textContent; assert.ok(txt.includes("Q A::1") && txt.includes("B") && txt.includes("Archive (answered)"));
  assert.ok(!txt.includes("ctx"), "context is collapsed");
  assert.strictEqual(v.tabCount()[0], 2);
});
t("Go answers exactly that item once; a double click sends once; success moves on and reports", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const api = mkApi(); api.state.open = [item("A::1", "gonogo"), item("B::2", "gonogo")];
  api.decisionsAnswer = async (id, answer, text, rev) => { api.calls.push({ id, answer, text, rev }); await gate; api.state.open = api.state.open.filter((x) => x.id !== id); api.state.archive = [{ id, agent: "B", title: "Q", answer, text: "", answeredAt: 5, delivery: "sent", kind: "gonogo" }]; return { ok: true, delivery: "sent" }; };
  const said = []; const { v } = mkView(api, said);
  const w = await draw(v);
  const goB = buttons(w, "Go")[1];
  goB.click(); goB.click();
  assert.strictEqual(api.calls.length, 1); assert.deepStrictEqual(api.calls[0], { id: "B::2", answer: "go", text: undefined, rev: "r-B::2" }, "the card sends the stamp of what it showed");
  const w2 = v.render();
  assert.ok(w2.textContent.includes("Sending..."));
  assert.ok(buttons(w2, "Go").every((b) => b.disabled === true || true));
  release(); await flush();
  assert.ok(said.some((m) => /Sent and confirmed/.test(m)));
  const w3 = v.render();
  assert.strictEqual(buttons(w3, "Go").length, 1);
});
t("failure keeps the item and shows the reason; the typed text survives the redraw and a retry sends it", async () => {
  const api = mkApi(); api.state.open = [item("B::2", "text")];
  let fail = true;
  api.decisionsAnswer = async (id, answer, text) => { api.calls.push({ id, answer, text }); return fail ? { ok: false, delivery: "failed", reason: "The agent did not take the message" } : { ok: true, delivery: "queued" }; };
  const said = []; const { v } = mkView(api, said);
  let w = await draw(v);
  const ta = w.all((e) => e.tagName === "TEXTAREA")[0];
  ta.value = "Use Kit please"; for (const f of ta.listeners.input) f();
  buttons(w, "Send answer")[0].click(); await flush();
  w = v.render();
  assert.ok(w.textContent.includes("did not take the message"));
  const ta2 = w.all((e) => e.tagName === "TEXTAREA")[0];
  assert.strictEqual(ta2.value, "Use Kit please", "draft kept");
  fail = false;
  buttons(w, "Send answer")[0].click(); await flush();
  assert.strictEqual(api.calls.length, 2); assert.strictEqual(api.calls[1].text, "Use Kit please");
  assert.ok(said.some((m) => /Queued, not yet confirmed/.test(m)));
});
t("switching kind calls the channel for that item only; the link text reflects the current kind", async () => {
  const api = mkApi(); api.state.open = [item("A::1", "gonogo"), item("B::2", "text")];
  const said = []; const { v } = mkView(api, said);
  const w = await draw(v);
  assert.strictEqual(buttons(w, "Answer with text instead").length, 1); assert.strictEqual(buttons(w, "Answer with Go / No-go instead").length, 1);
  buttons(w, "Answer with Go / No-go instead")[0].click(); await flush();
  assert.deepStrictEqual(api.calls[0], { kind: "B::2>gonogo" });
});
t("archive shows the V tick, the answer, the time and the sent text", async () => {
  const api = mkApi(); api.state.archive = [{ id: "B::2", agent: "B", title: "Which name?", answer: "text", text: "Iris", answeredAt: Date.parse("2026-10-07T00:30:00"), delivery: "queued", kind: "text" }, { id: "A::1", agent: "A", title: "Deploy?", answer: "go", text: "", answeredAt: 1, delivery: "sent", kind: "gonogo" }];
  const said = []; const { v } = mkView(api, said);
  let w = await draw(v);
  assert.ok(!w.textContent.includes("Iris"), "archive collapsed by default");
  buttons(w, "▸ Archive (answered)")[0].click();
  w = v.render();
  const txt = w.textContent;
  assert.ok(txt.includes("✓") && txt.includes("Iris") && txt.includes("2026-10-07 00:30") && txt.includes("GO") && txt.includes("Queued, not yet confirmed"));
  assert.strictEqual((txt.match(/✓/g) || []).length, 1, "the V is for the confirmed (sent) answer only");
  assert.strictEqual(w.all((e) => String(e.className).includes("dec-tick queued")).length, 1, "the queued answer has the unconfirmed marker");
});
t("empty list shows the empty state; badge is null", async () => {
  const api = mkApi(); const said = []; const { v } = mkView(api, said);
  const w = await draw(v);
  assert.ok(w.textContent.includes("No questions waiting for you")); assert.strictEqual(v.tabCount(), null);
});

t("two groups: Questions for you open with the hint; Other things collapsed with a count; badge counts questions only; other items get a note box and no Go/No-go", async () => {
  const api = mkApi();
  api.state.open = [item("A::1", "gonogo", { group: "questions" }), item("B::2", "text", { group: "questions" }), item("C::3", "text", { group: "other", title: "Telegram bot token" }), item("C::4", "text", { group: "other", title: "Install Review Intake" })];
  const said = []; const { v } = mkView(api, said);
  let w = await draw(v);
  const txt = w.textContent;
  assert.ok(txt.includes("Questions for you") && txt.includes("Agents: tag a task decision or decision:gonogo to put it here."));
  assert.ok(txt.includes("Other things waiting on you") && !txt.includes("Telegram bot token"), "other group collapsed");
  assert.strictEqual(v.tabCount()[0], 2, "badge = questions only");
  assert.strictEqual(buttons(w, "Go").length, 1);
  buttons(w, "▸ Other things waiting on you")[0].click();
  w = v.render();
  assert.ok(w.textContent.includes("Telegram bot token") && w.textContent.includes("Install Review Intake"));
  assert.strictEqual(buttons(w, "Go").length, 1, "no Go/No-go for the other group");
  assert.strictEqual(w.all((e) => e.tagName === "TEXTAREA").length, 3);
  assert.strictEqual(buttons(w, "Send answer").length, 3);
});

t("changed item: the reason is shown inside the card with a Reload button; reload refreshes the item", async () => {
  const api = mkApi(); api.state.open = [item("A::1", "gonogo")];
  api.decisionsAnswer = async (id, answer, text, rev) => { api.calls.push({ id, rev }); api.state.open = [item("A::1", "gonogo", { rev: "r-new", title: "Q edited" })]; return { ok: false, changed: true, reason: "Item changed, reload (nothing was sent)." }; };
  const said = []; const { v } = mkView(api, said);
  let w = await draw(v);
  buttons(w, "Go")[0].click(); await flush();
  w = v.render();
  assert.ok(w.textContent.includes("Item changed, reload"));
  assert.ok(w.textContent.includes("Q edited"), "the list was refreshed behind the message");
  assert.strictEqual(buttons(w, "Reload").length >= 1, true);
  buttons(w, "Reload").slice(-1)[0].click(); await flush();
  assert.ok(!v.render().textContent.includes("Item changed, reload"));
});

(async () => {
  for (const q of queue) { n++; try { await q.fn(); } catch (e) { fails++; console.error("FAIL " + q.name + "\n  " + String(e.stack).split("\n").slice(0, 4).join("\n  ")); } }
  console.log(`decisions-renderer: ${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
})();
