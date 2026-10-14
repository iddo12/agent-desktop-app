// node tests/decisions.test.js - My Daily Decisions tab: pure model, service (fake delivery: sent / queued / failed), store, IPC handlers.
"use strict";
const LK = require("../src/legacyKeys").KEYS;
const assert = require("assert");
const { cfgFor } = require("./helpers/dailyCfg");
const fs = require("fs");
const os = require("os");
const path = require("path");
const M = require("../src/daily/decisions-model");
const S = require("../src/daily/decisions-main");
const D = require("../src/daily/main-daily");
const W = { name: "Alex", poss: "Alex's", by: "Alex", subj: "he", obj: "him", reads: "reads" };   // what the owner's migration config reproduces
let fails = 0, n = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const NOW = Date.parse("2026-10-07T00:30:00Z");
const iso = (d) => new Date(NOW - d * 86400000).toISOString();
const task = (id, title, o) => Object.assign({ id, title, detail: "", status: "open", [LK.needs]: true, priority: 2, tags: [], created: iso(2), updated: iso(2) }, o || {});
const HEB = "שלום";

// ---------------------------------------------------------------- model
t("kind inference: go/no-go wording and the tag win; everything else is text", () => {
  const k = (title, o) => M.inferKind(task("x", title, o));
  for (const s of ["Go/no-go: deploy v1.78", "Approve Thursday newsletter", "Waiting for the go-ahead", "OK to deploy the worker", "Ostrakon: Alex to approve Stage 1", "Alex decision: merge decision for PR 6", "Green light for the shoot", "Sign-off on the scope"]) assert.strictEqual(k(s), "gonogo", s);
  for (const s of ["Telegram bot token", "Which lawyer covers Israeli e-commerce law?", "Choose hotel near the venue", "Confirm newsletter cadence", "Keep or remove the old mirror?", "Alex to listen to the audio A/B", "Approximately 5 percent"]) assert.strictEqual(k(s), "text", s);
  assert.strictEqual(k("Pick a name", { tags: ["decision:gonogo"] }), "gonogo");
  assert.strictEqual(k("Approve the thing", { tags: ["decision:text"] }), "text");
  assert.strictEqual(k("Pick a name", { detail: "Needs your go-ahead before we ship." }), "gonogo", "strong wording in the detail");
  assert.strictEqual(k("Pick a name", { detail: "Please approve the colour." }), "text", "weak words in the detail do not count");
});
t("open items: only needsOwner and not done, priority then newest first, ids are agent::task", () => {
  const stores = [
    { agent: "A", items: [task("1", "low old", { priority: 3, updated: iso(9), created: iso(9) }), task("2", "high", { priority: 1, updated: iso(5), created: iso(5) }), task("3", "no need", { [LK.needs]: false }), task("4", "done", { status: "done" }), task("5", "normal new", { updated: iso(0), created: iso(1) })] },
    { agent: "B", items: [task("1", "other agent same id", { updated: iso(1) })] },
    null, { agent: "C" }, { items: [] },
  ];
  const r = M.openItems(stores, {}, {});
  assert.deepStrictEqual(r.map((x) => x.id), ["A::2", "A::5", "B::1", "A::1"]);
  assert.strictEqual(r[0].agent, "A"); assert.strictEqual(r[0].taskId, "2");
});
t("dedupe: same agent and same title (case, punctuation) keeps the highest priority; different agents are kept", () => {
  const stores = [
    { agent: "A", items: [task("a1", "Pick the lawyer?", { priority: 2 }), task("a2", "pick the LAWYER", { priority: 1 }), task("a3", "Other")] },
    { agent: "B", items: [task("b1", "Pick the lawyer")] },
  ];
  const r = M.openItems(stores, {}, {});
  assert.deepStrictEqual(r.map((x) => x.id).sort(), ["A::a2", "A::a3", "B::b1"]);
});
t("answered items leave the open list while the task is unchanged; reappear when the agent updates the task", () => {
  const stores = [{ agent: "A", items: [task("1", "q", { updated: "2026-10-06T10:00:00" })] }];
  const ans = { "A::1": { taskUpdated: "2026-10-06T10:00:00", answeredAt: 5 } };
  assert.strictEqual(M.openItems(stores, ans, {}).length, 0);
  stores[0].items[0].updated = "2026-10-07T01:00:00";
  assert.strictEqual(M.openItems(stores, ans, {}).length, 1);
});
t("override switches the kind both ways and is reported", () => {
  const stores = [{ agent: "A", items: [task("1", "Approve x"), task("2", "Pick y")] }];
  const r = M.openItems(stores, {}, { "A::1": "text", "A::2": "gonogo", "A::9": "bogus" });
  const by = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.strictEqual(by["A::1"].kind, "text"); assert.strictEqual(by["A::1"].kindInferred, "gonogo"); assert.ok(by["A::1"].kindOverridden);
  assert.strictEqual(by["A::2"].kind, "gonogo");
});
t("archive: newest answer first, keeps text and time", () => {
  const r = M.archiveItems({ "A::1": { agent: "A", title: "t1", answer: "go", answeredAt: 10, kind: "gonogo" }, "B::2": { agent: "B", title: "t2", answer: "text", text: "hello", answeredAt: 20, delivery: "queued", kind: "text" }, "C::3": null });
  assert.deepStrictEqual(r.map((x) => x.id), ["B::2", "A::1"]);
  assert.strictEqual(r[0].text, "hello"); assert.strictEqual(r[0].delivery, "queued");
});
t("messages: fixed wording for Go / No-go, text carries the answer; limit refuses, never truncates", () => {
  const it = { title: "Deploy v1.78?", taskId: "dep" };
  assert.ok(M.messageFor(it, "go", undefined, W).startsWith("Alex answered GO to: Deploy v1.78?"));
  assert.ok(M.messageFor(it, "nogo", undefined, W).startsWith("Alex answered NO-GO to: Deploy v1.78?"));
  assert.ok(M.messageFor(it, "text", "  Use Kit.\nThanks ", W).startsWith("Alex's answer to: Deploy v1.78?\n\nUse Kit.\nThanks"));
  assert.strictEqual(M.validateAnswer("text", "text", "x".repeat(4000)).ok, true);
  const bad = M.validateAnswer("text", "text", "x".repeat(4001));
  assert.strictEqual(bad.ok, false); assert.ok(/4001/.test(bad.reason) && /nothing was sent/i.test(bad.reason));
  assert.strictEqual(M.validateAnswer("text", "text", "   ").ok, false);
  assert.strictEqual(M.validateAnswer("gonogo", "text", "x").ok, false);
  assert.strictEqual(M.validateAnswer("text", "go").ok, false);
});

