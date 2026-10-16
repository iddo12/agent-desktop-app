// node tests/finance.test.js - MY FINANCE skeleton (v1.90.0): vault location (never Dropbox / any cloud folder / the app, checked on the
// REAL location: junctions, 8.3 names, \\?\, UNC, the default dir), the synthetic ledger (clearly fake, deterministic, card lumps counted
// once), the service numbers (same-days comparison for a running month), demo create/remove safety (archive, never delete; markers on every
// line), the ledger cache, prototype-named ids, the generic CSV preview (Hebrew headers, title lines, debit/credit, Windows-1255, UTF-16,
// hostile files: huge lines, wide files, many files, event loop never blocked for long), the IPC allow-list and guards (incl. a log-leak
// test that can fail), prefs safety, and the static privacy / lightness / design guards. Writes only into temp folders.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const SV = require("../src/finance/service");
const SY = require("../src/finance/synthetic");
const CSV = require("../src/finance/csv");
const VA = require("../src/finance/vault");
const MF = require("../src/finance/main-finance");

let n = 0, fails = 0; const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const SRC = path.join(__dirname, "..", "src");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "finance-test-"));
const NOW = new Date(2026, 9, 8, 12, 0, 0);
const svc = (ud, extra) => SV.createService(Object.assign({ userData: ud, testMode: true, env: {}, now: () => NOW }, extra || {}));
const ledgerPath = (ud) => path.join(ud, "finance-vault", "db", "ledger.json");
const junction = (link, target) => { const r = cp.spawnSync("cmd", ["/d", "/c", "mklink", "/J", link, target], { encoding: "utf8" }); return r.status === 0; };
function shortName(p) {   // the 8.3 alias of an existing folder, or null when 8.3 names are off on this volume
  const r = cp.spawnSync("cmd", ["/d", "/s", "/c", "\"for %I in (\"" + p + "\") do @echo %~sI\""], { encoding: "utf8", windowsVerbatimArguments: true });
  const s = (r.stdout || "").trim();
  return s && s.toLowerCase() !== p.toLowerCase() && /~\d/.test(s) ? s : null;
}

