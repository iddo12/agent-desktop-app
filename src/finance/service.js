// MY FINANCE service (v1.90.0 skeleton, main process). Reads ONE local ledger file and the drop folder of the finance vault and turns
// them into the numbers the view draws. LIGHT: loaded on the first finance-* call. The parsed ledger is cached in memory keyed by the
// file's mtime + size (a search must not re-read it per keystroke) and dropped when the view closes (dropCache).
// PRIVATE: the vault is a local folder outside any cloud-synced folder, checked on its REAL location (vault.js); no network, no
// credentials, nothing logged except channel names and error codes. SAFE: only <vault>\db\ledger.json and regular files directly in
// <vault>\drop (and drop\samples) are read, with size, column, line and per-scan byte caps; the drop-folder scan is async and yields
// between files and chunks so the main process never blocks for long; symlinks and folders are never followed; strings are clipped.
// SKELETON: the ledger is plain JSON for now and may only hold SYNTHETIC data (see FINANCE_SKELETON_REPORT.md). The encrypted
// SQLCipher ledger from the build report replaces it before the first real file is imported.
"use strict";
const fs = require("fs");
const path = require("path");
const csv = require("./csv");
const synthetic = require("./synthetic");
const vault = require("./vault");

const MAX_LEDGER_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;          // one export file; a weekly bank export is a few KB
const MAX_SCAN_BYTES = 12 * 1024 * 1024;           // all CSVs read in one scan together
const MAX_PARSED_FILES = 20;                       // CSVs previewed per scan; more are listed as "not read"
const MAX_TX = 50000, MAX_FILES = 60, MAX_ROWS_OUT = 400;
const SUBFOLDERS = ["drop", "receipts", "db", "exports", "archive"];       // the vault layout from the build report, section 6
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;
const okId = (id) => typeof id === "string" && ID_RE.test(id) && !(id in Object.prototype) && id !== "prototype";   // "constructor", "__proto__", "toString" never become keys
const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// R4: the marker the demo generator writes, as a WHOLE word: "demo" / "Demo" / "(demo)" / "דמו" / "(דמו)" / "הדמו". "Demolition Ltd" or
// "דמוקרט" do not count.
const DEMO_MARK = /(?:^|[^A-Za-z0-9\u0590-\u05FF])(?:demo|ה?דמו)(?:$|[^A-Za-z0-9\u0590-\u05FF])/i;
const DEMO_FILE = /^DEMO_[A-Za-z0-9_-]+\.csv$/i;

const stripBom = (s) => (typeof s === "string" && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);
const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r2 = (n) => Math.round(n * 100) / 100;
const dict = () => Object.create(null);
const pause = () => new Promise((res) => setImmediate(res));
const pad = (n) => String(n).padStart(2, "0");

