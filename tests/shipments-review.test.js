// node tests/shipments-review.test.js - fixes after the second review (SE, 2026-10-27): A serialised store access, B safe migration,
// C order-number warning with "use it anyway", D changecarrier/deletetrack handling, E rate-limit wording. Temp folders and a dummy key only.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const M = require("../src/daily/shipments-model");
const E = require("../src/daily/shipments-email");
const T = require("../src/daily/shipments-track");
const S = require("../src/daily/shipments-main");

const NOW = Date.parse("2026-10-27T10:00:00Z");
const DAY = 86400000;
const SECRET = "TESTKEY-0123456789-ABCDEF";
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)), decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString("utf8") };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ship-review-"));
const noSleep = () => Promise.resolve();
const queue = [];
const t = (name, fn) => queue.push({ name, fn });
const readStore = (file, def) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return def; } };
const writeJsonAtomic = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + ".tmp", JSON.stringify(obj)); fs.renameSync(file + ".tmp", file); };
const raw = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const ok = (data) => ({ status: 200, json: { code: 0, data } });
const notFoundAll = (ep, body) => ok(ep === "gettrackinfo"
  ? { accepted: body.map((b) => ({ number: b.number, track_info: { latest_status: { status: "NotFound", sub_status: "NotFound_Other" }, tracking: { providers: [] } } })), rejected: [] }
  : { accepted: body.map((b) => ({ number: b.number })), rejected: [] });

function service(handler, opts) {
  const dir = tmp();
  const file = path.join(dir, "shipments.json");
  if (opts && opts.seed) fs.writeFileSync(file, JSON.stringify(opts.seed));
  const calls = [];
  const request = async (method, url, o) => { const body = JSON.parse(o.body); const ep = url.split("/").pop(); calls.push({ ep, body }); return (handler || notFoundAll)(ep, body); };
  const tr = T.createTracker({ dataDir: tmp(), safeStorage: fakeSafe, request, sleep: noSleep });
  if (!opts || opts.key !== false) tr.keys.set("17track", SECRET);
  const svc = S.createService({ file, readStore, writeJsonAtomic, tracker: tr, getMails: async () => (opts && opts.mails) || [], now: () => NOW, notices: [], say: () => {} });
  return { svc, file, calls };
}
const fedexMail = { from: "FedEx <TrackingUpdates@fedex.com>", subject: "You're getting a shipment 870000000004", date: "2026-10-05T07:12:00Z", messageId: "<x1>", body: "From: Acme SPA, Rome, IT" };

t("A: an op waiting on a slow provider does not lose what a concurrent mail scan or a second op saved", async () => {
  const slow = (ep, body) => new Promise((res) => setTimeout(() => res(notFoundAll(ep, body)), ep === "gettrackinfo" ? 60 : 0));
  const s = service(slow, { mails: [fedexMail] });
  const p1 = s.svc.op({ op: "add", text: "ABC98765432", label: "slow one" });
  const p2 = s.svc.load({ force: true });
  const p3 = s.svc.op({ op: "add", text: "RR123456789IL" });
  const [r1, , r3] = await Promise.all([p1, p2, p3]);
  assert.strictEqual(r1.ok, true); assert.strictEqual(r3.ok, true);
  const saved = raw(s.file).items.map((x) => x.numbers.map((n) => n.no).join(","));
  assert.strictEqual(saved.length, 3, saved.join(" | "));
  for (const n of ["ABC98765432", "870000000004", "RR123456789IL"]) assert.ok(saved.includes(n), n + " lost: " + saved.join(" | "));
});

t("B: migration leaves parcels that have events alone, never wipes events, never overwrites another orderId", () => {
  const ev = [{ at: NOW - DAY, text: "Departed", place: "HK" }];
  const list = [
    M.makeShipment({ id: "e1", merchant: "AliExpress", carrier: "cainiao", numbers: [{ no: "12345678901234", carrier: "cainiao" }], events: ev, lastEvent: ev[0], polledOk: true, state: "in_transit" }, NOW),
    M.makeShipment({ id: "e2", merchant: "AliExpress", carrier: "cainiao", numbers: [{ no: "1234567890123456", carrier: "cainiao" }], events: ev, state: "in_transit" }, NOW),
    M.makeShipment({ id: "e3", merchant: "AliExpress", carrier: "cainiao", orderId: "9999888877776666", numbers: [{ no: "00100000000111", carrier: "cainiao" }], state: "shipped" }, NOW),
    M.makeShipment({ id: "e4", merchant: "DHL", carrier: "dhl", events: ev, numbers: [{ no: "8000000003", carrier: "dhl" }], state: "in_transit" }, NOW),
  ];
  const r = M.migrateWrongNumbers(list, NOW);
  assert.deepStrictEqual(list[0].numbers.map((n) => n.no), ["12345678901234"]);
  assert.deepStrictEqual(list[1].numbers.map((n) => n.no), ["1234567890123456"]);
  assert.strictEqual(list[0].events.length, 1); assert.ok(list[0].lastEvent);
  assert.deepStrictEqual(list[2].numbers.map((n) => n.no), ["00100000000111"]);
  assert.strictEqual(list[2].orderId, "9999888877776666");
  assert.deepStrictEqual(list[3].numbers.map((n) => n.no), ["8000000003"]);
  assert.strictEqual(r.changed, false);
});

