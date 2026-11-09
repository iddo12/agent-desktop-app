// node tests/answerOnce.test.js - src/answerOnce.js (verify + inbox service), the Python signer in shared_tools/ask_confirm.py (cross-language),
// and src/renderer/answer-once.js (id finding, agent match, the one delivery path), loaded in a vm with stubs.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm"), assert = require("assert"), cp = require("child_process");
const A = require("../src/answerOnce");
let n = 0, fails = 0; const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ao-"));
const KEY = "ab".repeat(32), NOW = 1_800_000_000_000;
const ASK = { id: "20261031-014211-9f54", agent: "Security", question: "May I restart the NAS app?", quick: ["Yes", "No"] };
const sign = (over) => { const r = Object.assign({ v: 1, id: ASK.id, answer: "Yes", qhash: A.qhash(ASK), nonce: "c".repeat(32), ts: NOW }, over); r.mac = A.macOf(KEY, r); return r; };
const chk = (req, over) => A.verify(req, Object.assign({ key: KEY, now: NOW + 1000, ask: ASK, fileNonce: req.nonce }, over));

t("good request verifies", () => assert.strictEqual(chk(sign()).ok, true));
t("wrong key / tampered answer / tampered id are refused", () => {
  assert.strictEqual(chk(sign(), { key: "cd".repeat(32) }).ok, false);
  const r = sign(); r.answer = "No"; assert.match(chk(r).reason, /signature/);
  const r2 = sign(); r2.id = "20261031-014211-0000"; assert.match(chk(r2, { ask: Object.assign({}, ASK, { id: r2.id }) }).reason, /signature/);
});
t("unsigned or missing mac is refused", () => { const r = sign(); delete r.mac; assert.strictEqual(chk(r).ok, false); });
t("answer must be one of the ask's quick answers (even when signed)", () => assert.match(chk(sign({ answer: "Delete everything" })).reason, /quick/));
t("question text changed after the window: refused", () => assert.match(chk(sign(), { ask: Object.assign({}, ASK, { question: "Something else?" }) }).reason, /changed/));
t("asking agent or quick answers changed after the window: refused (agent could be retargeted)", () => {
  assert.match(chk(sign(), { ask: Object.assign({}, ASK, { agent: "Other agent" }) }).reason, /changed/);
  assert.match(chk(sign(), { ask: Object.assign({}, ASK, { quick: ["Yes", "No", "Sure"] }) }).reason, /changed/);
});
t("malformed key file is replaced, never used", () => {
  const d = tmp(); fs.writeFileSync(path.join(d, "key"), "abc\n");
  const k = A.readKey(d, true); assert.ok(/^[0-9a-f]{64}$/.test(k) && k !== "abc"); assert.strictEqual(A.readKey(d, false), k);
  const d2 = tmp(); fs.writeFileSync(path.join(d2, "key"), "xyz"); assert.strictEqual(A.readKey(d2, false), null);
});
t("ask no longer open: refused", () => assert.match(chk(sign(), { ask: null }).reason, /no longer open/));
t("stale and future requests are refused", () => {
  assert.match(chk(sign(), { now: NOW + A.MAX_AGE_MS + 1 }).reason, /stale/);
  assert.match(chk(sign(), { now: NOW - 120000 }).reason, /future/);
});
t("nonce must equal the file name", () => assert.match(chk(sign(), { fileNonce: "d".repeat(32) }).reason, /nonce/));
t("stateDir: env override, Windows default, no hard-coded drive", () => {
  assert.strictEqual(A.stateDir({ AGENT_DESKTOP_ANSWER_ONCE_DIR: "X:\\s" }, "win32", "H"), "X:\\s");
  assert.ok(/AgentDesktop[\\/]answer-once$/.test(A.stateDir({ LOCALAPPDATA: "L" }, "win32", "H")));
  assert.ok(/agent-desktop[\\/]answer-once$/.test(A.stateDir({}, "linux", "/home/u")));
});

