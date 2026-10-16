// MY FINANCE feed validator (schema v0.2, docs: Software Engineering Agent\docs\my_finance_feed_schema_v0.2.md). Pure: no fs, no clock, no logging.
// validateFeed(obj) -> { ok, errors: [string] }. Errors name the JSON path and the rule that failed, NEVER a value from the feed (the first error is
// shown on screen and may be logged, and a figure must not leak that way). Unknown extra fields are ignored. A feed_version with a major above 0 is
// refused. Lists over MAX_ROWS are refused (an aggregate feed, not a ledger). Stops collecting after MAX_ERRORS.
"use strict";

const MAX_ROWS = 5000;
const MAX_ERRORS = 50;
const CURRENCIES = ["ILS", "USD", "EUR"];
const SCOPES = ["business", "personal", "all"];
const ROW_SCOPES = ["business", "personal"];
const SOURCE_KINDS = ["bank", "card", "paypal", "invoicing"];
const INVOICE_DIR = ["out", "in"];
const INVOICE_STATUS = ["paid", "unpaid", "overdue"];
const INCOME_KINDS = ["sponsorship", "sales", "other"];
const RECEIPT = ["matched", "missing"];
const MATCH = ["matched", "unmatched", "needs_check"];
const SUPPORTED_MAJOR = 0;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";

