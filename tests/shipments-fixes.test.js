// node tests/shipments-fixes.test.js - Shipments fixes 1-7 (research 2026-10-31, fixtures F1-F20). Anonymised synthetic data only; temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const M = require("../src/daily/shipments-model");
const E = require("../src/daily/shipments-email");
const T = require("../src/daily/shipments-track");
const V = require("../src/daily/shipments-vision");
const S = require("../src/daily/shipments-main");
const NOW = Date.parse("2026-10-31T10:00:00Z");
const readStore = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const writeJsonAtomic = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(o)); fs.renameSync(f + ".tmp", f); };
const noTracker = { keys: { get: () => "", has: () => false, set() {} }, hasLiveProvider: () => false, status: () => ({}), call: async () => ({ ok: false }) };
const queue = []; const t = (n, f) => queue.push({ n, f });
const service = (seed, opts) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-fix-"));
  const file = path.join(dir, "shipments.json");
  if (seed) fs.writeFileSync(file, JSON.stringify(seed));
  const svc = S.createService(Object.assign({ file, readStore, writeJsonAtomic, tracker: noTracker, getMails: async () => [], now: () => NOW, notices: [], say: () => {} }, opts || {}));
  return { svc, file, dir, raw: () => JSON.parse(fs.readFileSync(file, "utf8")) };
};
const card = (o) => M.makeShipment(Object.assign({ state: "shipped", source: "email" }, o), NOW);

// ------------------------------------------------------------------ fix 1: carrier from 17TRACK + Exelot pattern (F7, F8)
const ACC = (extra) => Object.assign({ number: "XLT123456789", carrier: 100032, track_info: {
  latest_status: { status: "InTransit", sub_status: "InTransit_CustomsReleased" },
  tracking: { providers: [{ provider: { key: 100032, name: "Exelot" }, events: [{ time_iso: "2026-10-20T10:00:00Z", description: "Package released from customs", location: "Tel Aviv" }] }] },
} }, extra);
t("F7: XLT + 9 digits is Exelot with high confidence", () => {
  assert.deepStrictEqual(M.detectCarrier("XLT123456789"), { carrier: "exelot", confidence: "high" });
  assert.deepStrictEqual(M.detectCarrier("xlt 123 456 789"), { carrier: "exelot", confidence: "high" });
  assert.strictEqual(M.detectCarrier("XLT12345").carrier, "other");
});
t("F7: a stored 'other' on an XLT number reads as Exelot after load; the owner's choice is kept", () => {
  assert.strictEqual(M.makeShipment({ numbers: [{ no: "XLT123456789", carrier: "other" }] }, NOW).numbers[0].carrier, "exelot");
  assert.strictEqual(M.makeShipment({ numbers: [{ no: "XLT123456789", carrier: "other" }], carrier: "other" }, NOW).carrier, "exelot", "the card header follows");
  assert.strictEqual(M.makeShipment({ numbers: [{ no: "XLT123456789", carrier: "dhl", carrierSet: true }] }, NOW).numbers[0].carrier, "dhl");
  assert.strictEqual(M.makeShipment({ numbers: [{ no: "ZZ99999999", carrier: "other" }] }, NOW).numbers[0].carrier, "other");
});
t("F7: an iHerb mail with an XLT number yields an exelot candidate", () => {
  const c = E.extractShipments({ from: "iHerb <shipping@iherb.com>", subject: "Your iHerb order has shipped", date: "2026-10-20T08:00:00Z", messageId: "<ih1@iherb.com>", body: "Your order has shipped.\nTracking number: XLT123456789\n" }, NOW)[0];
  assert.deepStrictEqual(c.numbers, [{ no: "XLT123456789", carrier: "exelot" }]);
});
t("F8: parseTrackInfo keeps 17TRACK's carrier answer (id and display name)", () => {
  const p = T.parseTrackInfo(ACC());
  assert.strictEqual(p.carrier, "exelot");
  assert.strictEqual(p.carrierName, "Exelot");
  assert.strictEqual(M.carrierFromT17(100032), "exelot");
  assert.strictEqual(M.carrierFromT17(9061), "israelpost");
  assert.strictEqual(M.carrierFromT17(999999), "");
});
t("F8: an unknown 17TRACK carrier keeps only its display name", () => {
  const acc = ACC({ carrier: 424242 });
  acc.track_info.tracking.providers[0].provider = { key: 424242, name: "Some Local Courier" };
  const p = T.parseTrackInfo(acc);
  assert.strictEqual(p.carrier, "");
  assert.strictEqual(p.carrierName, "Some Local Courier");
});
t("fix 1: refresh stores the detected carrier on an 'other' number, never over the owner's choice", async () => {
  const a = card({ numbers: [{ no: "ZZ99999999" }], merchant: "Shop" });
  const b = card({ numbers: [{ no: "ZZ88888888", carrier: "dhl", carrierSet: true }], merchant: "Shop" });
  assert.strictEqual(a.numbers[0].carrier, "other");
  const fake = T.createFake({ ZZ99999999: { events: [{ at: NOW - 1000, text: "Arrived", place: "" }], state: "in_transit", carrier: "exelot", carrierName: "Exelot" }, ZZ88888888: { events: [{ at: NOW - 1000, text: "Arrived", place: "" }], state: "in_transit", carrier: "exelot", carrierName: "Exelot" } });
  const tr = T.createTracker({ fakeProvider: fake });
  await tr.refresh([a, b], NOW, { force: true });
  assert.strictEqual(a.numbers[0].carrier, "exelot");
  assert.strictEqual(a.carrier, "exelot");
  assert.strictEqual(b.numbers[0].carrier, "dhl");
  assert.strictEqual(b.carrier, "dhl");
});
t("fix 1: an unknown carrier name is kept as a label on the number", async () => {
  const a = card({ numbers: [{ no: "ZZ99999999" }] });
  const fake = T.createFake({ ZZ99999999: { events: [{ at: NOW - 1000, text: "Arrived", place: "" }], state: "in_transit", carrier: "", carrierName: "Some Local Courier" } });
  await T.createTracker({ fakeProvider: fake }).refresh([a], NOW, { force: true });
  assert.strictEqual(a.numbers[0].carrier, "other");
  assert.strictEqual(a.numbers[0].carrierLabel, "Some Local Courier");
  assert.strictEqual(M.makeShipment(JSON.parse(JSON.stringify(a)), NOW).numbers[0].carrierLabel, "Some Local Courier", "survives a reload");
});

