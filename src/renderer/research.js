// My Research view (v1.87.0). Loaded on first click of the My Research entry (research-nav.js), not at startup.
// LOOK: built to UI-UX's mockup (<scratch>\UI-UX\research-tab\top_visual.html) and the owner's rule "big bold numbers, colour, icons, short
// words, always a legend". STRUCTURE FOR RESTYLING: all look is in styles-research.css (tokens --rs-*). All markup is built by the NAMED render
// functions below (renderHeader, renderAskBar, renderLegend, renderTopFive, renderPickCard, renderCoo, renderGlance, renderThemes, renderFilters,
// renderAgentTile, renderTierBar, renderFindingCard, renderFindingBody, renderSources, renderState); restyle them
// without touching the data/logic section at the bottom.
// PRIVACY/LIGHT: textContent only; no timers except one toast fade; one load on open (and on a week change / Refresh / Retry); nothing from
// the digests stays in the page once the view closes; the renderer never sends a path, only a week name and a finding's identity.
// Sending an "also research X" message uses the app's own window.libraryBridge.send (the compose box's path). No new transport.
// v1.89.0 "Write to <agent>" (renderWriteArea / renderWriteBox): on every opened finding, on the five (jumps to the finding with the box open)
// and on each agent's panel. The text goes through research-write in main, which uses the SAME verified delivery as My Daily > Tasks.
(function () {
  "use strict";
  const api = window.api && window.api.research;
  if (!api) return;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  // v1.121.1: the date line on every card (source date + the day the agent found it); built in main (research/dates.js), shown here only
  function dateEl(f) { return f && f.dateLine ? auto(el("p", "rs-dates", f.dateLine)) : null; }
  function addDates(host, f) { const d = dateEl(f); if (d) host.appendChild(d); return host; }
  function auto(e) { e.setAttribute("dir", "auto"); return e; }                 // Hebrew findings render right-to-left on their own
  function btn(label, cls, onClick) { const b = el("button", cls || "rs-btn", label); b.type = "button"; b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); onClick(ev); }); return b; }
  let uid = 0;
  const nextId = (p) => "rs-" + p + "-" + (++uid);
  const norm = (v) => String(v || "").trim().toLowerCase();
  const TIER = { high: { word: "High", shape: "▲" }, normal: { word: "Normal", shape: "■" }, low: { word: "Low", shape: "▼" } };
  const money = (n) => "$" + (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));
  const BAD = { "did-not-run": 1, "ran-no-digest": 1, invalid: 1, unreadable: 1, "too-big": 1 };

  // first sentence (or first ~170 characters) of a long text: the "so what" headline
  // never truncated: the headline is the first sentence (or the whole text when it has no sentence break); when the text is over ~140
  // characters, the rest of it moves to the top of "Why it matters"
  function splitHeadline(t) {
    t = String(t || "").replace(/\s+/g, " ").trim();
    if (!t) return { head: "", rest: "", whole: "" };
    const m = t.match(/^(.{20,}?[.!?])(\s+|$)/);
    const full = m ? m[1] : t;
    // longer than ~110 characters: cut at the last whole word before 110 and add an ellipsis; the FULL text then leads "Why it matters"
    let head = full, cut = false;
    if (full.length > 110) { head = full.slice(0, 110).replace(/\s+\S*$/, "").replace(/[\s,;:.\-]+$/, "") + "…"; cut = true; }
    return { head, cut, rest: t.slice(full.length).trim(), whole: t };
  }
  const oneLine = (t) => splitHeadline(t).head;
  const whyText = (f) => { const h = splitHeadline(f.soWhat); return h.cut ? h.whole : (h.whole.length > 140 && h.rest ? h.rest : h.whole); };
  function host(u) { const m = String(u || "").match(/^https?:\/\/([^\/?#]+)/i); return m ? m[1].replace(/^www\./, "") : ""; }
  function themeOf(f) { return String(f.topic || "").split(/[,(]/)[0].replace(/\s+/g, " ").trim().slice(0, 90); }
  function initial(name) { const m = String(name || "?").match(/[\p{L}\p{N}]/u); return m ? m[0].toUpperCase() : "?"; }
  function hue(name) { let h = 0; const s = String(name || ""); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  const keyOf = (agent, title) => S.snap.week + "|" + norm(agent) + "|" + norm(title);
  const domKey = (agent, title) => "f:" + norm(agent) + "|" + norm(title);
  const CONF = [["confirm", "✓", "confirmed"], ["likely", "~", "likely"], ["unverif", "?", "unverified"]];
  function confOf(c) { const w = norm(c); const m = CONF.find((x) => w.indexOf(x[0]) === 0); return m ? { icon: m[1], word: m[2] } : (w ? { icon: "·", word: w } : null); }
  function tierCounts(findings) { const n = { high: 0, normal: 0, low: 0 }; findings.forEach((f) => { n[f.tier]++; }); return n; }

  // ================================================================ NAMED RENDER FUNCTIONS (restyle here / in the css)
  // v1.107.0 unread: a card carries the finding's identity (week comes from the open view); "New" marks the ones not read yet
  function newChip() { const c = el("span", "rs-newchip", "New"); c.title = "You have not read this yet."; return c; }
  function tagSeen(node, agent, f) { node.dataset.fid = f.id; node.dataset.fagent = agent; if (f.unread) node.classList.add("rs-unread"); }
  function renderHeader(S) {
    const head = el("div", "rs-head");
    const row = el("div", "rs-head-row");
    row.append(el("b", "rs-title", "My Research"));
    const snap = S.snap;
    if (snap && snap.ok && snap.week) row.appendChild(el("span", "rs-sub", "Week " + snap.week.slice(6)));
    row.appendChild(el("span", "rs-sp"));
    if (snap && snap.weeks && snap.weeks.length) {
      const lab = el("label", "rs-weeklab"); lab.append(el("span", "", "Week"));
      const sel = el("select", "rs-week"); sel.setAttribute("aria-label", "Choose a week");
      snap.weeks.forEach((w, i) => { const o = el("option", "", w + (i === 0 ? " (latest)" : "")); o.value = w; if (w === snap.week) o.selected = true; sel.appendChild(o); });
      sel.addEventListener("change", () => S.onWeek(sel.value));
      lab.appendChild(sel); row.appendChild(lab);
    }
    if (snap && snap.ok && snap.week) { const eb = btn("Export week summary", "rs-btn", S.onExport); eb.title = "Extra: write a readable summary of this week (_week_summary.md) next to the digests."; row.appendChild(eb); }
    const un = snap && snap.ok ? S.unreadTotal : 0;
    if (snap && snap.ok && snap.week) { const mr = btn("Mark all as read" + (un ? " (" + un + ")" : ""), "rs-btn rs-markall", S.onMarkAll); mr.disabled = !un; mr.title = "Mark every new finding as read, so the blue number on the My Research tile goes to 0."; row.appendChild(mr); }
    const rb = btn("Refresh", "rs-btn", S.onRefresh); rb.title = "Read the digest files again."; row.appendChild(rb);
    head.appendChild(row);
    // v1.104.0: the Ask row moved out of the fixed header into the scrolling page (see render()), so it scrolls away
    return head;
  }

  // the research REQUEST row in the header (was labelled Also research before v1.102.0): pick an agent, say what, send (same path as the message box)
  function renderAskBar(S) {
    const f = el("form", "rs-ask"); f.addEventListener("submit", (ev) => ev.preventDefault());
    // v1.102.0: worded as a REQUEST ("Ask <agent> to look into: ... [Send to <agent>]") so the agent picker can't be mistaken for a filter
    // (the filter is "Show:" above the stories). The picker sits inside the sentence; the Send button names the agent.
    f.setAttribute("aria-label", "Send a research request to an agent (this does not filter the stories)");
    const icon = el("span", "rs-ask-ic", "✉"); icon.setAttribute("aria-hidden", "true");
    const l1 = el("span", "rs-ask-l", "Ask");
    const sel = el("select", "rs-ask-a"); sel.setAttribute("aria-label", "Which agent should receive the research request");
    S.snap.digests.forEach((d) => { const o = el("option", "", d.agent); o.value = d.agent; sel.appendChild(o); });
    const id = nextId("ask"), l2 = el("label", "rs-ask-l", "to look into:"); l2.htmlFor = id;
    const ta = el("input", "rs-ask-t"); ta.type = "text"; ta.id = id; ta.maxLength = 1500; ta.placeholder = "what you want researched (sent as a message, not a filter)"; auto(ta);
    const out = el("span", "rs-ask-r"); out.setAttribute("role", "status"); out.setAttribute("aria-live", "polite");
    const send = el("button", "rs-btn rs-pri", ""); send.type = "submit";
    const name = () => { send.textContent = "Send to " + (sel.value || "agent"); };
    name(); sel.addEventListener("change", name);
    send.title = "Sent like a message typed in that agent's own message box.";
    f.addEventListener("submit", () => S.onAsk(sel.value, ta, send, out));
    f.append(icon, l1, sel, l2, ta, send, out);
    return f;
  }

  // legend: sticky at the top, never collapsible, one wrapping row, each item only if it is used in this view
  function renderLegend(S) {
    const bar = el("div", "rs-legend" + (S.legendOpen ? "" : " rs-lg-closed")); bar.setAttribute("role", "note"); bar.setAttribute("aria-label", "Legend");
    // wide window (>= 1000 px): a plain label and every item. Narrow: ONE row with a "Legend" toggle, open by default, remembered in the prefs file.
    bar.appendChild(el("b", "rs-lg-h", "Legend"));
    const tg = el("button", "rs-lg-toggle"); tg.type = "button"; tg.setAttribute("aria-controls", "rs-lg-items"); tg.setAttribute("aria-expanded", S.legendOpen ? "true" : "false");
    tg.textContent = S.legendOpen ? "Legend ▾" : "Legend ▸";
    tg.addEventListener("click", () => { S.legendOpen = !S.legendOpen; bar.classList.toggle("rs-lg-closed", !S.legendOpen); tg.setAttribute("aria-expanded", S.legendOpen ? "true" : "false"); tg.textContent = S.legendOpen ? "Legend ▾" : "Legend ▸"; if (api.setPrefs) api.setPrefs({ legendOpen: S.legendOpen }).catch(() => {}); });
    bar.appendChild(tg);
    const items = el("div", "rs-lg-items"); items.id = "rs-lg-items"; bar.appendChild(items);
    const all = allFindings(), ds = S.snap.digests;
    const add = (swCls, text) => { const i = el("span", "rs-lgi"); if (swCls) { const sw = el("span", "rs-sw " + swCls); sw.setAttribute("aria-hidden", "true"); i.appendChild(sw); } i.appendChild(document.createTextNode(text)); items.appendChild(i); };
    if (all.length) { add("rs-sw-high", "High tier ▲"); add("rs-sw-normal", "Normal ■"); add("rs-sw-low", "Low ▼"); }
    if (all.some((x) => x.f.confidence)) add("", "✓ confirmed · ~ likely · ? unverified");
    if (all.some((x) => x.f.worth)) add("", "👁 Needs your eye");
    if (all.some((x) => x.f.idea)) add("", "💡 Could be an idea");
    if (ds.some((d) => BAD[d.state])) { const i = el("span", "rs-lgi"); const sw = el("span", "rs-sw rs-sw-dash"); sw.setAttribute("aria-hidden", "true"); i.append(sw, document.createTextNode("Dashed tile = did not run")); items.appendChild(i); }
    if (all.length) { add("", "☆ Interesting: the COO learns your taste"); add("", "(last week N) = last week's number"); }
    return bar;
  }

  function renderStar(S, agent, f) {
    const b = el("button", "rs-star"); b.type = "button"; b.dataset.key = keyOf(agent, f.title);
    b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); S.onStar(agent, f, b); });
    paintStar(b, S.marked.has(b.dataset.key));
    return b;
  }
  function paintStar(b, on) {
    b.textContent = "";
    const g = el("span", "rs-star-g", on ? "★" : "☆"); g.setAttribute("aria-hidden", "true");
    b.append(g, el("span", "rs-star-t", "Interesting"));
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.title = on ? "Marked interesting - the COO reads this to learn your taste. Click to remove." : "Mark as interesting so the COO learns what you like.";
    b.classList.toggle("rs-on", on);
  }
  function renderTierChip(tier) { const t = TIER[tier] || TIER.normal; const s = el("span", "rs-chip rs-tc rs-tc-" + tier); const sh = el("span", "", t.shape); sh.setAttribute("aria-hidden", "true"); s.append(sh, el("span", "", t.word.toUpperCase())); return s; }

  function srcCount(f) {
    const p = f.sources.filter((s) => norm(s.kind) === "primary").length, sec = f.sources.filter((s) => norm(s.kind) === "secondary").length, other = f.sources.length - p - sec;
    const parts = [];
    if (p) parts.push(p + " primary"); if (sec) parts.push(sec + " secondary"); if (other) parts.push(other + " other");
    return parts.length ? parts.join(" · ") + (f.sources.length === 1 ? " source" : " sources") : "";
  }

  // sources: primary first; kind word, title, domain and an external-link icon with the words "opens in browser". Wrapped, never truncated.
  function renderSources(S, f) {
    const box = el("div", "rs-src");
    box.appendChild(el("h4", "rs-h4", "Sources"));
    if (!f.sources.length) { box.appendChild(el("p", "rs-muted", "No sources listed.")); return box; }
    const order = { primary: 0, secondary: 1 };
    const list = f.sources.slice().sort((a, b) => (order[norm(a.kind)] ?? 2) - (order[norm(b.kind)] ?? 2));
    const ul = el("ul", "rs-srclist");
    list.forEach((s) => {
      const li = el("li");
      li.appendChild(el("span", "rs-kind rs-k-" + (norm(s.kind) || "other"), s.kind || "source"));
      const label = s.title || host(s.url) || s.url;
      if (/^https?:\/\//i.test(s.url)) {
        const a = el("a", "rs-link"); a.href = s.url; a.setAttribute("dir", "ltr");
        a.append(auto(el("span", "rs-link-t", label)));
        const ic = el("span", "rs-ext", "↗"); ic.setAttribute("aria-hidden", "true");
        a.append(ic, el("span", "rs-ext-w", "opens in browser"));
        a.addEventListener("click", (ev) => { ev.preventDefault(); S.onLink(s.url); });
        li.appendChild(a);
        const h = host(s.url); if (h) li.appendChild(el("span", "rs-dom", h));
      } else { li.appendChild(auto(el("span", "rs-link-t", label))); if (s.url) li.appendChild(el("span", "rs-dom", s.url)); }
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }

  function renderIdeaButton(S, agent, f) {
    const k = keyOf(agent, f.title), done = S.ideas.has(k);
    const b = el("button", "rs-btn rs-idea", done ? "✓ In my ideas inbox" : "💡 Add to my ideas"); b.type = "button"; b.disabled = done;
    b.title = "Extra: adds this finding to shared_reports\\research\\ideas_inbox.json for the COO.";
    b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); S.onIdea(agent, f, b); });
    return b;
  }
  // the long text of a finding: three labelled blocks (16 px prose)
  function renderFindingBody(S, f, agent) {
    const b = el("div", "rs-fbody");
    b.appendChild(el("h4", "rs-h4", "What changed")); b.appendChild(auto(el("p", "rs-text", f.whatChanged || "Not given.")));
    b.appendChild(el("h4", "rs-h4", "Why it matters")); b.appendChild(auto(el("p", "rs-text", whyText(f) || "Not given.")));
    b.appendChild(renderSources(S, f));
    if (f.topic) b.appendChild(auto(el("p", "rs-facts", "Topic: " + f.topic)));
    if (agent) b.appendChild(renderWriteArea(S, agent, f.id, oneLine(f.soWhat) || f.title, f.idea ? renderIdeaButton(S, agent, f) : null));
    return b;
  }

  // ---- v1.89.0 "Write to <agent>": a button (primary while the box is open) and, when open, the box. Drafts are kept per finding.
  const WEEK_FID = "_week";            // the agent panel writes about the agent's whole week
  const MAX_WRITE = 4000;
  const wkeyOf = (agent, fid) => S.snap.week + "|" + norm(agent) + "|" + fid;
  const writePrefill = (agent, headline) => "> Re: " + agent + ", " + S.snap.week + ": " + (headline ? "\u201c" + headline + "\u201d" : "your research digest for this week") + "\n\n";
  function paintResult(out, res) {
    out.textContent = ""; out.className = "rs-write-r" + (res ? " rs-wr-" + res.cls : "");
    if (!res) return;
    const ic = el("span", "rs-wr-i", res.icon); ic.setAttribute("aria-hidden", "true");
    out.append(ic, el("b", "", res.word), document.createTextNode(" " + res.text));
  }
  function renderWriteArea(S, agent, fid, headline, extra) {
    const wrap = el("div", "rs-wa"); wrap.dataset.wkey = wkeyOf(agent, fid);
    const boxId = nextId("wb");
    const draw = () => {
      const k = wrap.dataset.wkey, on = S.writeOpen.has(k);
      wrap.textContent = "";
      const row = el("div", "rs-wa-row");
      const b = el("button", "rs-btn rs-wbtn" + (on ? " rs-pri" : "")); b.type = "button";
      b.setAttribute("aria-expanded", on ? "true" : "false"); b.setAttribute("aria-controls", boxId);
      const ic = el("span", "", "✉"); ic.setAttribute("aria-hidden", "true");
      b.append(ic, el("span", "", fid === WEEK_FID ? "Write to " + agent + " about this week" : "Write to " + agent));
      b.title = "Write straight to " + agent + ": ask, correct, approve or push back on " + (fid === WEEK_FID ? "this week's research." : "this finding.");
      b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); if (on) S.writeOpen.delete(k); else S.writeOpen.add(k); draw(); const t = wrap.querySelector(on ? ".rs-wbtn" : ".rs-write-t"); if (t) t.focus(); });
      row.appendChild(b);
      if (extra) row.appendChild(extra);
      wrap.appendChild(row);
      if (on) { const box = renderWriteBox(S, agent, fid, headline, k, () => { S.writeOpen.delete(k); draw(); const t = wrap.querySelector(".rs-wbtn"); if (t) t.focus(); }); box.id = boxId; wrap.appendChild(box); }
      else if (S.wres.has(k)) { const out = el("p", "rs-write-r"); out.setAttribute("role", "status"); paintResult(out, S.wres.get(k)); wrap.appendChild(out); }
    };
    wrap.redraw = draw; draw();
    return wrap;
  }
  function renderWriteBox(S, agent, fid, headline, k, onClose) {
    const box = el("div", "rs-write");
    const id = nextId("w"), pre = writePrefill(agent, headline);
    const lab = el("label", "rs-write-l", "Your message to " + agent); lab.htmlFor = id;
    const ta = el("textarea", "rs-write-t"); ta.id = id; ta.rows = 5; ta.maxLength = MAX_WRITE + 500; auto(ta);
    ta.value = drafts.has(k) ? drafts.get(k) : pre;
    const cnt = el("span", "rs-write-n");
    const count = () => { cnt.textContent = ta.value.length + " / " + MAX_WRITE; cnt.classList.toggle("rs-write-over", ta.value.length > MAX_WRITE); };
    count();
    ta.addEventListener("input", () => { drafts.set(k, ta.value); count(); });
    const hint = el("p", "rs-write-h", "Goes straight to " + agent + "'s chat, with the reference line so it knows what you mean. Ctrl+Enter sends · Esc closes (the draft is kept).");
    const acts = el("div", "rs-write-acts");
    const send = el("button", "rs-btn rs-pri rs-wsend"); send.type = "button";
    const si = el("span", "", "➤"); si.setAttribute("aria-hidden", "true"); send.append(si, el("span", "", "Send to " + agent));
    send.disabled = S.wsending.has(k);
    const out = el("p", "rs-write-r"); out.setAttribute("role", "status"); out.setAttribute("aria-live", "polite");
    if (S.wsending.has(k)) paintResult(out, { cls: "wait", icon: "…", word: "Sending.", text: "Checking that it landed." }); else if (S.wres.has(k)) paintResult(out, S.wres.get(k));
    const go = () => S.onWrite(agent, fid, ta, send, out, pre, k);
    send.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); go(); });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    });
    acts.append(send, btn("Close", "rs-btn", onClose), el("span", "rs-sp"), cnt);
    box.append(lab, ta, hint, acts, out);
    return box;
  }

  // a finding card, collapsed: tier bar; row 1 chips + star; row 2 the "so what" headline; row 3 agent and title + source count; row 4 "Details"
  function renderFindingCard(S, agent, f, opts) {
    const o = opts || {};
    const card = el("div", "rs-fcard rs-ft-" + f.tier);
    card.dataset.fkey = domKey(agent, f.title); tagSeen(card, agent, f);
    const id = nextId("f"), k = keyOf(agent, f.title);
    const isOpen = S.openF.has(k);
    const r1 = el("div", "rs-r1");
    if (f.unread) r1.appendChild(newChip());
    r1.appendChild(renderTierChip(f.tier));
    const cf = confOf(f.confidence); if (cf) { const c = el("span", "rs-chip"); const ic = el("span", "", cf.icon); ic.setAttribute("aria-hidden", "true"); c.append(ic, el("span", "", cf.word)); r1.appendChild(c); }
    if (f.worth) r1.appendChild(el("span", "rs-chip", "👁 Needs your eye"));
    if (f.idea) r1.appendChild(el("span", "rs-chip", "💡 Idea"));
    const tp = themeOf(f); if (tp) r1.appendChild(el("span", "rs-chip rs-chip-theme", "# " + tp));
    if (S.last && S.last.week === S.snap.week && norm(S.last.agent) === norm(agent) && norm(S.last.finding) === norm(f.title)) r1.appendChild(el("span", "rs-lastmark", "◂ Last opened"));
    r1.appendChild(el("span", "rs-sp"));
    r1.appendChild(renderStar(S, agent, f));
    const head = el("button", "rs-fhead"); head.type = "button";
    head.setAttribute("aria-expanded", isOpen ? "true" : "false"); head.setAttribute("aria-controls", id);
    const so = oneLine(f.soWhat) || f.title;
    head.appendChild(auto(el("span", "rs-so" + (so.length > 90 ? " rs-so-sm" : ""), so)));
    const r3 = el("span", "rs-r3"); r3.appendChild(auto(el("span", "rs-r3t", (o.hideAgent ? "" : agent + " · ") + f.title)));
    const sc = srcCount(f); if (sc) r3.appendChild(el("span", "rs-srcn", sc));
    head.appendChild(r3);
    const more = el("span", "rs-more"); const car = el("span", "rs-caret", isOpen ? "▾" : "▸"); const mt = el("span", "", isOpen ? " Hide details" : " Details: what changed · why it matters · sources"); more.append(car, mt); head.appendChild(more);
    const body = el("div", "rs-fexp"); body.id = id; body.hidden = !isOpen;
    if (isOpen) body.appendChild(renderFindingBody(S, f, agent));
    head.addEventListener("click", () => {
      const now = head.getAttribute("aria-expanded") !== "true";
      head.setAttribute("aria-expanded", now ? "true" : "false"); car.textContent = now ? "▾" : "▸"; mt.textContent = now ? " Hide details" : " Details: what changed · why it matters · sources";
      if (now) { S.openF.add(k); if (!body.firstChild) body.appendChild(renderFindingBody(S, f, agent)); S.onOpened(agent, f); } else S.openF.delete(k);
      body.hidden = !now;
    });
    card.append(r1); addDates(card, f); card.append(head, body);
    return card;
  }

  // the COO's five: large numbered cards, the "so what" always visible; a click goes to the full finding in its agent block and opens it
  function renderPickCard(S, p, n, curated) {
    const c = el("article", "rs-pick" + (p.finding ? "" : " rs-pick-nolink"));
    const go = el(p.finding ? "button" : "div", "rs-pick-go"); if (p.finding) { go.type = "button"; go.title = "Go to the full finding below and open it"; }
    const top = el("span", "rs-pick-top");
    const num = el("span", "rs-num", String(n)); num.setAttribute("aria-hidden", "true");
    const av = el("span", "rs-av", initial(p.agent)); av.style.setProperty("--rs-h", String(hue(p.agent))); av.setAttribute("aria-hidden", "true");
    const chip = el("span", "rs-agentchip"); chip.append(av, el("span", "", p.agent));
    top.append(num, chip, el("span", "rs-sp"));
    if (p.finding) top.appendChild(renderTierChip(p.finding.tier));
    go.append(top); if (p.finding && p.finding.dateLine) go.appendChild(auto(el("span", "rs-dates", p.finding.dateLine)));
    go.append(auto(el("span", "rs-pick-title", p.title)));
    const sw = p.why || (p.finding ? oneLine(p.finding.soWhat) : "");
    if (sw) { const w = el("span", "rs-pick-why"); w.append(el("span", "rs-pick-wl", curated && p.why ? "Why read this: " : "So what: "), auto(el("span", "", sw))); go.appendChild(w); }
    if (!p.finding) go.appendChild(el("span", "rs-muted", "The finding itself was not found in this week's digest."));
    else go.appendChild(el("span", "rs-more", "↓ Open the full finding"));
    if (p.finding) go.addEventListener("click", () => S.onJump(p.agent, p.finding));
    c.appendChild(go);
    if (p.finding) {   // v1.89.0: write to the agent straight from the five (opens the full finding below with the box open)
      const w = el("button", "rs-btn rs-pick-w"); w.type = "button";
      const ic = el("span", "", "✉"); ic.setAttribute("aria-hidden", "true"); w.append(ic, el("span", "", "Write to " + p.agent));
      w.title = "Open this finding below with a message box to " + p.agent;
      w.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); S.onJump(p.agent, p.finding, true); });
      c.appendChild(w);
    }
    return c;
  }
  function renderTopFive(S) {
    const t = S.snap.top5, sec = el("section", "rs-top");
    sec.setAttribute("aria-label", "This week's five");
    const h = el("div", "rs-top-h");
    h.appendChild(el("h2", "rs-h2", "The five to read first"));
    if (t.state === "curated") h.appendChild(el("span", "rs-badge rs-b-ok", "✓ Curated by " + (t.pickedBy || "the COO") + (t.pickedAt ? ", " + t.pickedAt.slice(0, 10) : "")));
    else h.appendChild(el("span", "rs-badge rs-b-warn", "⚠ Not yet curated"));
    sec.appendChild(h);
    if (t.state !== "curated") {
      sec.appendChild(el("p", "rs-note", (t.state === "invalid" ? t.note + " " : "") + "The COO has not picked this week's five yet. Below is a preview only: the first finding of the first five agents, in alphabetical order. It is not a judgement of what matters."));
    }
    if (!t.picks.length) { sec.appendChild(el("p", "rs-muted", "There are no findings to preview.")); return sec; }
    // v1.102.0: the five follow the filters in the List view too (original rank kept)
    const shown = anyFilter() ? RF.filterPicks(t.picks, S.f, isMarked) : t.picks.map((p, i) => Object.assign({ rank: i + 1 }, p));
    if (!shown.length) { sec.appendChild(renderFilterEmpty(S, "None of this week's five match these filters.")); return sec; }
    const grid = el("div", "rs-grid");
    shown.forEach((p) => grid.appendChild(renderPickCard(S, p, p.rank, t.state === "curated")));
    sec.appendChild(grid);
    return sec;
  }

  // Contradictions (from the COO's weekly digest, when it exists): a small closed section. Research cost is intentionally not shown anywhere.
  function renderCoo(S) {
    const c = S.snap.coo;
    if (!c) return null;
    const wrap = el("div", "rs-coo");
    const mk = (title, count, fill) => {
      const sec = el("section", "rs-mini"), id = nextId("m");
      const h = el("button", "rs-mini-h"); h.type = "button"; h.setAttribute("aria-expanded", "false"); h.setAttribute("aria-controls", id);
      h.append(el("span", "rs-caret", "▸"), el("b", "", title), el("span", "rs-sub", count));
      const body = el("div", "rs-mini-b"); body.id = id; body.hidden = true;
      h.addEventListener("click", () => { const now = h.getAttribute("aria-expanded") !== "true"; h.setAttribute("aria-expanded", now ? "true" : "false"); h.firstChild.textContent = now ? "▾" : "▸"; if (now && !body.firstChild) fill(body); body.hidden = !now; });
      sec.append(h, body); return sec;
    };
    if (c.contradictions.length) wrap.appendChild(mk("Contradictions", c.contradictions.length + (c.contradictions.length === 1 ? " item" : " items"), (b) => c.contradictions.forEach((x) => {
      if (x.between && x.between.length) b.appendChild(el("p", "rs-facts", "Between: " + x.between.join(" and ")));
      b.appendChild(auto(el("p", "rs-text", x.about)));
    })));
    return wrap;
  }

  // v1.102.0: ONE filter state (S.f) and the pure logic in research-filter.js drive the hero, the five, the grid, the List view and every count
  const RF = window.researchFilter;
  function allFindings() { return RF.flatten(S.snap.digests); }
  const isMarked = (agent, f) => S.marked.has(keyOf(agent, f.title));
  function matches(agent, f) { return RF.matches(agent, f, S.f, isMarked); }
  const anyFilter = () => RF.isActive(S.f);
  const noFilters = () => RF.noFilters();
  const scoped = () => allFindings().filter((x) => RF.inScope(x.agent, x.f, S.f));   // agent + search: the base of every count

  // AT A GLANCE: 6 tiles, each a button that applies the matching filter; big number, bold label, last week's number
  // v1.102.0: counts follow the agent filter and the search; "Agents ran" no longer pretends to filter (it jumps to the agent tiles)
  function renderGlance(S) {
    const all = scoped(), ds = S.snap.digests.filter((d) => !S.f.agent || norm(d.agent) === norm(S.f.agent)), P = S.f.agent ? null : S.snap.prevStats;
    const n = (st) => ds.filter((d) => d.state === st).length;
    const failed = ds.filter((d) => BAD[d.state]).length;
    const sec = el("section", "rs-sec"); sec.appendChild(el("h2", "rs-secl", "This week at a glance"));
    const row = el("div", "rs-glance");
    const items = [
      ["", all.length, "Findings", P ? "last week " + P.findings : "", () => S.clearChips(), false, !RF.chipActive(S.f), "Show all findings (clears the tier and flag filters)"],
      ["▲ ", all.filter((x) => x.f.tier === "high").length, "High tier", P ? "last week " + P.high : "", () => S.setFilter("tier", "high"), true, S.f.tier === "high", "Show only high-tier findings"],
      ["👁 ", all.filter((x) => x.f.worth).length, "Needs your eye", P ? "last week " + P.worth : "", () => S.setFilter("worth"), false, S.f.worth, "Show only findings the agent flagged for your eye"],
      ["💡 ", all.filter((x) => x.f.idea).length, "Idea candidates", P ? "last week " + P.idea : "", () => S.setFilter("idea"), false, S.f.idea, "Show only findings that could become an idea"],
      ["", n("ok"), "Agents ran", P ? "last week " + P.ran : "", () => S.jumpToAgents(), false, null, "Go to the agent tiles (this is a count, not a filter)"],
      ["", failed, "Did not run", n("skipped") + " skipped · " + failed + " failed" + (n("not-due") ? " · " + n("not-due") + " not due" : ""), () => S.setFilter("noRun"), false, S.f.noRun, "Show only the agents that did not run (no stories)"],
    ];
    items.forEach((x) => {
      const c = el("button", "rs-gl" + (x[5] ? " rs-gl-hi" : "")); c.type = "button"; if (x[6] !== null) c.setAttribute("aria-pressed", x[6] ? "true" : "false");
      c.title = x[7]; c.addEventListener("click", x[4]);
      c.append(el("span", "rs-gl-n", String(x[1])), el("span", "rs-gl-l", x[0] + x[2]));
      if (x[3]) c.appendChild(el("span", "rs-gl-p", x[3]));
      row.appendChild(c);
    });
    sec.appendChild(row);
    return sec;
  }

  // THEMES: pill chips, name bold, count badge, "N agents" when several agents share it, a high tag; a click filters to that theme
  function renderThemes(S) {
    const m = new Map();
    scoped().forEach((x) => { const t = themeOf(x.f); if (t) { const e = m.get(t) || { n: 0, a: new Set(), high: false }; e.n++; e.a.add(x.agent); if (x.f.tier === "high") e.high = true; m.set(t, e); } });
    if (m.size < 2) return null;
    const sec = el("section", "rs-sec"); sec.appendChild(el("h2", "rs-secl", "Themes"));
    const wrap = el("div", "rs-themes"); wrap.setAttribute("role", "group"); wrap.setAttribute("aria-label", "Themes");
    [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12).forEach(([t, e]) => {
      const b = el("button", "rs-theme"); b.type = "button"; b.setAttribute("aria-pressed", S.f.topic === t ? "true" : "false");
      b.title = t + " - " + e.n + " finding(s) from " + e.a.size + " agent(s)"; b.setAttribute("aria-label", t + ", " + e.n + " finding" + (e.n === 1 ? "" : "s") + (e.a.size > 1 ? " from " + e.a.size + " agents" : ""));
      b.append(el("span", "rs-theme-n", t), el("i", "rs-theme-c", e.a.size > 1 ? e.a.size + " agents" : String(e.n)));
      if (e.high) b.appendChild(el("small", "", "▲ high"));
      b.addEventListener("click", () => S.setFilter("topic", t)); wrap.appendChild(b);
    });
    sec.appendChild(wrap);
    return sec;
  }

  // filter chips with counts + Clear filters + Expand/Collapse all
  function renderFilters(S) {
    const bar = el("div", "rs-filters"); bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Filter the findings");
    const all = allFindings(), C = RF.counts(all, S.f, isMarked);
    const chip = (label, count, on, fn) => { const b = el("button", "rs-fchip"); b.type = "button"; b.setAttribute("aria-pressed", on ? "true" : "false"); b.append(el("span", "", label), el("span", "rs-fc", String(count))); b.addEventListener("click", fn); return b; };
    bar.appendChild(chip("👁 Needs your eye", C.worth, S.f.worth, () => S.setFilter("worth")));
    bar.appendChild(chip("💡 Idea", C.idea, S.f.idea, () => S.setFilter("idea")));
    bar.appendChild(chip("★ Interesting", C.starred, S.f.starred, () => S.setFilter("starred")));
    ["high", "normal", "low"].forEach((t) => bar.appendChild(chip(TIER[t].shape + " " + TIER[t].word, C[t], S.f.tier === t, () => S.setFilter("tier", t))));
    const clr = btn("Clear filters", "rs-btn rs-clear", S.clearFilters); clr.disabled = !anyFilter(); bar.appendChild(clr);
    bar.appendChild(el("span", "rs-sp"));
    bar.appendChild(el("span", "rs-showing", (anyFilter() ? "Showing " + C.shown + " of " + C.total : "Showing all " + C.total) + ", sorted: high first, then needs your eye"));
    // Expand/Collapse act on the agent tiles of the list below; in the Magazine they also open/close every "Read the full finding"
    bar.appendChild(btn("Expand all", "rs-btn", () => S.setAll(true)));
    bar.appendChild(btn("Collapse all", "rs-btn", () => S.setAll(false)));
    const wrap = el("div"); wrap.appendChild(bar);
    const act = RF.activeLabels(S.f);
    if (act.length) {
      const ar = el("div", "rs-active"); ar.setAttribute("role", "group"); ar.setAttribute("aria-label", "Active filters");
      ar.appendChild(el("span", "rs-active-l", "Filtering by:"));
      act.forEach((a) => { const b = btn("", "rs-achip", () => S.clearOne(a.key)); b.dataset.k = a.key; b.setAttribute("aria-label", "Remove filter " + a.label); b.append(auto(el("span", "", a.label)), el("b", "", " ×")); ar.appendChild(b); });
      wrap.appendChild(ar);
    }
    return wrap;
  }

  // v1.102.0 the find bar at the top of the stories (both views): "Show: [All agents v]" + search + "N of M". Built once per render,
  // never redrawn while typing (focus and caret stay); only its count line updates.
  function renderFindBar(S) {
    const bar = el("div", "rs-findbar"); bar.setAttribute("role", "search"); bar.setAttribute("aria-label", "Filter the stories");
    const lab = el("label", "rs-show-l"); const sid = nextId("show"); lab.htmlFor = sid; lab.textContent = "Show:";
    const sel = el("select", "rs-show"); sel.id = sid; sel.title = "Show only one agent's stories (filters the hero, the five, the grid and the counts)";
    const opts = RF.agentOptions(S.snap.digests), total = allFindings().length;
    const o0 = el("option", "", "All agents (" + total + ")"); o0.value = ""; sel.appendChild(o0);
    opts.forEach((x) => { const o = el("option", "", x.agent + " (" + x.n + ")"); o.value = x.agent; sel.appendChild(o); });
    sel.value = S.f.agent && opts.some((x) => x.agent === S.f.agent) ? S.f.agent : "";
    sel.addEventListener("change", () => S.setAgent(sel.value));
    const qid = nextId("q"), ql = el("label", "rs-q-l", "Search"); ql.htmlFor = qid;
    const q = el("input", "rs-q"); q.type = "search"; q.id = qid; q.maxLength = 200; q.value = S.f.q || ""; auto(q);
    q.placeholder = "Search headlines, agents, sources, themes"; q.setAttribute("aria-describedby", qid + "-n");
    q.addEventListener("input", () => S.setQuery(q.value));   // no debounce timer (the view keeps only the toast timer); a week is a few hundred findings at most
    q.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (q.value) { q.value = ""; S.setQuery(""); } } });
    const cnt = el("span", "rs-q-n"); cnt.id = qid + "-n"; cnt.setAttribute("role", "status"); cnt.setAttribute("aria-live", "polite");
    const act = el("span", "rs-active"); act.setAttribute("aria-label", "Active filters");
    bar.append(lab, sel, ql, q, cnt, act);
    bar.paint = () => {
      const C = RF.counts(allFindings(), S.f, isMarked); cnt.textContent = anyFilter() ? "Showing " + C.shown + " of " + C.total + " stories" : "All " + C.total + " stories"; sel.value = S.f.agent || ""; if (document.activeElement !== q) q.value = S.f.q || "";
      act.textContent = "";   // the active filters as chips with an x, right next to the stories they filter
      RF.activeLabels(S.f).forEach((a) => { const b = btn("", "rs-achip", () => S.clearOne(a.key)); b.dataset.k = a.key; b.setAttribute("aria-label", "Remove filter " + a.label); b.append(auto(el("span", "", a.label)), el("b", "", " ×")); act.appendChild(b); });
      if (anyFilter()) act.appendChild(btn("Clear filters", "rs-btn", S.clearFilters));
    };
    bar.paint();
    return bar;
  }

  // tier bar of 3 segments sized by count + text "▲4 · ■5 · ▼2 (last week 11)"
  function renderTierBar(d) {
    const n = tierCounts(d.findings), box = el("div", "rs-tb");
    const bar = el("div", "rs-tbar"); bar.setAttribute("aria-hidden", "true");
    ["high", "normal", "low"].forEach((t) => { if (n[t]) { const seg = el("span", "rs-ts-" + t); seg.style.flex = String(n[t]); bar.appendChild(seg); } });
    box.append(bar, el("div", "rs-tbl", "▲" + n.high + " · ■" + n.normal + " · ▼" + n.low + (d.prevFindings != null ? " (last week " + d.prevFindings + ")" : "")));
    return box;
  }

  // an agent tile (4 per row) and, when opened, its full-width panel; closed by default. A tile that did not run is dashed and muted.
  function renderAgentTile(S, d, grid) {
    const c = "hsl(" + hue(d.agent) + " 45% 36%)";
    const bad = !!BAD[d.state], notDue = d.state === "not-due", skipped = d.state === "skipped";
    const shown = d.findings.filter((f) => matches(d.agent, f));
    const id = nextId("a"), isOpen = S.openA.has(d.agent);
    const idle = bad || notDue || (!d.findings.length && !d.summary);
    const tile = el("button", "rs-tile" + (bad ? " rs-tile-bad" : notDue ? " rs-tile-due" : ""));
    tile.type = "button"; tile.style.setProperty("--rs-c", c); tile.dataset.agent = norm(d.agent);
    tile.setAttribute("aria-expanded", isOpen ? "true" : "false"); tile.setAttribute("aria-controls", id);
    const top = el("span", "rs-tile-top");
    const av = el("span", "rs-tav", initial(d.agent)); av.setAttribute("aria-hidden", "true");
    top.append(av, el("span", "rs-tile-nm", d.agent), el("span", "rs-tile-ct", idle ? "—" : String(anyFilter() ? shown.length : d.findings.length)));
    tile.appendChild(top);
    const prevTxt = d.prevFindings != null ? " · last week " + d.prevFindings + " findings" : "";
    if (bad || notDue) {
      tile.appendChild(el("span", "rs-tile-msg", notDue ? "Not due yet" + prevTxt : d.state === "did-not-run" ? "Did not run this week" + prevTxt : d.state === "ran-no-digest" ? "Ran, but wrote no digest" + prevTxt : d.label + prevTxt));
    } else {
      if (d.findings.length) tile.appendChild(renderTierBar(d));
      else tile.appendChild(el("span", "rs-tile-msg", skipped ? "Skipped this week" + prevTxt : "No findings"));
    }
    const stTxt = { ok: "✓ Ran", skipped: "⏭ Skipped", "not-due": "… Not due", "did-not-run": "✗ Did not run" }[d.state] || (d.label ? "⚠ " + d.label : "");
    tile.appendChild(el("span", "rs-tile-st", stTxt + (isOpen ? "" : "  ▸ open")));
    const panel = el("div", "rs-panel"); panel.id = id; panel.hidden = !isOpen; panel.style.setProperty("--rs-c", c);
    const fill = () => {
      panel.textContent = "";
      panel.appendChild(el("h3", "rs-panel-h", d.agent));
      if (!d.noDigest && d.state !== "too-big" && d.state !== "unreadable") panel.appendChild(renderWriteArea(S, d.agent, WEEK_FID, ""));
      if (d.summary) { panel.appendChild(el("h4", "rs-h4", "What it researched")); panel.appendChild(auto(el("p", "rs-text rs-sum", d.summary))); }
      if (d.note) panel.appendChild(auto(el("p", "rs-note", d.note)));
      if (!d.findings.length && !d.note) panel.appendChild(el("p", "rs-muted", "Nothing to show for this agent this week."));
      shown.forEach((f) => panel.appendChild(renderFindingCard(S, d.agent, f, { hideAgent: true })));
    };
    if (isOpen) fill();
    tile.addEventListener("click", () => {
      const now = tile.getAttribute("aria-expanded") !== "true";
      tile.setAttribute("aria-expanded", now ? "true" : "false");
      const st = tile.querySelector(".rs-tile-st"); st.textContent = st.textContent.replace(/\s+▸ open$/, "") + (now ? "" : "  ▸ open");
      if (now) { S.openA.add(d.agent); if (!panel.firstChild) fill(); } else S.openA.delete(d.agent);
      panel.hidden = !now;
    });
    grid.append(tile, panel);
  }

  // empty / failed states in plain words, each with Retry
  function renderState(title, text) {
    const c = el("section", "rs-empty");
    c.appendChild(el("b", "", title));
    if (text) c.appendChild(el("p", "rs-text", text));
    const r = btn("Retry", "rs-btn rs-pri", S.onRefresh); r.style.alignSelf = "flex-start"; c.appendChild(r);
    return c;
  }

  // ================================================================ v1.91.0 MAGAZINE VIEW (look: styles-research-mag.css, tokens --rm-*)
  // Hero = the COO's first pick; then the other four and every other finding as article cards (image band or data card, chips, serif
  // headline, so-what, a chart when the finding's own text has comparable figures, sources, "Read the full finding", reply box).
  // Images: asked from main only when a card scrolls into view (one IntersectionObserver); main returns a cached local file or nothing.
  // The card shows its data card first and swaps the image in when it arrives. Never a remote URL in the page.
  const MAG_PAGE = 12;
  const imgKeyOf = (agent, f) => S.snap.week + "|" + norm(agent) + "|" + f.id;
  function sourceLine(f) {
    const m = new Map();
    f.sources.forEach((s) => { const h = host(s.url) || ""; if (h) m.set(h, (m.get(h) || 0) + 1); });
    if (!m.size) return "";
    const parts = [...m.entries()].slice(0, 3).map(([h, n]) => h + (n > 1 ? " (" + n + ")" : ""));
    return f.sources.length + (f.sources.length === 1 ? " source: " : " sources: ") + parts.join(" · ") + (m.size > 3 ? " · …" : "");
  }
  function renderViewSwitch(S) {
    const row = el("div", "rm-switch");
    const seg = el("div", "rm-seg"); seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "How to show the findings");
    [["magazine", "Magazine"], ["list", "List"]].forEach(([v, word]) => {
      const b = el("button", "", word); b.type = "button"; b.setAttribute("aria-pressed", S.view === v ? "true" : "false");
      b.addEventListener("click", () => S.setView(v));
      seg.appendChild(b);
    });
    row.append(el("span", "rm-switch-n", "View"), seg, el("span", "rm-switch-n", S.view === "magazine" ? "Magazine: pictures, charts and a reply box on every story. List: the compact list." : "List: the compact list. Magazine: pictures, charts and a reply box."));
    return row;
  }
  // one chip for the writer and the rank: "Legal Agent · #2 of the five"
  function renderByline(agent, extra) {
    const b = el("span", "rm-by"); const dot = el("i"); dot.setAttribute("aria-hidden", "true"); b.style.setProperty("--rm-h", String(hue(agent)));
    const t = agent + (extra ? " · " + extra : ""); b.title = t;   // the chip may shrink with an ellipsis: the full text stays readable
    b.append(dot, el("span", "", t)); return b;
  }
  function renderMagChips(S, agent, f, extra) {
    const r = el("div", "rm-chips");
    if (f.unread) r.appendChild(newChip());
    r.appendChild(renderTierChip(f.tier));
    const cf = confOf(f.confidence); if (cf) { const c = el("span", "rs-chip"); const ic = el("span", "", cf.icon + " "); ic.setAttribute("aria-hidden", "true"); c.append(ic, el("span", "", cf.word.charAt(0).toUpperCase() + cf.word.slice(1))); r.appendChild(c); }
    if (f.worth) r.appendChild(el("span", "rs-chip", "👁 Needs your eye"));
    if (f.idea) r.appendChild(el("span", "rs-chip", "💡 Idea"));
    r.appendChild(renderByline(agent, extra));
    return r;
  }
  // the data card: the finding's own big figure (when it has a chart), else the agent's colour tile with its initial. Never an invented picture.
  function renderDataCard(agent, f) {
    const d = el("div", "rm-data"); d.style.setProperty("--rm-h", String(hue(agent)));
    if (f.chart && f.chart.bars && f.chart.bars.length) {
      const n = el("div", "rm-data-n");
      if (f.chart.bars.length === 2) { const ar = el("span", "", "→"); ar.setAttribute("aria-hidden", "true"); n.append(document.createTextNode(f.chart.bars[0].text + " "), ar, document.createTextNode(" " + f.chart.bars[1].text)); n.setAttribute("aria-label", f.chart.bars[0].text + " to " + f.chart.bars[1].text); }
      else n.textContent = f.chart.figure;
      d.append(n, auto(el("div", "rm-data-l", f.chart.figureLine || f.chart.title)));
    } else {
      const ini = el("div", "rm-data-ini", initial(agent)); ini.setAttribute("aria-hidden", "true");
      d.append(ini, el("div", "rm-data-a", agent));
      const tp = themeOf(f); if (tp) d.appendChild(auto(el("div", "rm-data-l", tp)));
    }
    return d;
  }
  function renderMedia(S, agent, f) {
    const m = el("div", "rm-media"); m.dataset.ikey = imgKeyOf(agent, f);
    const paint = () => {
      m.textContent = ""; m.classList.remove("rm-logo");
      const r = S.imgs.get(m.dataset.ikey);
      const hero = m.closest ? m.closest(".rm-hero") : null;          // the hero is text-first until a picture arrives
      const has = !!(r && r.ok && !S.wrong.has(m.dataset.ikey));
      if (hero) hero.classList.toggle("rm-hero-img", has);
      if (!has) { m.appendChild(renderDataCard(agent, f)); return; }
      const img = el("img"); img.alt = r.art ? "Illustration made for this story" : "Lead image from " + (r.domain || "the source page"); img.decoding = "async"; img.src = r.url;
      img.addEventListener("error", () => { S.imgs.set(m.dataset.ikey, { ok: false }); paint(); });
      if (r.logo) m.classList.add("rm-logo");
      m.appendChild(img);
      m.appendChild(el("span", "rm-cap", "Image: " + (r.domain || "source page")));
      const w = el("button", "rm-wrong", "This image is wrong"); w.type = "button";
      w.title = "Hide this picture for this finding and show the data card instead (remembered).";
      w.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); S.onWrongImage(agent, f, m); });
      m.appendChild(w);
    };
    m.paint = paint; paint();
    if (!S.imgs.has(m.dataset.ikey) && !S.wrong.has(m.dataset.ikey) ) { m.dataset.want = "1"; m.agent = agent; m.finding = f; if (S.io) S.io.observe(m); }
    return m;
  }
  // horizontal bars, value at the end of each bar, a title saying what it is, the source named. Only figures that are in the finding.
  function renderChart(agent, f) {
    const c = f.chart; if (!c || !c.bars || c.bars.length < 2) return null;
    const fig = el("figure", "rm-chart");
    fig.appendChild(auto(el("div", "rm-chart-t", c.title)));
    const max = Math.max(...c.bars.map((b) => b.value)) || 1;
    c.bars.forEach((b, i) => {
      const row = el("div", "rm-bar");
      const tr = el("span", "rm-bar-tr");
      const bar = el("i", /, flat$/.test(b.label) ? "rm-flat" : i === c.bars.length - 1 || /after$/i.test(b.label) || /^From /.test(b.label) ? "rm-strong" : "");
      bar.style.width = Math.max(3, Math.round((b.value / max) * 100)) + "%"; bar.setAttribute("aria-hidden", "true");
      tr.append(bar, el("b", "", b.text));
      row.append(auto(el("span", "rm-bar-l", b.label)), tr);
      fig.appendChild(row);
    });
    const src = f.sources.map((s) => host(s.url)).find(Boolean);
    fig.appendChild(el("figcaption", "", "Figures as written in the finding · " + agent + (src ? " · source: " + src : "")));
    return fig;
  }
  // reply to the writer: reuses the v1.89.0 research-write path (S.onWrite) - the same verified delivery, no new transport
  const FOLLOW_UP = (f) => "Please write a follow-up article on “" + f.title.slice(0, 200) + "” for your next digest: what has changed since, what it means for us, and what I should decide or do.";
  function renderReply(S, agent, f, opts) {
    const o = opts || {};
    const k = wkeyOf(agent, f.id);
    const wrap = el("div", "rs-wa rm-reply"); wrap.dataset.wkey = k;
    const draw = () => {
      wrap.textContent = "";
      const open = o.alwaysOpen || S.writeOpen.has(k);
      const id = nextId("rm");
      wrap.classList.toggle("rm-closed", !open);
      if (open) { const h = el("label", "rm-reply-h", "✎ Reply to " + agent); h.htmlFor = id; wrap.appendChild(h); }
      const out = el("p", "rm-state"); out.setAttribute("role", "status"); out.setAttribute("aria-live", "polite");
      const btns = el("div", "rm-btns");
      let send = null;
      if (open) {
        const ta = el("textarea", "rm-ta"); ta.id = id; ta.rows = o.alwaysOpen ? 3 : 4; ta.maxLength = MAX_WRITE + 500; auto(ta);
        ta.placeholder = "Ask, correct, approve or push back. It goes straight to " + agent + ".";
        ta.value = drafts.get(k) || "";
        ta.addEventListener("input", () => drafts.set(k, ta.value));
        send = el("button", "rm-btn rm-pri", "Send to " + agent); send.type = "button"; send.disabled = S.wsending.has(k);
        const go = () => S.onWrite(agent, f.id, ta, send, out, "", k);
        send.addEventListener("click", (ev) => { ev.preventDefault(); go(); });
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); }
          else if (e.key === "Escape" && !o.alwaysOpen) { e.preventDefault(); e.stopPropagation(); S.writeOpen.delete(k); draw(); const b = wrap.querySelector(".rm-open"); if (b) b.focus(); }
        });
        wrap.appendChild(ta);
        btns.appendChild(send);
      } else {
        const ob = el("button", "rm-btn rm-pri rm-open", "✎ Reply to " + agent); ob.type = "button"; ob.setAttribute("aria-expanded", "false");
        ob.addEventListener("click", (ev) => { ev.preventDefault(); S.writeOpen.add(k); draw(); const t = wrap.querySelector(".rm-ta"); if (t) t.focus(); });
        btns.appendChild(ob);
      }
      const fu = el("button", "rm-btn", "Ask for a follow-up article"); fu.type = "button"; fu.disabled = S.wsending.has(k);
      fu.title = "Sends " + agent + ": " + FOLLOW_UP(f);
      fu.addEventListener("click", (ev) => { ev.preventDefault(); S.onWrite(agent, f.id, { value: FOLLOW_UP(f), focus() {} }, send || fu, out, "", k); });
      btns.appendChild(fu);
      wrap.appendChild(btns);
      // second, quieter row: Interesting, Add to my ideas, Close
      const icons = el("div", "rm-icons");
      icons.appendChild(renderStar(S, agent, f));
      if (f.idea) icons.appendChild(renderIdeaButton(S, agent, f));
      if (open && !o.alwaysOpen) icons.appendChild(btn("Close", "rm-btn rm-small", () => { S.writeOpen.delete(k); draw(); }));
      wrap.appendChild(icons);
      if (S.wsending.has(k)) paintMagState(out, { cls: "wait", word: "Sending.", text: "Checking that it landed." });
      else if (S.wres.has(k)) paintMagState(out, S.wres.get(k), agent);
      wrap.appendChild(out);
      const th = el("ul", "rm-thread"); th.hidden = true; wrap.appendChild(th);
      wrap.appendChild(el("p", "rm-note", "Replies arrive in your chat with " + agent + "."));
      S.loadThread(agent, f, th);
    };
    wrap.redraw = draw; draw();
    return wrap;
  }
  function paintMagState(out, res, agent) {
    out.textContent = ""; out.className = "rm-state" + (res && (res.cls === "ok" || res.cls === "q") ? " rm-ok" : res && res.cls === "bad" ? " rm-bad" : "");
    if (!res) return;
    // short inline line; the toast keeps the long explanation
    if (res.cls === "ok" || res.cls === "q") { out.append(el("b", "", "✓ Sent, waiting for reply"), document.createTextNode(" · " + (res.cls === "ok" ? "delivered" : /not running/.test(res.word) ? "queued (agent not running)" : "queued (agent busy)"))); return; }
    out.append(el("b", "", (res.cls === "bad" ? "⚠ " : "… ") + res.word + " "), document.createTextNode(res.text || ""));
  }
  function renderThreadItems(ul, items, agent) {
    ul.textContent = "";
    if (!items || !items.length) { ul.hidden = true; return; }
    items.forEach((x) => {
      const li = el("li"); const d = new Date(x.time);
      const when = isNaN(d) ? "" : d.getDate() + " " + d.toLocaleString("en-GB", { month: "short" }) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      const how = x.delivery === "sent" ? "delivered" : x.delivery === "pending" ? "waiting in " + agent + "'s notes" : x.delivery === "queued" ? "queued" : x.delivery || "";
      li.append(el("b", "", "You"), document.createTextNode(" · " + when + (how ? " · " + how : "") + ": "), auto(el("span", "", "“" + x.text + "”")));
      ul.appendChild(li);
    });
    ul.hidden = false;
  }
  // "Read the full finding": what changed, why it matters and the full source list (the reply box is already on the card)
  function renderReadMore(S, agent, f, withTitle) {
    const k = keyOf(agent, f.title), id = nextId("rf");
    const wrap = el("div");
    const b = el("button", "rm-read"); b.type = "button"; b.setAttribute("aria-controls", id);
    const body = el("div", "rm-full"); body.id = id;
    const set = (on) => { b.textContent = on ? "▾ Hide the full finding" : "▸ Read the full finding"; b.setAttribute("aria-expanded", on ? "true" : "false"); body.hidden = !on; if (on && !body.firstChild) { if (withTitle) { body.appendChild(el("h4", "rs-h4", "Headline")); body.appendChild(auto(el("p", "rs-text", f.title))); } body.appendChild(renderFindingBody(S, f, null)); } };
    set(S.openF.has(k));
    b.addEventListener("click", () => { const on = b.getAttribute("aria-expanded") !== "true"; if (on) { S.openF.add(k); S.onOpened(agent, f); } else S.openF.delete(k); set(on); });
    wrap.append(b, body);
    return wrap;
  }
  function renderHero(S, p, curated, rank) {
    const f = p.finding, agent = p.agent;
    const a = el("article", "rm-hero"); a.dataset.fkey = domKey(agent, f.title); tagSeen(a, agent, f);
    // layout (styles-research-mag.css): with a picture, image left and text + reply right (as the mockup); without one, a short
    // agent-colour band on top and text left, reply right, so the reply box stays above the fold
    const tx = el("div", "rm-tx");
    tx.appendChild(renderMagChips(S, agent, f, curated ? "#" + (rank || 1) + " of 5" : "preview")); addDates(tx, f);
    const h = auto(el("h3", "rm-clamp", f.title)); h.title = f.title; tx.appendChild(h);
    const so = (curated && p.why) || oneLine(f.soWhat); if (so) tx.appendChild(auto(el("p", "rm-so", so)));
    const ch = renderChart(agent, f); if (ch) tx.appendChild(ch);
    const sl = sourceLine(f); if (sl) tx.appendChild(el("p", "rm-meta", sl));
    tx.appendChild(renderReadMore(S, agent, f, true));
    const rep = el("div", "rm-hero-reply"); rep.appendChild(renderReply(S, agent, f, { alwaysOpen: true }));
    const media = renderMedia(S, agent, f); media.style.setProperty("--rm-h", String(hue(agent)));
    a.append(media, tx, rep);
    return a;
  }
  function renderArticle(S, agent, f, opts) {
    const o = opts || {};
    const a = el("article", "rm-art"); a.dataset.fkey = domKey(agent, f.title); tagSeen(a, agent, f);
    const b = el("div", "rm-b");
    b.appendChild(renderMagChips(S, agent, f, o.rank ? "#" + o.rank + " of 5" : "")); addDates(b, f);
    b.appendChild(auto(el("h3", "", f.title)));
    const so = o.why || oneLine(f.soWhat); if (so) b.appendChild(auto(el("p", "rm-so", so)));
    const ch = renderChart(agent, f); if (ch) b.appendChild(ch);
    const sl = sourceLine(f); if (sl) b.appendChild(el("p", "rm-meta", sl));
    b.appendChild(renderReadMore(S, agent, f));
    b.appendChild(renderReply(S, agent, f));
    a.append(renderMedia(S, agent, f), b);
    return a;
  }
  // the magazine area at the top: masthead, hero, the other four of the five
  function renderMagazine(S) {
    const t = S.snap.top5, sec = el("section", "rm-mag"); sec.setAttribute("aria-label", "This week's stories");
    const mast = el("div", "rm-mast");
    mast.append(el("span", "rm-kick", "My Research · Week " + S.snap.week.slice(6) + " · Magazine"), el("h2", "", "What the agents found this week"));
    mast.appendChild(el("p", "", t.state === "curated" ? "The five to read first, " + (t.pickedBy ? "picked by " + t.pickedBy : "picked by the COO") + (t.pickedAt ? " on " + t.pickedAt.slice(0, 10) : "") + ". Pictures come from each story's own source page; charts use only figures written in the finding." : "Not yet curated: a preview only (the first finding of the first five agents, alphabetical). Pictures come from each story's own source page; charts use only figures written in the finding."));
    sec.appendChild(mast);
    if (!t.picks.some((p) => p.finding)) { sec.appendChild(el("p", "rs-muted", "There are no stories to show yet.")); return sec; }
    // v1.102.0: the hero and the five follow the filters (agent, search, tiles, chips, themes); each keeps its original rank
    const picks = RF.filterPicks(t.picks, S.f, isMarked);
    if (!picks.length) { sec.appendChild(renderFilterEmpty(S, "None of this week's five match these filters.")); return sec; }
    const cur = t.state === "curated";
    sec.appendChild(renderHero(S, picks[0], cur, picks[0].rank));
    if (picks.length > 1) {
      const g = el("div", "rm-grid");
      picks.slice(1).forEach((p) => g.appendChild(renderArticle(S, p.agent, p.finding, { rank: cur ? p.rank : 0, why: cur ? p.why : "" })));
      sec.appendChild(g);
    }
    return sec;
  }
  // a clear empty state when the filters leave nothing (never silently stale content)
  function renderFilterEmpty(S, text) {
    const C = RF.counts(allFindings(), S.f, isMarked);
    const p = el("div", "rs-empty-f"); p.setAttribute("role", "status");
    p.append(el("span", "", text + (C.shown ? " " + C.shown + " other " + (C.shown === 1 ? "story matches" : "stories match") + " below." : S.f.noRun ? " \"Did not run\" lists agents, not stories: see the agent tiles below." : " Nothing else matches either.")));
    p.appendChild(btn("Clear filters", "rs-btn", S.clearFilters));
    return p;
  }
  // every other finding as article cards, following the filters above it; 12 at a time
  function renderMagMore(S, host) {
    host.textContent = "";
    const pickSet = new Set(S.snap.top5.picks.filter((p) => p.finding).map((p) => keyOf(p.agent, p.finding.title)));
    const rank = { high: 0, normal: 1, low: 2 };
    const list = allFindings().filter((x) => !pickSet.has(keyOf(x.agent, x.f.title)) && matches(x.agent, x.f) && !S.f.noRun)
      .sort((a, b) => (rank[a.f.tier] - rank[b.f.tier]) || ((a.f.worth ? 0 : 1) - (b.f.worth ? 0 : 1)));
    const h = el("div", "rm-sec-h"); h.append(el("h2", "", "More from the agents"), el("span", "", list.length + (list.length === 1 ? " story" : " stories") + (anyFilter() ? " match the filters" : "") + ", high first"));
    host.appendChild(h);
    if (!list.length) { host.appendChild(el("p", "rs-note", anyFilter() ? "Nothing else matches these filters." : "No other findings this week.")); return; }
    const g = el("div", "rm-grid"); host.appendChild(g);
    let shown = 0;
    const addTo = (n) => { list.slice(shown, n).forEach((x) => g.appendChild(renderArticle(S, x.agent, x.f))); shown = Math.max(shown, Math.min(n, list.length)); };
    addTo(S.magLimit);
    if (list.length > shown) {
      const label = () => "Show " + Math.min(MAG_PAGE, list.length - shown) + " more stories (" + (list.length - shown) + " left)";
      const more = btn(label(), "rm-btn rm-more-btn", () => {
        S.magLimit = shown + MAG_PAGE; addTo(S.magLimit); watchSeen();
        if (shown >= list.length) { more.remove(); const last = g.lastElementChild && g.lastElementChild.querySelector("h3"); if (last) { last.tabIndex = -1; last.focus(); } } else more.textContent = label();
      });
      host.appendChild(more);
    }
  }

  // ================================================================ SHELL, STATE AND DATA (logic: leave alone when restyling)
  const view = el("div"); view.id = "research-view"; view.className = "hidden";
  const headHost = el("div"), bodyHost = el("div", "rs-body"), toast = el("div", "rs-toast hidden"); toast.setAttribute("role", "status"); toast.setAttribute("aria-live", "polite");
  view.append(headHost, bodyHost, toast);
  document.getElementById("main-panel").appendChild(view);

  const S = { snap: null, week: null, ideas: new Set(), marked: new Set(), openA: new Set(), openF: new Set(), f: noFilters(), last: null, legendOpen: true, writeOpen: new Set(), wres: new Map(), wsending: new Set(),
    unreadTotal: 0, view: "magazine", wrong: new Set(), imgs: new Map(), threads: new Map(), io: null, magLimit: 12 };   // v1.91.0 magazine state
  const drafts = new Map();   // "Write to <agent>" drafts per week|agent|finding: the owner's own text, kept while the app runs (an untouched reference line is dropped on close)
  let open = false, navEl = null, toastTimer = null, listHost = null, topHost = null, leadHost = null, findBar = null;
  const say = (t) => { toast.textContent = t; toast.classList.remove("hidden"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add("hidden"), 6000); };
  const toastShown = () => !toast.classList.contains("hidden");
  const loadPrefs = () => (api.getPrefs ? api.getPrefs().then((r) => {
    if (r && r.ok && r.prefs) { S.last = r.prefs.lastOpened || null; S.legendOpen = r.prefs.legendOpen !== false; S.view = r.prefs.view === "list" ? "list" : "magazine"; S.wrong = new Set(Array.isArray(r.prefs.imageWrong) ? r.prefs.imageWrong : []); S.f.agent = typeof r.prefs.agentFilter === "string" ? r.prefs.agentFilter : ""; }
  }).catch(() => {}) : Promise.resolve());
  let prefsReady = loadPrefs();
  let moreHost = null;

  function renderList() {
    if (!listHost) return;
    if (moreHost) renderMagMore(S, moreHost);
    listHost.textContent = "";
    const rows = S.snap.digests.filter((d) => {
      if (S.f.noRun) return !!BAD[d.state];
      if (!anyFilter()) return true;
      return d.findings.some((f) => matches(d.agent, f));
    });
    rows.forEach((d) => renderAgentTile(S, d, listHost));
    if (anyFilter() && !rows.length) listHost.appendChild(el("p", "rs-note", "Nothing matches these filters. Use Clear filters."));
    watchSeen();
  }
  // glance, themes and filters depend on the filter state: redraw only that block
  function renderFilterBlock() { if (!topHost) return; topHost.textContent = ""; topHost.appendChild(renderGlance(S)); const th = renderThemes(S); if (th) topHost.appendChild(th); topHost.appendChild(renderFilters(S)); }
  // v1.102.0: the hero + the five (Magazine) or the five (List); redrawn on every filter change so it is never stale
  function renderLead() {
    if (!leadHost) return;
    leadHost.textContent = "";
    leadHost.appendChild(S.view === "magazine" && allFindings().length > 0 ? renderMagazine(S) : renderTopFive(S));
    watchSeen();
  }
  // the filter block is redrawn on every change; keep keyboard focus on the same control (same class + text) so Space/Enter can be repeated
  const refilter = () => {
    S.magLimit = MAG_PAGE;
    const a = document.activeElement, mine = topHost && a && topHost.contains(a), key = mine ? a.className + "|" + a.textContent.replace(/\d+$/, "").slice(0, 30) : null;
    renderLead(); renderFilterBlock(); renderList(); if (findBar) findBar.paint();   // renderList ends with watchSeen()
    if (key) { const n = [...topHost.querySelectorAll("button")].find((b) => b.className + "|" + b.textContent.replace(/\d+$/, "").slice(0, 30) === key); if (n) n.focus(); }
  };
  const saveAgent = () => { if (api.setPrefs) api.setPrefs({ agentFilter: S.f.agent || "" }).catch(() => {}); };

  S.setFilter = (k, v) => { S.f = RF.setFilter(S.f, k, v); refilter(); };
  S.setAgent = (a) => { S.f = RF.setFilter(S.f, "agent", a); saveAgent(); refilter(); };
  S.setQuery = (q) => { if ((S.f.q || "") === q) return; S.f = RF.setFilter(S.f, "q", q); refilter(); };
  S.clearOne = (k) => { S.f = RF.clearOne(S.f, k); if (k === "agent") saveAgent(); refilter(); };
  S.clearChips = () => { const z = noFilters(); z.agent = S.f.agent; z.q = S.f.q; S.f = z; refilter(); };   // "Findings" tile: keep agent + search
  S.clearFilters = () => { const had = !!S.f.agent; S.f = noFilters(); if (had) saveAgent(); refilter(); };
  S.jumpToAgents = () => { const h = view.querySelector(".rs-agents-h"); if (h) { h.scrollIntoView({ block: "start" }); const t = listHost && listHost.querySelector(".rs-tile"); if (t) t.focus({ preventScroll: true }); } };
  S.setAll = (on) => {
    S.openA = new Set(on ? S.snap.digests.filter((d) => d.state !== "not-due" && !BAD[d.state]).map((d) => d.agent) : []);
    if (!on) S.openF = new Set();
    else if (S.view === "magazine") allFindings().forEach((x) => { if (matches(x.agent, x.f)) S.openF.add(keyOf(x.agent, x.f.title)); });   // Magazine: open every "Read the full finding"
    if (S.view === "magazine") renderLead();
    renderList();
  };
  S.onOpened = (agent, f) => { S.last = { week: S.snap.week, agent, finding: f.title }; if (api.setPrefs) api.setPrefs({ lastOpened: S.last }).catch(() => {}); view.querySelectorAll(".rs-lastmark").forEach((m) => m.remove()); };
  S.onJump = (agent, f, write) => {
    if (anyFilter() && !matches(agent, f)) { S.f = noFilters(); saveAgent(); renderLead(); renderFilterBlock(); if (findBar) findBar.paint(); }
    S.openA.add(agent); S.openF.add(keyOf(agent, f.title)); S.last = { week: S.snap.week, agent, finding: f.title };
    if (write) S.writeOpen.add(wkeyOf(agent, f.id));
    if (api.setPrefs) api.setPrefs({ lastOpened: S.last }).catch(() => {});
    renderList();
    const card = [...listHost.querySelectorAll(".rs-fcard")].find((c) => c.dataset.fkey === domKey(agent, f.title));
    if (card) { card.scrollIntoView({ block: "center" }); const h = card.querySelector(write ? ".rs-write-t" : ".rs-fhead"); if (h) h.focus({ preventScroll: true }); card.classList.add("rs-flash"); }
  };
  // v1.89.0: send a "Write to <agent>" message. The renderer sends week, agent name, finding id and the text; main checks and delivers.
  S.onWrite = (agent, fid, ta, send, out, pre, k) => {
    // v1.104.0: the Magazine reply box's status line is an .rm-state paragraph; paintResult would swap its class for the List view's
    // .rs-write-r (unstyled there), so the Magazine keeps its own painter
    const mag = out.classList.contains("rm-state");
    const paint = (o, r) => (mag ? paintMagState(o, r, agent) : paintResult(o, r));
    const v = ta.value, body = v.indexOf(pre) === 0 ? v.slice(pre.length) : v;
    if (!body.trim()) { paint(out, { cls: "bad", icon: "⚠", word: "Not sent.", text: pre ? "Write your message below the reference line first." : "Write your message first." }); ta.focus(); return; }
    if (v.length > MAX_WRITE) { paint(out, { cls: "bad", icon: "⚠", word: "Not sent.", text: "That is " + v.length + " characters; the limit is " + MAX_WRITE + ". Shorten it." }); return; }
    if (S.wsending.has(k)) return;
    const week = S.snap.week;
    S.wsending.add(k); S.wres.delete(k); send.disabled = true;
    paint(out, { cls: "wait", icon: "…", word: "Sending.", text: "Checking that it landed in " + agent + "'s chat (can take up to about a minute)." });
    api.write(week, agent, fid, v).then((r) => {
      if (r && r.ok) {
        drafts.delete(k);
        if (r.delivery === "sent") return { cls: "ok", icon: "✓", word: "Delivered.", text: agent + " has it in its chat." };
        if (r.delivery === "pending" && r.busy) return { cls: "q", icon: "⏳", word: "Saved - " + agent + "'s chat box has unsent text.", text: "The app will not paste over it, so your message is kept in its pending notes (" + (r.file || "pending notes") + "). Clear that box, or ask it to read its notes." };
        if (r.delivery === "pending") return { cls: "q", icon: "⏳", word: "Queued - " + agent + " is not running.", text: "Saved to its pending notes (" + (r.file || "pending notes") + "); it reads them when it next starts." };
        return { cls: "q", icon: "⏳", word: "Queued, not yet confirmed.", text: agent + " is busy; it gets the message when its current turn ends." };
      }
      return { cls: "bad", icon: "⚠", word: "Not sent.", text: ((r && r.reason) || "That did not work.") + " Your draft is kept." };
    }).catch(() => ({ cls: "bad", icon: "⚠", word: "Not sent.", text: "The app could not reach the sender. Your draft is kept." })).then((res) => {
      S.wsending.delete(k);
      if (!open || !S.snap || S.snap.week !== week) return;       // the view closed or the week changed meanwhile
      S.wres.set(k, res);
      S.threads.delete(k);                                         // v1.91.0: the magazine thread re-reads _writes.jsonl
      say(res.word + " " + res.text);
      view.querySelectorAll(".rs-wa").forEach((w) => {
        if (w.dataset.wkey !== k || !w.redraw) return;
        const had = w.contains(document.activeElement);
        w.redraw();
        if (had) { const t = w.querySelector(".rs-write-t") || w.querySelector(".rs-wbtn") || w.querySelector(".rm-ta") || w.querySelector(".rm-open"); if (t) t.focus(); }
      });
    });
  };
  // ---- v1.91.0 magazine: view switch, lead images (lazy, from main's cache), "This image is wrong", the sent thread
  S.setView = (v) => {
    if (S.view === v) return;
    S.view = v; S.magLimit = MAG_PAGE;
    if (api.setPrefs) api.setPrefs({ view: v }).catch(() => {});
    render();
    const b = [...view.querySelectorAll(".rm-seg button")].find((x) => x.getAttribute("aria-pressed") === "true"); if (b) b.focus();
  };
  S.fetchImage = (m) => {
    const key = m.dataset.ikey, week = S.snap && S.snap.week;
    if (!week || S.imgs.has(key) || !api.image) return;
    S.imgs.set(key, { ok: false, pending: true });
    api.image(week, m.agent, m.finding.id).then((r) => r, () => null).then((r) => {
      if (!open || !S.snap || S.snap.week !== week) return;
      S.imgs.set(key, r && r.ok && typeof r.url === "string" && /^file:\/\//i.test(r.url) ? r : { ok: false });   // only a local cached file, never a remote URL
      view.querySelectorAll(".rm-media").forEach((x) => { if (x.dataset.ikey === key && x.paint) x.paint(); });
    });
  };
  S.onWrongImage = (agent, f, m) => {
    const key = imgKeyOf(agent, f);
    if (!api.setPrefs) return;
    api.setPrefs({ imageWrong: { week: S.snap.week, agent, findingId: f.id } }).then((r) => {
      if (!r || !r.ok) { say((r && r.reason) || "Not saved."); return; }
      S.wrong.add(key);
      view.querySelectorAll(".rm-media").forEach((x) => { if (x.dataset.ikey === key && x.paint) x.paint(); });
      say("Picture hidden for this finding; the data card is shown instead.");
    }).catch(() => say("Not saved."));
  };
  S.loadThread = (agent, f, ul) => {
    const k = wkeyOf(agent, f.id), week = S.snap.week;
    if (S.threads.has(k)) { renderThreadItems(ul, S.threads.get(k), agent); return; }
    if (!api.thread) return;
    S.threads.set(k, []);
    api.thread(week, agent, f.id).then((r) => {
      if (!open || !S.snap || S.snap.week !== week) return;
      const items = r && r.ok && Array.isArray(r.items) ? r.items : [];
      S.threads.set(k, items);
      if (ul.isConnected) renderThreadItems(ul, items, agent);
    }).catch(() => {});
  };
  S.onLink = (url) => { api.openLink(url).then((r) => { if (r && !r.ok) say(r.reason || "Could not open the link."); }).catch(() => say("Could not open the link.")); };
  S.onStar = (agent, f, srcBtn) => {
    const key = keyOf(agent, f.title), want = !S.marked.has(key);
    api.mark({ week: S.snap.week, agent, finding: f.title, interesting: want }).then((r) => {
      if (!r || !r.ok) { say((r && r.reason) || "Not saved."); return; }
      if (want) S.marked.add(key); else S.marked.delete(key);
      view.querySelectorAll('.rs-star[data-key="' + key.replace(/["\\]/g, "") + '"]').forEach((b) => paintStar(b, want));
      renderFilterBlock();
      if (S.f.starred) renderList();
      say(want ? "Marked interesting. The COO will see it." : "Mark removed.");
    }).catch(() => say("Not saved."));
  };
  S.onIdea = (agent, f, b) => {
    b.disabled = true;
    api.addIdea({ week: S.snap.week, agent, finding: f.title }).then((r) => {
      if (r && r.ok) { S.ideas.add(keyOf(agent, f.title)); b.textContent = "✓ In my ideas inbox"; say(r.already ? "It was already in the ideas inbox." : "Added to the ideas inbox. The COO will see it."); }
      else { b.disabled = false; say((r && r.reason) || "Not saved."); }
    }).catch(() => { b.disabled = false; say("Not saved."); });
  };
  S.onExport = () => { api.exportWeek(S.snap.week).then((r) => say(r && r.ok ? "Week summary written: " + r.file : (r && r.reason) || "Not saved.")).catch(() => say("Not saved.")); };
  S.onWeek = (w) => { S.week = w; S.openA = new Set(); S.openF = new Set(); const ag = S.f.agent; S.f = noFilters(); S.f.agent = ag; refresh(); };
  S.onRefresh = () => refresh();
  S.onAsk = (agentName, ta, sendBtn, out) => {
    const text = (ta.value || "").trim();
    if (!text) { out.textContent = "Type what to research first."; return; }
    const bridge = window.libraryBridge;
    if (!bridge || typeof bridge.send !== "function") { out.textContent = "Sending is not available in this window."; return; }
    const low = norm(agentName);
    const a = (bridge.agents() || []).find((x) => norm(x.displayName) === low || norm(x.folderName) === low);
    if (!a) { out.textContent = agentName + " is not in the agent list in this window, so nothing was sent."; return; }
    sendBtn.disabled = true; out.textContent = "Sending...";
    const msg = "From " + (window.AppCfg ? window.AppCfg.owner() : "the user") + ", via the My Research tab (" + S.snap.week + "): please research the following and tell me what you find. If it is more than a quick answer, put it in your next weekly research digest.\n\n" + text;
    bridge.send(a.path, msg).then((r) => {
      if (r && r.ok) { out.textContent = r.how === "queued" ? "Queued: " + agentName + " is busy and will get it next." : "Sent to " + agentName + "."; say(out.textContent); ta.value = ""; }
      else out.textContent = (r && r.error) || "Could not send it.";
    }).catch(() => { out.textContent = "Could not send it."; }).then(() => { sendBtn.disabled = false; });
  };

  // ---- v1.107.0 unread: a finding is read when its card is clicked/opened/replied to (any click inside it) or after ~4 s on screen
  const pendingSeen = new Map(); let seenTimer = null, dwellIO = null;
  const DWELL_MS = 4000;
  function pushBadge(n) { try { window.dispatchEvent(new CustomEvent("research-badge", { detail: { count: n } })); } catch (e) { /* cosmetic */ } }
  function flushSeen() {
    clearTimeout(seenTimer); seenTimer = null;
    if (!pendingSeen.size || !api.seen) return;
    const items = [...pendingSeen.values()]; pendingSeen.clear();
    api.seen(items).then((r) => { if (r && r.ok) { S.unreadTotal = r.count; pushBadge(r.count); paintMarkAll(); } }).catch(() => {});
  }
  function markSeen(agent, fid) {
    const week = S.snap && S.snap.week; if (!week || !fid) return;
    const hit = allFindings().find((x) => x.f.id === fid && x.agent === agent);
    if (!hit || !hit.f.unread) return;
    hit.f.unread = false;
    S.unreadTotal = Math.max(0, S.unreadTotal - 1);                  // local estimate; the reply from main sets the real number
    view.querySelectorAll(".rs-unread").forEach((n) => { if (n.dataset.fid === fid && n.dataset.fagent === agent) { n.classList.remove("rs-unread"); n.querySelectorAll(".rs-newchip").forEach((c) => c.remove()); } });
    pendingSeen.set(week + "|" + agent + "|" + fid, { week, agent, findingId: fid });
    paintMarkAll();
    if (!seenTimer) seenTimer = setTimeout(flushSeen, 400);
  }
  function paintMarkAll() { const b = view.querySelector(".rs-markall"); if (b) { b.textContent = "Mark all as read" + (S.unreadTotal ? " (" + S.unreadTotal + ")" : ""); b.disabled = !S.unreadTotal; } }
  S.onMarkAll = () => {
    if (!api.seenAll) return;
    api.seenAll().then((r) => {
      if (!r || !r.ok) { say((r && r.reason) || "Not saved."); return; }
      S.unreadTotal = r.count; pushBadge(r.count);
      if (S.snap && S.snap.digests) S.snap.digests.forEach((d) => d.findings.forEach((f) => { f.unread = false; }));
      view.querySelectorAll(".rs-unread").forEach((n) => n.classList.remove("rs-unread"));
      view.querySelectorAll(".rs-newchip").forEach((n) => n.remove());
      paintMarkAll(); say("Everything is marked as read.");
    }).catch(() => say("Not saved."));
  };
  view.addEventListener("click", (ev) => { const c = ev.target && ev.target.closest ? ev.target.closest("[data-fid]") : null; if (c && c.classList.contains("rs-unread")) markSeen(c.dataset.fagent, c.dataset.fid); }, true);
  view.addEventListener("focusin", (ev) => { const t = ev.target; if (t && t.matches && t.matches("textarea")) { const c = t.closest("[data-fid]"); if (c) markSeen(c.dataset.fagent, c.dataset.fid); } });   // starting a reply
  function watchSeen() {
    if (typeof IntersectionObserver !== "function") return;
    if (!dwellIO) dwellIO = new IntersectionObserver((entries) => entries.forEach((e) => {
      const n = e.target;
      if (e.isIntersecting && n.classList.contains("rs-unread")) { if (!n._dwell) n._dwell = setTimeout(() => { n._dwell = null; if (n.classList.contains("rs-unread")) markSeen(n.dataset.fagent, n.dataset.fid); }, DWELL_MS); }
      else if (n._dwell) { clearTimeout(n._dwell); n._dwell = null; }
    }), { threshold: 0.6 });
    view.querySelectorAll(".rs-unread[data-fid]:not([data-dw])").forEach((n) => { n.dataset.dw = "1"; dwellIO.observe(n); });
  }

  // v1.133.0 MY RECOMMENDATIONS: a second tab. recs.js and styles-recs.css load the first time the tab is opened; closing the view drops it.
  function renderTabs() {
    const bar = el("div", "rc-tabs"); bar.setAttribute("role", "tablist");
    [["findings", "Findings"], ["recs", "My Recommendations"]].forEach(([id, word]) => {
      const b = el("button", "", word); b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", (S.tab || "findings") === id ? "true" : "false");
      b.addEventListener("click", () => { if ((S.tab || "findings") === id) return; if (window.recsView && S.tab === "recs") window.recsView.unmount(); S.tab = id; render(); });
      bar.appendChild(b);
    });
    return bar;
  }
  let recsLoading = false;
  function mountRecs() {
    const go = () => { if (window.recsView) window.recsView.mount(bodyHost); };
    if (window.recsView) return go();
    bodyHost.appendChild(el("div", "rs-muted rs-pad", "Opening the recommendations..."));
    if (recsLoading) return;                                  // already loading: its onload mounts into whatever the current bodyHost is
    recsLoading = true;
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "styles-recs.css"; document.head.appendChild(link);
    const sc = document.createElement("script"); sc.src = "recs.js";
    sc.onload = () => { recsLoading = false; if (S.tab === "recs") { bodyHost.textContent = ""; go(); } };
    sc.onerror = () => { recsLoading = false; sc.remove(); link.remove(); bodyHost.textContent = ""; bodyHost.appendChild(el("p", "rs-note", "The recommendations tab could not load. Switch tabs and back to try again.")); };
    document.body.appendChild(sc);
  }
  function render() {
    headHost.textContent = ""; bodyHost.textContent = ""; listHost = topHost = moreHost = leadHost = findBar = null;
    if (S.io) { S.io.disconnect(); S.io = null; }
    headHost.appendChild(renderHeader(S));
    headHost.appendChild(renderTabs());                       // v1.133.0: Findings | Recommendations
    if (S.tab === "recs") { mountRecs(); return; }
    if (!S.snap) { bodyHost.appendChild(el("div", "rs-muted rs-pad", "Reading this week's digests...")); return; }
    const main = el("div", "rs-main");
    if (S.snap.needsSetup && window.NeedsSetup) { bodyHost.appendChild(main); main.appendChild(window.NeedsSetup.card("research")); return; } // v1.121.0: the calm card with a Set up button
    if (!S.snap.ok) { bodyHost.appendChild(main); main.appendChild(renderState("Couldn't read the week file", S.snap.reason && S.snap.reason !== "Couldn't read the week file" ? S.snap.reason : "The research folder for this week could not be opened.")); return; }
    if (!S.snap.week) { bodyHost.appendChild(main); main.appendChild(renderState("No findings for this week", "No research weeks were found. The agents write a digest each week into shared_reports\\research\\<week>.")); return; }
    bodyHost.append(renderLegend(S), main);
    if (S.snap.digests.some((d) => !d.noDigest)) main.appendChild(renderAskBar(S));   // v1.104.0: scrolls with the page
    main.appendChild(renderViewSwitch(S));
    const mag = S.view === "magazine" && allFindings().length > 0;
    if (S.f.agent && !S.snap.digests.some((d) => d.agent === S.f.agent && d.findings.length)) S.f.agent = "";   // remembered agent has nothing this week
    findBar = allFindings().length ? renderFindBar(S) : null;
    if (findBar) main.appendChild(findBar);
    if (mag) {
      // one observer for the whole view: a card's image is asked for only when it comes near the screen
      if (typeof IntersectionObserver === "function") S.io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { S.io.unobserve(e.target); S.fetchImage(e.target); } }), { rootMargin: "300px 0px" });
    }
    leadHost = el("div", "rs-lead"); main.appendChild(leadHost); renderLead();
    const coo = renderCoo(S); if (coo) main.appendChild(coo);
    if (!allFindings().length) main.appendChild(renderState("No findings for this week", "The digests for " + S.snap.week + " hold no findings yet."));
    topHost = el("div", "rs-topblock"); main.appendChild(topHost);
    if (mag) { moreHost = el("section", "rm-mag"); moreHost.setAttribute("aria-label", "More stories"); main.appendChild(moreHost); }
    const h = el("div", "rs-sec-h rs-agents-h"); h.appendChild(el("h2", "rs-secl", "Agents · tap to open, closed by default")); if (S.snap.statusNote) h.appendChild(el("span", "rs-sub", S.snap.statusNote));
    main.appendChild(h);
    if (S.snap.skippedFiles) main.appendChild(el("p", "rs-note", S.snap.skippedFiles + " more digest file(s) were not read (limit 60 per week)."));
    if (S.snap.tasteOk === false) main.appendChild(el("p", "rs-note", "taste.json could not be read, so your marks are not shown and new ones will not be saved until it is fixed."));
    listHost = el("div", "rs-tiles"); main.appendChild(listHost);
    renderFilterBlock(); renderList(); watchSeen();
  }

  function refresh() {
    return prefsReady.then(() => api.load(S.week)).then((s) => {
      S.snap = s;
      if (s && s.ok) { S.unreadTotal = s.unreadCount || 0; pushBadge(S.unreadTotal); }
      if (s && s.ok && s.week) { S.week = s.week; S.marked = new Set(s.marked || []); S.ideas = new Set(s.ideasAdded || []); }
      if (open) render();
    }).catch(() => { S.snap = { ok: false, reason: "The research folder could not be read." }; if (open) render(); });
  }

  const onDocClick = (e) => { if (e.target.closest(".argus-nav, .iris-nav, .memory-nav, #library-nav, .daily-nav, .health-nav, .tools-nav, #agent-list .agent-item")) close(); };
  // Esc: first dismisses a toast; then closes an open Details (focus goes back to its toggle); only then closes the view
  const onDocKey = (e) => {
    if (e.key !== "Escape") return;
    if (toastShown()) { toast.classList.add("hidden"); clearTimeout(toastTimer); e.preventDefault(); return; }
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA")) return;
    const card = e.target && e.target.closest ? e.target.closest(".rs-fcard") : null;
    const h = card && card.querySelector(".rs-fhead");
    if (h && h.getAttribute("aria-expanded") === "true") { e.preventDefault(); h.click(); h.focus(); return; }
    close();
  };
  function openView() {
    if (open) return;
    const b = document.body;
    if (b.classList.contains("argus-open")) document.querySelector("#argus-view .argus-close")?.click();
    if (b.classList.contains("iris-open")) document.querySelector("#iris-view .iris-close")?.click();
    if (b.classList.contains("daily-open")) document.querySelector(".daily-nav")?.click();
    if (b.classList.contains("health-open")) document.querySelector(".health-nav")?.click();
    if (b.classList.contains("tools-open") && window.toolsView) window.toolsView.close();
    if (b.classList.contains("memory-open")) { b.classList.remove("memory-open"); document.getElementById("memory-view")?.classList.add("hidden"); document.querySelector(".memory-nav")?.classList.remove("active"); }
    const lib = document.getElementById("library-view");
    if (lib && !lib.classList.contains("hidden")) document.querySelector("#library-view .library-close")?.click();
    open = true;
    b.classList.add("research-open");
    view.classList.remove("hidden");
    if (navEl) navEl.classList.add("active");
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onDocKey);
    S.week = null; prefsReady = loadPrefs(); render(); refresh();
  }
  function close() {
    if (!open) return;
    open = false;
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onDocKey);
    document.body.classList.remove("research-open");
    view.classList.add("hidden");
    if (navEl) navEl.classList.remove("active");
    for (const [k, v] of drafts) if (/^> Re: [^\n]*\n\n$/.test(v)) drafts.delete(k);   // an untouched reference line is not a draft
    S.writeOpen = new Set(); S.wres = new Map();
    if (S.io) { S.io.disconnect(); S.io = null; }
    if (api.cancelImages) api.cancelImages().catch(() => {});              // queued image fetches in main give up
    S.imgs = new Map(); S.threads = new Map(); S.magLimit = MAG_PAGE; moreHost = null;   // v1.91.0: no images or threads stay in the page
    if (pendingSeen.size) flushSeen(); if (dwellIO) { dwellIO.disconnect(); dwellIO = null; }
    S.snap = null; S.marked = new Set(); S.ideas = new Set(); S.openA = new Set(); S.openF = new Set(); S.f = noFilters();
    if (window.recsView) window.recsView.unmount(); S.tab = "findings";
    headHost.textContent = ""; bodyHost.textContent = ""; toast.textContent = ""; toast.classList.add("hidden"); listHost = topHost = null;   // nothing from the digests stays in the page
  }
  window.researchView = { toggle(nav) { if (nav) navEl = nav; open ? close() : openView(); }, close };
})();
