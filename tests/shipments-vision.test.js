// node tests/shipments-vision.test.js - screenshot reading, applying a reading, Amazon junk numbers, the EPERM save fallback. Temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const M = require("../src/daily/shipments-model");
const E = require("../src/daily/shipments-email");
const S = require("../src/daily/shipments-main");
const V = require("../src/daily/shipments-vision");
const NOW = Date.parse("2026-10-27T10:00:00Z");
const ORDER = "113-6007992-3663405";
const readStore = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const writeJsonAtomic = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const noTracker = { keys: { get: () => "", has: () => false, set() {} }, hasLiveProvider: () => false, status: () => ({}), call: async () => ({ ok: false }) };
const queue = []; const t = (n, f) => queue.push({ n, f });
const mk = (extra) => M.makeShipment(Object.assign({ orderId: ORDER, merchant: "Amazon", state: "shipped", source: "email" }, extra || {}), NOW);

t("parseReading: JSON inside prose/fence is found; order number in trackingNumber is kept for apply to refuse; bad carrier dropped", () => {
  const r = V.parseReading('Here you go:\n```json\n{"orderId":"113-6007992-3663405","merchant":"Amazon","parcels":[{"carrier":"dhl","trackingNumber":"8004 1009 21","items":["Mic","Cable"],"eta":"Nov 10"},{"carrier":"zzz","trackingNumber":"","items":[]}]}\n```');
  assert.ok(r.ok && r.parcels.length === 2);
  assert.strictEqual(r.parcels[0].no, "8004100921");
  assert.strictEqual(r.parcels[0].carrier, "dhl");
  assert.strictEqual(r.parcels[1].carrier, "");
  assert.strictEqual(V.parseReading("sorry I cannot").ok, false);
  assert.strictEqual(V.parseReading("{not json}").ok, false);
});

t("applyReading: number goes to the numberless card of that order, items become the title, order number refused", () => {
  const list = [mk({ title: "" })];
  const rd = V.parseReading(JSON.stringify({ orderId: ORDER, merchant: "Amazon", parcels: [{ carrier: "dhl", trackingNumber: "8004100921", items: ["Mic", "Cable"] }, { carrier: "other", trackingNumber: "113-6007992-3663405", items: ["x"] }] }));
  const r = V.applyReading(list, rd, NOW, ORDER);
  assert.ok(r.ok);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].numbers[0].no, "8004100921");
  assert.strictEqual(list[0].title, "Mic, Cable");
  assert.ok(r.summary.some((x) => /order number/.test(x)));
});

t("applyReading: two parcels on one order give two cards, each with its own items; re-applying changes nothing", () => {
  const list = [mk()];
  const rd = V.parseReading(JSON.stringify({ parcels: [{ carrier: "dhl", trackingNumber: "8004100921", items: ["Mic"] }, { carrier: "ups", trackingNumber: "1Z999AA10123456784", items: ["Tripod"] }] }));
  const r = V.applyReading(list, rd, NOW, ORDER);
  assert.ok(r.ok && list.length === 2 && r.created === 1);
  assert.ok(list.every((x) => x.split && x.orderId === ORDER));
  assert.deepStrictEqual(list.map((x) => x.title).sort(), ["Mic", "Tripod"]);
  const again = V.applyReading(list, rd, NOW + 1000, ORDER);
  assert.ok(again.ok && list.length === 2 && again.created === 0);
});

t("applyReading: a parcel with no number only names a single numberless card; empty reading is refused", () => {
  const list = [mk()];
  const r = V.applyReading(list, V.parseReading(JSON.stringify({ parcels: [{ items: ["Mic"] }] })), NOW, ORDER);
  assert.ok(r.ok && list[0].title === "Mic" && list[0].numbers.length === 0);
  assert.strictEqual(V.applyReading([mk()], V.parseReading(JSON.stringify({ parcels: [] })), NOW, ORDER).ok, false);
});

t("op screenshot: end to end through the service with an injected reader; bad image refused", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ship-vis-")), "shipments.json");
  const seed = { items: [mk()] };
  fs.writeFileSync(file, JSON.stringify(seed));
  const stub = JSON.stringify({ orderId: ORDER, merchant: "Amazon", parcels: [{ carrier: "dhl", trackingNumber: "8004100921", items: ["Mic"] }] });
  const reader = V.createReader({ testMode: true, stubFile: path.join(path.dirname(file), "stub.txt") });
  fs.writeFileSync(path.join(path.dirname(file), "stub.txt"), stub);
  const svc = S.createService({ file, readStore, writeJsonAtomic, tracker: noTracker, getMails: async () => [], readScreenshot: reader.read, now: () => NOW, notices: [], say: () => {}, testMode: true });
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const r = await svc.op({ op: "screenshot", image: png, orderId: ORDER });
  assert.ok(r.ok, JSON.stringify(r));
  const items = JSON.parse(fs.readFileSync(file, "utf8")).items;
  assert.strictEqual(items[0].numbers[0].no, "8004100921");
  const bad = await svc.op({ op: "screenshot", image: "hello", orderId: ORDER });
  assert.strictEqual(bad.ok, false);
});