// Where the vault is. Order: env AGENT_DESKTOP_FINANCE_DIR, then "vaultDir" in <userData>\finance_prefs.json, then the default
// (v1.121.0: o.defaultDir, a value or a function - the configuration key financeVault - else <userData>\finance-vault). In test mode the default is always under userData,
// so the sandbox never touches the real vault. EVERY candidate, the default and the fallback included, goes through vault.unsafeReason.
// -> {dir, from, note} ; dir is null when not even the fallback is safe (the view then shows a blocked state and nothing is read or written).
function resolveVault(o) {
  const env = o.env || process.env;
  const fallback = path.join(o.userData, "finance-vault");
  const cfgDir = typeof o.defaultDir === "function" ? o.defaultDir() : o.defaultDir;   // read on every call: a Setup change applies at once
  const def = o.testMode ? fallback : (typeof cfgDir === "string" && cfgDir.trim() ? cfgDir.trim() : fallback);
  let want = null, from = "default";
  if (typeof env.AGENT_DESKTOP_FINANCE_DIR === "string" && env.AGENT_DESKTOP_FINANCE_DIR.trim()) { want = env.AGENT_DESKTOP_FINANCE_DIR.trim(); from = "env"; }
  else {
    try {
      const j = JSON.parse(stripBom(fs.readFileSync(path.join(o.userData, "finance_prefs.json"), "utf8")));
      if (j && typeof j.vaultDir === "string" && j.vaultDir.trim()) { want = j.vaultDir.trim(); from = "setting"; }
    } catch (e) { /* no or unreadable prefs file: default */ }
  }
  const notes = [];
  if (want) {
    const why = vault.unsafeReason(want, o.appDir);
    if (!why) return { dir: path.resolve(vault.stripDevicePrefix(want)), from, note: "" };
    notes.push("The finance folder setting was not used: it is " + why + ". Money data must stay on this PC, outside cloud-synced folders.");
  }
  for (const cand of def === fallback ? [def] : [def, fallback]) {
    const why = vault.unsafeReason(cand, o.appDir);
    if (!why) return { dir: path.resolve(cand), from: cand === def ? "default" : "fallback", note: notes.join(" ") };
    notes.push("The " + (cand === def ? "default" : "fallback") + " finance folder is " + why + ", so it was not used.");
  }
  return { dir: null, from: "none", note: notes.join(" ") + " Nothing is read or written until a safe folder is set." };
}

// {ok, value, mtime, size} | {ok:false, code}. Only ENOENT means "missing"; any other error (EPERM, EBUSY...) is "unreadable",
// so a ledger that is merely locked is never treated as absent and overwritten (review S1).
function statLedger(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return { ok: false, code: e && e.code === "ENOENT" ? "missing" : "unreadable" }; }
  if (!st.isFile()) return { ok: false, code: "not-file" };
  if (st.size > MAX_LEDGER_BYTES) return { ok: false, code: "too-big" };
  return { ok: true, mtime: st.mtimeMs, size: st.size };
}
function readLedgerFile(file) {
  const s = statLedger(file);
  if (!s.ok) return s;
  try { return { ok: true, value: JSON.parse(stripBom(fs.readFileSync(file, "utf8"))), mtime: s.mtime, size: s.size }; } catch (e) { return { ok: false, code: e && e.code === "ENOENT" ? "missing" : "unreadable" }; }
}

// A ledger counts as demo data only if it says so AND every account and every line carries the demo marker (review S2). A ledger that
// says synthetic but holds one unmarked line is treated as REAL: demo data is never written over it and it is never moved away.
function isDemoLedger(j) {
  if (!j || typeof j !== "object" || j.synthetic !== true) return false;
  const acc = Array.isArray(j.accounts) ? j.accounts : [], tx = Array.isArray(j.transactions) ? j.transactions : [];
  return acc.every((a) => a && DEMO_MARK.test(String(a.name || ""))) && tx.every((t) => t && DEMO_MARK.test(String(t.merchant || "")));
}

