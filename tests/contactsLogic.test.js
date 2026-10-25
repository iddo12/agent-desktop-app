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
for (const bad of ["constructor", "__proto__", "toString", "__none"]) assert.strictEqual(L.validCategories([bad]), null, "reserved category name " + bad);
assert.strictEqual(L.validCategories("Audio"), null); assert.strictEqual(L.validCategories(Array(9).fill("x").map((x, i) => x + i)), null);
assert.strictEqual(L.validDate("2026-10-30"), true); assert.strictEqual(L.validDate("2026-13-40"), false); assert.strictEqual(L.validDate("tomorrow"), false);
assert.strictEqual(L.validLink("web", "https://a.example/x"), "https://a.example/x"); assert.strictEqual(L.validLink("web", "javascript:alert(1)"), null);
assert.strictEqual(L.validLink("web", "http://a.example"), null); assert.strictEqual(L.validLink("phone", "+972 50-123 4567"), "+972 50-123 4567"); assert.strictEqual(L.validLink("phone", "x;rm"), null);
assert.strictEqual(L.validLink("web", ""), "");

// agent export carries no mail subjects
const rec = L.lookupRecord(idx, {}, {}, dir.companies[0], NOW);
assert.strictEqual(rec.current_contacts.length, 3); assert.strictEqual(rec.current_contacts[0].who_wrote_last, "them");
assert.ok(!JSON.stringify(rec).includes("there"), "no subjects in the agent export");
// ---- merges + duplicate suggestions
{
  const mk = (id, name, domain, people, last) => ({ id, name, domain, aliases: [], last, dir: "in", people: people.map((i) => ({ id: i, name: "P" + i, emails: [], mails: [] })) });
  const d0 = { generatedAt: null, windowDays: 1460, unknownPeople: 0, companies: [mk(1, "SmallRig", "smallrig.com", [1, 2, 3], "2026-10-01"), mk(2, "Smallrig Ltd", "smallrig.cn", [4], "2026-10-20"), mk(3, "Other Co", "other.example", [5], "2026-01-01"), mk(4, "Gmail Bob", "gmail.com", [6], null), mk(5, "Gmail Ann", "gmail.com", [7], null)] };
  const sg = L.mergeSuggestions(d0, {});
  assert.strictEqual(sg.length, 1, "smallrig pair only (gmail and short names are not a duplicate signal)"); assert.strictEqual(sg[0].into.id, 1, "the company with more people stays"); assert.strictEqual(sg[0].from.id, 2);
  assert.strictEqual(L.mergeSuggestions(d0, { "1-2": 1 }).length, 0, "Not the same is remembered");
  const m = L.applyMerges(d0, { 2: 1 });
  assert.strictEqual(m.companies.length, 4); const c1 = m.companies.find((c) => c.id === 1);
  assert.deepStrictEqual(c1.people.map((p) => p.id), [1, 2, 3, 4]); assert.strictEqual(c1.last, "2026-10-20", "newest contact wins");
  assert.ok(c1.aliases.includes("Smallrig Ltd") && c1.aliases.includes("smallrig.cn")); assert.strictEqual(c1.mergedFrom[0].id, 2); assert.strictEqual(m.merges[0].into.name, "SmallRig");
  assert.strictEqual(d0.companies.length, 5, "input untouched"); assert.strictEqual(d0.companies[0].people.length, 3);
  const ch = L.applyMerges(d0, { 3: 2, 2: 1 }); assert.strictEqual(ch.companies.find((c) => c.id === 1).people.length, 5, "chains resolve to the end");
  const cy = L.applyMerges(d0, { 1: 2, 2: 1 }); assert.strictEqual(cy.companies.length, 5, "a cycle merges nothing");
  assert.strictEqual(L.applyMerges(d0, { 9: 1, 1: 99, 2: "x" }).companies.length, 5, "unknown ids ignored");
  assert.strictEqual(L.applyMerges(d0, null).companies.length, 5);
  const ix = L.buildIndex(m, {}, {}, NOW); assert.ok(L.listPage(ix, { q: "smallrig.cn", sort: "az" }).rows.some((r) => r.id === 1), "search finds the merged-in domain");
  assert.strictEqual(L.nameKey("The SmallRig, Inc."), "smallrig");
  const d1 = JSON.parse(JSON.stringify(d0)); d1.companies[0].aliases = ["smallrig.cn"]; assert.strictEqual(L.mergeSuggestions(d1, {}).length, 0, "a domain already listed as an alias is not suggested again")
}
console.log("contactsLogic tests passed");