// ---------------------------------------------------------------- grouping (v1.78.1), real titles from the fleet store (2026-10-07)
t("grouping: real questions land in Questions, real to-dos in Other", () => {
  const g = (title, o) => M.inferGroup(task("x", title, o));
  for (const s of ["Alex decision: merge Agent Desktop PR 6 (Restart All, v1.61.3+, sandbox-tested)", "Ostrakon: Alex to approve Stage 1 (4 decisions in paper section 6)", "Back-fill disclosures on published reviews? Review Writer found none", "Newsletter: 8 decisions for Alex (provider Kit, cadence)", "Decide: keep or remove 21 HyperFrames skills installed globally", "Alex: pick episode (54 or 56) for a blind auto-edit test", "Rank Math PRO purchase decision + organic growth action plan", "Which lawyer covers Israeli e-commerce law?", "Tasks panel open questions"]) assert.strictEqual(g(s), "questions", s);
  for (const s of ["Telegram bot token", "Install/trial Review Intake v0.2 on Pixel 8", "Run the NVIDIA clean-install script (DDU + driver 616.92)", "Add Sarah as UptimeRobot alert contact for cafeshoot + greenery", "Check B&H DataFeedFile for a product price feed", "Stream Deck app hangs on launch - needs Alex to check his screen"]) assert.strictEqual(g(s), "other", s);
  assert.strictEqual(g("Telegram bot token", { detail: "BotFather -> /newbot -> then --approve <chat id>. Tasks can now also be approved from the Tasks panel." }), "other", "approve in a detail alone is not a question");
  assert.strictEqual(g("Telegram bot token", { tags: ["decision"] }), "questions");
  assert.strictEqual(g("Anything", { tags: ["decision:gonogo"] }), "questions");
  assert.strictEqual(g("Anything", { detail: "Shall we ship it? Needs a reply." }), "questions", "a question in the detail");
  assert.strictEqual(g("Anything", { detail: "Use option A or B for the layout." }), "questions");
  assert.strictEqual(g("Layout choice", { detail: "Either A or B works." }), "questions");
});
t("grouping: Questions first in the list; Other items offer text unless switched; merge-decision title is Go/No-go", () => {
  const stores = [{ agent: "Security", items: [task("tg", "Telegram bot token", { priority: 1 }), task("pr6", "Alex decision: merge Agent Desktop PR 6", { priority: 3 }), task("nv", "Run the NVIDIA clean-install script", { tags: ["nvidia"] })] }];
  const r = M.openItems(stores, {}, {});
  assert.deepStrictEqual(r.map((x) => x.id), ["Security::pr6", "Security::tg", "Security::nv"]);
  assert.deepStrictEqual(r.map((x) => x.group), ["questions", "other", "other"]);
  assert.strictEqual(r[0].kind, "gonogo");
  assert.strictEqual(r[1].kind, "text");
  const sw = M.openItems(stores, {}, { "Security::tg": "gonogo" });
  assert.strictEqual(sw.find((x) => x.id === "Security::tg").kind, "gonogo", "Go/No-go only after a manual switch");
});