// ledger JSON -> a clean, bounded copy (unknown fields dropped, bad rows skipped and counted)
function normalizeLedger(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const accounts = (Array.isArray(j.accounts) ? j.accounts : []).slice(0, 50).map((a) => (a && okId(a.id) ? { id: a.id, name: clip(a.name, 80) || a.id, kind: ["bank", "card", "cash"].includes(a.kind) ? a.kind : "bank", opening: num(a.opening) || 0 } : null)).filter(Boolean);
  const categories = (Array.isArray(j.categories) ? j.categories : []).slice(0, 200).map((c) => (c && okId(c.id) ? { id: c.id, en: clip(c.en, 60) || c.id, he: clip(c.he, 60), icon: clip(c.icon, 8), group: ["business", "personal", "income", "transfer"].includes(c.group) ? c.group : "personal" } : null)).filter(Boolean);
  if (!categories.some((c) => c.id === "other")) categories.push({ id: "other", en: "Uncategorised", he: "לא מסווג", icon: "❔", group: "personal" });
  const accIds = new Set(accounts.map((a) => a.id)), catIds = new Set(categories.map((c) => c.id));
  let skipped = 0;
  const list = Array.isArray(j.transactions) ? j.transactions : [];
  const transactions = [];
  for (const t of list.slice(0, MAX_TX)) {
    const amount = t && num(t.amount);
    if (!t || !DATE_RE.test(t.date) || amount == null || !accIds.has(t.account)) { skipped++; continue; }
    const category = catIds.has(t.category) ? t.category : "other";
    transactions.push({ id: clip(String(t.id || "t" + transactions.length), 40), date: t.date, amount, account: t.account, merchant: clip(t.merchant, 120), raw: clip(t.raw, 200), category, bp: t.bp === "business" ? "business" : "personal", transfer: t.transfer === true || category === "transfer", receipt: typeof t.receipt === "string" ? clip(t.receipt, 40) : null });
  }
  skipped += Math.max(0, list.length - MAX_TX);
  const receipts = (Array.isArray(j.receipts) ? j.receipts : []).slice(0, 5000).map((r) => (r && DATE_RE.test(r.date) && num(r.total) != null ? { id: clip(String(r.id || ""), 40), date: r.date, vendor: clip(r.vendor, 120), total: num(r.total), status: ["matched", "new", "no-line"].includes(r.status) ? r.status : "new", tx: typeof r.tx === "string" ? clip(r.tx, 40) : null, suggestTx: typeof r.suggestTx === "string" ? clip(r.suggestTx, 40) : null } : null)).filter(Boolean);
  const rules = (Array.isArray(j.rules) ? j.rules : []).slice(0, 500).map((r) => (r && clip(r.contains, 80) && catIds.has(r.category) ? { contains: clip(r.contains, 80), category: r.category, bp: r.bp === "business" ? "business" : "personal", learned: r.learned === true } : null)).filter(Boolean);
  return { synthetic: isDemoLedger(j), createdAt: clip(j.createdAt, 40), accounts, categories, transactions, receipts, rules, skipped };
}

const monthOf = (d) => d.slice(0, 7);
function prevMonthOf(ym) { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return m === 1 ? (y - 1) + "-12" : y + "-" + pad(m - 1); }