function rig(extra) {
  const dir = tmp(), qdir = tmp(), delivered = [];
  fs.writeFileSync(path.join(dir, "key"), KEY + "\n");
  fs.writeFileSync(path.join(qdir, ASK.id + ".json"), JSON.stringify(ASK));
  let clock = NOW + 1000;
  const svc = A.createService(Object.assign({ dir, questionsDir: qdir, now: () => clock, deliver: async (r) => { delivered.push(r); return { ok: true }; } }, extra));
  const put = (req, name) => { fs.mkdirSync(svc.dirs.inbox, { recursive: true }); fs.writeFileSync(path.join(svc.dirs.inbox, (name || req.nonce) + ".json"), JSON.stringify(req)); };
  return { dir, qdir, svc, delivered, put, setClock: (c) => { clock = c; } };
}
const has = (d, f) => fs.existsSync(path.join(d, f + ".json"));

t("service: a signed request is delivered once, the file moves to done, the verdict is written", async () => {
  const r = rig(); const req = sign(); r.put(req);
  assert.strictEqual(await r.svc.scan(), 1);
  assert.deepStrictEqual(r.delivered, [{ id: ASK.id, agent: "Security", answer: "Yes" }]);
  assert.ok(has(r.svc.dirs.done, req.nonce) && !has(r.svc.dirs.inbox, req.nonce));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.svc.dirs.results, req.nonce + ".json"), "utf8")).ok, true);
  r.put(req); await r.svc.scan();                                           // replay of the same nonce
  assert.strictEqual(r.delivered.length, 1);
  fs.rmSync(path.join(r.svc.dirs.done, req.nonce + ".json")); r.put(req); await r.svc.scan();   // even if the done marker is lost, the used marker holds
  assert.strictEqual(r.delivered.length, 1);
});
t("service: forged, wrong-name, oversize and garbage files are never delivered", async () => {
  const r = rig();
  const forged = sign(); forged.mac = "0".repeat(64); r.put(forged);
  r.put(sign({ nonce: "e".repeat(32) }), "f".repeat(32));
  fs.writeFileSync(path.join(r.svc.dirs.inbox, "notanonce.json"), "{}");
  fs.writeFileSync(path.join(r.svc.dirs.inbox, "a".repeat(32) + ".json"), " ".repeat(5000));
  await r.svc.scan();
  assert.strictEqual(r.delivered.length, 0);
  assert.ok(has(r.svc.dirs.rejected, forged.nonce));
  assert.ok(fs.existsSync(path.join(r.svc.dirs.inbox, "notanonce.json")), "foreign names are left alone, never executed");
});
t("service: a request for a question that was answered meanwhile is refused", async () => {
  const r = rig(); fs.unlinkSync(path.join(r.qdir, ASK.id + ".json")); r.put(sign()); await r.svc.scan();
  assert.strictEqual(r.delivered.length, 0);
});
t("service: window not ready (retry) keeps the file, then delivers; after 10 minutes it is dropped", async () => {
  let ready = false; const r = rig({ deliver: async () => (ready ? { ok: true } : { ok: false, retry: true, error: "window not ready" }) });
  const req = sign(); r.put(req); await r.svc.scan();
  assert.ok(has(r.svc.dirs.inbox, req.nonce));
  ready = true; await r.svc.scan(); assert.ok(has(r.svc.dirs.done, req.nonce));
  const r2 = rig({ deliver: async () => ({ ok: false, retry: true }) }); const q2 = sign({ nonce: "9".repeat(32) }); r2.put(q2); r2.setClock(NOW + A.MAX_AGE_MS + 5000); await r2.svc.scan();
  assert.ok(has(r2.svc.dirs.rejected, q2.nonce));
});
t("service: a delivery failure is reported to the window and not retried", async () => {
  const r = rig({ deliver: async () => ({ ok: false, error: "the asking agent is not in the list" }) }); const req = sign(); r.put(req); await r.svc.scan();
  const v = JSON.parse(fs.readFileSync(path.join(r.svc.dirs.results, req.nonce + ".json"), "utf8"));
  assert.strictEqual(v.ok, false); assert.match(v.error, /not in the list/); assert.ok(has(r.svc.dirs.rejected, req.nonce));
});