// ------------------------------------------------------------------ fix 2: customs mapping (F8, F17)
t("F8: customs released is in transit, processing is customs", () => {
  assert.strictEqual(M.stateFromTrack17("InTransit", "InTransit_CustomsReleased", "Package released from customs"), "in_transit");
  assert.strictEqual(M.stateFromTrack17("InTransit", "InTransit_CustomsReleased", ""), "in_transit");
  assert.strictEqual(M.stateFromTrack17("InTransit", "InTransit_CustomsProcessing", "Arrived at customs"), "customs");
  assert.strictEqual(M.stateFromTrack17("InTransit", "InTransit_CustomsProcessing", ""), "customs");
  assert.strictEqual(M.stateFromTrack17("InTransit", "InTransit_CustomsRequiringInformation", ""), "customs");
  assert.strictEqual(M.stateFromTrack17("InTransit", "InTransit_Other", ""), "in_transit");
  assert.strictEqual(T.parseTrackInfo(ACC()).state, "in_transit");
});
t("F17: Hebrew customs release and pickup wording", () => {
  assert.strictEqual(M.stateFromText("החבילה שוחרר מהמכס"), "in_transit");
  assert.strictEqual(M.stateFromText("החבילה מוכנה לאיסוף בסניף"), "action_pickup");
});