// ---------------------------------------------------------------- service
function mkService(over) {
  const root = (over && over.root) || fs.mkdtempSync(path.join(os.tmpdir(), "dec-"));
  const file = path.join(root, "daily", "decisions.json");
  const stores = [{ agent: "Security", items: [task("deploy", "Approve deploy of v1.78", { updated: "u1", detail: "details here" }), task("name", "Which name?", { updated: "u2" })] }, { agent: "Legal Agent", items: [task("lic", "Licence?", { updated: "u3" })] }];
  const sent = [], ran = [];
  const state = { delivery: { delivered: true, via: "channel", attempts: 1 } };
  const svc = S.createService(Object.assign({
    people: () => W, root, file, path, readStore: D.readStore, writeJsonAtomic: D.writeJsonAtomic, notices: [], now: () => NOW, say: () => {},
    loadStores: async () => ({ stores: JSON.parse(JSON.stringify(stores)), skipped: 0 }),
    deliver: async (p, text) => { sent.push({ p, text }); if (state.throws) throw new Error(state.throws); return state.delivery; },
    knownAgent: () => true,
    run: async (a) => { ran.push(a); if (state.runFails) throw new Error("tasks.py exploded"); return "ok"; },
  }, over || {}));
  svc.answerR = async (a) => { const v = await svc.view(); const it = v.open.find((x) => x.id === a.id); return svc.answer(Object.assign({ rev: it && it.rev }, a)); };
  return { svc, root, file, stores, sent, ran, state, say: (over && over.sayLog) || null };
}
const cleanup = (c) => fs.rmSync(c.root, { recursive: true, force: true });