t("cleanBox: fractions inside the picture are kept, anything implausible is dropped", () => {
  assert.deepStrictEqual(V.cleanBox([0.05, 0.25, 0.17, 0.44]), [0.05, 0.25, 0.17, 0.44]);
  assert.strictEqual(V.cleanBox(null), null);
  assert.strictEqual(V.cleanBox([0.2, 0.2, 0.1, 0.4]), null, "inverted");
  assert.strictEqual(V.cleanBox([0, 0, 1, 1]), null, "whole screenshot");
  assert.strictEqual(V.cleanBox([0.1, 0.1, 0.11, 0.3]), null, "too thin");
  assert.strictEqual(V.cleanBox([0.1, 0.1, 0.9, 0.2]), null, "a banner, not a product picture");
  assert.strictEqual(V.cleanBox(["a", 0, 1, 1]), null);
});
t("parseReading: items may be strings (old) or {name, box}; boxes run parallel to names", () => {
  const r = V.parseReading(JSON.stringify({ orderId: ORDER, parcels: [{ trackingNumber: "2367361581", carrier: "aramex", items: ["Cable", { name: "Slippers", box: [0.05, 0.25, 0.17, 0.44] }, { name: "Band", box: [0, 0, 1, 1] }] }] }));
  assert.deepStrictEqual(r.parcels[0].items, ["Cable", "Slippers", "Band"]);
  assert.deepStrictEqual(r.parcels[0].boxes, [null, [0.05, 0.25, 0.17, 0.44], null]);
});
t("applyReading: screenshot items become card items and queue one crop per picture; a card that already has pictures is left alone", () => {
  const card = mk({ numbers: [], orderId: ORDER });
  const rd = V.parseReading(JSON.stringify({ orderId: ORDER, merchant: "Amazon", parcels: [{ trackingNumber: "2367361581", carrier: "aramex", items: [{ name: "Slippers", box: [0.05, 0.25, 0.17, 0.44] }, { name: "Band" }] }] }));
  const list = [card];
  const out = V.applyReading(list, rd, NOW, ORDER);
  assert.ok(out.ok, JSON.stringify(out));
  assert.deepStrictEqual(card.items.map((x) => x.name), ["Slippers", "Band"]);
  assert.strictEqual(out.crops.length, 1);
  assert.strictEqual(out.crops[0].card, card);
  assert.strictEqual(out.crops[0].index, 0);
  const withPic = mk({ numbers: [{ no: "2367361581", carrier: "aramex" }], items: [{ name: "Keep me", qty: 1, thumb: "ship-x-0.png" }] });
  const out2 = V.applyReading([withPic], rd, NOW, ORDER);
  assert.strictEqual(withPic.items[0].name, "Keep me");
  assert.strictEqual(out2.crops.length, 0);
});
t("op screenshot: pictures are cropped through the injected cropPicture and stored as item thumbs; a failing crop only loses that picture", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ship-crop-")), "shipments.json");
  fs.writeFileSync(file, JSON.stringify({ items: [mk()] }));
  const stub = JSON.stringify({ orderId: ORDER, merchant: "Amazon", parcels: [{ carrier: "aramex", trackingNumber: "2367361581", items: [{ name: "A", box: [0.05, 0.25, 0.17, 0.44] }, { name: "B", box: [0.05, 0.5, 0.17, 0.7] }] }] });
  fs.writeFileSync(path.join(path.dirname(file), "stub.txt"), stub);
  const reader = V.createReader({ testMode: true, stubFile: path.join(path.dirname(file), "stub.txt") });
  const calls = [];
  const cropPicture = async (url, box, id) => { calls.push(box); if (calls.length === 2) throw new Error("boom"); return id + ".png"; };
  const svc = S.createService({ file, readStore, writeJsonAtomic, tracker: noTracker, getMails: async () => [], readScreenshot: reader.read, cropPicture, now: () => NOW, notices: [], say: () => {}, testMode: true });
  const r = await svc.op({ op: "screenshot", image: "data:image/png;base64,iVBORw0KGgo=", orderId: ORDER });
  assert.ok(r.ok, JSON.stringify(r));
  const card = JSON.parse(fs.readFileSync(file, "utf8")).items[0];
  assert.strictEqual(calls.length, 2);
  assert.ok(/^ship-[\w-]+-s0-[\w]+\.png$/.test(card.items[0].thumb), card.items[0].thumb);
  assert.ok(!card.items[1].thumb);
});