// Everything the Overview / Accounts / Categories / Receipts tabs draw, computed from the normalised ledger. All key->value maps are
// null-prototype objects. `now` decides whether the newest month is still running: if so, it is compared with the SAME DAYS of the
// month before (1st to today's day), not with the whole month (review S4).
function summarize(L, now) {
  const today = now instanceof Date ? now : new Date();
  const todayYm = today.getFullYear() + "-" + pad(today.getMonth() + 1);
  const monthsSet = new Set(L.transactions.map((t) => monthOf(t.date)));
  const months = [...monthsSet].sort().slice(-12);
  const byMonth = dict(); for (const m of months) byMonth[m] = { month: m, in: 0, out: 0 };
  const catMonths = dict();   // catId -> {month: amount}  (spend and income both as positive numbers)
  const accStats = dict(); for (const a of L.accounts) accStats[a.id] = { balance: a.opening, lastDate: "", lines: 0 };
  const cur = months[months.length - 1] || null;
  const partial = cur === todayYm;
  const sameDays = partial ? today.getDate() : null;
  const prevOfCur = cur ? prevMonthOf(cur) : null;
  const same = { in: 0, out: 0, has: false }, catPrevSame = dict();
  for (const t of L.transactions) {
    const s = accStats[t.account]; s.balance += t.amount; s.lines++; if (t.date > s.lastDate) s.lastDate = t.date;
    if (t.transfer) continue;
    const m = monthOf(t.date), bm = byMonth[m];
    if (!bm) continue;
    if (t.amount > 0) bm.in += t.amount; else bm.out += -t.amount;
    const cm = catMonths[t.category] || (catMonths[t.category] = dict());
    cm[m] = r2((cm[m] || 0) + Math.abs(t.amount));
    if (partial && m === prevOfCur && +t.date.slice(8, 10) <= sameDays) {
      same.has = true;
      if (t.amount > 0) same.in += t.amount; else same.out += -t.amount;
      catPrevSame[t.category] = r2((catPrevSame[t.category] || 0) + Math.abs(t.amount));
    }
  }
  const monthRows = months.map((m) => ({ month: m, in: r2(byMonth[m].in), out: r2(byMonth[m].out), net: r2(byMonth[m].in - byMonth[m].out) }));
  const accounts = L.accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, balance: r2(accStats[a.id].balance), lastDate: accStats[a.id].lastDate, lines: accStats[a.id].lines }));
  const curRow = monthRows[monthRows.length - 1] || null, prevRow = monthRows.length > 1 && monthRows[monthRows.length - 2].month === prevOfCur ? monthRows[monthRows.length - 2] : null;
  const cash = r2(accounts.filter((a) => a.kind !== "card").reduce((s, a) => s + a.balance, 0));
  const owed = r2(accounts.filter((a) => a.kind === "card").reduce((s, a) => s + Math.min(0, a.balance), 0));
  // the "before" figures the tiles compare with: same days of last month while the month runs, else the whole of last month
  const cmpIn = partial ? (same.has || prevRow ? r2(same.in) : null) : prevRow ? prevRow.in : null;
  const cmpOut = partial ? (same.has || prevRow ? r2(same.out) : null) : prevRow ? prevRow.out : null;
  const cmpCat = (id) => (partial ? (prevRow ? catPrevSame[id] || 0 : null) : prevRow ? (catMonths[id] && catMonths[id][prevRow.month]) || 0 : null);
  const spendCats = (m) => L.categories.filter((c) => c.group !== "income" && c.group !== "transfer").map((c) => ({ id: c.id, amount: (catMonths[c.id] && catMonths[c.id][m]) || 0 })).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount);
  const top = curRow ? spendCats(curRow.month)[0] || null : null;
  const recNew = L.receipts.filter((r) => r.status === "new").length, recNoLine = L.receipts.filter((r) => r.status === "no-line").length;
  const noReceipt = (m, maxDay) => L.transactions.filter((t) => monthOf(t.date) === m && (!maxDay || +t.date.slice(8, 10) <= maxDay) && t.bp === "business" && t.amount < 0 && !t.transfer && !t.receipt && t.category !== "taxes" && t.category !== "fees").length;
  const catPrev = dict(); if (curRow) for (const c of L.categories) { const v = cmpCat(c.id); if (v != null) catPrev[c.id] = v; }
  const overview = {
    month: curRow ? curRow.month : null, prevMonth: prevRow ? prevRow.month : (partial ? prevOfCur : null),
    partial, sameDays,                                         // sameDays = 8 means "1-8 of last month" is the comparison
    cash, owed,
    in: curRow ? curRow.in : 0, out: curRow ? curRow.out : 0, net: curRow ? curRow.net : 0,
    prevIn: cmpIn, prevOut: cmpOut, prevNet: cmpIn == null || cmpOut == null ? null : r2(cmpIn - cmpOut),
    prevFullIn: prevRow ? prevRow.in : null, prevFullOut: prevRow ? prevRow.out : null,
    receiptsToCheck: recNew + recNoLine, receiptsNew: recNew, receiptsNoLine: recNoLine,
    linesNoReceipt: curRow ? noReceipt(curRow.month) : 0, prevLinesNoReceipt: prevRow ? noReceipt(prevRow.month, partial ? sameDays : 0) : null,
    topCategory: top ? { id: top.id, amount: r2(top.amount), prev: cmpCat(top.id) == null ? null : r2(cmpCat(top.id)) } : null,
    catPrev,                                                   // per category: the comparison figure for the newest month
  };
  return { months: monthRows, accounts, overview, catMonths, txCount: L.transactions.length, transferCount: L.transactions.filter((t) => t.transfer).length };
}