// ------------------------------------------------------------------ vault location (review B1)
t("vault: test mode defaults under userData; env and the prefs setting win when safe", () => {
  const ud = tmp();
  assert.strictEqual(SV.resolveVault({ userData: ud, testMode: true, env: {} }).dir, path.join(ud, "finance-vault"));
  const live = SV.resolveVault({ userData: ud, testMode: false, env: {}, defaultDir: "C:\\Example\\Scratch\\Finance\\vault" });
  assert.strictEqual(live.dir, "C:\\Example\\Scratch\\Finance\\vault", "the report's vault outside Dropbox");
  const other = path.join(ud, "elsewhere");
  const e = SV.resolveVault({ userData: ud, testMode: true, env: { AGENT_DESKTOP_FINANCE_DIR: other } });
  assert.deepStrictEqual([e.dir, e.from], [other, "env"]);
  fs.writeFileSync(path.join(ud, "finance_prefs.json"), "\uFEFF" + JSON.stringify({ vaultDir: other }));
  assert.strictEqual(SV.resolveVault({ userData: ud, testMode: true, env: {} }).from, "setting");
  assert.strictEqual(SV.DEFAULT_VAULT, undefined, "no built-in vault folder");
  const ud2 = tmp();
  assert.strictEqual(SV.resolveVault({ userData: ud2, testMode: false, env: {}, defaultDir: () => null }).dir, path.join(ud2, "finance-vault"), "nothing configured: the app folder");
  assert.strictEqual(SV.resolveVault({ userData: ud2, testMode: false, env: {}, defaultDir: () => "C:\\Example\\Scratch\\Finance\\vault" }).dir, "C:\\Example\\Scratch\\Finance\\vault", "a function is read per call");
});
t("vault: every lexical bypass from the review is refused (Dropbox (x), My Drive, Box, OneDrive - x, pCloud, Sync, \\\\?\\ into the app, UNC, relative)", () => {
  const ud = tmp(), app = path.join(ud, "app"); fs.mkdirSync(app);
  const bad = ["D:\\Dropbox (Personal)\\money", "D:\\Dropbox (Acmeco)\\money", "D:\\dropbox\\x", "D:/Dropbox/x", "\\\\?\\D:\\Dropbox\\x", "G:\\My Drive\\money",
    "C:\\Users\\Alex\\Box\\money", "C:\\Users\\Alex\\OneDrive - Home\\money", "C:\\Users\\x\\Google Drive\\f", "P:\\pCloud Drive\\m", "C:\\Users\\x\\Sync\\m",
    "C:\\Users\\x\\iCloudDrive\\m", "\\\\NAS\\share\\money", "\\\\localhost\\d$\\Dropbox\\x", "\\\\?\\UNC\\NAS\\share", "relative\\path",
    "\\\\?\\" + path.join(app, "v"), path.join(app, "data"), path.join(app, "..", "app", "x"), "C:\\Example\\Scratch\\..\\Dropbox\\x"];
  for (const p of bad) {
    assert.ok(VA.unsafeReason(p, app), "refused: " + p);
    const r = SV.resolveVault({ userData: ud, testMode: true, appDir: app, env: { AGENT_DESKTOP_FINANCE_DIR: p } });
    assert.strictEqual(r.dir, path.join(ud, "finance-vault"), p); assert.ok(r.note, "a visible note for " + p);
  }
  for (const ok of ["C:\\Example\\Scratch\\Finance\\vault", path.join(ud, "money"), "C:\\Example\\Scratch\\Gadgetry\\x", "C:\\Example\\Scratch\\Boxes\\x"]) assert.strictEqual(VA.unsafeReason(ok, app), null, "allowed: " + ok);
});
t("vault: a junction into a Dropbox folder is refused (env AND default), and demo data is never written through it", () => {
  const ud = tmp(), root = tmp(), target = path.join(root, "Dropbox", "money"); fs.mkdirSync(target, { recursive: true });
  const link = path.join(root, "innocent");
  if (!junction(link, target)) { console.log("  (skipped: mklink /J not available)"); return; }
  assert.ok(VA.unsafeReason(path.join(link, "vault"), null), "junction resolved to its real place");
  const s = svc(ud, { env: { AGENT_DESKTOP_FINANCE_DIR: path.join(link, "vault") } });
  assert.strictEqual(s.where().dir, path.join(ud, "finance-vault"));
  assert.strictEqual(s.createDemo(NOW).ok, true);
  assert.deepStrictEqual(fs.readdirSync(target), [], "nothing reached the Dropbox target");
  const d = SV.resolveVault({ userData: ud, testMode: false, env: {}, defaultDir: path.join(link, "vault") });
  assert.strictEqual(d.dir, path.join(ud, "finance-vault"), "the DEFAULT dir is checked too"); assert.strictEqual(d.from, "fallback");
  const none = SV.resolveVault({ userData: path.join(link, "ud"), testMode: false, env: {}, defaultDir: path.join(link, "vault") });
  assert.strictEqual(none.dir, null, "no safe folder at all -> nothing is used");
  const b = SV.createService({ userData: path.join(link, "ud"), testMode: true, env: {} });
  assert.strictEqual(b.load().state, "blocked"); assert.strictEqual(b.createDemo(NOW).ok, false); assert.strictEqual(b.folderFor("drop"), null);
  assert.deepStrictEqual(fs.readdirSync(target), []);
});
t("vault: 8.3 short names are expanded to the real name (or refused when they cannot be resolved yet)", () => {
  const root = tmp(), long = path.join(root, "Dropbox (Acmeco Studio)"); fs.mkdirSync(path.join(long, "money"), { recursive: true });
  assert.ok(VA.unsafeReason("C:\\Example\\Scratch\\DROPBO~1\\x", null) || fs.existsSync("C:\\Example\\Scratch\\DROPBO~1") === false, "a not-yet-existing 8.3-looking segment is refused");
  assert.ok(VA.unsafeReason(path.join(root, "NOTREA~1", "x"), null), "unresolvable short name refused");
  let sn = shortName(long), extra = null;
  if (!sn && process.env.LOCALAPPDATA) {   // the temp volume has 8.3 names off: try the user's own Temp on C:, cleaned up below
    extra = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, "Temp", "fin83-"));
    const l2 = path.join(extra, "Dropbox (Acmeco Studio)"); fs.mkdirSync(path.join(l2, "money"), { recursive: true }); sn = shortName(l2);
  }
  try {
    if (!sn) { console.log("  (8.3 names are off on every volume tried: real alias not tested)"); return; }
    assert.ok(/~\d/.test(sn) && !/dropbox \(/i.test(sn), "a real 8.3 alias: " + sn);
    assert.ok(VA.unsafeReason(path.join(sn, "money"), null), "the alias " + sn + " is seen as the Dropbox folder it is");
    assert.ok(VA.unsafeReason(path.join(sn, "money", "new", "vault"), null), "also for a not-yet-existing folder under it");
  } finally { if (extra) fs.rmSync(extra, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ vault subfolders (re-review R1, R2, R3, R6)
// a fake "Dropbox (Personal)" folder and a safe vault whose ONE subfolder is a junction into it
function linkedSub(sub) {
  const ud = tmp(), cloud = path.join(tmp(), "Dropbox (Personal)", "money");
  fs.mkdirSync(cloud, { recursive: true });
  const v = path.join(ud, "finance-vault");
  fs.mkdirSync(path.dirname(path.join(v, sub)), { recursive: true });
  if (!junction(path.join(v, sub), cloud)) return null;
  return { ud, v, cloud, s: svc(ud) };
}
t("vault R1: a junction as ANY subfolder (db, drop, archive, receipts, exports) into a Dropbox folder blocks every write, and nothing reaches it", async () => {
  for (const sub of SV.SUBFOLDERS) {
    const w = linkedSub(sub);
    if (!w) { console.log("  (skipped: mklink /J not available)"); return; }
    const c = w.s.createDemo(NOW);
    assert.strictEqual(c.ok, false, sub + ": demo data refused"); assert.ok(new RegExp(sub + " folder is a link or junction").test(c.reason), c.reason);
    assert.deepStrictEqual(fs.readdirSync(w.cloud), [], sub + ": nothing written into the Dropbox target");
    assert.ok(!fs.existsSync(ledgerPath(w.ud)) || sub === "db", sub + ": no ledger written");
    assert.strictEqual(w.s.removeDemo().ok, false, sub + ": remove refused");
  }
  const db = linkedSub("db"); assert.strictEqual(db.s.load().state, "blocked"); assert.ok(/db\) is a link or junction/.test(db.s.load().reason));
  const drop = linkedSub("drop");
  fs.writeFileSync(path.join(drop.cloud, "x.csv"), "Date,Amount\n2026-10-01,1\n");
  const scan = await drop.s.importScan(); assert.strictEqual(scan.ok, false, "a linked drop folder is not scanned"); assert.ok(!scan.files);
  assert.strictEqual(drop.s.folderFor("drop"), null);
  const sm = linkedSub(path.join("drop", "samples"));
  fs.writeFileSync(path.join(sm.cloud, "y.csv"), "Date,Amount\n2026-10-01,1\n");
  const sc = await sm.s.importScan(); assert.strictEqual(sc.ok, true); assert.ok(!sc.files.some((f) => f.name === "y.csv"), "a linked drop\\samples is skipped");
});
t("vault R1: a demo ledger already in place is never moved into a linked archive (remove and 'make new' both refuse first)", () => {
  const ud = tmp(), s = svc(ud); s.createDemo(NOW);
  const v = path.join(ud, "finance-vault"), cloud = path.join(tmp(), "Dropbox (Personal)"); fs.mkdirSync(cloud);
  fs.rmdirSync(path.join(v, "archive"));
  if (!junction(path.join(v, "archive"), cloud)) { console.log("  (skipped: mklink /J not available)"); return; }
  const before = fs.readFileSync(ledgerPath(ud), "utf8");
  assert.strictEqual(s.removeDemo().ok, false); assert.strictEqual(s.createDemo(NOW).ok, false);
  assert.deepStrictEqual(fs.readdirSync(cloud), [], "nothing moved into Dropbox");
  assert.strictEqual(fs.readFileSync(ledgerPath(ud), "utf8"), before, "the ledger stayed where it was");
  assert.strictEqual(fs.readdirSync(path.join(v, "drop")).length, 2, "the DEMO files stayed");
});
t("vault R2: drop swapped for a junction between the check and the write -> the file is taken back and the call fails", () => {
  const ud = tmp(), s = svc(ud), v = path.join(ud, "finance-vault"), cloud = path.join(tmp(), "Dropbox (Personal)"); fs.mkdirSync(cloud);
  const orig = fs.openSync; let swapped = false, ok = true;
  fs.openSync = function (p) {
    if (!swapped && /[\\/]drop[\\/]DEMO_.*\.tmp$/.test(String(p))) { swapped = true; fs.renameSync(path.join(v, "drop"), path.join(v, "drop-old")); ok = junction(path.join(v, "drop"), cloud); }
    return orig.apply(fs, arguments);
  };
  let r; try { r = s.createDemo(NOW); } finally { fs.openSync = orig; }
  if (!ok) { console.log("  (skipped: mklink /J not available)"); return; }
  assert.ok(swapped, "the race was simulated"); assert.strictEqual(r.ok, false); assert.ok(/drop is a link or junction/.test(r.reason), r.reason);
  assert.deepStrictEqual(fs.readdirSync(cloud), [], "the file written through the swapped link was taken back");
  const src = fs.readFileSync(path.join(SRC, "finance", "service.js"), "utf8");
  assert.ok(/fs\.openSync\(tmp, "wx"\)/.test(src), "temp files are created with O_EXCL");
});
t("vault R3/R6: names ending in a dot or space, stream names (:) and drive-relative paths are refused", () => {
  for (const p of ["C:\\Users\\x\\Box.\\money", "G:\\My Drive.\\m", "C:\\x\\Google Drive.\\m", "P:\\pCloud.\\m", "C:\\x\\MEGA.\\m", "C:\\x\\Sync.\\m", "C:\\x\\Box \\m", "C:\\x\\money.", "C:\\x\\money \\v","D:\\Dropbox:ads\\x", "C:\\x\\a:b", "D:Dropbox", "\\Dropbox\\x"])
    assert.ok(VA.unsafeReason(p, null), "refused: " + JSON.stringify(p));
  assert.strictEqual(VA.unsafeReason("C:\\Example\\Scratch\\Finance\\vault.v2\\x", null), null, "a dot inside a name is fine");
});

// ------------------------------------------------------------------ synthetic data
t("synthetic R4: the demo marker is a whole word - every generated name has it; 'Demolition Ltd' and 'דמוקרט' do not count", () => {
  const L = SY.makeLedger({ now: NOW });
  for (const nm of [...L.accounts.map((x) => x.name), ...L.transactions.map((x) => x.merchant), ...L.receipts.map((x) => x.vendor)]) assert.ok(SV.DEMO_MARK.test(nm), "marked: " + nm);
  for (const nm of ["Demolition Ltd", "DEMOCRAT store", "דמוקרטיה בע\"מ", "Pandemonium", "Superdemo", "ademo"]) assert.ok(!SV.DEMO_MARK.test(nm), "not a marker: " + nm);
  for (const nm of ["Fuel Stop Demo", "Demo Air", "x (demo)", "Leumi - demo", "שוק הדמו", "ארנונה (דמו)", "DEMO"]) assert.ok(SV.DEMO_MARK.test(nm), nm);
  L.transactions[0].merchant = "Demolition Ltd";
  assert.strictEqual(SV.isDemoLedger(L), false, "one 'Demolition Ltd' line makes the ledger real");
});
t("synthetic: deterministic, marked synthetic, every merchant and account clearly demo, Hebrew and English, NIS amounts, 6 months", () => {
  const a = SY.makeLedger({ now: NOW }), b = SY.makeLedger({ now: NOW });
  assert.deepStrictEqual(a, b, "same now + seed = same ledger");
  assert.strictEqual(a.synthetic, true); assert.ok(/DEMO DATA/.test(a.note)); assert.ok(SV.isDemoLedger(a));
  for (const r of a.receipts) assert.ok(/demo|דמו/i.test(r.vendor), r.vendor);
  assert.ok(a.transactions.some((x) => /[\u0590-\u05FF]/.test(x.merchant)) && a.transactions.some((x) => /^[A-Za-z]/.test(x.merchant)));
  const months = new Set(a.transactions.map((x) => x.date.slice(0, 7)));
  assert.deepStrictEqual([...months].sort(), ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  assert.ok(a.transactions.every((x) => x.date <= "2026-10-08"), "nothing in the future");
  assert.ok(a.categories.length >= 18 && a.categories.every((c) => c.he && c.en && c.icon));
});
t("synthetic: card lump debits are transfers, so card spending is counted once; transfers balance out", () => {
  const L = SY.makeLedger({ now: NOW });
  const lumps = L.transactions.filter((x) => /settlement/.test(x.merchant));
  assert.ok(lumps.length >= 8 && lumps.every((x) => x.transfer && x.category === "transfer" && x.account === "leumi"));
  assert.ok(Math.abs(L.transactions.filter((x) => x.transfer).reduce((s, x) => s + x.amount, 0)) < 0.05, "every transfer has its other side");
  const sep = L.transactions.filter((x) => x.account === "card-a" && !x.transfer && x.date.startsWith("2026-09")).reduce((s, x) => s + x.amount, 0);
  const lump = L.transactions.find((x) => x.date === "2026-10-02" && x.merchant === "Card A settlement (demo)");
  assert.ok(Math.abs(lump.amount - sep) < 0.05);
});

// ------------------------------------------------------------------ service
t("service: no ledger = empty state; demo data creates the vault folders, a synthetic ledger and two demo exports", () => {
  const ud = tmp(), s = svc(ud);
  const e = s.load(); assert.strictEqual(e.state, "empty"); assert.strictEqual(e.vault, path.join(ud, "finance-vault")); assert.ok(!fs.existsSync(e.vault), "load never creates folders");
  const c = s.createDemo(NOW); assert.strictEqual(c.ok, true); assert.ok(c.transactions > 150);
  for (const sub of SV.SUBFOLDERS) assert.ok(fs.statSync(path.join(ud, "finance-vault", sub)).isDirectory(), sub);
  assert.deepStrictEqual(fs.readdirSync(path.join(ud, "finance-vault", "drop")).sort(), ["DEMO_bank_export.csv", "DEMO_card_export.csv"]);
  assert.notStrictEqual(fs.readFileSync(ledgerPath(ud))[0], 0xEF, "ledger JSON has no BOM");
  const r = s.load(); assert.strictEqual(r.state, "ready"); assert.strictEqual(r.synthetic, true);
});
t("service: month totals, balances and the overview add up from the lines (transfers left out)", () => {
  const ud = tmp(), s = svc(ud); s.createDemo(NOW);
  const r = s.load(), L = JSON.parse(fs.readFileSync(ledgerPath(ud), "utf8"));
  assert.strictEqual(r.months.length, 6);
  for (const m of r.months) {
    const lines = L.transactions.filter((x) => !x.transfer && x.date.startsWith(m.month));
    const inn = lines.filter((x) => x.amount > 0).reduce((s2, x) => s2 + x.amount, 0), out = lines.filter((x) => x.amount < 0).reduce((s2, x) => s2 - x.amount, 0);
    assert.ok(Math.abs(m.in - inn) < 0.05 && Math.abs(m.out - out) < 0.05 && Math.abs(m.net - (m.in - m.out)) < 0.05, m.month);
  }
  const leumi = r.accounts.find((a) => a.id === "leumi");
  assert.ok(Math.abs(leumi.balance - (18000 + L.transactions.filter((x) => x.account === "leumi").reduce((s2, x) => s2 + x.amount, 0))) < 0.05);
  const o = r.overview;
  assert.ok(Math.abs(o.cash - r.accounts.filter((a) => a.kind !== "card").reduce((s2, a) => s2 + a.balance, 0)) < 0.05);
  assert.ok(o.owed <= 0 && o.receiptsToCheck === o.receiptsNew + o.receiptsNoLine && o.receiptsNoLine === 3);
  const spent = Object.keys(r.catMonths).filter((k) => r.categories.find((c) => c.id === k).group !== "income").reduce((s2, k) => s2 + (r.catMonths[k]["2026-09"] || 0), 0);
  assert.ok(Math.abs(spent - r.months[4].out) < 0.1, "category totals add up to the month's money out");
  assert.ok(!("transfer" in r.catMonths), "transfers are never in the category totals");
});
t("service (S4): a running month is compared with the SAME DAYS of last month; a finished month with the whole month", () => {
  const ud = tmp(), s = svc(ud); s.createDemo(NOW);
  const r = s.load(), o = r.overview, L = JSON.parse(fs.readFileSync(ledgerPath(ud), "utf8"));
  assert.strictEqual(o.month, "2026-10"); assert.strictEqual(o.prevMonth, "2026-09"); assert.strictEqual(o.partial, true); assert.strictEqual(o.sameDays, 8);
  const sep18 = L.transactions.filter((x) => !x.transfer && x.date >= "2026-09-01" && x.date <= "2026-09-08");
  assert.ok(Math.abs(o.prevIn - sep18.filter((x) => x.amount > 0).reduce((a, x) => a + x.amount, 0)) < 0.05);
  assert.ok(Math.abs(o.prevOut - sep18.filter((x) => x.amount < 0).reduce((a, x) => a - x.amount, 0)) < 0.05);
  assert.strictEqual(o.prevFullIn, r.months[4].in); assert.ok(o.prevIn < o.prevFullIn);
  const food = sep18.filter((x) => x.category === "food").reduce((a, x) => a - x.amount, 0);
  assert.ok(Math.abs((o.catPrev.food || 0) - food) < 0.05, "category comparison uses the same days too");
  const later = SV.createService({ userData: ud, testMode: true, env: {}, now: () => new Date(2026, 10, 20) }).load().overview;
  assert.strictEqual(later.partial, false); assert.strictEqual(later.prevIn, r.months[4].in, "October finished: compared with all of September");
  const js = fs.readFileSync(path.join(SRC, "renderer", "finance.js"), "utf8");
  assert.ok(/cls: partial \? "mf-flat"/.test(js) && /cmpLabel/.test(js) && /" vs " \+ vs/.test(js), "no green 'good' chip while the month runs; the words say what it is compared with");
});
t("service: transactions search (Hebrew), filters, sums, newest first, the 400-row cap; junk filter values are ignored", () => {
  const ud = tmp(), s = svc(ud); s.createDemo(NOW);
  const all = s.transactions({}); assert.strictEqual(all.ok, true); assert.strictEqual(all.total, all.all); assert.strictEqual(all.rows.length, 200);
  assert.ok(all.rows[0].date >= all.rows[all.rows.length - 1].date);
  const he = s.transactions({ text: "סופר" }); assert.ok(he.total > 0 && he.rows.every((x) => /סופר/.test(x.merchant + x.raw)));
  const m = s.transactions({ month: "2026-09", kind: "out", account: "card-b" }); assert.ok(m.rows.every((x) => x.date.startsWith("2026-09") && x.amount < 0 && !x.transfer && x.account === "card-b"));
  assert.ok(m.sumIn === 0 && m.sumOut > 0);
  assert.ok(s.transactions({ kind: "transfer" }).rows.every((x) => x.transfer));
  assert.strictEqual(s.transactions({ limit: 5000 }).rows.length, Math.min(400, all.all));
  assert.strictEqual(s.transactions({ month: "../x", account: "a/../b", category: "constructor", kind: "evil", limit: -3 }).total, all.all);
  assert.strictEqual(s.transactions([1, 2]).total, all.all);
  assert.strictEqual(svc(tmp()).transactions({}).ok, false);
});
t("service (S5): the parsed ledger is cached by mtime + size, re-read when the file changes, dropped on close", () => {
  const ud = tmp(), s = svc(ud); s.createDemo(NOW);
  const file = ledgerPath(ud), orig = fs.readFileSync; let reads = 0;
  fs.readFileSync = function (p) { if (String(p) === file) reads++; return orig.apply(fs, arguments); };
  try {
    s.load(); s.transactions({ text: "a" }); s.transactions({ text: "ab" }); s.transactions({ text: "abc" });
    assert.strictEqual(reads, 1, "one read for four calls");
    const j = JSON.parse(orig(file, "utf8")); j.transactions.pop(); fs.writeFileSync(file, JSON.stringify(j));
    assert.strictEqual(s.transactions({}).all, j.transactions.length); assert.strictEqual(reads, 2, "changed file -> read again");
    s.dropCache(); s.transactions({}); assert.strictEqual(reads, 3, "dropped on close");
  } finally { fs.readFileSync = orig; }
});
t("service (S6): ids like constructor / __proto__ / toString never become keys; nothing global is changed", () => {
  const ud = tmp(), s = svc(ud); fs.mkdirSync(path.dirname(ledgerPath(ud)), { recursive: true });
  fs.writeFileSync(ledgerPath(ud), JSON.stringify({ accounts: [{ id: "a1", name: "A", kind: "bank" }, { id: "constructor", name: "C" }],
    categories: [{ id: "constructor", en: "x" }, { id: "toString", en: "y" }, { id: "hasOwnProperty", en: "z" }, { id: "food", en: "Food" }],
    transactions: [{ date: "2026-10-01", amount: -10, account: "a1", category: "constructor", merchant: "m" }, { date: "2026-10-02", amount: -5, account: "a1", category: "food", merchant: "m" }, { date: "2026-10-02", amount: -5, account: "constructor", merchant: "m" }] }).replace('"food", en', '"food", "__proto__": {"polluted": 1}, "en'));
  const r = s.load();
  assert.strictEqual(r.state, "ready"); assert.deepStrictEqual(r.accounts.map((a) => a.id), ["a1"]);
  assert.ok(!r.categories.some((c) => ["constructor", "toString", "hasOwnProperty"].includes(c.id)));
  assert.strictEqual(r.catMonths.other["2026-10"], 10, "the line falls back to Uncategorised and is still counted");
  assert.strictEqual(Object["2026-10"], undefined); assert.strictEqual({}.polluted, undefined); assert.strictEqual(Object.prototype["2026-10"], undefined);
  for (const id of ["constructor", "__proto__", "toString", "prototype", "valueOf"]) assert.strictEqual(SV.okId(id), false, id);
});
t("service (S1, S2): only ENOENT means 'no ledger'; demo data is archived, never deleted, and only if EVERY line is marked demo", () => {
  const ud = tmp(), s = svc(ud); s.createDemo(NOW);
  const v = path.join(ud, "finance-vault");
  fs.writeFileSync(path.join(v, "drop", "leumi_2026-10.csv"), "תאריך,סכום\n01/10/2026,5\n");
  const rm = s.removeDemo(); assert.strictEqual(rm.ok, true); assert.strictEqual(rm.moved, 3);
  assert.ok(!fs.existsSync(ledgerPath(ud))); assert.deepStrictEqual(fs.readdirSync(path.join(v, "drop")), ["leumi_2026-10.csv"], "a real export is kept");
  const arch = fs.readdirSync(path.join(v, "archive"));
  assert.strictEqual(arch.filter((f) => /^ledger-demo-.*\.json$/.test(f)).length, 1, "the ledger was MOVED to the archive"); assert.strictEqual(arch.length, 3);
  // a ledger that claims synthetic but holds one unmarked line counts as REAL
  s.createDemo(NOW); const j = JSON.parse(fs.readFileSync(ledgerPath(ud), "utf8"));
  j.transactions.push({ id: "x", date: "2026-10-03", amount: -99, account: "leumi", merchant: "Supermarket", category: "food" }); fs.writeFileSync(ledgerPath(ud), JSON.stringify(j));
  assert.strictEqual(s.removeDemo().ok, false); assert.strictEqual(s.createDemo(NOW).ok, false); assert.strictEqual(s.load().synthetic, false, "no demo banner over real lines");
  assert.strictEqual(JSON.parse(fs.readFileSync(ledgerPath(ud), "utf8")).transactions.length, j.transactions.length, "untouched");
  fs.writeFileSync(ledgerPath(ud), "{ broken"); assert.strictEqual(s.createDemo(NOW).ok, false); assert.strictEqual(fs.readFileSync(ledgerPath(ud), "utf8"), "{ broken");
  // a stat error that is not ENOENT (a locked or access-denied ledger: EPERM / EBUSY) is "unreadable", never "missing", so it is never overwritten
  const ud2 = tmp(), s2 = svc(ud2), lp = ledgerPath(ud2), origL = fs.lstatSync;
  fs.lstatSync = function (p) { if (String(p) === lp) { const e = new Error("locked"); e.code = "EPERM"; throw e; } return origL.apply(fs, arguments); };
  try { assert.strictEqual(s2.load().state, "unreadable"); assert.strictEqual(s2.createDemo(NOW).ok, false); assert.strictEqual(s2.removeDemo().ok, false); }
  finally { fs.lstatSync = origL; }
  assert.ok(!fs.existsSync(lp), "nothing was written over the locked ledger");
  // "Make new demo data" archives the old demo ledger instead of overwriting it
  const ud3 = tmp(), s3 = svc(ud3); s3.createDemo(NOW); s3.createDemo(NOW);
  assert.strictEqual(fs.readdirSync(path.join(ud3, "finance-vault", "archive")).filter((f) => /^ledger-demo-/.test(f)).length, 1);
});
t("service: the ledger is normalised - bad rows skipped and counted, unknown category -> Uncategorised, strings clipped, BOM ok, size cap", () => {
  const ud = tmp(), s = svc(ud); fs.mkdirSync(path.dirname(ledgerPath(ud)), { recursive: true });
  fs.writeFileSync(ledgerPath(ud), "\uFEFF" + JSON.stringify({ synthetic: true, accounts: [{ id: "a1", name: "A", kind: "bank", opening: 10 }, { id: "../x", name: "bad" }], categories: [{ id: "food", en: "Food", he: "מזון", icon: "🛒", group: "personal" }],
    transactions: [{ date: "2026-10-01", amount: -5, account: "a1", merchant: "M".repeat(500), category: "nope" }, { date: "1/10/2026", amount: 1, account: "a1" }, { date: "2026-10-02", amount: "7", account: "a1" }, { date: "2026-10-03", amount: 3, account: "ghost" }, null] }));
  const r = s.load();
  assert.strictEqual(r.state, "ready"); assert.strictEqual(r.skipped, 4); assert.strictEqual(r.accounts[0].balance, 5);
  assert.strictEqual(r.synthetic, false, "synthetic:true without demo markers is not treated as demo data");
  const row = s.transactions({}).rows[0]; assert.strictEqual(row.category, "other"); assert.strictEqual(row.merchant.length, 120);
  fs.writeFileSync(ledgerPath(ud), "{\"pad\":\"" + "x".repeat(SV.MAX_LEDGER_BYTES + 5) + "\"}");
  assert.strictEqual(s.load().state, "unreadable");
});

// ------------------------------------------------------------------ CSV preview
t("csv: Hebrew header under a title line, semicolons, debit/credit columns -> signed amounts; day-first dates", () => {
  const txt = "פירוט עסקאות\n\nתאריך עסקה;שם בית העסק;חובה;זכות\n05/09/2026;סופר (דמו);120.50;\n06/09/2026;החזר;;30\n\n";
  const r = CSV.parseCsv(Buffer.from("\uFEFF" + txt, "utf8"));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.headerRow, 3); assert.strictEqual(r.delimiter, ";");
  assert.deepStrictEqual(r.columns.map((c) => c.role), ["date", "description", "debit", "credit"]);
  assert.strictEqual(r.rows, 2); assert.strictEqual(r.usable, 2);
  assert.deepStrictEqual(r.preview.map((p) => p.amount), [-120.5, 30]); assert.strictEqual(r.firstDate, "2026-09-05");
});
t("csv: English headers, quoted commas, amount + balance, a bad row counted but not usable; no header -> a plain note", () => {
  const r = CSV.parseCsv("Date,Description,Amount,Balance\n2026-10-01,\"Shop, Ltd (demo)\",\"-1,234.50\",100\nxx,oops,abc,\n");
  assert.strictEqual(r.ok, true); assert.strictEqual(r.rows, 2); assert.strictEqual(r.usable, 1);
  assert.strictEqual(r.preview[0].description, "Shop, Ltd (demo)"); assert.strictEqual(r.preview[0].amount, -1234.5);
  const no = CSV.parseCsv("a,b,c\n1,2,3\n"); assert.strictEqual(no.ok, false); assert.ok(/header/.test(no.note));
  assert.strictEqual(CSV.parseCsv("").ok, false);
});
t("csv: Windows-1255 and UTF-16 (LE/BE, with or without BOM) are decoded", () => {
  const head = Buffer.from([0xFA, 0xE0, 0xF8, 0xE9, 0xEA, 0x2C, 0xF1, 0xEB, 0xE5, 0xED, 0x0A]);   // "תאריך,סכום" in Windows-1255
  const r = CSV.parseCsv(Buffer.concat([head, Buffer.from("01.10.26,12\n")]), { now: NOW });
  assert.strictEqual(r.encoding, "windows-1255"); assert.strictEqual(r.columns[0].name, "תאריך"); assert.strictEqual(r.usable, 1);
  const text = "Date,Amount\n2026-10-01,5\n", le = Buffer.from(text, "utf16le");
  const be = Buffer.from(le); for (let i = 0; i < be.length; i += 2) { const x = be[i]; be[i] = be[i + 1]; be[i + 1] = x; }
  for (const [buf, enc] of [[Buffer.concat([Buffer.from([0xFF, 0xFE]), le]), "utf-16le"], [Buffer.concat([Buffer.from([0xFE, 0xFF]), be]), "utf-16be"], [le, "utf-16le"], [be, "utf-16be"]]) {
    const p = CSV.parseCsv(buf, { now: NOW }); assert.strictEqual(p.encoding, enc); assert.strictEqual(p.usable, 1, enc);
  }
});
t("csv: amounts (decimal comma, parentheses, 1,2,3 refused) and dates (two-digit years, nothing far in the future)", () => {
  assert.deepStrictEqual(["1,234.50", "(12.00)", "12.00-", "₪ 1,000", "1.234,50", "−7", "12,34", "(-5)", "1,2,3", "abc", ""].map(CSV.parseAmount), [1234.5, -12, -12, 1000, 1234.5, -7, 12.34, -5, null, null, null]);
  assert.deepStrictEqual(["05/09/2026", "5.9.26", "2026-09-05", "31/12/99", "01/01/89", "01/01/30", "01/01/2035", "31/02/2026", "13/13/2026", "x"].map((d) => CSV.parseDate(d, NOW)),
    ["2026-09-05", "2026-09-05", "2026-09-05", "1999-12-31", null, null, null, null, null, null]);
});
t("csv: spreadsheetSafe (for the future accountant export) defuses formula cells", () => {
  assert.deepStrictEqual(["=cmd|' /C calc'!A0", "+1+1", "-2+3", "@SUM(A1)", "\tx", "\rx", "Shop", "", 12.5, -3].map(CSV.spreadsheetSafe),
    ["'=cmd|' /C calc'!A0", "'+1+1", "'-2+3", "'@SUM(A1)", "'\tx", "'\rx", "Shop", "", 12.5, -3]);
});
t("csv (B2): hostile files stay fast and small - a 5 MB single line, a 3 000-column header, an unterminated quote, 50 000+ rows", () => {
  const cases = [["Date,,,," + ",".repeat(5 * 1024 * 1024)], ["Date," + Array.from({ length: 3000 }, (_, i) => "c" + i).join(",") + "\n2026-10-01," + "1,".repeat(3000)],
    ["Date,Amount\n\"" + "x".repeat(3 * 1024 * 1024)], ["Date,Amount\n" + "2026-10-01,1\n".repeat(60000)], [("x".repeat(300 * 1024) + "\n").repeat(15) + "Date,Amount\n"]];
  for (const [text] of cases) {
    const t0 = Date.now(), r = CSV.parseCsv(text, { now: NOW }), ms = Date.now() - t0;
    assert.ok(ms < 1500, "took " + ms + " ms"); assert.ok(!r.columns || r.columns.length <= CSV.MAX_COLS, "columns capped: " + (r.columns && r.columns.length));
    assert.ok(JSON.stringify(r).length < 100 * 1024, "the result stays small");
  }
  const big = CSV.parseCsv("Date,Amount\n" + "2026-10-01,1\n".repeat(60000), { now: NOW }); assert.strictEqual(big.rows, 50000); assert.ok(/first 50000/.test(big.note));
  const single = Date.now(); CSV.parseCsv("Date,,,," + ",".repeat(5 * 1024 * 1024)); assert.ok(Date.now() - single < 500, "5 MB single line under 500 ms");
  // R5: a header just under the 4 KB header limit, made of 1-character columns, so it IS used as the header and the 64-column cap must bite
  const hdr = "Date,Amount," + Array.from({ length: 1900 }, () => "x").join(","); assert.ok(hdr.length < 4096 && hdr.length > 3700);
  const wide = CSV.parseCsv(hdr + "\n2026-10-01,5," + "1,".repeat(1900), { now: NOW });
  assert.strictEqual(wide.ok, true); assert.strictEqual(wide.columns.length, CSV.MAX_COLS, "exactly 64 columns kept"); assert.strictEqual(wide.usable, 1);
  assert.strictEqual(CSV.splitLine("a,".repeat(500), ",").length, CSV.MAX_COLS);
});
t("import scan (B2): async; CSV previewed, Excel/PDF listed as not read; folders, oversize files, too many files and the per-scan budget are handled", async () => {
  const ud = tmp(), s = svc(ud);
  assert.deepStrictEqual((await s.importScan()).files, []); assert.strictEqual((await s.importScan()).exists, false);
  s.createDemo(NOW);
  const drop = path.join(ud, "finance-vault", "drop");
  fs.mkdirSync(path.join(drop, "samples")); fs.writeFileSync(path.join(drop, "samples", "leumi.xlsx"), "PK"); fs.writeFileSync(path.join(drop, "card.pdf"), "%PDF");
  fs.mkdirSync(path.join(drop, "nested.csv")); fs.writeFileSync(path.join(drop, "big.csv"), Buffer.alloc(SV.MAX_IMPORT_BYTES + 1, 0x41));
  const p = s.importScan(); assert.ok(p instanceof Promise, "the scan is async");
  const r = await p, by = (nm) => r.files.find((f) => f.name === nm);
  assert.ok(!by("nested.csv"), "a folder is not a file");
  assert.strictEqual(by("DEMO_bank_export.csv").parse.ok, true); assert.ok(by("DEMO_bank_export.csv").parse.usable > 10);
  assert.strictEqual(by("DEMO_card_export.csv").parse.headerRow, 3);
  assert.strictEqual(by("leumi.xlsx").kind, "excel"); assert.ok(!by("leumi.xlsx").parse);
  assert.strictEqual(by("card.pdf").kind, "pdf"); assert.strictEqual(by("big.csv").parse.ok, false);
  for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(drop, "f" + String(i).padStart(2, "0") + ".csv"), "Date,Amount\n2026-10-01,1\n");
  const many = await s.importScan();
  assert.strictEqual(many.files.length, 60); assert.ok(many.more >= 10);
  assert.ok(many.files.filter((f) => f.parse && f.parse.ok).length <= 20, "at most 20 CSVs previewed per look");
});
t("import scan (B2): hostile files in the drop folder never block the main process for long", async () => {
  const ud = tmp(), s = svc(ud); s.createDemo(NOW);
  const drop = path.join(ud, "finance-vault", "drop"), mb = 1.9 * 1024 * 1024;
  fs.writeFileSync(path.join(drop, "oneline.csv"), "Date,,," + ",".repeat(mb));
  fs.writeFileSync(path.join(drop, "wide.csv"), ("Date," + "x,".repeat(2000) + "\n").repeat(Math.floor(mb / 4100)));
  fs.writeFileSync(path.join(drop, "rows.csv"), "Date,Amount\n" + "01/10/2026,12.50\n".repeat(Math.floor(mb / 17)));
  fs.writeFileSync(path.join(drop, "quote.csv"), "Date,Amount\n\"" + "y".repeat(mb));
  fs.writeFileSync(path.join(drop, "longlines.csv"), "Date,Amount\n" + ("2026-10-01," + "9".repeat(40000) + "\n").repeat(45));
  let last = Date.now(), maxGap = 0, run = true;
  const tick = () => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; if (run) setImmediate(tick); };
  setImmediate(tick);
  const t0 = Date.now(), r = await s.importScan(); run = false;
  const total = Date.now() - t0;
  assert.ok(maxGap < 150, "longest block " + maxGap + " ms (total " + total + " ms)");
  for (const f of r.files) if (f.parse && f.parse.columns) assert.ok(f.parse.columns.length <= 64, f.name);
  assert.ok(JSON.stringify(r).length < 200 * 1024, "the reply to the view stays small");
  console.log("  hostile scan: " + r.files.length + " files, longest block " + maxGap + " ms, total " + total + " ms");
});