// YYYY-MM-DD that is a real calendar day
function isDate(v) {
  if (!isStr(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = +v.slice(0, 4), m = +v.slice(5, 7), d = +v.slice(8, 10);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const isPeriod = (v) => isStr(v) && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const isDateTime = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(v) && isDate(v.slice(0, 10)) && !Number.isNaN(Date.parse(v.replace(" ", "T")));

function versionProblem(v) {
  if (!isStr(v) || !/^\d+\.\d+(\.\d+)?$/.test(v)) return "must look like 0.2";
  if (+v.split(".")[0] !== SUPPORTED_MAJOR) return "this app reads major version " + SUPPORTED_MAJOR + " only (newer feed refused)";
  return null;
}

function validateFeed(feed) {
  const errors = [];
  let full = false;
  const err = (p, msg) => { if (errors.length < MAX_ERRORS) errors.push(p + ": " + msg); else full = true; };

  const need = (o, key, path) => { if (!Object.prototype.hasOwnProperty.call(o, key) || o[key] === undefined || o[key] === null) { err(path + key, "required"); return false; } return true; };
  const date = (v, p, nullable) => { if (v === null && nullable) return; if (!isDate(v)) err(p, "must be a date YYYY-MM-DD"); };
  const num = (v, p) => { if (!isNum(v)) err(p, "must be a finite number"); };
  const int = (v, p) => { if (!Number.isInteger(v) || v < 0) err(p, "must be a whole number, 0 or more"); };
  const oneOf = (v, list, p) => { if (!list.includes(v)) err(p, "must be one of " + list.join("|")); };
  const str = (v, p) => { if (!isStr(v) || !v.length) err(p, "must be a non-empty text"); };
  const bool = (v, p) => { if (typeof v !== "boolean") err(p, "must be true or false"); };
  const list = (v, p) => {
    if (!Array.isArray(v)) { err(p, "must be a list"); return false; }
    if (v.length > MAX_ROWS) { err(p, "has more than " + MAX_ROWS + " rows (not allowed in an aggregate feed)"); return false; }
    return true;
  };
  const rows = (v, p, fn) => { if (!list(v, p)) return; for (let i = 0; i < v.length && !full; i++) { const q = p + "[" + i + "]"; if (!isObj(v[i])) err(q, "must be an object"); else fn(v[i], q); } };
  const obj = (v, p) => { if (!isObj(v)) { err(p, "must be an object"); return false; } return true; };

  function money(v, p) {
    if (!obj(v, p)) return;
    oneOf(v.currency, CURRENCIES, p + ".currency");
    num(v.amount, p + ".amount"); num(v.nis, p + ".nis");
    if (!(v.rate === null || isNum(v.rate))) err(p + ".rate", "must be a number or null");
    date(v.rate_date === undefined ? null : v.rate_date, p + ".rate_date", true);
    date(v.as_of, p + ".as_of");
    if (v.currency === "ILS" && isNum(v.amount) && isNum(v.nis) && Math.abs(v.amount - v.nis) > 0.005) err(p, "an ILS amount must equal its nis value");
  }

  if (!isObj(feed)) return { ok: false, errors: ["feed: must be a JSON object"] };

  const vp = need(feed, "feed_version", "") && versionProblem(feed.feed_version);
  if (vp) err("feed_version", vp);
  if (errors.length && /newer feed refused/.test(errors[0])) return { ok: false, errors };   // a newer major is not read at all
  const required = ["generated_at", "synthetic", "sources", "balances", "periods"];
  for (const k of required) need(feed, k, "");
  if (feed.generated_at != null && !isDateTime(feed.generated_at)) err("generated_at", "must be an ISO date and time");
  if (feed.synthetic != null) bool(feed.synthetic, "synthetic");

  if (Array.isArray(feed.sources) || feed.sources == null) {
    if (feed.sources) rows(feed.sources, "sources", (s, p) => {
      str(s.id, p + ".id"); str(s.label, p + ".label"); oneOf(s.kind, SOURCE_KINDS, p + ".kind"); oneOf(s.scope, SCOPES, p + ".scope");
      if (!Array.isArray(s.currencies) || s.currencies.some((c) => !CURRENCIES.includes(c))) err(p + ".currencies", "must be a list of ILS|USD|EUR");
      date(s.last_import_date, p + ".last_import_date"); date(s.as_of, p + ".as_of");
      if (s.fresh !== undefined) bool(s.fresh, p + ".fresh");
      if (s.manual !== undefined) bool(s.manual, p + ".manual");
      if (s.last_full_refresh != null) date(s.last_full_refresh, p + ".last_full_refresh");
      if (s.next_due != null) date(s.next_due, p + ".next_due");
    });
  } else err("sources", "must be a list");

  if (Array.isArray(feed.balances) || feed.balances == null) {
    if (feed.balances) rows(feed.balances, "balances", (b, p) => {
      str(b.source, p + ".source"); oneOf(b.currency, CURRENCIES, p + ".currency"); num(b.amount, p + ".amount"); num(b.nis, p + ".nis");
      if (!(b.rate === null || b.rate === undefined || isNum(b.rate))) err(p + ".rate", "must be a number or null");
      date(b.rate_date === undefined ? null : b.rate_date, p + ".rate_date", true); date(b.as_of, p + ".as_of");
    });
  } else err("balances", "must be a list");

  if (feed.nis_total !== undefined) {
    if (obj(feed.nis_total, "nis_total")) for (const s of SCOPES) if (feed.nis_total[s] !== undefined) money(feed.nis_total[s], "nis_total." + s);
  }
  if (feed.by_currency !== undefined) {
    if (obj(feed.by_currency, "by_currency")) for (const s of SCOPES) if (feed.by_currency[s] !== undefined) rows(feed.by_currency[s], "by_currency." + s, (r, p) => { oneOf(r.currency, CURRENCIES, p + ".currency"); num(r.amount, p + ".amount"); num(r.nis, p + ".nis"); });
  }

  if (Array.isArray(feed.periods) || feed.periods == null) {
    if (feed.periods) rows(feed.periods, "periods", (r, p) => {
      if (!isPeriod(r.id)) err(p + ".id", "must be a period YYYY-MM"); oneOf(r.scope, SCOPES, p + ".scope");
      money(r.income, p + ".income"); money(r.expenses, p + ".expenses"); money(r.net, p + ".net"); int(r.to_check, p + ".to_check"); date(r.as_of, p + ".as_of");
      if (r.rate_date != null) date(r.rate_date, p + ".rate_date");
    });
  } else err("periods", "must be a list");

  if (feed.vat !== undefined && obj(feed.vat, "vat")) {
    oneOf(feed.vat.scope, SCOPES, "vat.scope");
    rows(feed.vat.periods, "vat.periods", (r, p) => {
      if (!isPeriod(r.period)) err(p + ".period", "must be a period YYYY-MM");
      money(r.charged, p + ".charged"); money(r.input, p + ".input"); money(r.refund_or_due, p + ".refund_or_due"); int(r.to_check, p + ".to_check"); date(r.file_by, p + ".file_by"); date(r.as_of, p + ".as_of");
    });
  }

  if (feed.invoices !== undefined && obj(feed.invoices, "invoices")) {
    const iv = feed.invoices;
    for (const k of ["unpaid", "overdue"]) if (iv[k] !== undefined && obj(iv[k], "invoices." + k)) { int(iv[k].count, "invoices." + k + ".count"); money(iv[k].amount, "invoices." + k + ".amount"); }
    if (iv.rows !== undefined) rows(iv.rows, "invoices.rows", (r, p) => {
      str(r.id, p + ".id"); oneOf(r.direction, INVOICE_DIR, p + ".direction"); str(r.party_masked, p + ".party_masked"); date(r.date, p + ".date"); date(r.due, p + ".due");
      oneOf(r.status, INVOICE_STATUS, p + ".status"); oneOf(r.scope, ROW_SCOPES, p + ".scope"); money(r.money, p + ".money");
    });
  }

  if (feed.income !== undefined && obj(feed.income, "income")) {
    if (feed.income.by_client !== undefined) rows(feed.income.by_client, "income.by_client", (r, p) => {
      str(r.party_masked, p + ".party_masked"); oneOf(r.kind, INCOME_KINDS, p + ".kind"); oneOf(r.currency, CURRENCIES, p + ".currency");
      if (!isPeriod(r.month)) err(p + ".month", "must be a period YYYY-MM"); oneOf(r.scope, ROW_SCOPES, p + ".scope"); money(r.money, p + ".money");
    });
    if (feed.income.expected_vs_received !== undefined) rows(feed.income.expected_vs_received, "income.expected_vs_received", (r, p) => {
      if (!isPeriod(r.period)) err(p + ".period", "must be a period YYYY-MM"); oneOf(r.scope, SCOPES, p + ".scope"); money(r.expected, p + ".expected"); money(r.received, p + ".received");
    });
  }

  if (feed.expenses !== undefined && obj(feed.expenses, "expenses") && feed.expenses.by_category !== undefined) {
    rows(feed.expenses.by_category, "expenses.by_category", (r, p) => { str(r.category, p + ".category"); if (!isPeriod(r.period)) err(p + ".period", "must be a period YYYY-MM"); oneOf(r.scope, ROW_SCOPES, p + ".scope"); money(r.money, p + ".money"); });
  }

  if (feed.cards !== undefined) rows(feed.cards, "cards", (c, p) => {
    str(c.card_label, p + ".card_label"); oneOf(c.scope, ROW_SCOPES, p + ".scope");
    if (obj(c.cycle, p + ".cycle")) { date(c.cycle.start, p + ".cycle.start"); date(c.cycle.end, p + ".cycle.end"); }
    date(c.due_date, p + ".due_date"); money(c.amount_due, p + ".amount_due");
    if (c.charges !== undefined) rows(c.charges, p + ".charges", (h, q) => {
      date(h.date, q + ".date"); str(h.category, q + ".category"); oneOf(h.receipt, RECEIPT, q + ".receipt"); money(h.orig, q + ".orig");
      if (h.instalment != null) { if (obj(h.instalment, q + ".instalment")) { int(h.instalment.n, q + ".instalment.n"); int(h.instalment.of, q + ".instalment.of"); } }
    });
  });

  if (feed.needs_you !== undefined && obj(feed.needs_you, "needs_you")) {
    if (feed.needs_you.by_type !== undefined) rows(feed.needs_you.by_type, "needs_you.by_type", (r, p) => { str(r.type, p + ".type"); int(r.count, p + ".count"); });
    if (feed.needs_you.items !== undefined) rows(feed.needs_you.items, "needs_you.items", (r, p) => { str(r.type, p + ".type"); str(r.label, p + ".label"); oneOf(r.scope, ROW_SCOPES, p + ".scope"); int(r.age_days, p + ".age_days"); date(r.due === undefined ? null : r.due, p + ".due", true); });
  }

  if (feed.accountant_package !== undefined && obj(feed.accountant_package, "accountant_package")) {
    const a = feed.accountant_package;
    if (a.handover_date !== undefined) date(a.handover_date, "accountant_package.handover_date");
    for (const k of ["parts_ready", "parts_total", "items_to_check"]) if (a[k] !== undefined) int(a[k], "accountant_package." + k);
    if (a.parts !== undefined) rows(a.parts, "accountant_package.parts", (r, p) => { str(r.name, p + ".name"); bool(r.ready, p + ".ready"); });
    if (a.prev_month !== undefined && obj(a.prev_month, "accountant_package.prev_month")) { int(a.prev_month.parts_ready, "accountant_package.prev_month.parts_ready"); int(a.prev_month.items_to_check, "accountant_package.prev_month.items_to_check"); }
    if (a.status !== undefined && obj(a.status, "accountant_package.status")) { bool(a.status.send_blocked, "accountant_package.status.send_blocked"); if (a.status.reason !== undefined && !isStr(a.status.reason)) err("accountant_package.status.reason", "must be text"); }
  }

  if (feed.rates !== undefined) rows(feed.rates, "rates", (r, p) => { oneOf(r.currency, CURRENCIES, p + ".currency"); num(r.rate, p + ".rate"); date(r.date, p + ".date"); });
  if (feed.period_end_rates !== undefined) rows(feed.period_end_rates, "period_end_rates", (r, p) => { oneOf(r.currency, CURRENCIES, p + ".currency"); if (!isPeriod(r.period)) err(p + ".period", "must be a period YYYY-MM"); num(r.rate, p + ".rate"); date(r.date, p + ".date"); });
  if (feed.transactions !== undefined) rows(feed.transactions, "transactions", (r, p) => { str(r.source, p + ".source"); date(r.date, p + ".date"); str(r.category, p + ".category"); oneOf(r.match_status, MATCH, p + ".match_status"); money(r.money, p + ".money"); });

  if (feed.cash_flow_60d !== undefined && obj(feed.cash_flow_60d, "cash_flow_60d")) {
    const c = feed.cash_flow_60d;
    if (c.days !== undefined) rows(c.days, "cash_flow_60d.days", (r, p) => { date(r.date, p + ".date"); num(r.balance_nis_projected, p + ".balance_nis_projected"); num(r.in, p + ".in"); num(r.out, p + ".out"); });
    if (c.expected !== undefined) rows(c.expected, "cash_flow_60d.expected", (r, p) => { date(r.date, p + ".date"); str(r.kind, p + ".kind"); if (r.direction !== undefined) oneOf(r.direction, ["in", "out"], p + ".direction"); money(r.money, p + ".money"); });
  }

  if (full) errors.push("(more problems not listed)");
  return { ok: errors.length === 0, errors };
}

module.exports = { validateFeed, isDate, MAX_ROWS, MAX_ERRORS, CURRENCIES, SUPPORTED_MAJOR };