function createService(o) {
  const say = typeof o.log === "function" ? o.log : () => {};
  const where = () => resolveVault(o);
  const nowFn = typeof o.now === "function" ? o.now : () => new Date();
  const ledgerFile = (dir) => path.join(dir, "db", "ledger.json");
  let cache = null;                                   // {file, mtime, size, L}
  const read = () => {
    const v = where();
    if (!v.dir) return { v, r: { ok: false, code: "blocked" }, L: null };
    const file = ledgerFile(v.dir);
    const bad = subUnsafe(v.dir, "db");
    if (bad) { cache = null; return { v, r: { ok: false, code: "unsafe", why: bad }, L: null }; }
    const st = statLedger(file);
    if (!st.ok) { cache = null; return { v, r: st, L: null }; }
    if (cache && cache.file === file && cache.mtime === st.mtime && cache.size === st.size) return { v, r: st, L: cache.L };
    const r = readLedgerFile(file);
    if (!r.ok) { cache = null; return { v, r, L: null }; }
    const L = normalizeLedger(r.value);
    cache = L ? { file, mtime: r.mtime, size: r.size, L } : null;
    return { v, r, L };
  };
  const dropCache = () => { cache = null; };

  function load() {
    const { v, r, L } = read();
    const base = { ok: true, vault: v.dir, vaultFrom: v.from, vaultNote: v.note, dropDir: v.dir ? path.join(v.dir, "drop") : null };
    if (!v.dir) return Object.assign(base, { state: "blocked", reason: v.note });
    if (!r.ok && r.code === "unsafe") return Object.assign(base, { state: "blocked", reason: "The ledger folder (db) is " + r.why + ". Money data must stay on this PC, outside cloud-synced folders, so nothing is read or written." });
    if (!r.ok && r.code === "missing") return Object.assign(base, { state: "empty" });
    if (!r.ok) return Object.assign(base, { state: "unreadable", reason: r.code === "too-big" ? "The ledger file is over 20 MB, so it was not opened." : "The ledger file could not be read. It was left untouched." });
    if (!L) return Object.assign(base, { state: "unreadable", reason: "The ledger file is not in the expected format." });
    const s = summarize(L, nowFn());
    return Object.assign(base, { state: "ready", synthetic: L.synthetic, createdAt: L.createdAt, skipped: L.skipped, categories: L.categories, rules: L.rules, receipts: L.receipts.slice(0, 500) }, s);
  }

  // q = {text, account, category, month, kind: ""|"in"|"out"|"transfer", bp: ""|"business"|"personal", limit}
  function transactions(q) {
    const a = q && typeof q === "object" && !Array.isArray(q) ? q : {};
    const text = clip(a.text, 100).trim().toLowerCase();
    const account = okId(a.account) ? a.account : "";
    const category = okId(a.category) ? a.category : "";
    const month = typeof a.month === "string" && MONTH_RE.test(a.month) ? a.month : "";
    const kind = ["in", "out", "transfer"].includes(a.kind) ? a.kind : "";
    const bp = ["business", "personal"].includes(a.bp) ? a.bp : "";
    const limit = Number.isInteger(a.limit) && a.limit > 0 ? Math.min(a.limit, MAX_ROWS_OUT) : 200;
    const { r, L } = read();
    if (!r.ok || !L) return { ok: false, reason: r.ok ? "The ledger is not in the expected format." : r.code === "missing" ? "There is no ledger yet." : "The ledger could not be read." };
    const catName = new Map(L.categories.map((c) => [c.id, (c.en + " " + c.he).toLowerCase()]));
    const accName = new Map(L.accounts.map((x) => [x.id, x.name.toLowerCase()]));
    const hits = L.transactions.filter((t) => {
      if (account && t.account !== account) return false;
      if (category && t.category !== category) return false;
      if (month && monthOf(t.date) !== month) return false;
      if (bp && t.bp !== bp) return false;
      if (kind === "transfer" && !t.transfer) return false;
      if (kind === "in" && (t.transfer || t.amount <= 0)) return false;
      if (kind === "out" && (t.transfer || t.amount >= 0)) return false;
      if (text && !(t.merchant.toLowerCase().includes(text) || t.raw.toLowerCase().includes(text) || (catName.get(t.category) || "").includes(text) || (accName.get(t.account) || "").includes(text) || String(Math.abs(t.amount)).includes(text))) return false;
      return true;
    });
    let sumIn = 0, sumOut = 0;
    for (const t of hits) { if (t.transfer) continue; if (t.amount > 0) sumIn += t.amount; else sumOut += -t.amount; }
    hits.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
    return { ok: true, total: hits.length, all: L.transactions.length, sumIn: r2(sumIn), sumOut: r2(sumOut), rows: hits.slice(0, limit), limited: hits.length > limit };
  }

  // The Import tab: every regular file directly in <vault>\drop and <vault>\drop\samples, with a generic CSV preview. ASYNC: file reads use
  // fs.promises, the parser yields every few thousand lines, and the loop yields between files, so a hostile or huge file never freezes
  // the main process (review B2). Caps: 60 files listed, 20 CSVs previewed, 2 MB per file, 12 MB per scan.
  async function importScan() {
    const v = where();
    if (!v.dir) return { ok: false, reason: v.note };
    const drop = path.join(v.dir, "drop");
    const bad = subUnsafe(v.dir, "drop");
    if (bad) return { ok: false, reason: "The drop folder is " + bad + ", so it was not read." };
    const files = [];
    let more = 0, parsed = 0, budget = MAX_SCAN_BYTES;
    for (const sub of ["", "samples"]) {
      if (sub && subUnsafe(v.dir, path.join("drop", sub))) continue;   // a linked samples folder is skipped, never followed
      const dir = sub ? path.join(drop, sub) : drop;
      let ents = [];
      try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of ents) {
        if (!e.isFile()) continue;                       // folders and symlinks are not followed
        if (files.length >= MAX_FILES) { more++; continue; }
        const full = path.join(dir, e.name);
        let st; try { st = await fs.promises.lstat(full); } catch (x) { continue; }
        if (!st.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase().replace(".", "");
        const f = { name: clip(e.name, 160), folder: sub, size: st.size, modified: new Date(st.mtimeMs).toISOString(), ext, kind: ["csv", "txt", "tsv"].includes(ext) ? "csv" : ["xlsx", "xls"].includes(ext) ? "excel" : ext === "pdf" ? "pdf" : ext === "dat" ? "dat" : "other", demo: /^DEMO_/i.test(e.name) };
        if (f.kind === "csv") {
          if (st.size > MAX_IMPORT_BYTES) f.parse = { ok: false, note: "Over 2 MB, so it was not read. A weekly bank export is much smaller; check that this is the right file." };
          else if (parsed >= MAX_PARSED_FILES || st.size > budget) f.parse = { ok: false, note: "Not read in this pass (limit " + MAX_PARSED_FILES + " files / 12 MB per look). Move older files out of the drop folder." };
          else {
            parsed++; budget -= st.size;
            try { f.parse = await csv.parseCsvAsync(await fs.promises.readFile(full)); } catch (x) { f.parse = { ok: false, note: "The file could not be read." }; say("finance-import-scan read failed: code=" + (x && x.code ? x.code : "unknown")); }
          }
        }
        files.push(f);
        await pause();
      }
    }
    files.sort((a, b) => (a.modified < b.modified ? 1 : -1));
    let exists = false; try { exists = (await fs.promises.stat(drop)).isDirectory(); } catch (e) { exists = false; }
    return { ok: true, dropDir: drop, exists, files, more };
  }

  const unsafeError = (why) => { const e = new Error("unsafe folder"); e.code = "EUNSAFE"; e.why = why; return e; };
  // R1 + R2: write `text` to <vault>\<sub>\<name>. The folder is checked right before the write; the temp file is created with O_EXCL
  // ("wx") inside it, renamed into place, and the folder is checked AGAIN after the rename. If the folder was swapped for a link in between
  // (a race: someone who can already write next to the vault), our own freshly written synthetic file is taken back out at once and the call
  // fails. RESIDUAL RISK (documented in the report): during the few milliseconds between the swap and the take-back the file sits in the
  // linked place; a sync client could pick it up. Only synthetic data is ever written in this skeleton.
  function writeAtomic(dir, sub, name, text) {
    const folder = path.join(dir, sub), file = path.join(folder, name);
    let bad = subUnsafe(dir, sub);
    if (bad) throw unsafeError(sub + " is " + bad);
    const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
    const fd = fs.openSync(tmp, "wx");
    try { fs.writeSync(fd, Buffer.from(text, "utf8")); try { fs.fsyncSync(fd); } catch (e) { /* best effort */ } } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ } throw e; }
    bad = subUnsafe(dir, sub);
    if (bad) { retractWrite(file); throw unsafeError(sub + " is " + bad); }
  }
  // take back a file THIS call has just written (synthetic data), when its folder turned out to be a link after the write
  function retractWrite(dest) { try { fs.unlinkSync(dest); } catch (e) { /* already gone */ } }
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
  // move a file into <vault>\archive (never delete). The archive folder is checked first (R1): a linked archive is refused.
  function archive(dir, file, name) {
    const a = path.join(dir, "archive");
    fs.mkdirSync(a, { recursive: true });
    const bad = subUnsafe(dir, "archive");
    if (bad) throw unsafeError("archive is " + bad);
    const to = path.join(a, name);
    fs.renameSync(file, to);
    return to;
  }
  // R1: a vault subfolder is acceptable only if it is a plain folder (not a link or junction), it really sits where its name says (its real
  // path = the vault's real path + its name) and that place passes the cloud/app check. A subfolder that does not exist yet is checked by name.
  function subUnsafe(dir, sub) {
    const p = path.join(dir, sub);
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return e && e.code === "ENOENT" ? vault.unsafeReason(p, o.appDir) : "not readable"; }
    if (st.isSymbolicLink()) return "a link or junction";
    if (!st.isDirectory()) return "not a folder";
    let real, realDir;
    try { real = vault.stripDevicePrefix(fs.realpathSync.native(p)); realDir = vault.stripDevicePrefix(fs.realpathSync.native(dir)); } catch (e) { return "not resolvable"; }
    if (real.toLowerCase() !== path.join(realDir, sub).toLowerCase()) return "really somewhere else (a link)";
    return vault.unsafeReason(p, o.appDir);
  }
  // the vault folder and EVERY subfolder (db, drop, receipts, exports, archive)
  function vaultUnsafe(dir) {
    const top = vault.unsafeReason(dir, o.appDir);
    if (top) return "the finance folder is " + top;
    for (const s of SUBFOLDERS) { const w = subUnsafe(dir, s); if (w) return "the " + s + " folder is " + w; }
    return null;
  }
  const unsafeReply = (e, what) => ({ ok: false, reason: "Nothing more was " + what + ": " + (e.why || "a folder is not safe") + ". Money data must stay on this PC, outside cloud-synced folders." });

  // Creates the vault folders, a SYNTHETIC ledger and two demo export files. A ledger that is not demo data (by flag AND markers) or that
  // cannot be read is never touched. An older demo ledger is moved to archive\, not overwritten.
  function createDemo(now) {
    const v = where();
    if (!v.dir) return { ok: false, reason: "There is no safe finance folder, so nothing was written." };
    const file = ledgerFile(v.dir);
    const cur = readLedgerFile(file);
    if (cur.ok && !isDemoLedger(cur.value)) return { ok: false, reason: "A real ledger already exists, so demo data was not written." };
    if (!cur.ok && cur.code !== "missing") return { ok: false, reason: "A ledger file exists but cannot be read, so it was left untouched." };
    if (vault.unsafeReason(v.dir, o.appDir)) return { ok: false, reason: "The finance folder is not safe, so nothing was written." };
    // a subfolder that already exists as a link is refused BEFORE anything is created or written
    const pre = vaultUnsafe(v.dir);
    if (pre) return { ok: false, reason: "Nothing was written: " + pre + ". Money data must stay on this PC, outside cloud-synced folders." };
    for (const s of SUBFOLDERS) fs.mkdirSync(path.join(v.dir, s), { recursive: true });
    const post = vaultUnsafe(v.dir);
    if (post) return { ok: false, reason: "Nothing was written: " + post + "." };
    try {
      if (cur.ok) archive(v.dir, file, "ledger-demo-" + stamp() + ".json");
      const L = synthetic.makeLedger({ now: now instanceof Date ? now : nowFn() });
      writeAtomic(v.dir, "db", "ledger.json", JSON.stringify(L, null, 1) + "\n");
      for (const f of synthetic.demoExports(L)) {
        const p = path.join(v.dir, "drop", f.name);
        if (fs.existsSync(p)) archive(v.dir, p, path.basename(f.name, ".csv") + "-" + stamp() + ".csv");
        writeAtomic(v.dir, "drop", f.name, "\uFEFF" + f.text);
      }
      dropCache();
      return { ok: true, transactions: L.transactions.length };
    } catch (e) { dropCache(); if (e && e.code === "EUNSAFE") return unsafeReply(e, "written"); throw e; }
  }

  // MOVES the demo ledger and the DEMO_ export files to <vault>\archive (nothing is deleted). Refuses unless the ledger is demo data by flag
  // AND by the marker on every account and line.
  function removeDemo() {
    const v = where();
    if (!v.dir) return { ok: false, reason: "There is no safe finance folder." };
    const file = ledgerFile(v.dir);
    const cur = readLedgerFile(file);
    if (cur.ok && !isDemoLedger(cur.value)) return { ok: false, reason: "The ledger holds real data, so nothing was moved." };
    if (!cur.ok && cur.code !== "missing") return { ok: false, reason: "The ledger file cannot be read, so it was left untouched." };
    const pre = vaultUnsafe(v.dir);
    if (pre) return { ok: false, reason: "Nothing was moved: " + pre + "." };
    const ts = stamp();
    let moved = 0;
    try {
      if (cur.ok) { archive(v.dir, file, "ledger-demo-" + ts + ".json"); moved++; }
      const drop = path.join(v.dir, "drop");
      let ents = []; try { ents = fs.readdirSync(drop, { withFileTypes: true }); } catch (e) { ents = []; }
      for (const e of ents) if (e.isFile() && DEMO_FILE.test(e.name)) { archive(v.dir, path.join(drop, e.name), path.basename(e.name, path.extname(e.name)) + "-" + ts + ".csv"); moved++; }
    } catch (e) { dropCache(); if (e && e.code === "EUNSAFE") return unsafeReply(e, "moved"); throw e; }
    dropCache();
    return { ok: true, moved, archive: path.join(v.dir, "archive") };
  }

  // A folder the Open button may show: the drop folder or the vault itself (created on first use). Never a path from the renderer.
  function folderFor(which) {
    const v = where();
    if (!v.dir) return null;
    if (which !== "vault" && subUnsafe(v.dir, "drop")) return null;      // an existing linked drop folder is never opened or created through
    const p = which === "vault" ? v.dir : path.join(v.dir, "drop");
    fs.mkdirSync(p, { recursive: true });
    if (vault.unsafeReason(p, o.appDir) || (which !== "vault" && subUnsafe(v.dir, "drop"))) return null;
    return p;
  }

  return { load, transactions, importScan, createDemo, removeDemo, folderFor, where, dropCache };
}

const cloudOrApp = (p, appDir) => !!vault.unsafeReason(p, appDir);

module.exports = { createService, resolveVault, normalizeLedger, summarize, isDemoLedger, cloudOrApp, okId, DEMO_MARK, MAX_LEDGER_BYTES, MAX_IMPORT_BYTES, MAX_SCAN_BYTES, SUBFOLDERS };
