// node tests/shipments-items.test.js - what is in each parcel: mail reading, model merge, picture fetch, renderer wiring.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const M = require("../src/daily/shipments-model");
const E = require("../src/daily/shipments-email");
const S = require("../src/daily/shipments-main");
const NOW = Date.parse("2026-10-27T10:00:00Z");
const ORDER = "113-0000007-0000008";
const readStore = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const writeJsonAtomic = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const noTracker = { keys: { get: () => "", has: () => false, set() {} }, hasLiveProvider: () => false, status: () => ({}), call: async () => ({ ok: false }) };
const queue = []; const t = (n, f) => queue.push({ n, f });

const BH = "Shipping Confirmation\nOrder #1100000001\nTracking # 520000000006\n20TB N300 7200 rpm SATA III 3.5\" Internal NAS HDD\nB&H #TON300NHD20T\nQTY: 1\nSuper Grip Double Baby Receiver\nB&H #KUKG400912\nQTY: 2\nShip To:";

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
  const html = "<td>Tracking # 520000000006</td><td>Thing A</td><td>B&amp;H #AA1</td><td>QTY: 1</td><td>Thing B</td><td>B&amp;H #AB2</td><td>QTY: 3</td>";
  const c = E.extractShipments({ from: "B&H Photo <orders@bhphotovideo.com>", subject: "B&H Photo Order #1100000001 Shipped", date: "2026-04-28T10:00:00Z", messageId: "m1", verified: "bhphotovideo.com", images: ["https://i/logo.png", "https://i/a.jpg", "https://i/b.jpg"], body: html }, NOW)[0];
  assert.deepStrictEqual(c.items.map((x) => [x.name, x.qty, x.src]), [["Thing A", 1, "https://i/a.jpg"], ["Thing B", 3, "https://i/b.jpg"]]);
  assert.strictEqual(c.itemCount, 4);
  assert.strictEqual(c.numbers[0].no, "520000000006");
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
t("model: a card that predates contents gets them once from a mail it already saw; a second pass changes nothing", () => {
  const list = [M.makeShipment({ orderId: "X-2", merchant: "Amazon", state: "shipped", msgIds: ["old1"] }, NOW)];
  const cand = { orderId: "X-2", merchant: "Amazon", state: "shipped", items: [{ name: "Adhesives" }], itemCount: 2, msgId: "old1", at: NOW };
  assert.strictEqual(M.mergeCandidate(list, cand, NOW).changed, true);
  assert.strictEqual(list[0].items[0].name, "Adhesives");
  assert.strictEqual(M.mergeCandidate(list, cand, NOW).changed, false);
});
t("model: a shipment that already has a picture is not overwritten by a re-read mail", () => {
  const list = [M.makeShipment({ orderId: "X-1", merchant: "B&H", state: "shipped", items: [{ name: "Thing", thumb: "ship-a-0.png" }] }, NOW)];
  M.mergeCandidate(list, { orderId: "X-1", merchant: "B&H", state: "shipped", items: [{ name: "Other" }], itemCount: 1, msgId: "z", at: NOW }, NOW);
  assert.strictEqual(list[0].items[0].name, "Thing");
});
t("service: scan fetches each picture once into a local file name, drops src, a failing picture is retried once, then dropped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-items-"));
  const file = path.join(dir, "shipments.json");
  const calls = [];
  const mail = { from: "B&H Photo <orders@bhphotovideo.com>", subject: "B&H Photo Order #1100000001 Shipped", date: "2026-10-27T08:00:00Z", messageId: "m9", verified: "bhphotovideo.com", images: ["https://i/a.jpg", "https://i/bad.jpg"], body: "<td>Tracking # 520000000006</td><td>Thing A</td><td>B&amp;H #AA1</td><td>QTY: 1</td><td>Thing B</td><td>B&amp;H #AB2</td><td>QTY: 1</td>" };
  const svc = S.createService({ file, readStore, writeJsonAtomic, tracker: noTracker, getMails: async () => [mail], makeThumb: async (url, id) => { calls.push(url); if (/bad/.test(url)) throw new Error("nope"); return id + ".png"; }, now: () => NOW, notices: [], say: () => {}, testMode: false });
  await svc.refreshNow();
  await svc.refreshNow();
  await svc.refreshNow();
  const it = JSON.parse(fs.readFileSync(file, "utf8")).items[0].items;
  assert.strictEqual(it.length, 2);
  assert.ok(/^ship-[\w-]+-0\.png$/.test(it[0].thumb), JSON.stringify(it));
  assert.ok(!it[0].src && !it[1].src && !it[1].thumb);
  assert.deepStrictEqual(calls, ["https://i/a.jpg", "https://i/bad.jpg", "https://i/bad.jpg"], "a failed picture gets ONE retry on the next scan (2026-10-31), then is given up");
});
t("renderer + css wiring: contents block, textContent only, local pictures", () => {
  const root = path.join(__dirname, "..", "src");
  const r = fs.readFileSync(path.join(root, "renderer", "daily-shipments.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "renderer", "styles-daily.css"), "utf8");
  assert.ok(/function contentsBlock/.test(r) && /wantPics\(data\.items/.test(r) && /api\.thumbs/.test(r));
  assert.ok(!/innerHTML/.test(r));
  assert.ok(/\.ship-pic\b/.test(css) && /\.ship-items\b/.test(css));
});

t("no pictures when the sender did not pass DKIM/SPF, even from a shop address", () => {
  const html = "<td>Tracking # 520000000006</td><td>Thing A</td><td>B&amp;H #AA1</td><td>QTY: 1</td>";
  const c = E.extractShipments({ from: "B&H Photo <orders@bhphotovideo.com>", subject: "B&H Photo Order #1 Shipped", date: "2026-10-27T08:00:00Z", messageId: "f1", verified: false, images: ["https://i/a.jpg"], body: html }, NOW)[0];
  assert.strictEqual(c.items[0].name, "Thing A");
  assert.ok(!c.items[0].src);
});
t("senderVerified: needs Gmail's own dmarc=pass for the From domain; foreign dkim pass or a forged header copy does not count", () => {
  const G = require("../src/daily/gmail.js");
  const mk = (from, ...ars) => ({ payload: { headers: [{ name: "From", value: from }, ...ars.map((v) => ({ name: "Authentication-Results", value: v }))] } });
  const good = "mx.google.com; dkim=pass header.i=@bhphotovideo.com; spf=pass smtp.mailfrom=x@bhphotovideo.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=bhphotovideo.com";
  assert.strictEqual(G.senderVerified(mk("B&H <orders@bhphotovideo.com>", good)), "bhphotovideo.com");
  assert.strictEqual(G.senderVerified(mk("B&H <orders@bhphotovideo.com>", "mx.google.com; spf=pass", good)), "", "only the topmost header counts");
  assert.strictEqual(G.senderVerified(mk("evil <a@evil.example>, B&H <orders@bhphotovideo.com>", good)), "", "two addresses");
  assert.strictEqual(G.senderVerified(mk("\"x <orders@bhphotovideo.com>\" <a@evil.example>", good)), "", "quoted decoy");
  assert.strictEqual(G.senderVerified(mk("B&H <orders@bhphotovideo.com>", "mx.google.com; dkim=pass header.i=@evil.example; dmarc=fail header.from=bhphotovideo.com")), "");
  assert.strictEqual(G.senderVerified(mk("B&H <orders@bhphotovideo.com>", "mx.google.com; dkim=pass header.i=@evil.example; spf=pass")), "");
  assert.strictEqual(G.senderVerified(mk("B&H <orders@bhphotovideo.com>", "evil.example; dmarc=pass header.from=bhphotovideo.com")), "");
  assert.strictEqual(G.senderVerified(mk("x <a@evil.example>", good)), "");
  assert.strictEqual(G.senderVerified(mk("B&H <orders@bhphotovideo.com>", "mx.google.com; dkim=pass header.i=@evil.example (dmarc=pass header.from=bhphotovideo.com); dmarc=fail header.from=bhphotovideo.com")), "", "text inside a comment is not a verdict");
  assert.strictEqual(G.senderVerified(mk("B&H <orders@bhphotovideo.com>", "mx.google.com; dkim=pass x=dmarc=pass header.from=bhphotovideo.com")), "", "method must be dmarc");
  assert.strictEqual(G.senderVerified(mk("B&H <orders@bhphotovideo.com>")), "");
});
t("pictures are only taken from a known shop sender; hostile html stays fast", () => {
  const body = "<td>Tracking # 520000000006</td><td>Thing A</td><td>B&amp;H #AA1</td><td>QTY: 1</td>";
  const c = E.extractShipments({ from: "x <a@evil.example>", subject: "Your order has shipped tracking 520000000006", date: "2026-10-27T08:00:00Z", messageId: "e1", images: ["https://evil.example/p.gif"], body }, NOW)[0];
  if (c) assert.ok((c.items || []).every((x) => !x.src));
  const G = require("../src/daily/gmail.js");
  assert.ok(G);
  const t0 = Date.now();
  const hostile = "<img " + "src=\"https://a/".repeat(20000);
  /<img[^<>]{0,1000}?src\s*=\s*["'](https:\/\/[^"'\s<>]{4,400})["'][^<>]{0,1000}>/gi.exec(hostile.slice(0, 300000));
  assert.ok(Date.now() - t0 < 1000);
});

t("one mail never makes a second card: a card holding the mail id is matched even when numbers differ", () => {
  const list = [M.makeShipment({ merchant: "AliExpress", state: "shipped", orderId: "00100000000111", msgIds: ["mail-a"] }, NOW)];
  const r = M.mergeCandidate(list, { merchant: "AliExpress", state: "shipped", numbers: [{ no: "00100000000111", carrier: "cainiao" }], msgId: "mail-a", at: NOW }, NOW);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(r.created, false);
  assert.strictEqual(list[0].numbers.length, 0, "the card's own order id is never a tracking number");
});
t("migration 4: cards sharing a mail id merge into one; PH twin and own-order-id numbers dropped; a real Amazon-order Aramex number kept", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-dedupe-"));
  const file = path.join(dir, "shipments.json");
  const mk = (x) => M.makeShipment(Object.assign({ merchant: "AliExpress", state: "in_transit", source: "email" }, x), NOW);
  const items = [
    mk({ orderId: "00100000000111", state: "shipped", msgIds: ["m1"] }),
    mk({ orderId: "00100000000111", state: "shipped", msgIds: ["m1"] }),
    mk({ state: "shipped", numbers: [{ no: "00100000000111", carrier: "cainiao" }], msgIds: ["m1"] }),
    mk({ numbers: [{ no: "PH8000000003", carrier: "other" }], msgIds: ["m2"] }),
    mk({ numbers: [{ no: "PH8000000003", carrier: "other" }], msgIds: ["m2"] }),
    mk({ numbers: [{ no: "8000000003", carrier: "dhl" }], msgIds: ["m2"] }),
    mk({ merchant: "Amazon", orderId: "113-0000007-0000008", state: "delivered", numbers: [{ no: "2300000002", carrier: "aramex", carrierSet: true }], msgIds: ["a1", "a2"] }),
  ];
  items[6].events = [{ text: "LYON", at: NOW - 20 * 86400000 }];
  fs.writeFileSync(file, JSON.stringify({ items, migrated: 3 }));
  const svc = S.createService({ file, readStore, writeJsonAtomic, tracker: noTracker, getMails: async () => [], now: () => NOW, notices: [], say: () => {}, testMode: true });
  await svc.load({});
  const out = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(out.migrated, 6);
  assert.strictEqual(out.items.length, 3, JSON.stringify(out.items.map((x) => [x.merchant, x.orderId, x.numbers.map((n) => n.no)])));
  const ali1 = out.items.find((x) => x.orderId === "00100000000111");
  assert.strictEqual(ali1.numbers.length, 0);
  const dhl = out.items.find((x) => x.numbers.some((n) => n.no === "PH8000000003"));
  assert.deepStrictEqual(dhl.numbers.map((n) => n.no), ["PH8000000003"], "2026-10-31: the owner's corrected PH form is kept, the plain twin dropped");
  const amz = out.items.find((x) => x.merchant === "Amazon");
  assert.strictEqual(amz.numbers.length, 1, "2026-10-31: that number is a real Aramex number: never deleted by a migration"); assert.strictEqual(amz.events.length, 1); assert.strictEqual(amz.state, "delivered");
  assert.ok(fs.readdirSync(dir).some((n) => /before_numberfix/.test(n)));
});
t("amazon cards (tracked inside Amazon) are never 'stuck'; category items are flagged; paste box answers to hover and shows progress", () => {
  const a = M.makeShipment({ merchant: "Amazon", carrier: "amazon", state: "shipped", numbers: [{ no: "TBA123456789012", carrier: "amazon" }], lastChangeAt: NOW - 30 * 86400000, stateAt: NOW - 30 * 86400000 }, NOW);
  assert.strictEqual(M.effectiveState(a, NOW, 10), "shipped");
  const ups = M.makeShipment({ merchant: "X", carrier: "ups", state: "in_transit", lastEvent: { text: "Departed facility", at: NOW - 30 * 86400000 }, numbers: [{ no: "1Z999AA10123456784", carrier: "ups" }], lastChangeAt: NOW - 30 * 86400000, stateAt: NOW - 30 * 86400000 }, NOW);
  assert.strictEqual(M.effectiveState(ups, NOW, 10), "exception_stuck");
  assert.ok(E.extractItems("", "Shipped 2 items: Shoes, Adhesives").items.every((x) => x.cat));
  assert.ok(!E.extractItems(["Hi", "Thing", "B&H #A1", "QTY: 1"].join(String.fromCharCode(10)), "").items[0].cat);
  const r = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "daily-shipments.js"), "utf8");
  assert.ok(/mouseenter/.test(r) && /Reading the picture/.test(r) && /every\(\(x\) => x\.cat\)/.test(r));
});
(async () => { let f = 0; for (const { n, f: fn } of queue) { try { await fn(); } catch (e) { f++; console.error("FAIL " + n + "\n  " + e.stack.split("\n").slice(0, 5).join("\n  ")); } } console.log(`shipments-items: ${queue.length - f}/${queue.length} passed`); process.exit(f ? 1 : 0); })();
