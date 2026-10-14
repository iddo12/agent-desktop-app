// node tests/emailDismiss.test.js - My Daily email Dismiss (v1.113.1): pure key building, filtering, bulk-by-age, store round trip,
// and a guard that the dismiss code never touches mail (no imap/gmail calls) and is wired in main/preload/renderer.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const D = require("../src/daily/emaildismiss");
const NOW = Date.parse("2026-10-11T10:00:00Z");
const DAY = 86400000;

const em = {
  top: [{ id: "n1", account: "A", from: "x", subject: "S1", importance: 2 }],
  needAnswer: [{ id: "n1", account: "A", from: "x", subject: "S1", ageDays: 2 }, { id: "n2", account: "B", from: "y", subject: "S2", ageDays: 40 }],
  sentNoReply: [{ id: "s1", account: "A", to: "p", subject: "T1", ageDays: 38 }, { id: "s2", account: "A", to: "q", subject: "T2", ageDays: 70 }, { id: "s3", account: "B", to: "r", subject: "T3", ageDays: 15 }],
  hidden: 3,
};

// key building
assert.strictEqual(D.keyOf("sentNoReply", em.sentNoReply[0]), "sentNoReply|A|s1");
assert.strictEqual(D.keyOf("needAnswer", { id: "s1", account: "A" }), "needAnswer|A|s1", "list is part of the key");
assert.strictEqual(D.keyOf("bogus", { id: "1", account: "A" }), null);
assert.strictEqual(D.keyOf("needAnswer", { account: "A" }), null);
assert.strictEqual(D.keyOf("needAnswer", { id: "1" }), null);
assert.strictEqual(D.keyOf("needAnswer", null), null);

// add + apply
let st = D.add(D.emptyStore(), [D.entryOf("sentNoReply", em.sentNoReply[0])], NOW);
let r = D.apply(em, st);
assert.deepStrictEqual(r.emails.sentNoReply.map((x) => x.id), ["s2", "s3"]);
assert.strictEqual(r.emails.needAnswer.length, 2);
assert.strictEqual(r.dismissed.length, 1);
assert.strictEqual(r.dismissed[0].key, "sentNoReply|A|s1");
assert.strictEqual(r.dismissed[0].who, "p");
assert.strictEqual(r.emails.hidden, 3, "other fields kept");
assert.strictEqual(em.sentNoReply.length, 3, "input not mutated");

// dismissing a needAnswer item also removes it from top
st = D.add(st, [D.entryOf("needAnswer", em.needAnswer[0])], NOW);
r = D.apply(em, st);
assert.strictEqual(r.emails.top.length, 0);
assert.deepStrictEqual(r.emails.needAnswer.map((x) => x.id), ["n2"]);

// a new last message = a new id = the thread is treated normally again
const em2 = { needAnswer: [], top: [], sentNoReply: [{ id: "s1-newer", account: "A", to: "p", subject: "T1", ageDays: 1 }] };
assert.strictEqual(D.apply(em2, st).emails.sentNoReply.length, 1);
assert.strictEqual(D.apply(em2, st).dismissed.length, 0);

// same id in another account is not dismissed
assert.strictEqual(D.apply({ sentNoReply: [{ id: "s1", account: "B", subject: "x", ageDays: 5 }] }, st).emails.sentNoReply.length, 1);

// restore one / all
const k = "sentNoReply|A|s1";
assert.strictEqual(D.apply(em, D.restore(st, [k])).emails.sentNoReply.length, 3);
assert.strictEqual(Object.keys(D.restore(st, null).items).length, 0);
assert.strictEqual(Object.keys(D.restore(st, ["nope"]).items).length, 2);

// bulk by age: strictly older than N days, per list, optional account
const ids = (a) => a.map((x) => x.id);
assert.deepStrictEqual(ids(D.olderThan("sentNoReply", em.sentNoReply, 30, "all")), ["s1", "s2"]);
assert.deepStrictEqual(ids(D.olderThan("sentNoReply", em.sentNoReply, 60)), ["s2"]);
assert.deepStrictEqual(ids(D.olderThan("sentNoReply", em.sentNoReply, 14, "B")), ["s3"]);
assert.deepStrictEqual(ids(D.olderThan("sentNoReply", em.sentNoReply, 70)), [], "exactly N days is not older");
assert.deepStrictEqual(ids(D.olderThan("needAnswer", em.needAnswer, 30)), ["n2"]);
assert.deepStrictEqual(D.olderThan("nope", em.needAnswer, 30), []);
assert.deepStrictEqual(D.olderThan("needAnswer", em.needAnswer, 0), []);
assert.strictEqual(D.olderThan("sentNoReply", em.sentNoReply, 30)[0].list, "sentNoReply");

// serialize round trip, BOM, damaged input
const back = D.parse(D.serialize(st));
assert.deepStrictEqual(back, D.cleanStore(st));
assert.deepStrictEqual(D.apply(em, back).dismissed.map((x) => x.key).sort(), D.apply(em, st).dismissed.map((x) => x.key).sort());
assert.strictEqual(Object.keys(D.parse("\uFEFF" + D.serialize(st)).items).length, 2);
for (const bad of ["", "not json", "[]", "null", '{"items":[]}', '{"items":{"x":1}}', '{"items":{"needAnswer|A|1":{"at":"zz"}}}']) assert.deepStrictEqual(D.parse(bad), D.emptyStore(), "bad: " + bad);
assert.deepStrictEqual(D.cleanStore(undefined), D.emptyStore());

// old entries are forgotten on add; cap holds
const old = { v: 1, items: { "needAnswer|A|old": { at: NOW - 500 * DAY, subject: "o", who: "" } } };
assert.strictEqual(Object.keys(D.add(old, [], NOW).items).length, 0);
const many = D.add(D.emptyStore(), Array.from({ length: D.MAX_ENTRIES + 50 }, (_, i) => ({ list: "needAnswer", account: "A", id: "m" + i, subject: "s" })), NOW);
assert.strictEqual(Object.keys(many.items).length, D.MAX_ENTRIES);
assert.deepStrictEqual(D.apply(null, st).emails.needAnswer, []);

// wiring guards: never touches mail, hooked into main, preload, renderer, html
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
assert.ok(!/imap|gmail|require\(|fs\./i.test(read("src/daily/emaildismiss.js").replace(/\/\/.*$/gm, "")), "pure module touches nothing");
const main = read("src/daily/main-daily.js");
assert.ok(/daily-email-dismiss/.test(main) && /daily-email-restore/.test(main) && /emailDismiss\.apply\(/.test(main));
assert.ok(/emailDismiss:/.test(read("src/preload.js")) && /emailRestore:/.test(read("src/preload.js")));
assert.ok(/emaildismiss\.js/.test(read("src/renderer/index.html")));
assert.ok(/Dismiss older than/.test(read("src/renderer/daily.js")) && /Dismissed \(/.test(read("src/renderer/daily.js")));
console.log("emailDismiss: all checks passed");