// ------------------------------------------------------------------ IPC
function world(extra) {
  const handlers = {}, logs = [], opened = [];
  const wc = { mainFrame: {} }, win = { webContents: wc, isDestroyed: () => false };
  const ud = tmp();
  MF.init(Object.assign({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, getMainWindow: () => win, userData: ud, appDir: path.join(ud, "app"), testMode: true, log: (l) => logs.push(l), env: {}, openPath: async (p) => { opened.push(p); return ""; } }, extra || {}));
  return { handlers, logs, opened, good: { sender: wc, senderFrame: wc.mainFrame }, wc, ud };
}
t("ipc: the allow-list; only the main window's own frame (a null or other frame is refused); arrays, scalars and oversized arguments refused", async () => {
  const w = world();
  assert.deepStrictEqual(Object.keys(w.handlers).sort(), ["finance-closed", "finance-demo-create", "finance-demo-remove", "finance-feed", "finance-import-scan", "finance-load", "finance-open-folder", "finance-prefs-get", "finance-prefs-set", "finance-transactions"]);
  assert.strictEqual((await w.handlers["finance-load"](w.good)).ok, true);
  assert.strictEqual((await w.handlers["finance-load"]({ sender: {}, senderFrame: {} })).ok, false);
  assert.strictEqual((await w.handlers["finance-load"]({ sender: w.wc, senderFrame: {} })).ok, false, "a sub-frame is refused");
  assert.strictEqual((await w.handlers["finance-load"]({ sender: w.wc, senderFrame: null })).ok, false, "a null (destroyed) frame is refused");
  assert.strictEqual((await w.handlers["finance-transactions"](w.good, { text: "x".repeat(3000) })).ok, false);
  assert.strictEqual((await w.handlers["finance-transactions"](w.good, [1, 2])).ok, false); assert.strictEqual((await w.handlers["finance-transactions"](w.good, "x")).ok, false);
  const pre = fs.readFileSync(path.join(SRC, "preload.js"), "utf8"), blk = pre.slice(pre.indexOf("finance: {"), pre.indexOf("finance: {") + 1000);
  for (const c of Object.keys(w.handlers)) assert.ok(blk.includes('"' + c + '"'), "preload exposes " + c);
});
t("ipc: demo create -> load -> transactions -> import scan -> remove (archived), end to end inside the vault", async () => {
  const w = world();
  assert.strictEqual((await w.handlers["finance-demo-create"](w.good)).ok, true);
  const l = await w.handlers["finance-load"](w.good); assert.strictEqual(l.state, "ready"); assert.strictEqual(l.synthetic, true); assert.ok(l.vault.startsWith(w.ud));
  assert.ok((await w.handlers["finance-transactions"](w.good, { text: "דמו" })).total > 0);
  assert.strictEqual((await w.handlers["finance-import-scan"](w.good)).files.length, 2);
  assert.strictEqual((await w.handlers["finance-closed"](w.good)).ok, true);
  assert.strictEqual((await w.handlers["finance-demo-remove"](w.good)).ok, true);
  assert.strictEqual((await w.handlers["finance-load"](w.good)).state, "empty");
});
t("ipc: logs never carry data - error and refusal paths are forced and every line must be 'channel refused|failed: code=X'", async () => {
  const w = world({ openPath: async () => { const e = new Error("₪1,234.50 Sponsor North (demo) E:\\secret\\path"); e.code = "EACCES"; throw e; } });
  await w.handlers["finance-demo-create"](w.good);
  assert.strictEqual((await w.handlers["finance-open-folder"](w.good, { which: "drop" })).ok, false);
  await w.handlers["finance-load"]({ sender: {}, senderFrame: {} });
  assert.ok(w.logs.length >= 2, "the error and refusal paths really logged: " + JSON.stringify(w.logs));
  for (const l of w.logs) {
    assert.ok(/^finance-[a-z-]+ (refused: not the main window|failed: code=[A-Za-z0-9_]+|read failed: code=[A-Za-z0-9_]+)$/.test(l), "log format: " + l);
    assert.ok(!/₪|1,234|Sponsor|demo|secret|\\/.test(l), "no data in: " + l);
  }
});
t("ipc: open-folder takes only 'drop' or 'vault'; prefs keep only a known tab, are written atomically, keep vaultDir, and a corrupt file is never overwritten (S3)", async () => {
  const w = world();
  assert.strictEqual((await w.handlers["finance-open-folder"](w.good, { which: "drop" })).ok, true);
  assert.strictEqual((await w.handlers["finance-open-folder"](w.good, { which: "vault" })).ok, true);
  assert.strictEqual((await w.handlers["finance-open-folder"](w.good, { which: "C:\\Windows" })).ok, false);
  assert.deepStrictEqual(w.opened, [path.join(w.ud, "finance-vault", "drop"), path.join(w.ud, "finance-vault")]);
  const pf = path.join(w.ud, "finance_prefs.json"), vd = path.join(w.ud, "v2");
  fs.writeFileSync(pf, JSON.stringify({ vaultDir: vd }));
  assert.strictEqual((await w.handlers["finance-prefs-set"](w.good, { tab: "import" })).ok, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(pf, "utf8")), { vaultDir: vd, tab: "import" }, "vaultDir kept");
  assert.strictEqual((await w.handlers["finance-prefs-get"](w.good)).prefs.tab, "import");
  assert.ok(!fs.readdirSync(w.ud).some((f) => /\.tmp$/.test(f)), "no temp file left");
  fs.writeFileSync(pf, "{\"vaultDir\": \"" + vd.replace(/\\/g, "\\\\") + "\", \"tab\": ");   // half-written
  assert.strictEqual((await w.handlers["finance-prefs-set"](w.good, { tab: "overview" })).ok, false);
  assert.ok(fs.readFileSync(pf, "utf8").includes("vaultDir"), "corrupt file left untouched");
  assert.strictEqual((await w.handlers["finance-prefs-set"](w.good, { tab: "../evil" })).ok, false);
  assert.deepStrictEqual(MF.TABS, ["home", "overview", "accounts", "transactions", "categories", "receipts", "import", "accountant"]);
});

