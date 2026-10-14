// My Health view (v1.81.0, stage 1). Loaded on first click of the My Health entry (health-nav.js), not at startup.
// Three screens: Today, Labs, Meds & supplements, plus Import file. textContent only; every number comes from the main process
// already formatted and compared (health/view-model.js). LIGHT: no timers, no polling, one read on open and after each action.
// PRIVACY: nothing here logs, sets document.title, copies to the clipboard or sends content anywhere but to the main process's own
// health-* handlers. The badge on the tile shows no number. Stage 1 sends nothing to any agent or model.
(function () {
  "use strict";
  const api = window.api && window.api.health;
  if (!api) return;

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const NS = "http://www.w3.org/2000/svg";
  const STATUS = {
    "outside-lab": ["Outside lab range", "bad"], "outside-optimal": ["Normal, outside optimal", "warn"], optimal: ["In optimal zone", "ok"],
    "in-range": ["In lab range", "ok"], "no-range": ["No range given", "none"],
  };
  // Five group tabs, sub-pages as pills (UI-UX v3 mockup, option A). "weekly" is not a tab: it opens from the Today card.
  const GROUPS = [["today", "Today", "Today", ["visual", "today"]], ["periodic", "Periodic", "Periodic", ["periodic"]], ["body", "Body", "Body", ["trends", "labs", "longevity"]], ["learn", "Learn", "Learn", ["insights", "evidence", "reading"]], ["do", "Do", "Do", ["routines", "nutrition", "experiments", "plan"]], ["meds", "Medicines", "Meds", ["meds", "interactions"]], ["painmap", "Body map", "Map", ["painmap"]]];
  const PAGE_LABEL = { visual: "Visual", periodic: "Periodic", today: "Imported data", trends: "Trends", labs: "Labs", longevity: "Longevity", insights: "Insights", evidence: "Evidence map", reading: "Reading list", routines: "Routines", nutrition: "Nutrition", experiments: "Experiments", plan: "Plan", meds: "Meds & supplements", interactions: "Interaction check", weekly: "Weekly review", painmap: "Body map" };
  const groupOf = (page) => { const g = GROUPS.find((x) => x[3].indexOf(page) >= 0); return g ? g[0] : "today"; };
  const lastIn = { today: "visual", periodic: "periodic", body: "trends", learn: "insights", do: "routines", meds: "meds", painmap: "painmap" };
  const MORE_TABS = ["nutrition", "routines", "longevity", "evidence", "interactions", "weekly", "reading"], AGENT_TABS = ["insights", "trends", "plan", "experiments"];
  const DIR = { up: "▲", down: "▼", flat: "=" };

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) { e.textContent = text; e.dir = "auto"; } return e; }   // dir=auto: Hebrew names next to English units read correctly
  function btn(label, cls, onClick) { const b = el("button", cls || "hl-btn", label); b.type = "button"; b.addEventListener("click", (ev) => { ev.preventDefault(); onClick(ev); }); return b; }
  function field(label, input, cls) { const w = el("label", "hl-field" + (cls ? " " + cls : "")); w.append(el("span", "hl-flabel", label), input); return w; }
  function input(type, ph, attrs) { const i = el("input", "hl-input"); i.type = type; if (ph) i.placeholder = ph; if (attrs) Object.keys(attrs).forEach((k) => i.setAttribute(k, attrs[k])); return i; }
  const dayText = (ts) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ts || ""); return m ? +m[3] + " " + MONTHS[+m[2] - 1] + (m[1] !== String(new Date().getFullYear()) ? " " + m[1] : "") : ""; };
  const todayText = (ts) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ts || ""); if (!m) return ""; const d = new Date(+m[1], +m[2] - 1, +m[3]); return WD[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()]; };
  const num = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 100) / 100));

  let snap = null, tab = "visual", busy = false, open = false, navEl = null;
  let showReading = false, showLabForm = false, showMedForm = false, showStopped = false, confirmStop = null;
  let toastTimer = null, dirty = false, choice = null;
  const openLabCharts = new Set();

  // ------------------------------------------------------------------ shell
  const view = el("div"); view.id = "health-view"; view.className = "hidden";
  const head = el("div", "hl-head");
  const title = el("b", "hl-title", "My Health");
  const dateEl = el("span", "hl-date");
  const chip = el("span", "hl-chip", "Data stays on this PC");
  const sp = el("span", "hl-sp");
  const importBtn = btn("Import file", "hl-btn pri", () => doImport("file"));
  const folderBtn = btn("Import folder", "hl-btn", () => doImport("folder"));
  head.append(title, dateEl, chip, sp, folderBtn, importBtn);
  const tabsEl = el("div", "hl-tabs"), subEl = el("div", "hl-subtabs");
  const body = el("div", "hl-body");
  const toast = el("div", "hl-toast hidden"); toast.setAttribute("role", "status"); toast.setAttribute("aria-live", "polite");
  view.append(head, tabsEl, subEl, body, toast);
  document.getElementById("main-panel").appendChild(view);

  function say(text) {
    toast.textContent = text; toast.classList.remove("hidden");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add("hidden"), 6000);
  }

  // ------------------------------------------------------------------ open / close
  const onDocClick = (e) => { if (e.target.closest(".argus-nav, .iris-nav, .memory-nav, #library-nav, .daily-nav, #agent-list .agent-item")) close(); };
  // Escape closes the view, but never silently throws away something you were typing (review UI finding).
  const onDocKey = (e) => {
    if (e.key !== "Escape" || e.target.closest("#health-view input, #health-view select, #health-view textarea")) return;
    if (dirty && !window.confirm("Close My Health? What you typed and did not save will be lost.")) return;
    close();
  };
  view.addEventListener("input", (e) => { if (e.target && e.target.type !== "checkbox") dirty = true; });
  function openView() {
    if (open) return;
    const b = document.body;
    if (b.classList.contains("argus-open")) document.querySelector("#argus-view .argus-close")?.click();
    if (b.classList.contains("iris-open")) document.querySelector("#iris-view .iris-close")?.click();
    if (b.classList.contains("daily-open")) document.querySelector(".daily-nav")?.click();
    if (b.classList.contains("memory-open")) { b.classList.remove("memory-open"); document.getElementById("memory-view")?.classList.add("hidden"); document.querySelector(".memory-nav")?.classList.remove("active"); }
    const lib = document.getElementById("library-view");
    if (lib && !lib.classList.contains("hidden")) document.querySelector("#library-view .library-close")?.click();
    open = true; dirty = false;
    b.classList.add("health-open");
    try { api.viewState(true); } catch (e) { /* older preload */ }
    view.classList.remove("hidden");
    if (navEl) navEl.classList.add("active");
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onDocKey);
    render();
    refresh();
  }
  function close() {
    if (!open) return;
    open = false; dirty = false; choice = null;
    try { api.viewState(false); } catch (e) { /* older preload */ }
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onDocKey);
    document.body.classList.remove("health-open");
    view.classList.add("hidden");
    if (navEl) navEl.classList.remove("active");
    snap = null; agentData = null; moreData = null; body.textContent = ""; if (window.healthVisual) window.healthVisual.clear(); if (window.healthBody) window.healthBody.clear();   // nothing from the store stays in the page while the view is closed
  }
  function toggle(nav) { if (nav) navEl = nav; open ? close() : openView(); }

  function refresh() {
    return api.load().then((s) => { snap = s; render(); }).catch(() => { snap = { ok: false, reason: "The health store could not be read." }; render(); });
  }

  function summarize(r) {
    if (!r || !r.ok) return (r && r.reason) || "Import failed.";
    if (r.canceled) return "";
    if (!r.files.length) return (r.reasons && r.reasons[0]) || "Nothing was imported.";
    return "Imported " + r.files.length + (r.files.length === 1 ? " file" : " files") + ": " + r.added + " new, " + r.updated + " updated" + (r.kept ? ", " + r.kept + " kept (fuller day already stored)" : "") + (r.skipped ? ", " + r.skipped + " rows skipped" : "") + (r.rejected ? ", " + r.rejected + " not accepted" : "") + (r.failed ? ", " + r.failed + " file(s) not readable" : "") + "." + (r.notes && r.notes.length ? " " + r.notes.join(" ") : "");
  }
  async function doImport(kind, chosen) {
    if (busy) return;
    busy = true; importBtn.disabled = true; folderBtn.disabled = true;
    try {
      const r = chosen ? await api.importChoose(chosen.token, chosen.order) : kind === "folder" ? await api.importFolder() : await api.importPick();
      if (r && r.ok && r.needsChoice) { choice = { token: r.token, reason: r.reason }; render(); }
      else { choice = null; const msg = summarize(r); if (msg) say(msg); await refresh(); }
    } catch (e) { say("Import failed."); }
    busy = false; importBtn.disabled = false; folderBtn.disabled = false;
  }
  // The dates in a file can be read two ways: the user decides (the choice is sent as a token, never as a file path).
  function choiceBanner() {
    const c = card("How are the dates written?"); c.appendChild(el("p", "hl-p", choice.reason));
    const row = el("div", "hl-actions"); row.append(btn("Day first (31/12 = 31 December)", "hl-btn pri", () => doImport(null, { token: choice.token, order: "dmy" })), btn("Month first (12/31 = 31 December)", "hl-btn", () => doImport(null, { token: choice.token, order: "mdy" })), btn("Cancel", "hl-btn", () => { choice = null; render(); }));
    c.appendChild(row); return c;
  }

  // ------------------------------------------------------------------ render
  function render() {
    dirty = false;
    dateEl.textContent = snap && snap.today ? todayText(snap.today) : "";
    const grp = groupOf(tab); lastIn[grp] = tab === "weekly" ? "visual" : tab;
    const go = (page) => { tab = page; confirmStop = null; if (AGENT_TABS.indexOf(page) >= 0) agentData = null; if (MORE_TABS.indexOf(page) >= 0) { moreData = null; moreOpts = {}; } render(); };
    tabsEl.textContent = ""; tabsEl.setAttribute("role", "tablist"); tabsEl.setAttribute("aria-label", "My Health sections"); body.setAttribute("role", "tabpanel");
    for (const [id, label, short] of GROUPS) {
      const t = el("button", "hl-tab" + (grp === id ? " on" : "")); t.type = "button";
      const f = el("span", "hl-tab-full", label), sh = el("span", "hl-tab-short", short); t.append(f, sh);
      t.addEventListener("click", () => go(lastIn[id])); t.setAttribute("role", "tab"); t.setAttribute("aria-selected", grp === id ? "true" : "false"); t.tabIndex = grp === id ? 0 : -1; t.dataset.tab = id;
      tabsEl.appendChild(t);
    }
    const pages = tab === "weekly" ? ["weekly"] : (GROUPS.find((x) => x[0] === grp) || GROUPS[0])[3];
    subEl.textContent = ""; subEl.hidden = pages.length < 2 && tab !== "weekly"; subEl.setAttribute("role", "tablist"); subEl.setAttribute("aria-label", "Pages in " + (GROUPS.find((x) => x[0] === grp) || [0, ""])[1]);
    pages.forEach((pg) => {
      const b = el("button", "hl-pill" + (tab === pg ? " on" : ""), PAGE_LABEL[pg]); b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", tab === pg ? "true" : "false"); b.tabIndex = tab === pg ? 0 : -1;
      b.addEventListener("click", () => go(pg)); subEl.appendChild(b);
    });
    if (tab === "weekly") subEl.appendChild(btn("Back to Today", "hl-pill", () => go("today")));
    const arrows = (list, cur, pick) => (e) => { if (["ArrowRight", "ArrowLeft", "Home", "End"].indexOf(e.key) < 0) return; const i = list.indexOf(cur), n = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length; e.preventDefault(); pick(list[n]); };
    tabsEl.onkeydown = arrows(GROUPS.map((x) => x[0]), grp, (g) => { go(lastIn[g]); const t0 = tabsEl.querySelector('[data-tab="' + g + '"]'); if (t0) t0.focus(); });
    subEl.onkeydown = arrows(pages, tab, (pg) => { go(pg); const k = pages.indexOf(pg); const b0 = subEl.children[k]; if (b0) b0.focus(); });
    body.textContent = "";
    if (tab === "painmap") { renderBody(); return; }   // v1.118.0: reads its own pain_log.jsonl through main, independent of the store snapshot
    if (tab === "visual" || tab === "periodic") { renderVisual(); return; }   // v1.114.0: reads its own single feed file, independent of the local store below
    if (!snap) { body.appendChild(el("div", "hl-muted hl-pad", "Reading your health folder...")); return; }
    if (!snap.ok) { body.appendChild(el("div", "hl-error hl-pad", snap.reason || "My Health is not available.")); importBtn.disabled = true; return; }
    importBtn.disabled = busy; folderBtn.disabled = busy;
    if (choice) body.appendChild(choiceBanner());
    if (tab === "today") renderToday(); else if (tab === "labs") renderLabs(); else if (tab === "meds") renderMeds(); else if (MORE_TABS.indexOf(tab) >= 0) renderMore(); else renderAgent();
  }

  // ---- v1.114.0 visual pane (Visual + Periodic pages): code fetched on first use; data comes from main (health-pane-feed), see health-visual.js
  let visualScript = null;
  function ensureVisual() {
    if (window.healthVisual) return Promise.resolve();
    if (!visualScript) visualScript = new Promise((res, rej) => {
      const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "styles-health-visual.css"; document.head.appendChild(link);
      const a = document.createElement("script"); a.src = "../health/pane-logic.js";
      a.onload = () => { const b = document.createElement("script"); b.src = "health-visual.js"; b.onload = () => (window.healthVisual ? res() : rej(new Error("no view"))); b.onerror = () => rej(new Error("load")); document.body.appendChild(b); };
      a.onerror = () => rej(new Error("load")); document.body.appendChild(a);
    }).catch((e) => { visualScript = null; throw e; });
    return visualScript;
  }
  function renderVisual() {
    if (window.healthVisual) { window.healthVisual.render(tab, body, UI); return; }
    body.appendChild(el("div", "hl-muted hl-pad", "Loading..."));
    ensureVisual().then(() => { if (open && (tab === "visual" || tab === "periodic")) render(); }).catch(() => { body.textContent = ""; body.appendChild(el("div", "hl-error hl-pad", "The visual pane could not be loaded.")); });
  }

  // ---- v1.118.0 Body map (pain-spot map + pain log): code, data tables and CSS fetched on first use; the file itself stays in main (health-body-load / -save)
  let bodyScript = null;
  function ensureBody() {
    if (window.healthBody) return Promise.resolve();
    if (!bodyScript) bodyScript = new Promise((res, rej) => {
      if (!document.querySelector('link[href="styles-health-body.css"]')) { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "styles-health-body.css"; document.head.appendChild(link); }
      const chain = ["../health/body-data.js", "../health/body-logic.js", "health-body.js"];
      const next = (i) => { if (i >= chain.length) return window.healthBody ? res() : rej(new Error("no view")); const a = document.createElement("script"); a.src = chain[i]; a.onload = () => next(i + 1); a.onerror = () => rej(new Error("load")); document.body.appendChild(a); };
      next(0);
    }).catch((e) => { bodyScript = null; throw e; });
    return bodyScript;
  }
  function renderBody() {
    if (window.healthBody) { window.healthBody.render(tab, body, UI); return; }
    body.appendChild(el("div", "hl-muted hl-pad", "Loading..."));
    ensureBody().then(() => { if (open && tab === "painmap") render(); }).catch(() => { body.textContent = ""; body.appendChild(el("div", "hl-error hl-pad", "The Body map could not be loaded.")); });
  }

  // ---- the agent-written screens: their code (health-agent.js) and their data are fetched only when one of these tabs opens
  let agentData = null, agentScript = null, agentLoading = false;
  function ensureAgentScript() {
    if (window.healthAgentUi) return Promise.resolve();
    if (!agentScript) agentScript = new Promise((res, rej) => { const s = document.createElement("script"); s.src = "health-agent.js"; s.onload = res; s.onerror = () => { agentScript = null; rej(new Error("load")); }; document.body.appendChild(s); });
    return agentScript;
  }
  function reloadAgent() { agentLoading = true; return Promise.all([ensureAgentScript(), api.agentLoad()]).then(([, d]) => { agentData = d; agentLoading = false; if (open) render(); }).catch(() => { agentLoading = false; agentData = { ok: false, reason: "These screens could not be read." }; if (open) render(); }); }
  function renderAgent() {
    if (!agentData) { body.appendChild(el("div", "hl-muted hl-pad", "Reading what the Health agent wrote...")); if (!agentLoading) reloadAgent(); return; }
    if (!agentData.ok) { body.appendChild(el("div", "hl-error hl-pad", agentData.reason || "Not available.")); return; }
    window.healthAgentUi.render(tab, body, agentData, UI);
  }

  // ---- stage 1b screens (Routines, Longevity, Evidence, Interactions, Weekly, Reading): code and data fetched when one of them opens
  let moreData = null, moreOpts = {}, moreScript = null, moreLoading = false;
  function ensureMoreScript() {
    if (window.healthMoreUi) return Promise.resolve();
    if (!moreScript) moreScript = new Promise((res, rej) => { const s = document.createElement("script"); s.src = "health-more.js"; s.onload = res; s.onerror = () => { moreScript = null; rej(new Error("load")); }; document.body.appendChild(s); });
    return moreScript;
  }
  function reloadMore(opts) {
    if (opts) moreOpts = Object.assign({}, moreOpts, opts);
    moreLoading = true; const want = tab;
    return Promise.all([ensureMoreScript(), api.extraLoad(Object.assign({ tab: want }, moreOpts))]).then(([, d]) => { moreLoading = false; if (tab === want) { moreData = d; if (open) render(); } })
      .catch(() => { moreLoading = false; moreData = { ok: false, reason: "This screen could not be read." }; if (open) render(); });
  }
  function renderMore() {
    if (!moreData) { body.appendChild(el("div", "hl-muted hl-pad", "Reading...")); if (!moreLoading) reloadMore(); return; }
    if (!moreData.ok) { body.appendChild(el("div", "hl-error hl-pad", moreData.reason || "Not available.")); return; }
    window.healthMoreUi.render(tab, body, moreData, UI);
  }
  const UI = { act: (p, okText) => p.then((r) => { if (r && r.ok) { if (okText) say(okText); } else say((r && r.reason) || "That did not work."); return r; }).catch(() => { say("That did not work."); }), reloadMore: (o) => reloadMore(o), tile: (t) => tileEl(t), go: (pg) => { tab = pg; if (AGENT_TABS.indexOf(pg) >= 0) agentData = null; if (MORE_TABS.indexOf(pg) >= 0) { moreData = null; moreOpts = {}; } render(); }, chart: (o) => window.healthChart.make(o), el, btn, input, card: (t, s) => card(t, s), empty: (w, st) => empty(w, st), say, dayText, num, rerender: () => render(), reloadAgent: () => reloadAgent() };

  function card(titleText, sub) { const c = el("section", "hl-card"); if (titleText) { const h = el("div", "hl-card-h"); h.appendChild(el("span", "hl-card-t", titleText)); if (sub) h.appendChild(el("span", "hl-tag", sub)); c.appendChild(h); } return c; }

  function empty(what, steps) {
    const c = card("Nothing here yet");
    c.appendChild(el("p", "hl-p", what));
    const ul = el("ul", "hl-ul"); steps.forEach((s) => ul.appendChild(el("li", "", s))); c.appendChild(ul);
    c.appendChild(el("p", "hl-muted hl-small", "Everything is stored in a folder on this PC. Nothing is sent anywhere, and no agent or model sees it."));
    return c;
  }

  // ---- Today
  function tileEl(t) {
    const c = el("div", "hl-tile");
    c.append(el("div", "hl-tile-t", t.title), el("div", "hl-tile-v", t.valueText));
    const sub = el("div", "hl-tile-s");
    if (t.previous) sub.textContent = "previous " + t.previous.valueText + " (" + dayText(t.previous.at) + ")" + (t.change ? ", " + (DIR[t.change.dir] || "") + " " + (t.change.dir === "flat" ? "no change" : t.change.text) : "");
    else sub.textContent = "first reading, no earlier value to compare";
    c.appendChild(sub);
    if (t.band) {
      const b = el("div", "hl-tile-s", "your normal " + t.band.text + " (last " + t.band.days + " days, " + t.band.n + " readings)" + (t.band.position && t.band.position !== "within" ? " · " + t.band.position + " it" : ""));
      c.appendChild(b);
    } else c.appendChild(el("div", "hl-tile-s hl-muted", "your normal: needs 5 readings in 30 days"));
    c.appendChild(window.healthChart.make({ series: t.series, unit: t.unit, dec: t.dec, kind: t.kind, w: 300, h: 140, title: t.title, band: t.band ? { low: t.band.low, high: t.band.high, label: "your normal" } : null }));
    c.appendChild(el("div", "hl-tile-src", t.source + " · " + dayText(t.at)));
    return c;
  }
  function renderToday() {
    const v = snap.todayView;
    const top = el("div", "hl-actions");
    top.appendChild(btn(showReading ? "Close" : "Add a reading", "hl-btn", () => { showReading = !showReading; render(); }));
    body.appendChild(top);
    if (snap.weekShort) {
      const w = snap.weekShort, c = card("Week " + w.week.slice(6) + " in short", w.sunday ? "this week so far" : "last week"); c.classList.add("hl-weekshort");
      const g = el("div", "hl-wk-tiles"); w.rows.forEach((r) => { const t = el("div", "hl-wk-tile"); t.append(el("div", "hl-tile-t", r.label), el("div", "hl-wk-v", r.cur), el("div", "hl-small hl-muted", r.prev ? "previous week " + r.prev : "no readings the week before")); g.appendChild(t); });
      w.routines.forEach((r) => { const t = el("div", "hl-wk-tile"); t.append(el("div", "hl-tile-t", r.title), el("div", "hl-wk-v", String(r.chunks)), el("div", "hl-small hl-muted", "of " + r.target + " chunks")); g.appendChild(t); });
      c.appendChild(g); const row = el("div", "hl-actions"); row.append(btn("Open weekly review", "hl-btn pri", () => { tab = "weekly"; moreData = null; moreOpts = {}; render(); }), btn("Open Insights", "hl-btn", () => { tab = "insights"; agentData = null; render(); }));
      c.appendChild(row); body.appendChild(c);
    }
    if (snap.nextChunk) { const h = card(null); h.classList.add("hl-hint"); const row = el("div", "hl-actions"); row.append(el("span", "", "Next chunk: " + snap.nextChunk.text + " (" + snap.nextChunk.done + " of " + snap.nextChunk.perDay + " done today)"), btn("Open Routines", "hl-btn sm", () => { tab = "routines"; moreData = null; render(); })); h.appendChild(row); body.appendChild(h); }
    if (showReading) body.appendChild(readingForm());
    if (!v.hasData) {
      body.appendChild(empty("Import your first file to fill this screen. In this order:", [
        "Scale: the Renpho CSV export (weight, body fat, muscle).",
        "Fitbit history: unzip the Google Takeout, then use Import folder (sleep, heart rate, steps).",
        "Phone: a CSV from a Health Connect exporter app (steps, heart rate, weight, blood pressure). Health Connect's own export is a zip with a database, which is not supported yet.",
        "Or add a single reading by hand with Add a reading.",
        "Lab results go on the Labs tab.",
      ]));
      return;
    }
    const grid = el("div", "hl-tiles"); v.tiles.forEach((t) => grid.appendChild(tileEl(t))); body.appendChild(grid);
    const lg = card(null);
    const row = el("div", "hl-legend");
    const sw = el("span", "hl-sw"); row.append(el("b", "", "Legend"), sw, el("span", "", "your own 30-day normal band (middle half of your readings)"), el("span", "", "▲ higher than previous"), el("span", "", "▼ lower"), el("span", "", "= no change"));
    lg.append(row, el("div", "hl-muted hl-small", "Every number shows its source and date. A band appears once there are at least 5 readings in the last 30 days."));
    body.appendChild(lg);
  }
  function readingForm() {
    const c = card("Add a reading");
    const sel = el("select", "hl-input");
    snap.metrics.forEach((m) => { const o = el("option", "", m.label + " (" + m.unit + ")"); o.value = m.id; sel.appendChild(o); });
    const val = input("text", "value", { inputmode: "decimal" }), date = input("date");
    const row = el("div", "hl-form");
    row.append(field("Reading", sel), field("Value", val), field("Date (optional)", date), btn("Save", "hl-btn pri", async () => {
      const r = await api.addReading({ metric: sel.value, value: val.value, date: date.value || undefined });
      if (r && r.ok) { say("Reading saved."); showReading = false; refresh(); } else say((r && r.reason) || "Not saved.");
    }));
    c.appendChild(row); return c;
  }

  // ---- Labs
  function bar(r) {
    const w = el("div", "hl-rbar"), sc = r.scale, rng = sc.max - sc.min || 1, pct = (x) => Math.max(0, Math.min(100, ((x - sc.min) / rng) * 100));
    const seg = (cls, lo, hi) => { const s = el("div", cls); const a = lo == null ? 0 : pct(lo), b = hi == null ? 100 : pct(hi); s.style.left = a + "%"; s.style.width = Math.max(1, b - a) + "%"; return s; };
    if (r.refLow != null || r.refHigh != null) w.appendChild(seg("hl-ref", r.refLow, r.refHigh));
    if (r.optLow != null || r.optHigh != null) w.appendChild(seg("hl-opt", r.optLow, r.optHigh));
    const d = el("div", "hl-rdot " + (STATUS[r.status] || STATUS["no-range"])[1]); d.style.left = pct(r.last.value) + "%"; w.appendChild(d);
    return w;
  }
  const rng = (lo, hi) => (lo != null && hi != null ? num(lo) + "-" + num(hi) : lo != null ? "above " + num(lo) : hi != null ? "below " + num(hi) : "");
  function renderLabs() {
    const top = el("div", "hl-actions");
    top.appendChild(btn(showLabForm ? "Close" : "Add result", "hl-btn", () => { showLabForm = !showLabForm; render(); }));
    body.appendChild(top);
    if (showLabForm) body.appendChild(labForm());
    const v = snap.labsView;
    if (!v.hasData) { body.appendChild(empty("No lab results yet.", ["Type results from your lab report with Add result (test, value, unit, the lab's range, date).", "Or import a lab-entries JSON file with Import file.", "Reading lab PDFs comes in a later stage; it will run only after names and ID numbers are removed."])); return; }
    const c = card("Your results");
    const list = el("div", "hl-labs");
    const hd = el("div", "hl-lab hl-lab-h"); ["MARKER", "YOUR VALUE AGAINST THE RANGES", "LAST 3 VALUES", "STATUS", "SOURCE"].forEach((t) => hd.appendChild(el("div", "", t))); list.appendChild(hd);
    for (const r of v.rows) {
      const row = el("div", "hl-lab");
      const m = el("div", "hl-lab-m"); m.append(el("b", "", r.test), el("span", "hl-muted hl-small", r.unit));
      const b = el("div", "hl-lab-b"); b.appendChild(bar(r));
      const parts = []; if (rng(r.refLow, r.refHigh)) parts.push("lab " + rng(r.refLow, r.refHigh)); if (rng(r.optLow, r.optHigh)) parts.push("optimal " + rng(r.optLow, r.optHigh));
      b.appendChild(el("div", "hl-muted hl-small", parts.join(" · ") || "no range given"));
      const h = el("div", "hl-lab-h3"); h.appendChild(el("b", "", r.history.map((x) => num(x.value)).join(" · ")));
      h.appendChild(el("div", "hl-muted hl-small", r.change ? (DIR[r.change.dir] || "") + " " + (r.change.dir === "flat" ? "no change" : (r.change.abs > 0 ? "+" : "") + num(r.change.abs)) + " since " + dayText(r.history[Math.max(0, r.history.length - 2)].ts) : "first result"));
      const st = STATUS[r.status] || STATUS["no-range"];
      const s = el("div", "hl-lab-s " + st[1]); s.append(el("b", "", st[0]), el("div", "", num(r.last.value) + " " + r.unit));
      const src = el("div", "hl-lab-src hl-muted hl-small", r.last.source + " · " + dayText(r.last.ts) + (r.last.fileId ? " · file " + r.last.fileId.slice(0, 8) : ""));
      const open = openLabCharts.has(r.key);
      const cb = btn(open ? "Hide chart" : "Chart", "hl-btn sm", () => { if (open) openLabCharts.delete(r.key); else openLabCharts.add(r.key); render(); }); cb.setAttribute("aria-expanded", open ? "true" : "false");
      src.appendChild(cb);
      row.append(m, b, h, s, src); list.appendChild(row);
      if (open) { const cr = el("div", "hl-lab-chart"); cr.appendChild(window.healthChart.make({ series: r.series, unit: r.unit, dec: 2, w: 600, h: 170, title: r.test + " results", band: r.refBand })); list.appendChild(cr); }
    }
    c.appendChild(list); body.appendChild(c);
    const lg = card(null);
    const lr = el("div", "hl-legend"); const a = el("span", "hl-sw hl-sw-ref"), o = el("span", "hl-sw hl-sw-opt");
    lr.append(el("b", "", "Legend"), a, el("span", "", "lab normal"), o, el("span", "", "optimal zone (optional, from your own entry)"), el("span", "hl-ok", "dot in optimal"), el("span", "hl-warn", "dot normal but outside optimal"), el("span", "hl-bad", "dot outside lab range"));
    lg.append(lr, el("div", "hl-muted hl-small", "Ranges are the ones you typed from the lab report. This screen shows your numbers; it does not interpret them."));
    body.appendChild(lg);
  }
  function labForm() {
    const c = card("Add a lab result");
    const f = { test: input("text", "e.g. LDL cholesterol"), value: input("text", "value", { inputmode: "decimal" }), unit: input("text", "mg/dL"),
      refLow: input("text", "lab low", { inputmode: "decimal" }), refHigh: input("text", "lab high", { inputmode: "decimal" }),
      optLow: input("text", "optimal low (optional)", { inputmode: "decimal" }), optHigh: input("text", "optimal high (optional)", { inputmode: "decimal" }), date: input("date") };
    const row = el("div", "hl-form");
    row.append(field("Test", f.test, "wide"), field("Value", f.value), field("Unit", f.unit), field("Lab range low", f.refLow), field("Lab range high", f.refHigh), field("Optimal low", f.optLow), field("Optimal high", f.optHigh), field("Date of the test", f.date),
      btn("Save", "hl-btn pri", async () => {
        const p = {}; Object.keys(f).forEach((k) => { p[k] = f[k].value; });
        const r = await api.addLab(p);
        if (r && r.ok) { say("Result saved."); showLabForm = false; refresh(); } else say((r && r.reason) || "Not saved.");
      }));
    c.appendChild(row); return c;
  }

  // ---- Meds
  function medRow(m, stopped) {
    const row = el("div", "hl-med");
    row.append(el("b", "hl-med-s", m.schedule || "Any time"), el("span", "hl-med-n", m.name), el("span", "hl-med-d", m.dose), el("span", "hl-muted hl-small hl-med-x", (m.medKind === "supplement" ? "" : m.medKind + " · ") + "started " + dayText(m.start) + (m.stop ? ", stopped " + dayText(m.stop) : "") + (m.note ? " · " + m.note : "")));
    if (!stopped) {
      if (confirmStop === m.id) { const w = el("span", "hl-med-a"); w.append(el("span", "hl-small", "Stop today?"), btn("Yes, stop", "hl-btn sm", async () => { const r = await api.stopMed(m.id); confirmStop = null; if (!(r && r.ok)) say((r && r.reason) || "Not stopped."); refresh(); }), btn("No", "hl-btn sm", () => { confirmStop = null; render(); })); row.appendChild(w); }
      else { const w = el("span", "hl-med-a"); w.appendChild(btn("Stop", "hl-btn sm", () => { confirmStop = m.id; render(); })); row.appendChild(w); }
    }
    return row;
  }
  function renderMeds() {
    const v = snap.medsView;
    const top = el("div", "hl-actions");
    top.appendChild(btn(showMedForm ? "Close" : "Add item", "hl-btn", () => { showMedForm = !showMedForm; render(); }));
    body.appendChild(top);
    if (showMedForm) body.appendChild(medForm());
    if (!v.hasData) { body.appendChild(empty("No medications or supplements yet.", ["Add each one with Add item: name, dose and when you take it.", "Prescriptions are listed with a clear label. Nothing here changes a dose or gives advice."])); return; }
    const c = card("Daily list");
    if (!v.active.length) c.appendChild(el("div", "hl-muted hl-pad", "Nothing active. Stopped items are below."));
    v.active.forEach((m) => c.appendChild(medRow(m, false)));
    body.appendChild(c);
    if (v.stopped.length) {
      const s = card(null);
      s.appendChild(btn((showStopped ? "Hide" : "Show") + " stopped (" + v.stopped.length + ")", "hl-btn sm", () => { showStopped = !showStopped; render(); }));
      if (showStopped) v.stopped.forEach((m) => s.appendChild(medRow(m, true)));
      body.appendChild(s);
    }
    body.appendChild(el("div", "hl-muted hl-small hl-pad", "No interaction check in this version. Ask your pharmacist or doctor."));
  }
  function medForm() {
    const c = card("Add a medication or supplement");
    const name = input("text", "name"), dose = input("text", "e.g. 2,000 IU"), start = input("date");
    const sched = el("select", "hl-input"); ["Morning", "Noon", "Afternoon", "Evening", "Bedtime", "As needed"].forEach((s) => { const o = el("option", "", s); o.value = s; sched.appendChild(o); });
    const kind = el("select", "hl-input"); [["supplement", "Supplement"], ["med", "Medication"], ["prescription", "Prescription"]].forEach(([v, l]) => { const o = el("option", "", l); o.value = v; kind.appendChild(o); });
    const row = el("div", "hl-form");
    row.append(field("Name", name, "wide"), field("Dose", dose), field("When", sched), field("Type", kind), field("Started", start),
      btn("Save", "hl-btn pri", async () => {
        const r = await api.addMed({ name: name.value, dose: dose.value, schedule: sched.value, medKind: kind.value, start: start.value || undefined });
        if (r && r.ok) { say("Saved."); showMedForm = false; refresh(); } else say((r && r.reason) || "Not saved.");
      }));
    c.appendChild(row); return c;
  }

  window.healthView = { toggle, open: () => openView(), close, _state: () => ({ open, tab }), setTab: (t) => { tab = t; if (open) render(); } };
})();
