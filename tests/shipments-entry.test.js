// node tests/shipments-entry.test.js - 2026-10-27: order numbers are never tracking numbers, the one-shot migration, the manual
// entry flow (number / carrier / label / review tag), and the persisted per-number reason. Uses temp folders only, never the
// real daily\shipments.json and never a real key.
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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ship-entry-"));
const noSleep = () => Promise.resolve();
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

// minimal store helpers equal to main-daily's readStore / writeJsonAtomic
const readStore = (file, def) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return def; } };
const writeJsonAtomic = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + ".tmp", JSON.stringify(obj)); fs.renameSync(file + ".tmp", file); };

function fake17(handler) {
  const calls = [];
  const request = async (method, url, opts) => { const body = JSON.parse(opts.body); const ep = url.split("/").pop(); calls.push({ ep, body, key: opts.headers["17token"] }); return handler(ep, body); };
  return { request, calls };
}
const ok = (data) => ({ status: 200, json: { code: 0, data } });
const notFoundAll = (ep, body) => ok(ep === "register" ? { accepted: body.map((b) => ({ number: b.number })), rejected: [] }
  : ep === "gettrackinfo" ? { accepted: body.map((b) => ({ number: b.number, track_info: { latest_status: { status: "NotFound", sub_status: "NotFound_Other" }, tracking: { providers: [] } } })), rejected: [] }
  : { accepted: body.map((b) => ({ number: b.number })), rejected: [] });

function service(handler, opts) {
  const dir = tmp();
  const file = path.join(dir, "shipments.json");
  if (opts && opts.seed) fs.writeFileSync(file, JSON.stringify(opts.seed));
  const f = fake17(handler || notFoundAll);
  const tr = T.createTracker({ dataDir: tmp(), safeStorage: fakeSafe, request: f.request, sleep: noSleep });
  if (!opts || opts.key !== false) tr.keys.set("17track", SECRET);
  const logs = [];
  let now = NOW;
  const svc = S.createService({ file, readStore, writeJsonAtomic, tracker: tr, getMails: async () => (opts && opts.mails) || [], now: () => now, notices: [], say: (m) => logs.push(m) });
  return { svc, file, dir, calls: f.calls, logs, tr, setNow: (n) => { now = n; } };
}
const raw = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// ------------------------------------------------------------------ parser
const aliMail = (extra) => Object.assign({
  from: "AliExpress <transaction@notice.aliexpress.com>", subject: "Your order 1123450589717403 has shipped", date: "2026-10-20T08:00:00Z", messageId: "<ali1>",
  body: "Hi, your order has shipped.\nOrder number: 1123450589717403\nProduct: SD card reader\nEstimated delivery: 30 Nov 2026",
}, extra || {});

t("parser: an AliExpress mail with only an ORDER number gives a parcel with no tracking number", () => {
  const c = E.extractShipments(aliMail(), NOW);
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual(c[0].numbers, []);
  assert.strictEqual(c[0].orderId, "1123450589717403");
  assert.strictEqual(c[0].merchant, "AliExpress");
});
t("parser: 'Order ID' / Hebrew order labels and the order number in the subject are not picked up", () => {
  const c1 = E.extractShipments(aliMail({ subject: "Shipment update for order 1123450589717403", body: "Order ID: 1123450589717403\nYour parcel is on its way." }), NOW);
  assert.deepStrictEqual(c1[0].numbers, []);
  const c2 = E.extractShipments(aliMail({ body: "×”×–×ž× ×” ×ž×¡×¤×¨: 00100086960111\n×”×—×‘×™×œ×” ×‘×“×¨×š ××œ×™×š" }), NOW);
  assert.ok(!c2.length || c2[0].numbers.length === 0);
});
t("parser: the real LP number in the same mail is still found, the order number is not", () => {
  const c = E.extractShipments(aliMail({ body: "Order number: 1123450589717403\nTracking number: LP00123456789012345678\nProduct: SD card reader" }), NOW);
  assert.deepStrictEqual(c[0].numbers.map((n) => n.no), ["LP00123456789012345678"]);
  assert.strictEqual(c[0].numbers[0].carrier, "cainiao");
  assert.strictEqual(c[0].orderId, "1123450589717403");
});
t("parser: a shop mail (not a carrier) never yields a bare unlabelled DHL/FedEx-looking digit run", () => {
  const c = E.extractShipments({ from: "Shop <orders@iherb.com>", subject: "Your package from DHL is on its way", date: "2026-10-20T08:00:00Z", messageId: "<h1>", body: "Your package ships via DHL.\nReference 8004100921 for support." }, NOW);
  assert.ok(!c.length || c[0].numbers.length === 0);
});
t("parser: a DHL mail from DHL itself with a bare number still works (no regression)", () => {
  const c = E.extractShipments({ from: "DHL <noreply@dhl.com>", subject: "Your DHL shipment is on its way", date: "2026-10-20T08:00:00Z", messageId: "<d1>", body: "Waybill 1234567890 is out." }, NOW);
  assert.deepStrictEqual(c[0].numbers.map((n) => n.no), ["1234567890"]);
});
t("looksLikeOrderNumber: AliExpress 16 digits, Amazon 3-7-7 (with and without dashes); real formats are not", () => {
  for (const v of ["1123450589717403", "114-1234567-1234567", "11412345671234567"]) assert.strictEqual(M.looksLikeOrderNumber(v), true, v);
  for (const v of ["LP00123456789012345678", "RR123456789IL", "1Z999AA10123456784", "878247853307", "TBA123456789012", "PH8004100921"]) assert.strictEqual(M.looksLikeOrderNumber(v), false, v);
});