// ------------------------------------------------------------------ fix 3: a mail seen before is re-merged (F12, F13, F20)
const SNIP = { orderId: "L-1", merchant: "AliExpress", state: "shipped", msgId: "m-1", at: NOW - 5000, numbers: [], items: [] };
const FULL = Object.assign({}, SNIP, { numbers: [{ no: "LP00123456789012345", carrier: "cainiao" }], items: [{ name: "Gadget Alpha", qty: 1, src: "https://ae01.alicdn.com/kf/a.jpg" }], itemCount: 1 });
t("F12: snippet first, then the full copy of the same mail: one card, with the number, items and picture", () => {
  const list = [];
  M.mergeCandidate(list, SNIP, NOW);
  const r = M.mergeCandidate(list, FULL, NOW);
  assert.strictEqual(list.length, 1);
  assert.ok(r.changed);
  assert.strictEqual(list[0].numbers[0].no, "LP00123456789012345");
  assert.strictEqual(list[0].items[0].name, "Gadget Alpha");
  assert.strictEqual(list[0].items[0].src, "https://ae01.alicdn.com/kf/a.jpg");
  const r2 = M.mergeCandidate(list, FULL, NOW);
  assert.ok(!r2.changed && list[0].numbers.length === 1 && list[0].items.length === 1, "idempotent");
});
t("F20: a parser improvement reaches cards made from the same mails earlier", () => {
  const list = [];
  M.mergeCandidate(list, Object.assign({}, FULL, { items: [] }), NOW);
  assert.strictEqual(list[0].items.length, 0);
  M.mergeCandidate(list, FULL, NOW);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].items.length, 1);
});
t("fix 3: a picture that failed twice is not queued again", () => {
  const list = [];
  M.mergeCandidate(list, FULL, NOW);
  const it = list[0].items[0];
  delete it.src; it.tried = 1;
  M.mergeCandidate(list, FULL, NOW);
  assert.ok(list[0].items[0].src, "one retry");
  delete list[0].items[0].src; list[0].items[0].tried = 2;
  M.mergeCandidate(list, FULL, NOW);
  assert.ok(!list[0].items[0].src, "then give up");
  assert.strictEqual(M.cleanItems([{ name: "x", tried: 2 }])[0].tried, 2);
  list[0].items[0].thumb = "ship-a.png"; list[0].items[0].tried = 0;
  M.mergeCandidate(list, FULL, NOW);
  assert.ok(!list[0].items[0].src, "a fetched picture is never queued again");
});
t("fix 3: the richest copy of a mail wins (Gmail full body before a Betterbird snippet)", () => {
  const mails = [{ messageId: "a", snippet: "short", from: "x" }, { messageId: "a", body: "the full body of the mail", images: ["https://i/1.jpg"], from: "x" }, { messageId: "b", snippet: "only snippet" }, { messageId: "", snippet: "no id 1" }, { messageId: "", snippet: "no id 2" }];
  const out = S.dedupeMails(mails);
  assert.strictEqual(out.length, 4);
  assert.ok(out.find((m) => m.messageId === "a").body);
  assert.strictEqual(out.filter((m) => m.messageId === "a").length, 1);
});
t("F13: a mail without Message-ID from two sources gets the same key and makes one card", () => {
  const base = { from: "AliExpress <order@notice.aliexpress.com>", subject: "Your order has shipped", messageId: "" };
  const a = E.extractShipments(Object.assign({}, base, { date: "2026-10-20T08:00:10Z", snippet: "Order ID: 1234567890123456. Your order has shipped" }), NOW)[0];
  const b = E.extractShipments(Object.assign({}, base, { date: "2026-10-20T08:00:40Z", body: "Order ID: 1234567890123456. Your order has shipped. Tracking number: LP00123456789012345" }), NOW)[0];
  assert.ok(a.msgId && a.msgId === b.msgId, "same hash key within the minute");
  const list = [];
  M.mergeCandidate(list, a, NOW); M.mergeCandidate(list, b, NOW);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].numbers.length, 1);
});