t("migration 3: the junk 10-digit number on an Amazon email card is dropped with its events; a chosen carrier is kept; backup made", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-mig-"));
  const file = path.join(dir, "shipments.json");
  const junk = mk({ numbers: [{ no: "2367361581", carrier: "dhl", carrierSet: false }], state: "delivered", events: [{ at: NOW - 9e8, text: "final status", place: "MILAN" }], lastEvent: { at: NOW - 9e8, text: "final status", place: "MILAN" } });
  const kept = mk({ orderId: "113-1111111-2222222", numbers: [{ no: "5551234567", carrier: "dhl", carrierSet: true }] });
  fs.writeFileSync(file, JSON.stringify({ items: [junk, kept], migrated: 2 }));
  const svc = S.createService({ file, readStore, writeJsonAtomic, tracker: noTracker, getMails: async () => [], now: () => NOW, notices: [], say: () => {}, testMode: true });
  const v = await svc.load({});
  const items = JSON.parse(fs.readFileSync(file, "utf8")).items;
  assert.strictEqual(items.find((x) => x.orderId === ORDER).numbers.length, 0);
  assert.strictEqual(items.find((x) => x.orderId === ORDER).events.length, 0);
  assert.strictEqual(items.find((x) => x.orderId === "113-1111111-2222222").numbers.length, 1);
  assert.ok(fs.readdirSync(dir).some((n) => /before_numberfix/.test(n)), "backup file");
  assert.ok(v.ok);
});

t("migration 3: a weak number that has tracking history is never touched (Evri 16 digits, owner 'auto'); a numberless-history guess is dropped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-mig2-"));
  const file = path.join(dir, "shipments.json");
  const proven = mk({ orderId: "113-3333333-4444444", numbers: [{ no: "5559876543", carrier: "dhl", carrierSet: false }], state: "in_transit", events: [{ at: NOW - 1e6, text: "Departed", place: "Leipzig" }], lastEvent: { at: NOW - 1e6, text: "Departed", place: "Leipzig" } });
  const guess = mk({ orderId: "113-5555555-6666666", numbers: [{ no: "5550001112", carrier: "dhl", carrierSet: false }] });
  fs.writeFileSync(file, JSON.stringify({ items: [proven, guess], migrated: 2 }));
  const svc = S.createService({ file, readStore, writeJsonAtomic, tracker: noTracker, getMails: async () => [], now: () => NOW, notices: [], say: () => {}, testMode: true });
  await svc.load({});
  const items = JSON.parse(fs.readFileSync(file, "utf8")).items;
  const p = items.find((x) => x.orderId === "113-3333333-4444444");
  assert.strictEqual(p.numbers.length, 1); assert.strictEqual(p.events.length, 1); assert.ok(p.lastEvent);
  assert.strictEqual(items.find((x) => x.orderId === "113-5555555-6666666").numbers.length, 0);
});

t("IPC size: a worst-case screenshot request stays under the 262144-character cap of the daily-* wrapper", () => {
  const image = "data:image/jpeg;base64," + "A".repeat(V.MAX_DATAURL_CHARS - 23);
  const req = { op: "screenshot", id: "smvmq2trm3e9t", image, orderId: "113-6007992-3663405" };
  assert.ok(JSON.stringify(req).length < 262144, "request " + JSON.stringify(req).length);
  assert.ok(V.MAX_DATAURL_CHARS <= 230000);
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "daily-shipments.js"), "utf8");
  assert.ok(/url\.length <= 230000/.test(src), "renderer limit matches MAX_DATAURL_CHARS");
  assert.ok(/MAX_ARG_CHARS = 262144/.test(fs.readFileSync(path.join(__dirname, "..", "src", "daily", "main-daily.js"), "utf8")), "cap unchanged");
});

t("save fallback: a truncated shipments.json is restored from the .bak by readStore", () => {
  const D = require("../src/daily/main-daily");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-trunc-"));
  const file = path.join(dir, "shipments.json");
  D.writeJsonAtomic(file, { version: 1, items: [{ id: "a" }] });
  D.writeJsonAtomic(file, { version: 1, items: [{ id: "a" }, { id: "b" }] });   // second write makes the .bak (the first version)
  fs.writeFileSync(file, '{"version":1,"items":[{"id":"a"},{"i');                // a crash mid in-place write
  const notices = [];
  const got = D.readStore(file, { items: [] }, notices, "Shipments");
  assert.ok(Array.isArray(got.items) && got.items.length >= 1, "restored: " + JSON.stringify(got));
  assert.ok(notices.length >= 1, "owner is told");
});

t("email: an Amazon shop mail's unrecognised id is no longer a tracking number", () => {
  const mail = { from: "ship-confirm@amazon.com", subject: "Shipped: your Amazon order " + ORDER, date: "2026-10-05T10:00:00Z", messageId: "m1",
    body: "Your package has shipped. Order # " + ORDER + "\nTrack your package: https://www.amazon.com/progress-tracker/package/ref?shipmentId=2367361581\nTracking ID: 2367361581\nArriving Tuesday" };
  const c = E.extractShipments(mail, NOW);
  assert.ok(c.length === 1);
  assert.strictEqual(c[0].numbers.length, 0, "no junk number: " + JSON.stringify(c[0].numbers));
  assert.strictEqual(c[0].orderId, ORDER);
});

(async () => { let f = 0; for (const { n, f: fn } of queue) { try { await fn(); } catch (e) { f++; console.error("FAIL " + n + "\n  " + e.stack.split("\n").slice(0, 5).join("\n  ")); } } console.log(`shipments-vision: ${queue.length - f}/${queue.length} passed`); process.exit(f ? 1 : 0); })();
