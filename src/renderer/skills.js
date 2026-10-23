// Skills & Plugins (v1.139.0): the third tab inside My Research ("Findings | My Recommendations | Skills & Plugins"). Loaded on first use by
// research.js (window.skillsView.mount(host)), never at startup. Shows, in plain words, what the weekly Skills & Plugins watch will look at and what
// it found: (1) This week - who researches, why, when it runs next; (2) Found - every item of the newest week grouped by agent, best score first,
// with the owner's answer from ARGUS when there is one; (3) Where we look - the list of places, read-only; (4) Already adopted - pinned copies.
// READ-ONLY: this tab writes nothing. Answers (Install it / Park / Don't install / Ask a question) stay in ARGUS > Ideas; the button here only
// opens ARGUS. Every number is a button that opens or jumps to what it counts.
// PRIVACY/LIGHT: textContent only, one load on open (and on Refresh / a week change), no timers, nothing kept once the tab closes; the renderer
// sends only a week name. Links open through research-open (http/https only, checked in main). Look: styles-skills.css (tokens --rs-*, prefix sk-).
(function () {
  "use strict";
  const api = window.api && window.api.research;
  if (!api || !api.skillsLoad) return;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function auto(e) { e.setAttribute("dir", "auto"); return e; }
  function btn(label, cls, onClick, title) { const b = el("button", cls || "sk-btn", label); b.type = "button"; if (title) b.title = title; b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); onClick(ev); }); return b; }
  const norm = (v) => String(v || "").trim().toLowerCase();
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

  const USE = { use_directly: ["Use it as it is", "The agent thinks we can use this one directly, after Security checks it."], borrow_idea: ["Borrow the idea", "Not worth installing; the agent suggests copying the idea into our own tools."], skip: ["Skip it", "Looked at and judged not worth it."] };
  const VERDICT = { approved: "Install it", parked: "Parked", rejected: "Don't install" };
  const SCORE_HELP = "Score out of 10, given by the agent that found it: 10 = must-have, 7 = pretty useful, 5 = meh, 1 = not needed.";

  function fmtDay(v) {
    const d = typeof v === "number" ? new Date(v) : /^\d{4}-\d{2}-\d{2}/.test(String(v || "")) ? new Date(String(v).slice(0, 10) + "T12:00:00") : null;
    return d && !isNaN(d) ? d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
  }
  function fmtWhen(ms) {
    const d = new Date(ms);
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(new Date().setHours(0, 0, 0, 0))) / 86400000);
    const rel = days <= 0 ? "today" : days === 1 ? "tomorrow" : "in " + days + " days";
    return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" }) + ", about " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + " (" + rel + ")";
  }

  const S = { data: null, week: "", closedAgents: new Set(), allSources: false, loading: false };
  let host = null, bodyEl = null;

  function jump(id) { const t = bodyEl && bodyEl.querySelector('[data-sk="' + id + '"]'); if (t) { t.scrollIntoView({ block: "start" }); const h = t.querySelector("h2, h3"); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } } }
  function numBtn(n, label, sub, onClick, title) {
    const b = btn("", "sk-num", onClick, title);
    b.append(el("span", "sk-num-n", String(n)), el("span", "sk-num-l", label));
    if (sub) b.appendChild(el("span", "sk-num-s", sub));
    return b;
  }
  function section(id, title, sub) {
    const s = el("section", "sk-sec"); s.dataset.sk = id;
    const h = el("div", "sk-sec-h"); h.appendChild(el("h2", "sk-sec-t", title)); if (sub) h.appendChild(el("span", "sk-sec-s", sub));
    s.appendChild(h);
    return s;
  }
  function openArgus() { const n = document.querySelector(".argus-nav"); if (n) n.click(); }
  function link(text, url, cls) {
    if (!url) return auto(el("span", cls || "", text));
    const a = btn(text, "sk-link " + (cls || ""), () => api.openLink(url).catch(() => {}), "Open " + url + " in your browser");
    auto(a);
    return a;
  }

  // ---- (1) this week
  function renderThisWeek(d) {
    const r = d.rotation || {};
    const s = section("week", "This week: who looks for new skills and plugins");
    if (!r.agents) { s.appendChild(el("p", "sk-note", r.missing ? "The rotation list (skills_plugins_rotation.json) is not there yet, so no agents are set for the watch." : "The rotation list could not be read.")); return s; }
    const found = new Set((d.agents || []).filter((a) => d.week === r.week).map((a) => norm(a.agent)));
    s.appendChild(el("p", "sk-lead", plural(r.agents.length, "agent looks", "agents look") + " this week. Each one searches the places in \"Where we look\" for skills, plugins and add-ons that would help its own work, then scores what it finds."));
    const chips = el("div", "sk-agents");
    r.agents.forEach((a) => {
      const has = found.has(norm(a));
      chips.appendChild(btn(a + (has ? "" : " (no report yet)"), "sk-agent" + (has ? " sk-has" : ""), () => (has ? jump("agent-" + norm(a)) : null), has ? "Jump to what " + a + " found." : a + " has not written a report for this week yet."));
    });
    s.appendChild(chips);
    if (r.reason) { const p = el("p", "sk-text"); p.append(el("b", "", "Why these agents: "), document.createTextNode(r.reason)); s.appendChild(auto(p)); }
    const when = el("p", "sk-when");
    when.append(el("b", "", "Next run: "), document.createTextNode(r.nextRunAt ? fmtWhen(r.nextRunAt) : (r.schedule || "not set")));
    s.appendChild(when);
    if (r.schedule) s.appendChild(auto(el("p", "sk-small", "Schedule as written: " + r.schedule)));
    const set = [];
    if (r.week) set.push("List set for week " + r.week);
    if (r.setAt) set.push("on " + fmtDay(r.setAt));
    if (set.length) s.appendChild(el("p", "sk-small", set.join(" ") + "."));
    if (r.week && d.thisWeek && r.week < d.thisWeek) s.appendChild(el("p", "sk-note", "This list was set for week " + r.week + ". The list for this week (" + d.thisWeek + ") has not been written yet, so the next run may use different agents."));
    return s;
  }

  // ---- (2) found
  function itemCard(d, a, it) {
    const c = el("article", "sk-item" + (it.use === "skip" ? " sk-skip" : ""));
    const head = el("div", "sk-itemhead");
    const sc = el("span", "sk-score" + (it.score >= 8 ? " sk-hi" : it.score >= 6 ? " sk-mid" : ""), it.score == null ? "?" : it.score + "/10");
    sc.title = SCORE_HELP; sc.setAttribute("aria-label", it.score == null ? "No score" : "Score " + it.score + " out of 10");
    head.append(sc, link(it.title, it.url, "sk-title"));
    c.appendChild(head);
    const chips = el("div", "sk-chips");
    const u = USE[it.use];
    if (u) { const ch = el("span", "sk-chip sk-use-" + it.use, u[0]); ch.title = u[1]; chips.appendChild(ch); }
    const dec = it.decision && VERDICT[it.decision.verdict];
    const vc = el("span", "sk-chip " + (dec ? "sk-dec-" + it.decision.verdict : "sk-open"), dec ? "Your answer: " + dec + (it.decision.at ? " (" + fmtDay(it.decision.at) + ")" : "") : "Not answered yet");
    vc.title = dec ? "You answered this in ARGUS > Ideas." : "Nobody has answered this yet. Answer it in ARGUS > Ideas (Install it / Park / Don't install / Ask a question).";
    chips.appendChild(vc);
    if (it.security === "unvetted") { const ch = el("span", "sk-chip sk-quiet", "Not checked by Security yet"); ch.title = "Nothing is installed before Security has read it."; chips.appendChild(ch); }
    else if (it.security) chips.appendChild(el("span", "sk-chip sk-quiet", "Security: " + it.security));
    c.appendChild(chips);
    if (it.howItHelps) { const p = el("p", "sk-why"); p.append(el("b", "", "How it helps: "), document.createTextNode(it.howItHelps)); c.appendChild(auto(p)); }
    if (it.integration) { const p = el("p", "sk-small"); p.append(el("b", "", "Where it would plug in: "), document.createTextNode(it.integration)); c.appendChild(auto(p)); }
    const more = [["Made by", it.author], ["Licence", it.licence], ["What it needs to run", it.permissions], ["Also useful for", it.fitAgents.join(", ")], ["Link", it.url]].filter((x) => x[1]);
    if (more.length) {
      const det = el("details", "sk-more"); det.appendChild(el("summary", "", "More about it"));
      more.forEach(([k, v]) => { const p = el("p", ""); p.append(el("b", "", k + ": "), document.createTextNode(v)); det.appendChild(auto(p)); });
      c.appendChild(det);
    }
    const row = el("div", "sk-actions");
    row.appendChild(btn(dec ? "Change your answer in ARGUS" : "Answer in ARGUS", "sk-btn", openArgus, "Opens ARGUS. The same item is in its Ideas list (" + d.week + ", " + a.agent + ") with Install it / Park / Don't install / Ask a question."));
    c.appendChild(row);
    return c;
  }
  function renderFound(d) {
    const s = section("found", "Found" + (d.week ? " in week " + d.week : ""), d.week ? plural(d.total, "item", "items") + " from " + plural(d.agents.length, "agent", "agents") : "");
    if (d.weeks && d.weeks.length > 1) {
      const lab = el("label", "sk-weeklab"); lab.appendChild(el("span", "", "Week"));
      const sel = el("select", "sk-week"); sel.setAttribute("aria-label", "Choose a week");
      d.weeks.forEach((w, i) => { const o = el("option", "", w + (i === 0 ? " (latest)" : "")); o.value = w; if (w === d.week) o.selected = true; sel.appendChild(o); });
      sel.addEventListener("change", () => { S.week = sel.value; load(); });
      lab.appendChild(sel); s.querySelector(".sk-sec-h").appendChild(lab);
    }
    const nr = d.rotation && d.rotation.nextRunAt ? " The next run is " + fmtWhen(d.rotation.nextRunAt) + "." : "";
    if (!d.week) { s.appendChild(el("p", "sk-empty", "Nothing found yet this week." + nr)); return s; }
    if (d.thisWeek && d.week < d.thisWeek) s.appendChild(el("p", "sk-note", "Nothing found yet this week (" + d.thisWeek + "). Showing the last week that has results, " + d.week + "." + nr));
    s.appendChild(el("p", "sk-small", SCORE_HELP + " Best first."));
    if (d.skipped) s.appendChild(el("p", "sk-note", plural(d.skipped, "report file", "report files") + " could not be read and are not shown."));
    d.agents.forEach((a) => {
      const k = d.week + "|" + norm(a.agent), isOpen = !S.closedAgents.has(k);
      const g = el("div", "sk-group"); g.dataset.sk = "agent-" + norm(a.agent);
      const h = el("button", "sk-ghead"); h.type = "button"; h.setAttribute("aria-expanded", isOpen ? "true" : "false");
      h.title = (isOpen ? "Hide" : "Show") + " the " + plural(a.items.length, "item", "items") + " " + a.agent + " found.";
      h.append(el("span", "sk-caret", isOpen ? "▾" : "▸"), el("span", "sk-avatar", (a.agent[0] || "?").toUpperCase()), el("h3", "sk-gname", a.agent),
        el("span", "sk-gsub", plural(a.items.length, "item", "items") + (a.items[0] && a.items[0].score != null ? " · best " + a.items[0].score + "/10" : "") + (a.generatedAt ? " · written " + fmtDay(a.generatedAt) : "")));
      h.addEventListener("click", () => { isOpen ? S.closedAgents.add(k) : S.closedAgents.delete(k); render(); });
      g.appendChild(h);
      if (isOpen) {
        if (a.summary) g.appendChild(auto(el("p", "sk-gsum", a.summary)));
        if (!a.items.length) g.appendChild(el("p", "sk-empty", a.agent + " looked and found nothing worth keeping this week."));
        const grid = el("div", "sk-grid");
        a.items.forEach((it) => grid.appendChild(itemCard(d, a, it)));
        g.appendChild(grid);
      }
      s.appendChild(g);
    });
    return s;
  }

  // ---- (3) where we look
  const SRC_PAGE = 15;
  function renderSources(d) {
    const src = d.sources || { list: [] };
    const s = section("sources", "Where we look", src.list.length ? plural(src.list.length, "place", "places") + (src.updatedAt ? " · list updated " + fmtDay(src.updatedAt) : "") : "");
    if (!src.list.length) { s.appendChild(el("p", "sk-note", src.missing ? "The list of places (sources\\_skills_plugins.json) is not there yet." : "The list of places could not be read.")); return s; }
    s.appendChild(el("p", "sk-small", "The agents check these places, best first. The score (out of 10) is how useful a place has been; \"weeks with nothing new\" counts how many weeks in a row it gave nothing. Places at 0 are skipped. Nothing is installed from any of them before Security checks it."));
    const ul = el("ul", "sk-srcs");
    const list = S.allSources ? src.list : src.list.slice(0, SRC_PAGE);
    list.forEach((x) => {
      const li = el("li", "sk-src" + (x.score === 0 ? " sk-src-off" : ""));
      const sc = el("span", "sk-score sk-small-score", x.score == null ? "?" : String(x.score)); sc.title = x.score === 0 ? "Score 0: skipped by the agents." : "How useful this place has been, out of 10.";
      const top = el("div", "sk-src-top"); top.append(sc, link(x.name, x.url, "sk-src-name"));
      if (x.kind) top.appendChild(el("span", "sk-chip sk-quiet", x.kind));
      li.appendChild(top);
      const facts = [];
      facts.push(x.lastUseful ? "last useful " + fmtDay(x.lastUseful) : "not useful yet");
      if (x.barrenWeeks != null) facts.push(plural(x.barrenWeeks, "week", "weeks") + " with nothing new");
      if (x.lastChecked) facts.push("checked " + fmtDay(x.lastChecked));
      li.appendChild(el("p", "sk-small", facts.join(" · ")));
      if (x.note) { const det = el("details", "sk-more"); det.appendChild(el("summary", "", "Notes")); det.appendChild(auto(el("p", "", x.note))); li.appendChild(det); }
      ul.appendChild(li);
    });
    s.appendChild(ul);
    if (src.list.length > SRC_PAGE) s.appendChild(btn(S.allSources ? "Show only the best " + SRC_PAGE : "Show all " + src.list.length + " places", "sk-btn", () => { S.allSources = !S.allSources; render(); if (!S.allSources) jump("sources"); }));
    return s;
  }

  // ---- (4) already adopted
  function renderAdopted(d) {
    const list = d.adopted || [];
    const s = section("adopted", "Already adopted", list.length ? plural(list.length, "pinned copy", "pinned copies") : "");
    if (!list.length) { s.appendChild(el("p", "sk-empty", "Nothing adopted yet. When Security has checked a skill and it is approved, a fixed copy is kept in the shared tools folder (skills) and shows here.")); return s; }
    s.appendChild(el("p", "sk-small", "Fixed copies we keep ourselves, checked by Security. They do not update by themselves; a new version needs a new check."));
    list.forEach((x) => {
      const c = el("div", "sk-adopt");
      c.appendChild(auto(el("b", "sk-adopt-t", x.title || x.name)));
      const facts = [plural(x.skills, "skill", "skills")];
      if (x.hashes) facts.push(plural(x.hashes, "file", "files") + " with a recorded fingerprint (checked before use)");
      c.appendChild(el("p", "sk-small", facts.join(" · ")));
      if (x.source) c.appendChild(auto(el("p", "sk-small", x.source)));
      if (x.vetted) c.appendChild(auto(el("p", "sk-small", x.vetted)));
      s.appendChild(c);
    });
    return s;
  }

  function render() {
    if (!bodyEl) return;
    const scroller = bodyEl.closest(".rs-body") || bodyEl.parentNode;
    const top = scroller ? scroller.scrollTop : 0;
    bodyEl.textContent = "";
    const d = S.data;
    if (!d) { bodyEl.appendChild(el("p", "sk-note", "Reading the Skills & Plugins watch...")); return; }
    if (!d.ok) {
      if (d.needsSetup && window.NeedsSetup) bodyEl.appendChild(window.NeedsSetup.card("research"));
      else bodyEl.appendChild(el("p", "sk-note", d.reason || "The Skills & Plugins files could not be read."));
      return;
    }
    const intro = el("div", "sk-intro");
    intro.appendChild(el("p", "sk-lead", "Every week a few agents look for new Claude skills, plugins and add-ons that could help us. This page shows who looks this week, what they found, and where they look. Nothing is installed from here."));
    const nums = el("div", "sk-nums");
    const rAgents = d.rotation && d.rotation.agents ? d.rotation.agents.length : 0;
    const cmp = d.prevWeek ? "last time (" + d.prevWeek + "): " + d.prevTotal : d.week ? "first week, nothing to compare" : "no week has results yet";
    const answered = d.agents.reduce((n, a) => n + a.items.filter((i) => i.decision).length, 0);
    nums.append(
      numBtn(rAgents, rAgents === 1 ? "agent this week" : "agents this week", d.rotation && d.rotation.week ? "list for " + d.rotation.week : "", () => jump("week"), "Jump to who researches this week."),
      numBtn(d.total, d.total === 1 ? "item found" : "items found", cmp, () => jump("found"), "Jump to what was found" + (d.week ? " in " + d.week : "") + "."),
      numBtn(answered, "answered", "of " + d.total + " found", () => jump("found"), "Items you already answered in ARGUS (the rest are still open)."),
      numBtn(d.sources.list.length, d.sources.list.length === 1 ? "place we look" : "places we look", "", () => jump("sources"), "Jump to the list of places."),
      numBtn((d.adopted || []).length, "adopted", "pinned copies", () => jump("adopted"), "Jump to what is already adopted."));
    intro.appendChild(nums);
    const bar = el("div", "sk-bar"); bar.appendChild(btn(S.loading ? "Reading..." : "Refresh", "sk-btn sk-quietbtn", () => load(), "Read the files again."));
    intro.appendChild(bar);
    bodyEl.append(intro, renderThisWeek(d), renderFound(d), renderSources(d), renderAdopted(d));
    if (scroller) scroller.scrollTop = top;
  }

  function load() {
    S.loading = true; if (S.data) render();
    return api.skillsLoad(S.week).then((r) => { S.loading = false; S.data = r; if (r && r.week) S.week = r.week; render(); })
      .catch(() => { S.loading = false; S.data = { ok: false, reason: "The Skills & Plugins files could not be read." }; render(); });
  }

  window.skillsView = {
    mount(h) { host = h; bodyEl = el("div", "sk-root"); host.appendChild(bodyEl); render(); if (!S.data) load(); },   // a re-render of My Research re-mounts: keep what is loaded
    unmount() { if (bodyEl && bodyEl.parentNode) bodyEl.parentNode.removeChild(bodyEl); bodyEl = null; host = null; S.data = null; S.week = ""; S.closedAgents = new Set(); S.allSources = false; S.loading = false; },
  };
})();