// ------------------------------------------------------------------ static guards
const files = () => fs.readdirSync(path.join(SRC, "finance")).map((f) => path.join(SRC, "finance", f)).concat(["finance.js", "finance-nav.js"].map((f) => path.join(SRC, "renderer", f)));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
t("guards: no network, no credentials, no console output, no shell/eval/storage/clipboard/innerHTML/title in the finance code", () => {
  for (const f of files()) {
    const s = strip(fs.readFileSync(f, "utf8")), name = path.basename(f);
    assert.ok(!/console\.(log|info|debug|warn|error|trace|dir|table)\s*\(/.test(s), "console output in " + name);
    for (const re of [/require\(["'](https?|net|tls|dgram|dns|child_process)["']\)/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /https?:\/\//, /document\.title/, /clipboard/i, /localStorage/, /sessionStorage/, /indexedDB/, /\beval\s*\(/, /new Function/, /innerHTML/, /insertAdjacentHTML/, /\bexec\s*\(/, /shell:\s*true/, /password|passwd|token|apikey|api_key|credential/i, /unlinkSync\(file\)/]) assert.ok(!re.test(s), name + " matches " + re);
  }
  const ren = strip(fs.readFileSync(path.join(SRC, "renderer", "finance.js"), "utf8"));
  assert.ok(!/openExternal|openPath|shell\./.test(ren), "the renderer never opens anything itself; it asks main");
});
t("guards: lightness - lazy view and css, only the nav at startup, no intervals/observers, two timers; wiring in every shared file", () => {
  for (const f of files()) assert.ok(!/setInterval|requestAnimationFrame|MutationObserver|IntersectionObserver/.test(strip(fs.readFileSync(f, "utf8"))), path.basename(f));
  const view = strip(fs.readFileSync(path.join(SRC, "renderer", "finance.js"), "utf8"));
  assert.strictEqual((view.match(/setTimeout\(/g) || []).length, 2, "the search debounce and the toast fade only");
  assert.ok(/api\.closed\(\)/.test(view), "closing the view tells main to drop the cached ledger");
  const html = fs.readFileSync(path.join(SRC, "renderer", "index.html"), "utf8");
  assert.ok(html.includes("finance-nav.js") && html.includes("styles-finance-nav.css") && !/"finance\.js"/.test(html) && !html.includes("styles-finance.css"));
  assert.ok(html.indexOf("finance-nav.js") > html.indexOf("health-nav.js") && html.indexOf("finance-nav.js") < html.indexOf("<script src=\"leftpane.js\">"));
  const nav = fs.readFileSync(path.join(SRC, "renderer", "finance-nav.js"), "utf8");
  assert.ok(/dataset\.systemNav = "finance"/.test(nav) && /\.health-nav/.test(nav) && /link\[href="styles-finance\.css"\]/.test(nav));
  assert.ok(/id: "finance"[^}]*finance-open/.test(fs.readFileSync(path.join(SRC, "renderer", "viewmanager.js"), "utf8")));
  assert.ok(/PHEME_OVERLAY_CLASSES = \[[^\]]*"finance-open"/.test(fs.readFileSync(path.join(SRC, "renderer", "renderer.js"), "utf8")));
  assert.ok(/finance:\s*\[\["rect"/.test(fs.readFileSync(path.join(SRC, "renderer", "leftpane.js"), "utf8")) && fs.readFileSync(path.join(SRC, "renderer", "styles-leftpane.css"), "utf8").includes("finance-nav-name"));
  assert.ok(/if \(!demo\.ON\) \{\s*try \{\s*require\("\.\/finance\/main-finance"\)\.init/.test(fs.readFileSync(path.join(SRC, "main.js"), "utf8")));
  assert.ok(/querySelectorAll\("\.finance-nav"\)\.forEach\(\(n\) => n\.remove\(\)\)/.test(fs.readFileSync(path.join(SRC, "demo", "renderer", "demo-ui.js"), "utf8")));
  const LP = require("../src/leftpane");
  assert.deepStrictEqual(LP.planTiles(["argus", "library"], ["health", "finance", "tools", "research"]).filter((x) => x.kind === "live").map((x) => x.id), ["argus", "library", "health", "finance", "tools", "research"]);
});
t("guards: design - tabs from the report, named render functions, demo banner, confirm before archiving, dir=auto, 3 weights, nothing under 12 px (view AND nav css), tokens only", () => {
  const js = fs.readFileSync(path.join(SRC, "renderer", "finance.js"), "utf8"), css = fs.readFileSync(path.join(SRC, "renderer", "styles-finance.css"), "utf8"), navCss = fs.readFileSync(path.join(SRC, "renderer", "styles-finance-nav.css"), "utf8");
  for (const w of ["Overview", "Accounts", "Transactions", "Categories & rules", "Receipts", "Import", "For the accountant"]) assert.ok(js.includes('label: "' + w + '"'), w);
  for (const fn of ["renderHeader", "renderBanner", "renderTabs", "renderEmpty", "renderTile", "renderOverview", "renderMonthChart", "renderLegend", "renderCategoryBars", "renderAccounts", "renderTransactions", "renderTxRows", "renderCategories", "renderCatTable", "renderRules", "renderReceipts", "renderImport", "renderConfirmButton", "renderImportFile", "renderAccountant", "renderState"]) assert.ok(new RegExp("function " + fn + "\\(").test(js), fn);
  assert.ok(js.includes("Demo data - not real.") && /S\.snap\.synthetic/.test(js));
  assert.ok(/renderConfirmButton\("Remove demo data"/.test(js) && /move it to the archive/.test(js), "remove asks once more and says nothing is deleted");
  assert.ok(/mf-bar-v", grp\(v\)/.test(js), "every bar prints its actual number");
  assert.ok(/"▲ /.test(js) && /"▼ /.test(js) && /Money in ▲/.test(js) && /Money out ▼/.test(js));
  assert.ok((js.match(/auto\(/g) || []).length >= 12 && /auto\(el\("option"/.test(js), "Hebrew text (incl. select options) gets dir=auto");
  assert.ok(/aria-selected/.test(js) && /role", "tablist"/.test(js) && /role", "status"/.test(js));
  for (const [name, c] of [["styles-finance.css", css], ["styles-finance-nav.css", navCss]]) {
    assert.ok(!/font-size:\s*([0-9]|1[01])(\.\d+)?px/.test(c), "nothing under 12 px in " + name);
    assert.ok(!/font-size:\s*[\d.]+(em|rem)/.test(c), "no em/rem sizes in " + name);
  }
  assert.deepStrictEqual([...new Set((css.match(/font-weight:\s*(\d+)/g) || []).map((x) => x.replace(/\D/g, "")))].sort(), ["400", "600", "700"], "three weights");
  const body = css.slice(css.indexOf("#finance-view {"));
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(body.replace(/#finance-view/g, "").replace(/(:root|body\.dark, html\[data-theme="dark"\] body)\s*\{[^}]*\}/g, "")), "no literal colours outside the token blocks");
  assert.ok(!/\.mf-cbar-(en|prev) \{[^}]*text-overflow: ellipsis/.test(css), "category names and comparisons wrap, never cut (S8)");
  assert.strictEqual((css.match(/^\.mf-two \.mf-cbar \{/gm) || []).length, 1, "no duplicate rule (R6)");
});

(async () => {
  for (const q of queue) {
    n++;
    try { await q.fn(); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); }
  }
  console.log(fails ? fails + " of " + n + " FAILED" : "finance: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
