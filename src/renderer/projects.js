// Projects view (Project Autopilot). Loaded on the first click of the Projects entry (projects-nav.js). Reads the ledger through the main process
// (window.api.projects); all text is set with textContent (agents write the project text). Rules and view models live in src/projects/projectsLogic.js.
// v1: you can read everything, answer a blocking question (Yes = take the default, No, or type an answer) and press Green light on a signed draft.
(function () {
  "use strict";
  const api = window.api && window.api.projects;
  if (!api) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const auto = (e) => { e.dir = "auto"; return e; };
  const NS = "http://www.w3.org/2000/svg";
  const svg = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k of Object.keys(attrs || {})) e.setAttribute(k, String(attrs[k])); if (text != null) e.textContent = text; return e; };

  const view = el("div"); view.id = "projects-view"; view.className = "hidden";
  const head = el("div", "pj-head"), body = el("div", "pj-body"), toast = el("div", "pj-toast hidden");
  toast.setAttribute("role", "status");
  view.append(head, body, toast);
  document.getElementById("main-panel").appendChild(view);

  const S = { list: null, detail: null, slug: null, err: "", live: false, lastAt: 0, busy: false, tile: null, toastTimer: null, drafts: {} };
  let open = false, navEl = null, off = null, pollT = null, tickT = null;

  // ---- loading ----
  function refresh() {
    const wanted = S.slug;
    const p = api.list().then((r) => {
      if (!open) return;
      if (!r || !r.ok) { S.err = (r && r.reason) || "Projects could not load."; S.list = null; S.live = false; }
      else { S.err = ""; S.list = r; S.live = true; S.lastAt = Date.now(); if (window.projectsNavCount) window.projectsNavCount(r.counts.red); }
    });
    const d = wanted ? api.detail(wanted).then((r) => {
      if (!open || S.slug !== wanted) return;
      if (r && r.ok) S.detail = r; else { S.detail = null; S.slug = null; }
    }) : Promise.resolve();
    return Promise.all([p, d]).then(render).catch(() => { S.live = false; S.err = "Projects could not load."; render(); });
  }
  const ago = () => { const s = Math.max(0, Math.round((Date.now() - S.lastAt) / 1000)); return s < 5 ? "just now" : s < 90 ? s + " s ago" : Math.round(s / 60) + " min ago"; };
  function say(t) { toast.textContent = t; toast.classList.remove("hidden"); clearTimeout(S.toastTimer); S.toastTimer = setTimeout(() => toast.classList.add("hidden"), 6000); }

  // ---- pieces ----
  function renderHeader() {
    head.textContent = "";
    head.append(el("h2", "pj-title", "Projects"));
    const dot = el("span", "pj-live " + (S.live ? "on" : "off"), S.live ? "● Live" : "○ Paused");
    dot.title = S.live ? "Updated " + ago() : "Not updating. Close and open Projects.";
    head.append(dot, el("span", "pj-ago", S.live ? "updated " + ago() : ""), el("span", "pj-sp"));
    const re = el("button", "pj-btn", "Refresh"); re.type = "button"; re.addEventListener("click", refresh); head.append(re);
  }
  function chipOf(c) { return el("span", "pj-chip " + (c.labelKind || c.light), c.label); }
  function renderBar(c) {
    const bar = el("div", "pj-bar"); bar.setAttribute("role", "img"); bar.setAttribute("aria-label", c.donePct + "% done" + (c.planPct ? ", plan " + c.planPct + "%" : ""));
    const f = el("div", "pj-bar-fill"); f.style.width = Math.min(100, c.donePct) + "%"; bar.append(f);
    if (c.planPct) { const m = el("div", "pj-bar-plan"); m.style.left = Math.min(99, c.planPct) + "%"; bar.append(m); }
    return bar;
  }
  function renderCard(c) {
    const b = el("button", "pj-card " + c.light); b.type = "button";
    const top = el("div", "pj-card-top");
    top.append(auto(el("span", "pj-name", c.name)), chipOf(c));
    if (c.questions) top.append(el("span", "pj-q-mark", c.questions + (c.questions === 1 ? " question for you" : " questions for you")));
    top.append(el("span", "pj-sp"), auto(el("span", "pj-owner", c.ownerShort || c.owner)));
    b.append(top, auto(el("div", "pj-reason", c.reason)), renderBar(c));
    const meta = el("div", "pj-meta");
    meta.append(el("span", "", c.donePct + "% " + c.milestoneNote));
    if (c.tokenPct != null) meta.append(el("span", "", "tokens " + c.tokenPct + "% of budget"));
    if (c.lastAge) meta.append(auto(el("span", "", "last activity " + c.lastAge + (c.lastText ? ": " + c.lastText : ""))));
    b.append(meta);
    b.addEventListener("click", () => { S.slug = c.slug; S.detail = null; S.tile = null; render(); refresh(); body.scrollTop = 0; });
    return b;
  }
  function renderEmpty() {
    const e = el("div", "pj-empty");
    e.append(el("p", "pj-empty-t", "No projects yet"), el("p", "pj-note", "When the COO starts a project with you, it shows up here with its plan, progress and the few things it needs from you."));
    return e;
  }
  function renderList() {
    const d = S.list, c = d.counts;
    const counts = el("div", "pj-counts");
    for (const [n, l, cls] of [[c.red, "Blocked", "red"], [c.amber, "Waiting or late", "amber"], [c.green, "Moving", "green"]]) {
      const x = el("div", "pj-count " + cls); x.append(el("b", "pj-n", String(n)), el("span", "pj-l", l)); counts.append(x);
    }
    body.append(counts);
    if (!d.projects.length) { body.append(renderEmpty()); return; }
    for (const p of d.projects) body.append(renderCard(p));
    if (c.finished) body.append(el("p", "pj-note", c.finished + " finished or cancelled (listed last)."));
  }
  function renderTile(p, key) {
    const t = p.numbers[key], b = el("button", "pj-tile"); b.type = "button"; b.setAttribute("aria-expanded", S.tile === key ? "true" : "false");
    b.append(el("b", "pj-n", t.value), el("span", "pj-l", t.label), t.sub ? el("span", "pj-tile-age", t.sub) : el("span"), el("span", "pj-tile-age", t.at ? "as of " + ageOf(t.at) : "no data yet"));
    b.addEventListener("click", () => { S.tile = S.tile === key ? null : key; render(); });
    return b;
  }
  function ageOf(iso) { const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 90 ? "just now" : s < 5400 ? Math.round(s / 60) + " min ago" : s < 129600 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; }
  function renderWhat(p) {
    const t = p.numbers[S.tile]; const ul = el("ul", "pj-what");
    if (!t.what.length) ul.append(el("li", "", t.empty));
    for (const w of t.what.slice(0, 200)) ul.append(auto(el("li", "", (w.done ? "✓ " : "○ ") + w.text)));
    return ul;
  }
  function renderChart(p) {
    const b = p.burnup, W = 640, H = 220, L = 36, R = 12, T = 12, B = 28;
    if (!b || !b.total) return el("p", "pj-note", "No plan items yet, so there is nothing to chart.");
    const t0 = b.start, t1 = Math.max(b.end, t0 + 86400000), x = (t) => L + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (W - L - R), y = (v) => T + (1 - v / b.total) * (H - T - B);
    const s = svg("svg", { viewBox: "0 0 " + W + " " + H, class: "pj-chart", role: "img", "aria-label": "Burn-up: " + b.done + " of " + b.total + " done, plan " + b.plannedNow });
    s.append(svg("line", { x1: L, y1: y(0), x2: W - R, y2: y(0), class: "pj-ax" }), svg("line", { x1: L, y1: T, x2: L, y2: y(0), class: "pj-ax" }));
    s.append(svg("text", { x: 4, y: T + 10 }, String(b.total)), svg("text", { x: 4, y: y(0) }, "0"));
    const poly = (pts) => pts.map((q) => x(q.t).toFixed(1) + "," + y(q.v).toFixed(1)).join(" ");
    s.append(svg("polyline", { points: poly(b.plan), class: "pj-plan" }), svg("polyline", { points: poly(b.actual), class: "pj-act" }));
    if (b.projection.length) s.append(svg("polyline", { points: poly(b.projection), class: "pj-proj" }));
    s.append(svg("text", { x: L, y: H - 8 }, new Date(t0).toLocaleDateString(undefined, { month: "short", day: "numeric" })));
    return s;
  }
  function renderBurn(p) {
    const sec = el("section", "pj-sec"), b = p.burnup;
    sec.append(el("h3", "pj-h", "Progress against plan"), renderChart(p));
    const lg = el("div", "pj-legend"); lg.append(el("span", "", "solid green: done"), el("span", "", "dashed grey: plan"), el("span", "", "dotted amber: projected, at the pace of the last " + b.paceWindowDays + " days"));
    sec.append(lg);
    const fin = b.state === "done" ? "Finished." : b.state === "projected" ? "Projected finish " + p.finishText + (p.planFinishText ? " (plan: " + p.planFinishText + ")" : "") + (b.late ? ", " + b.lateDays + (b.lateDays === 1 ? " day" : " days") + " late." : ".") : b.state === "empty" ? "" : "No pace yet, so no projected finish" + (p.planFinishText ? " (plan: " + p.planFinishText + ")." : ".");
    if (fin) sec.append(el("p", "", fin));
    return sec;
  }
  function renderMilestones(p) {
    const sec = el("section", "pj-sec"); sec.append(el("h3", "pj-h", "Milestones"));
    if (!p.milestones.length) sec.append(el("p", "pj-note", "No milestones yet."));
    for (const m of p.milestones) {
      const row = el("div", "pj-ms"), top = el("div", "pj-ms-top");
      const word = m.state === "done" ? "DONE" : m.state === "late" ? "LATE" : m.state === "active" ? "IN PROGRESS" : "NOT STARTED";
      top.append(auto(el("span", "pj-ms-t", m.id + " " + m.title)), el("span", "pj-chip " + (m.state === "done" ? "done" : m.state === "late" ? "late" : m.state === "active" ? "green" : "cancelled"), word), el("span", "pj-meta", m.done + " of " + m.total + " done (" + m.pct + "%)" + (m.planned ? ", planned " + m.planned : "")));
      row.append(top);
      const ul = el("ul", "pj-items");
      for (const i of m.items) { const li = auto(el("li", i.done ? "done" : "", (i.done ? "✓ " : "○ ") + (i.kind === "task" ? i.ref + " · " : "") + i.text + (i.done && i.by ? " (" + i.by + ")" : ""))); ul.append(li); }
      row.append(ul); sec.append(row);
    }
    return sec;
  }
  function renderQuestion(p, q) {
    const box = el("div", "pj-q" + (q.irreversible ? " irr" : ""));
    box.append(auto(el("div", "pj-q-t", q.text)));
    const meta = [q.askedBy ? "asked by " + q.askedBy : "", q.askedAge, q.default ? "default: " + q.default : "no default", q.deadlineText ? "by " + q.deadlineText : "", q.irreversible ? "cannot be undone, so no automatic default" : q.autoApplies ? "the default applies by itself at the deadline" : ""].filter(Boolean).join(" · ");
    box.append(auto(el("div", "pj-meta", meta)));
    const row = el("div", "pj-q-row"), input = el("input", "pj-input"); input.type = "text"; input.maxLength = 500; input.placeholder = "Or write your own answer"; input.dir = "auto"; input.setAttribute("aria-label", "Your answer");
    input.value = S.drafts[p.slug + q.id] || ""; input.addEventListener("input", () => { S.drafts[p.slug + q.id] = input.value; });
    const send = (text) => {
      if (!text.trim()) { say("Write an answer first."); return; }
      S.busy = true; render();
      api.answer(p.slug, q.id, text).then((r) => { S.busy = false; if (r && r.ok) { delete S.drafts[p.slug + q.id]; say("Answer sent."); } else say((r && r.reason) || "That did not work."); refresh(); }).catch(() => { S.busy = false; refresh(); });
    };
    const mk = (label, cls, fn, off) => { const b = el("button", "pj-btn " + cls, label); b.type = "button"; b.disabled = S.busy || !S.detail.canWrite || !!off; b.addEventListener("click", fn); return b; };
    row.append(mk("Yes" + (q.default ? ": use the default" : ""), "pj-primary", () => send(q.default ? "Yes - use the default: " + q.default : "Yes"), false), mk("No", "", () => send("No"), false), input, mk("Send", "", () => send(input.value), false));
    box.append(row); return box;
  }
  function renderDetail() {
    const p = S.detail && S.detail.project;
    const back = el("button", "pj-btn pj-back", "← All projects"); back.type = "button"; back.addEventListener("click", () => { S.slug = null; S.detail = null; S.tile = null; render(); });
    body.append(back);
    if (!p) { body.append(el("p", "pj-note", "Loading…")); return; }
    const hero = el("div", "pj-hero"), top = el("div", "pj-card-top");
    top.append(auto(el("h2", "pj-hero-name", p.name)), chipOf(p)); hero.append(top, auto(el("p", "pj-reason", p.reason)));
    hero.append(auto(el("p", "pj-meta", "Owner: " + p.owner + " · last activity " + (p.lastAge || "none") + (p.lastText ? ": " + p.lastText : ""))));
    body.append(hero);
    if (p.status === "draft") {
      const sec = el("section", "pj-sec"); sec.append(el("h3", "pj-h", "Waiting for your Green light"));
      sec.append(el("p", "", p.budget.signed ? "The budget (" + (p.budget.pct != null ? p.budget.pct + "% of the week" : "no figure") + ") was signed by " + p.budget.signedBy + "." : "The budget is not signed yet. System Optimization has to sign it before you can press Green light."));
      const gl = el("button", "pj-btn pj-primary", "Green light"); gl.type = "button"; gl.disabled = !p.canGreenLight || S.busy || !S.detail.canWrite;
      let armed = false;   // starting a project is attributed to Iddo: first click arms, second click confirms
      gl.addEventListener("click", () => { if (!armed) { armed = true; gl.textContent = "Press again to confirm Green light"; setTimeout(() => { armed = false; gl.textContent = "Green light"; }, 6000); return; } S.busy = true; render(); api.greenLight(p.slug).then((r) => { S.busy = false; say(r && r.ok ? "Green light given." : (r && r.reason) || "That did not work."); refresh(); }).catch(() => { S.busy = false; refresh(); }); });
      sec.append(gl);
      if (S.detail.intake) sec.append(el("h3", "pj-h", "The conversation so far"), auto(el("div", "pj-pre", S.detail.intake)));
      body.append(sec);
    }
    if (p.questions.length) { const sec = el("section", "pj-sec"); sec.append(el("h3", "pj-h", "Needs your answer")); for (const q of p.questions) sec.append(renderQuestion(p, q)); body.append(sec); }
    const tiles = el("div", "pj-tiles"); for (const k of ["done", "open", "tokens"]) tiles.append(renderTile(p, k)); body.append(tiles);
    if (S.tile && p.numbers[S.tile]) body.append(renderWhat(p));
    body.append(renderBurn(p), renderMilestones(p));
    const bl = el("section", "pj-sec"); bl.append(el("h3", "pj-h", "Blocked tasks"));
    if (!p.blockedTasks.length) bl.append(el("p", "pj-note", "Nothing is blocked."));
    for (const t of p.blockedTasks) bl.append(auto(el("p", "", t.id + " " + t.title + ": " + t.reason + " (needs " + (t.needs === "iddo" ? "you" : t.needs) + (t.sinceAge ? ", " + t.sinceAge : "") + ")")));
    body.append(bl);
    const rd = el("section", "pj-sec"); rd.append(el("h3", "pj-h", "Ready to start (" + p.readyTasks.length + ")"));
    if (!p.readyTasks.length) rd.append(el("p", "pj-note", "No task is ready right now."));
    const rl = el("ul", "pj-items"); for (const t of p.readyTasks) rl.append(auto(el("li", "", t.id + " · " + t.title))); rd.append(rl); body.append(rd);
    const sp = el("section", "pj-sec"); sp.append(el("h3", "pj-h", "Spend against budget"));
    sp.append(el("p", "", p.budgetPctWeek ? p.spentPctWeek + "% of the week used, budget " + p.budgetPctWeek + "% of the week (" + p.tokenPct + "% of budget)." : "No budget set. " + p.spentPctWeek + "% of the week used so far."));
    sp.append(el("p", "pj-note", p.budget.signed ? "Budget signed by " + p.budget.signedBy + "." : "Budget not signed."));
    body.append(sp);
    const rc = el("section", "pj-sec"); rc.append(el("h3", "pj-h", "Recent activity"));
    if (!p.recent.length) rc.append(el("p", "pj-note", "No events yet."));
    for (const e of p.recent) rc.append(auto(el("p", "pj-meta", e.age + " · " + e.agent + " · " + e.kind + ": " + e.text)));
    if (p.truncated) rc.append(el("p", "pj-note", "The event log is large; only its end was read."));
    body.append(rc);
  }

  function render() {
    renderHeader(); const keep = body.scrollTop; body.textContent = "";
    if (S.err) { body.append(el("p", "pj-note", S.err)); return; }
    if (!S.list) { body.append(el("p", "pj-note", "Loading…")); return; }
    if (S.list.empty) { body.append(renderEmpty()); return; }
    if (S.slug) renderDetail(); else renderList();
    body.scrollTop = keep;
  }

  const onKey = (e) => { if (e.key === "Escape" && open) { if (S.slug) { S.slug = null; S.detail = null; render(); } else close(); e.preventDefault(); } };
  function schedule() { pollT = setTimeout(() => { if (!open) return; if (!document.hidden) refresh(); schedule(); }, 30000); }   // safety net only; live updates come from the main process
  function tick() { tickT = setTimeout(() => { if (!open) return; const a = head.querySelector(".pj-ago"); if (a && S.live) a.textContent = "updated " + ago(); tick(); }, 5000); }
  function openView() {
    if (open) return;
    if (window.viewManager) window.viewManager.closeAll();
    open = true; document.body.classList.add("projects-open"); view.classList.remove("hidden");
    if (navEl) navEl.classList.add("active");
    document.addEventListener("keydown", onKey);
    off = api.onChanged(refresh); schedule(); tick();
    S.list = null; S.slug = null; S.detail = null; S.tile = null; render(); refresh();
  }
  function close() {
    if (!open) return;
    open = false; document.removeEventListener("keydown", onKey); if (off) off(); off = null; clearTimeout(pollT); clearTimeout(tickT);
    document.body.classList.remove("projects-open"); view.classList.add("hidden");
    if (navEl) navEl.classList.remove("active");
    S.list = null; S.detail = null; S.slug = null; head.textContent = ""; body.textContent = ""; toast.classList.add("hidden"); clearTimeout(S.toastTimer);
  }
  window.projectsView = { toggle(nav) { if (nav) navEl = nav; open ? close() : openView(); }, close, isOpen: () => open };
})();
