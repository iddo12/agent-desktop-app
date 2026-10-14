// FLEET CONVERSATIONS pane (v1.119.0), turned into a conversation TIMELINE in v1.120.0: every message between this person's agents and
// the other person's agents - the Exchange file mailbox AND IRIS - as chat bubbles grouped by thread (our side on the right, the other
// side on the left), so you can see whether an agent talked to the other side, what they said, and whether anybody answered.
// Configurable since v1.121.0: the label, the two people's names and the lead role come from main (window.api.fleet.settings(), read from
// appConfig); nothing is polled and no listing is requested while the feature is not set up (the tile shows dimmed, the pane explains
// and offers the Setup panel), and a feature turned off hides the tile.
// A tile in the sidebar (with an unread badge) opens a pane on the RIGHT of the normal conversation - the chat stays visible. Data comes from
// main (src/fleetTimeline.js -> window.api.fleet.timeline, async fs, names + stat only; IRIS log tail cached): every 5 min while the pane is
// closed (and when the window gets focus, at most every 30 s), every 60 s while it is open; re-draws only when the listing changed (typed
// drafts, focus, caret and scroll survive). Exchange note bodies are read lazily ("Show full note" -> fleet-read). The only write is the
// existing open-question "Send answer" (fleet-reply: a new file in the mailbox's outbox folder, never overwrites). textContent only (no HTML injection);
// all message text gets dir="auto" so Hebrew renders right-to-left.
// Outgoing bubbles carry a status line: delivered / queued / in the mailbox, and "answered <time>" or "no reply yet (Xh)". "Answered" is a
// best-effort guess (a later incoming message in the same thread), labelled as such.
// Unread = incoming notes/messages newer than ui-flags "fleetPaneLastSeen". First run starts at "now" (no flood); opening the pane moves it to
// the newest incoming message of a SUCCESSFUL listing only. Questions can be dismissed (ui-flags "fleetPaneDismissed", ids, newest 200).
// The pane remembers it was open ("fleetPaneOpen") and its width ("fleetPaneWidth", 340-520, drag the left edge).
// FUTURE (not built): a compose box per thread that writes into the thread (IRIS send / mailbox file); every item carries source + thread key.
(function () {
  "use strict";
  if (!window.api || !window.api.fleet) return;
  var api = window.api.fleet, POLL_OPEN = 60000, POLL_CLOSED = 300000, FOCUS_MIN = 30000, FLAG = "fleetPaneLastSeen", FLAG_DISMISS = "fleetPaneDismissed", FLAG_OPEN = "fleetPaneOpen", FLAG_W = "fleetPaneWidth";
  var W_MIN = 340, W_MAX = 520, W_DEF = 420, AUTO_OPEN_THREADS = 3;
  var sig = "", drafts = {}, dismissed = [], openThreads = {}, expanded = {}, bodies = {}, lastLoadAt = 0, pollTimer = null, loadError = false;
  var data = null, lastSeen = 0, prevSeen = 0, open = false, status = "", filter = "all", width = W_DEF, pendingScroll = null;
  // Wording and state from main (appConfig). Neutral until it answers; st.state is ready | needs-attention | needs-setup | off.
  var st = { state: "ready", label: "", owner: "", partner: "", role: "" }, stLoaded = false;
  var theirSide = function () { return st.partner ? st.partner + "'s side" : "the other side"; };
  var theirAgents = function () { return st.partner ? st.partner + "'s agents" : "the other side's agents"; };
  var theirAgent = function () { return st.partner ? st.partner + "'s agent" : "the other side's agent"; };
  var linkLabel = function () { return st.label || "Shared fleet"; };
  var usable = function () { return st.state === "ready" || st.state === "needs-attention"; };

  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var auto = function (e) { e.setAttribute("dir", "auto"); return e; }; // Hebrew text must run right-to-left like in the normal chat
  var btn = function (label, cls, fn) { var b = el("button", "fp-btn " + (cls || ""), label); b.type = "button"; b.dataset.label = label; b.addEventListener("click", function (ev) { ev.preventDefault(); fn(ev); }); return b; };
  var p2 = function (n) { return String(n).padStart(2, "0"); };
  function fmtDate(ms) {
    var d = new Date(ms), now = new Date();
    var day = d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
    var diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    return diff === 0 ? "today" : diff === 1 ? "yesterday" : day;
  }
  function fmtWhen(ms) { return fmtDate(ms) + " " + p2(new Date(ms).getHours()) + ":" + p2(new Date(ms).getMinutes()); }
  function fmtAge(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return m + " min"; var h = Math.round(m / 60); if (h < 48) return h + " h"; return Math.round(h / 24) + " d";
  }

  // ---- sidebar tile + badge
  var nav = el("button", "fleet-nav"); nav.type = "button"; nav.dataset.systemNav = "fleet"; /* the left pane turns this into a SYSTEMS tile */
  nav.hidden = true; /* shown once main has told us the state (no flash of a wrong label) */
  var navTitle = el("span", "fleet-nav-title", "Shared fleet"), navSub = el("span", "fleet-nav-sub", "Fleet conversations");
  var navName = el("span", "fleet-nav-name"); navName.append(navTitle, navSub);
  var badge = el("span", "fleet-nav-badge hidden"); nav.append(navName, badge);
  var agentList = document.getElementById("agent-list"), libNav = document.getElementById("library-nav");
  if (!agentList || !agentList.parentNode) return;
  agentList.parentNode.insertBefore(nav, libNav && libNav.parentNode === agentList.parentNode ? libNav : agentList);
  nav.addEventListener("click", function () { if (open) closePane(); else refreshSettings().then(openPane); });

  var pane = el("aside", "fleet-pane hidden"); pane.id = "fleet-pane"; pane.setAttribute("aria-label", "Fleet conversations");
  document.body.appendChild(pane);
  var grip = el("div", "fp-grip"); grip.title = "Drag to resize"; grip.setAttribute("aria-hidden", "true"); document.body.appendChild(grip);
  function applyWidth() { document.body.style.setProperty("--fleet-w", width + "px"); }
  applyWidth();
  grip.addEventListener("pointerdown", function (ev) {
    ev.preventDefault(); try { grip.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    var move = function (e2) { width = Math.max(W_MIN, Math.min(W_MAX, window.innerWidth - e2.clientX)); applyWidth(); };
    var up = function () { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); setFlag(FLAG_W, width); };
    grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up);
  });

  function idleTitle() { return "Conversation timeline with " + theirAgents() + " (the Exchange mailbox and IRIS) and questions waiting for your answer"; }
  function setBadge() {
    var n = data && data.found && usable() ? data.unread : 0;
    badge.textContent = n > 99 ? "99+" : String(n); badge.classList.toggle("hidden", !n);
    nav.title = !usable() ? linkLabel() + ": needs setup (open the Setup panel)" : n ? n + " new message" + (n === 1 ? "" : "s") + " from " + theirSide() : idleTitle();
  }
  // Ask main for the state and wording; applies it to the tile. Resolves when done; never rejects.
  function refreshSettings() {
    return Promise.resolve(api.settings ? api.settings() : null).then(function (r) {
      if (r && r.ok) { st = { state: r.state || "ready", label: r.label || "", owner: r.owner || "", partner: r.partner || "", role: r.role || "", reason: r.reason || "" }; }
      stLoaded = true; applyTile();
    }).catch(function () { stLoaded = true; applyTile(); });
  }
  function applyTile() {
    navTitle.textContent = linkLabel();
    nav.hidden = st.state === "off";
    nav.classList.toggle("fleet-nav-setup", st.state === "needs-setup");
    navSub.textContent = st.state === "needs-setup" ? "Set up" : "Fleet conversations";
    setBadge();
    if (st.state === "off" && open) closePane();
    if (open) render();
  }
  function byId(id) { return data && data.items.find(function (i) { return i.id === id; }); }
  function setFlag(k, v) { try { window.api.setUiFlag(k, v); } catch (e) { /* ignore */ } }

  function load(force) {
    lastLoadAt = Date.now();
    if (!usable()) return Promise.resolve(false); // not set up / off: no request, nothing polled
    return Promise.resolve(api.timeline(lastSeen, !!force)).then(function (r) {
      if (r && !r.ok && (r.reason === "needs-setup" || r.reason === "off")) { st.state = r.reason; applyTile(); return false; }
      if (!r || !r.ok) { loadError = true; if (open) render(); return false; }
      loadError = false; data = r;
      var ns = r.fp + "#" + r.found + "#" + dismissed.length;
      var changed = ns !== sig; sig = ns;
      if (open) { markSeen(r); if (changed || force) render(); } // the badge stays in step while the pane is open
      setBadge();
      return true;
    }).catch(function () { loadError = true; return false; });
  }
  // Seen = the newest incoming message of a successful listing (never "now", never after a failed listing).
  function markSeen(r) {
    if (!r || !r.ok || !r.found) return;
    var ns = Math.max(lastSeen, r.maxPartnerMtime || 0);
    if (ns > lastSeen) { lastSeen = ns; setFlag(FLAG, ns); }
    r.unread = 0;
  }
  function schedule() { if (pollTimer) clearTimeout(pollTimer); pollTimer = setTimeout(function () { if (!document.hidden && usable()) load(false); schedule(); }, open ? POLL_OPEN : POLL_CLOSED); }

  function openPane() {
    open = true; prevSeen = lastSeen; status = "";
    pane.classList.remove("hidden"); grip.classList.add("on"); document.body.classList.add("fleet-open"); nav.classList.add("active"); setFlag(FLAG_OPEN, true);
    render(); schedule();
    load(true).then(function (ok) { if (ok) setBadge(); });
  }
  function closePane() { open = false; pane.classList.add("hidden"); grip.classList.remove("on"); document.body.classList.remove("fleet-open"); nav.classList.remove("active"); setFlag(FLAG_OPEN, false); schedule(); }

  function header() {
    var h = el("div", "fp-head"), t = el("div", "fp-title"); t.append(el("span", "fp-title-main", linkLabel()), el("span", "fp-title-sub", "Timeline: files + IRIS"));
    var refresh = btn("Refresh", "fp-ghost", function () { status = ""; load(true); }), close = btn("×", "fp-close", closePane); close.title = "Close (Esc)"; close.setAttribute("aria-label", "Close");
    h.append(t, refresh, close); return h;
  }

  function chips() {
    var FILTERS = [["all", "All"], ["waiting", "Waiting for a reply"], ["partner", "From " + theirSide()]]; // "partner" is the stored filter id, never shown
    var row = el("div", "fp-chips"); row.setAttribute("role", "group"); row.setAttribute("aria-label", "Filter");
    FILTERS.forEach(function (f) {
      var c = el("button", "fp-chip" + (filter === f[0] ? " on" : ""), f[1]); c.type = "button"; c.setAttribute("aria-pressed", filter === f[0] ? "true" : "false");
      if (f[0] === "waiting" && data && data.threads) { var n = data.threads.filter(function (t) { return t.waiting; }).length; if (n) c.append(el("span", "fp-chip-n", String(n))); }
      c.addEventListener("click", function () { filter = f[0]; render(); }); row.append(c);
    });
    return row;
  }

  // Re-draw keeping the focused box, its caret and the scroll position.
  function render() {
    if (!open) return;
    var a = document.activeElement, keep = null, scrollTop = 0, sc = pane.querySelector(".fp-body");
    if (sc) scrollTop = sc.scrollTop;
    if (a && pane.contains(a) && a.dataset && a.dataset.draftKey) keep = { key: a.dataset.draftKey, s: a.selectionStart, e: a.selectionEnd };
    pane.textContent = "";
    renderTimeline();
    var body = pane.querySelector(".fp-body"); if (body) body.scrollTop = scrollTop;
    if (keep) { var ta = pane.querySelector('[data-draft-key="' + keep.key.replace(/"/g, "") + '"]'); if (ta) { ta.focus(); try { ta.setSelectionRange(keep.s, keep.e); } catch (e) { /* ignore */ } } }
    if (pendingScroll) { var want = pendingScroll; pendingScroll = null; try { var tgt = Array.prototype.find.call(pane.querySelectorAll("[data-bubble-id]"), function (n) { return n.dataset.bubbleId === want; }); if (tgt && tgt.scrollIntoView) tgt.scrollIntoView({ block: "center" }); } catch (e) { /* never break a render over a scroll */ } }
  }

  function renderTimeline() {
    pane.append(header());
    var body = el("div", "fp-body");
    if (st.state === "needs-setup") { pane.append(body); body.append(setupNote()); return; }
    if (!data) { pane.append(body); body.append(el("p", "fp-note", loadError ? "Could not read the mailbox right now. It will retry; press Refresh to try now." : "Loading...")); return; }
    if (!data.found) { pane.append(body); body.append(el("p", "fp-note", "Nothing found. The Exchange folder is not on this PC (or its sync has not finished yet) and IRIS has no messages. Nothing is wrong with the app.")); return; }
    pane.append(chips(), body);
    if (loadError) body.append(el("p", "fp-note", "The last refresh failed; showing the previous listing."));
    if (!data.exchangeFound) body.append(el("p", "fp-note", "The Exchange mailbox folder was not found; showing IRIS only."));
    var qs = data.questions.filter(function (q) { return dismissed.indexOf(q.id) < 0; });
    if (qs.length) body.append(questionsBox(qs));
    body.append(el("div", "fp-section", "Conversations" + (data.capped ? " (newest " + data.items.filter(function (i) { return i.source === "exchange"; }).length + " of " + data.total + " mailbox files)" : "")));
    var shown = 0;
    data.threads.forEach(function (t, idx) { var b = threadBlock(t, idx); if (b) { body.append(b); shown++; } });
    if (!shown) body.append(el("p", "fp-note", filter === "waiting" ? "Nothing is waiting for a reply from " + theirSide() + " (best guess)." : filter === "partner" ? "No messages from " + theirSide() + "." : "No messages yet."));
    if (data.threads.length) body.append(el("p", "fp-foot", "Reply detection is a best guess: a later message from the other side in the same thread counts as an answer."));
    if (status) body.append(el("div", "fp-status", status));
  }

  // Calm "needs setup" state: what is missing, and one button to the Setup panel (never an error, never an empty screen).
  function setupNote() {
    var box = el("div", "fp-setup");
    box.append(el("p", "fp-note", linkLabel() + " is not set up yet. Pick the shared mailbox folder in Setup and it will show the conversation with " + theirAgents() + ". Nothing is wrong with the app."));
    box.append(btn("Set up", "fp-primary", function () { try { if (window.setupView && window.setupView.open) window.setupView.open(); } catch (e) { /* the Setup tile is in the sidebar */ } }));
    return box;
  }

  function keepDraft(ta, key) { ta.value = drafts[key] || ""; ta.addEventListener("input", function () { drafts[key] = ta.value; }); ta.dataset.draftKey = key; }

  function questionsBox(qs) {
    var box = el("section", "fp-questions"); box.append(el("div", "fp-qhead", "Waiting for your answer (" + qs.length + ")"));
    qs.forEach(function (q) {
      var card = el("div", "fp-qcard"); card.append(auto(el("div", "fp-qtitle", q.title)));
      card.append(auto(el("div", "fp-qmeta", "from " + q.sender + " · " + fmtDate(q.date))));
      if (q.preview) card.append(auto(el("div", "fp-qprev", q.preview)));
      var ta = el("textarea", "fp-ta"); ta.rows = 2; ta.setAttribute("dir", "auto"); ta.placeholder = "Your answer to " + q.sender + "..."; ta.setAttribute("aria-label", "Answer to " + q.title); keepDraft(ta, "q:" + q.id);
      var acts = el("div", "fp-qactions");
      var dismiss = btn("Dismiss", "fp-ghost fp-onDark", function () { dismissed.push(q.id); dismissed = dismissed.slice(-200); setFlag(FLAG_DISMISS, dismissed); render(); }); dismiss.title = "Hide this question without replying";
      var read = btn("Show in timeline", "fp-ghost fp-onDark", function () { showInTimeline("exchange:" + q.id); });
      var send = btn("Send answer", "fp-primary", function () { sendReply(q.sender, q.title, ta, send); });
      acts.append(dismiss, read, send); card.append(ta, acts); box.append(card);
    });
    return box;
  }

  function showInTimeline(id) {
    var it = byId(id); if (!it) return;
    filter = "all"; openThreads[it.threadKey] = true; pendingScroll = id; loadBody(it); render();
  }

  function statusLine(i) {
    var s = i.status, bad = false, parts = [];
    if (i.source === "iris") {
      if (s === "delivered") parts.push("delivered");
      else if (s === "queued") parts.push("queued, not delivered yet");
      else if (s === "awaiting-approval") { parts.push("waiting for your approval"); bad = true; }
      else if (s === "rejected") { parts.push("rejected by the other side" + (i.reason ? " (" + i.reason + ")" : "")); bad = true; }
      else if (s === "expired") { parts.push("expired, never delivered"); bad = true; }
      else if (s === "declined") { parts.push("not sent (you declined)"); bad = true; }
      else parts.push(s || "sent");
    } else parts.push("in the mailbox");
    if (!bad) {
      if (i.answeredAt) parts.push("answered " + fmtWhen(i.answeredAt) + (i.answeredBy ? " by " + i.answeredBy : "") + " (best guess)");
      else { parts.push("no reply yet (" + fmtAge(Date.now() - i.atMs) + ")"); bad = (Date.now() - i.atMs) > 6 * 3600000; }
    }
    var line = auto(el("div", "fp-bstatus" + (i.answeredAt ? " ok" : bad ? " warn" : ""), parts.join(" · ")));
    return line;
  }

  function loadBody(i) {
    expanded[i.id] = true;
    if (!i.lazy || bodies[i.id] != null) return;
    bodies[i.id] = "Loading...";
    Promise.resolve(api.read(i.rawId)).then(function (r) { bodies[i.id] = r && r.ok ? r.text + (r.truncated ? "\n\n[shortened]" : "") : "Could not read this file."; render(); }).catch(function () { bodies[i.id] = "Could not read this file."; render(); });
  }

  function bubble(i) {
    var mine = i.dir === "out", isNew = !mine && i.atMs > prevSeen;
    var wrap = el("div", "fp-brow " + (mine ? "fp-mine" : "fp-theirs")); wrap.dataset.bubbleId = i.id;
    var b = el("div", "fp-bubble" + (isNew ? " fp-bnew" : "") + (i.question ? " fp-bq" : ""));
    var top = el("div", "fp-btop"); top.append(auto(el("span", "fp-bname", i.from + (i.to && i.to !== "unknown" ? " → " + i.to : ""))));
    top.append(el("span", "fp-src fp-src-" + i.source, i.source === "iris" ? "IRIS" : "File"));
    if (isNew) top.append(el("span", "fp-new", "new"));
    b.append(top);
    if (i.source === "exchange" && i.subject) b.append(auto(el("div", "fp-bsubj", i.subject)));
    var full = expanded[i.id] && i.lazy && bodies[i.id] != null;
    var txt = full ? bodies[i.id] : i.text;
    if (txt) { var tx = auto(el("div", "fp-btext" + (full || i.source === "iris" ? " full" : ""), txt)); b.append(tx); }
    if (i.lazy) {
      var more = el("button", "fp-more", expanded[i.id] ? "Hide full note" : "Show full note"); more.type = "button";
      more.addEventListener("click", function () { if (expanded[i.id]) { expanded[i.id] = false; render(); } else { loadBody(i); render(); } }); b.append(more);
    }
    b.append(el("div", "fp-btime", fmtWhen(i.atMs)));
    if (mine) b.append(statusLine(i));
    wrap.append(b); return wrap;
  }

  function threadBlock(t, idx) {
    var items = t.items.map(byId).filter(Boolean);
    if (filter === "waiting" && !t.waiting) return null;
    if (filter === "partner") items = items.filter(function (i) { return i.dir === "in"; });
    if (!items.length) return null;
    var det = el("details", "fp-thread" + (t.waiting ? " fp-waiting" : ""));
    var initOpen = openThreads[t.key] != null ? !!openThreads[t.key] : idx < AUTO_OPEN_THREADS; det.open = initOpen;
    det.addEventListener("toggle", function () { if (openThreads[t.key] == null && det.open === initOpen) return; openThreads[t.key] = det.open; }); // the first programmatic toggle must not pin an auto-open choice
    var sum = el("summary", "fp-tsum"), main = el("span", "fp-tmain");
    var sources = {}; items.forEach(function (i) { sources[i.source] = 1; });
    main.append(auto(el("span", "fp-ttitle", t.title)), el("span", "fp-tmeta", fmtWhen(t.newestMs) + " · " + items.length + " message" + (items.length === 1 ? "" : "s") + " · " + Object.keys(sources).map(function (s) { return s === "iris" ? "IRIS" : "files"; }).join(" + ")));
    sum.append(main);
    if (t.waiting) sum.append(el("span", "fp-tag fp-tag-wait", "no reply yet"));
    if (items.some(function (i) { return i.dir === "in" && i.atMs > prevSeen; })) sum.append(el("span", "fp-new", "new"));
    det.append(sum);
    var chat = el("div", "fp-chat"); items.forEach(function (i) { chat.append(bubble(i)); }); det.append(chat);
    return det;
  }

  function sendReply(to, topic, ta, sendBtn) {
    var text = ta.value.trim(); if (!text) { ta.focus(); return; }
    var label = sendBtn.dataset.label || "Send"; sendBtn.disabled = true; sendBtn.textContent = "Sending...";
    var fail = function (msg) { status = "Not sent: " + msg + "."; sendBtn.disabled = false; sendBtn.textContent = label; render(); };
    Promise.resolve(api.reply(to, topic, text)).then(function (r) {
      if (r && r.ok) {
        delete drafts[ta.dataset.draftKey]; ta.value = "";
        status = "Saved to the mailbox as " + r.name + ". " + theirAgent() + " will see it on its next check.";
        return load(true).then(function () { showInTimeline("exchange:" + r.id); });
      }
      fail((r && r.error) || "unknown problem");
    }).catch(function () { fail("could not reach the mailbox"); });
  }

  // Esc closes the fleet pane only (and not the waiting-queue panel at the same time): capture phase, handled and stopped. A box with
  // typed text keeps the pane open. If the focus is elsewhere and the waiting-queue panel is open, that panel gets the key.
  document.addEventListener("keydown", function (e) {
    if (!open || e.key !== "Escape" || e.defaultPrevented) return;
    var a = document.activeElement, inPane = a && pane.contains(a);
    if (!inPane && document.querySelector(".wq-panel")) return;
    if (a && a.tagName === "TEXTAREA" && a.value) return;
    e.preventDefault(); e.stopImmediatePropagation(); closePane();
  }, true);
  window.addEventListener("focus", function () { refreshSettings().then(function () { if (Date.now() - lastLoadAt > FOCUS_MIN) load(false); }); });

  // start: stored last-seen (first run = now, so old notes do not flood the badge), stored dismissals and width, reopen when it was open,
  // one listing a few seconds later
  var wasOpen = false;
  Promise.resolve(window.api.getUiFlags ? window.api.getUiFlags() : {}).then(function (f) {
    f = f || {}; var v = Number(f[FLAG]);
    if (v > 0) lastSeen = v; else { lastSeen = Date.now(); setFlag(FLAG, lastSeen); }
    prevSeen = lastSeen; if (Array.isArray(f[FLAG_DISMISS])) dismissed = f[FLAG_DISMISS].filter(function (x) { return typeof x === "string"; }).slice(-200);
    var w = Number(f[FLAG_W]); if (w >= W_MIN && w <= W_MAX) { width = Math.round(w); applyWidth(); }
    wasOpen = f[FLAG_OPEN] === true;
  }).catch(function () { lastSeen = Date.now(); }).then(refreshSettings).then(function () {
    if (wasOpen && st.state !== "off") openPane();
    setTimeout(function () { if (!open) load(false); schedule(); }, 3000);
  });
  window.FleetPane = { _state: function () { return { open: open, unread: data && data.unread, lastSeen: lastSeen, filter: filter, width: width }; } };
})();