// ------------------------------------------------------------------ migration
const seedItems = () => [
  { id: "a1", merchant: "AliExpress", carrier: "cainiao", numbers: [{ no: "1123450589717403", carrier: "cainiao" }], state: "shipped", source: "email", msgIds: ["<ali1>"] },
  { id: "a2", merchant: "AliExpress", carrier: "cainiao", numbers: [{ no: "00100086960111", carrier: "cainiao" }], state: "shipped", source: "email" },
  { id: "d1", merchant: "DHL", carrier: "dhl", numbers: [{ no: "8004100921", carrier: "dhl" }], state: "in_transit", source: "email" },
  { id: "ok1", merchant: "AliExpress", carrier: "cainiao", numbers: [{ no: "LP00123456789012345678", carrier: "cainiao" }], state: "in_transit", source: "email" },
  { id: "ok2", merchant: "FedEx", carrier: "fedex", numbers: [{ no: "878247853307", carrier: "fedex" }], state: "in_transit", source: "email" },
  { id: "man", merchant: "", carrier: "other", numbers: [{ no: "ABC1234567", carrier: "other" }], state: "shipped", source: "manual" },
];
t("migration (pure): order numbers move to orderId, DHL fix applied, real numbers kept, idempotent", () => {
  const list = seedItems().map((x) => M.makeShipment(x, NOW));
  const r1 = M.migrateWrongNumbers(list, NOW);
  assert.strictEqual(r1.changed, true);
  const by = (id) => list.find((x) => x.id === id);
  assert.deepStrictEqual(by("a1").numbers, []); assert.strictEqual(by("a1").orderId, "1123450589717403");
  assert.deepStrictEqual(by("a2").numbers, []); assert.strictEqual(by("a2").orderId, "00100086960111");
  assert.deepStrictEqual(by("d1").numbers.map((n) => n.no), ["PH8004100921"]);
  assert.deepStrictEqual(by("ok1").numbers.map((n) => n.no), ["LP00123456789012345678"]);
  assert.deepStrictEqual(by("ok2").numbers.map((n) => n.no), ["878247853307"]);
  assert.deepStrictEqual(by("man").numbers.map((n) => n.no), ["ABC1234567"]);
  assert.strictEqual(M.needsNumber(by("a1")), true);
  const again = M.migrateWrongNumbers(list, NOW + 1);
  assert.strictEqual(again.changed, false);
});
t("migration (service): backs up shipments.json first, writes once, flag set, second load does nothing", async () => {
  const { svc, file, dir } = service(null, { seed: { version: 1, items: seedItems(), scannedAt: 0, polledAt: 0 }, key: false });
  const before = fs.readFileSync(file, "utf8");
  const v = await svc.load({});
  const baks = fs.readdirSync(dir).filter((f) => /\.bak_.*_before_numberfix$/.test(f));
  assert.strictEqual(baks.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, baks[0]), "utf8"), before, "backup is the untouched original");
  const saved = raw(file);
  assert.strictEqual(saved.migrated, 3);
  assert.deepStrictEqual(v.items.find((x) => x.id === "a1").numbers, []);
  assert.strictEqual(v.items.find((x) => x.id === "a1").needsNumber, true);
  await svc.load({});
  assert.strictEqual(fs.readdirSync(dir).filter((f) => /_before_numberfix$/.test(f)).length, 1, "no second backup");
});
t("migration (service): a failed backup writes nothing and is retried", async () => {
  const { svc, file, dir } = service(null, { seed: { version: 1, items: seedItems() }, key: false });
  const orig = fs.copyFileSync;
  fs.copyFileSync = () => { throw new Error("disk full"); };
  const before = fs.readFileSync(file, "utf8");
  try { await svc._loadStore(); } finally { fs.copyFileSync = orig; }
  assert.strictEqual(fs.readFileSync(file, "utf8"), before);
  await svc.load({});
  assert.strictEqual(raw(file).migrated, 3);
});
t("a later mail with the real number for the same order fills the empty parcel (matched by order id)", () => {
  const list = [M.makeShipment({ id: "p", merchant: "AliExpress", orderId: "1123450589717403", numbers: [], state: "shipped", msgIds: ["<ali1>"] }, NOW)];
  const c = E.extractShipments(aliMail({ messageId: "<ali2>", subject: "Your parcel has a tracking number", body: "Order number: 1123450589717403\nTracking number: LP00123456789012345678" }), NOW);
  const r = M.mergeCandidate(list, c[0], NOW);
  assert.strictEqual(r.created, false);
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0].numbers.map((n) => n.no), ["LP00123456789012345678"]);
});

