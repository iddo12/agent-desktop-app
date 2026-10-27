// node tests/shipments-split.test.js - one order, two shipments (Amazon split). Temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const M = require("../src/daily/shipments-model");
const S = require("../src/daily/shipments-main");
const NOW = Date.parse("2026-10-27T10:00:00Z");
const readStore = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const writeJsonAtomic = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(o)); fs.renameSync(f + ".tmp", f); };
const noTracker = { keys: { get: () => "", has: () => false, set() {} }, call: async () => ({ ok: false }) };
const queue = []; const t = (n, f) => queue.push({ n, f });
const ORDER = "113-6007992-3663405";

t("model: split order never merges a different number by order id; unsplit order still does", () => {
  const list = [];
  const a = M.mergeCandidate(list, { orderId: ORDER, merchant: "Amazon", title: "Amazon", at: NOW }, NOW).shipment;
  M.mergeCandidate(list, { orderId: ORDER, merchant: "Amazon", numbers: [{ no: "TBA111111111111", carrier: "amazon" }], at: NOW }, NOW);
  assert.strictEqual(list.length, 1, "unsplit: number joins the order card");
  a.split = true;
  const r = M.mergeCandidate(list, { orderId: ORDER, merchant: "Amazon", numbers: [{ no: "TBA222222222222", carrier: "amazon" }], at: NOW }, NOW);
  assert.ok(r.created && list.length === 2, "split: a different number is a new parcel");
  const r2 = M.mergeCandidate(list, { numbers: [{ no: "TBA111111111111", carrier: "amazon" }], at: NOW }, NOW);
  assert.strictEqual(r2.shipment, a, "same number still matches");
});

t("model: a mail carrying the same number as an existing sibling does not create another card", () => {
  const list = [];
  const a = M.mergeCandidate(list, { orderId: ORDER, merchant: "Amazon", numbers: [{ no: "TBA111111111111", carrier: "amazon" }], at: NOW }, NOW).shipment;
  a.split = true;
  const b = M.mergeCandidate(list, { orderId: ORDER, merchant: "Amazon", numbers: [{ no: "TBA222222222222", carrier: "amazon" }], at: NOW }, NOW).shipment;
  const r = M.mergeCandidate(list, { orderId: ORDER, merchant: "Amazon", numbers: [{ no: "TBA222222222222", carrier: "amazon" }], at: NOW + 1000 }, NOW + 1000);
  assert.ok(!r.created && r.shipment === b && list.length === 2);
});

t("op split: adds a numberless sibling with the same order, and marks both split", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ship-split-")), "shipments.json");
  const seed = { items: [M.makeShipment({ orderId: ORDER, merchant: "Amazon", title: "Amazon", state: "shipped", source: "email" }, NOW)] };
  fs.writeFileSync(file, JSON.stringify(seed));
  const svc = S.createService({ file, readStore, writeJsonAtomic, tracker: noTracker, getMails: async () => [], now: () => NOW, notices: [], say: () => {} });
  const id = seed.items[0].id;
  const r = await svc.op({ op: "split", id });
  assert.ok(r.ok && r.id && r.id !== id);
  const items = JSON.parse(fs.readFileSync(file, "utf8")).items;
  assert.strictEqual(items.length, 2);
  assert.ok(items.every((x) => x.split === true && x.orderId === ORDER && x.merchant === "Amazon"));
  assert.strictEqual(items.find((x) => x.id === r.id).numbers.length, 0);
  const bad = await svc.op({ op: "split", id: "nope" });
  assert.strictEqual(bad.ok, false);
});

(async () => { let f = 0; for (const { n, f: fn } of queue) { try { await fn(); } catch (e) { f++; console.error("FAIL " + n + "\n  " + e.stack.split("\n").slice(0, 5).join("\n  ")); } } console.log(`shipments-split: ${queue.length - f}/${queue.length} passed`); process.exit(f ? 1 : 0); })();
