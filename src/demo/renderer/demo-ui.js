// Demo mode (v1.86.0): renderer side, injected only when AGENT_DESKTOP_DEMO=1 (window.__demoFinance is set just before this runs).
// Adds the demo-only "My Finance" destination: a tile in the Systems grid and a view in the main panel, drawn from invented numbers.
(function () {
  "use strict";
  if (window.__demoUiInstalled) return;
  window.__demoUiInstalled = true;
  const body = document.body;
  const data = window.__demoFinance || { months: [], moneyIn: [], moneyOut: [], kpis: [], recurring: [], invoices: [], currency: "$" };
  const cur = data.currency || "$";
  const money = (n) => (n < 0 ? "-" : "") + cur + Math.abs(Math.round(n)).toLocaleString("en-US");
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const NS = "http://www.w3.org/2000/svg";
  const svg = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]); return n; };

  function icon() {
    const s = svg("svg", { viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
    s.appendChild(svg("rect", { x: "3", y: "6", width: "18", height: "13", rx: "2" }));
    s.appendChild(svg("path", { d: "M3 10h18M16 14.5h2" }));
    const w = el("span", "lp-ico"); w.appendChild(s); return w;
  }

  // ---- the view ----------------------------------------------------------------------------------------------
  const view = el("div"); view.id = "finance-view"; view.className = "hidden";
  const head = el("div", "fin-head");
  head.append(el("strong", "fin-title", "My Finance"), el("span", "fin-date", new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })), el("span", "fin-sp"));
  const close = el("button", "fin-btn", "Close"); close.type = "button";
  head.appendChild(close);
  const tabs = el("div", "fin-tabs");
  ["Overview", "Cash flow", "Bills", "Invoices"].forEach((t, i) => tabs.appendChild(el("button", "fin-tab" + (i === 0 ? " on" : ""), t)));
  const main = el("div", "fin-body");
  view.append(head, tabs, main);

  function chart() {
    const W = 640, H = 220, padL = 44, padB = 24, padT = 10, n = data.months.length;
    const max = Math.max.apply(null, data.moneyIn.concat(data.moneyOut)) * 1.1;
    const s = svg("svg", { class: "fin-chart", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
    for (let g = 0; g <= 4; g++) {
      const y = padT + (H - padT - padB) * (g / 4);
      s.appendChild(svg("line", { x1: padL, x2: W - 6, y1: y, y2: y, stroke: "#e3e0d5", "stroke-width": "1" }));
      const t = svg("text", { x: padL - 6, y: y + 4, "text-anchor": "end" }); t.textContent = cur + Math.round(max * (1 - g / 4) / 1000) + "k"; s.appendChild(t);
    }
    const slot = (W - padL - 6) / n;
    for (let i = 0; i < n; i++) {
      const x0 = padL + slot * i + slot * 0.16, bw = slot * 0.32;
      const h = (v) => (H - padT - padB) * (v / max);
      s.appendChild(svg("rect", { x: x0, y: H - padB - h(data.moneyIn[i]), width: bw, height: h(data.moneyIn[i]), rx: 3, fill: "#14b8a6" }));
      s.appendChild(svg("rect", { x: x0 + bw + 3, y: H - padB - h(data.moneyOut[i]), width: bw, height: h(data.moneyOut[i]), rx: 3, fill: "#f59e0b" }));
      const t = svg("text", { x: padL + slot * i + slot / 2, y: H - 7, "text-anchor": "middle" }); t.textContent = data.months[i]; s.appendChild(t);
    }
    return s;
  }
  function card(title, extra) { const c = el("div", "fin-card"); const h = el("h3", "fin-card-h", title); if (extra) h.appendChild(extra); c.appendChild(h); return c; }
  function render() {
    main.textContent = "";
    const tiles = el("div", "fin-tiles");
    for (const k of data.kpis) { const t = el("div", "fin-tile"); t.append(el("div", "fin-tile-t", k.label), el("div", "fin-tile-v", k.value), el("div", "fin-tile-s", k.note)); tiles.appendChild(t); }
    main.appendChild(tiles);
    const row = el("div", "fin-row2");
    const legend = el("span", "fin-legend");
    const lg = (c, t) => { const s = el("span"); const sw = el("i", "fin-sw"); sw.style.background = c; s.append(sw, t); return s; };
    legend.append(lg("#14b8a6", "Money in"), lg("#f59e0b", "Money out"));
    const cf = card("Cash flow, last six months", legend); cf.appendChild(chart());
    const bills = card("Recurring bills");
    const list = el("div", "fin-list");
    for (const b of data.recurring) { const li = el("div", "fin-li"); li.append(el("span", "fin-li-n", b.name), el("span", "fin-li-d", b.due), el("span", "fin-li-a", money(b.amount))); list.appendChild(li); }
    bills.appendChild(list);
    row.append(cf, bills);
    main.appendChild(row);
    const inv = card("Invoiced vs received");
    const hdr = el("div", "fin-inv fin-inv-h"); ["Client", "Paid", "Invoiced", "Received", "Open"].forEach((t, i) => hdr.appendChild(el("span", i > 1 ? "fin-num" : "", t)));
    inv.appendChild(hdr);
    for (const r of data.invoices) {
      const line = el("div", "fin-inv");
      const bar = el("div", "fin-bar"); const fill = el("i"); fill.style.width = Math.min(100, Math.round((r.received / r.invoiced) * 100)) + "%"; bar.appendChild(fill);
      const open = r.invoiced - r.received;
      line.append(el("span", "", r.client), bar, el("span", "fin-num", money(r.invoiced)), el("span", "fin-num", money(r.received)), el("span", "fin-num " + (open > 0 ? "fin-warn" : "fin-ok"), open > 0 ? money(open) : "paid"));
      inv.appendChild(line);
    }
    main.appendChild(inv);
  }
  render();

  // ---- the tile and the open/close behaviour ----------------------------------------------------------------------------
  // v1.90.0: the real My Finance entry (finance-nav.js) has no handlers in demo mode; the demo's own mock-up replaces it
  document.querySelectorAll(".finance-nav").forEach((n) => n.remove());
  const nav = el("button", "finance-nav lp-tile"); nav.type = "button"; nav.dataset.lpId = "finance"; nav.dataset.systemNav = "finance";
  nav.title = "My Finance - cash flow, bills and invoices.";
  nav.append(icon(), el("span", "finance-nav-name", "My Finance"));
  const grid = document.querySelector("#systems-group .lp-grid");
  if (grid) {
    const after = grid.querySelector('[data-lp-id="health"]');
    if (after && after.nextSibling) grid.insertBefore(nav, after.nextSibling); else grid.appendChild(nav);
  } else { const list = document.getElementById("agent-list"); if (list && list.parentNode) list.parentNode.insertBefore(nav, list); }
  const mainPanel = document.getElementById("main-panel");
  if (mainPanel) mainPanel.appendChild(view);

  const OTHERS = ["argus-open", "iris-open", "library-open", "daily-open", "memory-open", "tools-open", "health-open"];
  let isOpen = false;
  function openView() {
    if (window.viewManager) window.viewManager.closeAll();
    isOpen = true; body.classList.add("finance-open"); view.classList.remove("hidden"); nav.classList.add("active");
  }
  function closeView() { if (!isOpen) return; isOpen = false; body.classList.remove("finance-open"); view.classList.add("hidden"); nav.classList.remove("active"); }
  nav.addEventListener("click", () => (isOpen ? closeView() : openView()));
  close.addEventListener("click", closeView);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen) closeView(); });
  // another destination, or an agent, opens: this one steps aside
  new MutationObserver(() => { if (isOpen && OTHERS.some((c) => body.classList.contains(c))) closeView(); }).observe(body, { attributes: true, attributeFilter: ["class"] });
  const agentListEl = document.getElementById("agent-list");
  if (agentListEl) agentListEl.addEventListener("click", () => closeView(), true);
  tabs.addEventListener("click", (e) => { const b = e.target.closest(".fin-tab"); if (!b) return; tabs.querySelectorAll(".fin-tab").forEach((x) => x.classList.toggle("on", x === b)); });
  window.demoFinance = { open: openView, close: closeView };

  // A few product texts name the app's real owner and partner ("Send to the partner", "needs the owner"). On screen they read as the fictional
  // owner and partner instead. Text nodes and title/placeholder attributes only; runs once per animation frame at most.
  const NAMES = [[/\bPartner\b/g, "Sam"], [/\bOwner\b/g, "Maya"]];
  // the demo working folder never shows on screen: it reads as the studio's own folder
  const BASE = String(window.__demoBase || "");
  const fixBase = (s) => {
    if (!BASE) return s;
    let o = s, i;
    while ((i = o.toLowerCase().indexOf(BASE.toLowerCase())) >= 0) o = o.slice(0, i) + "C:\\Aurora Studio" + o.slice(i + BASE.length);
    return o;
  };
  const HIT = { test: (t) => /Sarah|Alex/.test(t) || (BASE !== "" && String(t).toLowerCase().indexOf(BASE.toLowerCase()) >= 0) };
  const fix = (s) => { let o = fixBase(s); for (const [re, to] of NAMES) o = o.replace(re, to); return o; };
  function scrub(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) { if (HIT.test(n.nodeValue)) n.nodeValue = fix(n.nodeValue); }
    if (root.querySelectorAll) for (const e of root.querySelectorAll("[title],[placeholder],[aria-label]")) {
      for (const a of ["title", "placeholder", "aria-label"]) { const v = e.getAttribute(a); if (v && HIT.test(v)) e.setAttribute(a, fix(v)); }
    }
  }
  let queued = false;
  new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; try { scrub(document.body); } catch (e) { /* cosmetic */ } }); })
    .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["title", "placeholder", "aria-label"] });
  scrub(document.body);
})();
