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

t("email: an Amazon shop mail's unrecognised id is no longer a tracking number", () => {
  const mail = { from: "ship-confirm@amazon.com", subject: "Shipped: your Amazon order " + ORDER, date: "2026-10-05T10:00:00Z", messageId: "m1",
    body: "Your package has shipped. Order # " + ORDER + "\nTrack your package: https://www.amazon.com/progress-tracker/package/ref?shipmentId=2367361581\nTracking ID: 2367361581\nArriving Tuesday" };
  const c = E.extractShipments(mail, NOW);
  assert.ok(c.length === 1);
  assert.strictEqual(c[0].numbers.length, 0, "no junk number: " + JSON.stringify(c[0].numbers));
  assert.strictEqual(c[0].orderId, ORDER);
});

(async () => { let f = 0; for (const { n, f: fn } of queue) { try { await fn(); } catch (e) { f++; console.error("FAIL " + n + "\n  " + e.stack.split("\n").slice(0, 5).join("\n  ")); } } console.log(`shipments-vision: ${queue.length - f}/${queue.length} passed`); process.exit(f ? 1 : 0); })();
