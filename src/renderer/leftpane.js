// Left pane layouts F ("dock") and C ("grid") (v1.80.0). See ../leftpane.js for the pure logic and styles-leftpane.css for the look.
//
// What this does, and what it deliberately does not:
//  - It MOVES the sidebar entries the modules already created (ARGUS, MEMORY, My Daily, IRIS, Library) into one
//    collapsible SYSTEMS group. Same elements, so their click handlers, badges, hover digests and "active" states
//    keep working untouched. Dim "soon" tiles are placeholders for systems that do not exist yet.
//  - Agent rows are restyled by CSS only. No row is rebuilt, nothing is polled, no timers. F adds one dock for the
//    selected agent, refreshed from ONE coalesced MutationObserver on the agent list (it rewrites the dock only when
//    something visible changed). C adds one legend bar. Both: a click handler on the SYSTEMS header, a localStorage read.
//  - Anything that throws while building a layout puts the old stack back (classic) and logs it.
(() => {
  "use strict";
  const LP = window.LeftPane;
  const sidebar = document.getElementById("sidebar");
  const agentList = document.getElementById("agent-list");
  if (!LP || !sidebar || !agentList) return;

  const KEY_LAYOUT = "agentDesktop.leftPaneLayout";
  const KEY_STRIP = "agentDesktop.systemsCollapsed";
  const KEY_LEGEND = "agentDesktop.legendOpen";   // v1.83.2: C's legend card, collapsed behind a "?" button
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked: the setting just does not persist */ } },
  };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  // 18px line icons, stroke currentColor, built as SVG nodes (no HTML strings).
  const ICONS = {
    argus: [["circle", { cx: "12", cy: "12", r: "3" }], ["path", { d: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" }]],
    memory: [["rect", { x: "4", y: "4", width: "16", height: "4", rx: "1" }], ["rect", { x: "4", y: "10", width: "16", height: "4", rx: "1" }], ["rect", { x: "4", y: "16", width: "16", height: "4", rx: "1" }]],
    daily: [["rect", { x: "3", y: "5", width: "18", height: "16", rx: "2" }], ["path", { d: "M16 3v4M8 3v4M3 10h18" }]],
    iris: [["path", { d: "M7 7h13l-3-3M17 17H4l3 3" }]],
    chats: [["path", { d: "M4 5h16v11H9l-5 4z" }]],
    library: [["path", { d: "M4 5h4v14H4zM10 5h4v14h-4zM16 6l4 1-3 12-4-1z" }]],
    health: [["path", { d: "M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z" }]],
    tasks: [["path", { d: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" }]],
    reviews: [["path", { d: "M9 12l2 2 4-4M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" }]],
    designs: [["rect", { x: "3", y: "3", width: "8", height: "8", rx: "1.5" }], ["rect", { x: "13", y: "3", width: "8", height: "8", rx: "1.5" }], ["rect", { x: "3", y: "13", width: "8", height: "8", rx: "1.5" }], ["circle", { cx: "17", cy: "17", r: "4" }]],
    tools: [["path", { d: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z" }]],
    research: [["circle", { cx: "11", cy: "11", r: "6" }], ["path", { d: "M20 20l-4.2-4.2" }]],
    finance: [["rect", { x: "3", y: "6", width: "18", height: "13", rx: "2" }], ["path", { d: "M3 10h18M16 14.5h2" }]],
    setup: [["circle", { cx: "12", cy: "12", r: "3" }], ["path", { d: "M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" }]],
    other: [["circle", { cx: "12", cy: "12", r: "8" }]],
  };
  function icon(id) {
    const NS = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(NS, "svg");
    const attrs = { viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
    for (const k of Object.keys(attrs)) s.setAttribute(k, attrs[k]);
    for (const [tag, a] of ICONS[id] || ICONS.other) { const p = document.createElementNS(NS, tag); for (const k of Object.keys(a)) p.setAttribute(k, a[k]); s.appendChild(p); }
    const w = el("span", "lp-ico"); w.appendChild(s); return w;
  }

  let group = null;            // #systems-group while F or C is on
  let moved = [];              // the moved sidebar entries, in their original order, so classic can put them back
  let dock = null, legendBar = null, dockObs = null, dockSig = null, dockQueued = false;
  let helpBtn = null;
  let kind = null;             // "dock" | "grid" | null (classic)

  // ------------------------------------------------------------------ shared: the SYSTEMS group
  function buildGroup() {
    const found = [];
    for (const s of LP.SYSTEMS) {
      const n = document.querySelector(s.sel);
      if (n && n.parentNode === sidebar) found.push({ id: s.id, node: n });
    }
    const extras = [...sidebar.querySelectorAll(":scope > [data-system-nav]")]
      .filter((n) => !found.some((f) => f.node === n)).map((n) => ({ id: n.dataset.systemNav, node: n }));
    const nodes = new Map();
    for (const x of found.concat(extras)) if (!nodes.has(x.id)) nodes.set(x.id, x.node);
    const tiles = LP.planTiles(found.map((f) => f.id), extras.map((x) => x.id));
    const keep = new Set(nodes.values());
    moved = [...sidebar.children].filter((c) => keep.has(c));

    const g = el("div"); g.id = "systems-group";
    const headRow = el("div", "lp-head-row");
    const head = el("button", "lp-head");
    head.type = "button";
    head.append(el("span", "lp-caret", "▾"), el("span", "lp-head-title", "SYSTEMS"));
    // v1.83.2: "?" opens/closes C's legend card (the card used to sit permanently above the list, ~70 px). Shown in C only (CSS).
    const help = el("button", "lp-help", "?");
    help.type = "button";
    help.title = "What the icons on the agent rows mean";
    help.setAttribute("aria-label", "Show or hide the legend of the agent row icons");
    help.addEventListener("click", () => { const now = !(legendBar && !legendBar.hidden); setLegend(now); store.set(KEY_LEGEND, LP.serializeCollapsed(now)); });
    headRow.append(head, help);
    helpBtn = help;
    const grid = el("div", "lp-grid");
    let soonCount = 0;
    for (const t of tiles) {
      const node = t.kind === "live" ? nodes.get(t.id) : null;
      if (node) {
        node.classList.add("lp-tile");
        node.dataset.lpId = t.id;
        node.insertBefore(icon(t.id), node.firstChild);
        grid.appendChild(node);
      } else {
        soonCount++;
        const soon = el("div", "lp-tile lp-soon");
        soon.dataset.lpId = t.id;
        soon.title = t.label + " - coming soon";
        soon.setAttribute("aria-disabled", "true");
        soon.append(icon(t.id), el("span", "lp-soon-name", t.label)); // v1.83.2: no per-tile "soon" word; one "N coming" line below the grid
        grid.appendChild(soon);
      }
    }
    // F: the soon tiles hide behind one dashed "More" card (placed before them). C shows them and hides this card.
    const more = el("button", "lp-tile lp-more");
    more.type = "button";
    const moreT = el("span", "lp-more-t", "▾ More");
    more.append(moreT, el("span", "lp-more-s", LP.comingLine(soonCount)));
    more.title = "Systems that are coming: " + tiles.filter((t) => t.kind === "soon").map((t) => t.label).join(", ");
    more.addEventListener("click", () => { const closed = g.classList.toggle("lp-more-closed"); moreT.textContent = closed ? "▾ More" : "▴ Less"; });
    const firstSoon = grid.querySelector(".lp-soon");
    if (firstSoon) grid.insertBefore(more, firstSoon); else more.hidden = true;
    g.classList.add("lp-more-closed");
    const coming = el("div", "lp-coming", LP.comingLine(soonCount)); // C only (F has the More card)
    if (!soonCount) coming.hidden = true;
    g.append(headRow, grid, coming);
    sidebar.insertBefore(g, agentList);
    group = g;

    head.addEventListener("click", () => { const now = !g.classList.contains("lp-strip"); setStrip(now); store.set(KEY_STRIP, LP.serializeCollapsed(now)); });
    // Library: in C and in the icon strip its three buttons are not shown, so a click on the tile itself opens Documents.
    const lib = grid.querySelector("#library-nav");
    if (lib) lib.addEventListener("click", (e) => {
      if (e.target.closest(".library-nav-unread")) return;
      const bare = g.classList.contains("lp-strip") || document.body.classList.contains("lp-c");
      if (e.target.closest(".library-nav-btn") && !bare) return;
      const b = lib.querySelector(".library-nav-btn:has(.library-nav-unread)") || lib.querySelector(".library-nav-btn");
      if (b && !e.target.closest(".library-nav-btn")) b.click();
    });
    setStrip(LP.parseCollapsed(store.get(KEY_STRIP)));
  }

  function setStrip(on) {
    if (!group) return;
    group.classList.toggle("lp-strip", on);
    const head = group.querySelector(".lp-head");
    head.setAttribute("aria-expanded", on ? "false" : "true");
    head.title = on ? "Show the Systems with names" : "Collapse the Systems to one row of icons";
    group.querySelector(".lp-caret").textContent = on ? "▸" : "▾";
  }

  function legendItems(host, max) {
    for (const l of LP.LEGEND.slice(0, max || LP.LEGEND.length)) { const it = el("span", "lp-lg-item"); it.appendChild(el("i", l.cls, l.glyph)); it.append(l.label.split(":")[0]); host.appendChild(it); }
  }

  // ------------------------------------------------------------------ C: legend bar between the Systems and the agents
  function setLegend(open) {
    if (!legendBar) return;
    legendBar.hidden = !open;
    if (helpBtn) { helpBtn.setAttribute("aria-expanded", open ? "true" : "false"); helpBtn.classList.toggle("lp-on", open); }
  }
  function buildLegendBar() {
    const bar = el("div"); bar.id = "lp-legend-bar";
    bar.title = "Icon on the avatar = run state. The small dot at the right of a row is the agent's own health reading, a separate thing.";
    legendItems(bar);
    sidebar.insertBefore(bar, agentList);
    legendBar = bar;
    // remembered; the very first run shows it once, then it starts closed
    const init = LP.legendInitial(store.get(KEY_LEGEND));
    setLegend(init.open);
    if (init.persist) store.set(KEY_LEGEND, LP.serializeCollapsed(false));
  }

  // ------------------------------------------------------------------ F: one dock for the selected agent
  function readSelected() {
    const row = agentList.querySelector(".agent-item.active");
    if (!row) return null;
    const ic = row.querySelector(".xp-state-icon");
    const nameEl = row.querySelector(".agent-item-name");
    const roleEl = row.querySelector(".agent-item-role");
    const fills = [...row.querySelectorAll(":scope > .mem-mark .mem-bar-fill")].map((f) => f.style.width);
    const nb = row.querySelector(".xp-needs-badge");
    return { row, folder: row.dataset.folderName, name: nameEl && nameEl.firstChild ? nameEl.firstChild.textContent : "",
      role: roleEl ? roleEl.textContent : "", paused: row.classList.contains("agent-item-paused"),
      state: ic ? (ic.classList.contains("working") ? "working" : ic.classList.contains("ready") ? "ready" : "off") : "off", widths: fills, needs: nb ? nb.title : "" };
  }
  function buildDock() {
    const d = el("div"); d.id = "lp-dock";
    sidebar.insertBefore(d, agentList.nextSibling);
    dock = d; dockSig = null;
    refreshDock();
    // ONE observer, coalesced to a frame: rows are rebuilt on every list refresh, memory bars arrive after them, the selected row changes on click.
    dockObs = new MutationObserver(() => {
      if (dockQueued) return;
      dockQueued = true;
      requestAnimationFrame(() => { dockQueued = false; try { refreshDock(); } catch (e) { console.error("[leftpane] dock", e); } });
    });
    dockObs.observe(agentList, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }
  function refreshDock() {
    if (!dock) return;
    const sel = readSelected();
    const m = LP.dockModel(sel);
    const sig = m ? m.sig : "";
    if (sig === dockSig) return;
    dockSig = sig;
    dock.textContent = "";
    dock.classList.toggle("lp-dock-sel", !!m); // v1.83.2: neutral border until an agent is selected
    if (!m) { dock.appendChild(el("div", "lp-dock-empty", "Select an agent to see its controls and memory here.")); return; }
    const top = el("div", "lp-dock-top");
    const av = sel.row.querySelector(".avatar-wrap");
    if (av) top.appendChild(av.cloneNode(true));
    const txt = el("div", "lp-dock-text");
    txt.append(el("div", "lp-dock-name", m.name));
    if (m.role) txt.append(el("div", "lp-dock-role", m.role));
    top.appendChild(txt);
    // v1.84.3 (UI-UX spec): the Pause button sits at the right of the first row, so the dock is two rows instead of five.
    const b = el("button", "lp-dock-btn", m.action);
    b.type = "button";
    b.title = m.paused ? "Resume this agent (same as its ... menu)" : "Pause this agent: stops its background process until resumed (same as its ... menu)";
    b.addEventListener("click", () => {
      try { const a = typeof agents !== "undefined" ? agents.find((x) => x.folderName === m.folder) : null; if (a && typeof toggleAgentPaused === "function") toggleAgentPaused(a); } catch (e) { console.error("[leftpane] pause", e); }
    });
    top.appendChild(b);
    dock.appendChild(top);
    dock.classList.toggle("lp-dock-working", m.state === "working");
    const mem = el("div", "lp-dock-mem");
    mem.appendChild(el("span", "lp-dock-memlbl", "Memory"));
    const bars = sel.row.querySelector(":scope > .mem-mark");
    if (bars) { const c = bars.cloneNode(true); c.classList.add("lp-dock-bars"); mem.appendChild(c); }
    mem.appendChild(el("span", "lp-dock-memtxt", m.memory || "no figures yet"));
    // The run-state legend moved behind an (i) button: shown on hover AND keyboard focus, with this agent's own state first.
    const info = el("span", "lp-dock-info");
    const ib = el("button", "lp-dock-ibtn", "i");
    ib.type = "button";
    ib.setAttribute("aria-label", "Run state legend. This agent: " + LP.stateWord(m.state));
    const tip = el("span", "lp-dock-tip");
    tip.setAttribute("role", "tooltip");
    tip.appendChild(el("div", "lp-dock-tipcur", "This agent: " + LP.stateWord(m.state)));
    const lg = el("div", "lp-dock-legend");
    legendItems(lg, 3);
    for (const it of lg.children) { if (it.textContent.trim().toLowerCase() === LP.stateWord(m.state).toLowerCase()) { it.classList.add("lp-dock-cur"); it.append(" ✓"); } } // UI-UX: mark this agent's own state instead of repeating it
    tip.appendChild(lg);
    info.append(ib, tip);
    mem.appendChild(info);
    dock.appendChild(mem);
  }
  function destroyDock() {
    if (dockObs) { dockObs.disconnect(); dockObs = null; }
    if (dock) { dock.remove(); dock = null; }
    dockSig = null; dockQueued = false;
  }

  // ------------------------------------------------------------------ layouts on / off
  function layoutOn(want) {
    if (!group) buildGroup();
    if (want === "dock") { if (legendBar) { legendBar.remove(); legendBar = null; } if (!dock) buildDock(); }
    else { destroyDock(); if (!legendBar) buildLegendBar(); }
    kind = want;
    document.body.classList.remove("lp-classic", "lp-f", "lp-c");
    document.body.classList.add("lp-on", want === "dock" ? "lp-f" : "lp-c");
  }

  function layoutOff() {
    destroyDock();
    if (legendBar) { legendBar.remove(); legendBar = null; }
    document.body.classList.remove("lp-on", "lp-f", "lp-c");
    document.body.classList.add("lp-classic");
    kind = null;
    if (!group) return;
    for (const node of moved) {
      node.classList.remove("lp-tile");
      delete node.dataset.lpId;
      const ico = node.querySelector(":scope > .lp-ico");
      if (ico) ico.remove();
      sidebar.insertBefore(node, agentList);
    }
    group.remove();
    group = null; moved = []; helpBtn = null;
  }

  function applyLayout(name) {
    const want = LP.normalizeLayout(name);
    try {
      if (want === "classic") layoutOff(); else layoutOn(want);
    } catch (e) {
      console.error("[leftpane] layout failed, falling back to classic", e);
      try { layoutOff(); } catch (e2) { console.error("[leftpane] restore failed", e2); }
    }
    const sel = document.getElementById("lp-layout-select");
    if (sel) sel.value = kind || "classic";
  }

  // ------------------------------------------------------------------ the setting (sidebar foot, under Plan)
  const row = el("div"); row.id = "lp-layout-row";
  const lab = el("label", null, "Left pane"); lab.setAttribute("for", "lp-layout-select");
  const sel = el("select"); sel.id = "lp-layout-select";
  sel.title = "F: card grid of Systems and a dock for the selected agent. C: icon grid of Systems and a legend bar. Classic: the layout before 1.80.";
  for (const v of LP.LAYOUTS) { const o = el("option", null, LP.LAYOUT_LABELS[v]); o.value = v; sel.appendChild(o); }
  row.append(lab, sel);
  // v1.80.1: Restart agents... stays reachable with no chat open. Same button, same picker and confirmation (it just clicks the original).
  const rs = el("button", null, "↻ Restart agents…"); rs.id = "lp-restart-btn"; rs.type = "button";
  rs.title = "Restart every agent's background process (or a chosen subset); opens the same picker as before.";
  rs.addEventListener("click", () => { const o = document.getElementById("restart-all-btn"); if (o) o.click(); });
  const rsRow = el("div"); rsRow.id = "lp-restart-row"; rsRow.appendChild(rs);
  const plan = document.getElementById("plan-selector-row");
  sidebar.insertBefore(row, plan ? plan.nextSibling : document.getElementById("app-version"));
  sidebar.insertBefore(rsRow, row.nextSibling);
  sel.addEventListener("change", () => { store.set(KEY_LAYOUT, LP.normalizeLayout(sel.value)); applyLayout(sel.value); });

  applyLayout(store.get(KEY_LAYOUT));
  window.leftPane = { applyLayout, current: () => kind || "classic" };
})();