t("go: delivered (sent), recorded in decisions.json, task updated with --set-needs-owner no, item moves to the archive", async () => {
  const c = mkService();
  const r = await c.svc.answerR({ id: "Security::deploy", answer: "go" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.delivery, "sent"); assert.strictEqual(r.warning, "");
  assert.strictEqual(c.sent.length, 1);
  assert.strictEqual(c.sent[0].p, path.join(c.root, "Security"));
  assert.ok(c.sent[0].text.startsWith("Alex answered GO to: Approve deploy of v1.78"));
  assert.deepStrictEqual(c.ran[0].slice(0, 6), ["--agent", "Security", "--update", "deploy", LK.needsFlag, "no"]);
  const det = c.ran[0][c.ran[0].indexOf("--detail") + 1];
  assert.ok(/Alex answered via My Daily: GO/.test(det)); assert.ok(det.startsWith("details here"), "old detail kept");
  const saved = JSON.parse(fs.readFileSync(c.file, "utf8"));
  assert.strictEqual(saved.answers["Security::deploy"].answer, "go"); assert.strictEqual(saved.answers["Security::deploy"].answeredAt, NOW);
  const v = await c.svc.view();
  assert.strictEqual(v.archive.length, 1); assert.strictEqual(v.archive[0].answer, "go");
  assert.ok(!v.open.some((x) => x.id === "Security::deploy"));
  cleanup(c);
});
t("text answer: message carries the text, the archive keeps it", async () => {
  const c = mkService();
  const r = await c.svc.answerR({ id: "Security::name", answer: "text", text: "Call it Iris.\n" + HEB });
  assert.strictEqual(r.ok, true);
  assert.ok(c.sent[0].text.startsWith("Alex's answer to: Which name?\n\nCall it Iris.\n" + HEB));
  const v = await c.svc.view();
  assert.strictEqual(v.archive[0].text, "Call it Iris.\n" + HEB);
  assert.ok(!v.open.some((x) => x.id === "Security::name"));
  cleanup(c);
});
t("queued (agent busy: handed over, transcript not confirmed) is recorded as queued", async () => {
  const c = mkService(); c.state.delivery = { delivered: false, via: "channel", attempts: 3 };
  const r = await c.svc.answerR({ id: "Legal Agent::lic", answer: "text", text: "no" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.delivery, "queued");
  assert.strictEqual((await c.svc.view()).archive[0].delivery, "queued");
  cleanup(c);
});
t("failed delivery (nothing handed over, aborted, dry run, or it throws): item stays open, nothing recorded, task not touched", async () => {
  for (const mode of [{ delivery: { delivered: false, via: null, attempts: 3 } }, { throws: "pipe closed" }, { delivery: { delivered: false, via: "channel", aborted: true } }, { delivery: { delivered: false, dry: true } }]) {
    const c = mkService(); Object.assign(c.state, mode);
    const r = await c.svc.answerR({ id: "Security::deploy", answer: "go" });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.delivery, "failed"); assert.ok(r.reason);
    assert.ok(!fs.existsSync(c.file), "no archive file written");
    assert.strictEqual(c.ran.length, 0);
    const v = await c.svc.view();
    assert.ok(v.open.some((x) => x.id === "Security::deploy")); assert.strictEqual(v.archive.length, 0);
    cleanup(c);
  }
});
t("tasks.py failure: answer still kept, warning shown, item still leaves the open list", async () => {
  const c = mkService(); c.state.runFails = true;
  const r = await c.svc.answerR({ id: "Security::deploy", answer: "go" });
  assert.strictEqual(r.ok, true); assert.ok(/could not be updated/.test(r.warning));
  const v = await c.svc.view();
  assert.ok(!v.open.some((x) => x.id === "Security::deploy")); assert.strictEqual(v.archive[0].taskNote, "failed");
  cleanup(c);
});
t("double click: a second answer while the first is in flight is refused, only one message is delivered", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const c = mkService({ deliver: async (p, text) => { c.sent.push({ p, text }); await gate; return { delivered: true, via: "channel" }; } });
  const p1 = c.svc.answerR({ id: "Security::deploy", answer: "go" });
  await new Promise((r) => setTimeout(r, 20));
  const r2 = await c.svc.answerR({ id: "Security::deploy", answer: "nogo" });
  assert.strictEqual(r2.ok, false); assert.ok(/already being sent/.test(r2.reason));
  assert.strictEqual(c.svc.inflightCount(), 1);
  release();
  assert.strictEqual((await p1).ok, true);
  assert.strictEqual(c.sent.length, 1); assert.strictEqual(c.svc.inflightCount(), 0);
  const r3 = await c.svc.answerR({ id: "Security::deploy", answer: "go" });
  assert.strictEqual(r3.ok, false, "answering again after it was answered is refused"); assert.strictEqual(c.sent.length, 1);
  cleanup(c);
});
t("a click answers exactly its own id; unknown ids, unknown agents and bad answers send nothing", async () => {
  const c = mkService();
  assert.strictEqual((await c.svc.answerR({ id: "Security::nope", answer: "go" })).ok, false);
  assert.strictEqual((await c.svc.answerR({ id: "nocolon", answer: "go" })).ok, false);
  assert.strictEqual((await c.svc.answerR({ id: "Security::deploy", answer: "maybe" })).ok, false);
  assert.strictEqual((await c.svc.answerR({ id: "Security::name", answer: "text", text: "" })).ok, false);
  assert.strictEqual((await c.svc.answerR({ id: "Security::name", answer: "text", text: "x".repeat(4001) })).ok, false);
  assert.strictEqual((await c.svc.answerR({ id: "Security::name", answer: "go" })).ok, false, "Go on a text item is refused");
  const c2 = mkService({ knownAgent: () => false });
  assert.strictEqual((await c2.svc.answerR({ id: "Security::deploy", answer: "go" })).ok, false);
  assert.strictEqual(c.sent.length + c2.sent.length, 0);
  await c.svc.answerR({ id: "Legal Agent::lic", answer: "text", text: "yes" });
  assert.strictEqual(c.sent.length, 1); assert.ok(c.sent[0].p.endsWith("Legal Agent"));
  cleanup(c); cleanup(c2);
});
t("switching kind is stored and applied; a Go on a switched item works", async () => {
  const c = mkService();
  assert.strictEqual((await c.svc.setKind({ id: "Security::name", kind: "gonogo" })).ok, true);
  assert.strictEqual((await c.svc.setKind({ id: "Security::name", kind: "weird" })).ok, false);
  const v = await c.svc.view();
  assert.strictEqual(v.open.find((x) => x.id === "Security::name").kind, "gonogo");
  assert.strictEqual((await c.svc.answerR({ id: "Security::name", answer: "go" })).ok, true);
  cleanup(c);
});
t("store: atomic write keeps a .bak, a damaged file is recovered from it, the archive survives a restart", async () => {
  const c = mkService();
  await c.svc.answerR({ id: "Security::deploy", answer: "go" });
  await c.svc.answerR({ id: "Legal Agent::lic", answer: "text", text: "ok" });
  assert.ok(fs.existsSync(c.file + ".bak"));
  fs.writeFileSync(c.file, "{ not json");
  const notices = [];
  const c2 = mkService({ root: c.root, notices });
  const v = await c2.svc.view();
  assert.strictEqual(v.archive.length, 1, "restored from the previous good copy");
  assert.ok(notices.length >= 1);
  cleanup(c);
});
t("fixture mode never calls the loader and offers fixture items; answers never touch tasks.py", async () => {
  const c = mkService({ fixtures: true, loadStores: async () => { throw new Error("must not be called"); } });
  const v = await c.svc.view();
  assert.ok(v.open.length >= 3); assert.ok(v.open.some((x) => x.kind === "gonogo")); assert.ok(v.counts.questions >= 1);
  const it = v.open[0];
  const r = await c.svc.answerR({ id: it.id, answer: it.kind === "gonogo" ? "go" : "text", text: "ok" });
  assert.strictEqual(r.ok, true); assert.strictEqual(c.ran.length, 0);
  cleanup(c);
});