t("Python signer (shared_tools/ask_confirm.py) and Node verifier agree", async () => {
  const py = path.join(__dirname, "..", "..", "shared_tools", "ask_confirm.py");
  const candidates = [process.env.ASK_CONFIRM_PY, py, "D:\\Dropbox\\Claude stuff\\shared_tools\\ask_confirm.py"].filter(Boolean).filter((p) => fs.existsSync(p));
  if (!candidates.length) { console.log("  (skipped: ask_confirm.py not found)"); return; }
  const r = rig();
  const code = "import sys,json;sys.path.insert(0,sys.argv[1]);import ask_confirm as c;ask=json.loads(sys.argv[3]);print(json.dumps(c.make_request(sys.argv[2],ask,'Yes',ts=" + NOW + ")))";
  const out = cp.spawnSync("python", ["-I", "-c", code, path.dirname(candidates[0]), KEY, JSON.stringify(ASK)], { encoding: "utf8" });
  if (out.error || out.status !== 0) { console.log("  (skipped: python not usable)"); return; }
  const req = JSON.parse(out.stdout); r.put(req); await r.svc.scan();
  assert.strictEqual(r.delivered.length, 1, "Node accepted the request the Python signer made");
});

t("wiring: main, preload, index.html, renderer hook", () => {
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
  assert.ok(/answer-once-deliver/.test(rd("main.js")) && /AGENT_DESKTOP_ANSWER_ONCE_DIR/.test(rd("main.js")));
  assert.ok(/onAnswerOnceDeliver/.test(rd("preload.js")) && /answerOnceResult/.test(rd("preload.js")));
  assert.ok(/answer-once\.js/.test(rd("renderer/index.html")) && /styles-answer-once\.css/.test(rd("renderer/index.html")));
  assert.ok(/AnswerOnce\.scan/.test(rd("renderer/renderer.js")));
  assert.ok(/answer-once-resolved/.test(rd("renderer/waiting-queue.js")));
});