t("C: 16/17 digits give a warning with use-it-anyway; hard refusal only for known order ids, Amazon dashes, AliExpress/Amazon parcels", async () => {
  const { svc } = service(null, { key: false, seed: { version: 1, migrated: 2, items: [
    { id: "ali", merchant: "AliExpress", orderId: "1100000000000005", numbers: [], state: "ordered", source: "email" },
    { id: "gen", merchant: "Shop", numbers: [], state: "ordered", source: "email" },
  ] } });
  const w = await svc.op({ op: "add", text: "2234567890123456" });
  assert.strictEqual(w.ok, false); assert.strictEqual(w.needsConfirm, true);
  assert.strictEqual((await svc.op({ op: "add", text: "2234567890123456", force: true })).ok, true);
  const known = await svc.op({ op: "add", text: "1100000000000005", force: true });
  assert.ok(!known.ok && !known.needsConfirm, "known order id refused even with force");
  assert.ok(!(await svc.op({ op: "add", text: "114-1234567-1234567", force: true })).ok);
  const onAli = await svc.op({ op: "add-number", id: "ali", text: "3234567890123456", force: true });
  assert.ok(!onAli.ok && !onAli.needsConfirm, "AliExpress parcel: hard refusal");
  assert.strictEqual((await svc.op({ op: "add-number", id: "gen", text: "4234567890123456" })).needsConfirm, true);
  assert.strictEqual((await svc.op({ op: "add-number", id: "gen", text: "4234567890123456", force: true })).ok, true);
});

t("C: parser keeps a labelled tracking number in a carrier mail; an unlabelled 16-digit subject number from a shop is dropped", () => {
  const c = E.extractShipments({ from: "Evri <noreply@dhl.com>", subject: "Your parcel is on its way", date: "2026-10-20T08:00:00Z", messageId: "<e1>", body: "Tracking number: 2234567890123456\nThanks" }, NOW);
  assert.ok(c[0].numbers.some((n) => n.no === "2234567890123456"));
  const c2 = E.extractShipments({ from: "Shop <orders@aliexpress.com>", subject: "Your parcel 1100000000000005 shipped", date: "2026-10-20T08:00:00Z", messageId: "<e2>", body: "Thanks" }, NOW);
  assert.ok(!c2.length || c2[0].numbers.length === 0);
});

t("D: changecarrier answering 200 without 'accepted' falls back to delete + register; a failed delete keeps the choice and skips register", async () => {
  let delOk = true;
  const handler = (ep, body) => (ep === "changecarrier" ? ok({})
    : ep === "deletetrack" ? (delOk ? ok({ accepted: body.map((b) => ({ number: b.number })), rejected: [] }) : ok({ accepted: [], rejected: body.map((b) => ({ number: b.number, error: { code: -5, message: "busy" } })) }))
    : notFoundAll(ep, body));
  const s = service(handler);
  const r = await s.svc.op({ op: "add", text: "ABC98765432" });
  s.calls.length = 0;
  await s.svc.op({ op: "set-carrier", id: r.id, carrier: "aramex" });
  assert.deepStrictEqual(s.calls.map((c) => c.ep).slice(0, 4), ["changecarrier", "deletetrack", "register", "gettrackinfo"]);
  assert.strictEqual(raw(s.file).items[0].numbers[0].recarrier, undefined);
  delOk = false;
  s.calls.length = 0;
  await s.svc.op({ op: "set-carrier", id: r.id, carrier: "fedex" });
  assert.ok(!s.calls.some((c) => c.ep === "register"), "no register after a failed delete");
  const n = raw(s.file).items[0].numbers[0];
  assert.strictEqual(n.recarrier, true);
  assert.strictEqual(n.carrier, "fedex"); assert.strictEqual(n.carrierSet, true);
  assert.ok(/carrier you chose/.test(n.reasonText), n.reasonText);
});

t("E: only 'rate limit' / 'too many requests' count as rate limiting", () => {
  for (const m of ["separate account problem", "cannot generate tracking", "accurate data missing"]) assert.notStrictEqual(T.classifyReason(m).reason, "rate", m);
  assert.strictEqual(T.classifyReason("rate limited").reason, "rate");
  assert.strictEqual(T.classifyReason("Too many requests").reason, "rate");
});

t("renderer: use-it-anyway confirmation exists for add, save number and the order picker", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "daily-shipments.js"), "utf8");
  assert.ok(src.includes("Use it anyway") && (src.match(/confirmable\(/g) || []).length >= 4);
});

(async () => {
  let n = 0, fails = 0;
  for (const { name, fn } of queue) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.stack.split("\n").slice(0, 5).join("\n  ")); } }
  console.log(`shipments-review: ${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
})();