// ------------------------------------------------------------------ manual entry
t("add: only the number is required; label, carrier and review tag are optional and stored", async () => {
  const { svc } = service(null, { key: false });
  const r1 = await svc.op({ op: "add", text: "RR123456789IL" });
  assert.strictEqual(r1.ok, true);
  const r2 = await svc.op({ op: "add", text: "ABC98765432", label: "Lens from Dana", carrier: "fedex", review: true });
  assert.strictEqual(r2.ok, true);
  const v = await svc.load({});
  const a = v.items.find((x) => x.id === r1.id), b = v.items.find((x) => x.id === r2.id);
  assert.strictEqual(a.carrier, "israelpost"); assert.strictEqual(a.review, false);
  assert.strictEqual(b.title, "Lens from Dana"); assert.strictEqual(b.review, true); assert.strictEqual(b.carrier, "fedex");
  assert.strictEqual(b.numbers[0].carrier, "fedex");
  assert.ok(Array.isArray(v.carriers) && v.carriers.some((c) => c.id === "fedex") && !v.carriers.some((c) => c.id === "other"));
});
t("add: an order number is refused with an explanation; junk is refused", async () => {
  const { svc } = service(null, { key: false });
  const r = await svc.op({ op: "add", text: "1123450589717403" });
  assert.strictEqual(r.ok, false); assert.ok(/order number/i.test(r.reason));
  assert.strictEqual((await svc.op({ op: "add", text: "114-1234567-1234567" })).ok, false);
  assert.strictEqual((await svc.op({ op: "add", text: "hi" })).ok, false);
});
t("add-number: attaches to the chosen parcel (the old code lost it), detects the carrier, refuses order numbers and numbers on another parcel", async () => {
  const { svc } = service(null, { seed: { version: 1, migrated: 2, items: [
    { id: "p1", merchant: "AliExpress", orderId: "1123450589717403", title: "SD reader", numbers: [], state: "ordered", source: "email" },
    { id: "p2", merchant: "B&H", numbers: [{ no: "1Z999AA10123456784", carrier: "ups" }], state: "in_transit", source: "email" },
  ] }, key: false });
  assert.strictEqual((await svc.op({ op: "add-number", id: "p1", text: "1123450589717403" })).ok, false);
  const dup = await svc.op({ op: "add-number", id: "p1", text: "1Z999AA10123456784" });
  assert.strictEqual(dup.ok, false); assert.ok(/already on another parcel/.test(dup.reason));
  const good = await svc.op({ op: "add-number", id: "p1", text: "LP00123456789012345678" });
  assert.strictEqual(good.ok, true);
  const v = await svc.load({});
  const p1 = v.items.find((x) => x.id === "p1");
  assert.deepStrictEqual(p1.numbers.map((n) => n.no), ["LP00123456789012345678"]);
  assert.strictEqual(p1.carrier, "cainiao"); assert.strictEqual(p1.needsNumber, false); assert.strictEqual(p1.state, "shipped");
  const p3 = await svc.op({ op: "add-number", id: "p1", text: "ZZ77665544", carrier: "aramex" });
  assert.strictEqual(p3.ok, true);
  assert.strictEqual((await svc.load({})).items.find((x) => x.id === "p1").numbers.find((n) => n.no === "ZZ77665544").carrier, "aramex");
});

