// node tests/finance-feed.test.js - MY FINANCE feed (v1.129.0 slice 1, v1.130.0 slice 2: feed pages): validator (schema v0.2), reader refusals, scope filter / Home view,
// the finance-feed IPC channel, the config keys, and static guards (nothing hard-coded, read-only, no figures in logs). Synthetic data only
// (tests/fixtures/finance_feed_synthetic.json). Writes only into temp folders.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const V = require("../src/finance/feedValidator");
const R = require("../src/finance/feedReader");
const MF = require("../src/finance/main-finance");
const { createAppConfig } = require("../src/appConfig");

let n = 0, fails = 0; const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const SRC = path.join(__dirname, "..", "src");
const FIX = path.join(__dirname, "fixtures", "finance_feed_synthetic.json");
const good = () => JSON.parse(fs.readFileSync(FIX, "utf8"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "finance-feed-test-"));
const bad = (mut) => { const f = good(); mut(f); return V.validateFeed(f); };
const firstErr = (r) => { assert.strictEqual(r.ok, false); return r.errors[0]; };

// ------------------------------------------------------------------ validator
t("validator: the synthetic feed is valid; unknown extra fields are ignored", () => {
  const r = V.validateFeed(good());
  assert.deepStrictEqual(r, { ok: true, errors: [] });
  const f = good(); f.brand_new_section = { anything: [1, 2, 3] }; f.balances[0].extra = "x"; f.balances[0].nis_note = null;
  assert.strictEqual(V.validateFeed(f).ok, true);
});
t("validator: not an object / required top-level keys", () => {
  for (const x of [null, [], "x", 5, undefined]) assert.strictEqual(V.validateFeed(x).ok, false);
  for (const k of ["feed_version", "generated_at", "synthetic", "sources", "balances", "periods"]) {
    const r = bad((f) => { delete f[k]; });
    assert.ok(r.errors.some((e) => e.startsWith(k + ": required")), "missing " + k + " -> " + JSON.stringify(r.errors));
  }
});
t("validator: version - major 0 only, a higher major is refused, garbage refused", () => {
  assert.strictEqual(bad((f) => { f.feed_version = "0.9"; }).ok, true, "a newer minor is read");
  assert.strictEqual(bad((f) => { f.feed_version = "0.2.1"; }).ok, true);
  assert.ok(/newer feed refused/.test(firstErr(bad((f) => { f.feed_version = "1.0"; }))));
  assert.ok(/newer feed refused/.test(firstErr(bad((f) => { f.feed_version = "2.3.1"; }))));
  assert.strictEqual(bad((f) => { f.feed_version = "v0.2"; }).ok, false);
  assert.strictEqual(bad((f) => { f.feed_version = 0.2; }).ok, false);
});
t("validator: Money shape - finite numbers, known currency, ILS nis equals amount, dates", () => {
  const e1 = firstErr(bad((f) => { f.balances[0].currency = "GBP"; })); assert.ok(/^balances\[0\]\.currency/.test(e1), e1);
  assert.ok(/nis_total\.all\.amount/.test(firstErr(bad((f) => { f.nis_total.all.amount = "5"; }))));
  assert.ok(/nis_total\.all\.nis/.test(firstErr(bad((f) => { f.nis_total.all.nis = null; }))));
  assert.strictEqual(bad((f) => { f.nis_total.all.amount = Infinity; }).ok, false, "Infinity is not finite");
  assert.strictEqual(bad((f) => { f.nis_total.all.nis = NaN; }).ok, false);
  assert.ok(/currency/.test(firstErr(bad((f) => { f.nis_total.all.currency = "ils"; }))), "currency is case-exact");
  assert.ok(/must equal/.test(firstErr(bad((f) => { f.nis_total.all.nis = f.nis_total.all.amount + 1; }))), "ILS amount != nis");
  assert.ok(/rate_date/.test(firstErr(bad((f) => { f.vat.periods[0].charged.rate_date = "15/10/2026"; }))));
  assert.ok(/as_of/.test(firstErr(bad((f) => { f.vat.periods[0].charged.as_of = "2026-02-30"; }))), "30 Feb is not a day");
  assert.ok(/\.rate/.test(firstErr(bad((f) => { f.invoices.rows[0].money.rate = "3.6"; }))));
});
t("validator: dates, period ids, enums", () => {
  assert.ok(/generated_at/.test(firstErr(bad((f) => { f.generated_at = "yesterday"; }))));
  assert.ok(/last_import_date/.test(firstErr(bad((f) => { f.sources[0].last_import_date = "2026-13-01"; }))));
  assert.ok(/periods\[0\]\.id/.test(firstErr(bad((f) => { f.periods[0].id = "2026-13"; }))));
  assert.ok(/sources\[0\]\.kind/.test(firstErr(bad((f) => { f.sources[0].kind = "crypto"; }))));
  assert.ok(/sources\[0\]\.scope/.test(firstErr(bad((f) => { f.sources[0].scope = "mine"; }))));
  assert.ok(/invoices\.rows\[0\]\.status/.test(firstErr(bad((f) => { f.invoices.rows[0].status = "late"; }))));
  assert.ok(/direction/.test(firstErr(bad((f) => { f.invoices.rows[0].direction = "sideways"; }))));
  assert.ok(/match_status/.test(firstErr(bad((f) => { f.transactions[0].match_status = "maybe"; }))));
  assert.ok(/\.scope/.test(firstErr(bad((f) => { f.needs_you.items[0].scope = "all"; }))), "row scope is business|personal only");
  assert.ok(/synthetic/.test(firstErr(bad((f) => { f.synthetic = "yes"; }))));
});
t("validator: 5000-row caps", () => {
  const f = good(); f.transactions = Array.from({ length: V.MAX_ROWS }, () => good().transactions[0]);
  assert.strictEqual(V.validateFeed(f).ok, true, "exactly 5000 is allowed");
  f.transactions.push(good().transactions[0]);
  const r = V.validateFeed(f); assert.ok(/transactions: has more than 5000 rows/.test(firstErr(r)));
  const g = good(); g.sources = Array.from({ length: 5001 }, () => g.sources[0]); assert.ok(/sources: has more than 5000/.test(firstErr(V.validateFeed(g))));
  const h = good(); h.invoices.rows = Array.from({ length: 5001 }, () => ({})); assert.ok(/invoices\.rows/.test(firstErr(V.validateFeed(h))));
});
t("validator: errors never carry a value from the feed; the list is capped", () => {
  const f = good(); f.balances[0].amount = "SECRET-12345"; f.balances[0].currency = "GBP"; f.sources[0].label = "";
  const r = V.validateFeed(f); assert.strictEqual(r.ok, false);
  assert.ok(!JSON.stringify(r.errors).includes("SECRET") && !JSON.stringify(r.errors).includes("12345") && !JSON.stringify(r.errors).includes("GBP"));
  const g = good(); g.balances = Array.from({ length: 300 }, () => ({})); const rg = V.validateFeed(g);
  assert.ok(rg.errors.length <= V.MAX_ERRORS + 1, "capped: " + rg.errors.length);
});