// ---- renderer module ----
function loadRenderer(over) {
  const sent = [], resolved = [], listeners = {};
  const rowsEl = (over && over.rows) || [{ folder: "Security", name: "Security & Infrastructure Agent", path: "/a/Security" }];
  const win = { api: Object.assign({ listOpenQuestions: async () => [ASK], resolveOpenQuestion: async (id) => { resolved.push(id); return true; }, onAnswerOnceDeliver: (cb) => { win._deliver = cb; }, answerOnceResult: async () => true }, over && over.api),
    queueSendToAgent: async (p, text) => { sent.push([p, text]); return (over && over.sendResult) || { ok: true }; }, addEventListener() {}, dispatchEvent: (e) => { (listeners[e.type] = listeners[e.type] || []).push(e.detail); } };
  const doc = { querySelectorAll: (sel) => (sel === "#agent-list .agent-item" ? rowsEl.map((r) => ({ dataset: { folderName: r.folder, agentPath: r.path }, querySelector: () => ({ textContent: r.name }) })) : []), querySelector: () => null };
  const ctx = { window: win, document: doc, CustomEvent: function (type, o) { this.type = type; this.detail = o.detail; }, setInterval() {}, Promise, console };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "answer-once.js"), "utf8"), ctx);
  return { win, sent, resolved, events: listeners };
}
t("renderer: findIds finds open-ask ids once each, ignores other numbers", () => {
  const { win } = loadRenderer();
  assert.deepStrictEqual(Array.from(win.AnswerOncePure.findIds("see 20261031-014211-9f54 and again 20261031-014211-9f54, not 2026-10-31 or 20261031-014211-zzzz")), ["20261031-014211-9f54"]);
});
t("renderer: matchAgent follows the queue's rule", () => {
  const { win } = loadRenderer(); const P = win.AnswerOncePure, rows = [{ folder: "Software Engineering Agent", display: "SE", path: "p1" }, { folder: "Security", display: "Security & Infrastructure Agent", path: "p2" }];
  assert.strictEqual(P.matchAgent("Security", rows).path, "p2"); assert.strictEqual(P.matchAgent("software engineering", rows).path, "p1"); assert.strictEqual(P.matchAgent("Nobody", rows), null);
});
t("renderer: answer() sends the label into the ASKING agent's chat, then resolves, then tells the queue", async () => {
  const m = loadRenderer(); const r = await m.win.AnswerOnce.answer(ASK.id, "Yes");
  assert.strictEqual(r.ok, true); assert.deepStrictEqual(m.sent, [["/a/Security", `Iddo answers YES to your question: "${ASK.question}" (ask ${ASK.id}). He agrees to: May I restart the NAS app.`]]); assert.deepStrictEqual(m.resolved, [ASK.id]); assert.strictEqual(m.events["answer-once-resolved"].length, 1);
});
t("renderer v1.155.10: context sentence for Yes / No / other quick / free text; bare text only when the question is empty", () => {
  const { win } = loadRenderer(); const c = win.AnswerOncePure.contextSentence;
  const a = { id: "20261109-101010-abcd", question: "Deploy Specs staging build w8bf (adds Sirui Aurora 15mm/24mm, removes 7 Sony Alphas) to staging?", context: "staging only" };
  assert.strictEqual(c(a, "Yes", false), 'Iddo answers YES to your question: "' + a.question + '" (ask ' + a.id + ", context: staging only). He agrees to: " + a.question.replace(/\?$/, "") + ".");
  assert.strictEqual(c(a, "No", false), 'Iddo answers NO to your question: "' + a.question + '" (ask ' + a.id + ", context: staging only). He declines: " + a.question.replace(/\?$/, "") + ".");
  assert.strictEqual(c({ id: a.id, question: "Which one?" }, "Option B", false), 'Iddo answers "Option B" to your question: "Which one?" (ask ' + a.id + ").");
  assert.strictEqual(c({ id: a.id, question: "Which one?" }, "/run\nnow", true), 'Iddo answers your question: "Which one?" (ask ' + a.id + ') with this text: "/run now".');
  assert.strictEqual(c({ id: a.id, question: "   " }, "Yes", false), "Yes"); assert.strictEqual(c({ id: a.id }, "no", true), "no"); assert.strictEqual(c(null, "Yes", false), "Yes");
  assert.ok(c({ id: a.id, question: "x".repeat(5000) }, "Yes", false).length < 1700);
});
t("renderer: refuses text that is not a quick answer, a closed ask, an unknown agent; never resolves on a failed send", async () => {
  let m = loadRenderer(); assert.strictEqual((await m.win.AnswerOnce.answer(ASK.id, "Delete it")).ok, false); assert.strictEqual(m.sent.length, 0);
  m = loadRenderer({ api: { listOpenQuestions: async () => [] } }); assert.strictEqual((await m.win.AnswerOnce.answer(ASK.id, "Yes")).ok, false); assert.strictEqual(m.sent.length, 0);
  m = loadRenderer({ rows: [{ folder: "Other", name: "Other", path: "/o" }] }); assert.match((await m.win.AnswerOnce.answer(ASK.id, "Yes")).error, /not in the list/);
  m = loadRenderer({ sendResult: { ok: false, error: "agent is paused" } }); const r = await m.win.AnswerOnce.answer(ASK.id, "Yes");
  assert.strictEqual(r.ok, false); assert.strictEqual(m.resolved.length, 0);
});
t("renderer: a request from the confirm window goes through the same path and reports back", async () => {
  const m = loadRenderer(); let got = null; m.win.api.answerOnceResult = async (x) => { got = x; };
  m.win._deliver({ reqId: "r1", id: ASK.id, answer: "No" }); await new Promise((res) => setTimeout(res, 20));
  assert.deepStrictEqual(m.sent, [["/a/Security", `Iddo answers NO to your question: "${ASK.question}" (ask ${ASK.id}). He declines: May I restart the NAS app.`]]); assert.strictEqual(got.reqId, "r1"); assert.strictEqual(got.ok, true);
});

(async () => {
  for (const [name, fn] of queue) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } }
  console.log(n - fails + "/" + n + " answerOnce tests passed"); process.exit(fails ? 1 : 0);
})();
