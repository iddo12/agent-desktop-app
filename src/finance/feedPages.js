// MY FINANCE feed pages (v1.130.0, slice 2, main process, pure): one small, scope-filtered view per page of the approved mock-up
// (cards, invoices, income, expenses, vat, accounts, queue, package, rates, sources, cash). Input is an already validated feed
// (feedValidator.js); output is plain data for the renderer (finance-pages.js). Lists are capped and paged here so a payload stays small;
// every view carries the dates its figures are "as of". Nothing here reads a file, writes, or logs.
"use strict";

const PAGES = ["cards", "invoices", "income", "expenses", "vat", "accounts", "queue", "package", "rates", "sources", "cash"];
const PAGE_SIZE = 50;
const MAX_CHARGES = 100;
const MAX_CLIENT_ROWS = 100;
const FILTERS = { invoices: ["unpaid", "overdue", "paid"], accounts: ["matched", "unmatched", "needs_check"] };
const SCOPES = ["business", "personal", "all"];

const inScope = (rowScope, scope) => scope === "all" || rowScope === scope || rowScope === "all";
const sum = (a) => a.reduce((x, y) => x + y, 0);
const maxStr = (a) => a.reduce((m, x) => (x && x > m ? x : m), "") || null;
const dayNum = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const mny = (m) => ({ cur: m.currency, amt: m.amount, nis: m.nis, as_of: m.as_of });
const desc = (k) => (a, b) => (a[k] < b[k] ? 1 : a[k] > b[k] ? -1 : 0);

