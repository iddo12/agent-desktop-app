// Setup panel (v1.121.0), following UI-UX's spec (setup_panel_spec_2026-10-14): one Setup tile, grouped rows, four states
// (symbol + word), one button per row, in-place expansion with the best folder preselected, a first-run card.
// All paths come from main (suggestions, folder picker); this file never builds a path. textContent only, no innerHTML, no timers.
// All words live in setup-strings.js (English + Hebrew). Styles: styles-setup.css, scoped under #setup-panel.
(function () {
  "use strict";
  const api = window.api && window.api.config;
  const nav = document.getElementById("setup-nav");
  const mainPanel = document.getElementById("main-panel");
  const SS = window.SetupStrings;
  if (!api || !nav || !mainPanel || !SS) return;

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  let code = "en";
  const T = (k) => { const v = SS.pick(code)[k]; return v !== undefined ? v : SS.lang.en[k]; };
  const errText = (r) => { const m = SS.pick(code).errors || {}; const e = SS.lang.en.errors; return (m[r && r.error] || e[r && r.error] || m.generic || e.generic); };
  const chip = (path) => { const c = el("code", "setup-chip-path", path); c.setAttribute("dir", "ltr"); return c; };

  let view = null, head = null, bodyEl = null, msgEl = null, open = false, data = null, openRow = null;
  const GROUP_ORDER = ["daily", "private", "computer", "connections", "advanced"];

  function say(text, bad, pathNode) {
    if (!msgEl) return;
    msgEl.textContent = text || ""; msgEl.className = "setup-msg" + (bad ? " setup-bad" : text ? " setup-good" : "");
    if (pathNode) { msgEl.appendChild(document.createTextNode(" ")); msgEl.appendChild(pathNode); }
  }

  function detectLang(flags) {
    const f = flags && flags.setupLang;
    if (f && SS.lang[f]) return f;
    try { if (/^he\b/i.test(navigator.language || "")) return "he"; } catch (e) { /* default English */ }
    return "en";
  }
  function applyDir() { if (view) { view.setAttribute("dir", SS.pick(code).dir); view.setAttribute("lang", code); } }

  function build() {
    view = el("div"); view.id = "setup-panel"; view.className = "hidden";
    head = el("div", "setup-head");
    bodyEl = el("div", "setup-body");
    msgEl = el("div", "setup-msg"); msgEl.setAttribute("role", "status");
    view.append(head, msgEl, bodyEl);
    mainPanel.appendChild(view);
    view.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && openRow) { const b = openRow.querySelector(".setup-act"); closeRow(); if (b) b.focus(); ev.stopPropagation(); }
    });
  }

  function renderHead() {
    head.textContent = "";
    head.append(el("h2", "setup-title", T("title")));
    const copy = el("button", "setup-btn setup-copy", T("copyBtn")); copy.type = "button";
    copy.addEventListener("click", async () => {
      try { const r = await api.agentInstructions(); if (!r || !r.ok) return say(T("copyFail"), true); await navigator.clipboard.writeText(r.text); say(T("copied")); }
      catch (e) { say(T("copyFail"), true); }
    });
    const close = el("button", "setup-btn", T("close")); close.type = "button"; close.addEventListener("click", closeView);
    const report = el("button", "setup-btn setup-report", (window.BugReportStrings && window.BugReportStrings.pick(code).button) || "Report a problem"); report.type = "button";
    report.addEventListener("click", () => { try { if (window.BugReport) window.BugReport.open(code); } catch (e) { say(T("copyFail"), true); } });
    head.append(copy, report, close);
  }

  async function refresh() {
    const r = await api.getAll();
    if (!r || !r.ok) { say(T("errors").generic, true); return; }
    data = r;
    applyDir(); renderHead(); renderBody(); updateBadge();
  }

  function updateBadge() {
    const b = nav.querySelector(".setup-nav-badge"); if (!b || !data) return;
    const n = data.features.filter((f) => f.state === "needs-attention").length;
    b.textContent = String(n); b.classList.toggle("hidden", n === 0);
    nav.setAttribute("aria-label", n ? T("title") + " (" + n + ")" : T("title"));
  }

  function renderBody() {
    bodyEl.textContent = "";
    openRow = null;
    if (data.welcome && !data.dismissedWelcome) bodyEl.appendChild(renderWelcome());
    bodyEl.appendChild(el("p", "setup-text", T("intro")));
    const where = el("div", "setup-where"); where.append(document.createTextNode(T("settingsFile")), chip(data.configPath || "-")); bodyEl.appendChild(where);
    // workspace card
    const wsGroup = el("section", "setup-group"); wsGroup.appendChild(el("h3", "setup-group-h", T("groups").core));
    wsGroup.appendChild(renderRow(Object.assign({}, data.workspace, { _ws: true })));
    bodyEl.appendChild(wsGroup);
    for (const g of GROUP_ORDER) {
      const items = data.features.filter((f) => f.group === g);
      if (!items.length) continue;
      items.sort((a, b) => (b.state === "needs-attention") - (a.state === "needs-attention"));
      const sec = el("section", "setup-group"); sec.appendChild(el("h3", "setup-group-h", T("groups")[g]));
      for (const f of items) sec.appendChild(renderRow(f));
      bodyEl.appendChild(sec);
    }
  }

  // ---- one row ----
  function featText(f) { return f._ws ? [ "", T("groups").core, f.help, "", "" ] : SS.feature(code, f.id); }
  function renderRow(f) {
    const ft = featText(f);
    const row = el("div", "setup-row setup-st-" + f.state); row.dataset.feature = f.id;
    const top = el("div", "setup-row-top");
    const helpBtn = el("button", "setup-help", T("btnHelp")); helpBtn.type = "button"; helpBtn.setAttribute("aria-label", T("btnHelp") + " " + ft[1]); helpBtn.setAttribute("aria-expanded", "false");
    const ico = el("span", "setup-ico", ft[0]); ico.setAttribute("aria-hidden", "true");
    const nameWrap = el("div", "setup-namewrap");
    const title = f.id === "fleet" && f.title && f.title !== "Shared fleet" ? f.title : ft[1];
    const name = el("div", "setup-name", title); name.setAttribute("dir", "auto");
    const what = el("div", "setup-what", ft[2]); what.setAttribute("dir", "auto");
    nameWrap.append(name, what);
    if (f.group === "private") nameWrap.appendChild(el("div", "setup-private", T("privateNote")));
    const pill = el("span", "setup-pill setup-" + f.state, T("states")[f.state] || f.state);
    top.append(helpBtn, ico, nameWrap, pill);
    if (!f.wired && !f._ws) top.appendChild(el("span", "setup-asis", T("asIs")));
    const noSteps = !f.steps.length;
    let act = null;
    if (f.state === "ready") { act = el("button", "setup-act setup-link", T("btnChange")); }
    else if (f.state === "off") { act = el("button", "setup-act setup-btn", T("btnTurnOn")); }
    else if (f.state === "needs-attention") { act = el("button", "setup-act setup-btn setup-pri", T("btnFix")); }
    else { act = el("button", "setup-act setup-btn setup-pri", noSteps ? T("btnTurnOn") : T("btnSetup")); }
    act.type = "button";
    act.addEventListener("click", () => {
      if (f.state === "off" || (noSteps && f.state !== "ready")) return setEnabled(f, true);
      if (openRow === row) { closeRow(); return; }
      openForm(row, f, act);
    });
    top.appendChild(act);
    row.appendChild(top);
    if ((f.state === "needs-setup" || f.state === "needs-attention") && f.reason && f.state === "needs-attention") row.appendChild(el("div", "setup-reason", f.reason));
    const drawer = el("div", "setup-drawer hidden");
    drawer.append(el("p", "setup-text", f.help), el("p", "setup-text", T("needs") + ft[3]), el("p", "setup-text", T("why") + ft[4]));
    const cp = el("button", "setup-link", T("helpCopy")); cp.type = "button";
    cp.addEventListener("click", async () => {
      try { const r = await api.agentInstructions(f._ws ? "workspace" : f.id); if (r && r.ok) { await navigator.clipboard.writeText(r.text); say(T("copied")); } else say(T("copyFail"), true); } catch (e) { say(T("copyFail"), true); }
    });
    drawer.appendChild(cp);
    helpBtn.addEventListener("click", () => { const h = drawer.classList.toggle("hidden"); helpBtn.setAttribute("aria-expanded", h ? "false" : "true"); });
    row.appendChild(drawer);
    return row;
  }

  function closeRow() { if (openRow) { const f = openRow.querySelector(".setup-form"); if (f) f.remove(); openRow = null; } }

  async function setEnabled(f, on) {
    if (on && f.kind === "consent") { // network listener: the confirmation dialog is shown by the app itself (main process)
      const c = await api.consent(f.id);
      if (!c || !c.ok) return say(errText(c), true);
      if (c.declined) return say("");
      say(SS.feature(code, f.id)[1] + T("turnedOn")); await refresh(); return;
    }
    const r = await api.setFeature(f.id, undefined, on, false);
    if (!r || !r.ok) return say(errText(r), true);
    say(SS.feature(code, f.id)[1] + (on ? T("turnedOn") : T("turnedOff")));
    await refresh();
  }

  // ---- in-place expansion ----
  function openForm(row, f, actBtn) {
    closeRow();
    openRow = row;
    const form = el("div", "setup-form");
    const fields = {};
    for (const s of f.steps) {
      const line = el("fieldset", "setup-step");
      line.appendChild(el("legend", "setup-q", s.label + (s.optional ? " (optional)" : "")));
      line.appendChild(el("div", "setup-hint", s.help));
      if (s.kind === "folder" || s.kind === "file") {
        const sugg = f.suggestions.filter((x) => x.key === s.key);
        const grp = el("div", "setup-radios"); grp.setAttribute("role", "radiogroup");
        const cur = { path: null, isNew: false };
        const addOpt = (path, tag, exists, checked) => {
          const lab = el("label", "setup-opt");
          const rd = el("input"); rd.type = "radio"; rd.name = "su-" + f.id + "-" + s.key; rd.value = path; rd.checked = checked;
          rd.addEventListener("change", () => { cur.path = path; cur.isNew = !exists; note(); });
          lab.append(rd, chip(path), el("span", "setup-tag", tag === "detected" ? T("tagDetected") : T("tagNew")));
          grp.appendChild(lab);
          if (checked) { cur.path = path; cur.isNew = !exists; }
          return rd;
        };
        sugg.forEach((x, i) => addOpt(x.path, x.tag, x.exists, i === 0));
        const pick = el("button", "setup-btn setup-small", T("btnChoose")); pick.type = "button";
        pick.addEventListener("click", async () => { const r = await api.pickFolder(f.id, s.key); if (r && r.ok && r.path) { const rd = addOpt(r.path, "detected", true, true); rd.checked = true; cur.path = r.path; cur.isNew = false; note(); } });
        line.append(grp, pick);
        if (!sugg.length) line.appendChild(el("div", "setup-hint", T("workspaceFirst")));
        fields[s.key] = { get: () => cur.path, s, cur };
      } else if (s.kind === "choice") {
        const sel = el("select", "setup-input"); sel.appendChild(el("option", "", ""));
        for (const c of s.choices || []) { const o = el("option", "", c); o.value = c; sel.appendChild(o); }
        sel.value = s.value || ""; line.appendChild(sel);
        fields[s.key] = { get: () => sel.value || null, s, cur: {} };
      } else {
        const inp = el("input", "setup-input"); inp.type = "text"; inp.value = s.value || ""; inp.setAttribute("dir", "auto"); line.appendChild(inp);
        fields[s.key] = { get: () => inp.value.trim() || null, s, cur: {} };
      }
      form.appendChild(line);
    }
    const noteEl = el("div", "setup-note");
    const errEl = el("div", "setup-errbox hidden"); errEl.setAttribute("role", "alert");
    function note() {
      noteEl.textContent = "";
      for (const k of Object.keys(fields)) { const c = fields[k].cur; if (c && c.path) { noteEl.append(document.createTextNode((c.isNew ? T("willCreate") : T("willUse"))), chip(c.path), document.createElement("br")); } }
      primary.textContent = Object.keys(fields).some((k) => fields[k].cur && fields[k].cur.isNew) ? T("btnCreate") : T("btnSave");
    }
    const primary = el("button", "setup-btn setup-pri", T("btnSave")); primary.type = "button";
    const cancel = el("button", "setup-btn", T("btnCancel")); cancel.type = "button";
    cancel.addEventListener("click", () => { closeRow(); actBtn.focus(); });
    primary.addEventListener("click", async () => {
      errEl.classList.add("hidden");
      const values = {};
      for (const k of Object.keys(fields)) { const v = fields[k].get(); if (v) values[k] = v; }
      const missing = f.steps.filter((s) => !s.optional && !values[s.key]);
      if (missing.length) { errEl.textContent = T("fill") + missing.map((s) => s.label).join(", "); errEl.classList.remove("hidden"); return; }
      const mk = await api.createFolders(f._ws ? "workspace" : f.id, values);
      if (!mk || !mk.ok) { errEl.textContent = errText(mk); errEl.classList.remove("hidden"); return; }
      const r = await api.setFeature(f._ws ? "workspace" : f.id, values, true, false);
      if (!r || !r.ok) { errEl.textContent = errText(r); if (r && r.key && values[r.key]) errEl.appendChild(chip(values[r.key])); errEl.classList.remove("hidden"); return; }
      const made = mk.created && mk.created.length ? T("createdN").replace("%n", String(mk.created.length)) : "";
      await refresh();
      say(T("saved") + made);
      const again = bodyEl.querySelector('.setup-row[data-feature="' + (f._ws ? "workspace" : f.id) + '"] .setup-act'); if (again) again.focus();
    });
    form.append(noteEl, errEl);
    const bar = el("div", "setup-actions"); bar.append(primary, cancel); form.appendChild(bar);
    row.appendChild(form);
    note();
    primary.focus();
  }

  // ---- first run: one card, three choices, one button ----
  function renderWelcome() {
    const card = el("section", "setup-welcome");
    const W = () => SS.pick(code).welcome || SS.lang.en.welcome;
    card.appendChild(el("h3", "setup-welcome-t", W().title));
    card.appendChild(el("p", "setup-text", W().sub));
    const q1 = el("div", "setup-q", W().qLang); const langs = el("div", "setup-langs"); langs.setAttribute("role", "group");
    for (const c of Object.keys(SS.langNames)) {
      const b = el("button", "setup-btn setup-lang" + (c === code ? " setup-sel" : ""), SS.langNames[c]); b.type = "button"; b.setAttribute("aria-pressed", c === code ? "true" : "false");
      b.addEventListener("click", async () => { code = c; try { window.api.setUiFlag("setupLang", c); } catch (e) { /* keeps for this session */ } await refresh(); });
      langs.appendChild(b);
    }
    const q2 = el("div", "setup-q", W().qFolder);
    const wsInput = el("input", "setup-input"); wsInput.type = "text"; wsInput.setAttribute("dir", "ltr"); wsInput.value = data.workspace.suggestions.length ? data.workspace.suggestions[0].path : (data.workspace.steps[0] && data.workspace.steps[0].suggestion) || "";
    const pick = el("button", "setup-btn setup-small", T("btnChoose")); pick.type = "button";
    pick.addEventListener("click", async () => { const r = await api.pickFolder("workspace", "workspaceRoot"); if (r && r.ok && r.path) wsInput.value = r.path; });
    const q3 = el("div", "setup-q", W().qStarters); const starters = el("div", "setup-starters");
    const boxes = {};
    for (const id of SS.STARTERS) {
      const lab = el("label", "setup-opt"); const cb = el("input"); cb.type = "checkbox"; cb.checked = true; boxes[id] = cb;
      lab.append(cb, el("span", "", SS.feature(code, id)[0] + " " + SS.feature(code, id)[1])); starters.appendChild(lab);
    }
    const start = el("button", "setup-btn setup-pri", W().start); start.type = "button";
    start.addEventListener("click", async () => {
      const ws = wsInput.value.trim();
      const mk = await api.createFolders("workspace", { workspaceRoot: ws });
      if (!mk || !mk.ok) return say(errText(mk), true, ws ? chip(ws) : null);
      const r = await api.setFeature("workspace", { workspaceRoot: ws }, true, false);
      if (!r || !r.ok) return say(errText(r), true, ws ? chip(ws) : null);
      let d = await api.getAll();
      for (const id of SS.STARTERS) {
        if (!boxes[id].checked || !d || !d.ok) continue;
        const f = d.features.find((x) => x.id === id); if (!f) continue;
        const values = {};
        for (const s of f.steps) { const sg = f.suggestions.find((x) => x.key === s.key && (s.kind === "folder" || x.exists)); if (sg) values[s.key] = sg.path; }
        await api.createFolders(id, values);
        await api.setFeature(id, values, true, false);
      }
      await refresh();
      say(W().later);
    });
    card.append(q1, langs, q2, wsInput, pick, el("div", "setup-hint", W().qFolderHelp), q3, starters, start);
    return card;
  }

  async function openView() {
    if (!view) build();
    open = true; document.body.classList.add("setup-open"); view.classList.remove("hidden"); nav.classList.add("active");
    say("");
    await refresh();
  }
  function closeView() { open = false; closeRow(); document.body.classList.remove("setup-open"); if (view) view.classList.add("hidden"); nav.classList.remove("active"); }

  window.setupView = { toggle() { open ? closeView() : openView(); }, close: closeView, open: openView };
  nav.addEventListener("click", () => window.setupView.toggle());

  // First run: no settings file, nothing detected, not a test instance -> open the welcome. Never on a configured computer.
  // The badge for "needs attention" is filled from the same state, once, at start (no polling).
  // Read after the first paint, when the page is idle: the main process may have to look through PATH the first time it is asked.
  function startRead() {
    Promise.all([api.getAll(), window.api.getUiFlags ? window.api.getUiFlags() : {}]).then(([r, flags]) => {
      code = detectLang(flags);
      if (r && r.ok) { data = r; updateBadge(); if (r.welcome) openView(); }
    }).catch(() => { /* the panel is still reachable from the sidebar */ });
  }
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(startRead, { timeout: 2000 }); else startRead();
})();
