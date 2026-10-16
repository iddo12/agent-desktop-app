// node tests/finance-feed.test.js - MY FINANCE feed (v1.129.0, slice 1): validator (schema v0.2), reader refusals, scope filter / Home view,
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
  const big = { lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, size: R.MAX_BYTES + 1 }), readFileSync: () => { throw new Error("must not read"); } };
  assert.strictEqual(R.createFeedReader({ getPath: () => p, fs: big }).readFeed().code, "TOO_BIG");
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
    assert.ok(!/writeFile|appendFile|unlink|rename|rmSync|mkdirSync|copyFile|createWriteStream|openSync|chmod/.test(s), f + " is not read-only");
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
  assert.ok(/feed: \(scope\) => ipcRenderer\.invoke\("finance-feed", \{ scope \}\)/.test(pre), "the renderer sends the scope string only");
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
