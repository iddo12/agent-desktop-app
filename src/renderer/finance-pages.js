// My Finance feed pages (v1.130.0, slice 2). Loaded by finance-nav.js BEFORE finance.js; finance.js hands over its helpers with
// window.financePages.build(H) and calls render(S, tab). One page per approved mock-up page (UI-UX "My Finance detail pages"):
// cards, invoices, income, expenses, vat, accounts, queue, package, rates, sources, cash. Every page shows the date its figures are "as of";
// every non-zero count is a button that opens the list behind it; the Business / Personal / All toggle (drawn by finance.js) applies to all.
// PRIVACY: textContent only, no HTML strings, nothing logged, nothing stored. READ-ONLY: there is no button here that sends, pays or changes
// anything (the accountant package shows why sending is blocked and has no send button).
(function () {
  "use strict";
  const NS = ["http:", "", "www.w3.org", "2000", "svg"].join("/");   // the SVG namespace id, not an address

  function build(H) {
    const { el, auto, grp, orig, shortDay, MON } = H;
    const nisT = (n) => (n < 0 ? "-" : "") + grp(n);
    const sgn = (n) => (n > 0 ? "+" : n < 0 ? "-" : "") + grp(n);
    const asOf = (d) => el("div", "mf-asof-line", d ? "Data as of " + shortDay(d) : "Data date not given");
    const periodWord = (id) => (id && /^\d{4}-\d{2}$/.test(id) ? MON[+id.slice(5, 7) - 1] + " " + id.slice(0, 4) : "");
    const btn = (text, onClick, cls) => { const b = el("button", cls || "mf-linkbtn", text); b.type = "button"; b.addEventListener("click", onClick); return b; };
    const chip = (text, cls) => el("span", "mf-chip" + (cls ? " " + cls : ""), text);

    function table(heads, rows, cls) {
      const wrap = el("div", "mf-tablewrap"), t = el("table", "mf-table mf-home-table" + (cls ? " " + cls : ""));
      const th = el("thead"), hr = el("tr");
      for (const h of heads) hr.appendChild(el("th", h.num ? "mf-num" : "", h.t));
      th.appendChild(hr); t.appendChild(th);
      const tb = el("tbody");
      for (const r of rows) {
        const tr = el("tr", r.cls || "");
        (r.cells || r).forEach((c, i) => {
          const td = el("td", heads[i] && heads[i].num ? "mf-num" + (c && c.neg ? " mf-neg" : "") : "");
          if (c && c.node) td.appendChild(c.node); else if (c && typeof c === "object" && "t" in c) td.textContent = c.t; else if (c instanceof Node) td.appendChild(c); else td.textContent = c == null ? "" : String(c);
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      }
      t.appendChild(tb); wrap.appendChild(t); return wrap;
    }
    const money = (cur, amt) => ({ t: orig(cur, amt), neg: amt < 0 });
    const nisCell = (n) => ({ t: nisT(n), neg: n < 0 });
    const card = (title, date) => H.homeCard(title, date);
    const tile = (label, value, sub, warn, onClick) => {
      const t = el("div", "mf-tile2 " + (warn ? "mf-tile2-w" : "mf-tile2-ok"));
      t.appendChild(el("b", "", label));
      if (onClick) t.appendChild(btn(value, onClick, "mf-linkbtn mf-tile-val")); else t.appendChild(el("span", "mf-tile-val", value));
      if (sub) t.appendChild(el("span", "mf-st", sub));
      return t;
    };
    const empty = (text) => el("p", "mf-muted", text);
    const heading = (S, title, d) => { const w = el("div", "mf-page-h"); w.appendChild(el("h2", "mf-h2", title)); w.appendChild(asOf(d)); return w; };
    function pager(S, tab, P) {
      const w = el("div", "mf-pager");
      const from = P.total ? P.offset + 1 : 0, to = Math.min(P.total, P.offset + P.limit);
      w.appendChild(el("span", "mf-asof", from + "-" + to + " of " + P.total));
      const prev = btn("‹ Previous", () => S.onPage(tab, Math.max(0, P.offset - P.limit), P.filter), "mf-btn"); prev.disabled = P.offset <= 0;
      const next = btn("Next ›", () => S.onPage(tab, P.offset + P.limit, P.filter), "mf-btn"); next.disabled = to >= P.total;
      w.append(prev, next); return w;
    }
    function filterSelect(S, tab, P, label, options) {
      const l = el("label", "mf-filter"); l.appendChild(el("span", "", label));
      const sel = el("select"); sel.setAttribute("aria-label", label);
      for (const [v, t] of [["", "All"]].concat(options)) { const o = el("option", "", t); o.value = v; if ((P.filter || "") === v) o.selected = true; sel.appendChild(o); }
      sel.addEventListener("change", () => S.onPage(tab, 0, sel.value || null));
      l.appendChild(sel); return l;
    }
    const receiptChip = (r) => (r === "matched" ? chip("✓ Matched", "mf-chip-ok") : chip("? Missing"));
    const matchChip = (m) => (m === "matched" ? chip("✓ Matched", "mf-chip-ok") : m === "unmatched" ? chip("? Unmatched") : chip("! Needs check"));
    const statusChip = (s) => (s === "paid" ? chip("✓ Paid", "mf-chip-ok") : s === "overdue" ? chip("▲ Overdue", "mf-chip-bad") : chip("Unpaid"));
    const sourceState = (s) => (!s.fresh ? chip("▲ Stale, " + s.age_days + " days") : s.manual ? chip("! Manual") : chip("✓ OK", "mf-chip-ok"));

    // ------------------------------------------------------------ pages
    function cards(S, P) {
      const root = el("div", "mf-page");
      root.appendChild(heading(S, "Credit cards", P.as_of));
      if (!P.cards.length) { root.appendChild(empty("No cards in this view.")); return root; }
      const only = S.pf.fcards === "missing";
      const cols = el("div", "mf-home-cols");
      for (const c of P.cards) {
        const k = card(c.label, c.due.as_of);
        k.appendChild(el("div", "mf-big", grp(c.due.nis) + " due " + shortDay(c.due_date)));
        k.appendChild(el("p", "mf-note", "Cycle " + shortDay(c.cycle.start) + " - " + shortDay(c.cycle.end) + " so far (" + c.scope + ")."));
        if (c.missing) k.appendChild(btn(c.missing + " charge" + (c.missing === 1 ? "" : "s") + " without a receipt" + (only ? " (showing only these; click to show all)" : " (click to list)"), () => S.onFilterLocal("fcards", only ? null : "missing")));
        else k.appendChild(el("p", "mf-note", "✓ every charge has a receipt"));
        cols.appendChild(k);
      }
      root.appendChild(cols);
      for (const c of P.cards) {
        const rows = c.charges.filter((x) => !only || x.receipt === "missing");
        const k = card("Charges, " + c.label, c.due.as_of);
        k.appendChild(rows.length ? table([{ t: "Date" }, { t: "Category" }, { t: "Tag" }, { t: "Original", num: 1 }, { t: "NIS", num: 1 }, { t: "Receipt" }],
          rows.map((x) => [shortDay(x.date), { node: auto(el("span", "", x.category)) }, x.tag, money(x.cur, x.amt), nisCell(x.nis), { node: receiptChip(x.receipt) }])) : empty("No charges to show."));
        if (c.charges_total > c.charges.length) k.appendChild(el("p", "mf-note", "Showing the newest " + c.charges.length + " of " + c.charges_total + " charges."));
        if (c.instalments.length) {
          k.appendChild(el("h3", "mf-home-h", "Instalments still running"));
          k.appendChild(table([{ t: "Item" }, { t: "Paid" }, { t: "Left", num: 1 }, { t: "Per month", num: 1 }], c.instalments.map((i) => [{ node: auto(el("span", "", i.category)) }, i.n + " of " + i.of, { t: String(i.left) }, nisCell(i.nis)])));
        }
        root.appendChild(k);
      }
      return root;
    }

    function invoices(S, P) {
      const root = el("div", "mf-page");
      root.appendChild(heading(S, "Invoices", P.as_of));
      if (P.empty) { root.appendChild(empty("No invoices in the feed.")); return root; }
      const sm = P.summary, tiles = el("div", "mf-tiles4");
      const go = (f) => () => S.onPage("finvoices", 0, P.filter === f ? null : f);
      tiles.append(
        tile("Unpaid", sm.unpaid.count + " · " + grp(sm.unpaid.nis), "as of " + shortDay(P.as_of), false, sm.unpaid.count ? go("unpaid") : null),
        tile("▲ Overdue", sm.overdue.count + " · " + grp(sm.overdue.nis), "as of " + shortDay(P.as_of), sm.overdue.count > 0, sm.overdue.count ? go("overdue") : null),
        tile("Paid", sm.paid.count + " · " + grp(sm.paid.nis), "as of " + shortDay(P.as_of), false, sm.paid.count ? go("paid") : null));
      root.appendChild(tiles);
      const f = el("div", "mf-filters"); f.appendChild(filterSelect(S, "finvoices", P, "Status", [["unpaid", "Unpaid"], ["overdue", "Overdue"], ["paid", "Paid"]])); root.appendChild(f);
      const k = card("Invoices" + (P.filter ? ", " + P.filter : ""), P.as_of);
      k.appendChild(P.rows.length ? table([{ t: "No." }, { t: "Date" }, { t: "Dir." }, { t: "Client / supplier" }, { t: "Original", num: 1 }, { t: "NIS", num: 1 }, { t: "Due" }, { t: "Status" }],
        P.rows.map((x) => [x.id, shortDay(x.date), x.direction === "out" ? "Issued" : "Received", { node: auto(el("span", "", x.party)) }, money(x.cur, x.amt), nisCell(x.nis), shortDay(x.due), { node: statusChip(x.status) }])) : empty("No invoices match."));
      k.appendChild(pager(S, "finvoices", P)); root.appendChild(k); return root;
    }

    function income(S, P) {
      const root = el("div", "mf-page");
      root.appendChild(heading(S, "Income", P.as_of));
      const cols = el("div", "mf-home-cols");
      const ev = card("Expected vs received", P.expected_vs_received[0] && P.expected_vs_received[0].as_of);
      if (P.expected_vs_received.length) {
        const [a, b] = P.expected_vs_received;
        const line = (r, label) => { const d = el("div", "mf-home-per"); d.appendChild(el("div", "", label + " (" + periodWord(r.period) + "): received " + grp(r.received) + " of " + grp(r.expected)));
          const bar = el("div", "mf-bar2"), i = el("i", label === "This period" ? "mf-bar-now" : "mf-bar-prev"); i.style.width = Math.min(100, r.expected ? Math.round((r.received / r.expected) * 100) : 0) + "%"; bar.appendChild(i); d.appendChild(bar);
          d.appendChild(el("p", "mf-note", "Still expected: " + grp(Math.max(0, r.expected - r.received)))); return d; };
        ev.appendChild(line(a, "This period")); if (b) ev.appendChild(line(b, "Last period"));
      } else ev.appendChild(empty("No expected-vs-received figures."));
      const cu = card("By currency", P.as_of);
      cu.appendChild(P.by_currency.length ? table([{ t: "Currency" }, { t: "Original", num: 1 }, { t: "NIS", num: 1 }], P.by_currency.map((r) => [r.currency, money(r.currency, r.amt), nisCell(r.nis)])) : empty("No income rows."));
      cols.append(ev, cu); root.appendChild(cols);
      const k = card("By client, kind and month (total " + grp(P.total) + " NIS)", P.as_of);
      k.appendChild(P.by_client.length ? table([{ t: "Source" }, { t: "Kind" }, { t: "Month" }, { t: "NIS", num: 1 }, { t: "Share", num: 1 }, { t: "Currency" }],
        P.by_client.map((r) => [{ node: auto(el("span", "", r.party)) }, r.kind, periodWord(r.month), nisCell(r.nis), r.share + "%", r.currencies.join(", ")])) : empty("No income rows in this view."));
      if (P.by_client_total > P.by_client.length) k.appendChild(el("p", "mf-note", "Showing " + P.by_client.length + " of " + P.by_client_total + " rows."));
      root.appendChild(k); return root;
    }

    function expenses(S, P) {
      const root = el("div", "mf-page");
      root.appendChild(heading(S, "Expenses", P.as_of));
      const k = card("By category, " + (periodWord(P.period) || "no period") + (P.previous ? " vs " + periodWord(P.previous) : ""), P.as_of);
      if (!P.categories.length) { k.appendChild(empty("No expense rows in this view.")); root.appendChild(k); return root; }
      const rows = P.categories.map((c) => [{ node: auto(el("span", "", c.category)) }, nisCell(c.this), nisCell(c.last), c.change == null ? "-" : (c.change > 0 ? "▲ +" : c.change < 0 ? "▼ " : "■ ") + c.change + "%"]);
      rows.push({ cls: "mf-total", cells: ["Total", nisCell(P.total.this), nisCell(P.total.last), P.total.last ? (P.total.this >= P.total.last ? "▲ +" : "▼ ") + Math.round(((P.total.this - P.total.last) / P.total.last) * 100) + "%" : "-"] });
      k.appendChild(table([{ t: "Category" }, { t: "This period", num: 1 }, { t: "Last period", num: 1 }, { t: "Change", num: 1 }], rows));
      root.appendChild(k); return root;
    }

    function vat(S, P) {
      const root = el("div", "mf-page");
      root.appendChild(heading(S, "VAT report", P.as_of));
      if (!P.periods.length) { root.appendChild(empty("No VAT figures in this view (VAT is a business figure).")); return root; }
      const c = P.periods[0], hero = card("Period " + c.period, c.as_of);
      hero.appendChild(el("div", "mf-big", grp(c.result) + (c.result >= 0 ? " refund" : " to pay")));
      hero.appendChild(el("p", "mf-note", "Charged " + grp(c.charged) + " · Input " + grp(c.input) + " · File by " + shortDay(c.file_by) + (P.periods[1] ? " · Last period: " + (P.periods[1].result >= 0 ? "refund " : "to pay ") + grp(P.periods[1].result) : "")));
      if (c.to_check) hero.appendChild(btn(c.to_check + " item" + (c.to_check === 1 ? "" : "s") + " to check before this is final (open the list)", () => S.go("fqueue")));
      root.appendChild(hero);
      const k = card("Periods (current and previous)", P.as_of);
      k.appendChild(table([{ t: "Period" }, { t: "Charged", num: 1 }, { t: "Input", num: 1 }, { t: "Result", num: 1 }, { t: "To check", num: 1 }, { t: "File by" }, { t: "As of" }],
        P.periods.map((r) => [r.period, nisCell(r.charged), nisCell(r.input), { t: grp(r.result) + (r.result >= 0 ? " refund" : " to pay"), neg: r.result < 0 }, r.to_check ? { node: btn(String(r.to_check), () => S.go("fqueue")) } : "0 ✓", shortDay(r.file_by), shortDay(r.as_of)])));
      root.appendChild(k); return root;
    }

    function accounts(S, P) {
      const root = el("div", "mf-page");
      root.appendChild(heading(S, "Accounts & transactions", P.as_of));
      const k = card("Balances", P.as_of), byId = new Map(P.sources.map((s) => [s.id, s]));
      k.appendChild(P.balances.length ? table([{ t: "Account" }, { t: "In its currency", num: 1 }, { t: "In NIS", num: 1 }, { t: "Last import" }, { t: "Refresh" }],
        P.balances.map((b) => { const s = byId.get(b.source), cell = el("span"); if (s) { const a = H.loginLink(s); if (a) cell.append(a, document.createTextNode(" ")); cell.appendChild(H.freshMark(s)); }
          return [{ node: auto(el("span", "", b.label)) }, money(b.currency, b.amount), nisCell(b.nis), s ? { node: el("span", s.fresh ? "" : "mf-stale", (s.fresh ? "" : "▲ ") + shortDay(s.last_import_date) + (s.fresh ? "" : ", " + s.age_days + " days")) } : "", { node: cell }]; })
        .concat([{ cls: "mf-total", cells: ["Total in NIS, as of " + shortDay(P.as_of), "", nisCell(P.total_nis), "", ""] }])) : empty("No accounts in this view."));
      root.appendChild(k);
      const tiles = el("div", "mf-tiles4");
      for (const [key, label] of [["matched", "Matched"], ["unmatched", "Unmatched"], ["needs_check", "Needs check"]]) {
        const n = P.counts[key];
        tiles.appendChild(tile(label, String(n), "as of " + shortDay(P.as_of), key !== "matched" && n > 0, n ? () => S.onPage("faccounts", 0, P.filter === key ? null : key) : null));
      }
      root.appendChild(tiles);
      const f = el("div", "mf-filters"); f.appendChild(filterSelect(S, "faccounts", P, "Match", [["matched", "Matched"], ["unmatched", "Unmatched"], ["needs_check", "Needs check"]])); root.appendChild(f);
      const t = card("Transactions (masked)" + (P.filter ? ", " + P.filter.replace("_", " ") : ""), P.as_of);
      t.appendChild(P.transactions.length ? table([{ t: "Date" }, { t: "Account" }, { t: "Category" }, { t: "Original", num: 1 }, { t: "NIS", num: 1 }, { t: "Match" }],
        P.transactions.map((x) => [shortDay(x.date), { node: auto(el("span", "", x.source)) }, { node: auto(el("span", "", x.category)) }, money(x.cur, x.amt), nisCell(x.nis), { node: matchChip(x.match) }])) : empty("No transactions match."));
      t.appendChild(pager(S, "faccounts", P)); root.appendChild(t); return root;
    }

    function queue(S, P) {
      const root = el("div", "mf-page");
      root.appendChild(heading(S, "Needs you", P.as_of));
      if (!P.count) { root.appendChild(el("div", "mf-need", "Nothing needs you ✓ (checked as of " + shortDay(P.as_of) + ")")); return root; }
      const n = el("div", "mf-need"); n.appendChild(el("b", "", "Needs you: " + P.count + ". ")); n.appendChild(document.createTextNode(P.by_type.map((x) => x.count + " " + x.type.replace(/_/g, " ")).join(", "))); root.appendChild(n);
      const k = card("Items", P.as_of);
      k.appendChild(table([{ t: "Item" }, { t: "Type" }, { t: "Source" }, { t: "Age (days)", num: 1 }, { t: "Due" }], P.items.map((x) => [{ node: auto(el("span", "", x.label)) }, x.type.replace(/_/g, " "), { node: auto(el("span", "", x.source)) }, { t: String(x.age_days) }, x.due ? shortDay(x.due) : "-"])));
      k.appendChild(el("p", "mf-note", "Read-only list: decisions are made where the data lives, not here."));
      root.appendChild(k); return root;
    }

    function pkg(S, P) {
      const root = el("div", "mf-page");
      root.appendChild(heading(S, "Accountant package", P.as_of));
      if (P.empty) { root.appendChild(empty("No accountant package in the feed.")); return root; }
      const hero = card("Month-end handover" + (P.handover_date ? " " + shortDay(P.handover_date) : ""), P.as_of);
      if (P.days_left != null) hero.appendChild(el("div", "mf-big", P.days_left >= 0 ? P.days_left + " days left" : "▲ " + -P.days_left + " days overdue"));
      const bar = el("div", "mf-bar2"), i = el("i", "mf-bar-now"); i.style.width = (P.parts_total ? Math.round((P.parts_ready / P.parts_total) * 100) : 0) + "%"; bar.appendChild(i); hero.appendChild(bar);
      hero.appendChild(el("p", "mf-note", "Ready " + P.parts_ready + " of " + P.parts_total + " parts" + (P.prev_month ? " · last month at this point: " + P.prev_month.parts_ready + " ready, " + P.prev_month.items_to_check + " to check" : "") + "."));
      if (P.items_to_check) hero.appendChild(btn(P.items_to_check + " item" + (P.items_to_check === 1 ? "" : "s") + " to check (open the list)", () => S.go("fqueue")));
      root.appendChild(hero);
      const k = card("Parts", P.as_of);
      k.appendChild(table([{ t: "Part" }, { t: "Ready" }], P.parts.map((p) => [{ node: auto(el("span", "", p.name)) }, { node: p.ready ? chip("✓ Ready", "mf-chip-ok") : chip("Not ready") }])));
      root.appendChild(k);
      const st = el("div", "mf-need" + (P.send_blocked ? " mf-need-w" : "")); st.setAttribute("role", "note");
      st.append(el("b", "", P.send_blocked ? "Sending is blocked" : "Prepared only"), document.createTextNode(P.send_blocked ? (P.reason ? ": " + P.reason + ". " : ". ") : ". "), document.createTextNode("This pane only shows the package; nothing can be sent from here."));
      root.appendChild(st);
      root.appendChild(el("p", "mf-note", "The package covers business and personal together (the toggle does not change it)."));
      return root;
    }

    function rates(S, P) {
      const root = el("div", "mf-page");
      root.appendChild(heading(S, "Currencies & rates", P.as_of));
      const peBy = new Map(P.period_end.map((r) => [r.currency, r]));
      const k = card("Rates, " + P.source_name, P.as_of);
      k.appendChild(P.rates.length ? table([{ t: "Currency" }, { t: "Rate today", num: 1 }, { t: "Date" }, { t: "Source" }, { t: "Period-end rate", num: 1 }],
        P.rates.map((r) => { const pe = peBy.get(r.currency); return [r.currency, { t: String(r.rate) }, shortDay(r.date), P.source_name, pe ? { t: pe.rate + " (" + periodWord(pe.period) + ", " + shortDay(pe.date) + ")" } : "-"]; })) : empty("No rates in the feed."));
      root.appendChild(k);
      const h = card("Holdings by currency", P.as_of);
      h.appendChild(P.holdings.length ? table([{ t: "Currency" }, { t: "Balance", num: 1 }, { t: "NIS equivalent", num: 1 }], P.holdings.map((r) => [r.currency, money(r.currency, r.amt), nisCell(r.nis)])) : empty("No holdings in this view."));
      root.appendChild(h); return root;
    }

    function sources(S, P) {
      const root = el("div", "mf-page");
      root.appendChild(heading(S, "Sources & import", P.as_of));
      const k = card("Sources", P.as_of);
      k.appendChild(P.sources.length ? table([{ t: "Source" }, { t: "Last collected" }, { t: "State" }, { t: "Refresh" }, { t: "Last full refresh" }, { t: "Next due" }],
        P.sources.map((s) => { const r = el("span"); const a = H.loginLink(s); if (a) r.append(a, document.createTextNode(" ")); r.appendChild(H.freshMark(s));
          return [{ node: auto(el("span", "", s.label)) }, shortDay(s.last_import_date) + (s.manual ? " (manual)" : ""), { node: sourceState(s) }, { node: r }, s.last_full_refresh ? shortDay(s.last_full_refresh) : "-",
            { node: s.next_due ? el("span", s.next_due_overdue ? "mf-stale" : "", (s.next_due_overdue ? "▲ Overdue " : "") + shortDay(s.next_due)) : el("span", "", "-") }]; })) : empty("No sources in this view."));
      if (!P.links_set) {
        const h = el("div", "mf-need mf-need-w"); h.setAttribute("role", "note");
        h.append(el("b", "", "No login links are set. "), document.createTextNode("To get a \"Get fresh data\" link next to each source, open Setup and fill in the setting financeLoginLinks. One entry per source: the source id, an = sign, then the web address (https only); separate entries with a semicolon. Your source ids: " + (P.link_ids.length ? P.link_ids.join(", ") : "none") + ". Nothing is stored except the address you type."));
        root.appendChild(h);
      }
      root.appendChild(k);
      const o = el("ol", "mf-steps");
      for (const t of ["Log in to each institution with the links above (you type the login yourself; nothing is stored here).", "Export the statement, or take a screenshot if there is no export.", "Drop the files into the Import tab.", "Check the Needs you list."]) o.appendChild(el("li", "", t));
      const c = card("Weekly refresh checklist", P.as_of); c.appendChild(o);
      c.appendChild(el("p", "mf-note", "Last full refresh: " + (P.last_full_refresh ? shortDay(P.last_full_refresh) : "not known") + ". Next due: " + (P.next_due ? shortDay(P.next_due) : "not known") + ". ")); if (P.next_due_overdue) c.appendChild(chip("▲ Overdue", "mf-chip-bad"));
      c.appendChild(btn("Open the Import tab", () => S.go("import")));
      root.appendChild(c); return root;
    }

    function cash(S, P) {
      const root = el("div", "mf-page");
      root.appendChild(heading(S, "Cash flow & forecast", P.as_of));
      if (P.empty) { root.appendChild(empty("No cash-flow projection in the feed.")); return root; }
      const tiles = el("div", "mf-tiles4");
      tiles.append(tile("Now (projected)", nisT(P.now), "as of " + shortDay(P.as_of)), tile("Lowest point", nisT(P.min), "next " + P.days.length + " days", P.min < 0), tile("In " + P.days.length + " days", nisT(P.end), (P.end - P.now >= 0 ? "▲ +" : "▼ ") + grp(P.end - P.now) + " vs now"));
      root.appendChild(tiles);
      const k = card("Projected balance, next " + P.days.length + " days, in NIS", P.as_of);
      const W = 620, Hh = 220, L = 10, R = 10, T = 28, B = 52, n = P.days.length;
      const lo = Math.min.apply(null, P.days.map((d) => d.bal)), hi = Math.max.apply(null, P.days.map((d) => d.bal)), span = Math.max(1, hi - lo);
      const X = (i) => L + (n > 1 ? (i * (W - L - R)) / (n - 1) : 0), Y = (v) => T + (Hh - T - B) * (1 - (v - lo) / span);
      const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 " + W + " " + Hh); svg.setAttribute("class", "mf-hchart"); svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Projected balance in NIS for the next " + n + " days; start " + nisT(P.now) + ", lowest " + nisT(P.min) + ", end " + nisT(P.end) + ". The table below lists the expected items.");
      const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const a of Object.keys(attrs)) e.setAttribute(a, attrs[a]); if (text != null) e.textContent = text; svg.appendChild(e); return e; };
      add("polyline", { points: P.days.map((d, i) => X(i).toFixed(1) + "," + Y(d.bal).toFixed(1)).join(" "), class: "mf-cash-line", fill: "none" });
      const label = new Set([0, n - 1, P.days.findIndex((d) => d.bal === P.min)]); for (let i = 10; i < n - 5; i += 10) label.add(i);
      const lowIdx = P.days.findIndex((d) => d.bal === P.min);
      for (const i of label) {
        const d = P.days[i];
        add("circle", { cx: X(i).toFixed(1), cy: Y(d.bal).toFixed(1), r: 3, class: "mf-cash-dot" });
        // the lowest point sits on the bottom edge with the line rising on both sides: its label goes UNDER the dot (the chart keeps 52 units free below the line for it and for the item ticks)
        if (i === lowIdx && i !== 0 && i !== n - 1) add("text", { x: Math.min(W - 24, Math.max(24, X(i))).toFixed(1), y: (Y(d.bal) + 20).toFixed(1), "text-anchor": "middle", class: "mf-hchart-t mf-cash-low" }, nisT(d.bal));
        else add("text", { x: Math.min(W - 24, Math.max(24, X(i))).toFixed(1), y: (Y(d.bal) - 8).toFixed(1), "text-anchor": "middle", class: "mf-hchart-t" }, nisT(d.bal));
      }
      const idx = new Map(P.days.map((d, i) => [d.date, i]));
      for (const e of P.expected) { const i = idx.get(e.date); if (i == null) continue; add("line", { x1: X(i).toFixed(1), x2: X(i).toFixed(1), y1: Hh - B + 26, y2: Hh - B + 34, class: "mf-cash-tick" }); }
      add("text", { x: L, y: Hh - 8, "text-anchor": "start", class: "mf-hchart-t" }, shortDay(P.days[0].date)); add("text", { x: W - R, y: Hh - 8, "text-anchor": "end", class: "mf-hchart-t" }, shortDay(P.days[n - 1].date));
      k.appendChild(svg);
      k.appendChild(el("p", "mf-note", "Line = projected balance (value on the start, the lowest point, the end and every 10th day); ticks under the line = expected items. Covers all accounts together (the toggle does not change it)."));
      root.appendChild(k);
      const e = card("Expected items", P.as_of);
      e.appendChild(P.expected.length ? table([{ t: "When" }, { t: "What" }, { t: "In / out" }, { t: "Original", num: 1 }, { t: "NIS", num: 1 }], P.expected.map((x) => [shortDay(x.date), { node: auto(el("span", "", x.kind)) }, x.direction === "in" ? "▲ in" : "▼ out", money(x.cur, x.amt), nisCell(x.nis)])) : empty("No expected items."));
      root.appendChild(e); return root;
    }

    const PAGES = { fcards: cards, finvoices: invoices, fincome: income, fexpenses: expenses, fvat: vat, faccounts: accounts, fqueue: queue, fpackage: pkg, frates: rates, fsources: sources, fcash: cash };
    return { render(S, tab, data) { const fn = PAGES[tab]; return fn ? fn(S, data) : el("p", "mf-muted", "Unknown page."); }, ids: Object.keys(PAGES) };
  }
  window.financePages = { build };
})();
