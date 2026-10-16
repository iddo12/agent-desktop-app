// MY FINANCE feed reader (main process, read-only). Finds the feed file through the configuration layer (key financeFeedPath = "finance.feed_path":
// env AGENT_DESKTOP_FINANCE_FEED_PATH > Setup panel > <work folder>\finance\feed\finance_feed.json), reads it, validates it (feedValidator.js) and
// builds the Home view the renderer draws. Nothing here writes, deletes, or sends anything; there is no network.
//   - The path comes from configuration only. The renderer never supplies one.
//   - A file whose folder is inside a cloud-synced folder, a network share, or the app folder is refused (same check as the vault: vault.unsafeReason).
//   - A link or junction as the file itself is refused; the file must be a plain file, 20 MB at most.
//   - Logs carry the channel name and an error code only, never a figure, a name or a path (the caller's `log` gets codes from here).
// readFeed() -> { ok:true, feed } | { ok:false, code, reason, firstError? }.   homeView(feed, scope, opts) -> the small, pre-filtered object the Home view needs.
"use strict";
const fs = require("fs");
const path = require("path");
const { validateFeed } = require("./feedValidator");
const { unsafeReason } = require("./vault");

const MAX_BYTES = 20 * 1024 * 1024;
const FRESH_DAYS = 7;
const SCOPES = ["business", "personal", "all"];

function createFeedReader(opts) {
  const o = opts || {};
  const getPath = typeof o.getPath === "function" ? o.getPath : () => null;
  const fsx = o.fs || fs;
  const say = typeof o.log === "function" ? o.log : () => {};

  function readFeed() {
    let p;
    try { p = getPath(); } catch (e) { p = null; }
    if (typeof p !== "string" || !p.trim()) return { ok: false, code: "NOPATH", reason: "No finance feed file is set up. Set it in Setup (Finance feed file)." };
    const bad = unsafeReason(path.dirname(p), o.appDir);
    if (bad) { say("finance-feed refused: code=UNSAFE_FOLDER"); return { ok: false, code: "UNSAFE_FOLDER", reason: "The finance feed must sit in a private folder on this PC, not " + bad + "." }; }
    // One open, then everything on the same descriptor (no check-then-use gap): the path is looked at once for a link, the descriptor is
    // checked with fstat (regular file, same file as the path, size within the cap), read once, and fstat'ed again to catch a file that grew.
    let fd = null, text;
    try {
      let lst;
      try { lst = fsx.lstatSync(p); } catch (e) { return { ok: false, code: e && e.code === "ENOENT" ? "MISSING" : "STAT", reason: "The finance feed file was not found." }; }
      if (lst.isSymbolicLink()) { say("finance-feed refused: code=NOT_PLAIN_FILE"); return { ok: false, code: "NOT_PLAIN_FILE", reason: "The finance feed must be a plain file (not a link)." }; }
      try { fd = fsx.openSync(p, "r"); } catch (e) { say("finance-feed read failed: code=" + (e && e.code ? e.code : "OPEN")); return { ok: false, code: "READ", reason: "The finance feed file could not be read." }; }
      const st = fsx.fstatSync(fd);
      if (!st.isFile()) { say("finance-feed refused: code=NOT_PLAIN_FILE"); return { ok: false, code: "NOT_PLAIN_FILE", reason: "The finance feed must be a plain file (not a link)." }; }
      if (lst.ino && st.ino && (lst.ino !== st.ino || lst.dev !== st.dev)) { say("finance-feed refused: code=CHANGED"); return { ok: false, code: "CHANGED", reason: "The finance feed file changed while it was being opened." }; }
      if (st.size > MAX_BYTES) return { ok: false, code: "TOO_BIG", reason: "The finance feed file is too large." };
      const buf = Buffer.alloc(st.size);
      let got = 0;
      while (got < st.size) { const k = fsx.readSync(fd, buf, got, st.size - got, got); if (!k) break; got += k; }
      const st2 = fsx.fstatSync(fd);
      if (got !== st.size || st2.size !== st.size || st2.size > MAX_BYTES) { say("finance-feed refused: code=CHANGED"); return { ok: false, code: "CHANGED", reason: "The finance feed file changed while it was being read. Try again." }; }
      text = buf.toString("utf8");
    } catch (e) { say("finance-feed read failed: code=" + (e && e.code ? e.code : "READ")); return { ok: false, code: "READ", reason: "The finance feed file could not be read." }; }
    finally { if (fd !== null) { try { fsx.closeSync(fd); } catch (e) { /* nothing to do */ } } }
    let feed;
    try { feed = JSON.parse(text.replace(/^﻿/, "")); } catch (e) { return { ok: false, code: "PARSE", reason: "Feed invalid", firstError: "the file is not valid JSON" }; }
    const v = validateFeed(feed);
    if (!v.ok) { say("finance-feed invalid: code=SCHEMA"); return { ok: false, code: "SCHEMA", reason: "Feed invalid", firstError: v.errors[0] }; }
    return { ok: true, feed };
  }
  return { readFeed };
}