// ------------------------------------------------------------------ reader
function writeFeed(dir, obj) { fs.mkdirSync(dir, { recursive: true }); const p = path.join(dir, "finance_feed.json"); fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj)); return p; }
t("reader: reads a valid feed from a private folder (read-only: the file is untouched)", () => {
  const dir = path.join(tmp(), "finance", "feed"), p = writeFeed(dir, good());
  const before = fs.readFileSync(p), mt = fs.statSync(p).mtimeMs;
  const r = R.createFeedReader({ getPath: () => p, appDir: path.join(tmp(), "app") }).readFeed();
  assert.strictEqual(r.ok, true); assert.strictEqual(r.feed.balances.length, 6);
  assert.ok(before.equals(fs.readFileSync(p)) && fs.statSync(p).mtimeMs === mt, "file unchanged");
  assert.deepStrictEqual(fs.readdirSync(dir), ["finance_feed.json"], "nothing else written beside it");
});
t("reader: refusals - no path, missing file, bad JSON, invalid feed (first error only), newer major, BOM ok", () => {
  const log = [];
  const mk = (p) => R.createFeedReader({ getPath: () => p, appDir: path.join(tmp(), "app"), log: (l) => log.push(l) }).readFeed();
  assert.strictEqual(mk(null).code, "NOPATH"); assert.strictEqual(mk("").code, "NOPATH");
  const dir = path.join(tmp(), "f");
  assert.strictEqual(mk(path.join(dir, "nope.json")).code, "MISSING");
  assert.strictEqual(mk(writeFeed(dir, "{not json")).code, "PARSE");
  const f = good(); f.balances[0].currency = "XXX";
  const r = mk(writeFeed(dir, f)); assert.strictEqual(r.code, "SCHEMA"); assert.strictEqual(r.reason, "Feed invalid"); assert.ok(/balances\[0\]\.currency/.test(r.firstError));
  const g = good(); g.feed_version = "1.0"; assert.ok(/newer feed refused/.test(mk(writeFeed(dir, g)).firstError));
  assert.strictEqual(mk(writeFeed(dir, "\uFEFF" + JSON.stringify(good()))).ok, true, "a BOM is tolerated");
  assert.strictEqual(mk(dir).code, "NOT_PLAIN_FILE", "a folder is not a feed");
  for (const l of log) assert.ok(/^finance-feed (refused|invalid|read failed): code=[A-Z_a-z0-9]+$/.test(l), "log format: " + l);
});
t("reader: refuses a feed inside a cloud-synced folder, a network path, and the app folder (same check as the vault)", () => {
  const root = tmp(), appDir = path.join(root, "app");
  for (const seg of ["Dropbox", "OneDrive - Acme", "Google Drive", "iCloudDrive"]) {
    const p = writeFeed(path.join(root, seg, "finance"), good());
    const r = R.createFeedReader({ getPath: () => p, appDir }).readFeed();
    assert.strictEqual(r.code, "UNSAFE_FOLDER", seg); assert.ok(/cloud-synced/.test(r.reason), seg + ": " + r.reason);
  }
  assert.strictEqual(R.createFeedReader({ getPath: () => "\\\\server\\share\\finance_feed.json" }).readFeed().code, "UNSAFE_FOLDER");
  const inApp = writeFeed(path.join(appDir, "data"), good());
  assert.strictEqual(R.createFeedReader({ getPath: () => inApp, appDir }).readFeed().code, "UNSAFE_FOLDER");
  assert.strictEqual(R.createFeedReader({ getPath: () => "relative/finance_feed.json" }).readFeed().code, "UNSAFE_FOLDER", "a relative path is refused");
});
t("reader: refuses a symlinked file and an oversized file", () => {
  const dir = path.join(tmp(), "feed"), p = writeFeed(dir, good()), link = path.join(dir, "link.json");
  let made = true; try { fs.symlinkSync(p, link); } catch (e) { made = false; }
  if (made) assert.strictEqual(R.createFeedReader({ getPath: () => link }).readFeed().code, "NOT_PLAIN_FILE");
  const fake = (over) => Object.assign({
    lstatSync: () => ({ isSymbolicLink: () => false, ino: 5, dev: 1 }), openSync: () => 99, closeSync: () => { fake.closed = (fake.closed || 0) + 1; },
    fstatSync: () => ({ isFile: () => true, size: 10, ino: 5, dev: 1 }), readSync: (fd, buf, off, len) => { buf.fill(32, off, off + len); return len; } }, over);
  const rd = (over) => R.createFeedReader({ getPath: () => p, fs: fake(over) }).readFeed();
  assert.strictEqual(rd({ fstatSync: () => ({ isFile: () => true, size: R.MAX_BYTES + 1, ino: 5, dev: 1 }), readSync: () => { throw new Error("must not read"); } }).code, "TOO_BIG");
  assert.strictEqual(rd({ fstatSync: () => ({ isFile: () => false, size: 1, ino: 5, dev: 1 }) }).code, "NOT_PLAIN_FILE", "the descriptor is not a regular file (device, pipe, folder)");
  assert.strictEqual(rd({ fstatSync: () => ({ isFile: () => true, size: 10, ino: 6, dev: 1 }) }).code, "CHANGED", "the path now points at another file than the one opened");
  let calls = 0;
  assert.strictEqual(rd({ fstatSync: () => ({ isFile: () => true, size: ++calls === 1 ? 10 : 11, ino: 5, dev: 1 }) }).code, "CHANGED", "the file grew while it was read");
  assert.strictEqual(rd({ readSync: () => 0 }).code, "CHANGED", "a short read (file truncated) is refused");
  fake.closed = 0; rd({}); rd({ fstatSync: () => ({ isFile: () => false, size: 1, ino: 5, dev: 1 }) });
  assert.strictEqual(fake.closed, 2, "the descriptor is always closed");
  assert.strictEqual(rd({ openSync: () => { const e = new Error("x"); e.code = "EACCES"; throw e; } }).code, "READ");
  // a real file is read through one descriptor and still works
  const real = R.createFeedReader({ getPath: () => p }).readFeed(); assert.strictEqual(real.ok, true);
});

