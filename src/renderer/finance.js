// My Finance view (v1.90.0 SKELETON). Loaded on the first click of the My Finance entry (finance-nav.js), not at startup.
// WHAT: seven tabs from the build report (docs\my_finance_build_report_2026-10-08.md, section 7), drawn from ONE local ledger that for now
// holds SYNTHETIC data only (a "Demo data - not real" banner shows while it does). The owner's rules: big readable numbers, every number with a
// comparison, real bar charts with the numbers printed on them, colour never alone (arrow shape + word), always a legend, real icons.
// STRUCTURE FOR RESTYLING: all look is in styles-finance.css (tokens --fin-*, classes mf-*). Markup is built only by the NAMED render functions
// below; the data/logic section at the bottom can be left alone when restyling.
// PRIVACY/LIGHT: textContent only (no HTML strings); the renderer never sends a path; nothing is logged; two timers only (the search
// debounce and the toast fade); nothing from the ledger stays in the page once the view closes.
(function () {
  "use strict";
  const api = window.api && window.api.finance;
  if (!api) return;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function auto(e) { e.setAttribute("dir", "auto"); return e; }                 // Hebrew merchants and names read right-to-left on their own
  function btn(label, cls, onClick) { const b = el("button", cls || "mf-btn", label); b.type = "button"; b.addEventListener("click", (ev) => { ev.preventDefault(); onClick(ev, b); }); return b; }
  const TAB_LIST = [
    { id: "overview", label: "Overview", icon: "📊" },
    { id: "accounts", label: "Accounts", icon: "🏦" },
    { id: "transactions", label: "Transactions", icon: "🧾" },
    { id: "categories", label: "Categories & rules", icon: "🏷️" },
    { id: "receipts", label: "Receipts", icon: "📎" },
    { id: "import", label: "Import", icon: "📥" },
    { id: "accountant", label: "For the accountant", icon: "📒" },
  ];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monShort = (ym) => (ym ? MON[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4) : "");
  const monLong = (ym) => (ym ? MONTH_LONG[+ym.slice(5, 7) - 1] : "");
  const dayLabel = (d) => (d ? +d.slice(8, 10) + " " + MON[+d.slice(5, 7) - 1] + " " + d.slice(0, 4) : "");
  const grp = (n) => Math.round(Math.abs(n)).toLocaleString("en-US");
  const nis = (n) => (n < 0 ? "-" : "") + "₪" + grp(n);                                  // whole shekels: tiles, bars, tables
  const nis2 = (n) => (n < 0 ? "-" : n > 0 ? "+" : "") + "₪" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const KIND = { bank: { icon: "🏦", word: "Bank account" }, card: { icon: "💳", word: "Credit card" }, cash: { icon: "💵", word: "Cash" } };
  const ROLE_WORD = { date: "Date", description: "Description", amount: "Amount", debit: "Debit (out)", credit: "Credit (in)", balance: "Balance" };
  const FILE_ICON = { csv: "📄", excel: "📊", pdf: "📕", dat: "🗂️", other: "📁" };

  // change vs last time, as arrow SHAPE + WORD (+ a colour class); `upIsGood` false for spending
  // `vs` names what it is compared with ("1-8 Sep" while the month runs). A month that is still running never gets a green "good" chip:
  // the comparison is fair (same days) but early in a month it is still noisy, so it stays neutral (review S4).
  function trend(cur, prev, upIsGood, vs, partial) {
    if (prev == null) return null;
    const d = cur - prev;
    const tail = vs ? " vs " + vs : "";
    if (Math.abs(d) < 0.5) return { shape: "■", word: "same" + tail, cls: "mf-flat" };
    const up = d > 0;
    return { shape: up ? "▲" : "▼", word: (up ? "up " : "down ") + nis(Math.abs(d)) + tail, cls: partial ? "mf-flat" : up === upIsGood ? "mf-good" : "mf-watch" };
  }
  const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);   // ledger ids are keys: never read inherited members
  const cmGet = (cm, id, m) => own(own(cm, id), m) || 0;
  // "1-8 Sep" while the newest month is still running, else "September"
  const cmpLabel = (o) => (o.partial && o.sameDays && o.prevMonth ? "1-" + o.sameDays + " " + MON[+o.prevMonth.slice(5, 7) - 1] : monLong(o.prevMonth));

  // ================================================================ NAMED RENDER FUNCTIONS (restyle here / in the css)
  function renderHeader(S) {
    const head = el("div", "mf-head");
    const t = el("div", "mf-head-t");
    t.append(el("b", "mf-title", "My Finance"), el("span", "mf-sub", "🔒 Private: stays on this PC. No bank or card connection."));
    head.appendChild(t);
    head.appendChild(el("span", "mf-sp"));
    head.appendChild(btn("📂 Open drop folder", "mf-btn", () => S.onOpenFolder("drop")));
    head.appendChild(btn("Refresh", "mf-btn", () => S.onRefresh()));
    const c = btn("Close", "mf-btn", () => close()); c.title = "Close My Finance (Esc)";
    head.appendChild(c);
    return head;
  }

  function renderBanner(S) {
    if (!S.snap || S.snap.state !== "ready" || !S.snap.synthetic) return null;
    const b = el("div", "mf-banner"); b.setAttribute("role", "note");
    b.append(el("span", "mf-banner-i", "⚠"), el("b", "", "Demo data - not real."), el("span", "", " Every name and number here is invented, to try the screens. Real bank files are not read yet."));
    return b;
  }

  function renderTabs(S) {
    const bar = el("div", "mf-tabs"); bar.setAttribute("role", "tablist"); bar.setAttribute("aria-label", "My Finance sections");
    TAB_LIST.forEach((t, i) => {
      const b = el("button", "mf-tab"); b.type = "button"; b.setAttribute("role", "tab"); b.id = "mf-tab-" + t.id;
      b.setAttribute("aria-selected", S.tab === t.id ? "true" : "false"); b.tabIndex = S.tab === t.id ? 0 : -1;
      const ic = el("span", "mf-tab-i", t.icon); ic.setAttribute("aria-hidden", "true");
      b.append(ic, el("span", "", t.label));
      b.addEventListener("click", () => S.onTab(t.id));
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const n = TAB_LIST[(i + (e.key === "ArrowRight" ? 1 : TAB_LIST.length - 1)) % TAB_LIST.length];
        S.onTab(n.id); const nb = document.getElementById("mf-tab-" + n.id); if (nb) nb.focus();
      });
      bar.appendChild(b);
    });
    return bar;
  }

  // no ledger yet: what to do, in plain words
  function renderEmpty(S) {
    const c = el("section", "mf-empty");
    c.append(el("div", "mf-empty-i", "💰"), el("h2", "mf-h2", "No money data yet"));
    c.appendChild(el("p", "mf-text", "My Finance reads one ledger file on this PC. There is none yet. Two ways to fill it:"));
    const ol = el("ol", "mf-steps");
    const a = el("li"); a.append(el("b", "", "Try the screens now: "), document.createTextNode("create demo data. Every name and number is invented and clearly marked."));
    const b = el("li"); b.append(el("b", "", "Real data (later): "), document.createTextNode("once a week, export last week's lines from each bank and card site and save the files into the drop folder. The Import tab shows what it finds. Reading them into the ledger is not built yet."));
    ol.append(a, b); c.appendChild(ol);
    const row = el("div", "mf-row");
    row.append(btn("Create demo data", "mf-btn mf-pri", (e, bt) => S.onDemoCreate(bt)), btn("📂 Open drop folder", "mf-btn", () => S.onOpenFolder("drop")));
    c.appendChild(row);
    if (S.snap && S.snap.vault) { const p = el("p", "mf-muted", "Finance folder: "); const code = el("code", "mf-path", S.snap.vault); code.setAttribute("dir", "ltr"); p.appendChild(code); c.appendChild(p); }
    return c;
  }

  function renderState(title, text) {
    const c = el("section", "mf-empty");
    c.append(el("div", "mf-empty-i", "⚠"), el("h2", "mf-h2", title));
    if (text) c.appendChild(el("p", "mf-text", text));
    c.appendChild(btn("Retry", "mf-btn mf-pri", () => S.onRefresh()));
    return c;
  }

  // one big-number tile: label, number, "(last month: X)", trend as shape + word
  function renderTile(label, icon, value, sub, tr, extraCls, period) {
    const t = el("div", "mf-tile" + (extraCls ? " " + extraCls : ""));
    const top = el("div", "mf-tile-top"); const ic = el("span", "mf-tile-i", icon); ic.setAttribute("aria-hidden", "true");
    top.append(ic, el("span", "mf-tile-l", label)); if (period) top.appendChild(el("span", "mf-tile-per", period)); t.appendChild(top);
    t.appendChild(el("div", "mf-tile-n", value));
    if (sub) t.appendChild(el("div", "mf-tile-s", sub));
    if (tr) { const c = el("span", "mf-trend " + tr.cls); const s = el("span", "", tr.shape); s.setAttribute("aria-hidden", "true"); c.append(s, document.createTextNode(" " + tr.word)); t.appendChild(c); }
    return t;
  }

  function renderOverview(S) {
    const s = S.snap, o = s.overview, wrap = el("div", "mf-stack");
    const mName = monLong(o.month), pName = monLong(o.prevMonth);
    const vs = cmpLabel(o);
    const lastP = (v) => (v == null ? "" : "(" + vs + ": " + nis(v) + ")");
    const grid = el("div", "mf-tiles");
    grid.appendChild(renderTile("Cash available", "🏦", nis(o.cash), "Banks + cash. Cards owe " + nis(Math.abs(o.owed)), null));
    const per = mName.slice(0, 3) + " so far";
    grid.appendChild(renderTile("Money in", "💵", nis(o.in), lastP(o.prevIn), trend(o.in, o.prevIn, true, vs, o.partial), "", per));
    grid.appendChild(renderTile("Money out", "💸", nis(o.out), lastP(o.prevOut), trend(o.out, o.prevOut, false, vs, o.partial), "", per));
    grid.appendChild(renderTile("Net", o.net >= 0 ? "✅" : "⚠️", (o.net >= 0 ? "+" : "") + nis(o.net), lastP(o.prevNet), trend(o.net, o.prevNet, true, vs, o.partial), o.net >= 0 ? "mf-tile-pos" : "mf-tile-neg", per));
    grid.appendChild(renderTile("Receipts to check", "📎", String(o.receiptsToCheck), o.receiptsNew + " new · " + o.receiptsNoLine + " with no bank line", null));
    const cat = o.topCategory ? catOf(o.topCategory.id) : null;
    grid.appendChild(renderTile("Top spend", cat ? cat.icon : "🏷️", cat ? nis(o.topCategory.amount) : "-", cat ? cat.en + (o.topCategory.prev != null ? " (" + vs + ": " + nis(o.topCategory.prev) + ")" : "") : "No spending yet", null, "", per));
    wrap.appendChild(grid);
    wrap.appendChild(renderMonthChart(S));
    wrap.appendChild(renderCategoryBars(S, o.month, o.prevMonth, "Where the money went in " + mName + " so far", 6));
    return wrap;
  }

  // grouped bars per month, money in (solid) and money out (hatched), the actual amount printed above every bar, net under the month
  function renderMonthChart(S) {
    const months = S.snap.months;
    const card = el("section", "mf-card");
    const h = el("div", "mf-card-h"); h.appendChild(el("h2", "mf-h2", "Money in and out, month by month"));
    h.appendChild(renderLegend([["mf-sw-in", "Money in ▲"], ["mf-sw-out", "Money out ▼"], ["", "Net = in minus out"]]));
    card.appendChild(h);
    if (!months.length) { card.appendChild(el("p", "mf-muted", "No months yet.")); return card; }
    const max = Math.max(1, ...months.map((m) => Math.max(m.in, m.out)));
    const chart = el("div", "mf-chart"); chart.setAttribute("role", "img");
    chart.setAttribute("aria-label", "Bar chart. " + months.map((m) => monShort(m.month) + ": in " + nis(m.in) + ", out " + nis(m.out) + ", net " + nis(m.net)).join("; "));
    months.forEach((m, i) => {
      const col = el("div", "mf-col" + (i === months.length - 1 ? " mf-col-cur" : ""));
      const bars = el("div", "mf-bars");
      for (const [k, v] of [["in", m.in], ["out", m.out]]) {
        const w = el("div", "mf-barw");
        w.appendChild(el("span", "mf-bar-v", grp(v)));
        const bar = el("div", "mf-bar mf-bar-" + k); bar.style.height = Math.max(2, Math.round((v / max) * 190)) + "px";
        bar.title = (k === "in" ? "Money in " : "Money out ") + monShort(m.month) + ": " + nis(v);
        w.appendChild(bar); bars.appendChild(w);
      }
      col.appendChild(bars);
      col.appendChild(el("div", "mf-col-m", monShort(m.month) + (i === months.length - 1 ? " (so far)" : "")));
      const net = el("div", "mf-col-net " + (m.net >= 0 ? "mf-pos" : "mf-neg"), (m.net >= 0 ? "▲ net +" : "▼ net -") + "₪" + grp(m.net));
      col.appendChild(net);
      chart.appendChild(col);
    });
    card.appendChild(chart);
    card.appendChild(el("p", "mf-note", "Amounts in ₪ (NIS). Transfers between your own accounts and card payments from the bank are not counted, so nothing is counted twice."));
    return card;
  }

  function renderLegend(items) {
    const lg = el("div", "mf-legend"); lg.setAttribute("aria-label", "Legend");
    for (const [cls, text] of items) { const i = el("span", "mf-lgi"); if (cls) { const sw = el("span", "mf-sw " + cls); sw.setAttribute("aria-hidden", "true"); i.appendChild(sw); } i.appendChild(document.createTextNode(text)); lg.appendChild(i); }
    return lg;
  }

  // ranked horizontal bars: icon, name (English + Hebrew), bar, amount, share, last month
  function renderCategoryBars(S, month, prevMonth, title, limit, group) {
    const card = el("section", "mf-card");
    const h = el("div", "mf-card-h"); h.appendChild(el("h2", "mf-h2", title)); card.appendChild(h);
    const cm = S.snap.catMonths;
    const want = group === "income" ? (c) => c.group === "income" : (c) => c.group !== "income" && c.group !== "transfer";
    const o = S.snap.overview, newest = month === o.month;
    // the newest month compares with the service's figure (same days of last month while it runs); older months with the whole month before
    const prevOf = (id) => (newest ? (own(o.catPrev, id) == null ? null : own(o.catPrev, id)) : prevMonth ? cmGet(cm, id, prevMonth) : null);
    const pLabel = newest ? cmpLabel(o) : monLong(prevMonth);
    const rows = S.snap.categories.filter(want).map((c) => ({ c, v: cmGet(cm, c.id, month), p: prevOf(c.id) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
    if (!rows.length) { card.appendChild(el("p", "mf-muted", "Nothing in this month.")); return card; }
    const total = rows.reduce((s, x) => s + x.v, 0), max = rows[0].v;
    const list = el("div", "mf-cbars");
    rows.slice(0, limit || rows.length).forEach((x) => {
      const r = el("button", "mf-cbar"); r.type = "button"; r.title = "Show these lines in Transactions";
      r.addEventListener("click", () => S.onShowTx({ category: x.c.id, month }));
      const ic = el("span", "mf-cbar-i", x.c.icon || "🏷️"); ic.setAttribute("aria-hidden", "true");
      const nm = el("span", "mf-cbar-n"); nm.append(el("span", "mf-cbar-en", x.c.en)); if (x.c.he) nm.appendChild(auto(el("span", "mf-cbar-he", x.c.he)));
      const track = el("span", "mf-cbar-t"); const fill = el("span", "mf-cbar-f" + (group === "income" ? " mf-cbar-fin" : "")); fill.style.width = Math.max(1, Math.round((x.v / max) * 100)) + "%"; track.appendChild(fill);
      const v = el("span", "mf-cbar-v", nis(x.v));
      const sh = el("span", "mf-cbar-p", pct(x.v, total) + "%");
      const pv = el("span", "mf-cbar-prev", x.p == null ? "" : "(" + pLabel + ": " + nis(x.p) + ")");
      r.append(ic, nm, track, v, sh, pv);
      list.appendChild(r);
    });
    card.appendChild(list);
    if (limit && rows.length > limit) card.appendChild(el("p", "mf-note", (rows.length - limit) + " smaller categories are on the Categories tab."));
    return card;
  }

  function renderAccounts(S) {
    const s = S.snap, wrap = el("div", "mf-stack");
    const grid = el("div", "mf-tiles mf-tiles-2");
    grid.appendChild(renderTile("Cash available", "🏦", nis(s.overview.cash), "All bank accounts + cash", null));
    grid.appendChild(renderTile("Cards owe (this cycle)", "💳", nis(Math.abs(s.overview.owed)), "Paid from the bank on the 2nd of next month", null));
    wrap.appendChild(grid);
    const cards = el("div", "mf-accs");
    s.accounts.forEach((a) => {
      const k = KIND[a.kind] || KIND.bank;
      const c = el("button", "mf-acc mf-acc-" + a.kind); c.type = "button"; c.title = "Show this account's lines";
      c.addEventListener("click", () => S.onShowTx({ account: a.id }));
      const top = el("div", "mf-acc-top"); const ic = el("span", "mf-acc-i", k.icon); ic.setAttribute("aria-hidden", "true");
      const nm = el("div", "mf-acc-nm"); nm.append(auto(el("b", "", a.name)), el("span", "mf-muted", k.word));
      top.append(ic, nm); c.appendChild(top);
      c.appendChild(el("div", "mf-acc-n" + (a.balance < 0 ? " mf-neg" : ""), (a.balance < 0 ? "-" : "") + "₪" + grp(a.balance)));
      c.appendChild(el("div", "mf-acc-s", a.kind === "card" ? (a.balance < 0 ? "Owed this cycle" : "Nothing owed") : "Balance from the last line"));
      c.appendChild(el("div", "mf-acc-f", "Last line " + (dayLabel(a.lastDate) || "-") + " · " + a.lines + " lines"));
      cards.appendChild(c);
    });
    wrap.appendChild(cards);
    wrap.appendChild(el("p", "mf-note", "Balances are worked out from the lines in the ledger. With real data they will come from the last bank export."));
    return wrap;
  }

  function renderTransactions(S) {
    const wrap = el("div", "mf-stack");
    const f = el("form", "mf-filters"); f.addEventListener("submit", (e) => e.preventDefault());
    const q = S.txq;
    const search = el("input", "mf-in mf-search"); search.type = "search"; search.placeholder = "Search: merchant, category, amount..."; search.maxLength = 100; search.value = q.text || ""; auto(search);
    search.setAttribute("aria-label", "Search the lines");
    search.addEventListener("input", () => S.onTxQuery({ text: search.value }, true));
    const sel = (label, key, opts) => {
      const s = el("select", "mf-in"); s.setAttribute("aria-label", label);
      for (const [v, t] of opts) { const o = auto(el("option", "", t)); o.value = v; if ((q[key] || "") === v) o.selected = true; s.appendChild(o); }
      s.addEventListener("change", () => S.onTxQuery({ [key]: s.value }));
      return s;
    };
    f.append(search,
      sel("Account", "account", [["", "All accounts"]].concat(S.snap.accounts.map((a) => [a.id, a.name]))),
      sel("Category", "category", [["", "All categories"]].concat(S.snap.categories.map((c) => [c.id, (c.icon ? c.icon + " " : "") + c.en]))),
      sel("Month", "month", [["", "All months"]].concat(S.snap.months.slice().reverse().map((m) => [m.month, monShort(m.month)]))),
      sel("Kind", "kind", [["", "In and out"], ["in", "▲ Money in"], ["out", "▼ Money out"], ["transfer", "🔁 Transfers"]]),
      sel("Business or personal", "bp", [["", "Business + personal"], ["business", "💼 Business"], ["personal", "🏠 Personal"]]));
    if (Object.keys(q).some((k) => q[k])) f.appendChild(btn("Clear", "mf-btn", () => S.onTxQuery(null)));
    wrap.appendChild(f);
    const host = el("div", "mf-txhost"); wrap.appendChild(host);
    S.txHost = host;
    renderTxRows(S);
    return wrap;
  }

  function renderTxRows(S) {
    const host = S.txHost; if (!host) return;
    host.textContent = "";
    const r = S.txRes;
    if (!r) { host.appendChild(el("p", "mf-muted", "Reading the lines...")); return; }
    if (!r.ok) { host.appendChild(el("p", "mf-note", r.reason || "The lines could not be read.")); return; }
    const sum = el("div", "mf-txsum");
    sum.append(el("b", "", "Showing " + Math.min(r.rows.length, r.total) + " of " + r.total + " lines"), el("span", "mf-muted", " (all lines: " + r.all + ")"));
    const a = el("span", "mf-pill mf-pos", "▲ in " + nis(r.sumIn)), b = el("span", "mf-pill mf-neg", "▼ out " + nis(r.sumOut));
    sum.append(a, b);
    host.appendChild(sum);
    if (!r.rows.length) { host.appendChild(el("p", "mf-note", "No lines match. Use Clear to see everything.")); return; }
    const table = el("table", "mf-table");
    const thead = el("thead"), hr = el("tr");
    for (const [t, c] of [["Date", ""], ["Merchant", ""], ["Category", ""], ["Account", ""], ["Type", ""], ["Receipt", "mf-c"], ["Amount", "mf-r"]]) hr.appendChild(el("th", c, t));
    thead.appendChild(hr); table.appendChild(thead);
    const tb = el("tbody");
    const accName = {}; S.snap.accounts.forEach((x) => { accName[x.id] = x.name; });
    for (const t of r.rows) {
      const tr = el("tr", t.transfer ? "mf-tr-transfer" : "");
      tr.appendChild(el("td", "mf-nowrap", dayLabel(t.date)));
      const m = el("td"); m.appendChild(auto(el("div", "mf-merch", t.merchant))); if (t.raw && t.raw !== t.merchant) m.appendChild(auto(el("div", "mf-raw", t.raw))); tr.appendChild(m);
      const c = catOf(t.category); const ct = el("td"); const chip = el("button", "mf-chip"); chip.type = "button"; chip.title = "Show only this category";
      chip.append(el("span", "", c ? c.icon : "❔"), document.createTextNode(" " + (c ? c.en : t.category))); chip.addEventListener("click", () => S.onTxQuery({ category: t.category }));
      ct.appendChild(chip); tr.appendChild(ct);
      const ac = el("td", "mf-muted"); ac.appendChild(auto(el("span", "", accName[t.account] || t.account))); tr.appendChild(ac);
      tr.appendChild(el("td", "", t.transfer ? "🔁 Transfer" : t.bp === "business" ? "💼 Business" : "🏠 Personal"));
      const rc = el("td", "mf-c " + (t.receipt ? "mf-rc-yes" : "mf-muted"), t.receipt ? "✓ Yes" : "No"); rc.title = t.receipt ? "Has a receipt" : "No receipt"; tr.appendChild(rc);
      tr.appendChild(el("td", "mf-r mf-amt " + (t.transfer ? "mf-amt-t" : t.amount >= 0 ? "mf-pos" : "mf-neg"), (t.transfer ? "" : t.amount >= 0 ? "▲ " : "▼ ") + nis2(t.amount)));
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    const sc = el("div", "mf-tablewrap"); sc.appendChild(table); host.appendChild(sc);
    if (r.limited) host.appendChild(el("p", "mf-note", "Only the newest " + r.rows.length + " are listed. Search or filter to narrow it down."));
  }

  function renderCategories(S) {
    const s = S.snap, wrap = el("div", "mf-stack");
    const months = s.months.map((m) => m.month);
    const sel = S.catMonth && months.includes(S.catMonth) ? S.catMonth : months[months.length - 1];
    const chips = el("div", "mf-mchips"); chips.setAttribute("role", "group"); chips.setAttribute("aria-label", "Month");
    months.forEach((m) => { const b = btn(monShort(m), "mf-mchip", () => { S.catMonth = m; render(); }); b.setAttribute("aria-pressed", m === sel ? "true" : "false"); chips.appendChild(b); });
    wrap.appendChild(chips);
    const i = months.indexOf(sel), prev = i > 0 ? months[i - 1] : null;
    const two = el("div", "mf-two");
    two.append(renderCategoryBars(S, sel, prev, "Spending by category · " + monShort(sel), 0), renderCategoryBars(S, sel, prev, "Income by source · " + monShort(sel), 0, "income"));
    wrap.appendChild(two);
    wrap.appendChild(renderCatTable(S));
    wrap.appendChild(renderRules(S));
    return wrap;
  }

  // every category x every month, the number printed in each cell; a tint shows size (the number is always there, so colour is not alone)
  function renderCatTable(S) {
    const s = S.snap, months = s.months.map((m) => m.month), cm = s.catMonths;
    const card = el("section", "mf-card");
    card.appendChild(el("h2", "mf-h2", "Month by month, per category (₪)"));
    const cats = s.categories.filter((c) => c.group !== "transfer").map((c) => ({ c, tot: months.reduce((t, m) => t + cmGet(cm, c.id, m), 0) })).filter((x) => x.tot > 0)
      .sort((a, b) => (a.c.group === "income") - (b.c.group === "income") || b.tot - a.tot);
    const max = Math.max(1, ...cats.filter((x) => x.c.group !== "income").map((x) => Math.max(...months.map((m) => cmGet(cm, x.c.id, m)))));
    const table = el("table", "mf-table mf-heat");
    const hr = el("tr"); hr.appendChild(el("th", "", "Category")); months.forEach((m) => hr.appendChild(el("th", "mf-r", monShort(m)))); hr.appendChild(el("th", "mf-r", "Total"));
    const th = el("thead"); th.appendChild(hr); table.appendChild(th);
    const tb = el("tbody");
    let incomeStarted = false;
    for (const x of cats) {
      if (x.c.group === "income" && !incomeStarted) { incomeStarted = true; const sep = el("tr", "mf-heat-sep"); const td = el("td", "", "Income"); td.colSpan = months.length + 2; sep.appendChild(td); tb.appendChild(sep); }
      const tr = el("tr");
      const n = el("td", "mf-heat-n"); n.append(el("span", "mf-heat-i", x.c.icon || "🏷️"), document.createTextNode(" " + x.c.en)); tr.appendChild(n);
      months.forEach((m) => {
        const v = cmGet(cm, x.c.id, m);
        const td = el("td", "mf-r mf-hc" + (x.c.group === "income" ? " mf-hc-in" : ""), v ? grp(v) : "-");
        if (x.c.group !== "income") td.style.setProperty("--h", String(Math.min(1, v / max).toFixed(2)));
        tr.appendChild(td);
      });
      tr.appendChild(el("td", "mf-r mf-b", grp(x.tot)));
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    const sc = el("div", "mf-tablewrap"); sc.appendChild(table); card.appendChild(sc);
    card.appendChild(el("p", "mf-note", "Darker cell = more spent that month. The number is always printed."));
    return card;
  }

  function renderRules(S) {
    const card = el("section", "mf-card");
    const h = el("div", "mf-card-h"); h.appendChild(el("h2", "mf-h2", "Rules: how lines get their category"));
    h.appendChild(renderLegend([["", "✓ learned from you = made when you corrected a line"]])); card.appendChild(h);
    if (!S.snap.rules.length) { card.appendChild(el("p", "mf-muted", "No rules yet.")); return card; }
    const table = el("table", "mf-table");
    const hr = el("tr"); for (const t of ["If the merchant contains", "Category", "Business / personal", "Learned from you"]) hr.appendChild(el("th", "", t));
    const th = el("thead"); th.appendChild(hr); table.appendChild(th);
    const tb = el("tbody");
    for (const r of S.snap.rules) {
      const c = catOf(r.category), tr = el("tr");
      const k = el("td"); k.appendChild(auto(el("code", "mf-code", r.contains))); tr.appendChild(k);
      tr.appendChild(el("td", "", (c ? c.icon + " " + c.en : r.category)));
      tr.appendChild(el("td", "", r.bp === "business" ? "💼 Business" : "🏠 Personal"));
      tr.appendChild(el("td", "", r.learned ? "✓ yes" : "-"));
      tb.appendChild(tr);
    }
    table.appendChild(tb); card.appendChild(table);
    card.appendChild(el("p", "mf-note", "Editing rules is not built yet. Later: correct a line once and choose \"always do this for this merchant\"."));
    return card;
  }

  function renderReceipts(S) {
    const s = S.snap, wrap = el("div", "mf-stack");
    const cols = [
      { st: "new", icon: "🆕", title: "New · needs a look", hint: "Arrived, not confirmed yet" },
      { st: "matched", icon: "✅", title: "Matched to a bank line", hint: "Done" },
      { st: "no-line", icon: "❓", title: "No bank line yet", hint: "Paid by cash, or the export is not in yet" },
    ];
    const board = el("div", "mf-board");
    for (const c of cols) {
      const list = s.receipts.filter((r) => r.status === c.st).sort((a, b) => (a.date < b.date ? 1 : -1));
      const col = el("section", "mf-bcol mf-bcol-" + c.st);
      const h = el("div", "mf-bcol-h"); const ic = el("span", "mf-bcol-i", c.icon); ic.setAttribute("aria-hidden", "true");
      h.append(ic, el("b", "", c.title), el("span", "mf-badge", String(list.length)));
      col.append(h, el("p", "mf-muted mf-bcol-s", c.hint));
      list.slice(0, c.st === "matched" ? 12 : 40).forEach((r) => {
        const card = el("div", "mf-rc");
        const th = el("span", "mf-rc-th", "🧾"); th.setAttribute("aria-hidden", "true");
        const body = el("div", "mf-rc-b"); body.append(auto(el("b", "mf-rc-v", r.vendor)), el("span", "mf-muted", dayLabel(r.date)));
        card.append(th, body, el("span", "mf-rc-n", nis(r.total)));
        col.appendChild(card);
      });
      if (c.st === "matched" && list.length > 12) col.appendChild(el("p", "mf-note", (list.length - 12) + " more matched receipts."));
      if (!list.length) col.appendChild(el("p", "mf-muted", "None."));
      board.appendChild(col);
    }
    wrap.appendChild(board);
    const o = s.overview;
    const miss = el("section", "mf-card");
    miss.appendChild(el("h2", "mf-h2", "Business lines without a receipt"));
    miss.appendChild(el("p", "mf-text", monLong(o.month) + " so far: " + o.linesNoReceipt + (o.prevLinesNoReceipt != null ? " (" + monLong(o.prevMonth) + ": " + o.prevLinesNoReceipt + ")" : "") + ". Taxes and bank fees do not need one."));
    miss.appendChild(btn("Show them in Transactions", "mf-btn", () => S.onShowTx({ bp: "business", kind: "out", month: o.month })));
    wrap.appendChild(miss);
    wrap.appendChild(el("p", "mf-note", "Receipts will come in by themselves later: from email (Personal Assistant) and from a Receipt mode in the phone app. Matching and confirming are not built yet."));
    return wrap;
  }

  function renderImport(S) {
    const wrap = el("div", "mf-stack");
    const how = el("section", "mf-card");
    how.appendChild(el("h2", "mf-h2", "Weekly routine, about 5 minutes"));
    const steps = el("div", "mf-flow");
    for (const [i, ic, t] of [["1", "🌐", "Open each bank and card site yourself and export last week's lines (Excel or CSV)."], ["2", "📂", "Save the files into the drop folder below."], ["3", "👀", "Come back here: each file shows how many lines it has."]]) {
      const st = el("div", "mf-flow-s"); const n = el("span", "mf-flow-n", i); const x = el("span", "mf-flow-i", ic); x.setAttribute("aria-hidden", "true");
      st.append(n, x, el("span", "mf-text", t)); steps.appendChild(st);
    }
    how.appendChild(steps);
    const r = S.imp;
    const pathRow = el("div", "mf-row");
    pathRow.appendChild(el("span", "mf-muted", "Drop folder:"));
    const code = el("code", "mf-path", r && r.dropDir ? r.dropDir : (S.snap && S.snap.dropDir) || "..."); code.setAttribute("dir", "ltr"); pathRow.appendChild(code);
    pathRow.append(btn("📂 Open drop folder", "mf-btn mf-pri", () => S.onOpenFolder("drop")), btn("Look again", "mf-btn", () => S.onImportScan()));
    how.appendChild(pathRow);
    how.appendChild(el("p", "mf-note", "No agent ever logs in to a bank or card. Nothing here connects to the internet."));
    wrap.appendChild(how);

    const files = el("section", "mf-card");
    const fh = el("div", "mf-card-h"); fh.appendChild(el("h2", "mf-h2", "Files in the drop folder"));
    fh.appendChild(renderLegend([["", "✓ read"], ["", "⏳ not read yet"], ["", "Preview only: nothing goes into the ledger yet"]])); files.appendChild(fh);
    if (!r) files.appendChild(el("p", "mf-muted", "Looking..."));
    else if (!r.ok) files.appendChild(el("p", "mf-note", r.reason || "The drop folder could not be read."));
    else if (!r.files.length) files.appendChild(el("p", "mf-text", r.exists ? "The drop folder is empty. Save a bank or card export there, then press Look again." : "The drop folder does not exist yet. Open drop folder creates it."));
    else { r.files.forEach((f) => files.appendChild(renderImportFile(S, f))); if (r.more) files.appendChild(el("p", "mf-note", r.more + " more files were not listed (limit 60).")); }
    wrap.appendChild(files);

    const demo = el("section", "mf-card");
    demo.appendChild(el("h2", "mf-h2", "Demo data"));
    const syn = S.snap && S.snap.state === "ready" && S.snap.synthetic, none = S.snap && S.snap.state === "empty";
    demo.appendChild(el("p", "mf-text", syn ? "The ledger holds invented demo data. Remove it before real data comes in." : none ? "There is no ledger. Demo data fills every screen with invented lines and two demo export files." : "The ledger holds real data. Demo data cannot be added or removed here."));
    const row = el("div", "mf-row");
    if (none) row.appendChild(btn("Create demo data", "mf-btn mf-pri", (e, b) => S.onDemoCreate(b)));
    if (syn) row.appendChild(renderConfirmButton("Make new demo data", "Yes, replace the demo data", "mf-btn", (b) => S.onDemoCreate(b)));
    if (syn) row.appendChild(renderConfirmButton("Remove demo data", "Yes, move it to the archive", "mf-btn mf-danger", (b) => S.onDemoRemove(b)));
    if (syn) demo.appendChild(el("p", "mf-note", "Nothing is deleted: the demo ledger and the DEMO_ files are moved into the archive folder of the finance folder."));
    demo.appendChild(row);
    wrap.appendChild(demo);
    return wrap;
  }

  // a button that asks once more in place: first click changes its words, the second click does it (no system dialog)
  function renderConfirmButton(label, sure, cls, onConfirm) {
    const b = el("button", cls, label); b.type = "button";
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = sure; b.classList.add("mf-armed"); b.setAttribute("aria-live", "polite"); return; }
      onConfirm(b);
    });
    b.addEventListener("blur", () => { b.dataset.armed = ""; b.textContent = label; b.classList.remove("mf-armed"); });
    return b;
  }

  function renderImportFile(S, f) {
    const card = el("div", "mf-file");
    const top = el("div", "mf-file-top");
    const ic = el("span", "mf-file-i", FILE_ICON[f.kind] || FILE_ICON.other); ic.setAttribute("aria-hidden", "true");
    const nm = el("div", "mf-file-nm"); nm.appendChild(auto(el("b", "", f.name)));
    nm.appendChild(el("span", "mf-muted", (f.folder ? f.folder + " · " : "") + Math.max(1, Math.round(f.size / 1024)) + " KB · saved " + dayLabel(String(f.modified).slice(0, 10)) + (f.demo ? " · demo file" : "")));
    top.append(ic, nm);
    const p = f.parse;
    let status;
    if (f.kind !== "csv") status = el("span", "mf-fstat mf-fstat-wait", "⏳ Not read yet: " + (f.kind === "excel" ? "Excel" : f.kind === "pdf" ? "PDF" : f.kind === "dat" ? "bank .dat" : "this type of") + " files are read once we have a real sample from each bank");
    else if (!p || !p.ok) status = el("span", "mf-fstat mf-fstat-bad", "⚠ " + ((p && p.note) || "Could not be read"));
    else status = el("span", "mf-fstat mf-fstat-ok", "✓ " + p.rows + " rows · " + p.usable + " with a date and an amount" + (p.firstDate ? " · " + dayLabel(p.firstDate) + " to " + dayLabel(p.lastDate) : ""));
    top.appendChild(status);
    card.appendChild(top);
    if (p && p.ok) {
      const meta = el("p", "mf-muted", "Header on line " + p.headerRow + " · separator \"" + p.delimiter + "\" · " + p.encoding + (p.missing && p.missing.length ? " · not found: " + p.missing.join(", ") : ""));
      card.appendChild(meta);
      const map = el("div", "mf-map"); map.setAttribute("aria-label", "Column mapping");
      p.columns.forEach((c) => { const m = el("span", "mf-mapc" + (c.role ? " mf-mapc-on" : "")); m.append(auto(el("span", "mf-mapc-n", c.name || "(no name)")), el("span", "mf-mapc-r", c.role ? "→ " + ROLE_WORD[c.role] : "→ not used")); map.appendChild(m); });
      card.appendChild(map);
      if (p.preview && p.preview.length) {
        const table = el("table", "mf-table mf-table-sm");
        const hr = el("tr"); for (const [t, c] of [["Date", ""], ["Description", ""], ["Amount", "mf-r"], ["Balance", "mf-r"], ["", "mf-c"]]) hr.appendChild(el("th", c, t));
        const th = el("thead"); th.appendChild(hr); table.appendChild(th);
        const tb = el("tbody");
        for (const row of p.preview) {
          const tr = el("tr");
          tr.appendChild(el("td", "mf-nowrap", row.date ? dayLabel(row.date) : "?"));
          const dtd = el("td"); dtd.appendChild(auto(el("span", "", row.description))); tr.appendChild(dtd);
          tr.appendChild(el("td", "mf-r mf-amt " + (row.amount == null ? "" : row.amount >= 0 ? "mf-pos" : "mf-neg"), row.amount == null ? "?" : nis2(row.amount)));
          tr.appendChild(el("td", "mf-r mf-muted", row.balance == null ? "" : nis(row.balance)));
          tr.appendChild(el("td", "mf-c", row.ok ? "✓" : "⚠"));
          tb.appendChild(tr);
        }
        table.appendChild(tb); card.appendChild(table);
      }
    }
    return card;
  }

  // the accountant: the 10 questions from the build report (section 9) and the planned workbook. Nothing is sent from here.
  const QUESTIONS = [
    "Which software do you use (Hashavshevet, Priority, iCount, Rivhit...)? Can you import a bank file (Bankin.dat / Discount.dat), or do you want our Excel?",
    "VAT period: monthly or bi-monthly? Advance-tax and National Insurance dates?",
    "Do you want the raw bank and card lines, or only our categorised list?",
    "Which expenses are partly recoverable (car, phone, home office), and at what %?",
    "Allocation-number rule: do you want a flag at 5,000 NIS before VAT, and how to treat invoices without one?",
    "Foreign suppliers (US gear shops, Adobe, Google): how to record them, which exchange rate?",
    "Does a photo or PDF replace the paper receipt? How long to keep paper?",
    "Do you already get Morning's accountant access? Is our workbook extra, or a replacement?",
    "Any category list or chart of accounts you want us to match?",
    "What did you have to chase me for last year? (That becomes a rule.)",
  ];
  const SHEETS = [["סיכום", "Summary"], ["הכנסות", "Income"], ["הוצאות", "Expenses"], ["תנועות בנק וכרטיס", "Bank and card lines"], ["לא מותאם", "Unmatched"], ["אינדקס קבלות", "Receipts index"]];
  function renderAccountant(S) {
    const wrap = el("div", "mf-stack");
    const st = el("div", "mf-banner mf-banner-info"); st.setAttribute("role", "note");
    st.append(el("span", "mf-banner-i", "ℹ"), el("b", "", "Not built yet."), el("span", "", " The one-click workbook for each VAT period comes after real data. First, the accountant answers these questions."));
    wrap.appendChild(st);
    const q = el("section", "mf-card");
    q.appendChild(el("h2", "mf-h2", "10 questions for the accountant"));
    const ol = el("ol", "mf-qs");
    QUESTIONS.forEach((t, i) => { const li = el("li", "mf-q"); li.append(el("span", "mf-q-n", String(i + 1)), el("span", "mf-text", t)); ol.appendChild(li); });
    q.appendChild(ol);
    wrap.appendChild(q);
    const w = el("section", "mf-card");
    w.appendChild(el("h2", "mf-h2", "The workbook, planned (one per VAT period)"));
    const grid = el("div", "mf-sheets");
    SHEETS.forEach(([he, en], i) => { const s = el("div", "mf-sheet"); s.append(el("span", "mf-sheet-i", "📗"), auto(el("b", "", he)), el("span", "mf-muted", (i + 1) + ". " + en)); grid.appendChild(s); });
    w.appendChild(grid);
    w.appendChild(el("p", "mf-note", "Hebrew headings first, English second, dates as dd/mm/yyyy, plus a zip of receipts. Layout to be confirmed with the accountant."));
    wrap.appendChild(w);
    return wrap;
  }

  // ================================================================ SHELL, STATE AND DATA (logic: leave alone when restyling)
  const view = el("div"); view.id = "finance-view"; view.className = "hidden";
  const headHost = el("div"), bannerHost = el("div"), tabsHost = el("div"), bodyHost = el("div", "mf-body"), toast = el("div", "mf-toast hidden");
  bodyHost.setAttribute("role", "tabpanel");
  toast.setAttribute("role", "status"); toast.setAttribute("aria-live", "polite");
  view.append(headHost, bannerHost, tabsHost, bodyHost, toast);
  document.getElementById("main-panel").appendChild(view);

  const S = { snap: null, tab: "overview", txq: {}, txRes: null, txHost: null, imp: null, catMonth: null };
  let open = false, navEl = null, toastTimer = null, searchTimer = null, seq = 0;
  const say = (t) => { toast.textContent = t; toast.classList.remove("hidden"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add("hidden"), 6000); };
  const catOf = (id) => (S.snap && S.snap.categories ? S.snap.categories.find((c) => c.id === id) : null) || null;
  const DATA_TABS = { overview: 1, accounts: 1, transactions: 1, categories: 1, receipts: 1 };

  function render() {
    headHost.textContent = ""; bannerHost.textContent = ""; tabsHost.textContent = ""; bodyHost.textContent = ""; S.txHost = null;
    headHost.appendChild(renderHeader(S));
    const b = renderBanner(S); if (b) bannerHost.appendChild(b);
    tabsHost.appendChild(renderTabs(S));
    bodyHost.setAttribute("aria-labelledby", "mf-tab-" + S.tab);
    if (!S.snap) { bodyHost.appendChild(el("p", "mf-muted", "Reading the ledger...")); return; }
    if (!S.snap.ok) { bodyHost.appendChild(renderState("Couldn't open My Finance", S.snap.reason)); return; }
    if (S.snap.state === "blocked" && S.tab !== "accountant") { bodyHost.appendChild(renderState("No safe finance folder", S.snap.reason)); return; }
    if (DATA_TABS[S.tab]) {
      if (S.snap.state === "empty") { bodyHost.appendChild(renderEmpty(S)); return; }
      if (S.snap.state !== "ready") { bodyHost.appendChild(renderState("The ledger could not be read", S.snap.reason)); return; }
    }
    if (S.snap.vaultNote) bodyHost.appendChild(el("p", "mf-note mf-note-warn", "⚠ " + S.snap.vaultNote));
    if (S.snap.skipped) bodyHost.appendChild(el("p", "mf-note", S.snap.skipped + " ledger lines could not be read and are left out."));
    const fn = { overview: renderOverview, accounts: renderAccounts, transactions: renderTransactions, categories: renderCategories, receipts: renderReceipts, import: renderImport, accountant: renderAccountant }[S.tab];
    bodyHost.appendChild(fn(S));
  }

  function loadTx() {
    const my = ++seq;
    const q = Object.assign({ limit: 300 }, S.txq);
    return api.transactions(q).then((r) => { if (!open || my !== seq) return; S.txRes = r; renderTxRows(S); }).catch(() => { if (open && my === seq) { S.txRes = { ok: false, reason: "The lines could not be read." }; renderTxRows(S); } });
  }
  function loadImport() {
    return api.importScan().then((r) => { if (!open) return; S.imp = r; if (S.tab === "import") render(); }).catch(() => { if (open) { S.imp = { ok: false, reason: "The drop folder could not be read." }; if (S.tab === "import") render(); } });
  }
  function refresh() {
    return api.load().then((s) => {
      if (!open) return;
      S.snap = s || { ok: false, reason: "No answer." };
      S.txRes = null; render();
      if (S.tab === "transactions" && S.snap.state === "ready") loadTx();
      if (S.tab === "import") loadImport();
    }).catch(() => { if (open) { S.snap = { ok: false, reason: "The ledger could not be read." }; render(); } });
  }

  S.onTab = (id) => {
    if (S.tab === id) return;
    S.tab = id; render();
    if (api.setPrefs) api.setPrefs({ tab: id }).catch(() => {});
    if (id === "transactions" && S.snap && S.snap.state === "ready") loadTx();
    if (id === "import") loadImport();
    bodyHost.scrollTop = 0;
  };
  S.onTxQuery = (patch, debounce) => {
    if (patch === null) S.txq = {}; else S.txq = Object.assign({}, S.txq, patch);
    for (const k of Object.keys(S.txq)) if (!S.txq[k]) delete S.txq[k];
    clearTimeout(searchTimer);
    if (debounce) { searchTimer = setTimeout(loadTx, 250); return; }
    const focus = document.activeElement && document.activeElement.getAttribute("aria-label");
    render(); loadTx();
    if (focus) { const n = bodyHost.querySelector('[aria-label="' + focus.replace(/["\\]/g, "") + '"]'); if (n) n.focus(); }
  };
  S.onShowTx = (q) => { S.txq = Object.assign({}, q); S.txRes = null; S.tab = "transactions"; if (api.setPrefs) api.setPrefs({ tab: "transactions" }).catch(() => {}); render(); loadTx(); bodyHost.scrollTop = 0; };
  S.onRefresh = () => { S.snap = null; S.imp = null; render(); refresh(); };
  S.onImportScan = () => { S.imp = null; render(); loadImport(); };
  S.onOpenFolder = (which) => { api.openFolder(which).then((r) => { if (!r || !r.ok) say((r && r.reason) || "The folder could not be opened."); }).catch(() => say("The folder could not be opened.")); };
  S.onDemoCreate = (b) => {
    if (b) b.disabled = true;
    api.demoCreate().then((r) => { if (r && r.ok) { say("Demo data created: " + r.transactions + " invented lines."); S.imp = null; refresh(); } else { if (b) b.disabled = false; say((r && r.reason) || "Not created."); } }).catch(() => { if (b) b.disabled = false; say("Not created."); });
  };
  S.onDemoRemove = (b) => {
    if (b) b.disabled = true;
    api.demoRemove().then((r) => { if (r && r.ok) { say("Demo data moved to the archive (" + r.moved + " files). Nothing was deleted."); S.imp = null; S.txq = {}; refresh(); } else { if (b) b.disabled = false; say((r && r.reason) || "Not removed."); } }).catch(() => { if (b) b.disabled = false; say("Not removed."); });
  };

  const onDocClick = (e) => { if (e.target.closest(".argus-nav, .iris-nav, .memory-nav, #library-nav, .daily-nav, .health-nav, .tools-nav, .research-nav, #agent-list .agent-item")) close(); };
  const onDocKey = (e) => {
    if (e.key !== "Escape") return;
    if (!toast.classList.contains("hidden")) { toast.classList.add("hidden"); clearTimeout(toastTimer); e.preventDefault(); return; }
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") && e.target.value) return;
    close();
  };
  function openView() {
    if (open) return;
    if (window.viewManager) window.viewManager.closeAll();
    open = true;
    document.body.classList.add("finance-open");
    view.classList.remove("hidden");
    if (navEl) navEl.classList.add("active");
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onDocKey);
    S.snap = null; render();
    const go = () => { if (open) { render(); refresh(); } };
    if (api.getPrefs) api.getPrefs().then((r) => { if (r && r.ok && r.prefs && r.prefs.tab) S.tab = r.prefs.tab; go(); }).catch(go); else go();
  }
  function close() {
    if (!open) return;
    open = false;
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onDocKey);
    document.body.classList.remove("finance-open");
    view.classList.add("hidden");
    if (navEl) navEl.classList.remove("active");
    clearTimeout(searchTimer); clearTimeout(toastTimer);
    if (api.closed) api.closed().catch(() => {});
    S.snap = null; S.txRes = null; S.imp = null; S.txq = {}; S.txHost = null; S.catMonth = null;
    headHost.textContent = ""; bannerHost.textContent = ""; tabsHost.textContent = ""; bodyHost.textContent = ""; toast.textContent = ""; toast.classList.add("hidden");   // nothing from the ledger stays in the page
  }
  window.financeView = { toggle(nav) { if (nav) navEl = nav; open ? close() : openView(); }, close };
})();
