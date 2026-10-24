"use strict";
// Contacts rules: normalise, current contacts (all recently active people), reply states, search folding, paging, validation, agent export.
const assert = require("assert");
const L = require("../src/contacts/contactsLogic");
const NOW = Date.parse("2026-10-25T12:00:00Z");
const iso = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
const P = (id, name, last, dir, extra) => Object.assign({ id, name, role: null, emails: [{ address: name.toLowerCase().replace(/\W/g, "") + "@x.example" }], last_contact: last, last_direction: dir, status: "replied", extra: { automated: false }, mails: [{ date: last, subject: "Hi <b>there</b>", direction: dir }] }, extra || {});
const raw = { generated_at: "2026-10-25T01:00:00", window_days: 1460, unknown_company_people: 79, companies: [
  { id: 1, name: "SmallRig", domain: "smallrig.com", aliases: [], last_contact: iso(3), last_direction: "in", people: [P(10, "Ana Lee", iso(3), "in"), P(11, "Bo Chen", iso(20), "out"), P(12, "Old Timer", iso(200), "out"), P(13, "Gone", iso(700), "out", { status: "dormant" })] },
  { id: 2, name: "Café Ünïcode", domain: "cafe.example", aliases: ["Kafe"], last_contact: iso(100), last_direction: "out", people: [P(20, "José Núñez", iso(100), "out")] },
  { id: 3, name: "Robot Inc", domain: "robot.example", aliases: [], last_contact: iso(2), last_direction: "in", people: [P(30, "Noreply", iso(2), "in", { extra: { automated: true } })] },
  { id: "bad" }, null,
] };
const dir = L.normalise(raw);
assert.strictEqual(dir.companies.length, 3, "malformed companies dropped");
assert.strictEqual(dir.unknownPeople, 79);
assert.deepStrictEqual(L.normalise(null).companies, []);
assert.deepStrictEqual(L.normalise({ companies: "x" }).companies, []);

// current contacts: ALL recently active people, newest first, silent flag, automated and >12 months excluded
const cur = L.currentContacts(dir.companies[0], NOW);
assert.deepStrictEqual(cur.map((p) => p.name), ["Ana Lee", "Bo Chen", "Old Timer"]);
assert.strictEqual(cur[2].silent, true, "200 d quiet while colleagues are active");
assert.strictEqual(cur[1].silent, false);
assert.strictEqual(L.currentContacts(dir.companies[2], NOW).length, 0, "automated senders are never current contacts");

// reply states, snooze and no-reply-needed
const ana = dir.companies[0].people[0], bo = dir.companies[0].people[1];
assert.strictEqual(L.replyState(ana, {}, NOW), "needs");
assert.strictEqual(L.replyState(bo, {}, NOW), "waiting");
assert.strictEqual(L.replyState(ana, { 10: { until: iso(-5) } }, NOW), "", "snoozed until a future day");
assert.strictEqual(L.replyState(ana, { 10: { until: iso(5) } }, NOW), "needs", "snooze over");
assert.strictEqual(L.replyState(ana, { 10: { noReply: true } }, NOW), "");
assert.strictEqual(L.replyState(dir.companies[2].people[0], {}, NOW), "", "automated");
assert.strictEqual(L.replyState(dir.companies[0].people[3], {}, NOW), "", "dormant");

const idx = L.buildIndex(dir, { companies: { 2: { categories: ["Audio", "Services"] } } }, {}, NOW);
assert.strictEqual(idx.total, 3); assert.strictEqual(idx.uncategorised, 2); assert.strictEqual(idx.counts.Audio, 1);
assert.strictEqual(idx.needs, 1, "only SmallRig: the robot is automated");
const rowTag = (id) => idx.rows.find((r) => r.id === id).tag;
assert.strictEqual(rowTag(1), "they wrote"); assert.strictEqual(rowTag(2), "waiting on them");

