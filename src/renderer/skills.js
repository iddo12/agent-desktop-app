// Skills & Plugins (v1.139.0): the third tab inside My Research ("Findings | My Recommendations | Skills & Plugins"). Loaded on first use by
// research.js (window.skillsView.mount(host)), never at startup. Shows, in plain words, what the weekly Skills & Plugins watch will look at and what
// it found: (1) This week - who researches, why, when it runs next; (2) Found - every item of the newest week grouped by agent, best score first,
// with the owner's answer from ARGUS when there is one; (3) Where we look - the list of places, read-only; (4) Already adopted - pinned copies.
// v1.140.0 (Iddo: "why not just say implement it or use it or discuss ... inside the tab itself"): each item has its own answer buttons
// (Install it / Use the idea / Park / Don't install) and a "Discuss with <agent>" box. NO new store and NO new transport:
//   - answers go through ARGUS's own write (window.api.argusSetIdeaDecision -> argus-data.setIdeaDecision), into the item's "decision" in
//     recommendations\<week>\<Agent>.json, so ARGUS > Ideas and this tab always show the same answer; pressing the chosen one again clears it.
//   - Discuss uses the My Recommendations reply path (api.recsWrite -> research-write's writer: verified delivery to the agent that found the
//     item, or a pending note when it is not running). The box is prefilled; nothing is sent until Send is pressed.
// Every number is a button that opens or jumps to what it counts.
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
  // the answer buttons; "approved" reads "Use the idea" on a borrow-the-idea item (same stored verdict; ARGUS shows it as approved)
  const yesWord = (it) => (it.use === "borrow_idea" ? "Use the idea" : "Install it");
  const verdictWord = (it, v) => (v === "approved" ? yesWord(it) : VERDICT[v] || "");
  const ANSWER_HELP = { approved: "Yes, go ahead (Security still checks it before anything is installed).", parked: "Not now; keep it for later.", rejected: "No, we do not want this." };
  const MAX_TEXT = 4000, NL = String.fromCharCode(10);
  const stripHead = (t) => String(t || "").replace(/^> Re: [^\n]*\n\n/, "");
  const SCORE_HELP = "Score out of 10, given by the agent that found it: 10 = must-have, 7 = pretty useful, 5 = meh, 1 = not needed.";

  function fmtDay(v) {
    const d = typeof v === "number" || /^\d{4}-\d{2}-\d{2}T\d/.test(String(v || "")) ? new Date(v) : /^\d{4}-\d{2}-\d{2}/.test(String(v || "")) ? new Date(String(v).slice(0, 10) + "T12:00:00") : null;   // v1.140.0: a full time is shown as a local date
    return d && !isNaN(d) ? d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
  }
  function fmtWhen(ms) {
    const d = new Date(ms);
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(new Date().setHours(0, 0, 0, 0))) / 86400000);
    const rel = days <= 0 ? "today" : days === 1 ? "tomorrow" : "in " + days + " days";
    return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" }) + ", about " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + " (" + rel + ")";
  }

  const S = { data: null, week: "", closedAgents: new Set(), allSources: false, loading: false, saving: new Set(), msg: new Map(), boxes: new Map(), sending: new Set() };
  const itemKey = (week, a, it) => week + "|" + norm(a.file || a.agent) + "|" + it.id;
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
    s.appendChild(el("p", "sk-lead", plural(r.agents.length, "agent looks", "agents look") + " this week. Each one searches the places in \"Where we look\" for skills, plugins and add-ons that would help its own work, then scores what it finds. Add or remove agents here; the next run uses this list."));
    // v1.141.0: the list is editable (x removes, "Add agent" adds); each change is saved at once through skills-rotation-set, with Undo.
    // The rotation's reason paragraph and the schedule text line are no longer shown (Iddo).
    const known = Array.isArray(d.knownAgents) ? d.knownAgents : [];
    const label = (name) => { const k = known.find((x) => norm(x.folderName) === norm(name)); return k && k.displayName && norm(k.displayName) !== norm(name) ? k.displayName : name; };
    const chips = el("div", "sk-agents");
    r.agents.forEach((a) => {
      const has = found.has(norm(a));
      const chip = el("span", "sk-agentchip" + (has ? " sk-has" : ""));
      chip.appendChild(btn(label(a) + (has ? "" : " (no report yet)"), "sk-agent" + (has ? " sk-has" : ""), () => (has ? jump("agent-" + norm(a)) : null), has ? "Jump to what " + label(a) + " found." : label(a) + " has not written a report for this week yet."));
      const x = btn("\u00d7", "sk-agentx", () => saveRotation(d, r.agents.filter((n) => n !== a), "Removed " + label(a) + "."), r.agents.length > 1 ? "Remove " + label(a) + " from this week's list." : "At least one agent has to look each week.");
      x.setAttribute("aria-label", "Remove " + label(a));
      if (r.agents.length <= 1 || S.rotSaving) x.disabled = true;
      chip.appendChild(x);
      chips.appendChild(chip);
    });
    const options = known.filter((k) => !r.agents.some((n) => norm(n) === norm(k.folderName))).sort((p, q) => (p.displayName || p.folderName).localeCompare(q.displayName || q.folderName));
    if (options.length) {
      const sel = el("select", "sk-week sk-addagent"); sel.setAttribute("aria-label", "Add an agent to this week's list");
      const first = el("option", "", "+ Add agent..."); first.value = ""; sel.appendChild(first);
      options.forEach((k) => { const o = el("option", "", k.displayName || k.folderName); o.value = k.folderName; sel.appendChild(o); });
      if (S.rotSaving) sel.disabled = true;
      sel.addEventListener("change", () => { const v = sel.value; if (v) saveRotation(d, r.agents.concat([v]), "Added " + label(v) + "."); });
      chips.appendChild(sel);
    }
    s.appendChild(chips);
    if (S.rotMsg) {
      const p = el("p", "sk-state " + (S.rotMsg.ok ? "sk-ok" : "sk-bad"), S.rotMsg.text); p.setAttribute("role", "status");
      if (S.rotMsg.ok && S.rotUndo) p.appendChild(btn("Undo", "sk-btn sk-quietbtn sk-undo", () => { const prev = S.rotUndo; S.rotUndo = null; saveRotation(d, prev, "Back to the previous list.", true); }, "Put the list back as it was before this change."));
      s.appendChild(p);
    }
    const when = el("p", "sk-when");
    when.append(el("b", "", "Next run: "), document.createTextNode(r.nextRunAt ? fmtWhen(r.nextRunAt) : (r.schedule || "not set")));
    s.appendChild(when);
    const set = [];
    if (r.week) set.push("List set for week " + r.week);
    if (r.setAt) set.push("on " + fmtDay(r.setAt));
    if (set.length) s.appendChild(el("p", "sk-small", set.join(" ") + "."));
    if (r.week && d.thisWeek && r.week < d.thisWeek) s.appendChild(el("p", "sk-note", "This list was set for week " + r.week + ". The list for this week (" + d.thisWeek + ") has not been written yet, so the next run may use different agents."));
    return s;
  }

  // v1.141.0 save who looks this week. The tab sends the list it showed (expected), so a change made elsewhere in the meantime is not overwritten.
  function saveRotation(d, agents, said, isUndo) {
    if (!api.skillsSetRotation || S.rotSaving) return;
    const before = d.rotation.agents.slice();
    S.rotSaving = true; S.rotMsg = { ok: true, text: "Saving..." }; render();
    api.skillsSetRotation(agents, before).then((r) => {
      S.rotSaving = false;
      if (r && r.ok) {
        d.rotation.agents = r.agents; d.rotation.setAt = r.setAt;
        if (r.nextRunAt) d.rotation.nextRunAt = r.nextRunAt;
        S.rotUndo = isUndo ? null : before;
        S.rotMsg = { ok: true, text: said + " Saved. Next run " + (d.rotation.nextRunAt ? fmtWhen(d.rotation.nextRunAt) : "as scheduled") + "." };
      } else S.rotMsg = { ok: false, text: "Not saved: " + ((r && r.reason) || "the list could not be written.") };
      render();
    }).catch(() => { S.rotSaving = false; S.rotMsg = { ok: false, text: "Not saved: something went wrong." }; render(); });
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
    const vc = el("span", "sk-chip " + (dec ? "sk-dec-" + it.decision.verdict : "sk-open"), dec ? "Your answer: " + verdictWord(it, it.decision.verdict) + (it.decision.at ? " (" + fmtDay(it.decision.at) + ")" : "") : "Not answered yet");
    vc.title = dec ? "Your answer. ARGUS > Ideas shows the same one. Change it with the buttons below." : "Not answered yet. Use the buttons below.";
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
    c.appendChild(answerBar(d, a, it));
    c.appendChild(discussBox(d, a, it));
    return c;
  }

  // ---- v1.140.0 answering inside the tab (ARGUS's own store and write; see the top of this file)
  function answerBar(d, a, it) {
    const k = itemKey(d.week, a, it), cur = it.decision ? it.decision.verdict : "none";
    const wrap = el("div", "sk-answer");
    const row = el("div", "sk-actions"); row.setAttribute("role", "group"); row.setAttribute("aria-label", "Your answer");
    [["approved", yesWord(it)], ["parked", "Park"], ["rejected", "Don't install"]].forEach(([v, word]) => {
      const on = cur === v;
      const b = btn(on ? "\u2713 " + word : word, "sk-btn sk-ans sk-ans-" + v + (on ? " sk-on" : ""), () => decide(d, a, it, on ? "none" : v),
        on ? "Your answer. Press again to take it back." : ANSWER_HELP[v]);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      if (S.saving.has(k)) b.disabled = true;
      row.appendChild(b);
    });
    const dk = "d|" + k;
    if (!S.boxes.has(dk)) row.appendChild(btn("Discuss with " + a.agent, "sk-btn sk-discuss", () => openDiscuss(d, a, it), "Write to " + a.agent + " about this item, here in the tab."));
    wrap.appendChild(row);
    const m = S.msg.get(k);
    if (m) { const p = el("p", "sk-state " + (m.ok ? "sk-ok" : "sk-bad"), m.text); p.setAttribute("role", "status"); wrap.appendChild(p); }
    return wrap;
  }
  function plainError(r) {
    const e = String((r && (r.error || r.reason)) || "");
    if (r && r.needsSetup) return "ARGUS is not set up on this computer (Setup, ARGUS).";
    if (/No idea with that id|No ideas file/i.test(e)) return "this item is not in the agent's ideas file for this week, so it cannot be answered (here or in ARGUS).";
    return e || "the answer could not be written.";
  }
  function decide(d, a, it, verdict) {
    const k = itemKey(d.week, a, it);
    if (!window.api.argusSetIdeaDecision) { S.msg.set(k, { ok: false, text: "Answering is not available in this version." }); render(); return; }
    S.saving.add(k); S.msg.delete(k); render();
    window.api.argusSetIdeaDecision({ week: d.week, agent: a.file || a.agent, id: it.id, verdict }).then((r) => {
      S.saving.delete(k);
      if (r && r.ok) {
        it.decision = verdict === "none" ? null : { verdict, at: new Date().toISOString() };
        S.msg.set(k, { ok: true, text: verdict === "none" ? "Answer taken back." : "Saved: " + verdictWord(it, verdict) + ". ARGUS shows the same answer." });
      } else S.msg.set(k, { ok: false, text: "Not saved: " + plainError(r) });
      render();
    }).catch(() => { S.saving.delete(k); S.msg.set(k, { ok: false, text: "Not saved: something went wrong. Try again." }); render(); });
  }
  const prefill = (d, it) => "> Re: " + it.title + " (" + d.week + ")" + NL + NL + "About " + it.title + " (" + it.id + "): ";
  function openDiscuss(d, a, it) {
    const dk = "d|" + itemKey(d.week, a, it);
    if (!S.boxes.has(dk)) S.boxes.set(dk, prefill(d, it));
    S.msg.delete(dk);
    render();
    const t = bodyEl && bodyEl.querySelector('textarea[data-k="' + CSS.escape(dk) + '"]');
    if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
  }
  function discussBox(d, a, it) {
    const dk = "d|" + itemKey(d.week, a, it);
    const wrap = el("div", "sk-discussbox");
    if (S.boxes.has(dk)) {
      const ta = el("textarea", "sk-ta"); ta.value = S.boxes.get(dk); ta.rows = 4; ta.maxLength = MAX_TEXT; ta.dataset.k = dk; ta.setAttribute("dir", "auto");
      ta.setAttribute("aria-label", "Message to " + a.agent + " about " + it.title);
      const cnt = el("span", "sk-count", ta.value.length + " / " + MAX_TEXT);
      ta.addEventListener("input", () => { S.boxes.set(dk, ta.value); cnt.textContent = ta.value.length + " / " + MAX_TEXT; });
      const row = el("div", "sk-actions");
      const send = btn(S.sending.has(dk) ? "Sending..." : "Send to " + a.agent, "sk-btn sk-send", () => doSend(d, a, it, ta.value));
      if (S.sending.has(dk)) send.disabled = true;
      row.append(send, btn("Cancel", "sk-btn sk-quietbtn", () => { S.boxes.delete(dk); S.msg.delete(dk); render(); }), cnt);
      wrap.append(ta, row);
    }
    const m = S.msg.get(dk);
    if (m) { const p = el("p", "sk-state " + (m.ok ? "sk-ok" : "sk-bad"), m.text); p.setAttribute("role", "status"); wrap.appendChild(p); }
    return wrap;
  }
  function doSend(d, a, it, text) {
    const dk = "d|" + itemKey(d.week, a, it);
    if (!stripHead(text).trim() || text.trim() === prefill(d, it).trim()) { S.msg.set(dk, { ok: false, text: "Write your message first." }); render(); return; }
    if (!api.recsWrite) { S.msg.set(dk, { ok: false, text: "Sending is not available in this version." }); render(); return; }
    S.sending.add(dk); S.msg.delete(dk); render();
    api.recsWrite(d.week, a.file || a.agent, it.id, text).then((r) => {
      S.sending.delete(dk);
      if (r && r.ok) { S.boxes.delete(dk); S.msg.set(dk, { ok: true, text: r.hidden ? "Saved for " + a.agent + ". " + a.agent + " reads it in the Claude desktop app, not here." : r.delivery === "pending" ? "Saved for " + a.agent + " (not running now: it reads it at its next start)." : "Sent to " + a.agent + "." }); }   // v1.141.0 hidden agents: notes only
      else S.msg.set(dk, { ok: false, text: "Not sent: " + ((r && r.reason) || "the message could not be delivered.") });
      render();
    }).catch(() => { S.sending.delete(dk); S.msg.set(dk, { ok: false, text: "Not sent: something went wrong." }); render(); });
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
    unmount() { if (bodyEl && bodyEl.parentNode) bodyEl.parentNode.removeChild(bodyEl); bodyEl = null; host = null; S.data = null; S.week = ""; S.closedAgents = new Set(); S.allSources = false; S.loading = false; S.saving = new Set(); S.msg = new Map(); S.boxes = new Map(); S.sending = new Set(); S.rotSaving = false; S.rotMsg = null; S.rotUndo = null; },
  };
})();
