// node tools/shipments-dryrun.js <scratch-dir> <shipments-file>...
// Dry run of the Shipments load path (migrations 1-5 + the duplicate check) on COPIES of store files. The inputs are only read; each is
// copied into <scratch-dir> and the service runs on the copy. Prints SHAPES only (counts, carrier ids, booleans): never a number, title,
// address or mail id. Exit code 1 when a number or an event was lost.
"use strict";
const fs = require("fs"), path = require("path");
const M = require("../src/daily/shipments-model");
const S = require("../src/daily/shipments-main");
const [scratch, ...inputs] = process.argv.slice(2);
if (!scratch || !inputs.length) { console.error("usage: node tools/shipments-dryrun.js <scratch-dir> <shipments-file>..."); process.exit(2); }
fs.mkdirSync(scratch, { recursive: true });
const readStore = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")); } catch (e) { return d; } };
const writeJsonAtomic = (f, o) => { fs.writeFileSync(f + ".tmp", JSON.stringify(o)); fs.renameSync(f + ".tmp", f); };
const shape = (items) => ({
  cards: items.length, open: items.filter((x) => !x.archived).length, archived: items.filter((x) => x.archived).length,
  numbers: items.reduce((a, x) => a + x.numbers.length, 0), events: items.reduce((a, x) => a + (x.events || []).length, 0),
  withItems: items.filter((x) => (x.items || []).length).length, split: items.filter((x) => x.split).length,
  carriers: items.reduce((a, x) => { x.numbers.forEach((n) => { a[n.carrier] = (a[n.carrier] || 0) + 1; }); return a; }, {}),
  sharedNumberOpenCards: (() => { const m = new Map(); items.filter((x) => !x.archived).forEach((x) => x.numbers.forEach((n) => m.set(n.no, (m.get(n.no) || 0) + 1))); return [...m.values()].filter((c) => c > 1).length; })(),
  sharedMailOpenCards: (() => { const m = new Map(); items.filter((x) => !x.archived).forEach((x) => (x.msgIds || []).forEach((i) => m.set(i, (m.get(i) || 0) + 1))); return [...m.values()].filter((c) => c > 1).length; })(),
});
let bad = false;
inputs.forEach((src, i) => {
  const copy = path.join(scratch, "copy" + i + "_" + path.basename(src).replace(/[^\w.]/g, "_"));
  fs.copyFileSync(src, copy);
  const raw = readStore(copy, { items: [] });
  const before = shape((raw.items || []).map((x) => M.makeShipment(x, Date.now())));
  const logs = [];
  const svc = S.createService({ file: copy, readStore, writeJsonAtomic, tracker: { keys: { get: () => "", has: () => false, set() {} }, hasLiveProvider: () => false, status: () => ({}) }, getMails: async () => [], notices: [], say: (m) => logs.push(m.replace(/\d{6,}/g, "#")) });
  const st = svc._loadStore();
  // the second pass proves the check is idempotent
  const inv = M.enforceInvariant(st.items.slice(), Date.now());
  const after = shape(st.items);
  // loss check: every number of the input (after the owner's known fixes) is still on some card, and no event vanished
  const keep = new Set(); st.items.forEach((x) => x.numbers.forEach((n) => keep.add(n.no)));
  const orderIds = new Set(st.items.map((x) => M.normNumber(x.orderId)).filter(Boolean));
  const lost = (raw.items || []).flatMap((x) => (x.numbers || []).map((n) => M.normNumber(n.no))).filter((no) => !keep.has(no) && !orderIds.has(no) && !keep.has(M.NUMBER_FIXES[no]) && !Object.values(M.NUMBER_FIXES).includes(no) && !(raw.items || []).some((o) => o.orderId && M.normNumber(o.orderId) === no)).length;
  const ev = (raw.items || []).reduce((a, x) => a + new Set((x.events || []).map((e) => e.at + "|" + e.text)).size, 0);
  console.log(JSON.stringify({ file: "input#" + i, migratedBefore: Number(raw.migrated) || 0, before, after, secondPassMerges: inv.merged, numbersLost: lost, eventsBefore: ev, eventsAfter: after.events, log: logs.slice(0, 4) }));
  if (lost || after.events < ev || inv.merged || after.sharedNumberOpenCards || after.sharedMailOpenCards) bad = true;
});
process.exit(bad ? 1 : 0);
