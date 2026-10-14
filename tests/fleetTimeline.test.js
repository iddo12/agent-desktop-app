// node tests/fleetTimeline.test.js - Fleet timeline (v1.120.0): src/fleetTimeline.js on TEMP fixtures (never the real Exchange folder or IRIS log).
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const T = require("../src/fleetTimeline"), M = require("../src/fleetMailbox");
M.configure({ inbox: "to_Owner_fleet", outbox: "from_Owner_fleet", owner: "Alex", partner: "Sarah", role: "COO" }); // the owner-computer migration values: fixtures stay as they were
let n = 0, fails = 0; const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const HOUR = 3600000, DAY = 24 * HOUR;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleettl-"));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const day = (d) => { const x = new Date(Date.now() - d * DAY), p = (v) => String(v).padStart(2, "0"); return x.getFullYear() + "-" + p(x.getMonth() + 1) + "-" + p(x.getDate()); };
const W = (dir, name, text, ageMs) => { const f = path.join(dir, name); fs.writeFileSync(f, text); const tm = new Date(Date.now() - (ageMs || 0)); fs.utimesSync(f, tm, tm); };
const iso = (ageMs) => new Date(Date.now() - ageMs).toISOString();
const mkEx = () => { const root = tmp(); fs.mkdirSync(path.join(root, "to_Owner_fleet")); fs.mkdirSync(path.join(root, "from_Owner_fleet")); return { root, A: path.join(root, "to_Owner_fleet"), B: path.join(root, "from_Owner_fleet") }; };
const mkIris = (lines, peers) => {
  const dir = tmp(); fs.mkdirSync(path.join(dir, "log"));
  const ym = new Date().toISOString().slice(0, 7);
  fs.writeFileSync(path.join(dir, "log", ym + ".jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  if (peers) fs.writeFileSync(path.join(dir, "peers.json"), JSON.stringify(peers));
  return dir;
};
const L = (root, o) => { M._resetCache(); T._reset(); return T.listTimeline(root, Object.assign({ force: true }, o)); };
const find = (r, id) => r.items.find((i) => i.id === id);

t("IRIS: queued + delivered are joined by id; received has text; delivered carries no text", async () => {
  const dir = mkIris([
    { at: iso(5 * HOUR), event: "queued", dir: "out", peer: "p1", id: "m1", type: "question", hop: 0, text: "Can you send the fan list?" },
    { at: iso(5 * HOUR - 1000), event: "delivered", dir: "out", peer: "p1", id: "m1" },
    { at: iso(4 * HOUR), event: "received", dir: "in", peer: "p1", id: "r1", type: "info", hop: 0, text: "Here it is" },
    { at: iso(3 * HOUR), event: "queued", dir: "out", peer: "p1", id: "m2", type: "info", text: "Thanks" },
    { at: iso(2 * HOUR), event: "frame-dropped", ip: "1.2.3.4", reason: "x" },
  ], { p1: { id: "p1", name: "Sarah's COO" } });
  const r = await L(path.join(dir, "no-exchange"), { irisDir: dir });
  assert.ok(r.ok && r.found && !r.exchangeFound && r.irisCount === 3);
  const m1 = find(r, "iris:m1"), m2 = find(r, "iris:m2"), r1 = find(r, "iris:r1");
  assert.strictEqual(m1.status, "delivered"); assert.strictEqual(m1.text, "Can you send the fan list?"); assert.strictEqual(m1.dir, "out"); assert.strictEqual(m1.to, "Sarah's COO");
  assert.strictEqual(m2.status, "queued"); assert.strictEqual(r1.dir, "in"); assert.strictEqual(r1.from, "Sarah's COO");
  assert.ok(m1.answeredAt && m1.answeredBy === "Sarah's COO", "r1 is later than m1 => answered"); assert.strictEqual(m2.answeredAt, null, "nothing after m2");
  const th = r.threads[0]; assert.ok(th.waiting && th.key === "iris-p1", "thread waits on m2"); assert.deepStrictEqual(th.items, ["iris:m1", "iris:r1", "iris:m2"], "oldest first inside a thread");
  rm(dir);
});
t("IRIS: rejected / expired / pending-approval states, torn lines skipped, unknown peer name falls back", async () => {
  const dir = mkIris(["{not json", { at: iso(HOUR), event: "send-pending-approval", peer: "pz", id: "a", type: "info", text: "needs ok" }, { at: iso(HOUR - 10), event: "send-approved", dir: "out", peer: "pz", id: "a", text: "needs ok" },
    { at: iso(HOUR - 20), event: "rejected", dir: "out", peer: "pz", id: "a", reason: "daily-cap" }, { at: iso(30 * 60000), event: "queued", dir: "out", peer: "pz", id: "b", text: "x" }, { at: iso(1000), event: "expired", dir: "out", peer: "pz", id: "b" },
    { at: iso(2000), event: "rejected", dir: "in", peer: "pz", id: "zzz", reason: "bad" }]);
  const r = await L(path.join(dir, "none"), { irisDir: dir });
  assert.strictEqual(find(r, "iris:a").status, "rejected"); assert.strictEqual(find(r, "iris:a").reason, "daily-cap"); assert.strictEqual(find(r, "iris:b").status, "expired");
  assert.ok(!find(r, "iris:zzz"), "an incoming rejection is not a message"); assert.ok(/^IRIS peer pz/.test(find(r, "iris:a").to)); rm(dir);
});
t("exchange + IRIS merge: sides, sources, status 'in-mailbox', answered by a later Sarah note in the same thread", async () => {
  const F = mkEx();
  W(F.B, day(2) + "_Security_to-COO_fan-control-question.md", "To: Sarah's COO. From: Security.\n\nWhich fans does she have?\n", 2 * DAY);
  W(F.A, day(1) + "_to-Security_fan-control-answer.md", "To: Security. From: Sarah's COO.\n\nThree Noctua fans.\n", 1 * DAY);
  W(F.B, day(1) + "_Security_to-COO_greenery-redirect-plan.md", "To: Sarah's COO. From: Security.\n\nPlan attached.\n", 1 * HOUR);
  const dir = mkIris([{ at: iso(2 * HOUR), event: "received", dir: "in", peer: "p1", id: "r9", type: "info", text: "\u05e9\u05dc\u05d5\u05dd \u05d1\u05d5\u05e7\u05e8 \u05d8\u05d5\u05d1" }], { p1: { id: "p1", name: "Sarah" } });
  const r = await L(F.root, { irisDir: dir });
  assert.ok(r.exchangeFound && r.found && r.items.length === 4);
  const q = find(r, "exchange:owner/" + fs.readdirSync(F.B).find((f) => /fan-control/.test(f))), a = find(r, "exchange:partner/" + fs.readdirSync(F.A)[0]);
  assert.strictEqual(q.dir, "out"); assert.strictEqual(q.status, "in-mailbox"); assert.strictEqual(a.dir, "in"); assert.strictEqual(q.source, "exchange"); assert.ok(q.lazy);
  assert.ok(q.answeredAt, "later note from Sarah's side in the same thread => answered");
  const plan = r.items.find((i) => /redirect-plan/.test(i.id)); assert.strictEqual(plan.answeredAt, null, "no reply on the redirect plan"); assert.ok(r.threads.find((x) => x.items.includes(plan.id)).waiting);
  assert.strictEqual(find(r, "iris:r9").source, "iris"); assert.ok(r.threads.length === 3);
  for (let i = 1; i < r.threads.length; i++) assert.ok(r.threads[i - 1].newestMs >= r.threads[i].newestMs, "newest thread first");
  rm(F.root); rm(dir);
});
t("unread counts incoming IRIS + file notes newer than lastSeen; maxPartnerMtime covers IRIS", async () => {
  const F = mkEx(); W(F.A, day(0) + "_to-X_fresh_note.md", "hi", 10 * 60000);
  const dir = mkIris([{ at: iso(5 * 60000), event: "received", dir: "in", peer: "p", id: "i1", text: "hey" }, { at: iso(3 * DAY), event: "received", dir: "in", peer: "p", id: "i0", text: "old" }]);
  const r = await L(F.root, { irisDir: dir, lastSeen: Date.now() - HOUR });
  assert.strictEqual(r.unread, 2); assert.ok(r.maxPartnerMtime >= Date.parse(iso(5 * 60000)) - 5000); rm(F.root); rm(dir);
});
t("bounded reads: only the last IRIS_MAX message entries, a huge log is tail-read, unchanged log hits the cache", async () => {
  const lines = []; for (let i = 0; i < 600; i++) lines.push({ at: iso((600 - i) * 1000), event: "received", dir: "in", peer: "p", id: "m" + i, text: "x".repeat(50) });
  const dir = mkIris(lines);
  const a = await T.readIris(dir); assert.strictEqual(a.items.length, T.IRIS_MAX); assert.strictEqual(a.items[a.items.length - 1].id, "iris:m599"); assert.strictEqual(a.items[0].id, "iris:m" + (600 - T.IRIS_MAX));
  const b = await T.readIris(dir); assert.strictEqual(a, b, "same object from the cache");
  // > 1 MB file: only the tail is read (the first lines are never parsed)
  const big = []; for (let i = 0; i < 6000; i++) big.push(JSON.stringify({ at: iso(1000), event: "received", dir: "in", peer: "p", id: "b" + i, text: "y".repeat(300) }));
  const d2 = mkIris(big); const c = await T.readIris(d2); assert.strictEqual(c.items.length, T.IRIS_MAX); assert.ok(c.items.every((i) => /^iris:b5[0-9]{3}$/.test(i.id)));
  const long = mkIris([{ at: iso(1000), event: "received", dir: "in", peer: "p", id: "L", text: "z".repeat(20000) }]); const d = await T.readIris(long); assert.ok(d.items[0].text.length <= T.TEXT_MAX + 3);
  rm(dir); rm(d2); rm(long);
});
t("IRIS: an inbound entry with a colliding id (or another peer) cannot change our message state", async () => {
  const dir = mkIris([{ at: iso(3 * HOUR), event: "queued", dir: "out", peer: "p1", id: "c1", text: "hello" }, { at: iso(2 * HOUR), event: "rejected", dir: "in", peer: "p1", id: "c1", reason: "bad" },
    { at: iso(HOUR), event: "expired", dir: "out", peer: "OTHER", id: "c1" }]);
  const r = await L(path.join(dir, "none"), { irisDir: dir }); assert.strictEqual(find(r, "iris:c1").status, "queued"); rm(dir);
});
t("an outgoing attachment never makes a thread wait or counts as unanswered; log parse skips noise lines", async () => {
  const F = mkEx(); W(F.B, day(1) + "_Security_to-COO_pics_for_review.md", "To: X. From: Security.\n\nsee pics\n", 3 * HOUR); W(F.A, day(1) + "_to-Security_pics_for_review_ok.md", "To: Security. From: X.\n\nok\n", 2 * HOUR);
  W(F.B, day(1) + "_Security_pics_for_review.png", "x", 1 * HOUR);
  const r = await L(F.root, { irisDir: path.join(F.root, "noiris") }); const th = r.threads.find((x) => x.items.some((i) => /pics_for_review.png/.test(i))); assert.ok(th, "thread found"); assert.strictEqual(th.waiting, false); assert.strictEqual(find(r, th.items.find((i) => /png/.test(i))).answeredAt, undefined); rm(F.root);
  const lines = []; for (let i = 0; i < 300; i++) lines.push(JSON.stringify({ at: iso(1000), event: "frame-dropped", ip: "1.1.1." + i, reason: "x" })); lines.push("{\"event\":\"queued\"  broken");
  const d = mkIris(lines.concat([JSON.stringify({ at: iso(500), event: "received", dir: "in", peer: "p", id: "k", text: "t" })])); const a = await T.readIris(d); assert.strictEqual(a.items.length, 1); rm(d);
});
t("exchange items keep light data: preview only, body not in the listing", async () => {
  const F = mkEx(); W(F.A, day(0) + "_to-X_big.md", "To: X. From: Y.\n\n" + "line of text\n".repeat(5000), 1000);
  const r = await L(F.root, { irisDir: path.join(F.root, "noiris") }); const it = r.items[0];
  assert.ok(it.lazy && it.text.length <= 140, "preview only"); assert.ok(JSON.stringify(r).length < 5000, "listing stays small"); rm(F.root);
});
t("missing everything: ok with found:false; missing IRIS dir does not break the mailbox; AGENT_DESKTOP_IRIS_DIR honoured", async () => {
  const r0 = await L(path.join(os.tmpdir(), "does-not-exist-fleettl"), { irisDir: path.join(os.tmpdir(), "no-iris-here") }); assert.ok(r0.ok && !r0.found && !r0.items.length);
  const F = mkEx(); W(F.A, day(1) + "_to-X_hello_world.md", "hi", DAY); const r1 = await L(F.root, { irisDir: undefined }); assert.ok(r1.found && r1.items.length === 1); rm(F.root);
  const o = process.env.AGENT_DESKTOP_IRIS_DIR; process.env.AGENT_DESKTOP_IRIS_DIR = "X:\\iris-fixture"; assert.strictEqual(T.irisDir("C:\\real"), "X:\\iris-fixture");
  if (o === undefined) delete process.env.AGENT_DESKTOP_IRIS_DIR; else process.env.AGENT_DESKTOP_IRIS_DIR = o; assert.strictEqual(T.irisDir("C:\\real"), o || "C:\\real");
});
const NOIRIS = (F) => ({ irisDir: path.join(F.root, "noiris") });
const qs = (r) => r.questions.map((q) => q.id).join("\n");
t("waiting box: a question counts as answered by a LATER owner note in the same thread, and leaves the unread count too", async () => {
  const F = mkEx();
  W(F.A, day(2) + "_Sam_calendar-sync-plan.md", "To: Alex. From: Sam.\n\nShould the calendar sync run nightly?\n", 2 * DAY);
  W(F.B, day(1) + "_Alex_calendar-sync-plan-reply.md", "To: Sam. From: Alex.\n\nYes, nightly.\n", 1 * DAY);
  W(F.A, day(1) + "_Sam_backup-schedule-check.md", "To: Alex. From: Sam.\n\nCan you confirm the backup schedule?\n", 3 * HOUR);
  const r = await L(F.root, Object.assign({ lastSeen: 0 }, NOIRIS(F)));
  assert.ok(!/calendar-sync/.test(qs(r)), "answered"); assert.ok(/backup-schedule/.test(qs(r)), "still open"); assert.strictEqual(r.unread, 1, "only the open one is unread"); rm(F.root);
});
t("waiting box: owner-side notes and notes addressed to the other side are never in the box", async () => {
  const F = mkEx();
  W(F.B, day(1) + "_Alex_to-Sam_pricing-question.md", "To: Sam. From: Alex.\n\nWhat is the price?\n", HOUR);
  W(F.A, day(1) + "_misfiled-copy-question.md", "To: Sam. From: Alex's COO.\n\nDid you get this?\n", HOUR); // an owner-side note sitting in the inbox folder
  W(F.A, day(1) + "_to-Sarah_other-party-question.md", "To: Sarah's COO. From: Sam.\n\nIs this for you?\n", HOUR); // addressed to the partner's own agents
  W(F.A, day(1) + "_Sam_real-open-question.md", "To: Alex. From: Sam.\n\nIs this for you?\n", HOUR);
  const r = await L(F.root, NOIRIS(F)); assert.strictEqual(qs(r).split("\n").filter(Boolean).length, 1, qs(r)); assert.ok(/real-open-question/.test(qs(r))); rm(F.root);
});
t("waiting box: a later note to a different person, an OLDER note, or an attachment does not answer", async () => {
  const F = mkEx();
  W(F.B, day(3) + "_Alex_to-Sam_invoice-review-earlier.md", "To: Sam. From: Alex.\n\nearlier\n", 3 * DAY); // older than the question
  W(F.A, day(2) + "_Sam_invoice-review-question.md", "To: Alex. From: Sam.\n\nCan you review the invoice?\n", 2 * DAY);
  W(F.B, day(1) + "_Alex_to-Kim_invoice-review-forward.md", "To: Kim. From: Alex.\n\nforwarding\n", 1 * DAY); // same thread, other person
  W(F.B, day(1) + "_Alex_invoice-review-scan.png", "x", HOUR); // attachment
  fs.mkdirSync(path.join(F.B, day(1) + "_invoice-review-folder")); // directory
  const r = await L(F.root, NOIRIS(F)); assert.ok(/invoice-review-question/.test(qs(r)), "still open: " + qs(r));
  W(F.B, day(0) + "_Alex_to-Sam_invoice-review-answer.md", "To: Sam. From: Alex.\n\nreviewed\n", 10 * 60000);
  const r2 = await L(F.root, NOIRIS(F)); assert.ok(!/invoice-review-question/.test(qs(r2)), "a later note to the same sender answers"); rm(F.root);
});
t("waiting box: without a thread key a later owner note to the same sender answers, to another person does not", () => {
  const q = { side: "partner", sender: "Sam", date: 1000, mtimeMs: 1000, hasNameDate: false };
  const o = (recipient, mtimeMs) => ({ side: "owner", recipient, date: mtimeMs, mtimeMs, hasNameDate: false });
  assert.ok(M.answersQuestion(o("Sam", 2000), q)); assert.ok(!M.answersQuestion(o("Kim", 2000), q), "different person"); assert.ok(!M.answersQuestion(o("Sam", 500), q), "older");
  assert.ok(!M.answersQuestion(o("unknown", 2000), q), "no thread key and no recipient: cannot tell");
  assert.ok(!M.answersQuestion(Object.assign(o("Sam", 2000), { isDir: true }), q) && !M.answersQuestion(Object.assign(o("Sam", 2000), { other: true }), q), "attachments ignored");
  assert.ok(!M.answersQuestion(Object.assign(o("Sam", 2000), { side: "partner" }), q), "partner-side note never answers");
});
t("waiting box: QUESTION_DAYS expiry still applies; an old unanswered question is not listed", async () => {
  const F = mkEx(); W(F.A, day(9) + "_Sam_stale-topic-question.md", "To: Alex. From: Sam.\n\nStill open?\n", 9 * DAY);
  const r = await L(F.root, NOIRIS(F)); assert.strictEqual(r.questions.length, 0); rm(F.root);
});
t("no network and no write: modules do not require net/http/https/child_process and never write", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "fleetTimeline.js"), "utf8");
  assert.ok(!/require\(["'](net|http|https|dgram|tls|child_process)["']\)/.test(src)); assert.ok(!/writeFile|appendFile|unlink|rename|mkdir/.test(src));
});
t("renderer: Hebrew dir=auto on message text, no innerHTML, filters, status wording, open flag, width bounds, IPC wired", () => {
  const dir = path.join(__dirname, "..", "src"), s = fs.readFileSync(path.join(dir, "renderer", "fleet-pane.js"), "utf8");
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(s)); assert.ok(/setAttribute\("dir", "auto"\)/.test(s) && /auto\(el\("div", "fp-btext/.test(s) && /auto\(el\("div", "fp-bsubj"/.test(s) && /auto\(el\("span", "fp-bname"/.test(s));
  assert.ok(/Waiting for a reply/.test(s) && /"From " \+ theirSide\(\)/.test(s) && /no reply yet \(/.test(s) && /answered /.test(s) && /best guess/.test(s));
  assert.ok(/fleetPaneOpen/.test(s) && /fleetPaneWidth/.test(s) && /W_MIN = 340, W_MAX = 520, W_DEF = 420/.test(s) && /api\.timeline\(/.test(s) && /POLL_OPEN = 60000/.test(s) && /POLL_CLOSED = 300000/.test(s));
  assert.ok(/fleet-timeline/.test(fs.readFileSync(path.join(dir, "preload.js"), "utf8")) && /"fleet-timeline"/.test(fs.readFileSync(path.join(dir, "fleetMain.js"), "utf8")));
  assert.ok(/unicode-bidi: plaintext/.test(fs.readFileSync(path.join(dir, "renderer", "styles-fleet-pane.css"), "utf8")));
});

(async () => {
  for (const [name, fn] of tests) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + (e && e.stack)); } }
  console.log(n - fails + "/" + n + " passed"); process.exit(fails ? 1 : 0);
})();