// ------------------------------------------------------------------ persisted reasons
t("reason: 'not found' is persisted per number and shown in the view; 'waiting' for a number younger than a day", async () => {
  const s = service(notFoundAll);
  const r = await s.svc.op({ op: "add", text: "ABC98765432" });
  assert.strictEqual(r.ok, true);
  let v = await s.svc.load({});
  let it = v.items.find((x) => x.id === r.id);
  assert.strictEqual(it.numbers[0].reason, "waiting");
  assert.ok(/first scan/i.test(it.reason.text));
  assert.strictEqual(it.cantTrack, false);
  assert.strictEqual(raw(s.file).items[0].numbers[0].reason, "waiting", "persisted in the file");
  s.setNow(NOW + 3 * DAY);
  v = await s.svc.refreshNow();
  it = v.items.find((x) => x.id === r.id);
  assert.strictEqual(it.reason.reason, "not_found");
  assert.strictEqual(it.cantTrack, true);
  assert.ok(/order number/.test(it.reason.text));
  assert.strictEqual(raw(s.file).items[0].numbers[0].reason, "not_found");
});
t("reason: key refused (401), quota used up, rejected, rate limited are each classified and persisted", async () => {
  const cases = [
    [() => ({ status: 401, json: null }), "key_refused"],
    [(ep, body) => (ep === "register" ? ok({ accepted: [], rejected: body.map((b) => ({ number: b.number, error: { code: -18019909, message: "Insufficient quota" } })) }) : ok({ accepted: [], rejected: [] })), "quota"],
    [(ep, body) => (ep === "register" ? ok({ accepted: [], rejected: body.map((b) => ({ number: b.number, error: { code: -18019901, message: "The carrier could not be detected" } })) }) : ok({ accepted: [], rejected: body.map((b) => ({ number: b.number, error: { code: -18010013, message: "not registered" } })) })), "rejected"],
    [() => ({ status: 429, json: null }), "rate"],
  ];
  for (const [handler, want] of cases) {
    const s = service(handler);
    const r = await s.svc.op({ op: "add", text: "ABC98765432" });
    const v = await s.svc.load({});
    const it = v.items.find((x) => x.id === r.id);
    assert.strictEqual(it.numbers[0].reason, want, want + " got " + it.numbers[0].reason + " / " + JSON.stringify(it.numbers[0]));
    assert.ok(it.numbers[0].reasonText.length > 10);
    assert.ok(!JSON.stringify(v).includes(SECRET) && !fs.readFileSync(s.file, "utf8").includes(SECRET));
  }
});
t("reason: cleared as soon as events arrive", async () => {
  let n = 0;
  const handler = (ep, body) => (ep === "gettrackinfo" && ++n > 1
    ? ok({ accepted: body.map((b) => ({ number: b.number, track_info: { latest_status: { status: "InTransit" }, tracking: { providers: [{ events: [{ time_iso: "2026-10-27T08:00:00Z", description: "Departed", location: "HK" }] }] } } })), rejected: [] })
    : notFoundAll(ep, body));
  const s = service(handler);
  const r = await s.svc.op({ op: "add", text: "ABC98765432" });
  assert.strictEqual(raw(s.file).items[0].numbers[0].reason, "waiting");
  await s.svc.refreshNow();
  const n0 = raw(s.file).items[0].numbers[0];
  assert.strictEqual(n0.reason, undefined);
  assert.strictEqual(raw(s.file).items[0].lastEvent.text, "Departed");
});
t("classifyReason: plain unit cases", () => {
  assert.strictEqual(T.classifyReason("the tracking key was refused").reason, "key_refused");
  assert.strictEqual(T.classifyReason("", { status: "NotFound", sub: "NotFound_InvalidCode" }, 5 * DAY).reason, "invalid");
  assert.strictEqual(T.classifyReason("", { status: "NotFound", sub: "NotFound_Other" }, 5 * DAY).reason, "not_found");
  assert.strictEqual(T.classifyReason("", null, 0).reason, "waiting");
  assert.strictEqual(T.classifyReason("boom").reason, "error");
});

