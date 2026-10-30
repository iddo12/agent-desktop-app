// How to improve (inside My Research): friction cards mined from the owner's own messages. Loaded on first use by research.js (window.improveView.mount).
// Built to UI-UX's mock (UI-UX\how_to_improve\mock.html), class prefix hi-. Yes / No only record a decision (main writes improve\decisions.json);
// applying an approved change is a separate step by the Security agent. "Talk to <agent>" sends a note through the same writer as the
// recommendations tab. PRIVACY/LIGHT: textContent only, one load on open and on Refresh, the renderer sends a card id, a decision and text, never a path.
// Look: styles-improve.css only (one block).
(function () {
  "use strict";
  const api = window.api && window.api.research;
  if (!api || !api.improveLoad) return;
  const MAX_TEXT = 2000, DAY = 86400000, KEEP_DAYS = 30;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function auto(e) { e.setAttribute("dir", "auto"); return e; }
  function btn(label, cls, onClick) { const b = el("button", cls || "hi-btn", label); b.type = "button"; b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); onClick(ev); }); return b; }
  function dt(iso, withTime) { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("en-GB", withTime ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" }); }
  // the card has no separate title: the first sentence of the finding, cut to ~100 characters
  function titleOf(c) { const t = c.finding.split(/(?<=[.!?:])\s/)[0] || c.finding; return t.length > 100 ? t.slice(0, 97).trimEnd() + "..." : t.replace(/[.:]$/, ""); }

  const FILTERS = [["new", "To decide"], ["approved", "Approved"], ["applied", "Applied, did it work?"], ["rejected", "Rejected"], ["all", "All"]];
  const S = { data: null, filter: "new", boxes: new Map(), sending: new Set(), msg: new Map(), open: new Set(), copied: null };
  let bodyEl = null;

  const isClosed = (c) => c.status === "worked" || c.status === "didnt_work" || c.status === "rejected";
  const lastAt = (c) => c.times[c.status] || c.answeredAt || "";
  // closed cards stay visible for 30 days after the answer
  function visible(c) { if (!isClosed(c)) return true; const t = Date.parse(lastAt(c)); return isNaN(t) || Date.now() - t <= KEEP_DAYS * DAY; }
  const matches = (c) => S.filter === "all" || (S.filter === "rejected" ? c.status === "rejected" : S.filter === "applied" ? c.status === "applied" : c.status === S.filter);
  function counts(cards) { const n = { new: 0, approved: 0, applied: 0, rejected: 0 }; cards.forEach((c) => { if (c.status in n && visible(c)) n[c.status]++; }); return n; }

  function chip(c) {
    const t = lastAt(c);
    const defs = {
      new: ["hi-new", "● New"], approved: ["hi-ok", "✓ Approved"], applied: ["hi-amber", "? Applied" + (t ? " " + dt(t) : "") + ", checking"],
      worked: ["hi-ok", "✓ Worked"], didnt_work: ["hi-amber", "? Did not work"], rejected: ["hi-grey", "– Rejected by you" + (t ? ", " + dt(t) : "")],
    };
    const d = defs[c.status] || ["hi-grey", c.status];
    return el("span", "hi-chip " + d[0], d[1]);
  }
  function timeline(c) {
    const st = c.status, step = (done, prog, word) => (done ? "● " : prog ? "◐ " : "○ ") + word;
    const ap = st === "approved", app = st === "applied", fin = st === "worked" || st === "didnt_work";
    const parts = [step(true, false, "Found"), step(ap || app || fin, false, "Approved"), step(app || fin, ap, "Applied"), step(fin, app, "Did it work?")];
    const t = el("div", "hi-tl");
    parts.forEach((p, i) => { if (i) t.appendChild(document.createTextNode("→")); t.appendChild(el("span", "", p)); });
    return t;
  }

  function decide(card, status) {
    const k = card.id;
    S.sending.add(k); S.msg.delete(k); render();
    api.improveDecide(card.id, status, "").then((r) => {
      S.sending.delete(k);
      if (r && r.ok) { card.status = status; card.answeredAt = r.answeredAt || new Date().toISOString(); card.times = Object.assign({}, card.times, { [status]: card.answeredAt }); S.open.delete(k); }
      else S.msg.set(k, { ok: false, text: (r && r.reason) || "Not saved." });
      render();
    }).catch(() => { S.sending.delete(k); S.msg.set(k, { ok: false, text: "Not saved." }); render(); });
  }

  function talk(card) {
    const k = "t" + card.id, d = el("details", "hi-talk");
    d.open = S.boxes.has(k);
    d.addEventListener("toggle", () => { if (d.open && !S.boxes.has(k)) S.boxes.set(k, ""); });
    d.appendChild(el("summary", "", "Talk to " + card.owner));
    const ta = el("textarea", "hi-ta"); ta.value = S.boxes.get(k) || ""; ta.rows = 3; ta.maxLength = MAX_TEXT; ta.placeholder = "Ask a question or change the proposal"; ta.setAttribute("dir", "auto"); ta.setAttribute("aria-label", "Message to " + card.owner);
    const cnt = el("span", "hi-count", ta.value.length + " / " + MAX_TEXT);
    ta.addEventListener("input", () => { S.boxes.set(k, ta.value); cnt.textContent = ta.value.length + " / " + MAX_TEXT; });
    const send = btn(S.sending.has(k) ? "Sending..." : "Send", "hi-btn hi-yes", () => doSend(card, k, ta.value));
    if (S.sending.has(k)) send.disabled = true;
    const row = el("div", "hi-act"); row.append(send, cnt);
    const state = el("p", "hi-state"); state.setAttribute("role", "status");
    const m = S.msg.get(k); if (m) { state.textContent = m.text; state.classList.add(m.ok ? "hi-good" : "hi-bad"); }
    d.append(ta, row, state);
    return d;
  }
  function doSend(card, k, text) {
    if (!String(text || "").trim()) { S.msg.set(k, { ok: false, text: "Write your message first." }); render(); return; }
    const head = "> Re: how to improve (" + card.signal + "): " + titleOf(card) + "\n\n";
    S.sending.add(k); S.msg.delete(k); render();
    api.improveWrite(card.id, card.owner, head + text).then((r) => {
      S.sending.delete(k);
      if (r && r.ok) { S.msg.set(k, { ok: true, text: r.hidden ? "Saved for " + card.owner + ". They read it in the Claude desktop app, not here." : r.delivery === "pending" ? "Saved for " + card.owner + " (not running: read at their next start)." : "Sent to " + card.owner + "." }); S.boxes.set(k, ""); }
      else S.msg.set(k, { ok: false, text: (r && r.reason) || "Not sent." });
      render();
    }).catch(() => { S.sending.delete(k); S.msg.set(k, { ok: false, text: "Not sent." }); render(); });
  }

  // new cards and a change waiting for "did it work?" start open; approved and closed cards start collapsed
  const startsOpen = (c) => c.status === "new" || c.status === "applied";
  function cardEl(card) {
    const isOpen = S.open.has(card.id) ? true : S.open.has("-" + card.id) ? false : startsOpen(card);
    const c = el("article", "hi-card" + (card.status === "new" ? " new" : ""));
    const head = el("div", "hi-head");
    const h = el("h4", "hi-title" + (card.status === "rejected" ? " hi-grey" : "")); auto(h);
    const tg = el("button", "hi-titlebtn", titleOf(card)); tg.type = "button"; tg.setAttribute("aria-expanded", isOpen ? "true" : "false");
    tg.addEventListener("click", () => { if (isOpen) { S.open.delete(card.id); S.open.add("-" + card.id); } else { S.open.add(card.id); S.open.delete("-" + card.id); } render(); });
    h.appendChild(tg);
    head.append(h, chip(card));
    c.appendChild(head);
    const t = card.status === "approved" ? card.times.approved || card.answeredAt : "";
    c.appendChild(el("p", "hi-by", "Owner: " + (card.owner || card.agent || "?") + (card.status === "approved" && t ? " · you said yes " + dt(t, true) : card.status === "new" && d0() ? " · found " + d0() : "")));
    if (!isOpen) return c;
    if (card.status === "approved" || card.status === "applied" || card.status === "worked" || card.status === "didnt_work") c.appendChild(timeline(card));
    c.appendChild(el("p", "hi-lab", "What we found")); c.appendChild(auto(el("p", "hi-p", card.finding)));
    if (card.proposedFix) { c.appendChild(el("p", "hi-lab", "Proposed fix")); c.appendChild(auto(el("p", "hi-p", card.proposedFix))); }
    const small = [["How", card.mechanism], ["Context cost", card.contextSaving], ["Undo", card.undo]].filter((x) => x[1]);
    if (small.length) { const p = el("p", "hi-small"); small.forEach((x, i) => { if (i) p.appendChild(document.createTextNode(" · ")); p.append(el("span", "hi-lbl", x[0] + ": "), document.createTextNode(x[1])); }); c.appendChild(p); }
    if (card.evidence.length) {
      const d = el("details", "hi-ev"); d.appendChild(el("summary", "", "Evidence (" + card.evidence.length + (card.evidence.length === 1 ? " quote)" : " quotes)")));
      card.evidence.forEach((q) => d.appendChild(auto(el("blockquote", "hi-q", q))));
      c.appendChild(d);
    }
    if (card.command) {
      const box = el("div", "hi-cmd"), bar = el("div", "hi-cmdbar");
      bar.append(el("span", "", "Command to apply: run in regular PowerShell"), btn(S.copied === card.id ? "Copied" : "Copy", "hi-btn hi-quiet", () => copyText(card.command, (ok) => { S.copied = ok ? card.id : null; render(); })));
      box.append(bar, el("pre", "", card.command));
      c.appendChild(box);
    }
    const busy = S.sending.has(card.id);
    let acts = null;
    if (card.status === "new") acts = [["✓ Yes, do it", "approved", true], ["✗ No", "rejected", false]];
    else if (card.status === "applied") acts = [["✓ Yes, it worked", "worked", true], ["✗ Not really", "didnt_work", false]];
    if (acts) {
      const row = el("div", "hi-act");
      acts.forEach((a) => { const b = btn(a[0], "hi-btn" + (a[2] ? " hi-yes" : ""), () => decide(card, a[1])); if (busy) b.disabled = true; row.appendChild(b); });
      c.appendChild(row);
    }
    const m = S.msg.get(card.id);
    if (m) { const s = el("p", "hi-state hi-bad", m.text); s.setAttribute("role", "status"); c.appendChild(s); }
    if (card.owner) c.appendChild(talk(card));
    return c;
  }
  const d0 = () => (S.data && S.data.generated ? dt(S.data.generated) : "");

  function copyText(text, done) {
    const fallback = () => { try { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); done(true); } catch (e) { done(false); } };
    try { navigator.clipboard.writeText(text).then(() => done(true), fallback); } catch (e) { fallback(); }
  }

  const SECTIONS = [["new", "To decide", (c) => c.status === "new"], ["approved", "Approved, waiting for the agent", (c) => c.status === "approved"],
    ["applied", "Applied: did it work?", (c) => c.status === "applied"], ["closed", "Closed (kept 30 days)", (c) => isClosed(c)]];

  function render() {
    if (!bodyEl) return;
    const scroller = bodyEl.closest(".rs-body") || bodyEl.parentNode, top = scroller ? scroller.scrollTop : 0;
    bodyEl.textContent = "";
    const d = S.data;
    if (!d) { bodyEl.appendChild(el("p", "hi-note", "Reading the improvement cards...")); return; }
    if (!d.ok) {
      if (d.needsSetup && window.NeedsSetup) bodyEl.appendChild(window.NeedsSetup.card("research"));
      else bodyEl.appendChild(el("p", "hi-note", d.reason || "The improvement cards could not be read."));
      return;
    }
    if (d.state === "missing") { bodyEl.appendChild(el("p", "hi-note", "No improvement cards yet. The friction miner writes them into shared_reports\\improve\\cards.json.")); bodyEl.appendChild(btn("Refresh", "hi-btn hi-quiet", () => load())); return; }
    if (d.state !== "ok") { bodyEl.appendChild(el("p", "hi-note", "The improvement cards file could not be read (" + (d.state === "too-big" ? "it is too large" : "it is damaged") + "). Nothing is shown.")); bodyEl.appendChild(btn("Refresh", "hi-btn hi-quiet", () => load())); return; }
    const n = counts(d.cards);
    const hd = el("div", "hi-headline");
    hd.appendChild(el("p", "hi-sum", (d.generated ? "Generated " + (dt(d.generated, true) || d.generated) : "Generation time unknown") + (d.windowDays ? " · last " + d.windowDays + " days" : "") + (d.humanMessages ? " · " + d.humanMessages + " of your messages read" : "")));
    hd.appendChild(el("p", "hi-counts", n.new + " to decide · " + n.approved + " approved · " + n.applied + " applied · " + n.rejected + " rejected"));
    if (d.decisionsBad) hd.appendChild(el("p", "hi-bad", "The decisions file cannot be read, so earlier answers are not shown and new ones cannot be saved until it is fixed."));
    bodyEl.appendChild(hd);
    const bar = el("div", "hi-bar"); bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Filter");
    FILTERS.forEach(([id, word]) => {
      const cnt = id === "all" ? "" : " (" + n[id] + ")";
      const b = btn(word + cnt, "hi-btn" + (S.filter === id ? " on" : ""), () => { S.filter = id; render(); });
      b.setAttribute("aria-pressed", S.filter === id ? "true" : "false");
      bar.appendChild(b);
    });
    bar.appendChild(btn("Refresh", "hi-btn hi-quiet", () => load()));
    bodyEl.appendChild(bar);
    const shown = d.cards.filter((c) => visible(c) && matches(c));
    if (!shown.length) bodyEl.appendChild(el("p", "hi-note", S.filter === "new" ? "Nothing to decide right now." : "Nothing here."));
    SECTIONS.forEach(([id, word, test]) => {
      const list = shown.filter(test);
      if (!list.length) return;
      bodyEl.appendChild(el("h3", "hi-sec", word));
      list.forEach((c) => bodyEl.appendChild(cardEl(c)));
    });
    if (scroller) scroller.scrollTop = top;
  }

  function load() {
    return api.improveLoad().then((r) => { S.data = r; render(); }).catch(() => { S.data = { ok: false, reason: "The improvement cards could not be read." }; render(); });
  }

  window.improveView = {
    mount(h) { bodyEl = el("div", "hi-root"); h.appendChild(bodyEl); render(); if (!S.data) load(); },
    unmount() { if (bodyEl && bodyEl.parentNode) bodyEl.parentNode.removeChild(bodyEl); bodyEl = null; S.data = null; S.boxes = new Map(); S.msg = new Map(); S.sending = new Set(); S.open = new Set(); },
  };
})();
