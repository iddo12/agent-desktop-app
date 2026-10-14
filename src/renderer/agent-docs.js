// Agent documents side panel (renderer), v1.92.0 rebuild of the v1.75 panel to the approved UI-UX mockups (2026-10-05).
// Self-contained: builds its own header toggle and panel inside #chat-view; renderer.js only calls
// window.agentDocsPanel.setAgent(agentPath, { key, name, avatar }) when the visible agent changes.
//
// Rules kept here: nothing loads until the panel is opened for an agent (the header badge is one cheap
// registry count); main is asked by agent folder name + document id only, never by path; every string from
// the registry goes in through textContent; read state is the Library's (same ids, same file) and both views
// tell each other through the "ad-doc-read" window event; open/closed, list/grid and the type pill are kept
// per agent in userData (agent-docs-prefs.json) through IPC, never localStorage.
(function () {
  "use strict";
  const L = window.AgentDocsLogic;
  if (!L) return;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const SVG_NS = "http://www.w3.org/2000/svg";
  function icon(kind, size) {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", String(size || 16));
    s.setAttribute("height", String(size || 16));
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "1.8");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    const paths = {
      doc: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 13h6", "M9 17h6"],
      search: ["M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z", "M20 20l-4-4"],
      close: ["M6 6l12 12", "M18 6L6 18"],
      ext: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
      back: ["M19 12H5", "M11 6l-6 6l6 6"],
      refresh: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"],
      grid: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
      list: ["M8 6h12", "M8 12h12", "M8 18h12", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
      folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
    };
    for (const d of paths[kind] || []) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      s.appendChild(p);
    }
    return s;
  }
  const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:");

  // ---- state ---------------------------------------------------------------------------------------------
  let agentPath = null; // for libraryBridge.send only (renderer-internal; never sent to main by this panel)
  let agentKey = null; // folder name: what main is asked with
  let agentInfo = {};
  let prefs = null; // { agents: { key: { open, view, type } } } once loaded
  let prefsLoading = null;
  const state = new Map(); // agentKey -> per-agent view state
  let reqSeq = 0, searchTimer = null, io = null, sentinelIo = null, ro = null;
  const thumbCache = new Map(); // "agentKey|id" -> thumbnail path, or "" when main has none (review N2)

  let btn, btnCount, btnNew, panel, listView, titleEl, avatarEl, viewBtn, searchEl, pillsEl, sortEl, countEl, statusEl, listEl, emptyEl;
  let viewer = null; // { root, item }

  const st = () => {
    if (!agentKey) return null;
    if (!prefs) return { open: false, items: [], loaded: false, expanded: {}, search: "", sort: "newest", sel: -1 }; // not kept: real state starts once prefs are in
    if (!state.has(agentKey)) {
      const p = (prefs && prefs.agents && prefs.agents[agentKey]) || {};
      state.set(agentKey, {
        open: !!p.open, type: p.type || null, view: p.view || null, typeChosen: !!p.type,
        search: "", sort: "newest", items: [], offset: 0, total: 0, counts: null, allTotal: null, unread: 0,
        sel: -1, expanded: {}, commenting: null, loaded: false, scroll: 0,
      });
    }
    return state.get(agentKey);
  };

  function savePref(patch) {
    if (!agentKey || !window.api.agentDocsPrefsSet) return;
    const key = agentKey;
    if (prefs) { prefs.agents[key] = { ...(prefs.agents[key] || {}), ...patch }; }
    window.api.agentDocsPrefsSet({ agent: key, ...patch }).catch(() => {});
  }

  function loadPrefs() {
    if (prefs) return Promise.resolve(prefs);
    if (!prefsLoading) {
      prefsLoading = (window.api.agentDocsPrefsGet ? window.api.agentDocsPrefsGet() : Promise.resolve(null))
        .then((p) => { prefs = p && p.agents ? p : { agents: {} }; return prefs; })
        .catch(() => { prefs = { agents: {} }; return prefs; });
    }
    return prefsLoading;
  }

  // ---- building the DOM (once) -----------------------------------------------------------------------------
  function build() {
    const header = document.getElementById("chat-header");
    const chatView = document.getElementById("chat-view");
    const body = document.getElementById("chat-body");
    if (!header || !chatView || !body || panel) return;

    btn = el("button", "agent-docs-btn");
    btn.id = "agent-docs-btn";
    btn.type = "button";
    btn.setAttribute("aria-controls", "agent-docs-panel");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-keyshortcuts", "Control+D");
    btn.appendChild(icon("doc", 15));
    btn.appendChild(el("span", "adp-btn-label xp-lbl", "Documents")); // xp-lbl: the word drops away on a narrow header, like the other top-bar buttons
    btnCount = el("span", "adp-btn-count hidden");
    btnNew = el("span", "adp-btn-new hidden");
    btn.append(btnCount, btnNew);
    btn.addEventListener("click", toggle);
    placeButton();

    panel = el("aside", "agent-docs-panel hidden");
    panel.id = "agent-docs-panel";
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-labelledby", "adp-title");
    panel.addEventListener("keydown", onPanelKey);

    listView = el("div", "adp-listview");
    const head = el("div", "adp-head");
    titleEl = el("h2", "adp-title");
    titleEl.id = "adp-title";
    titleEl.dir = "auto";
    avatarEl = el("span", "adp-avatar");
    avatarEl.setAttribute("aria-hidden", "true");
    const tools = el("div", "adp-tools");
    viewBtn = iconBtn("grid", "Show as a grid of previews", () => {
      const s = st();
      s.view = s.view === "grid" ? "list" : "grid";
      savePref({ view: s.view });
      render();
    });
    const refreshBtn = iconBtn("refresh", "Refresh the list", () => load(true, true));
    const closeBtn = iconBtn("close", "Close the documents panel (Esc)", () => setOpen(false, true));
    tools.append(viewBtn, refreshBtn, closeBtn);
    head.append(avatarEl, titleEl, tools);

    const sWrap = el("label", "adp-search");
    sWrap.appendChild(icon("search", 15));
    searchEl = el("input", "adp-search-input");
    searchEl.type = "search";
    searchEl.dir = "auto";
    searchEl.placeholder = "Search this agent's documents";
    searchEl.setAttribute("aria-label", "Search this agent's documents");
    searchEl.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { const s = st(); if (!s) return; s.search = searchEl.value.trim(); load(true); }, 200);
    });
    searchEl.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); focusList(0); }
      else if (e.key === "Escape" && searchEl.value) { e.preventDefault(); e.stopPropagation(); clearSearch(); }
    });
    sWrap.appendChild(searchEl);

    pillsEl = el("div", "adp-pills");
    pillsEl.setAttribute("role", "group");
    pillsEl.setAttribute("aria-label", "Show type");

    const meta = el("div", "adp-meta");
    sortEl = el("select", "adp-sort");
    sortEl.setAttribute("aria-label", "Sort");
    sortEl.append(new Option("Newest first", "newest"), new Option("Oldest first", "oldest"));
    sortEl.addEventListener("change", () => { const s = st(); s.sort = sortEl.value; load(true); });
    countEl = el("span", "adp-count");
    meta.append(sortEl, countEl);

    statusEl = el("div", "adp-status");
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");

    listEl = el("div", "adp-list");
    listEl.tabIndex = 0;
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", "Documents");
    listEl.addEventListener("keydown", onListKey);
    listEl.addEventListener("scroll", () => { const s = st(); if (s) s.scroll = listEl.scrollTop; }, { passive: true });

    emptyEl = el("div", "adp-empty hidden");

    listView.append(head, sWrap, pillsEl, meta, statusEl, listEl, emptyEl);
    panel.appendChild(listView);
    chatView.appendChild(panel);

    if ("ResizeObserver" in window) { ro = new ResizeObserver(() => layout()); ro.observe(chatView); }
    window.addEventListener("resize", layout);
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && String(e.key).toLowerCase() === "d" && agentKey && !chatView.classList.contains("hidden")) {
        e.preventDefault();
        toggle();
      }
    });
    window.addEventListener("ad-doc-read", onReadEvent);
  }

  // In the v1.71 two-row top bar the toggle sits in row 1's controls, just before Tasks (header-tasks.js builds
  // that row; if it is not there yet, or the old one-row header is in use, it goes after History and moves later).
  function placeButton() {
    if (!btn) return;
    const controls = document.querySelector("#chat-header .xp-controls");
    if (controls) {
      if (btn.parentElement === controls) return;
      const tasks = controls.querySelector(".xp-tasks-btn");
      btn.classList.add("xp-docs-btn");
      controls.insertBefore(btn, tasks || null);
      return;
    }
    if (btn.parentElement) return;
    const header = document.getElementById("chat-header");
    const hist = document.getElementById("history-toggle-btn");
    if (hist && hist.parentElement) hist.parentElement.insertBefore(btn, hist.nextSibling);
    else if (header) header.appendChild(btn);
  }

  function iconBtn(kind, label, fn) {
    const b = el("button", "adp-iconbtn");
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.appendChild(icon(kind, 16));
    b.addEventListener("click", fn);
    return b;
  }

  // ---- open / close / layout -------------------------------------------------------------------------------
  function toggle() { loadPrefs().then(() => { const s = st(); if (s) setOpen(!s.open, true); }); }

  function setOpen(open, byUser) {
    const s = st();
    if (!s) return;
    s.open = !!open;
    if (byUser) savePref({ open: s.open });
    if (!s.open) closeViewer(true);
    apply();
    if (s.open) {
      if (!s.loaded) load(true); else render();
      if (byUser) requestAnimationFrame(() => searchEl && searchEl.focus());
    } else if (byUser && btn) {
      btn.focus();
    }
  }

  function apply() {
    if (!panel) return;
    const s = st();
    const open = !!(s && s.open);
    panel.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.classList.toggle("active", open);
    const cv = document.getElementById("chat-view");
    if (cv) cv.classList.toggle("agent-docs-open", open);
    paintHead();
    if (open) {
      searchEl.value = s.search;
      sortEl.value = s.sort;
      layout();
      render();
    } else {
      layout();
    }
  }

  // Side by side when there is room, overlay when not (window < 1100 px, or the chat would drop under 360 px).
  function layout() {
    const cv = document.getElementById("chat-view");
    if (!cv || !panel) return;
    const s = st();
    const open = !!(s && s.open);
    const mode = open ? L.layoutMode(window.innerWidth, cv.clientWidth, !!viewer) : "";
    cv.classList.toggle("agent-docs-side", mode === "side");
    cv.classList.toggle("agent-docs-overlay", mode === "overlay");
    cv.classList.toggle("agent-docs-viewing", open && !!viewer);
    const body = document.getElementById("chat-body");
    if (body && open) panel.style.top = body.offsetTop + "px";
  }

  function paintHead() {
    if (!titleEl) return;
    titleEl.textContent = (agentInfo.name || "Agent") + " documents";
    avatarEl.textContent = "";
    if (agentInfo.avatar) {
      const img = el("img");
      img.src = agentInfo.avatar;
      img.alt = "";
      avatarEl.appendChild(img);
    } else {
      avatarEl.textContent = (agentInfo.name || "?").slice(0, 1).toUpperCase();
    }
    const s = st();
    const grid = s && s.view === "grid";
    viewBtn.textContent = "";
    viewBtn.appendChild(icon(grid ? "list" : "grid", 16));
    const vl = grid ? "Show as a list" : "Show as a grid of previews";
    viewBtn.title = vl;
    viewBtn.setAttribute("aria-label", vl);
    panel.setAttribute("aria-label", (agentInfo.name || "Agent") + " documents");
  }

  // ---- header badge ----------------------------------------------------------------------------------------
  async function refreshBadge() {
    if (!btn || !agentKey || !window.api.agentDocsSummary) return;
    const mine = agentKey;
    try {
      const r = await window.api.agentDocsSummary(mine);
      if (mine !== agentKey) return;
      paintBadge(r);
    } catch (e) { /* the badge is optional */ }
  }
  function paintBadge(sum) {
    const b = L.badge(sum);
    btnCount.textContent = b.total;
    btnCount.classList.toggle("hidden", false);
    btnNew.textContent = b.fresh;
    btnNew.classList.toggle("hidden", !b.fresh);
    btn.title = b.label + " (Ctrl+D)";
    btn.setAttribute("aria-label", b.label);
  }

  // ---- data ------------------------------------------------------------------------------------------------
  async function load(reset, refresh) {
    const s = st();
    if (!s) return;
    const mine = agentKey, seq = ++reqSeq;
    if (reset) { s.offset = 0; s.items = []; s.sel = -1; s.commenting = null; }
    statusEl.textContent = s.items.length ? "Loading more..." : "Loading...";
    listEl.setAttribute("aria-busy", "true");
    const type = s.type || "docs";
    let r;
    try {
      r = await window.api.agentDocsList(mine, { type, search: s.search, sort: s.sort, offset: s.offset, refresh: !!refresh, stack: true });
    } catch (e) {
      if (seq === reqSeq) statusEl.textContent = "Could not load the documents.";
      listEl.removeAttribute("aria-busy");
      return;
    }
    if (seq !== reqSeq || mine !== agentKey) return; // a newer request or another agent won
    listEl.removeAttribute("aria-busy");
    s.loaded = true;
    s.counts = r.counts || {};
    if (!s.search) s.allTotal = s.counts.all || 0;
    // First open for this agent with no saved choice: an image-heavy agent opens on Images, as a grid.
    if (!s.typeChosen && !s.search && reset && !s.type) {
      const d = L.defaultView(s.counts);
      s.typeChosen = true;
      if (!s.view) s.view = d.view;
      if (d.type !== type) { s.type = d.type; paintHead(); return load(true); }
      s.type = d.type;
    }
    if (!s.view) s.view = "list";
    s.items = s.items.concat(r.items || []);
    s.offset = s.items.length;
    s.total = r.total || 0;
    s.unread = r.unread || 0;
    statusEl.textContent = "";
    paintHead();
    render();
    refreshBadge(); // registered documents only, the same number before and after the panel was opened (N8)
  }

  function clearSearch() {
    const s = st();
    searchEl.value = "";
    s.search = "";
    load(true);
    searchEl.focus();
  }

  // ---- rendering -------------------------------------------------------------------------------------------
  function render() {
    const s = st();
    if (!panel || !s || !s.open) return;
    const type = s.type || "docs";
    pillsEl.textContent = "";
    for (const p of L.pills(s.counts, type)) {
      const b = el("button", "adp-pill" + (p.active ? " active" : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", p.active ? "true" : "false");
      b.append(el("span", "adp-pill-l", p.label), el("span", "adp-pill-n", String(p.n)));
      b.addEventListener("click", () => {
        if (s.type === p.key) return;
        s.type = p.key;
        s.typeChosen = true;
        savePref({ type: p.key });
        load(true);
      });
      pillsEl.appendChild(b);
    }
    const filesN = s.counts ? s.counts[type] || 0 : 0;
    countEl.textContent = L.countLine({ loaded: s.loaded, search: s.search, files: filesN, total: s.total, shown: s.items.length, allTotal: s.allTotal });

    listEl.textContent = "";
    listEl.classList.toggle("grid", s.view === "grid");
    // An agent with nothing at all: just the title and the explanation (mockup section 5), no search or pills to play with.
    const nothing = s.loaded && !s.search && !s.allTotal;
    for (const n of [searchEl.parentElement, pillsEl, sortEl.parentElement]) n.classList.toggle("hidden", nothing);
    if (s.loaded && !s.items.length) {
      const pill = L.PILLS.find((x) => x.key === type);
      showEmpty(L.emptyState({ allTotal: s.allTotal, search: s.search, typeLabel: pill ? pill.label : "" }));
      return;
    }
    emptyEl.classList.add("hidden");
    listEl.classList.remove("hidden");
    let lastGroup = null;
    s.items.forEach((it, i) => {
      if (it.group !== lastGroup) {
        lastGroup = it.group;
        const g = el("div", "adp-group", it.group);
        g.setAttribute("role", "presentation");
        listEl.appendChild(g);
      }
      listEl.appendChild(row(it, i, s));
      if (it.older && it.older.length && s.expanded[it.id]) {
        for (const o of it.older) { const orow = row(o, -1, s); orow.classList.add("older"); listEl.appendChild(orow); }
      }
    });
    if (s.items.length < s.total) {
      const more = el("button", "adp-more", "Load " + Math.min(40, s.total - s.items.length) + " more");
      more.type = "button";
      more.addEventListener("click", () => load(false));
      listEl.appendChild(more);
      // Scrolling to the end loads the next page too.
      if ("IntersectionObserver" in window) {
        if (!sentinelIo) sentinelIo = new IntersectionObserver((ents) => ents.forEach((e) => { if (e.isIntersecting) { sentinelIo.unobserve(e.target); load(false); } }), { root: listEl, rootMargin: "80px" });
        sentinelIo.observe(more);
      }
    }
    if (s.sel >= 0) listEl.setAttribute("aria-activedescendant", "adp-row-" + s.sel); else listEl.removeAttribute("aria-activedescendant");
    if (s.scroll) listEl.scrollTop = s.scroll;
  }

  function showEmpty(e) {
    listEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    emptyEl.textContent = "";
    const ic = el("div", "adp-empty-icon");
    ic.appendChild(icon(e.kind === "nomatch" ? "search" : "doc", 40));
    const t = el("div", "adp-empty-title", e.title);
    t.dir = "auto";
    emptyEl.append(ic, t, el("div", "adp-empty-text", e.text));
    if (e.action) {
      const b = el("button", "adp-btn", e.action);
      b.type = "button";
      b.addEventListener("click", () => {
        const s = st();
        if (e.kind === "nomatch") clearSearch();
        else { s.type = "all"; s.typeChosen = true; savePref({ type: "all" }); load(true); }
      });
      emptyEl.appendChild(b);
    }
  }

  function row(it, i, s) {
    const grid = s.view === "grid";
    const selected = i >= 0 && i === s.sel;
    const r = el("div", "adp-row" + (it.unread ? " unread" : "") + (selected ? " sel" : ""));
    if (i >= 0) { r.id = "adp-row-" + i; r.dataset.index = String(i); }
    r.setAttribute("role", "option");
    r.setAttribute("aria-selected", selected ? "true" : "false");
    r.setAttribute("aria-label", it.title + ", " + it.kind + ", " + (it.unread ? "not opened yet" : "read") + ", " + L.fmtWhen(it.mtimeMs));

    const dot = el("span", "adp-dot " + (it.unread ? "is-unread" : "is-read"));
    dot.title = it.unread ? "Not opened yet" : "Read";
    dot.setAttribute("aria-hidden", "true");

    const tile = el("div", "adp-tile k-" + it.type);
    tile.appendChild(el("span", "adp-tile-k", it.kind));
    // No Word thumbnails: the Windows shell gives a near-blank page for most .docx, the DOC tile says more.
    if (["image", "pdf", "video"].includes(it.type) && window.api.agentDocsThumb) {
      const key = agentKey;
      const ck = key + "|" + it.id;
      const addImg = (p) => {
        const img = el("img");
        img.alt = "";
        img.loading = "lazy";
        img.addEventListener("load", () => tile.classList.add("has-img"));
        img.addEventListener("error", () => img.remove());
        img.src = fileUrl(p);
        tile.insertBefore(img, tile.firstChild);
      };
      // Review N2: a rebuilt row reuses the answer it already got (path, or "" for none) - no new IPC per re-render.
      if (thumbCache.has(ck)) { const p = thumbCache.get(ck); if (p) addImg(p); }
      else {
        lazy(tile, async () => {
          try {
            const t = await window.api.agentDocsThumb(key, it.id);
            thumbCache.set(ck, t && t.ok ? t.path : "");
            if (t && t.ok && key === agentKey && tile.isConnected) addImg(t.path);
          } catch (e) { /* keep the type tile */ }
        });
      }
    }

    const main = el("div", "adp-main");
    const name = el("div", "adp-name", it.title);
    name.dir = "auto";
    name.title = it.name;
    const sub = el("div", "adp-sub");
    sub.appendChild(el("span", "", L.fmtWhen(it.mtimeMs) + " · " + L.fmtSize(it.size)));
    const chip = L.statusChip(it.status);
    if (chip) sub.appendChild(el("span", "adp-chip " + chip.cls, chip.text));
    main.append(name, sub);
    if (it.versions > 1) {
      const open = !!s.expanded[it.id];
      const fold = el("button", "adp-fold", it.versions + " versions" + (open ? " · hide older" : " · show older"));
      fold.type = "button";
      fold.setAttribute("aria-expanded", open ? "true" : "false");
      fold.addEventListener("click", (e) => { e.stopPropagation(); s.expanded[it.id] = !open; render(); });
      main.appendChild(fold);
    }
    if (grid) r.append(tile, dot, main); else r.append(dot, tile, main);

    if (selected || i < 0) {
      if (selected) {
        const acts = el("div", "adp-acts");
        const mk = (label, cls, fn, title, ic) => {
          const b = el("button", "adp-btn" + (cls ? " " + cls : ""));
          b.type = "button";
          b.appendChild(el("span", "", label));
          if (ic) b.appendChild(icon(ic, 13));
          if (title) b.title = title;
          b.addEventListener("click", (e) => { e.stopPropagation(); fn(it); });
          return b;
        };
        if (it.viewable) acts.appendChild(mk("Open here", "primary", openHere, "Open in the viewer beside the chat (Enter)"));
        // Review N4: legacy .doc/.xls/.rtf, .svg and .zip are never launched from here - Show in folder instead.
        if (it.openable) acts.appendChild(mk("Open externally", it.viewable ? "" : "primary", (x) => openExt(x, "open"), "Open with the default program (Shift+Enter)", "ext"));
        acts.appendChild(mk("Show in folder", it.viewable || it.openable ? "" : "primary", (x) => openExt(x, "reveal"), "Show the file in Explorer"));
        acts.appendChild(mk(it.unread ? "Mark read" : "Mark unread", "", toggleRead, "U"));
        acts.appendChild(mk("Comment & send", "", (x) => startComment(x), "Write a comment and send it to " + (agentInfo.name || "the agent") + " (C)"));
        r.appendChild(acts);
        if (s.commenting === it.id) r.appendChild(commentBox(it, () => { s.commenting = null; rerow(s.sel); focusList(); }));
      }
    }
    r.addEventListener("click", () => {
      if (i < 0) { openDefault(it); return; }
      if (s.sel !== i) select(i);
      listEl.focus({ preventScroll: true });
    });
    r.addEventListener("dblclick", () => openDefault(it));
    return r;
  }

  function lazy(node, fn) {
    if (!("IntersectionObserver" in window)) { fn(); return; }
    if (!io) {
      io = new IntersectionObserver((ents) => ents.forEach((e) => {
        if (e.isIntersecting) { io.unobserve(e.target); const f = e.target._lazy; e.target._lazy = null; if (f) f(); }
      }), { root: null, rootMargin: "120px" });
    }
    node._lazy = fn;
    io.observe(node);
  }

  // ---- selection without rebuilding the list (review N2) -----------------------------------------------------
  // Only the row that loses and the row that gains the selection are rebuilt; thumbnails come from thumbCache.
  function rerow(i) {
    const s = st();
    if (!s || i == null || i < 0 || !s.items[i] || !listEl) return;
    const n = listEl.querySelector("#adp-row-" + i);
    if (n) n.replaceWith(row(s.items[i], i, s));
  }
  function select(i) {
    const s = st();
    if (!s) return;
    const old = s.sel;
    s.sel = i;
    s.commenting = null;
    rerow(old);
    rerow(i);
    if (i >= 0) listEl.setAttribute("aria-activedescendant", "adp-row-" + i); else listEl.removeAttribute("aria-activedescendant");
  }

  // ---- actions ---------------------------------------------------------------------------------------------
  async function setReadId(id, read) {
    let r;
    try { r = await window.api.libraryStateOp({ op: "read", id, value: !!read }); } catch (e) { r = null; }
    if (!r || !r.ok) { statusEl.textContent = (r && r.error) || "Could not save the read state."; return false; }
    applyRead(id, !!read);
    try { window.dispatchEvent(new CustomEvent("ad-doc-read", { detail: { id, read: !!read, from: "panel" } })); } catch (e) { /* optional */ }
    return true;
  }
  const setRead = (it, read) => setReadId(it.id, read);
  // A stack head's dot = its own state OR any older version unread (the pure part is L.applyReadToItems).
  function applyRead(id, read) {
    const s = st();
    if (!s) return;
    const changed = L.applyReadToItems(s.items, id, read);
    refreshBadge(); // the badge counts registered documents in main - also right when the id is not on a loaded page (N6)
    if (!changed) return;
    s.unread = Math.max(0, s.unread + (read ? -changed : changed));
    if (viewer) { paintViewerBar(); return; }
    // Rebuild only the rows that hold this id; a full render only when an expanded older version shows it.
    let full = false;
    s.items.forEach((h, i) => {
      const inOlder = (h.older || []).some((o) => o.id === id);
      if (h.id === id || inOlder) { if (inOlder && s.expanded[h.id]) full = true; else rerow(i); }
    });
    if (full) render();
  }
  function onReadEvent(ev) {
    const d = ev && ev.detail;
    if (!d || d.from === "panel" || typeof d.id !== "string") return;
    applyRead(d.id, !!d.read);
  }
  // Review S4: "Mark read" on a stacked row marks the whole document (head + every unread older version), so the dot
  // and the button really change; "Mark unread" marks the head only.
  async function toggleRead(it) {
    const read = !!it.unread;
    for (const id of L.idsForRead(it, read)) await setReadId(id, read);
  }

  function openDefault(it) { if (it.viewable) openHere(it); else openExt(it, it.openable ? "open" : "reveal"); }

  async function openExt(it, how) {
    let r;
    try { r = await window.api.agentDocsOpen(agentKey, it.id, how); } catch (e) { r = { ok: false }; }
    if (!r || !r.ok) { statusEl.textContent = (r && r.error) || "Could not open it."; return; }
    statusEl.textContent = how === "reveal" ? "Shown in its folder." : "Opened outside Agent Desktop.";
    if (how === "open" && it.unread) setRead(it, true);
  }

  // ---- the in-panel viewer (Open here) ---------------------------------------------------------------------
  // Same rules as the Library's viewer: the file URL comes from main by id; the viewer is shown BEFORE the
  // file loads (a PDF started in a hidden frame stays grey) and PDFs ask Chromium's viewer for 100%.
  async function openHere(it) {
    let r;
    try { r = await window.api.agentDocsOpen(agentKey, it.id, "view"); } catch (e) { r = { ok: false }; }
    if (!r || !r.ok) { statusEl.textContent = (r && r.error) || "Could not open it here."; return; }
    const s = st();
    s.scroll = listEl.scrollTop;
    closeViewer(false);
    const root = el("div", "adp-viewer");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Viewer: " + it.title);
    viewer = { root, item: it, bar: null, commentHost: null };
    const bar1 = el("div", "adp-vbar");
    const back = el("button", "adp-btn adp-back");
    back.type = "button";
    back.append(icon("back", 14), el("span", "", "Back to list"));
    back.title = "Back to the list (Esc)";
    back.addEventListener("click", () => closeViewer(true));
    const vt = el("div", "adp-vtitle", it.title);
    vt.dir = "auto";
    bar1.append(back, vt);
    const chip = L.statusChip(it.status);
    if (chip) bar1.appendChild(el("span", "adp-chip " + chip.cls, chip.text));
    const bar2 = el("div", "adp-vbar adp-vbar2");
    viewer.bar = bar2;
    const commentHost = el("div", "adp-vcomment");
    viewer.commentHost = commentHost;
    let content;
    if (r.type === "image") { content = el("img", "adp-vmedia"); content.alt = it.title; }
    else if (r.type === "video") { content = el("video", "adp-vmedia"); content.controls = true; }
    else {
      content = el("iframe", "adp-vframe");
      content.title = it.title;
      if (r.ext !== "pdf") content.setAttribute("sandbox", ""); // no scripts, no same-origin; the PDF viewer plugin needs no sandbox
    }
    const stage = el("div", "adp-vstage");
    stage.appendChild(content);
    root.append(bar1, bar2, commentHost, stage);
    listView.classList.add("hidden");
    panel.appendChild(root);
    paintViewerBar();
    layout();
    const target = r.ext === "pdf" ? r.url.replace(/#.*$/, "") + "#zoom=100&navpanes=0" /* no page-thumbnail sidebar in the narrow panel */ : r.url;
    requestAnimationFrame(() => { if (viewer && viewer.root === root) content.src = target; });
    back.focus();
    if (it.unread) setRead(it, true);
  }

  function paintViewerBar() {
    if (!viewer) return;
    const it = viewer.item;
    const bar = viewer.bar;
    bar.textContent = "";
    const mk = (label, fn, ic, title) => {
      const b = el("button", "adp-btn");
      b.type = "button";
      b.appendChild(el("span", "", label));
      if (ic) b.appendChild(icon(ic, 13));
      if (title) b.title = title;
      b.addEventListener("click", fn);
      bar.appendChild(b);
      return b;
    };
    if (it.openable) mk("Open externally", () => openExt(it, "open"), "ext", "Open with the default program");
    mk("Show in folder", () => openExt(it, "reveal"));
    mk(it.unread ? "Mark read" : "Mark unread", () => toggleRead(it));
    mk("Comment & send", () => {
      const host = viewer.commentHost;
      if (host.firstChild) { host.textContent = ""; return; }
      host.appendChild(commentBox(it, () => { host.textContent = ""; }));
    });
  }

  function closeViewer(restore) {
    if (!viewer) return;
    const f = viewer.root.querySelector("iframe, video");
    if (f) { try { f.src = "about:blank"; } catch (e) { /* ignore */ } }
    viewer.root.remove();
    viewer = null;
    if (listView) listView.classList.remove("hidden");
    layout();
    if (restore) {
      render();
      const s = st();
      if (s && s.sel >= 0) focusList(s.sel); else if (listEl) listEl.focus();
    }
  }

  // ---- Comment & send (to this agent, through the app's own send path) ---------------------------------------
  function startComment(it) {
    const s = st();
    if (s.sel < 0 || s.items[s.sel] !== it) { const i = s.items.indexOf(it); if (i >= 0) s.sel = i; }
    s.commenting = it.id;
    if (s.sel >= 0) { rerow(s.sel); listEl.setAttribute("aria-activedescendant", "adp-row-" + s.sel); } else render();
  }

  function commentBox(it, done) {
    const who = agentInfo.name || "the agent";
    const box = el("div", "adp-comment");
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("keydown", (e) => e.stopPropagation()); // typing here never drives the list
    const ta = el("textarea", "adp-comment-t");
    ta.rows = 3;
    ta.dir = "auto";
    ta.placeholder = "Write a comment for " + who + "...";
    ta.setAttribute("aria-label", "Comment for " + who + " about " + it.title);
    const row = el("div", "adp-comment-acts");
    const send = el("button", "adp-btn primary", "Send to " + who);
    send.type = "button";
    const cancel = el("button", "adp-btn", "Cancel");
    cancel.type = "button";
    const note = el("span", "adp-comment-note");
    note.setAttribute("role", "status");
    cancel.addEventListener("click", done);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send.click(); }
    });
    send.addEventListener("click", async () => {
      const text = L.commentText(it.title, it.path, ta.value);
      if (!text) { note.textContent = "Write something first."; return; }
      const bridge = window.libraryBridge;
      if (!bridge || !agentPath) { note.textContent = "Sending is not available here."; return; }
      send.disabled = true;
      note.textContent = "Sending...";
      let r;
      try { r = await bridge.send(agentPath, text); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
      send.disabled = false;
      if (!r || !r.ok) { note.textContent = "Not sent: " + ((r && r.error) || "unknown error"); return; }
      try {
        await window.api.libraryStateOp({ op: "history", id: it.id, record: { to: agentPath, toName: who, action: "comment", comment: L.cleanBody(ta.value).trim() } });
      } catch (e) { /* history is a nicety */ }
      statusEl.textContent = r.how === "queued" ? "Comment queued for " + who + " (it is busy)." : "Comment sent to " + who + ".";
      done();
    });
    row.append(send, cancel, note);
    box.append(ta, row);
    requestAnimationFrame(() => ta.focus());
    return box;
  }

  // ---- keyboard --------------------------------------------------------------------------------------------
  function focusList(i) {
    const s = st();
    if (!s || !s.items.length) return;
    if (i != null && i >= 0) select(Math.min(i, s.items.length - 1));
    listEl.focus({ preventScroll: true });
    const n = listEl.querySelector(".adp-row.sel");
    if (n) n.scrollIntoView({ block: "nearest" });
  }

  function onListKey(e) {
    const s = st();
    if (!s || !s.items.length) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key;
    if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(k)) {
      e.preventDefault();
      const start = s.sel < 0 ? (k === "ArrowUp" ? 0 : -1) : s.sel;
      const next = start < 0 ? 0 : L.moveSel(start, k, s.items.length);
      select(next);
      const n = listEl.querySelector(".adp-row.sel");
      if (n) n.scrollIntoView({ block: "nearest" });
      if (k === "End" && s.items.length < s.total) load(false);
      return;
    }
    const it = s.sel >= 0 ? s.items[s.sel] : null;
    if (!it) return;
    if (k === "Enter") { e.preventDefault(); if (e.shiftKey && it.openable) openExt(it, "open"); else openDefault(it); }
    else if (k.toLowerCase() === "u") { e.preventDefault(); toggleRead(it); }
    else if (k.toLowerCase() === "c") { e.preventDefault(); startComment(it); }
  }

  function onPanelKey(e) {
    if (e.key !== "Escape") return;
    if (e.target && e.target.closest && e.target.closest(".adp-comment")) return;
    e.preventDefault();
    e.stopPropagation();
    if (viewer) closeViewer(true);
    else setOpen(false, true);
  }

  // ---- entry point -----------------------------------------------------------------------------------------
  window.agentDocsPanel = {
    setAgent(p, info) {
      build();
      if (!panel) return;
      placeButton();
      const nextKey = (info && info.key) || null;
      if (viewer) closeViewer(false);
      const cur = st();
      if (cur && listEl) cur.scroll = listEl.scrollTop;
      agentPath = p || null;
      agentKey = nextKey;
      agentInfo = info || {};
      btn.classList.toggle("hidden", !agentKey);
      if (!agentKey) { apply(); return; }
      btnCount.classList.add("hidden");
      btnNew.classList.add("hidden");
      const mine = agentKey;
      // Prefs are one small file read once; until they arrive the panel stays as it was (closed on first start).
      loadPrefs().then(() => {
        if (mine !== agentKey) return;
        const s = st();
        apply();
        if (s.open && !s.loaded) load(true);
      });
      if (prefs) apply();
      refreshBadge();
    },
    // For tests and the sandbox driver.
    _state: () => ({ key: agentKey, s: st(), viewer: !!viewer }),
  };
})();