// ---------------------------------------------------------------- v1.78.2
t("go/no-go inference: a question mark or an A-or-B / option X choice falls to text; the explicit tag overrides; merge decision stays go/no-go", () => {
  const k = (title, o) => M.inferKind(task("x", title, o));
  assert.strictEqual(k("Approve option A or B?"), "text");
  assert.strictEqual(k("Approve option B"), "text");
  assert.strictEqual(k("Approve A or B"), "text");
  assert.strictEqual(k("OK to deploy the worker?"), "text");
  assert.strictEqual(k("Approve the layout", { detail: "Pick option A or B." }), "text");
  assert.strictEqual(k("Approve option A or B?", { tags: ["decision:gonogo"] }), "gonogo", "the tag wins");
  assert.strictEqual(k("Alex decision: merge Agent Desktop PR 6 (Restart All, v1.61.3+, sandbox-tested)"), "gonogo");
  assert.strictEqual(k("Ostrakon: Alex to approve Stage 1 (4 decisions in paper section 6)"), "gonogo");
});
t("the card must send what it showed: unchanged item answers; a changed title, a changed detail, or a missing stamp is refused", async () => {
  for (const mut of [null, (it) => { it.title = "Approve deploy of v1.79 (edited)"; }, (it) => { it.detail = "details here, now different"; }, "norev"]) {
    const c = mkService();
    const v = await c.svc.view();
    const shown = v.open.find((x) => x.id === "Security::deploy");
    assert.ok(shown.rev);
    if (typeof mut === "function") mut(c.stores[0].items[0]);
    const svc2 = mut && typeof mut === "function" ? S.createService({ people: () => W, root: c.root, file: c.file, path, readStore: D.readStore, writeJsonAtomic: D.writeJsonAtomic, notices: [], now: () => NOW, say: () => {}, loadStores: async () => ({ stores: JSON.parse(JSON.stringify(c.stores)), skipped: 0 }), deliver: async (p, text) => { c.sent.push({ p, text }); return { delivered: true, via: "channel" }; }, knownAgent: () => true, run: async (a) => { c.ran.push(a); } }) : c.svc;
    const r = await svc2.answer({ id: "Security::deploy", answer: "go", rev: mut === "norev" ? undefined : shown.rev });
    if (mut === null) { assert.strictEqual(r.ok, true); assert.strictEqual(c.sent.length, 1); }
    else { assert.strictEqual(r.ok, false); assert.strictEqual(r.changed, true); assert.ok(/Item changed, reload/.test(r.reason)); assert.strictEqual(c.sent.length, 0); assert.strictEqual(c.ran.length, 0); assert.ok(!fs.existsSync(c.file)); }
    cleanup(c);
  }
});
t("task detail update: a 9000-char old detail keeps its TAIL plus the whole note inside 6000 chars, and the loss is logged", async () => {
  const old = "HEAD-" + "h".repeat(4100) + "-MIDDLE-" + "m".repeat(4900) + "-TAIL-END";
  const logs = [];
  const c = mkService({ say: (l) => logs.push(l) });
  c.stores[0].items[0].detail = old;
  assert.strictEqual(old.length >= 9000 && old.length < 9100, true);
  const r = await c.svc.answerR({ id: "Security::deploy", answer: "go" });
  assert.strictEqual(r.ok, true);
  const det = c.ran[0][c.ran[0].indexOf("--detail") + 1];
  assert.ok(det.length <= 6000, "length " + det.length);
  assert.ok(det.includes("-TAIL-END") && !det.includes("HEAD-"), "head cut, tail kept");
  assert.ok(/earlier characters cut by My Daily/.test(det));
  assert.ok(/Alex answered via My Daily: GO$/.test(det), "the note is intact at the end");
  assert.ok(logs.some((l) => l.includes("old " + old.length + " chars") && /head cut/.test(l)), logs.join("|"));
  cleanup(c);
  // pure: a long text answer keeps its (<= 600 char) note whole even with a huge old detail
  const note = "[2026-10-07 00:30] " + M.taskNoteText("text", "z".repeat(5000), "queued", W);
  const b = M.buildTaskDetail("o".repeat(20000), note);
  assert.ok(b.detail.length <= 6000 && b.detail.endsWith(note) && b.keptOld > 4000);
  assert.ok(/queued, not yet confirmed/.test(note));
  const small = M.buildTaskDetail("short", "N");
  assert.strictEqual(small.detail, "short\n\nN"); assert.strictEqual(small.cut, false);
});