// ---------------------------------------------------------------- scope filter and Home view
const dayNum = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const inScope = (rowScope, scope) => scope === "all" || rowScope === scope || rowScope === "all";
const sumNis = (arr) => arr.reduce((a, m) => a + m, 0);
const isHttps = (u) => { try { const x = new URL(u); return x.protocol === "https:" && /^https:\/\/[^\/@?#]+([\/?#]|$)/i.test(u) && u.length <= 500; } catch (e) { return false; } };

// "id=https://a;id2=https://b" -> { id: url } ; only https, only plain ids; anything else is dropped (empty = no link)
function parseLoginLinks(text) {
  const out = Object.create(null);
  if (typeof text !== "string") return out;
  for (const part of text.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const id = part.slice(0, i).trim(), url = part.slice(i + 1).trim();
    if (/^[A-Za-z0-9_.-]{1,60}$/.test(id) && isHttps(url)) out[id] = url;
  }
  return out;
}

function homeView(feed, scopeIn, o) {
  const opts = o || {};
  const scope = SCOPES.includes(scopeIn) ? scopeIn : "all";
  const today = typeof opts.today === "string" ? opts.today : new Date().toISOString().slice(0, 10);
  const links = opts.loginLinks || Object.create(null);
  const srcById = new Map(feed.sources.map((s) => [s.id, s]));

  const sources = feed.sources.filter((s) => inScope(s.scope, scope)).map((s) => {
    const age = dayNum(today) - dayNum(s.last_import_date);
    return { id: s.id, label: s.label, kind: s.kind, manual: !!s.manual, last_import_date: s.last_import_date, age_days: age, fresh: age <= FRESH_DAYS, link: Object.prototype.hasOwnProperty.call(links, s.id) ? links[s.id] : null };
  });
  const balances = feed.balances.filter((b) => srcById.has(b.source) && inScope(srcById.get(b.source).scope, scope)).map((b) => {
    const s = srcById.get(b.source);
    return { source: b.source, label: s.label, kind: s.kind, currency: b.currency, amount: b.amount, nis: b.nis, as_of: b.as_of };
  });
  const tot = feed.nis_total && feed.nis_total[scope];
  const total = tot ? { nis: tot.nis, as_of: tot.as_of } : { nis: sumNis(balances.map((b) => b.nis)), as_of: balances.reduce((m, b) => (b.as_of > m ? b.as_of : m), "") || null };

  let per = feed.periods.filter((p) => p.scope === scope);
  if (scope === "all" && !per.length) {   // the feed has no "all" rows: add business and personal per period
    const by = new Map();
    for (const p of feed.periods) { const x = by.get(p.id) || { id: p.id, income: { nis: 0 }, expenses: { nis: 0 }, net: { nis: 0 }, to_check: 0, as_of: p.as_of }; x.income.nis += p.income.nis; x.expenses.nis += p.expenses.nis; x.net.nis += p.net.nis; x.to_check += p.to_check; if (p.as_of < x.as_of) x.as_of = p.as_of; by.set(p.id, x); }
    per = Array.from(by.values());
  }
  per = per.sort((a, b) => (a.id < b.id ? 1 : -1));
  const period = (p) => (p ? { id: p.id, income: p.income.nis, expenses: p.expenses.nis, net: p.net.nis, to_check: p.to_check, as_of: p.as_of } : null);
  const trend = per.slice(0, 6).reverse().map((p) => ({ id: p.id, income: p.income.nis, expenses: p.expenses.nis }));

  let vat = null;
  if (feed.vat && inScope(feed.vat.scope, scope) && feed.vat.periods.length) {
    const vp = feed.vat.periods.slice().sort((a, b) => (a.period < b.period ? 1 : -1));
    const f = (r) => ({ period: r.period, charged: r.charged.nis, input: r.input.nis, result: r.refund_or_due.nis, to_check: r.to_check, file_by: r.file_by, as_of: r.as_of });
    vat = { current: f(vp[0]), previous: vp[1] ? f(vp[1]) : null };
  }

  let invoices = null;
  if (feed.invoices) {
    const iv = feed.invoices;
    if (scope === "all" && iv.unpaid && iv.overdue) invoices = { unpaid: { count: iv.unpaid.count, nis: iv.unpaid.amount.nis }, overdue: { count: iv.overdue.count, nis: iv.overdue.amount.nis }, as_of: iv.unpaid.amount.as_of };
    else if (Array.isArray(iv.rows)) {
      const r = iv.rows.filter((x) => inScope(x.scope, scope));
      const pick = (st) => { const a = r.filter((x) => x.status === st); return { count: a.length, nis: sumNis(a.map((x) => x.money.nis)) }; };
      invoices = { unpaid: pick("unpaid"), overdue: pick("overdue"), as_of: r.reduce((m, x) => (x.money.as_of > m ? x.money.as_of : m), "") || null };
    }
  }

  let needs = null;
  if (feed.needs_you && Array.isArray(feed.needs_you.items)) {
    const items = feed.needs_you.items.filter((x) => inScope(x.scope, scope));
    const by = new Map();
    for (const x of items) by.set(x.type, (by.get(x.type) || 0) + 1);
    needs = { count: items.length, by_type: Array.from(by, ([type, count]) => ({ type, count })), labels: items.slice(0, 5).map((x) => x.label) };
  }

  const rates = (feed.rates || []).filter((r) => r.currency !== "ILS").map((r) => ({ currency: r.currency, rate: r.rate, date: r.date }));
  return { synthetic: !!feed.synthetic, generated_at: feed.generated_at, scope, today, total, balances, sources, stale: sources.filter((s) => !s.fresh).map((s) => ({ id: s.id, label: s.label, age_days: s.age_days })), period: { this: period(per[0]), last: period(per[1]) }, trend, vat, invoices, needs, rates };
}

module.exports = { createFeedReader, homeView, parseLoginLinks, FRESH_DAYS, SCOPES, MAX_BYTES };