// ------------------------------------------------------------------ fix 4: mergeShipments, PH twin (F14, F15)
t("fix 4: mergeShipments keeps events, items, split, and recomputes the carrier", () => {
  const a = card({ id: "a", numbers: [{ no: "1234567890" }], carrier: "other", events: [{ at: 1000, text: "one", place: "" }], items: [{ name: "Thing", qty: 1 }], orderId: "O-1" });
  const b = card({ id: "b", numbers: [{ no: "LP00123456789012345", carrier: "cainiao", carrierSet: true }], split: true, events: [{ at: 2000, text: "two", place: "" }, { at: 1000, text: "one", place: "" }], items: [{ name: "Thing", qty: 1, thumb: "t.png" }, { name: "Other", qty: 2 }], orderCount: 3, itemCount: 3 });
  M.mergeShipments(a, b, NOW);
  assert.deepStrictEqual(a.events.map((e) => e.text), ["two", "one"]);
  assert.strictEqual(a.lastEvent.text, "two");
  assert.strictEqual(a.items.length, 2);
  assert.strictEqual(a.items.find((x) => x.name === "Thing").thumb, "t.png");
  assert.strictEqual(a.split, true);
  assert.strictEqual(a.carrier, "cainiao");
  assert.ok(a.numbers.find((x) => x.no.startsWith("LP")).carrierSet);
  assert.strictEqual(a.orderCount, 3);
});
t("F14: three cards on one mail, two with the PH form and one plain: one card, PH kept, events kept, carrier recomputed", () => {
  const [plain, ph] = Object.entries(M.NUMBER_FIXES)[0];
  const mk = (id, no, evs) => card({ id, msgIds: ["m-9"], merchant: "AliExpress", orderId: "9876543210123456", numbers: [{ no }], events: evs || [], carrier: "other" });
  const { svc, raw } = service({ version: 1, migrated: 3, items: [mk("c1", ph, [{ at: 5, text: "scan", place: "" }]), mk("c2", ph), mk("c3", plain)] });
  const items = svc._loadStore().items;
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual(items[0].numbers.map((x) => x.no), [ph]);
  assert.strictEqual(items[0].events.length, 1);
  assert.ok(raw().migrated >= 5);
});
t("fix 4: a store migrated at 4 whose only number is the owner's known-wrong plain form is repaired once, with a backup", () => {
  const [plain, ph] = Object.entries(M.NUMBER_FIXES)[0];
  const { svc, dir, raw } = service({ version: 1, migrated: 4, items: [card({ id: "c1", merchant: "AliExpress", numbers: [{ no: plain }] })] });
  const items = svc._loadStore().items;
  assert.deepStrictEqual(items[0].numbers.map((x) => x.no), [ph]);
  assert.ok(fs.readdirSync(dir).some((n) => /\.bak_/.test(n)), "backup first");
  assert.strictEqual(raw().migrated, 5);
});
t("F15: a number that used to be KNOWN_JUNK on a manual Amazon card with events is never touched, even in a rerun", () => {
  const c = card({ id: "z", merchant: "Amazon", source: "manual", numbers: [{ no: "5550001111", carrier: "aramex", carrierSet: true }], events: [{ at: 7, text: "Delivered to courier", place: "" }], msgIds: ["m-3"] });
  const e = card({ id: "y", merchant: "Amazon", source: "email", numbers: [], msgIds: ["m-3"] });
  const { svc } = service({ version: 1, migrated: 0, items: [c, e] });
  const items = svc._loadStore().items;
  const kept = items.find((x) => x.numbers.some((n) => n.no === "5550001111"));
  assert.ok(kept && kept.events.length === 1, "number and events survive");
  const { svc: s2 } = service({ version: 1, migrated: 3, items: [Object.assign({}, c, { msgIds: [] })] });
  assert.ok(s2._loadStore().items[0].events.length === 1);
});

// ------------------------------------------------------------------ fix 5: 'amazon' is a carrier only for TBA numbers (F5, F6)
t("F5/F6: amazon counts only for TBA numbers", () => {
  assert.strictEqual(M.detectCarrier("TBA123456789012", "amazon").carrier, "amazon");
  assert.notStrictEqual(M.detectCarrier("1234567890", "amazon").carrier, "amazon");
  assert.notStrictEqual(M.detectCarrier("ZZ99999999", "amazon").carrier, "amazon");
  const p = E.parseAddInput("Amazon 1234567890");
  assert.notStrictEqual(p.numbers[0].carrier, "amazon");
});
t("F5: a screenshot saying 'Shipped with Amazon' for a 10-digit number is not an amazon number and gets polled", async () => {
  const items = [];
  const reading = { ok: true, orderId: "113-1234567-7654321", merchant: "Amazon", parcels: [{ carrier: "amazon", no: "1234567890", items: ["Gadget"], boxes: [null], eta: "" }, { carrier: "amazon", no: "TBA123456789012", items: [], boxes: [], eta: "" }] };
  V.applyReading(items, reading, NOW, "");
  const ten = items.find((x) => x.numbers.some((n) => n.no === "1234567890")).numbers[0];
  const tba = items.find((x) => x.numbers.some((n) => n.no === "TBA123456789012")).numbers[0];
  assert.notStrictEqual(ten.carrier, "amazon");
  assert.ok(!ten.carrierSet);
  assert.strictEqual(tba.carrier, "amazon");
  const fake = T.createFake({});
  const tr = T.createTracker({ fakeProvider: fake });
  const due = tr.due(items, NOW, true).map((d) => d.number);
  assert.deepStrictEqual(due, ["1234567890"], "TBA is not polled, the 10-digit number is");
  assert.ok(/not a carrier|TBA/.test(V.PROMPT("f", "")), "the reader prompt says so");
});
t("F5: stored amazon+non-TBA numbers heal on load; the set-carrier op refuses amazon for them", async () => {
  const s = M.makeShipment({ numbers: [{ no: "1234567890", carrier: "amazon", carrierSet: true }], carrier: "amazon" }, NOW);
  assert.notStrictEqual(s.numbers[0].carrier, "amazon");
  assert.notStrictEqual(s.carrier, "amazon");
  assert.ok(!s.numbers[0].carrierSet);
  const { svc } = service({ version: 1, migrated: 5, items: [card({ id: "q", numbers: [{ no: "1234567890" }] })] });
  const r = await svc.op({ op: "set-carrier", id: "q", carrier: "amazon" });
  assert.strictEqual(r.ok, false);
});