// ---------------------------------------------------------------- IPC handlers (real main-daily wiring, fake deliver)
async function ansI(h, a) { const v = await h["daily-decisions-load"](OWN); const it = v.open.find((x) => x.id === a.id); return h["daily-decisions-answer"](OWN, Object.assign({ rev: it && it.rev }, a)); }
const WIN = { webContents: { id: 1, mainFrame: { id: "main" } } };
const OWN = { sender: WIN.webContents, senderFrame: WIN.webContents.mainFrame };
t("IPC: load / answer / kind through main-daily; foreign callers are refused; sent, queued, failed all surface", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dec-ipc-"));
  fs.mkdirSync(path.join(root, "shared_reports", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, "shared_reports", "tasks", "Security.json"), JSON.stringify({ agent: "Security", schema: "agent-tasks/1", items: [task("deploy", "Approve deploy", { updated: "u1" }), task("name", "Which name?", { updated: "u2" })] }));
  const h = {}, ran = [], delivered = [];
  let mode = "sent";
  D.init({
    ipcMain: { handle: (c, f) => { h[c] = f; } }, getMainWindow: () => WIN, cfg: cfgFor(root, { values: { ownerName: "Alex", partnerName: "Sarah" }, daily: { ownerPronouns: "he", partnerPronouns: "she", sharePartnerDefault: true } }), testMode: false, log: () => {},
    runPython: async (a) => { ran.push(a); return "ok"; },
    deliverToAgent: async (p, text) => { delivered.push({ p, text }); return mode === "sent" ? { delivered: true, via: "channel" } : mode === "queued" ? { delivered: false, via: "channel", attempts: 3 } : { delivered: false, via: null, attempts: 3 }; },
    knownAgent: () => true,
  });
  for (const c of ["daily-decisions-load", "daily-decisions-answer", "daily-decisions-kind"]) {
    for (const ev of [null, {}, { sender: { id: 2 } }]) { const r = await h[c](ev, {}); assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, "Not allowed."); }
  }
  const v = await h["daily-decisions-load"](OWN);
  assert.strictEqual(v.ok, true); assert.strictEqual(v.open.length, 2); assert.ok(v.open.some((x) => x.kind === "gonogo"));
  mode = "failed";
  const f = await ansI(h, { id: "Security::deploy", answer: "go" });
  assert.strictEqual(f.ok, false); assert.strictEqual(f.delivery, "failed");
  assert.strictEqual((await h["daily-decisions-load"](OWN)).open.length, 2, "failed delivery keeps the item open");
  mode = "queued";
  const q = await ansI(h, { id: "Security::deploy", answer: "go" });
  assert.strictEqual(q.ok, true); assert.strictEqual(q.delivery, "queued");
  mode = "sent";
  const s = await ansI(h, { id: "Security::name", answer: "text", text: "Iris" });
  assert.strictEqual(s.ok, true); assert.strictEqual(s.delivery, "sent");
  assert.strictEqual(ran.length, 2);
  const after = await h["daily-decisions-load"](OWN);
  assert.strictEqual(after.open.length, 0); assert.strictEqual(after.archive.length, 2);
  assert.strictEqual((await ansI(h, { id: "Security::deploy", answer: "go" })).ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});
t("IPC: without a delivery function (older host) nothing can be answered", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dec-ipc2-"));
  fs.mkdirSync(path.join(root, "shared_reports", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, "shared_reports", "tasks", "Security.json"), JSON.stringify({ agent: "Security", items: [task("a", "Approve")] }));
  const h = {};
  D.init({ ipcMain: { handle: (c, f) => { h[c] = f; } }, getMainWindow: () => WIN, cfg: cfgFor(root, { values: { ownerName: "Alex", partnerName: "Sarah" }, daily: { ownerPronouns: "he", partnerPronouns: "she", sharePartnerDefault: true } }), testMode: false, log: () => {}, runPython: async () => "ok" });
  const r = await ansI(h, { id: "Security::a", answer: "go" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual((await h["daily-decisions-load"](OWN)).open.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

(async () => {
  for (const q of queue) { n++; try { await q.fn(); } catch (e) { fails++; console.error("FAIL " + q.name + "\n  " + String(e.stack).split("\n").slice(0, 4).join("\n  ")); } }
  console.log(`decisions: ${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
})();