t("validator: a malicious string in a numeric/text field never reaches the first error (path + rule only)", () => {
  const evil = "<img src=x onerror=alert(1)>";
  for (const mut of [(f) => { f.balances[0].amount = evil; }, (f) => { f.nis_total.all.nis = evil; }, (f) => { f.balances[0].currency = evil; }, (f) => { f.generated_at = evil; }, (f) => { f.periods[0].id = evil; }, (f) => { f.sources[0].kind = evil; }, (f) => { f.feed_version = evil; }, (f) => { f.invoices.rows[0].status = evil; }]) {
    const f = good(); mut(f); const r = V.validateFeed(f); assert.strictEqual(r.ok, false);
    for (const e of r.errors) assert.ok(!/img|onerror|alert|<|>/.test(e), "value leaked: " + e);
  }
  const dir = path.join(tmp(), "feed"); const f = good(); f.balances[0].amount = evil;
  const r = R.createFeedReader({ getPath: () => writeFeed(dir, f), appDir: path.join(tmp(), "app") }).readFeed();
  assert.strictEqual(r.code, "SCHEMA"); assert.ok(/^balances\[0\]\.amount: must be a finite number$/.test(r.firstError), r.firstError);
  const w = world(writeFeed(path.join(tmp(), "e"), f)); return w.handlers["finance-feed"](w.good, { scope: "all" }).then((x) => { assert.ok(!JSON.stringify(x).match(/img|onerror/), "nothing from the value in the IPC answer"); });
});
t("main window: https links open in the OS browser, every window.open is denied, navigation away from the app page is cancelled (src/main.js)", () => {
  const m = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
  const i = m.indexOf("setWindowOpenHandler(");
  assert.ok(i > 0, "a window-open handler exists");
  const blk = m.slice(i, i + 260);
  assert.ok(/\/\^https:/.test(blk) && !blk.includes("https?:") && /shell\.openExternal\(url\)/.test(blk) && /action: "deny"/.test(blk), "https opens externally, the new window is always denied");
  assert.ok(/on\("will-navigate", \(event, url\) => \{ if \(url !== ownUrl\(\)\) event\.preventDefault\(\); \}\)/.test(m), "will-navigate cancels anything but the app page");
  assert.ok(/on\("will-redirect", \(event, url\) => \{ if \(url !== ownUrl\(\)\) event\.preventDefault\(\); \}\)/.test(m), "will-redirect too");
  const js = fs.readFileSync(path.join(SRC, "renderer", "finance.js"), "utf8");
  assert.ok(/a\.target = "_blank"/.test(js), "the Home link relies on that handler");
});