// ------------------------------------------------------------------ fix 6: pictures by alt text and shop image hosts (F2, F7, F19)
const AMZ = (o) => Object.assign({ from: "Amazon <shipment-tracking@amazon.com>", subject: "Shipped: 2 items", date: "2026-10-30T08:00:00Z", messageId: "<am1@amazon.com>", verified: "amazon.com", body: "Your package has shipped.\nShipped 2 items: Gadget Alpha Pro, Widget Beta Mini\nOrder # 113-1234567-7654321\n", imageAlts: [
  { src: "https://m.media-amazon.com/images/G/01/logo.png", alt: "Amazon" },
  { src: "https://m.media-amazon.com/images/I/aaa.jpg", alt: "Gadget Alpha Pro - 12 pack" },
  { src: "https://m.media-amazon.com/images/I/bbb.jpg", alt: "Widget Beta Mini black" },
  ...[1, 2, 3, 4, 5, 6].map((i) => ({ src: "https://m.media-amazon.com/images/I/rec" + i + ".jpg", alt: "Recommended product number " + i })),
] }, o || {});
t("F2: Amazon shipped mail: pictures pair by alt text, logo and recommendations ignored", () => {
  const c = E.extractShipments(AMZ(), NOW)[0];
  assert.strictEqual(c.items.length, 2);
  assert.strictEqual(c.items[0].src, "https://m.media-amazon.com/images/I/aaa.jpg");
  assert.strictEqual(c.items[1].src, "https://m.media-amazon.com/images/I/bbb.jpg");
  assert.strictEqual(c.itemCount, 2);
});
t("F7: iHerb mail with no item text: the alt becomes the name, the picture goes with it", () => {
  const c = E.extractShipments({ from: "iHerb <shipping@iherb.com>", subject: "Your iHerb order has shipped", date: "2026-10-20T08:00:00Z", messageId: "<ih2@iherb.com>", verified: "iherb.com", body: "Your order has shipped.\nTracking number: XLT123456789\n", imageAlts: [
    { src: "https://s3.images-iherb.com/logo/iherb.png", alt: "iHerb" },
    { src: "https://s3.images-iherb.com/abc/l/1.jpg", alt: "Vitamin Example 500 mg, 90 Capsules" },
    { src: "https://cloudinary.images-iherb.com/image/upload/2.jpg", alt: "Protein Sample Powder, Vanilla" }] }, NOW)[0];
  assert.deepStrictEqual(c.items.map((x) => x.name), ["Vitamin Example 500 mg, 90 Capsules", "Protein Sample Powder, Vanilla"]);
  assert.ok(c.items.every((x) => /^https:\/\//.test(x.src)));
});
t("F19: no pictures when the sender failed DMARC, or the host is not a known shop image host", () => {
  assert.ok(E.extractShipments(AMZ({ verified: "" }), NOW)[0].items.every((x) => !x.src));
  assert.ok(E.extractShipments(AMZ({ verified: "evil.example" }), NOW)[0].items.every((x) => !x.src));
  const evil = AMZ({ imageAlts: [{ src: "https://evil.example/aaa.jpg", alt: "Gadget Alpha Pro - 12 pack" }, { src: "http://m.media-amazon.com/images/I/bbb.jpg", alt: "Widget Beta Mini black" }, { src: "https://m.media-amazon.com.evil.example/images/I/ccc.jpg", alt: "Widget Beta Mini black" }] });
  assert.ok(E.extractShipments(evil, NOW)[0].items.every((x) => !x.src));
});
t("F16: the older count-based pairing still works for mails that carry only plain image urls (B&H regression)", () => {
  const c = E.extractShipments({ from: "B&H Photo <orders@bhphotovideo.com>", subject: "B&H Photo Order #1100000001 Shipped", date: "2026-10-27T08:00:00Z", messageId: "bh1", verified: "bhphotovideo.com", images: ["https://i/logo.png", "https://i/a.jpg", "https://i/b.jpg"], body: "<td>Tracking # 520000000006</td><td>Thing A</td><td>B&amp;H #AA1</td><td>QTY: 1</td><td>Thing B</td><td>B&amp;H #AB2</td><td>QTY: 1</td>" }, NOW)[0];
  assert.strictEqual(c.items.length, 2);
  assert.strictEqual(c.items[0].src, "https://i/a.jpg");
});
t("fix 6: gmail returns image alt texts next to the urls", () => {
  const G = require("../src/daily/gmail");
  assert.strictEqual(typeof G.htmlImageAlts, "function");
  const html = '<p><img src="https://m.media-amazon.com/images/I/a.jpg" alt="Gadget &amp; Co" width="200"><img src="https://x.example/p.gif" width="1" alt="px"><img alt="Late alt" src="https://m.media-amazon.com/images/I/b.jpg"></p>';
  const payload = { mimeType: "text/html", body: { data: Buffer.from(html).toString("base64") } };
  assert.deepStrictEqual(G.htmlImageAlts(payload), [{ src: "https://m.media-amazon.com/images/I/a.jpg", alt: "Gadget & Co" }, { src: "https://m.media-amazon.com/images/I/b.jpg", alt: "Late alt" }]);
});

// ------------------------------------------------------------------ fix 7: duplicate check on every save (F14, G)
t("fix 7: enforceInvariant merges open cards that share a number or a mail id, leaves archived and split-manual alone", () => {
  const a = card({ id: "a", numbers: [{ no: "LP00123456789012345" }], events: [{ at: 1, text: "e", place: "" }] });
  const b = card({ id: "b", numbers: [{ no: "LP00123456789012345" }] });
  const c = card({ id: "c", msgIds: ["m-5"], numbers: [{ no: "AA11111111" }] });
  const d = card({ id: "d", msgIds: ["m-5"], numbers: [] });
  const e = card({ id: "e", numbers: [{ no: "LP00123456789012345" }], archived: true, archivedAt: NOW, state: "delivered" });
  const f = card({ id: "f", msgIds: ["m-6"], source: "manual", split: true, orderId: "O-1" });
  const g = card({ id: "g", msgIds: ["m-6"], orderId: "O-1" });
  const list = [a, b, c, d, e, f, g];
  const r = M.enforceInvariant(list, NOW);
  assert.strictEqual(r.merged, 2);
  assert.deepStrictEqual(list.map((x) => x.id).sort(), ["a", "c", "e", "f", "g"]);
  assert.strictEqual(M.enforceInvariant(list, NOW).merged, 0, "idempotent");
});
t("fix 7: every save runs the check, writes a backup and logs one line", async () => {
  const logs = [];
  const { svc, dir, raw } = service({ version: 1, migrated: 5, items: [card({ id: "a", numbers: [{ no: "LP00123456789012345" }] }), card({ id: "b", numbers: [{ no: "LP00123456789012345" }] }), card({ id: "k", numbers: [{ no: "AA11111111" }] })] }, { say: (m) => logs.push(m) });
  const r = await svc.op({ op: "note", id: "k", note: "hi" });
  assert.ok(r.ok);
  assert.strictEqual(raw().items.length, 2);
  assert.ok(fs.readdirSync(dir).some((n) => /\.bak_.*_before_dedupe$/.test(n)));
  assert.ok(logs.some((l) => /merged 1 duplicate/.test(l)));
});
t("fix 7: the scan with the same mail twice (snippet then full) leaves one card and keeps full data", async () => {
  const mails = [
    { from: "AliExpress <order@notice.aliexpress.com>", subject: "Your order has shipped", messageId: "m1", date: "2026-10-30T08:00:00Z", snippet: "Order 1234567890123456 has shipped" },
    { from: "AliExpress <order@notice.aliexpress.com>", subject: "Your order has shipped", messageId: "m1", date: "2026-10-30T08:00:00Z", body: "Order 1234567890123456 has shipped. Tracking number: LP00123456789012345" },
  ];
  const { svc, raw } = service({ version: 1, migrated: 5, items: [] }, { getMails: async () => mails });
  await svc.load({ force: true });
  const items = raw().items;
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].numbers[0].no, "LP00123456789012345");
});

(async () => { let f = 0; for (const { n, f: fn } of queue) { try { await fn(); } catch (e) { f++; console.error("FAIL " + n + "\n  " + e.stack.split("\n").slice(0, 5).join("\n  ")); } } console.log(`shipments-fixes: ${queue.length - f}/${queue.length} passed`); process.exit(f ? 1 : 0); })();
