// IRIS "Chats" page (v1.126.0, design v3): the shared, plain-language view of conversations between the people and agents of two linked
// Agent Desktops. The same page runs on both PCs. Words come from iris/direct-strings.js (English and Hebrew); the page language is the
// one the main process reports (the Setup language). Everything drawn from message text uses textContent only - messages come from
// another machine and are never parsed as HTML. Self-contained and wrapped so a fault here can only break this page.
(function () {
  "use strict";
  if (!window.api || !window.api.iris || !window.api.iris.chats || !window.IrisDirectStrings) return;
  const iris = window.api.iris;
  const DS = window.IrisDirectStrings;
  const POLL_MS = 5000;
  let code = "en";
  let S = DS.pick(code);
  let data = null;
  let selPeer = null, selThread = null, formOpen = false, lastError = "";
  let timer = null, rendering = false;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(label, cls, fn) { const b = el("button", ("ichat-btn " + (cls || "")).trim(), label); b.type = "button"; b.addEventListener("click", (ev) => { ev.preventDefault(); fn(ev); }); return b; }
  const T = (k, v) => DS.fill(S[k], v);
  const stamp = (iso) => { try { return new Date(iso).toLocaleString(code === "he" ? "he-IL" : undefined, { dateStyle: "short", timeStyle: "short" }); } catch (e) { return ""; } };
  const ownerName = () => (data && data.owner) || S.youLabel;

  // ---------------------------------------------------------------- sidebar entry + view shell
  const nav = el("button", "iris-nav ichat-nav");
  nav.dataset.systemNav = "chats";   // the left pane turns an entry with this attribute into a SYSTEMS tile (v1.128.1: it was a full-width row above SYSTEMS)
  const navName = el("span", "iris-nav-name");
  const navTitle = el("span", "iris-nav-title", S.navTitle), navSub = el("span", "iris-nav-sub", "");
  navName.append(navTitle, navSub);
  const navBadge = el("span", "iris-nav-badge hidden");
  nav.append(navName, navBadge);
  const agentList = document.getElementById("agent-list");
  const libNav = document.getElementById("library-nav");
  const irisNav = document.querySelector(".iris-nav:not(.ichat-nav)");
  agentList.parentNode.insertBefore(nav, irisNav ? irisNav.nextSibling : (libNav || agentList));

  const view = el("div"); view.id = "ichat-view"; view.className = "hidden";
  document.getElementById("main-panel").appendChild(view);
  const head = el("div", "ichat-head");
  const title = el("div", "ichat-title");
  const titleMain = el("span", "ichat-title-main", S.title), titleSub = el("span", "ichat-title-sub", S.subtitle);
  title.append(titleMain, titleSub);
  const closeBtn = el("button", "ichat-close", "×"); closeBtn.addEventListener("click", closeView);
  head.append(title, closeBtn);
  const body = el("div", "ichat-body");
  view.append(head, body);

  function openView() {
    if (document.body.classList.contains("iris-open")) document.querySelector("#iris-view .iris-close")?.click();
    const lib = document.getElementById("library-view");
    if (lib && !lib.classList.contains("hidden")) document.querySelector("#library-view .library-close")?.click();
    if (document.body.classList.contains("argus-open")) document.querySelector("#argus-view .argus-close")?.click();
    document.body.classList.add("irischat-open"); view.classList.remove("hidden"); nav.classList.add("active");
    refresh(true);
    clearInterval(timer); timer = setInterval(() => refresh(false), POLL_MS);
  }
  function closeView() {
    document.body.classList.remove("irischat-open"); view.classList.add("hidden"); nav.classList.remove("active");
    clearInterval(timer);
  }
  nav.addEventListener("click", () => (document.body.classList.contains("irischat-open") ? closeView() : openView()));
  agentList.addEventListener("click", (e) => { if (e.target.closest(".agent-item")) closeView(); }, true);
  new MutationObserver(() => { if (document.body.classList.contains("iris-open") && document.body.classList.contains("irischat-open")) closeView(); }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("irischat-open") && !e.target.closest("#ichat-view input, #ichat-view textarea")) closeView(); });

  function setLang(c) {
    code = DS.lang[c] ? c : "en"; S = DS.pick(code);
    view.setAttribute("dir", S.dir); view.setAttribute("lang", code);
    titleMain.textContent = S.title; titleSub.textContent = S.subtitle; navTitle.textContent = S.navTitle;
  }

  // ---------------------------------------------------------------- data
  async function refresh(force) {
    if (rendering) return;
    // never rebuild under a half-written message or an open settings form
    if (!force && view.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (!force && formOpen) return;
    rendering = true;
    try {
      const r = await iris.chats();
      if (!r || r.ok === false) { body.replaceChildren(el("p", "ichat-note", (r && r.reason) || "")); return; }
      data = r; setLang(r.lang);
      if (!selPeer || !r.peers.some((p) => p.id === selPeer)) selPeer = r.peers[0] ? r.peers[0].id : null;
      draw();
      if (selPeer && document.body.classList.contains("irischat-open")) iris.chatViewed(selPeer);
    } catch (e) { console.error("iris chats", e); } finally { rendering = false; }
  }

  function person(p) { return p.person || p.name; }
  function convTitle(t, p) {
    const a = t.localAgents[0] || ownerName();
    const b = t.remoteAgents[0] ? `${t.remoteAgents[0]} (${person(p)})` : person(p);
    return DS.fill(S.conversationWith, { a, p: b });
  }
  function chipText(m, p) {
    let s = DS.fill(S.chips[m.chip] || "", { p: person(p) });
    if (m.chip === "not-delivered" && m.reason) s += " - " + DS.reasonText(code, m.reason, { p: person(p) });
    if (m.chip === "handing-over" && m.waitingFor) s += " (" + DS.fill(S.waitingFor, { r: DS.reasonText(code, m.waitingFor, { p: person(p) }) }) + ")";
    return s;
  }

  // ---------------------------------------------------------------- drawing
  function draw() {
    body.replaceChildren();
    if (lastError) body.append(el("p", "ichat-error", lastError));
    const peers = data.peers;
    navSub.textContent = peers.length === 1 ? DS.fill(S.navSub, { p: person(peers[0]) }) : (peers.length ? S.navSubMany : "");
    const unread = peers.reduce((n, p) => n + (p.unread || 0), 0);
    navBadge.textContent = unread ? String(unread) : ""; navBadge.classList.toggle("hidden", !unread);
    if (!peers.length) { body.append(el("p", "ichat-note", S.noPeers)); return; }
    if (peers.length > 1) {
      const sel = el("select", "ichat-select");
      for (const p of peers) { const o = el("option", null, `${S.peer} ${person(p)}`); o.value = p.id; if (p.id === selPeer) o.selected = true; sel.append(o); }
      sel.addEventListener("change", () => { selPeer = sel.value; selThread = null; refresh(true); });
      body.append(sel);
    }
    const p = peers.find((x) => x.id === selPeer) || peers[0];
    body.append(el("h2", "ichat-h", `${S.peer} ${person(p)}`));
    const grid = el("div", "ichat-grid");
    // left: conversations
    const list = el("div", "ichat-list");
    list.append(btn("+ " + S.newMessage, "primary ichat-new", () => { selThread = null; draw(); }));
    if (!p.threads.length) list.append(el("p", "ichat-note", S.emptyList));
    for (const t of p.threads) {
      const row = el("button", "ichat-row" + (t.thread === selThread ? " sel" : "")); row.type = "button";
      row.append(el("span", "ichat-row-title", convTitle(t, p)), el("span", "ichat-row-last", String(t.last.text).slice(0, 80)));
      row.append(el("span", "ichat-row-meta", `${stamp(t.last.at)} · ${DS.fill(S.chips[t.lastChip] || "", { p: person(p) })}`));
      row.addEventListener("click", () => { selThread = t.thread; draw(); });
      list.append(row);
    }
    // right: conversation + compose
    const conv = el("div", "ichat-conv");
    const t = p.threads.find((x) => x.thread === selThread) || null;
    if (!t) conv.append(el("p", "ichat-note", S.pickConversation));
    else {
      conv.append(el("div", "ichat-conv-title", convTitle(t, p)));
      const scroll = el("div", "ichat-msgs");
      for (const m of t.messages) {
        const b = el("div", `ichat-bubble ${m.dir === "out" ? "mine" : "theirs"}${m.chip === "not-delivered" ? " bad" : ""}`);
        const from = m.dir === "out" ? (m.localAgent || ownerName()) : (m.remoteAgent || person(p));
        const to = m.dir === "out" ? (m.remoteAgent || person(p)) : (m.localAgent || ownerName());
        b.append(el("div", "ichat-bubble-head", `${from} → ${to} · ${stamp(m.at)}`), el("div", "ichat-bubble-text", m.text));
        const foot = el("div", "ichat-bubble-foot");
        foot.append(el("span", `ichat-chip ${m.chip}`, chipText(m, p)));
        if (m.chip === "not-delivered" && !m.retried) foot.append(btn(S.retry, "", async () => { const r = await iris.chatRetry(m.id); lastError = r && r.ok === false ? DS.reasonText(code, r.reason, { p: person(p) }) : ""; refresh(true); }));
        b.append(foot); scroll.append(b);
      }
      conv.append(scroll);
      setTimeout(() => { scroll.scrollTop = scroll.scrollHeight; }, 0);
    }
    conv.append(compose(p, t));
    grid.append(list, conv);
    body.append(grid);
    body.append(directPanel(p));
    body.append(approvals(p));
    body.append(activity());
  }

  function compose(p, t) {
    const box = el("div", "ichat-compose");
    const to = el("select", "ichat-select");
    const addOpt = (value, label) => { const o = el("option", null, label); o.value = value; to.append(o); return o; };
    const remote = t && t.remoteAgents[0] ? t.remoteAgents[0] : null;
    addOpt("@person", DS.fill(S.toPerson, { p: person(p) }));
    const names = new Set((p.remoteAgents || []).concat(t ? t.remoteAgents : []));
    for (const n of names) addOpt(n, DS.fill(S.toAgentOf, { a: n }));
    to.value = remote || "@person";
    const custom = el("input", "ichat-input"); custom.placeholder = S.typeAgent;
    if (!(p.remoteAgents || []).length) box.append(el("p", "ichat-hint", DS.fill(S.theirAgentsNone, { p: person(p) })));
    const txt = el("textarea", "ichat-text"); txt.placeholder = S.messagePlaceholder; txt.rows = 3;
    const send = btn(S.send, "primary", async () => {
      const text = txt.value;
      if (!text.trim()) { lastError = S.needText; draw(); return; }
      const target = custom.value.trim() || to.value;
      send.disabled = true;
      const r = await iris.chatSend(p.id, target, text, t && (target === (remote || "@person")) ? t.thread : null);
      send.disabled = false;
      if (r && r.ok) { txt.value = ""; custom.value = ""; lastError = ""; if (r.thread) selThread = r.thread; }
      else lastError = DS.reasonText(code, r && r.reason, { p: person(p) });
      refresh(true);
    });
    txt.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send.click(); });
    box.append(el("span", "ichat-label", S.toLabel), to, custom, txt, send, el("p", "ichat-hint", S.busyHint));
    return box;
  }

  function directPanel(p) {
    const sec = el("section", "ichat-section");
    sec.append(el("h3", "ichat-h3", S.directTitle));
    const d = p.direct;
    sec.append(el("p", "ichat-state " + (d.enabled ? "on" : "off"), DS.fill(d.enabled ? S.directStateOn : S.directStateOff, { p: person(p) })));
    sec.append(el("p", "ichat-hint", DS.fill(S.directExplain, { p: person(p) })));
    if (d.enabled) {
      sec.append(btn(S.directStop, "danger", async () => { const r = await iris.directSet(p.id, { enabled: false }); lastError = r && r.ok ? S.directStopped : DS.reasonText(code, r && r.reason, { p: person(p) }); refresh(true); }));
    }
    const open = btn(d.enabled ? "…" : DS.fill(S.directTurnOn, { p: person(p) }), "", () => { formOpen = !formOpen; draw(); });
    if (!formOpen) { if (!d.enabled) sec.append(open); return sec; }
    // the settings form: who they are, which agents, how many a day. Saving widening changes opens the native confirmation.
    const form = el("div", "ichat-form");
    const nameIn = el("input", "ichat-input"); nameIn.value = d.person || p.name; nameIn.maxLength = 40;
    const relIn = el("input", "ichat-input"); relIn.value = d.relation || ""; relIn.placeholder = S.directRelationPlaceholder; relIn.maxLength = 30;
    const capIn = el("input", "ichat-input narrow"); capIn.type = "number"; capIn.min = "0"; capIn.max = "500"; capIn.value = String(d.dailyCap);
    form.append(el("label", "ichat-label", S.directPerson), nameIn, el("label", "ichat-label", DS.fill(S.directRelation, { p: person(p) })), relIn);
    form.append(el("div", "ichat-label", DS.fill(S.directAgents, { p: person(p) })));
    const checks = [];
    const agentsNow = data.myAgents || [];
    const denied = new Set((d.deny || []).map((x) => x.toLowerCase()));
    const allowed = new Set((d.allow || []).map((x) => x.toLowerCase()));
    for (const a of agentsNow) {
      const lab = el("label", "ichat-check"); const cb = el("input"); cb.type = "checkbox";
      // strict by default: only the agents the owner ticks (a new setting starts with none ticked)
      cb.checked = d.enabled ? (d.mode === "only" ? allowed.has(a.toLowerCase()) : !denied.has(a.toLowerCase())) : false;
      lab.append(cb, document.createTextNode(" " + a)); form.append(lab); checks.push([a, cb]);
    }
    form.append(el("p", "ichat-hint", S.directSensitiveNote));
    const futureLab = el("label", "ichat-check"); const future = el("input"); future.type = "checkbox"; future.checked = d.enabled && d.mode === "all";
    futureLab.append(future, document.createTextNode(" " + S.directFuture)); form.append(futureLab);
    form.append(el("label", "ichat-label", S.directCap), capIn);
    form.append(btn(S.directSave, "primary", async () => {
      const deny = checks.filter(([, cb]) => !cb.checked).map(([a]) => a);
      const ticked = checks.filter(([, cb]) => cb.checked).map(([a]) => a);
      const r = await iris.directSet(p.id, { enabled: true, mode: future.checked ? "all" : "only", deny: future.checked ? deny : [], allow: future.checked ? [] : ticked, person: nameIn.value, relation: relIn.value, dailyCap: Number(capIn.value) || 0 });
      formOpen = false;
      lastError = r && r.ok ? "" : (r && r.reason === "cancelled" ? S.directCancelled : DS.reasonText(code, r && r.reason, { p: person(p) }));
      refresh(true);
    }), btn(S.dialog.cancel, "", () => { formOpen = false; draw(); }));
    sec.append(form);
    return sec;
  }

  function approvals(p) {
    const list = (data.pendingSends || []).filter((x) => x.peer === p.id);
    const sec = el("section", "ichat-section" + (list.length ? "" : " hidden"));
    if (!list.length) return sec;
    sec.append(el("h3", "ichat-h3", S.approvalTitle), el("p", "ichat-hint", S.approvalHint));
    for (const x of list) {
      const c = el("div", "ichat-pending");
      c.append(el("div", "ichat-pre", x.text));
      c.append(btn(S.approve, "primary", async () => { await iris.approveSend(x.id); refresh(true); }), btn(S.discard, "danger", async () => { await iris.rejectSend(x.id); refresh(true); }));
      sec.append(c);
    }
    return sec;
  }

  function activity() {
    const sec = el("section", "ichat-section");
    sec.append(el("h3", "ichat-h3", S.activityTitle));
    if (!data.activity.length) { sec.append(el("p", "ichat-hint", S.activityEmpty)); return sec; }
    const ul = el("ul", "ichat-activity");
    for (const e of data.activity) {
      const p = data.peers.find((x) => x.id === e.peer);
      const sentence = DS.fill(S.activity[e.event] || "", { p: p ? person(p) : "", a: e.agent || "", r: e.reason ? DS.reasonText(code, e.reason, { p: p ? person(p) : "" }) : "" });
      if (sentence) ul.append(el("li", null, `${stamp(e.at)} - ${sentence}`));
    }
    sec.append(ul);
    return sec;
  }

  // sidebar badge while the page is closed: unread messages, from the cheap status call
  async function badge() {
    try {
      if (document.body.classList.contains("irischat-open")) return;
      const st = await iris.status();
      if (!st || st.ok === false) return;
      const peers = st.peers || [];
      const n = peers.reduce((a, p) => a + (p.unreadChats || 0), 0);
      navBadge.textContent = n ? String(n) : ""; navBadge.classList.toggle("hidden", !n);
      nav.classList.toggle("hidden", !peers.length);
    } catch (e) { /* cosmetic */ }
  }
  iris.onChanged(() => { if (document.body.classList.contains("irischat-open")) refresh(false); else badge(); });
  setInterval(badge, 20000);
  setTimeout(() => { badge(); try { iris.chats().then((r) => { if (r && r.lang) setLang(r.lang); }); } catch (e) { /* default English */ } }, 2500);
})();