// ------------------------------------------------------------------ scope filter and Home view
t("scope: business / personal / all filter sources, balances, totals, VAT, needs-you; the freshness is recomputed from today", () => {
  const f = good(), H = (s) => R.homeView(f, s, { today: "2026-10-16" });
  const b = H("business"), p = H("personal"), a = H("all");
  assert.strictEqual(b.balances.length, 5); assert.strictEqual(p.balances.length, 1); assert.strictEqual(a.balances.length, 6);
  assert.deepStrictEqual(p.balances.map((x) => x.source), ["card_p"]);
  assert.strictEqual(b.total.nis, 85066); assert.strictEqual(p.total.nis, -4980); assert.strictEqual(a.total.nis, 80086);
  assert.ok(b.vat && b.vat.current.result === 1860 && b.vat.previous.result === 1540 && a.vat && p.vat === null, "VAT is business-only");
  assert.strictEqual(b.needs.count, 2); assert.strictEqual(p.needs.count, 1); assert.strictEqual(a.needs.count, 3);
  assert.strictEqual(p.invoices.unpaid.count, 0, "no personal invoices"); assert.strictEqual(a.invoices.unpaid.count, 4, "all = the feed summary");
  assert.strictEqual(b.invoices.overdue.count, 1);
  assert.deepStrictEqual(a.stale.map((s) => s.id).sort(), ["bank_a_usd", "bank_b_ils"], "7-day rule: 13 and 9 days are stale, 4 is not");
  assert.strictEqual(a.sources.find((s) => s.id === "bank_a_ils").fresh, true);
  f.sources[0].fresh = false; assert.strictEqual(H("all").sources.find((s) => s.id === "bank_a_ils").fresh, true, "the pane trusts its own computation");
  const at = (d) => R.homeView(f, "all", { today: d }).sources.find((s) => s.id === "bank_a_ils");
  assert.deepStrictEqual([at("2026-10-22").age_days, at("2026-10-22").fresh], [7, true], "7 days exactly is fresh");
  assert.deepStrictEqual([at("2026-10-23").age_days, at("2026-10-23").fresh], [8, false], "8 days is stale");
});
t("scope: unknown scope falls back to all; periods this/last/trend; 'all' without feed rows adds business + personal", () => {
  const f = good();
  assert.strictEqual(R.homeView(f, "evil", { today: "2026-10-16" }).scope, "all");
  assert.strictEqual(R.homeView(f, undefined, { today: "2026-10-16" }).scope, "all");
  const b = R.homeView(f, "business", { today: "2026-10-16" });
  assert.strictEqual(b.period.this.id, "2026-10"); assert.strictEqual(b.period.last.id, "2026-09"); assert.strictEqual(b.trend.length, 6);
  assert.strictEqual(b.period.this.income, 31200); assert.strictEqual(b.period.last.income, 28900);
  const a = R.homeView(f, "all", { today: "2026-10-16" });
  assert.strictEqual(a.period.this.income, 31200 + 5000); assert.strictEqual(a.period.this.expenses, 22400 + 4200);
});
t("home view: login links come only from config, https only, no credentials in the address; empty = no link", () => {
  const L = R.parseLoginLinks("bank_a_ils=https://login.example.test/a; paypal=http://insecure.test/x;bad id=https://x.test;card_p=https://u:p@evil.test/;card_b=javascript:alert(1);=https://x.test;bank_b_ils=https://ok.test/path?q=1");
  assert.deepStrictEqual(Object.keys(L).sort(), ["bank_a_ils", "bank_b_ils"]);
  assert.deepStrictEqual(R.parseLoginLinks(""), Object.create(null)); assert.deepStrictEqual(Object.keys(R.parseLoginLinks(null)), []);
  const h = R.homeView(good(), "all", { today: "2026-10-16", loginLinks: L });
  assert.strictEqual(h.sources.find((s) => s.id === "bank_a_ils").link, "https://login.example.test/a");
  assert.strictEqual(h.sources.find((s) => s.id === "paypal").link, null);
  assert.strictEqual(R.homeView(good(), "all", { today: "2026-10-16" }).sources.every((s) => s.link === null), true);
  assert.strictEqual(Object.keys(R.parseLoginLinks("__proto__=https://x.test;constructor=https://y.test")).length, 2, "ids that look like prototype members are plain keys");
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(R.homeView(good(), "all", { today: "2026-10-16", loginLinks: R.parseLoginLinks("__proto__=https://x.test") }).sources.every((s) => s.link === null || s.id === "__proto__"), true);
});
t("home view: carries the synthetic flag; Hebrew labels pass through untouched", () => {
  const f = good(); f.sources[0].label = "בנק א׳, שקל";
  const h = R.homeView(f, "all", { today: "2026-10-16" });
  assert.strictEqual(h.synthetic, true); assert.strictEqual(h.balances[0].label, "בנק א׳, שקל");
  f.synthetic = false; assert.strictEqual(R.homeView(f, "all", { today: "2026-10-16" }).synthetic, false);
});

// ------------------------------------------------------------------ IPC channel
function world(feedPath, links, extra) {
  const handlers = {}, logs = [], wc = { mainFrame: {} }, win = { webContents: wc, isDestroyed: () => false }, ud = tmp();
  MF.init(Object.assign({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, getMainWindow: () => win, userData: ud, appDir: path.join(ud, "app"), testMode: true, log: (l) => logs.push(l), env: {},
    feedConfig: { path: () => feedPath, links: () => links || null }, today: () => "2026-10-16" }, extra || {}));
  return { handlers, logs, good: { sender: wc, senderFrame: wc.mainFrame }, wc };
}
t("ipc: finance-feed answers the main window only, takes a scope string only, never a path; failures give a reason and a code", async () => {
  const p = writeFeed(path.join(tmp(), "finance", "feed"), good());
  const w = world(p, "bank_a_ils=https://login.example.test/a");
  const ok = await w.handlers["finance-feed"](w.good, { scope: "business" });
  assert.strictEqual(ok.ok, true); assert.strictEqual(ok.view.scope, "business"); assert.strictEqual(ok.view.balances.length, 5);
  assert.strictEqual(ok.view.sources.find((s) => s.id === "bank_a_ils").link, "https://login.example.test/a");
  assert.strictEqual((await w.handlers["finance-feed"](w.good, { scope: "x" })).view.scope, "all");
  assert.strictEqual((await w.handlers["finance-feed"](w.good)).view.scope, "all");
  assert.strictEqual((await w.handlers["finance-feed"](w.good, { scope: "all", path: "C:\\evil.json" })).view.balances.length, 6, "a renderer-supplied path is ignored");
  for (const bad of [{ sender: {}, senderFrame: {} }, { sender: w.wc, senderFrame: {} }, { sender: w.wc, senderFrame: null }]) assert.strictEqual((await w.handlers["finance-feed"](bad, { scope: "all" })).ok, false);
  assert.strictEqual((await w.handlers["finance-feed"](w.good, [1])).ok, false); assert.strictEqual((await w.handlers["finance-feed"](w.good, "all")).ok, false);
  assert.strictEqual((await w.handlers["finance-feed"](w.good, { scope: "x".repeat(3000) })).ok, false);
  const none = world(path.join(tmp(), "none.json")); const r = await none.handlers["finance-feed"](none.good, { scope: "all" });
  assert.deepStrictEqual([r.ok, r.code], [false, "MISSING"]);
  const badFeed = good(); badFeed.balances[0].nis = "x"; const inv = world(writeFeed(path.join(tmp(), "i"), badFeed));
  const ri = await inv.handlers["finance-feed"](inv.good, { scope: "all" }); assert.strictEqual(ri.reason, "Feed invalid"); assert.ok(/balances\[0\]\.nis/.test(ri.firstError));
  assert.ok(!("view" in ri) && !("feed" in ri), "an invalid feed returns no partial data");
});
t("ipc: logs carry channel names and codes only - no figures, names or paths", async () => {
  const f = good(); f.sources[0].label = "Secret Bank 99999"; f.balances[0].nis = 12345.67; f.balances[0].amount = 12345.67;
  const dir = path.join(tmp(), "Dropbox", "secret-dir"); const p = writeFeed(dir, f);
  const w = world(p); await w.handlers["finance-feed"](w.good, { scope: "all" });   // unsafe folder -> logged
  const w2 = world(writeFeed(path.join(tmp(), "ok"), Object.assign(good(), { balances: [{ bad: 12345.67 }] }))); await w2.handlers["finance-feed"](w2.good, { scope: "all" });
  await w2.handlers["finance-feed"]({ sender: {}, senderFrame: {} }, { scope: "all" });
  const all = w.logs.concat(w2.logs); assert.ok(all.length >= 3, JSON.stringify(all));
  for (const l of all) { assert.ok(/^finance-feed (refused: (not the main window|code=[A-Z_]+)|invalid: code=[A-Z]+|read failed: code=[A-Za-z0-9_]+)$/.test(l), "log format: " + l); assert.ok(!/12345|Secret|secret|Dropbox|\\/.test(l), "no data in: " + l); }
});

