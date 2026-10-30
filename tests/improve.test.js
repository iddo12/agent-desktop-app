// node tests/improve.test.js - How to improve service: load (good / malformed / oversize / missing), decisions writer, lifecycle, findRef. Temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { createService, isoWeek } = require("../src/improve/service");
let n = 0, fails = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adimp-"));
const mk = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
const card = (id, o) => Object.assign({ id, agent: "Security", signal: "keep_going", kind: "rule", finding: "Finding " + id + ". More words.", proposedFix: "Fix", owner: "Security", evidence: ["q1", "q2"], command: "", mechanism: "m", contextSaving: "c", undo: "u", score: 10, status: "new", answer: "", answeredAt: "", stage: 0 }, o || {});
const cards = (d, list, extra) => fs.writeFileSync(path.join(d, "cards.json"), "﻿" + JSON.stringify(Object.assign({ generated: "2026-10-30T02:50:23", window_days: 14, humanMessages: 99, cards: list }, extra || {})));
const NOW = Date.parse("2026-10-30T10:00:00Z");
const svc = (d) => createService({ dir: d, now: () => NOW });
const readDec = (d) => JSON.parse(fs.readFileSync(path.join(d, "decisions.json"), "utf8"));

t("good file: header, sort new first by score, bad cards dropped, strings clipped", async () => {
  const d = mk("good");
  cards(d, [card("a", { score: 5 }), card("b", { score: 50 }), card("c", { status: "approved", score: 999 }), { id: "", finding: "x" }, null, card("long", { finding: "x".repeat(5000), evidence: Array(20).fill("e".repeat(900)) })]);
  const r = await svc(d).load();
  assert.strictEqual(r.state, "ok"); assert.strictEqual(r.windowDays, 14); assert.strictEqual(r.humanMessages, 99); assert.strictEqual(r.generated, "2026-10-30T02:50:23");
  assert.deepStrictEqual(r.cards.map((c) => c.id), ["b", "long", "a", "c"]);   // new first (by score), then the others
  const l = r.cards.find((c) => c.id === "long"); assert.strictEqual(l.finding.length, 1200); assert.strictEqual(l.evidence.length, 8); assert.strictEqual(l.evidence[0].length, 300);
  assert.strictEqual(r.counts.new, 3); assert.strictEqual(r.counts.approved, 1);
});
t("malformed file: plain state, no throw", async () => {
  const d = mk("bad"); fs.writeFileSync(path.join(d, "cards.json"), "{nope");
  assert.strictEqual((await svc(d).load()).state, "unreadable");
  fs.writeFileSync(path.join(d, "cards.json"), JSON.stringify({ cards: "x" })); assert.strictEqual((await svc(d).load()).state, "unreadable");
  fs.writeFileSync(path.join(d, "cards.json"), "[]"); assert.strictEqual((await svc(d).load()).state, "unreadable");
});
t("oversize file refused", async () => { const d = mk("big"); fs.writeFileSync(path.join(d, "cards.json"), JSON.stringify({ cards: [], pad: "x".repeat(1100 * 1024) })); assert.strictEqual((await svc(d).load()).state, "too-big"); });
t("missing file and missing folder", async () => { const r = await svc(mk("empty")).load(); assert.strictEqual(r.state, "missing"); assert.deepStrictEqual(r.cards, []); assert.strictEqual((await svc(path.join(tmp, "nope")).load()).state, "missing"); });
t("decide approved writes only decisions.json; cards.json untouched; load merges it", async () => {
  const d = mk("dec"); cards(d, [card("a"), card("b")]);
  const before = fs.readFileSync(path.join(d, "cards.json"), "utf8");
  const r = await svc(d).decide("a", "approved", "ok go");
  assert.ok(r.ok); assert.strictEqual(r.answeredAt, "2026-10-30T10:00:00.000Z");
  assert.strictEqual(fs.readFileSync(path.join(d, "cards.json"), "utf8"), before);
  assert.deepStrictEqual(fs.readdirSync(d).sort(), ["cards.json", "decisions.json"]);   // no temp file left behind
  const e = readDec(d).decisions.a; assert.strictEqual(e.status, "approved"); assert.strictEqual(e.answer, "ok go"); assert.strictEqual(e.times.approved, r.answeredAt);
  const l = await svc(d).load(); assert.strictEqual(l.cards.find((c) => c.id === "a").status, "approved"); assert.strictEqual(l.counts.new, 1);
});
t("decide refuses unknown card, bad status, bad id; keeps other decisions", async () => {
  const d = mk("dec2"); cards(d, [card("a"), card("b")]); const s = svc(d);
  assert.strictEqual((await s.decide("zzz", "approved")).ok, false); assert.strictEqual((await s.decide("a", "deleted")).ok, false); assert.strictEqual((await s.decide({}, "approved")).ok, false); assert.strictEqual((await s.decide("../a", "approved")).ok, false);
  assert.ok(!fs.existsSync(path.join(d, "decisions.json")));
  await s.decide("a", "approved"); await s.decide("b", "rejected", "x".repeat(5000));
  const dec = readDec(d).decisions; assert.strictEqual(dec.a.status, "approved"); assert.strictEqual(dec.b.status, "rejected"); assert.strictEqual(dec.b.answer.length, 2000);
});
t("concurrent decisions are serialised, none lost", async () => {
  const d = mk("conc"); const list = Array.from({ length: 12 }, (_, i) => card("c" + i)); cards(d, list); const s = svc(d);
  await Promise.all(list.map((c) => s.decide(c.id, "approved")));
  assert.strictEqual(Object.keys(readDec(d).decisions).length, 12);
});
t("lifecycle: applied only after approved; worked / didnt_work only after applied; history kept", async () => {
  const d = mk("life"); cards(d, [card("a")]); const s = svc(d);
  assert.strictEqual((await s.decide("a", "applied")).ok, false); assert.strictEqual((await s.decide("a", "worked")).ok, false);
  assert.ok((await s.decide("a", "approved")).ok); assert.strictEqual((await s.decide("a", "worked")).ok, false);
  assert.ok((await s.decide("a", "applied")).ok); assert.ok((await s.decide("a", "didnt_work")).ok);
  const e = readDec(d).decisions.a; assert.strictEqual(e.status, "didnt_work"); assert.deepStrictEqual(Object.keys(e.times).sort(), ["applied", "approved", "didnt_work"]);
  assert.strictEqual((await s.load()).cards[0].status, "didnt_work"); assert.strictEqual((await s.load()).counts.didnt_work, 1);
  assert.strictEqual((await s.decide("a", "rejected")).ok, false);
});
t("a later cards.json state is not downgraded by an older decision", async () => {
  const d = mk("rank"); cards(d, [card("a", { status: "applied" })]); fs.writeFileSync(path.join(d, "decisions.json"), JSON.stringify({ decisions: { a: { status: "approved", answeredAt: "x" } } }));
  assert.strictEqual((await svc(d).load()).cards[0].status, "applied");
});
t("damaged decisions.json: load still works and flags it; writer refuses and leaves it alone", async () => {
  const d = mk("baddec"); cards(d, [card("a")]); fs.writeFileSync(path.join(d, "decisions.json"), "{broken");
  const l = await svc(d).load(); assert.strictEqual(l.state, "ok"); assert.strictEqual(l.decisionsBad, true);
  assert.strictEqual((await svc(d).decide("a", "approved")).ok, false); assert.strictEqual(fs.readFileSync(path.join(d, "decisions.json"), "utf8"), "{broken");
});
t("findRef: only a real card addressed to its own owner", async () => {
  const d = mk("ref"); cards(d, [card("a", { owner: "Software Engineering" })]); const s = svc(d);
  assert.ok(await s.findRef("software engineering", "imp:a")); assert.strictEqual(await s.findRef("Security", "imp:a"), null); assert.strictEqual(await s.findRef("Software Engineering", "imp:zz"), null); assert.strictEqual(await s.findRef("Software Engineering", "a"), null);
});
t("isoWeek", () => { assert.strictEqual(isoWeek(Date.parse("2026-10-30T10:00:00Z")), "2026-W44"); assert.strictEqual(isoWeek(Date.parse("2027-01-01T10:00:00Z")), "2026-W53"); });
t("no sync fs calls in the service or tab", () => {
  for (const f of ["src/improve/service.js", "src/renderer/improve.js"]) { const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8"); assert.ok(!/(?:lstat|readdir|readFile|writeFile|open|read)Sync/.test(src), f); }
});
t("wiring: IPC handlers, preload, tab registered, writer knows imp: ids, applied refused from the tab", () => {
  const r = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const m = r("src/research/main-research.js");
  for (const k of ["improve-load", "improve-decide", "improve-write"]) { assert.ok(m.includes('handle("' + k + '"'), k); assert.ok(r("src/preload.js").includes('"' + k + '"'), k); }
  assert.ok(m.includes('startsWith("imp:")')); assert.ok(/status === "applied"/.test(m));
  assert.ok(r("src/renderer/research.js").includes('improve: { script: "improve.js"')); assert.ok(r("src/renderer/research.js").includes('["improve", "How to improve"]'));
});
(async () => {
  for (const [name, fn] of queue) { n++; try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + ": " + e.message); } }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(n - fails + "/" + n + " passed"); process.exit(fails ? 1 : 0);
})();