// ------------------------------------------------------------------ carrier set later -> re-register
t("set-carrier: marks the number as owner-chosen, calls changecarrier with the 17TRACK code, then clears the request", async () => {
  const s = service(notFoundAll);
  const r = await s.svc.op({ op: "add", text: "ABC98765432" });
  s.calls.length = 0;
  const sc = await s.svc.op({ op: "set-carrier", id: r.id, carrier: "aramex" });
  assert.strictEqual(sc.ok, true);
  const eps = s.calls.map((c) => c.ep);
  assert.deepStrictEqual(eps.slice(0, 3), ["changecarrier", "register", "gettrackinfo"]);
  assert.deepStrictEqual(s.calls[0].body, [{ number: "ABC98765432", carrier_new: 100004 }]);
  assert.strictEqual(s.calls[1].body[0].carrier, 100004);
  const n = raw(s.file).items[0].numbers[0];
  assert.strictEqual(n.carrier, "aramex"); assert.strictEqual(n.carrierSet, true); assert.strictEqual(n.recarrier, undefined);
  assert.ok(s.calls.every((c) => c.key === SECRET), "the key only travels in the header to 17TRACK");
});
t("set-carrier: when changecarrier is refused the number is deleted and registered again; auto-detect deletes and registers without a carrier", async () => {
  const handler = (ep, body) => (ep === "changecarrier" ? ok({ accepted: [], rejected: body.map((b) => ({ number: b.number, error: { code: -1, message: "not allowed" } })) }) : notFoundAll(ep, body));
  const s = service(handler);
  const r = await s.svc.op({ op: "add", text: "ABC98765432" });
  s.calls.length = 0;
  await s.svc.op({ op: "set-carrier", id: r.id, carrier: "aramex" });
  assert.deepStrictEqual(s.calls.map((c) => c.ep).slice(0, 4), ["changecarrier", "deletetrack", "register", "gettrackinfo"]);
  s.calls.length = 0;
  await s.svc.op({ op: "set-carrier", id: r.id, carrier: "auto" });
  assert.deepStrictEqual(s.calls.map((c) => c.ep).slice(0, 3), ["deletetrack", "register", "gettrackinfo"]);
  assert.strictEqual(s.calls[1].body[0].carrier, undefined);
});
t("set-carrier: a refused key keeps the request for the next poll", async () => {
  const s = service(() => ({ status: 401, json: null }));
  const r = await s.svc.op({ op: "add", text: "ABC98765432" });
  await s.svc.op({ op: "set-carrier", id: r.id, carrier: "aramex" });
  const n = raw(s.file).items[0].numbers[0];
  assert.strictEqual(n.recarrier, true);
  assert.strictEqual(n.reason, "key_refused");
});
t("review tag can be switched on and off", async () => {
  const { svc } = service(null, { key: false });
  const r = await svc.op({ op: "add", text: "RR123456789IL" });
  await svc.op({ op: "review", id: r.id, on: true });
  assert.strictEqual((await svc.load({})).items[0].review, true);
  await svc.op({ op: "review", id: r.id, on: false });
  assert.strictEqual((await svc.load({})).items[0].review, false);
});

// ------------------------------------------------------------------ renderer guards
t("renderer: the new boxes and wording exist and still use textContent only", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "daily-shipments.js"), "utf8");
  for (const s of ["Can't track this package yet - ask the sender which carrier they use", "Review sample", "Which order is this?", "numberBox", "carrierBox", "reasonLine", "Carrier: auto-detect", "add-number", "set-carrier"]) assert.ok(src.includes(s), s);
  assert.ok(!/No live tracking yet - state comes from the email/.test(src), "the generic line is gone");
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "eval("]) assert.ok(!src.includes(bad), bad);
});