// ------------------------------------------------------------------ slice 2: feed pages (v1.130.0)
const FP = require("../src/finance/feedPages");
const PG = (page, scope, o) => FP.pageView(good(), page, scope, Object.assign({ today: "2026-10-16" }, o || {}));
t("pages: every page exists, carries scope/synthetic/as_of, and unknown pages are null", () => {
  assert.deepStrictEqual(FP.PAGES.slice().sort(), ["accounts", "cards", "cash", "expenses", "income", "invoices", "package", "queue", "rates", "sources", "vat"]);
  for (const p of FP.PAGES) for (const s of ["business", "personal", "all"]) {
    const v = PG(p, s); assert.ok(v, p); assert.strictEqual(v.page, p); assert.strictEqual(v.scope, s); assert.strictEqual(v.synthetic, true);
    if (!v.empty && !(p === "vat" && !v.periods.length)) assert.ok(typeof v.as_of === "string" || v.as_of === null, p + " has an as_of");
    JSON.stringify(v);   // plain data only
  }
  assert.strictEqual(FP.pageView(good(), "nope", "all", {}), null);
  assert.strictEqual(PG("cards", "evil").scope, "all");
});
t("pages: credit cards - cycle, due date, receipt matched/missing, original + NIS, instalments, scope", () => {
  const b = PG("cards", "business"), p = PG("cards", "personal"), a = PG("cards", "all");
  assert.strictEqual(b.cards.length, 1); assert.strictEqual(p.cards.length, 1); assert.strictEqual(a.cards.length, 2);
  const c = b.cards[0]; assert.deepStrictEqual(c.cycle, { start: "2026-10-03", end: "2026-11-02" }); assert.strictEqual(c.due_date, "2026-11-02"); assert.strictEqual(c.due.nis, 2310); assert.strictEqual(c.due.as_of, "2026-10-12");
  assert.strictEqual(c.missing, 1); assert.strictEqual(c.charges.length, 4); assert.strictEqual(c.charges_total, 4);
  const usd = c.charges.find((x) => x.cur === "USD"); assert.deepStrictEqual([usd.amt, usd.nis], [29, 106]); assert.ok(["matched", "missing"].includes(usd.receipt));
  assert.deepStrictEqual(c.instalments, [{ category: "Equipment", n: 5, of: 12, left: 7, nis: 560 }]);
  assert.strictEqual(c.charges[0].date >= c.charges[1].date, true, "newest first");
  assert.strictEqual(p.cards[0].instalments[0].left, 4);
});
t("pages: invoices - summary, status filter, paging, scope", () => {
  const a = PG("invoices", "all");
  assert.deepStrictEqual([a.summary.unpaid.count, a.summary.unpaid.nis, a.summary.overdue.count, a.summary.overdue.nis, a.summary.paid.count], [4, 9600, 1, 2400, 2]);
  assert.strictEqual(a.total, 7); assert.strictEqual(a.rows.length, 7);
  const od = PG("invoices", "all", { filter: "overdue" }); assert.deepStrictEqual(od.rows.map((r) => r.id), ["2026-0131"]); assert.strictEqual(od.filter, "overdue");
  assert.strictEqual(PG("invoices", "all", { filter: "weird" }).filter, null, "unknown filter ignored");
  assert.strictEqual(PG("invoices", "personal").total, 0); assert.strictEqual(PG("invoices", "personal").summary.unpaid.count, 0);
  const pg = PG("invoices", "all", { offset: 5 }); assert.strictEqual(pg.rows.length, 2); assert.strictEqual(pg.offset, 5);
  assert.ok(a.rows.every((r) => r.cur && typeof r.nis === "number"));
});
t("pages: income / expenses / vat", () => {
  const i = PG("income", "business");
  assert.strictEqual(i.total, 3640 + 6000 + 7280 + 5319); assert.strictEqual(i.by_client[0].month, "2026-10"); assert.ok(i.by_client.every((r) => r.share >= 0 && r.share <= 100));
  assert.deepStrictEqual(i.by_currency.map((r) => r.currency).sort(), ["EUR", "ILS", "USD"]);
  assert.deepStrictEqual(i.expected_vs_received.map((r) => [r.period, r.expected, r.received]), [["2026-10", 31200, 24100], ["2026-09", 28900, 28900]]);
  assert.strictEqual(PG("income", "personal").total, 900);
  const e = PG("expenses", "business"); assert.strictEqual(e.period, "2026-10"); assert.strictEqual(e.previous, "2026-09");
  const eq = e.categories.find((c) => c.category === "Equipment"); assert.deepStrictEqual([eq.this, eq.last, eq.change], [7900, 5200, 52]);
  assert.strictEqual(e.total.this, 7900 + 3400 + 4100 + 2700 + 1200); assert.strictEqual(PG("expenses", "personal").categories[0].change, null, "no previous period: no percentage");
  const v = PG("vat", "business"); assert.strictEqual(v.periods.length, 2); assert.strictEqual(v.periods[0].period, "2026-10"); assert.strictEqual(v.periods[0].to_check, 3);
  assert.deepStrictEqual(PG("vat", "personal").periods, []);
});
t("pages: accounts and transactions - match filter, paging (50), masked rows, scope", () => {
  const a = PG("accounts", "all");
  assert.strictEqual(a.transactions.length, 50); assert.strictEqual(a.total, 120); assert.strictEqual(a.limit, 50);
  assert.strictEqual(a.counts.matched + a.counts.unmatched + a.counts.needs_check, 120);
  const u = PG("accounts", "all", { filter: "unmatched" }); assert.strictEqual(u.total, a.counts.unmatched); assert.ok(u.transactions.every((x) => x.match === "unmatched"));
  const last = PG("accounts", "all", { offset: 100 }); assert.strictEqual(last.transactions.length, 20);
  assert.ok(Object.keys(a.transactions[0]).sort().join() === "amt,category,cur,date,match,nis,source,tag", "only masked fields: " + Object.keys(a.transactions[0]));
  const pe = PG("accounts", "personal"); assert.strictEqual(pe.balances.length, 1); assert.strictEqual(pe.total_nis, -4980); assert.strictEqual(pe.total, 30);
  assert.strictEqual(PG("accounts", "business").balances.length, 5);
  const bad = PG("accounts", "all", { offset: -4 }); assert.strictEqual(bad.offset, 0);
});
t("pages: needs you, accountant package (blocked, no send), rates, sources, cash flow", () => {
  const q = PG("queue", "all"); assert.strictEqual(q.count, 3); assert.strictEqual(q.items[0].age_days, 14, "oldest first"); assert.strictEqual(q.items[0].source, "Card B (business)"); assert.strictEqual(PG("queue", "personal").count, 1);
  const k = PG("package", "personal"); assert.deepStrictEqual([k.parts_ready, k.parts_total, k.items_to_check, k.send_blocked, k.reason, k.days_left, k.all_scopes], [4, 5, 3, true, "3 items to check", 15, true]);
  assert.deepStrictEqual(k.prev_month, { parts_ready: 3, items_to_check: 5 }); assert.strictEqual(k.parts.filter((p) => !p.ready).length, 1);
  const noStatus = good(); delete noStatus.accountant_package.status; assert.strictEqual(FP.pageView(noStatus, "package", "all", { today: "2026-10-16" }).send_blocked, true, "no status = blocked");
  const r = PG("rates", "business"); assert.deepStrictEqual(r.rates.map((x) => x.currency), ["USD", "EUR"]); assert.strictEqual(r.period_end.find((x) => x.currency === "USD").period, "2026-09"); assert.strictEqual(r.source_name, "Bank of Israel");
  assert.deepStrictEqual(r.holdings.map((h) => h.currency), ["ILS", "USD"]); assert.ok(PG("rates", "all").holdings.length >= 2);
  const s = PG("sources", "all"); assert.strictEqual(s.sources.length, 7); assert.strictEqual(s.sources.find((x) => x.id === "bank_a_usd").fresh, false); assert.strictEqual(s.sources.find((x) => x.id === "card_b").manual, true);
  assert.strictEqual(s.last_full_refresh, "2026-10-07"); assert.strictEqual(s.next_due, "2026-10-14"); assert.strictEqual(s.next_due_overdue, true);
  const c = PG("cash", "all"); assert.strictEqual(c.days.length, 60); assert.strictEqual(c.expected.length, 4); assert.ok(c.min <= c.now && c.min <= c.end); assert.strictEqual(c.expected[2].direction, "in");
  assert.strictEqual(PG("cash", "personal").days.length, 60, "the projection covers all accounts");
  const none = good(); delete none.cash_flow_60d; assert.strictEqual(FP.pageView(none, "cash", "all", {}).empty, true);
});
t("pages: payloads stay small and scope-filtered", () => {
  for (const p of FP.PAGES) assert.ok(JSON.stringify(PG(p, "all")).length < 30000, p + " payload " + JSON.stringify(PG(p, "all")).length);
  const f = good(); f.transactions = Array.from({ length: 5000 }, () => good().transactions[0]);
  assert.ok(JSON.stringify(FP.pageView(f, "accounts", "all", { today: "2026-10-16" })).length < 30000, "5000 transactions still give one page");
  const personal = JSON.stringify(PG("cards", "personal")) + JSON.stringify(PG("invoices", "personal")) + JSON.stringify(PG("income", "personal")) + JSON.stringify(PG("expenses", "personal"));
  assert.ok(!/Card B|Client A|Client B|Equipment/.test(personal), "a personal view carries no business rows");
});
t("ipc: finance-feed page argument - allow-listed page, integer offset, filter; bad page refused", async () => {
  const w = world(writeFeed(path.join(tmp(), "pg"), good()));
  const r = await w.handlers["finance-feed"](w.good, { scope: "business", page: "invoices", offset: 0, filter: "overdue" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.page.page, "invoices"); assert.strictEqual(r.page.total, 1); assert.ok(!("view" in r));
  assert.strictEqual((await w.handlers["finance-feed"](w.good, { scope: "all", page: "accounts", offset: 50 })).page.offset, 50);
  assert.strictEqual((await w.handlers["finance-feed"](w.good, { scope: "all", page: "accounts", offset: "50" })).page.offset, 0, "a non-integer offset is ignored");
  for (const bad of ["../x", "home2", 5, {}, "__proto__"]) assert.strictEqual((await w.handlers["finance-feed"](w.good, { scope: "all", page: bad })).ok, false, String(bad));
  assert.strictEqual((await w.handlers["finance-feed"](w.good, { scope: "all", page: null })).view.scope, "all", "no page = Home");
  assert.strictEqual((await w.handlers["finance-feed"](w.good, { scope: "all", page: "cards", filter: "x".repeat(3000) })).ok, false);
});
t("guards: finance-pages.js - read-only (no send/pay/save button), text only, no network or storage, every page and the home links exist", () => {
  const js = fs.readFileSync(path.join(SRC, "renderer", "finance-pages.js"), "utf8"), fin = fs.readFileSync(path.join(SRC, "renderer", "finance.js"), "utf8"), nav = fs.readFileSync(path.join(SRC, "renderer", "finance-nav.js"), "utf8");
  const code = strip(js);
  for (const re of [/innerHTML|insertAdjacentHTML/, /\bfetch\s*\(|XMLHttpRequest|WebSocket/, /localStorage|sessionStorage|indexedDB|clipboard/i, /\beval\s*\(|new Function/, /console\./, /password|passwd|token|apikey|credential/i, /https?:\/\//, /btn\("(Send|Pay|Approve|Submit|Save|Delete)/i]) assert.ok(!re.test(code), "finance-pages.js matches " + re);
  assert.ok(!/ipcRenderer|window\.api/.test(code), "the pages module never calls the app itself");
  for (const id of ["fcards", "finvoices", "fincome", "fexpenses", "fvat", "faccounts", "fqueue", "fpackage", "frates", "fsources", "fcash"]) { assert.ok(new RegExp(id + ": ").test(js), "page " + id); assert.ok(fin.includes('id: "' + id + '"'), "tab " + id); }
  for (const link of ['"faccounts"', '"fincome"', '"fvat"', '"finvoices"', '"fqueue"', '"fsources"', '"fcards"']) assert.ok(fin.includes("goLink(") && fin.includes(link), "home links to " + link);
  assert.ok(/blocked|Sending is blocked/.test(js) && /nothing can be sent from here/.test(js));
  assert.ok(/finance-pages\.js/.test(nav) && /load\("finance-pages\.js", view, view\)/.test(nav), "the pages module loads before finance.js");
  assert.ok(/Data as of/.test(js) && /\.mf-linkbtn/.test(fs.readFileSync(path.join(SRC, "renderer", "styles-finance.css"), "utf8")));
});

// ------------------------------------------------------------------ slice 3 (v1.131.0): Hebrew, hints, reader name check
t("reader: a file name with ':' (NTFS alternate data stream) is refused before anything is opened; ino 0 skips only the same-file check", () => {
  const dir = path.join(tmp(), "feed"), p = writeFeed(dir, good()); let opened = 0;
  const spy = { lstatSync: () => { opened++; return { isSymbolicLink: () => false, ino: 1, dev: 1 }; }, openSync: () => { opened++; return 9; }, fstatSync: () => ({ isFile: () => true, size: 2, ino: 1, dev: 1 }), readSync: (fd, b, o, l) => { b.fill(32, o, o + l); return l; }, closeSync: () => {} };
  for (const name of ["finance_feed.json:evil", "finance_feed.json::$DATA", "a:b.json"]) {
    const r = R.createFeedReader({ getPath: () => path.join(dir, name), fs: spy }).readFeed();
    assert.strictEqual(r.code, "BAD_NAME", name);
  }
  assert.strictEqual(opened, 0, "nothing was stat'ed or opened");
  const rd = (lst, st) => R.createFeedReader({ getPath: () => p, fs: Object.assign({}, spy, { lstatSync: () => Object.assign({ isSymbolicLink: () => false }, lst), fstatSync: () => Object.assign({ isFile: () => true, size: 2 }, st) }) }).readFeed().code;
  assert.strictEqual(rd({ ino: 0, dev: 1 }, { ino: 7, dev: 2 }), "PARSE", "ino 0: the same-file check is skipped (the content here is just blanks, so it gets as far as parsing)");
  assert.strictEqual(rd({ ino: 5, dev: 1 }, { ino: 0, dev: 1 }), "PARSE");
  assert.strictEqual(rd({ ino: 5, dev: 1 }, { ino: 7, dev: 1 }), "CHANGED", "real inodes that differ are refused");
  assert.ok(/skipped when the file system reports no inode/.test(fs.readFileSync(path.join(SRC, "finance", "feedReader.js"), "utf8")), "documented in the code");
});
t("hebrew: the Hebrew synthetic feed validates; Hebrew labels pass through every page unchanged; the mixed strips use bdi islands", () => {
  const he = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "finance_feed_hebrew.json"), "utf8"));
  assert.deepStrictEqual(V.validateFeed(he), { ok: true, errors: [] });
  const raw = JSON.stringify(he); assert.ok(/[\u0590-\u05FF]/.test(raw));
  const heb = (v) => (JSON.stringify(v).match(/[\u0590-\u05FF]+/g) || []).length;
  for (const p of ["cards", "invoices", "income", "expenses", "accounts", "queue", "sources", "cash"]) assert.ok(heb(FP.pageView(he, p, "all", { today: "2026-10-16" })) > 0, p + " carries Hebrew");
  assert.ok(heb(R.homeView(he, "all", { today: "2026-10-16" })) > 0);
  assert.strictEqual(FP.pageView(he, "cards", "business", { today: "2026-10-16" }).cards[0].label, "כרטיס עסקי (Max)");
  const fin = fs.readFileSync(path.join(SRC, "renderer", "finance.js"), "utf8");
  assert.ok(/el\("bdi", "", s\.label\)/.test(fin) && /el\("bdi", "", l\)/.test(fin) && /el\("bdi", "", b\.label\)/.test(fin), "stale strip, needs-you strip and balance names are bidi islands");
});
t("sources page: a hint to Setup (financeLoginLinks) when no login links are set; no hint when one is; the text has no literal address", () => {
  const none = FP.pageView(good(), "sources", "all", { today: "2026-10-16" });
  assert.strictEqual(none.links_set, 0); assert.ok(none.link_ids.includes("bank_a_ils"));
  const some = FP.pageView(good(), "sources", "all", { today: "2026-10-16", loginLinks: R.parseLoginLinks("bank_a_ils=https://login.example.test/a") });
  assert.strictEqual(some.links_set, 1);
  const js = fs.readFileSync(path.join(SRC, "renderer", "finance-pages.js"), "utf8");
  assert.ok(/No login links are set/.test(js) && /financeLoginLinks/.test(js) && /!P\.links_set/.test(js));
});
t("cash chart: the lowest point's label sits under the dot with room reserved below the line (no overlap with the line or the ticks)", () => {
  const js = fs.readFileSync(path.join(SRC, "renderer", "finance-pages.js"), "utf8");
  assert.ok(/B = 52/.test(js) && /Y\(d\.bal\) \+ 20/.test(js) && /mf-cash-low/.test(js) && /y1: Hh - B \+ 26/.test(js), "label y = dot + 20, ticks start at +26");
});

// ------------------------------------------------------------------ config keys
t("config: financeFeedPath resolves env > file > default under the work folder; nothing is hard-coded to a PC", () => {
  const ud = tmp(), env = {};
  const cfg = createAppConfig({ userDataDir: ud, env, platform: "win32" });
  assert.strictEqual(cfg.get("financeFeedPath"), path.win32.join(ud, "work", "finance", "feed", "finance_feed.json"), "default = <work folder>\\finance\\feed\\finance_feed.json");
  const other = path.win32.join(ud, "elsewhere", "f.json");
  assert.strictEqual(cfg.set("financeFeedPath", other, { skipExistsCheck: true }) && cfg.get("financeFeedPath") !== undefined, true);
  const cfg2 = createAppConfig({ userDataDir: ud, env: { AGENT_DESKTOP_FINANCE_FEED_PATH: "D:\\Private\\feed.json" }, platform: "win32" });
  assert.strictEqual(cfg2.get("financeFeedPath"), "D:\\Private\\feed.json", "env wins");
  assert.strictEqual(createAppConfig({ userDataDir: ud, env: { AGENT_DESKTOP_FINANCE_FEED_PATH: "relative.json" }, platform: "win32" }).get("financeFeedPath") !== "relative.json", true, "a relative path is not accepted");
});
t("config: financeLoginLinks is plain text (up to 1500 characters), empty by default", () => {
  const ud = tmp(), cfg = createAppConfig({ userDataDir: ud, env: {}, platform: "win32" });
  assert.strictEqual(cfg.get("financeLoginLinks"), null);
  const long = "a=https://x.test/" + "p".repeat(1200);
  const c2 = createAppConfig({ userDataDir: ud, env: { AGENT_DESKTOP_FINANCE_LOGIN_LINKS: long }, platform: "win32" }); assert.strictEqual(c2.get("financeLoginLinks"), long);
  const c3 = createAppConfig({ userDataDir: ud, env: { AGENT_DESKTOP_FINANCE_LOGIN_LINKS: "x".repeat(1501) }, platform: "win32" }); assert.strictEqual(c3.get("financeLoginLinks"), null);
});

// ------------------------------------------------------------------ static guards
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
t("guards: no hard-coded path/drive/name in the feed code; read-only (no write/delete calls); no network; no console", () => {
  for (const f of ["feedValidator.js", "feedReader.js"]) {
    const s = strip(fs.readFileSync(path.join(SRC, "finance", f), "utf8"));
    assert.ok(!/[A-Za-z]:\\\\|[A-Za-z]:\//.test(s.replace(/https?:\/\/[^"'\s]*/g, "")), f + " has a drive path");
    assert.ok(!/E:\\|D:\\|Dropbox\\|Claude work|C:\\Users|Iddo|Merav|Accounting|lensvid/i.test(s.replace(/CLOUD_SEGMENTS[\s\S]*$/, "")), f + " names this PC or a person");
    assert.ok(!/writeFile|appendFile|unlink|rename|rmSync|mkdirSync|copyFile|createWriteStream|chmod/.test(s), f + " is not read-only");
    assert.ok((s.match(/openSync\(/g) || []).every(() => true) && !/openSync\([^)]*["'](w|a|r\+|wx|ax)["']/.test(s), f + " opens for writing");
    assert.ok(!/require\(["'](https?|net|tls|dgram|dns|child_process)["']\)|\bfetch\s*\(|XMLHttpRequest|console\./.test(s), f + " touches the network / console");
  }
  const main = fs.readFileSync(path.join(SRC, "finance", "main-finance.js"), "utf8");
  assert.ok(/financeFeedPath/.test(main) && !/finance_feed\.json/.test(strip(main)), "the path comes from the configuration key");
  const cfg = fs.readFileSync(path.join(SRC, "appConfig.js"), "utf8");
  assert.ok(/financeFeedPath: \{ kind: "file"[^\n]*c\.sub\("workDir", "finance", "feed", "finance_feed\.json"\)/.test(cfg), "default derives from the configured work folder");
});
t("guards: renderer - textContent only, no path sent, https-only links, scope toggle, SYNTHETIC badge, Feed invalid, 7-day marks, stylesheet tokens", () => {
  const js = fs.readFileSync(path.join(SRC, "renderer", "finance.js"), "utf8"), css = fs.readFileSync(path.join(SRC, "renderer", "styles-finance.css"), "utf8");
  const pre = fs.readFileSync(path.join(SRC, "preload.js"), "utf8");
  assert.ok(/feed: \(scope, page, offset, filter\) => ipcRenderer\.invoke\("finance-feed", \{ scope, page, offset, filter \}\)/.test(pre), "the renderer sends the scope string only");
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(js));
  for (const w of ["SYNTHETIC DATA", "Feed invalid.", "Get fresh data", "Business", "Personal", "Needs you", "Balances now", "Total in NIS", "Updated ", "Not updated "]) assert.ok(js.includes(w), "Home shows: " + w);
  assert.ok(/\/\^https:\\\/\\\//.test(js), "the login link is shown only when it is https");
  assert.ok(/rel = "noopener noreferrer"/.test(js) && /target = "_blank"/.test(js));
  assert.ok(/aria-pressed/.test(js) && /role", "alert"/.test(js));
  assert.ok(/id: "home"/.test(js) && /tab: "home"/.test(js), "Home is a tab and the first view");
  for (const tok of ["--fin-home-ok", "--fin-home-bad", "--fin-home-warn", "--fin-home-synth-bg"]) assert.ok(css.includes(tok), "token " + tok);
  assert.ok(/\.mf-synthetic/.test(css) && /\.mf-fresh-ok/.test(css) && /\.mf-fresh-bad/.test(css) && /\.mf-scope-b/.test(css));
  assert.ok(/dir="auto"|setAttribute\("dir", "auto"\)/.test(js) && /unicode-bidi: plaintext/.test(css), "Hebrew-safe");
  assert.ok(/text-align: end/.test(css) && /border-inline-start/.test(css), "logical properties for RTL");
});

(async () => {
  for (const q of queue) {
    n++;
    try { await q.fn(); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); }
  }
  console.log(fails ? fails + " of " + n + " FAILED" : "finance-feed: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