function pageView(feed, page, scopeIn, o) {
  const opts = o || {};
  const scope = SCOPES.includes(scopeIn) ? scopeIn : "all";
  const today = typeof opts.today === "string" ? opts.today : new Date().toISOString().slice(0, 10);
  const links = opts.loginLinks || Object.create(null);
  const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? Math.min(opts.offset, 100000) : 0;
  const filter = FILTERS[page] && FILTERS[page].includes(opts.filter) ? opts.filter : null;
  const generated = String(feed.generated_at).slice(0, 10);
  const base = { page, scope, today, synthetic: !!feed.synthetic, generated };
  const srcById = new Map(feed.sources.map((s) => [s.id, s]));
  const srcRow = (s) => {
    const age = dayNum(today) - dayNum(s.last_import_date);
    return { id: s.id, label: s.label, kind: s.kind, scope: s.scope, manual: !!s.manual, last_import_date: s.last_import_date, age_days: age, fresh: age <= 7, last_full_refresh: s.last_full_refresh || null, next_due: s.next_due || null, next_due_overdue: !!(s.next_due && s.next_due < today), link: Object.prototype.hasOwnProperty.call(links, s.id) ? links[s.id] : null };
  };

  switch (page) {
    case "cards": {
      const cards = (feed.cards || []).filter((c) => inScope(c.scope, scope)).map((c) => {
        const ch = c.charges || [];
        return {
          label: c.card_label, scope: c.scope, cycle: c.cycle, due_date: c.due_date, due: mny(c.amount_due),
          charges: ch.slice().sort(desc("date")).slice(0, MAX_CHARGES).map((x) => ({ date: x.date, category: x.category, tag: x.tag || "", receipt: x.receipt, cur: x.orig.currency, amt: x.orig.amount, nis: x.orig.nis, as_of: x.orig.as_of, instalment: x.instalment || null })),
          charges_total: ch.length, missing: ch.filter((x) => x.receipt === "missing").length,
          instalments: ch.filter((x) => x.instalment).map((x) => ({ category: x.category, n: x.instalment.n, of: x.instalment.of, left: Math.max(0, x.instalment.of - x.instalment.n), nis: x.orig.nis })),
        };
      });
      return Object.assign(base, { cards, as_of: maxStr(cards.map((c) => c.due.as_of)) });
    }
    case "invoices": {
      const iv = feed.invoices;
      if (!iv) return Object.assign(base, { empty: true });
      const all = (iv.rows || []).filter((r) => inScope(r.scope, scope));
      const pick = (st) => { const a = all.filter((x) => x.status === st); return { count: a.length, nis: sum(a.map((x) => x.money.nis)) }; };
      const summary = scope === "all" && iv.unpaid && iv.overdue
        ? { unpaid: { count: iv.unpaid.count, nis: iv.unpaid.amount.nis }, overdue: { count: iv.overdue.count, nis: iv.overdue.amount.nis }, paid: pick("paid") }
        : { unpaid: pick("unpaid"), overdue: pick("overdue"), paid: pick("paid") };
      const rows = all.filter((x) => !filter || x.status === filter).sort(desc("date"));
      return Object.assign(base, { filter, summary, total: rows.length, offset, limit: PAGE_SIZE, as_of: maxStr(all.map((x) => x.money.as_of)) || (iv.unpaid && iv.unpaid.amount.as_of) || null,
        rows: rows.slice(offset, offset + PAGE_SIZE).map((x) => ({ id: x.id, direction: x.direction, party: x.party_masked, date: x.date, due: x.due, status: x.status, cur: x.money.currency, amt: x.money.amount, nis: x.money.nis })) });
    }
    case "income": {
      const inc = feed.income || {};
      const rows = (inc.by_client || []).filter((r) => inScope(r.scope, scope));
      const g = new Map();
      for (const r of rows) {
        const k = r.party_masked + "|" + r.kind + "|" + r.month;
        const x = g.get(k) || { party: r.party_masked, kind: r.kind, month: r.month, nis: 0, currencies: new Set(), as_of: r.money.as_of };
        x.nis += r.money.nis; x.currencies.add(r.currency); if (r.money.as_of > x.as_of) x.as_of = r.money.as_of; g.set(k, x);
      }
      const by = Array.from(g.values()).sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : b.nis - a.nis));
      const total = sum(by.map((x) => x.nis));
      const cur = new Map();
      for (const r of rows) { const x = cur.get(r.currency) || { currency: r.currency, amt: 0, nis: 0 }; x.amt += r.money.amount; x.nis += r.money.nis; cur.set(r.currency, x); }
      const evr = new Map();
      for (const r of (inc.expected_vs_received || []).filter((r) => inScope(r.scope, scope))) {
        const x = evr.get(r.period) || { period: r.period, expected: 0, received: 0, as_of: r.received.as_of };
        x.expected += r.expected.nis; x.received += r.received.nis; if (r.received.as_of > x.as_of) x.as_of = r.received.as_of; evr.set(r.period, x);
      }
      const ev = Array.from(evr.values()).sort(desc("period")).slice(0, 2);
      return Object.assign(base, {
        total, by_client: by.slice(0, MAX_CLIENT_ROWS).map((x) => ({ party: x.party, kind: x.kind, month: x.month, nis: x.nis, share: total ? Math.round((x.nis / total) * 100) : 0, currencies: Array.from(x.currencies), as_of: x.as_of })),
        by_client_total: by.length, by_currency: Array.from(cur.values()), expected_vs_received: ev, as_of: maxStr(by.map((x) => x.as_of).concat(ev.map((x) => x.as_of))) });
    }
    case "expenses": {
      const rows = ((feed.expenses && feed.expenses.by_category) || []).filter((r) => inScope(r.scope, scope));
      const ids = Array.from(new Set(rows.map((r) => r.period))).sort().reverse();
      const thisId = ids[0] || null, lastId = ids[1] || null;
      const cat = new Map();
      for (const r of rows) { const x = cat.get(r.category) || { category: r.category, this: 0, last: 0 }; if (r.period === thisId) x.this += r.money.nis; else if (r.period === lastId) x.last += r.money.nis; cat.set(r.category, x); }
      const list = Array.from(cat.values()).sort((a, b) => b.this - a.this).map((x) => Object.assign(x, { change: x.last ? Math.round(((x.this - x.last) / x.last) * 100) : null }));
      return Object.assign(base, { period: thisId, previous: lastId, categories: list.slice(0, 100), total: { this: sum(list.map((x) => x.this)), last: sum(list.map((x) => x.last)) }, as_of: maxStr(rows.map((r) => r.money.as_of)) });
    }
    case "vat": {
      const v = feed.vat;
      if (!v || !inScope(v.scope, scope) || !v.periods.length) return Object.assign(base, { periods: [], as_of: null });
      const ps = v.periods.slice().sort((a, b) => (a.period < b.period ? 1 : -1)).slice(0, 12).map((r) => ({ period: r.period, charged: r.charged.nis, input: r.input.nis, result: r.refund_or_due.nis, to_check: r.to_check, file_by: r.file_by, as_of: r.as_of }));
      return Object.assign(base, { periods: ps, as_of: ps[0].as_of });
    }
    case "accounts": {
      const sources = feed.sources.filter((s) => inScope(s.scope, scope)).map(srcRow);
      const sById = new Map(sources.map((s) => [s.id, s]));
      const balances = feed.balances.filter((b) => sById.has(b.source)).map((b) => ({ source: b.source, label: sById.get(b.source).label, currency: b.currency, amount: b.amount, nis: b.nis, as_of: b.as_of }));
      const tx = (feed.transactions || []).filter((t) => sById.has(t.source));
      const counts = { matched: 0, unmatched: 0, needs_check: 0 };
      for (const t of tx) counts[t.match_status]++;
      const rows = tx.filter((t) => !filter || t.match_status === filter).sort(desc("date"));
      return Object.assign(base, { filter, sources, balances, total_nis: sum(balances.map((b) => b.nis)), counts, total: rows.length, offset, limit: PAGE_SIZE,
        transactions: rows.slice(offset, offset + PAGE_SIZE).map((t) => ({ date: t.date, source: sById.get(t.source).label, category: t.category, tag: t.tag || "", cur: t.money.currency, amt: t.money.amount, nis: t.money.nis, match: t.match_status })),
        as_of: maxStr(balances.map((b) => b.as_of)) });
    }
    case "queue": {
      const items = ((feed.needs_you && feed.needs_you.items) || []).filter((x) => inScope(x.scope, scope));
      const by = new Map(); for (const x of items) by.set(x.type, (by.get(x.type) || 0) + 1);
      return Object.assign(base, { count: items.length, by_type: Array.from(by, ([type, count]) => ({ type, count })), as_of: generated,
        items: items.slice().sort((a, b) => b.age_days - a.age_days).slice(0, 200).map((x) => ({ type: x.type, label: x.label, scope: x.scope, source: srcById.has(x.source) ? srcById.get(x.source).label : x.source, age_days: x.age_days, due: x.due || null })) });
    }
    case "package": {
      const a = feed.accountant_package;
      if (!a) return Object.assign(base, { empty: true });
      const st = a.status || {};
      return Object.assign(base, { handover_date: a.handover_date || null, days_left: a.handover_date ? dayNum(a.handover_date) - dayNum(today) : null, parts_ready: a.parts_ready, parts_total: a.parts_total, items_to_check: a.items_to_check,
        parts: (a.parts || []).slice(0, 50).map((p) => ({ name: p.name, ready: !!p.ready })), prev_month: a.prev_month || null, send_blocked: st.send_blocked !== false, reason: typeof st.reason === "string" ? st.reason : "", as_of: generated, all_scopes: true });
    }
    case "rates": {
      const pe = new Map();
      for (const r of (feed.period_end_rates || [])) { const x = pe.get(r.currency); if (!x || r.period > x.period) pe.set(r.currency, { currency: r.currency, period: r.period, rate: r.rate, date: r.date }); }
      const hold = feed.by_currency && feed.by_currency[scope] ? feed.by_currency[scope].map((r) => ({ currency: r.currency, amt: r.amount, nis: r.nis }))
        : Array.from(feed.balances.filter((b) => srcById.has(b.source) && inScope(srcById.get(b.source).scope, scope)).reduce((m, b) => { const x = m.get(b.currency) || { currency: b.currency, amt: 0, nis: 0 }; x.amt += b.amount; x.nis += b.nis; return m.set(b.currency, x); }, new Map()).values());
      const rates = (feed.rates || []).map((r) => ({ currency: r.currency, rate: r.rate, date: r.date, source: r.source || "BoI" }));
      return Object.assign(base, { rates, period_end: Array.from(pe.values()), holdings: hold, source_name: "Bank of Israel", as_of: maxStr(rates.map((r) => r.date)) });
    }
    case "sources": {
      const sources = feed.sources.filter((s) => inScope(s.scope, scope)).map(srcRow);
      const lf = maxStr(sources.map((s) => s.last_full_refresh)), nd = sources.map((s) => s.next_due).filter(Boolean).sort()[0] || null;
      return Object.assign(base, { sources, last_full_refresh: lf, next_due: nd, next_due_overdue: !!(nd && nd < today), as_of: generated });
    }
    case "cash": {
      const c = feed.cash_flow_60d;
      if (!c || !c.days || !c.days.length) return Object.assign(base, { empty: true });
      const days = c.days.slice(0, 90).map((d) => ({ date: d.date, bal: d.balance_nis_projected, in: d.in, out: d.out }));
      const bals = days.map((d) => d.bal);
      const exp = (c.expected || []).slice(0, 100).map((e) => ({ date: e.date, kind: e.kind, direction: e.direction || (e.money.nis < 0 ? "out" : "in"), cur: e.money.currency, amt: e.money.amount, nis: e.money.nis, as_of: e.money.as_of }));
      return Object.assign(base, { days, expected: exp, now: days[0].bal, end: days[days.length - 1].bal, min: Math.min(...bals), all_accounts: true, as_of: maxStr(exp.map((e) => e.as_of)) || generated });
    }
    default: return null;
  }
}

module.exports = { pageView, PAGES, FILTERS, PAGE_SIZE };