t("renderer smoke (fake DOM): cards for needs-number, can't-track and reason states render, and add form builds, without throwing", () => {
  const vm = require("vm");
  const mkNode = (tag) => { const n = { tag, children: [], cls: "", textContent: "", attrs: {}, handlers: {}, value: "", checked: false,
    append(...k) { for (const x of k) n.children.push(typeof x === "string" ? { tag: "#text", textContent: x, children: [] } : x); },
    setAttribute(k, v) { n.attrs[k] = v; }, addEventListener(e, f) { n.handlers[e] = f; }, focus() {} }; Object.defineProperty(n, "className", { get: () => n.cls, set: (v) => { n.cls = v; } }); return n; };
  const doc = { createElement: mkNode, createTextNode: (x) => ({ tag: "#text", textContent: x, children: [] }) };
  const win = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "daily-shipments.js"), "utf8"), { window: win, document: doc, console, setTimeout: () => 0, Date });
  const el = (tag, cls, text) => { const n = mkNode(tag); n.cls = cls || ""; if (text != null) n.textContent = text; return n; };
  const btn = (label, cls, fn) => { const n = el("button", cls, label); n.handlers.click = fn; return n; };
  const base = { id: "x", numbers: [], carrier: "other", carrierName: "Other / unknown", effective: "shipped", state: "shipped", source: "email", events: [], lastEvent: null, archived: false, review: false, action: "", orderAt: NOW, merchant: "AliExpress" };
  const items = [
    Object.assign({}, base, { id: "n1", needsNumber: true, orderId: "1123450589717403", title: "SD reader", review: true }),
    Object.assign({}, base, { id: "c1", needsNumber: false, cantTrack: true, numbers: [{ no: "ABC98765432", carrier: "other", carrierName: "Other" }], reason: { reason: "not_found", text: "17TRACK cannot find this number." } }),
    Object.assign({}, base, { id: "w1", needsNumber: false, numbers: [{ no: "RR123456789IL", carrier: "israelpost", carrierName: "Israel Post" }], reason: { reason: "quota", text: "The 17TRACK quota is used up, so this number cannot be tracked." } }),
  ];
  const data = { ok: true, now: NOW, items, carriers: [{ id: "fedex", name: "FedEx" }], provider: { live: true, has17: true, polledAt: NOW, scannedAt: NOW, lastError: "" }, counts: { needs: 0 } };
  const ops = [];
  const ctx = { el, btn, say: () => {}, copyText: () => {}, api: { shipmentsLoad: async () => data, shipmentsRefresh: async () => data, shipmentsOp: async (a) => { ops.push(a); return { ok: true }; } }, rerender: () => {}, isActive: () => true, emptyState: () => el("div") };
  const tab = win.dailyShipments.create(ctx);
  tab.render();                                  // first call triggers the load
  return Promise.resolve().then(() => new Promise((r) => setImmediate(r))).then(() => {
    const out = tab.render();
    const texts = []; (function walk(n) { if (n.textContent) texts.push(n.textContent); (n.children || []).forEach(walk); })(out);
    const all = texts.join("\n");
    assert.ok(/Review sample/.test(all), "review chip");
    assert.ok(/No tracking number yet/.test(all) && /Tracking number for: AliExpress/.test(all), "needs-number box");
    assert.ok(/Can't track this package yet - ask the sender which carrier they use/.test(all), "cant-track text");
    assert.ok(/Set carrier/.test(all) && /Save number/.test(all));
    assert.ok(/quota is used up/.test(all), "reason line");
    assert.ok(!/state comes from the email/.test(all));
    // open the Add form and type a number: the "which order is this?" helper lists the parcel that waits for a number
    const find = (n, f) => { if (f(n)) return n; for (const k of n.children || []) { const r = find(k, f); if (r) return r; } return null; };
    find(out, (n) => n.textContent === "+ Add shipment" && n.handlers.click).handlers.click();
    const form = find(tab.render(), (n) => /ship-addcard/.test(n.cls));
    assert.ok(form, "add form");
    const inputs = []; (function w(n) { if (n.tag === "input") inputs.push(n); (n.children || []).forEach(w); })(form);
    assert.ok(inputs.length >= 3, "number, label, review checkbox");
    inputs[0].value = "LP00123456789012345678"; inputs[0].handlers.input();
    const pickTxt = []; (function w(n) { if (n.textContent) pickTxt.push(n.textContent); (n.children || []).forEach(w); })(find(form, (n) => /ship-pick$/.test(n.cls)));
    assert.ok(/Which order is this\?/.test(pickTxt.join("|")) && /1123450589717403/.test(pickTxt.join("|")));
  });
});

(async () => {
  let n = 0, fails = 0;
  for (const { name, fn } of queue) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.stack.split("\n").slice(0, 5).join("\n  ")); } }
  console.log(`shipments-entry: ${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
})();
