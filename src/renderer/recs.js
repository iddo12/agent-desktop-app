// My Recommendations (v1.133.0): the second tab inside My Research ("Findings | My Recommendations"). Loaded on first use by research.js
// (window.recsView.mount(host)). Built to UI-UX's mockup (UI-UX Agent\docs\my_recommendations_mock_2026-10-18.html); icons by Graphics.
// Weeks newest first, each collapsible (the newest is open; the open weeks are remembered). In a week: the COO's top 5 (#1 full width, #2-5 in two
// columns, each joined by ideaId to the agent's own item), then one closed group per agent (items sorted by impact, two columns).
// Every item has a reply box: "Do it" / "I have a question" only FILL the box (item + week); the owner edits and presses Send. Nothing is ever sent
// by itself. After a send the item shows a "Replied <date>" chip (from the writer's log, so it survives a restart).
// PRIVACY/LIGHT: textContent only (the icons are built with createElementNS from constants), one load on open and on Refresh, the renderer sends a
// week name, an agent name and an item id, never a path. Look: styles-recs.css (tokens --rs-*). Restyle in the render* functions and the CSS only.
(function () {
  "use strict";
  const api = window.api && window.api.research;
  if (!api || !api.recsLoad) return;
  const MAX_TEXT = 4000, LS_KEY = "recsOpenWeeks";

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function auto(e) { e.setAttribute("dir", "auto"); return e; }
  function btn(label, cls, onClick) { const b = el("button", cls || "rc-btn", label); b.type = "button"; b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); onClick(ev); }); return b; }
  const norm = (v) => String(v || "").trim().toLowerCase();
  const NL = String.fromCharCode(10);
  const stripHead = (s) => String(s || "").replace(/^> Re: [^\n]*\n\n/, "");

  // Graphics' icons (24 px grid, currentColor); [path d or "circle", attributes]
  const ICONS = {
    do: [["M7 4.5 20 12 7 19.5z", { fill: "currentColor" }]],
    fix: [["M14.5 9.5 4.5 19.5", { "stroke-width": "3.4" }], ["M13 3.8a5 5 0 0 0-1.6 6.6 5 5 0 0 0 6.7 1.6 5 5 0 0 0 1.5-6.4L17.2 8.2 14.6 6.8z", { fill: "currentColor", "stroke-width": "1.6" }]],
    build: [["M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z", {}], ["M12 12v9M4.2 7.6 12 12l7.8-4.4", {}]],
    research: [["circle", { cx: "10", cy: "10", r: "6.2" }], ["m14.8 14.8 6 6", { "stroke-width": "3.4" }]],
    promote: [["m12 2.8 2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17l-5.6 3.1 1.2-6.3L3 9.4l6.3-.8z", { fill: "currentColor", "stroke-width": "1.6" }]],
    replied: [["circle", { cx: "12", cy: "12", r: "9.2" }], ["m7.6 12.4 3.2 3.2 5.8-6.6", { "stroke-width": "3" }]],
  };
  function icon(name) {
    const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
    const base = { viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "2.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "rc-ico" };
    for (const k of Object.keys(base)) svg.setAttribute(k, base[k]);
    (ICONS[name] || []).forEach((def) => {
      const p = document.createElementNS(NS, def[0] === "circle" ? "circle" : "path");
      if (def[0] !== "circle") p.setAttribute("d", def[0]);
      for (const k of Object.keys(def[1])) p.setAttribute(k, def[1][k]);
      svg.appendChild(p);
    });
    return svg;
  }
  const KIND = { do: "Do", fix: "Fix", build: "Build", research: "Research", promote: "Promote" };
  const EFFORT = { S: "Small", M: "Medium", L: "Large" };
  function statusWord(s) {
    s = String(s || "");
    if (!s || s === "new") return "New";
    if (s === "repeat-updated") return "Raised before, updated";
    if (/^done/.test(s)) return "Done";
    if (/^corrected/.test(s)) return "Corrected";
    return s.slice(0, 30);
  }
  // ISO week -> "12-18 Oct 2026"
  function weekDates(week) {
    const m = /^(\d{4})-W(\d{2})$/.exec(week); if (!m) return "";
    const y = +m[1], w = +m[2], jan4 = new Date(Date.UTC(y, 0, 4)), dow = jan4.getUTCDay() || 7;
    const mon = new Date(jan4.getTime() + ((w - 1) * 7 - (dow - 1)) * 86400000), sun = new Date(mon.getTime() + 6 * 86400000);
    const mo = (d) => d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
    return mon.getUTCDate() + (mo(mon) !== mo(sun) ? " " + mo(mon) : "") + "-" + sun.getUTCDate() + " " + mo(sun) + " " + sun.getUTCFullYear();
  }

  const S = { data: null, open: null, openAgents: new Set(), seededAgents: false, onlyNeeds: false, boxes: new Map(), sending: new Set(), msg: new Map(), repliedNow: {}, all: false };
  let host = null, bodyEl = null;
  const key = (week, agent, id) => week + "|" + norm(agent) + "|" + id;
  const repliedOn = (week, agent, id) => S.repliedNow[key(week, agent, id)] || (S.data && S.data.replied && S.data.replied[key(week, agent, id)]) || "";
  function loadOpen() { try { const v = JSON.parse(localStorage.getItem(LS_KEY) || "null"); return Array.isArray(v) ? new Set(v.filter((x) => typeof x === "string")) : null; } catch (e) { return null; } }
  function saveOpen() { try { localStorage.setItem(LS_KEY, JSON.stringify([...S.open])); } catch (e) { /* not remembered */ } }

  function toggleHead(parts, isOpen, onToggle, cls) {
    const h = el("button", "rc-head " + (cls || ""));
    h.type = "button"; h.setAttribute("aria-expanded", isOpen ? "true" : "false");
    h.appendChild(el("span", "rc-caret", isOpen ? "▾" : "▸"));
    parts.forEach((p) => h.appendChild(p));
    h.addEventListener("click", onToggle);
    return h;
  }

  function reply(week, agent, itemId, title) {
    const k = key(week, agent, itemId);
    const wrap = el("div", "rc-reply");
    const state = el("p", "rc-state"); state.setAttribute("role", "status");
    const m = S.msg.get(k); if (m) { state.textContent = m.text; state.classList.add(m.ok ? "rc-ok" : "rc-bad"); }
    const bar = el("div", "rc-actions");
    const goAhead = "Go ahead with: " + title + " (" + itemId + ").", question = "Question about " + title + " (" + itemId + "): ";
    const openBox = (prefill) => {
      const cur = S.boxes.get(k);
      const body = cur == null ? "" : stripHead(cur).trim();
      const typed = body !== "" && body !== goAhead.trim() && body !== question.trim();      // keep anything he already wrote
      if (!typed) S.boxes.set(k, prefill);
      render();
      const t = bodyEl && bodyEl.querySelector('textarea[data-k="' + CSS.escape(k) + '"]');
      if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
    };
    const head = "> Re: " + title + " (" + week + ")" + NL + NL;
    bar.append(btn("Do it", "rc-btn rc-do", () => openBox(head + goAhead)), btn("I have a question", "rc-btn", () => openBox(head + question)));
    wrap.appendChild(bar);
    if (S.boxes.has(k)) {
      const ta = el("textarea", "rc-ta"); ta.value = S.boxes.get(k); ta.rows = 4; ta.maxLength = MAX_TEXT; ta.dataset.k = k; ta.setAttribute("aria-label", "Reply to " + agent); ta.setAttribute("dir", "auto");
      const cnt = el("span", "rc-count", ta.value.length + " / " + MAX_TEXT);
      ta.addEventListener("input", () => { S.boxes.set(k, ta.value); cnt.textContent = ta.value.length + " / " + MAX_TEXT; });
      const row = el("div", "rc-actions");
      const send = btn(S.sending.has(k) ? "Sending..." : "Send to " + agent, "rc-btn rc-send", () => doSend(week, agent, itemId, k, ta.value));
      if (S.sending.has(k)) send.disabled = true;
      row.append(send, btn("Cancel", "rc-btn rc-quiet", () => { S.boxes.delete(k); S.msg.delete(k); render(); }), cnt);
      wrap.append(ta, row);
    }
    wrap.appendChild(state);
    return wrap;
  }

  function doSend(week, agent, itemId, k, text) {
    if (!stripHead(text).trim()) { S.msg.set(k, { ok: false, text: "Write your message first." }); render(); return; }
    S.sending.add(k); S.msg.delete(k); render();
    api.recsWrite(week, agent, itemId, text).then((r) => {
      S.sending.delete(k);
      if (r && r.ok) {
        S.msg.set(k, { ok: true, text: r.delivery === "pending" ? "Saved for " + agent + " (not running: they read it at their next start)." : "Sent to " + agent + "." });
        S.repliedNow[key(week, agent, itemId)] = new Date().toISOString().slice(0, 10);
        S.boxes.delete(k);
      } else S.msg.set(k, { ok: false, text: (r && r.reason) || "Not sent." });
      render();
    }).catch(() => { S.sending.delete(k); S.msg.set(k, { ok: false, text: "Not sent." }); render(); });
  }

  function chip(text, cls, iconName) {
    const c = el("span", "rc-chip" + (cls ? " " + cls : ""));
    if (iconName) c.appendChild(icon(iconName));
    c.appendChild(document.createTextNode(text));
    return c;
  }
  function itemCard(week, agent, it, extra) {
    const x = extra || {};
    const c = el("article", "rc-item" + (it.needsIddo ? " rc-needs" : "") + (x.cls ? " " + x.cls : ""));
    const head = el("div", "rc-itemhead");
    if (x.rank) head.appendChild(el("span", "rc-rank", "#" + x.rank));
    head.appendChild(auto(el("h4", "rc-title", it.title)));
    c.appendChild(head);
    if (x.agentName) c.appendChild(el("p", "rc-by", x.agentName));
    const chips = el("div", "rc-chips");
    if (it.kind) chips.appendChild(chip(KIND[it.kind] || it.kind, "", ICONS[it.kind] ? it.kind : null));
    const dots = el("span", "rc-chip rc-impact"); dots.setAttribute("aria-label", "Impact " + it.impact + " of 5");
    dots.append(el("span", "rc-dots", "●".repeat(it.impact) + "○".repeat(5 - it.impact)), document.createTextNode(" Impact " + it.impact + "/5"));
    chips.appendChild(dots);
    if (it.effort) chips.appendChild(chip("Effort " + (EFFORT[it.effort] || it.effort)));
    if (it.cost) chips.appendChild(chip("Cost: " + it.cost));
    chips.appendChild(chip(statusWord(it.status), "rc-quietchip"));
    const rep = repliedOn(week, agent, it.id);
    if (rep) chips.appendChild(chip("Replied " + rep, "rc-replied", "replied"));
    c.appendChild(chips);
    if (x.coo) c.appendChild(auto(el("p", "rc-coo", "Why the COO ranked it #" + x.rank + ": " + x.coo)));
    if (it.needsIddo) { const n = el("div", "rc-needs-strip"); n.append(el("strong", "", "Needs you: "), document.createTextNode(it.needsIddo)); auto(n); c.appendChild(n); }
    if (it.why) c.appendChild(auto(el("p", "rc-why", it.why)));
    if (it.firstStep) { const d = el("details", "rc-first"); d.appendChild(el("summary", "", "First step and what is needed")); d.appendChild(auto(el("p", "", it.firstStep))); c.appendChild(d); }
    c.appendChild(reply(week, agent, it.id, it.title));
    return c;
  }

  function topFive(w) {
    if (!w.top.length) return el("p", "rc-note", w.cooMissing ? "Not yet curated by the COO." : "The COO's list for this week is empty.");
    const box = el("section", "rc-top"); box.setAttribute("aria-label", "COO's top " + w.top.length);
    box.appendChild(el("h3", "rc-sec", "COO's top " + w.top.length));
    const grid = el("div", "rc-topgrid");
    w.top.forEach((t, i) => {
      const a = w.agents.find((z) => norm(z.agent) === norm(t.agent));
      const it = a && a.items.find((z) => z.id === t.ideaId);
      const cls = i === 0 ? "rc-top1" : "";
      if (it) grid.appendChild(itemCard(w.week, a.agent, it, { rank: t.rank, agentName: a.agent, coo: t.why, cls }));
      else {   // no matching item in the agent's file: the COO's own text, nothing to reply to
        const c = el("article", "rc-item " + cls); const h = el("div", "rc-itemhead");
        h.append(el("span", "rc-rank", "#" + t.rank), auto(el("h4", "rc-title", t.title)));
        c.append(h, el("p", "rc-by", t.agent || "Unknown agent"), auto(el("p", "rc-why", t.why)));
        grid.appendChild(c);
      }
    });
    box.appendChild(grid);
    return box;
  }

  function weekSection(w, idx) {
    const sec = el("section", "rc-week");
    const isOpen = S.open.has(w.week);
    const bar = [el("span", "rc-head-t", "Week " + w.week.slice(6) + " · " + weekDates(w.week)),
      el("span", "rc-head-s", w.total + " recommendations" + (w.needs ? " · " + w.needs + " need you" : "") + (w.skipped ? " · " + w.skipped + " file(s) unreadable" : ""))];
    sec.appendChild(toggleHead(bar, isOpen, () => { isOpen ? S.open.delete(w.week) : S.open.add(w.week); saveOpen(); render(); }, "rc-weekhead"));
    if (!isOpen) return sec;
    const body = el("div", "rc-weekbody");
    if (w.headline) body.appendChild(auto(el("p", "rc-headline", w.headline)));
    body.appendChild(topFive(w));
    body.appendChild(el("h3", "rc-sec", "Everything else, by agent"));
    const agents = w.agents.filter((a) => a.items.some((i) => !S.onlyNeeds || i.needsIddo));
    if (!agents.length) body.appendChild(el("p", "rc-note", S.onlyNeeds ? "Nothing needs you this week." : "No recommendation files for this week."));
    agents.forEach((a, ai) => {
      const items = a.items.filter((i) => !S.onlyNeeds || i.needsIddo).sort((p, q) => q.impact - p.impact);
      const ak = w.week + "|" + a.agent;
      if (idx === 0 && ai === 0 && !S.seededAgents) { S.seededAgents = true; S.openAgents.add(ak); }   // the first group of the newest week starts open
      const aOpen = S.openAgents.has(ak), needs = a.items.filter((i) => i.needsIddo).length;
      const g = el("div", "rc-agent");
      const parts = [el("span", "rc-avatar", (a.agent[0] || "?").toUpperCase()), el("span", "rc-head-t", a.agent),
        el("span", "rc-head-s", items.length + (items.length === 1 ? " item" : " items") + (needs ? " · " + needs + " need you" : ""))];
      g.appendChild(toggleHead(parts, aOpen, () => { aOpen ? S.openAgents.delete(ak) : S.openAgents.add(ak); render(); }, "rc-agenthead"));
      if (aOpen) {
        if (a.headline) g.appendChild(auto(el("p", "rc-headline rc-agentline", a.headline.length > 150 ? a.headline.slice(0, 147) + "..." : a.headline)));
        const grid = el("div", "rc-grid");
        items.forEach((i) => grid.appendChild(itemCard(w.week, a.agent, i)));
        g.appendChild(grid);
      }
      body.appendChild(g);
    });
    sec.appendChild(body);
    return sec;
  }

  function render() {
    if (!bodyEl) return;
    const scroller = bodyEl.closest(".rs-body") || bodyEl.parentNode;
    const top = scroller ? scroller.scrollTop : 0;
    bodyEl.textContent = "";
    const d = S.data;
    if (!d) { bodyEl.appendChild(el("p", "rc-note", "Reading the recommendations...")); return; }
    if (!d.ok) {
      if (d.needsSetup && window.NeedsSetup) bodyEl.appendChild(window.NeedsSetup.card("research"));
      else bodyEl.appendChild(el("p", "rc-note", d.reason || "The recommendations folder could not be read."));
      return;
    }
    if (!d.weeks.length) { bodyEl.appendChild(el("p", "rc-note", "No recommendation weeks yet. The agents write them into shared_reports\\recommendations\\<week>.")); return; }
    if (!S.open) S.open = loadOpen() || new Set([d.weeks[0].week]);
    const bar = el("div", "rc-bar");
    const only = btn(S.onlyNeeds ? "Showing only: needs you" : "Show only: needs you", "rc-btn" + (S.onlyNeeds ? " rc-on" : ""), () => { S.onlyNeeds = !S.onlyNeeds; render(); });
    only.setAttribute("aria-pressed", S.onlyNeeds ? "true" : "false");
    bar.append(btn("Open all weeks", "rc-btn", () => { d.weeks.forEach((w) => S.open.add(w.week)); saveOpen(); render(); }),
      btn("Collapse all", "rc-btn", () => { S.open.clear(); S.openAgents.clear(); saveOpen(); render(); }), only,
      btn("Refresh", "rc-btn rc-quiet", () => load()));
    bodyEl.appendChild(bar);
    d.weeks.forEach((w, i) => bodyEl.appendChild(weekSection(w, i)));
    if (d.more) bodyEl.appendChild(btn("Show older weeks", "rc-btn rc-quiet", () => load(true)));   // the newest 8 weeks load by default
    if (scroller) scroller.scrollTop = top;
  }

  function load(all) {
    if (all != null) S.all = !!all;
    return api.recsLoad(S.all).then((r) => { S.data = r; render(); })
      .catch(() => { S.data = { ok: false, reason: "The recommendations could not be read." }; render(); });
  }

  window.recsView = {
    mount(h) { host = h; bodyEl = el("div", "rc-root"); host.appendChild(bodyEl); render(); if (!S.data) load(); },   // a re-render of My Research re-mounts: keep what is loaded
    unmount() { if (bodyEl && bodyEl.parentNode) bodyEl.parentNode.removeChild(bodyEl); bodyEl = null; host = null; S.data = null; S.open = null; S.boxes = new Map(); S.msg = new Map(); S.sending = new Set(); S.seededAgents = false; },
  };
})();