// search folds accents/case, matches company, alias, person, email, category
const find = (q, o) => L.listPage(idx, Object.assign({ q, offset: 0 }, o || {})).rows.map((r) => r.id);
assert.deepStrictEqual(find("cafe"), [2]); assert.deepStrictEqual(find("ÜNÏCODE"), [2]); assert.deepStrictEqual(find("kafe"), [2]);
assert.deepStrictEqual(find("jose nunez"), [2]); assert.deepStrictEqual(find("analee@x"), [1]); assert.deepStrictEqual(find("services"), [2]);
assert.deepStrictEqual(find("zzz"), []);
assert.deepStrictEqual(find("", { filter: "needs" }), [1]); assert.deepStrictEqual(find("", { filter: "waiting" }).sort(), [1, 2]);
assert.deepStrictEqual(find("", { category: "__none" }).sort(), [1, 3]); assert.deepStrictEqual(find("", { category: "Audio" }), [2]);
assert.deepStrictEqual(find("", { sort: "az" }), [2, 3, 1]);
assert.strictEqual(L.searchPeople(idx, "nunez")[0].companyId, 2); assert.deepStrictEqual(L.searchPeople(idx, "n"), [], "one letter does not search people");

// paging by 50
const big = { companies: Array.from({ length: 120 }, (_, i) => ({ id: i + 1, name: "Co " + i, people: [], last_contact: iso(i), last_direction: "in" })) };
const bigIdx = L.buildIndex(L.normalise(big), {}, {}, NOW);
const p1 = L.listPage(bigIdx, { offset: 0 }), p3 = L.listPage(bigIdx, { offset: 100 }), pe = L.listPage(bigIdx, { offset: 9999 });
assert.strictEqual(p1.rows.length, 50); assert.strictEqual(p1.total, 120); assert.strictEqual(p3.rows.length, 20); assert.strictEqual(pe.rows.length, 0);
assert.ok(p1.rows[0].daysAgo <= p1.rows[1].daysAgo, "latest contact first");

// views are plain data; hostile text stays text
const cv = L.companyView(idx, { companies: { 1: { note: "n".repeat(9000), links: { web: "https://smallrig.com" } } } }, {}, 1, NOW);
assert.strictEqual(cv.note.length, 4000); assert.strictEqual(cv.people.length, 4); assert.strictEqual(L.companyView(idx, {}, {}, 99, NOW), null);
const pv = L.personView(idx, { person: { 10: "likes short mails" } }, {}, 10, NOW);
assert.strictEqual(pv.note, "likes short mails"); assert.strictEqual(pv.mails[0].subject, "Hi <b>there</b>"); assert.strictEqual(L.personView(idx, {}, {}, 999, NOW), null);

// validation of what the view may write
assert.deepStrictEqual(L.validCategories(["Audio", " Lighting "]), ["Audio", "Lighting"]);
assert.strictEqual(L.validCategories(["Audio", "audio"]), null, "duplicate (folded)"); assert.strictEqual(L.validCategories(["<script>"]), null);
assert.strictEqual(L.validCategories("Audio"), null); assert.strictEqual(L.validCategories(Array(9).fill("x").map((x, i) => x + i)), null);
assert.strictEqual(L.validDate("2026-10-30"), true); assert.strictEqual(L.validDate("2026-13-40"), false); assert.strictEqual(L.validDate("tomorrow"), false);
assert.strictEqual(L.validLink("web", "https://a.example/x"), "https://a.example/x"); assert.strictEqual(L.validLink("web", "javascript:alert(1)"), null);
assert.strictEqual(L.validLink("web", "http://a.example"), null); assert.strictEqual(L.validLink("phone", "+972 50-123 4567"), "+972 50-123 4567"); assert.strictEqual(L.validLink("phone", "x;rm"), null);
assert.strictEqual(L.validLink("web", ""), "");

// agent export carries no mail subjects
const rec = L.lookupRecord(idx, {}, {}, dir.companies[0], NOW);
assert.strictEqual(rec.current_contacts.length, 3); assert.strictEqual(rec.current_contacts[0].who_wrote_last, "them");
assert.ok(!JSON.stringify(rec).includes("there"), "no subjects in the agent export");
console.log("contactsLogic tests passed");
