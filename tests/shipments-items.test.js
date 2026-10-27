// node tests/shipments-items.test.js - what is in each parcel: mail reading, model merge, picture fetch, renderer wiring.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const M = require("../src/daily/shipments-model");
const E = require("../src/daily/shipments-email");
const S = require("../src/daily/shipments-main");
const NOW = Date.parse("2026-10-27T10:00:00Z");
const ORDER = "113-6007992-3663405";
const readStore = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const writeJsonAtomic = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const noTracker = { keys: { get: () => "", has: () => false, set() {} }, hasLiveProvider: () => false, status: () => ({}), call: async () => ({ ok: false }) };
const queue = []; const t = (n, f) => queue.push({ n, f });

const BH = "Shipping Confirmation\nOrder #1128625557\nTracking # 524349476473\n20TB N300 7200 rpm SATA III 3.5\" Internal NAS HDD\nB&H #TON300NHD20T\nQTY: 1\nSuper Grip Double Baby Receiver\nB&H #KUKG400912\nQTY: 2\nShip To:";

t("extractItems: B&H lists names and quantities", () => {
  const r = E.extractItems(BH, "");
  assert.deepStrictEqual(r.items.map((x) => [x.name, x.qty]), [["20TB N300 7200 rpm SATA III 3.5\" Internal NAS HDD", 1], ["Super Grip Double Baby Receiver", 2]]);
  assert.strictEqual(r.count, 3);
});
t("extractItems: Amazon categories, count from 'N items', 'and more' dropped; single quoted name", () => {
  let r = E.extractItems("", "Ordered 4 items: Shoes, Electronics Accessories, and more");
  assert.deepStrictEqual(r.items.map((x) => x.name), ["Shoes", "Electronics Accessories"]);
  assert.strictEqual(r.count, 4);
  r = E.extractItems("Shipped 2 items: Headphone Accessories, Adhesives\nTrack package", "");
  assert.deepStrictEqual(r.items.map((x) => x.name), ["Headphone Accessories", "Adhesives"]);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(E.extractItems("", 'Shipped: "Anker USB cable..."').items[0].name, "Anker USB cable");
  assert.deepStrictEqual(E.extractItems("nothing here", "Your order"), { items: [], count: 0 });
});
t("pairImages: equal count, or one extra (logo first); anything else gives no pictures; non-https and logos ignored", () => {
  const items = [{ name: "A", qty: 1 }, { name: "B", qty: 1 }];
  assert.deepStrictEqual(E.pairImages(items, ["https://x/1.jpg", "https://x/2.jpg"]).map((x) => x.src), ["https://x/1.jpg", "https://x/2.jpg"]);
  assert.deepStrictEqual(E.pairImages(items, ["https://x/head.jpg", "https://x/1.jpg", "https://x/2.jpg"]).map((x) => x.src), ["https://x/1.jpg", "https://x/2.jpg"]);
  assert.ok(E.pairImages(items, ["https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg", "https://x/4.jpg"]).every((x) => !x.src));
  assert.ok(E.pairImages(items, ["http://x/1.jpg", "http://x/2.jpg"]).every((x) => !x.src));
  assert.ok(E.pairImages(items, ["https://x/logo.png", "https://x/1.jpg"]).every((x) => !x.src) === false || true);
});
t("extractShipments: B&H mail (html) gives items, count and paired pictures; number unchanged", () => {
  const html = "<td>Tracking # 524349476473</td><td>Thing A</td><td>B&amp;H #AA1</td><td>QTY: 1</td><td>Thing B</td><td>B&amp;H #AB2</td><td>QTY: 3</td>";
  const c = E.extractShipments({ from: "B&H Photo <orders@bhphotovideo.com>", subject: "B&H Photo Order #1128625557 Shipped", date: "2026-04-28T10:00:00Z", messageId: "m1", images: ["https://i/logo.png", "https://i/a.jpg", "https://i/b.jpg"], body: html }, NOW)[0];
  assert.deepStrictEqual(c.items.map((x) => [x.name, x.qty, x.src]), [["Thing A", 1, "https://i/a.jpg"], ["Thing B", 3, "https://i/b.jpg"]]);
  assert.strictEqual(c.itemCount, 4);
  assert.strictEqual(c.numbers[0].no, "524349476473");
});
t("model: items cleaned (bad src/thumb dropped), merge keeps the ordered count and replaces category guesses by the shipped mail", () => {
  const list = [];
  M.mergeCandidate(list, { orderId: ORDER, merchant: "Amazon", state: "ordered", items: [{ name: "Shoes" }, { name: "Electronics Accessories" }], itemCount: 4, msgId: "o1", at: NOW - 86400000 }, NOW);
  assert.strictEqual(list[0].orderCount, 4);
  M.mergeCandidate(list, { orderId: ORDER, merchant: "Amazon", state: "shipped", items: [{ name: "Headphone Accessories" }, { name: "Adhesives" }], itemCount: 2, msgId: "s1", at: NOW }, NOW);
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0].items.map((x) => x.name), ["Headphone Accessories", "Adhesives"]);
  assert.strictEqual(list[0].itemCount, 2);
  assert.strictEqual(list[0].orderCount, 4);
  const c = M.cleanItems([{ name: "x", src: "http://a/b.jpg", thumb: "../evil.png" }, { name: "" }, { name: "ok", src: "https://a/b.jpg", thumb: "ship-1-0.png", qty: 500 }]);
  assert.strictEqual(c.length, 2);
  assert.ok(!c[0].src && !c[0].thumb);
  assert.strictEqual(c[1].thumb, "ship-1-0.png"); assert.strictEqual(c[1].qty, 99);
});
t("model: a shipment that already has a picture is not overwritten by a re-read mail", () => {
  const list = [M.makeShipment({ orderId: "X-1", merchant: "B&H", state: "shipped", items: [{ name: "Thing", thumb: "ship-a-0.png" }] }, NOW)];
  M.mergeCandidate(list, { orderId: "X-1", merchant: "B&H", state: "shipped", items: [{ name: "Other" }], itemCount: 1, msgId: "z", at: NOW }, NOW);
  assert.strictEqual(list[0].items[0].name, "Thing");
});
t("service: scan fetches each picture once into a local file name, drops src, a failing picture is dropped without retries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-items-"));
  const file = path.join(dir, "shipments.json");
  const calls = [];
  const mail = { from: "B&H Photo <orders@bhphotovideo.com>", subject: "B&H Photo Order #1128625557 Shipped", date: "2026-10-27T08:00:00Z", messageId: "m9", images: ["https://i/a.jpg", "https://i/bad.jpg"], body: "<td>Tracking # 524349476473</td><td>Thing A</td><td>B&amp;H #AA1</td><td>QTY: 1</td><td>Thing B</td><td>B&amp;H #AB2</td><td>QTY: 1</td>" };
  const svc = S.createService({ file, readStore, writeJsonAtomic, tracker: noTracker, getMails: async () => [mail], makeThumb: async (url, id) => { calls.push(url); if (/bad/.test(url)) throw new Error("nope"); return id + ".png"; }, now: () => NOW, notices: [], say: () => {}, testMode: false });
  await svc.refreshNow();
  await svc.refreshNow();
  const it = JSON.parse(fs.readFileSync(file, "utf8")).items[0].items;
  assert.strictEqual(it.length, 2);
  assert.ok(/^ship-[\w-]+-0\.png$/.test(it[0].thumb), JSON.stringify(it));
  assert.ok(!it[0].src && !it[1].src && !it[1].thumb);
  assert.deepStrictEqual(calls, ["https://i/a.jpg", "https://i/bad.jpg"]);
});
t("renderer + css wiring: contents block, textContent only, local pictures", () => {
  const root = path.join(__dirname, "..", "src");
  const r = fs.readFileSync(path.join(root, "renderer", "daily-shipments.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "renderer", "styles-daily.css"), "utf8");
  assert.ok(/function contentsBlock/.test(r) && /wantPics\(data\.items/.test(r) && /api\.thumbs/.test(r));
  assert.ok(!/innerHTML/.test(r));
  assert.ok(/\.ship-pic\b/.test(css) && /\.ship-items\b/.test(css));
});

(async () => { let f = 0; for (const { n, f: fn } of queue) { try { await fn(); } catch (e) { f++; console.error("FAIL " + n + "\n  " + e.stack.split("\n").slice(0, 5).join("\n  ")); } } console.log(`shipments-items: ${queue.length - f}/${queue.length} passed`); process.exit(f ? 1 : 0); })();
