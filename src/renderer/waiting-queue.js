// WAITING FOR YOU bar + answer queue (v1.115.0, the owner 2026-10-12: chose style D, real pictures, background, short conversation).
// A bar under the Agents title ("N waiting for you"); pressing it filters the left pane to the agents that wait for the owner and puts an
// answer box under each (D). Each box shows the agent's own picture + name, the question, a few lines of BACKGROUND (the agent's last
// message, read only when the box is shown), and a short thread: "Reply, keep talking" sends a normal message to that agent and shows
// its next reply here; "Send & done" sends and removes it from the queue. Everything sent goes through renderer.js
// window.queueSendToAgent, i.e. the same delivery path as the chat box, so it also appears in the agent's own conversation.
// WHO IS WAITING (v1): the sidebar rows the app already marks (xp-needs-blocked / pending / stopped from header-tasks.js needsOf).
// Light: no polling except one MutationObserver on the agent list and a 3 s transcript check for ONE agent while its thread is open.
// ON by default; localStorage "agentDesktop.waitingQueue" = "0" turns it off. Demo controls/sample items only when
// "agentDesktop.waitingQueue.demo" = "1" (the sandbox) and then nothing is sent. textContent only.
(function () {
  "use strict";
  var LS = "agentDesktop.waitingQueue", LS_STYLE = "agentDesktop.waitingQueue.style", LS_DEMO = "agentDesktop.waitingQueue.demo";
  var ls = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var lset = function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  if (ls(LS) === "0") return;
  var demoMode = ls(LS_DEMO) === "1";

  var style = demoMode && /^[ABCD]$/.test(ls(LS_STYLE) || "") ? ls(LS_STYLE) : "D";
  var dismissed = {};            // key -> the "why" text it was dismissed with (it returns when the agent's reason changes)
  var threads = {};              // key -> [{who, text}]
  var ctxCache = {};             // key -> {at, why, ctx, lastAt}
  var watchers = {};             // key -> {sentAt, seen:{}, timer, lastActive}
  var cur = 0, open = false, bar = null, panel = null, ctl = null, guide = null, toastEl = null, timer = null;

  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; if (/(^| )wq-(q|ctx|msg|ta|sugg)( |$)/.test(cls)) e.dir = "auto"; } if (text != null) e.textContent = text; return e; };
  var KINDS = { asking: { glyph: "?", cls: "wq-orange" }, blocked: { glyph: "!", cls: "wq-red" }, pending: { glyph: "?", cls: "wq-orange" }, stopped: { glyph: "?", cls: "wq-orange" } };

  // ---- pure helpers (exported for tests as window.WaitingQueuePure) ----
  function paragraphs(text) { return String(text || "").replace(/\r/g, "").split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean); }
  // The question = the text after the last "QUESTION FOR YOU" marker if present, else the last paragraph containing "?", else the last paragraph.
  // The background = the paragraphs before it, newest last, at most `max` characters.
  function extractQuestion(text, max) {
    max = max || 1100;
    var s = String(text || "").trim(); if (!s) return { why: "", ctx: "" };
    var last = -1, re = /QUESTION FOR YOU[^\n]*\n?/gi, mm;
    while ((mm = re.exec(s))) last = mm.index + mm[0].length;
    var why = "", before = s;
    if (last >= 0) { why = s.slice(last).replace(/^[\s`'"\-*]+|[`'"\s]+$/g, "").split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim(); before = s.slice(0, s.toUpperCase().lastIndexOf("QUESTION FOR YOU")); }
    if (!why) {
      var ps = paragraphs(s), idx = -1;
      for (var i = ps.length - 1; i >= 0; i--) if (/\?/.test(ps[i])) { idx = i; break; }
      if (idx < 0) idx = ps.length - 1;
      why = ps[idx].replace(/\s+/g, " "); before = ps.slice(0, idx).join("\n\n");
    }
    if (why.length > 420) why = why.slice(0, 417) + "...";
    var ctx = before.trim(); if (ctx.length > max) ctx = "..." + ctx.slice(ctx.length - max).replace(/^\S*\s/, "");
    return { why: why, ctx: ctx.replace(/[ \t]+\n/g, "\n") };
  }
  function lastAgentBlock(blocks) {
    if (!Array.isArray(blocks)) return null;
    for (var i = blocks.length - 1; i >= 0; i--) { var b = blocks[i]; if (b && b.role === "agent" && b.lines && b.lines.length) return b; }
    return null;
  }
  // v2 (the owner 2026-10-13): an idle agent whose LAST message asks him something has no badge, so it is found from the message itself.
  // Asking = the last message (after dropping its trailing "DONE:/BLOCKED:" status line) ends with a question mark, or contains
  // "QUESTION FOR YOU", or its status line is "BLOCKED:". Pure, tested.
  function looksAsking(text) {
    var s = String(text || "").replace(/\r/g, "").trim(); if (!s) return false;
    if (/QUESTION FOR YOU/i.test(s)) return true;
    var lines = s.split("\n"), blocked = false;
    while (lines.length && (/^\s*(BLOCKED|DONE)\s*:/i.test(lines[lines.length - 1]) || !lines[lines.length - 1].trim())) { if (/^\s*BLOCKED\s*:/i.test(lines[lines.length - 1])) blocked = true; lines.pop(); }
    // a BLOCKED: line is NOT enough (v1.117.2): agents are often blocked on another agent or a throttle, not on the owner
    var ps = paragraphs(lines.join("\n")); if (!ps.length) return false;
    return /\?[\s*_`"')\]║═]*$/.test(ps[ps.length - 1]);
  }
  window.WaitingQueuePure = { extractQuestion: extractQuestion, lastAgentBlock: lastAgentBlock, paragraphs: paragraphs, looksAsking: looksAsking };
  var predictions = {};          // key -> {status, text}: a suggested answer (Haiku, same service as the chat's predicted replies)
  var predTried = {}, predChain = Promise.resolve();
  var registered = [];            // questions agents registered through the configured question tool (v1.116.0): [{id, agent, question, context, quick, partner, created}]
  var asked = {};                // folderName -> { why, ts }  agents found asking by reading their last message (scan below)

  // Sample cards for the sandbox demo. Invented, generic content (no real agent, person or site) and no image path: the avatar falls back to the
  // first letter. The partner card uses the configured partner's name (AppCfg), read when the demo list is built.
  function partnerLabel() { return window.AppCfg ? window.AppCfg.partner() : "Partner"; }
  function demoItems() {
    var pn = partnerLabel();
    return [
      { key: "demo:a1", name: "Operations", kind: "blocked", why: "Allow me to push the staging theme to the live server? (permission prompt, the agent is stopped)", ctx: "Background: the agent finished the cutover rehearsal on staging and now wants to copy the new theme to the live site. This is the step that changes the live site, so Claude Code stopped and asked for permission. Nothing has been changed yet. If you deny, the agent keeps the work on staging.", age: "34 min", quick: ["Allow once", "Deny"] },
      { key: "demo:a2", name: "Engineering", kind: "pending", why: "Tag chips are built. Should the pros and cons scorecard go to staging today?", ctx: "Background: last night you chose idea F with the wording What we liked / What can be improved. The scorecard is built for 19 reviews. Deploying it to staging is safe (staging is hidden from Google); the live site is not affected. The agent only needs a go.", age: "12 min" },
      { key: "demo:a3", name: "Search", kind: "pending", why: "Mark 12 thin trade-show terms noindex now, or wait for the cutover?", ctx: "Background: twelve trade-show pages have fewer than 3 posts. The rule says noindex until they have content. Doing it now changes staging only; doing it at cutover changes the live site in one step.", age: "9 min" },
      { key: "demo:a4", name: "IRIS: " + pn + "'s side", kind: "pending", partner: true, why: pn + " asks whether the beta link can be shared with friends.", ctx: "Background: from " + pn + "'s agent via the shared link. The tool is internal-only until the licence is cleared, so the answer is probably no for now. " + pn + " is waiting for a yes or no.", age: "3 min" }
    ];
  }

  function ageOf(iso) { var m = Math.round((Date.now() - Date.parse(iso)) / 60000); if (!(m >= 0)) return ""; return m < 60 ? m + " min" : m < 1440 ? Math.round(m / 60) + " h" : Math.round(m / 1440) + " d"; }
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
  // match a registered question's agent name to a sidebar row: the folder name or display name, equal, or one starts with the other ("Security" / "Security & Infrastructure Agent")
  function registeredFor(row) {
    var f = norm(row.dataset.folderName), nm = row.querySelector(".agent-item-name"), d = norm(nm && nm.textContent);
    for (var i = 0; i < registered.length; i++) { var a = norm(registered[i].agent); if (a && (a === f || a === d || (f && f.indexOf(a + " ") === 0) || (d && d.indexOf(a + " ") === 0))) return registered[i]; }
    return null;
  }
  function loadRegistered() {
    if (!window.api || !window.api.listOpenQuestions) return Promise.resolve();
    return Promise.resolve(window.api.listOpenQuestions()).then(function (qs) {
      var a = JSON.stringify((qs || []).map(function (q) { return q.id; })), b = JSON.stringify(registered.map(function (q) { return q.id; }));
      registered = Array.isArray(qs) ? qs : []; if (a !== b) refresh();
    }).catch(function () { /* next tick */ });
  }
  // v1.117.3 (the owner): the Testing agent (and any name in localStorage "agentDesktop.waitingQueue.ignore", comma separated) never shows in the queue
  function ignored(row) {
    var list = (ls("agentDesktop.waitingQueue.ignore") || "testing").split(",").map(norm).filter(Boolean), f = norm(row.dataset.folderName), nm = row.querySelector(".agent-item-name"), d = norm(nm && nm.textContent);
    return list.some(function (x) { return f === x || d === x || f.indexOf(x + " ") === 0 || d.indexOf(x + " ") === 0; });
  }
  function rowsWaiting() {
    var out = [];
    document.querySelectorAll("#agent-list .agent-item").forEach(function (row) {
      var kind = ["blocked", "pending"].find(function (k) { return row.classList.contains("xp-needs-" + k); });
      var reg = registeredFor(row);
      if (ignored(row)) return;
      var ask = reg ? { why: reg.question, reg: reg } : asked[row.dataset.folderName || ""];
      if (ask && ask.reg) kind = kind || "asking";
      else if (!kind && ask && !row.classList.contains("xp-working")) kind = "asking";
      if (!kind) return;
      var nm = row.querySelector(".agent-item-name"), img = row.querySelector(".avatar-wrap img"), b = row.querySelector(".xp-needs-badge");
      var name = nm ? nm.textContent.trim() : (row.dataset.folderName || "agent");
      var why = ask ? ask.why : ((b && b.title) || "Waiting for you");
      out.push({ key: "row:" + (row.dataset.folderName || name), name: name, kind: kind, why: why, status: why, age: ask && ask.reg ? ageOf(ask.reg.created) : "", img: img && img.src, row: row, path: row.dataset.agentPath || "", qid: ask && ask.reg ? ask.reg.id : "", ctx: ask && ask.reg ? ask.reg.context : "", quick: ask && ask.reg && ask.reg.quick && ask.reg.quick.length ? ask.reg.quick : null, partner: !!(ask && ask.reg && ask.reg.partner) });
    });
    return out;
  }
  function items() {
    var list = rowsWaiting();
    if (demoMode) demoItems().forEach(function (d) { list.push(Object.assign({}, d, { status: d.why, row: null, path: "" })); });
    // re-arm: a dismissed agent that is no longer waiting may wait again later (same badge text) and must show up again
    Object.keys(dismissed).forEach(function (k) { if (!list.some(function (i) { return i.key === k; }) && k.indexOf("demo:") !== 0) delete dismissed[k]; });
    list = list.filter(function (i) { return dismissed[i.key] !== i.status; });
    list.forEach(function (i) { var c = ctxCache[i.key]; if (c && !i.ctx && c.ctx) i.ctx = c.ctx; if (c && c.why && i.path && !i.qid) i.agentWhy = c.why; });
    list.sort(function (a, b) { return (a.kind === "blocked" ? 0 : 1) - (b.kind === "blocked" ? 0 : 1); });
    return list;
  }
  // The question text: the agent's real last message when we have read it, else the app's own reason line.
  function shownQuestion(it) { return it.agentWhy || it.why; }

  function avatar(it) {
    var w = el("span", "wq-av");
    if (it.img) { var i = el("img"); i.src = it.img; i.alt = ""; w.appendChild(i); } else w.textContent = (it.name || "?").charAt(0);
    var k = KINDS[it.kind] || KINDS.pending; var m = el("span", "wq-mark " + k.cls, k.glyph); m.setAttribute("aria-hidden", "true"); w.appendChild(m);
    return w;
  }
  function toast(msg) {
    if (!toastEl) { toastEl = el("div", "wq-toast"); toastEl.setAttribute("role", "status"); document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add("on"); clearTimeout(timer); timer = setTimeout(function () { toastEl.classList.remove("on"); }, 2800);
  }

  // ---- reading the agent's last message (background) ----
  function loadContext(it) {
    if (!it.path || !window.api || !window.api.getLiveTranscript) return;
    var c = ctxCache[it.key]; if (c && Date.now() - c.at < 20000) return;
    ctxCache[it.key] = { at: Date.now(), loading: true, why: c && c.why, ctx: c && c.ctx };
    Promise.resolve(window.api.getLiveTranscript(it.path, false, true)).then(function (blocks) {
      var b = lastAgentBlock(blocks); var q = b ? extractQuestion(b.lines.join("\n")) : { why: "", ctx: "" };
      ctxCache[it.key] = { at: Date.now(), why: q.why, ctx: q.ctx, lastAt: b && b.timestamp };
      if (open) refresh();
    }).catch(function () { ctxCache[it.key] = { at: Date.now(), why: "", ctx: "" }; });
  }
  // ---- v2 scan: read each idle agent's last message now and then (cheap: the main process memoises transcripts per file) ----
  var scanning = false;
  function scanOne(row) {
    var f = row.dataset.folderName || "", path = row.dataset.agentPath || "";
    if (!f || !path || row.classList.contains("xp-working") || row.className.indexOf("xp-needs-") >= 0) { delete asked[f]; return Promise.resolve(); }
    return Promise.resolve(window.api.getLiveTranscript(path, false, true)).then(function (blocks) {
      var last = Array.isArray(blocks) && blocks.length ? blocks[blocks.length - 1] : null;
      var age = last && last.timestamp ? Date.now() - Date.parse(last.timestamp) : Infinity;
      if (last && last.role === "agent" && last.lines && last.lines.length && age < 48 * 3600 * 1000 && looksAsking(last.lines.join("\n"))) {
        var q = extractQuestion(last.lines.join("\n"));
        asked[f] = { why: q.why || "Asked you something", ts: last.timestamp };
      } else delete asked[f];
    }).catch(function () { /* keep the old answer */ });
  }
  function scanAll() {
    if (scanning || document.hidden || !window.api || !window.api.getLiveTranscript) return;
    scanning = true;
    var rows = Array.prototype.slice.call(document.querySelectorAll("#agent-list .agent-item")), sig0 = Object.keys(asked).sort().join("|") + Object.keys(asked).map(function (k) { return asked[k].why; }).join("|");
    var i = 0;
    (function next() {
      if (i >= rows.length) {
        scanning = false;
        var sig1 = Object.keys(asked).sort().join("|") + Object.keys(asked).map(function (k) { return asked[k].why; }).join("|");
        if (sig1 !== sig0) refresh();
        return;
      }
      scanOne(rows[i++]).then(function () { setTimeout(next, 60); });
    })();
  }
  // ---- watching for the agent's reply while a thread is open ----
  function watch(it) {
    if (!it.path || !window.api || !window.api.getLiveTranscript) return;
    var w = watchers[it.key] = watchers[it.key] || { seen: {} };
    w.sentAt = Date.now() - 1500; w.lastActive = Date.now(); w.path = it.path; w.name = it.name;
    if (w.timer) return;
    w.timer = setInterval(function () {
      if (Date.now() - w.lastActive > 180000 || !open) { clearInterval(w.timer); w.timer = null; return; }
      Promise.resolve(window.api.getLiveTranscript(w.path, false, true)).then(function (blocks) {
        if (!Array.isArray(blocks)) return;
        var added = false;
        blocks.forEach(function (b) {
          if (!b || b.role !== "agent" || !b.lines || !b.timestamp) return;
          var t = Date.parse(b.timestamp); if (!(t > w.sentAt) || w.seen[b.timestamp]) return;
          w.seen[b.timestamp] = true; w.lastActive = Date.now();
          (threads[it.key] = threads[it.key] || []).push({ who: "agent", text: b.lines.join("\n").slice(0, 900) }); added = true;
        });
        if (added && open) refresh();
      }).catch(function () { /* next tick */ });
    }, 3000);
  }

  // ---- the bar ----
  function buildBar() {
    var host = document.getElementById("sidebar-header"); if (!host || bar) return;
    bar = el("button", "wq-bar"); bar.type = "button"; bar.id = "wq-bar"; bar.setAttribute("aria-haspopup", "true");
    bar.addEventListener("click", function () { open ? close() : openQueue(); });
    host.insertAdjacentElement("afterend", bar);
  }
  function renderBar(list) {
    if (!bar) return;
    var blocked = list.filter(function (i) { return i.kind === "blocked"; }).length, n = list.length;
    bar.textContent = ""; bar.className = "wq-bar " + (n === 0 ? "wq-grey" : blocked ? "wq-red" : "wq-orange") + (guide ? " wq-pulse" : "");
    var ico = el("span", "wq-ico", n === 0 ? "\u2713" : blocked ? "!" : "?"); ico.setAttribute("aria-hidden", "true");
    var txt = el("span", "wq-txt");
    if (n === 0) txt.appendChild(el("b", "", "Nobody is waiting for you"));
    else { txt.appendChild(el("b", "", n + " waiting for you")); txt.appendChild(el("small", "", blocked ? blocked + " blocked, " + (n - blocked) + " can wait" : "others keep working")); }
    bar.appendChild(ico); bar.appendChild(txt); bar.appendChild(el("span", "wq-caret", open ? "\u25B4" : "\u25BE"));
    bar.setAttribute("aria-label", n === 0 ? "Nobody is waiting for you" : n + " agents waiting for you, " + blocked + " blocked");
    bar.setAttribute("aria-expanded", open ? "true" : "false");
  }

  // ---- answer box ----
  function firstName(n) { return String(n).length <= 22 ? String(n) : String(n).split(" ")[0]; }
  function answerBox(it, list, opts) {
    var box = el("div", "wq-answer");
    var who = el("div", "wq-boxhead"); who.appendChild(avatar(it)); var nmx = el("div", "wq-boxname"); nmx.appendChild(el("b", "", firstName(it.name))); if (it.partner) nmx.appendChild(el("i", "wq-partner", window.AppCfg ? window.AppCfg.partner({ upper: true }) : "PARTNER")); who.appendChild(nmx); if (it.age) who.appendChild(el("span", "wq-age", it.age)); box.appendChild(who);
    box.appendChild(el("div", "wq-q", shownQuestion(it)));
    var cx = it.ctx || ""; var c = ctxCache[it.key];
    if (!cx && c && c.loading) cx = "Reading the agent's last message...";
    if (cx) {
      var cb = el("div", "wq-ctx" + (cx.length > 150 ? " clamp" : ""), cx); box.appendChild(cb);
      if (cx.length > 150) { var more = el("button", "wq-more", "Show the whole background"); more.type = "button"; more.addEventListener("click", function () { var on = cb.classList.toggle("clamp"); more.textContent = on ? "Show the whole background" : "Show less"; }); box.appendChild(more); }
    }
    var th = threads[it.key] || [];
    if (th.length) {
      var tl = el("div", "wq-thread"); tl.setAttribute("role", "log"); tl.setAttribute("aria-live", "polite");
      th.slice(-8).forEach(function (m) { tl.appendChild(el("div", "wq-msg " + (m.who === "you" ? "you" : "agent"), (m.who === "you" ? "You: " : firstName(it.name) + ": ") + m.text)); });
      box.appendChild(tl);
      if (th.length >= 6) box.appendChild(el("div", "wq-hint", "Long talk: continue in the chat (Open chat)."));
    }
    if (it.quick) { var qb = el("div", "wq-quick"); it.quick.forEach(function (q) { var b = el("button", "wq-btn", q); b.type = "button"; b.addEventListener("click", function () { send(it, q, false); }); qb.appendChild(b); }); box.appendChild(qb); }
    var ta = el("textarea", "wq-ta"); ta.dataset.key = it.key; wantPrediction(it);
    var sc = suggChip(it.key, ta); if (sc && predictions[it.key].status === it.status) box.appendChild(sc); ta.rows = 2; ta.placeholder = th.length ? "Reply, or press Send & done if it is settled..." : "Type an answer, or ask the agent a question back..."; ta.setAttribute("aria-label", "Answer to " + it.name);
    ta.addEventListener("keydown", function (e) { if (e.key === "Tab" && !e.shiftKey && !ta.value && predictions[it.key] && predictions[it.key].status === it.status) { e.preventDefault(); ta.value = predictions[it.key].text; var sg = box.querySelector(".wq-sugg"); if (sg) sg.remove(); return; } if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(it, ta.value, false); } });
    box.appendChild(ta);
    var row = el("div", "wq-actions");
    var skip = el("button", "wq-btn", "Skip"); skip.type = "button"; skip.addEventListener("click", function () { cur = (cur + 1) % Math.max(1, list.length); refresh(); });
    var chat = el("button", "wq-btn", "Open chat"); chat.type = "button"; chat.addEventListener("click", function () { if (it.row) it.row.click(); close(); });
    var stay = el("button", "wq-btn", "Reply, keep talking"); stay.type = "button"; stay.title = "Sends your message and keeps this question open for the agent's answer"; stay.addEventListener("click", function () { send(it, ta.value, true); });
    var snd = el("button", "wq-btn wq-primary", "Send & done"); snd.type = "button"; snd.addEventListener("click", function () { send(it, ta.value, false); });
    row.appendChild(skip); row.appendChild(chat); row.appendChild(stay); row.appendChild(snd); box.appendChild(row);
    box.appendChild(el("div", "wq-mirror", demoMode ? "Demo: nothing is sent in the sandbox." : "Same conversation as in " + firstName(it.name) + "'s own chat. Chats in Claude Desktop are not mirrored."));
    if (opts && opts.focus) setTimeout(function () { ta.focus(); }, 30);
    return box;
  }
  // Suggested answer for one waiting item (v1.117.0). Same switch as the chat ("Predicted replies" checkbox); one call per item and
  // question, one at a time (the service spaces calls 12 s apart, so a busy answer is retried a few times), never for demo items.
  function predictionOn() { try { var s = window.predictReplies && window.predictReplies._state(); return !!(s && s.enabled); } catch (e) { return false; } }
  function wantPrediction(it) {
    if (demoMode || !it.path || !window.api || !window.api.predictRequest || !predictionOn()) return;
    var k = it.key + "|" + it.status; if (predTried[k]) return; predTried[k] = 1;
    predChain = predChain.then(function () { return askPrediction(it, 0); });
  }
  function askPrediction(it, n) {
    var c = ctxCache[it.key], text = it.status + (it.ctx || (c && c.ctx) ? "\n\n" + (it.ctx || c.ctx) : "");
    return Promise.resolve(window.api.predictRequest({ agentPath: it.path, turnKey: "q:" + it.key + "|" + it.status, assistantText: text, userMessages: [], boxEmpty: true, queue: true })).then(function (r) {
      if (r && r.suggestion) { predictions[it.key] = { status: it.status, text: r.suggestion }; showPrediction(it.key); return; }
      if (r && /^(cooldown|cooldown-agent|busy)$/.test(r.reason) && n < 4) return new Promise(function (res) { setTimeout(res, 13000); }).then(function () { return askPrediction(it, n + 1); });
    }).catch(function () { /* no suggestion */ });
  }
  function showPrediction(key) {   // fill in a chip into an open box without redrawing it (keeps typed text and focus)
    document.querySelectorAll(".wq-ta").forEach(function (ta) { if (ta.dataset.key === key && !ta.parentNode.querySelector(".wq-sugg")) { var chip = suggChip(key, ta); if (chip) ta.parentNode.insertBefore(chip, ta); } });
  }
  function suggChip(key, ta) {
    var p = predictions[key]; if (!p || ta.value) return null;
    var b = el("button", "wq-sugg", "Suggested: " + p.text); b.type = "button"; b.title = "Click, or press Tab in the empty box, to put this in the answer box (it is not sent)";
    b.addEventListener("click", function () { ta.value = p.text; ta.focus(); b.remove(); }); return b;
  }
  function doneQ(it) {   // the registered question is answered: move its file to answered\ and drop it from the list now
    if (!it.qid) return;
    registered = registered.filter(function (q) { return q.id !== it.qid; });
    try { window.api.resolveOpenQuestion(it.qid); } catch (e) { /* the file stays; it will show again */ }
  }
  function send(it, text, keep) {
    text = String(text || "").trim();
    if (!text) { toast("Type something first"); return; }
    var finish = function () {
      (threads[it.key] = threads[it.key] || []).push({ who: "you", text: text });
      document.querySelectorAll(".wq-ta").forEach(function (t) { if (t.dataset.key === it.key) t.value = ""; });   // sent: do not restore it as a draft
      if (keep) { watch(it); toast("Sent to " + firstName(it.name) + ". Its reply will appear here."); refresh(); }
      else { dismissed[it.key] = it.status; doneQ(it); toast("Sent. " + firstName(it.name) + " leaves the queue."); if (cur > 0) cur--; refresh(); }
    };
    if (demoMode || !it.path || !window.queueSendToAgent) {            // sandbox / sample items: nothing is delivered
      (threads[it.key] = threads[it.key] || []).push({ who: "you", text: text });
      if (keep) { toast("Demo: sent to " + firstName(it.name) + " (not really, in the sandbox)."); setTimeout(function () { (threads[it.key] = threads[it.key] || []).push({ who: "agent", text: "(demo reply) Thanks, understood. One question back: is that for today only, or for the whole cutover?" }); if (open) refresh(); }, 1400); refresh(); }
      else { dismissed[it.key] = it.status; toast("Demo: this is NOT sent in the sandbox. " + firstName(it.name) + " leaves the queue."); if (cur > 0) cur--; refresh(); }
      return;
    }
    window.queueSendToAgent(it.path, text).then(function (r) {
      if (r && r.ok) finish(); else toast("Could not send to " + firstName(it.name) + ": " + ((r && r.error) || "unknown error") + ". Nothing was sent.");
    }).catch(function (e) { toast("Could not send: " + (e && e.message || e)); });
  }

  // ---- the panel (style D; A, B, C only in the sandbox demo) ----
  function head(title) { var h = el("div", "wq-head"); h.appendChild(el("b", "", title)); var keys = el("span", "wq-keys"); ["Ctrl+Enter send", "Esc close"].forEach(function (t) { keys.appendChild(el("kbd", "", t)); }); h.appendChild(keys); return h; }
  function listRow(it, i, current) {
    var r = el("button", "wq-row" + (i === current ? " cur" : "")); r.type = "button"; r.appendChild(avatar(it));
    var t = el("span", "wq-rt"); var nm = el("b", "", it.name); if (it.partner) nm.appendChild(el("i", "wq-partner", window.AppCfg ? window.AppCfg.partner({ upper: true }) : "PARTNER")); t.appendChild(nm); t.appendChild(el("small", "", shownQuestion(it))); r.appendChild(t);
    r.appendChild(el("span", "wq-age", it.age || "")); r.addEventListener("click", function () { cur = i; refresh(); }); return r;
  }
  function clearPanel() {
    if (panel) { panel.remove(); panel = null; }
    document.body.classList.remove("wq-filter", "wq-style-A", "wq-style-B", "wq-style-C", "wq-style-D");
    document.querySelectorAll(".wq-inline").forEach(function (n) { n.remove(); });
    document.querySelectorAll(".agent-item.wq-waiting").forEach(function (n) { n.classList.remove("wq-waiting"); });
  }
  function place(p) { var sb = document.getElementById("sidebar"), r = bar.getBoundingClientRect(), s = sb ? sb.getBoundingClientRect() : { right: 280 }; p.style.left = Math.round(s.right + 8) + "px"; p.style.top = Math.max(8, Math.round(r.top)) + "px"; }
  function buildPanel(list) {
    // keep a typed-but-unsent answer when the panel redraws (a reply arrived, a poll tick)
    var drafts = {}; document.querySelectorAll(".wq-answer").forEach(function (b) { var ta = b.querySelector("textarea"), h = b.querySelector(".wq-boxname b"); if (ta && ta.value && h) drafts[h.textContent] = ta.value; });
    clearPanel(); if (!open) return;
    document.body.classList.add("wq-style-" + style);
    if (cur >= list.length) cur = Math.max(0, list.length - 1);
    var it = list[cur];
    if (!list.length) { panel = el("div", "wq-panel wq-empty-panel", "Nobody is waiting for you."); document.body.appendChild(panel); place(panel); return; }
    list.forEach(function (x) { loadContext(x); });
    if (style === "D") {
      document.body.classList.add("wq-filter");
      var extras = [];
      list.forEach(function (x) {
        if (x.row) x.row.classList.add("wq-waiting");   // v1.115.1: the answer boxes live in the CENTER pane (as in the mockup), never inline in the left list
        extras.push(x);
      });
      if (extras.length) { panel = el("div", "wq-panel wq-d-extra"); if (demoMode) panel.appendChild(el("b", "", "Sample items (demo)")); extras.forEach(function (x) { var r = el("div", "wq-dx"); r.appendChild(answerBox(x, list)); panel.appendChild(r); }); document.body.appendChild(panel); place(panel); }
    } else {
      panel = el("div", "wq-panel wq-p" + style); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Waiting for you");
      if (style === "B") {
        panel.appendChild(head("Waiting for you (" + list.length + ")"));
        list.forEach(function (x, i) { panel.appendChild(listRow(x, i, cur)); if (i === cur) panel.appendChild(answerBox(x, list, { focus: true })); });
        document.body.appendChild(panel); place(panel);
      } else if (style === "A") {
        panel.appendChild(el("div", "wq-count", (cur + 1) + " of " + list.length));
        var nav = el("div", "wq-nav"); var pv = el("button", "wq-btn", "\u25C0"); pv.type = "button"; pv.setAttribute("aria-label", "Previous"); pv.addEventListener("click", function () { cur = (cur - 1 + list.length) % list.length; refresh(); });
        var nx = el("button", "wq-btn", "\u25B6"); nx.type = "button"; nx.setAttribute("aria-label", "Next"); nx.addEventListener("click", function () { cur = (cur + 1) % list.length; refresh(); });
        nav.appendChild(pv); nav.appendChild(el("div", "wq-who")); nav.appendChild(nx); panel.appendChild(nav); panel.appendChild(answerBox(it, list, { focus: true })); bar.insertAdjacentElement("afterend", panel);
      } else {
        panel.classList.add("wq-focus"); panel.appendChild(el("div", "wq-count", "Waiting for you: " + (cur + 1) + " of " + list.length)); panel.appendChild(answerBox(it, list, { focus: true }));
        var cl = el("button", "wq-btn wq-closebtn", "Close (Esc)"); cl.type = "button"; cl.addEventListener("click", close); panel.appendChild(cl); document.body.appendChild(panel);
      }
    }
    document.querySelectorAll(".wq-answer").forEach(function (b) { var h = b.querySelector(".wq-boxname b"), ta = b.querySelector("textarea"); if (h && ta && drafts[h.textContent]) ta.value = drafts[h.textContent]; });
  }

  function refresh() { var list = items(); renderBar(list); buildPanel(list); }
  function openQueue() { open = true; cur = 0; refresh(); }
  function close() { open = false; refresh(); }
  document.addEventListener("keydown", function (e) {
    if (!open) return;
    if (e.key === "Escape") { close(); return; }
    if (style === "B" && e.target && e.target.tagName !== "TEXTAREA") { var list = items(); if (e.key === "ArrowDown") { cur = Math.min(list.length - 1, cur + 1); refresh(); e.preventDefault(); } if (e.key === "ArrowUp") { cur = Math.max(0, cur - 1); refresh(); e.preventDefault(); } }
  });
  document.addEventListener("mousedown", function (e) { if (open && style === "B" && panel && !panel.contains(e.target) && bar && !bar.contains(e.target)) close(); });

  // ---- sandbox-only demo controls ----
  function buildCtl() {
    ctl = el("div", "wq-ctl"); ctl.appendChild(el("b", "", "Queue demo"));
    ["A", "B", "C", "D"].forEach(function (s) {
      var b = el("button", "wq-sw" + (s === style ? " on" : ""), s); b.type = "button"; b.title = { A: "A: in-pane carousel", B: "B: popover list", C: "C: focus mode", D: "D: filter the left pane, answer inline (chosen)" }[s];
      b.addEventListener("click", function () { style = s; lset(LS_STYLE, s); ctl.querySelectorAll(".wq-sw").forEach(function (x) { x.classList.toggle("on", x.textContent === s); }); open = true; cur = 0; refresh(); });
      ctl.appendChild(b);
    });
    var rs = el("button", "wq-btn", "Reset"); rs.type = "button"; rs.addEventListener("click", function () { dismissed = {}; threads = {}; cur = 0; refresh(); toast("Demo items are back"); });
    var wh = el("button", "wq-btn", "Where is it?"); wh.type = "button"; wh.addEventListener("click", showGuide);
    ctl.appendChild(rs); ctl.appendChild(wh); document.body.appendChild(ctl);
  }
  function showGuide() {
    if (!bar) return; if (guide) guide.remove();
    var r = bar.getBoundingClientRect(); guide = el("div", "wq-guide");
    guide.style.left = Math.round(r.right + 14) + "px"; guide.style.top = Math.max(8, Math.round(r.top - 6)) + "px";
    guide.appendChild(el("b", "", "Here it is."));
    guide.appendChild(el("p", "", "The \"waiting for you\" bar sits at the top of the left pane, right under the Agents title. Press it to see who is waiting and answer them one by one."));
    var ok = el("button", "wq-btn wq-primary", "Got it"); ok.type = "button"; ok.addEventListener("click", function () { guide.remove(); guide = null; bar.classList.remove("wq-pulse"); lset("agentDesktop.waitingQueue.guideSeen", "1"); }); guide.appendChild(ok);
    document.body.appendChild(guide); bar.classList.add("wq-pulse");
  }

  function start() {
    buildBar(); if (!bar) { setTimeout(start, 400); return; }
    if (demoMode) buildCtl();
    refresh();
    loadRegistered(); setInterval(loadRegistered, 15000);                       // registered questions: a tiny folder listing
    setTimeout(scanAll, 6000); setInterval(scanAll, 120000);                     // fallback: idle agents whose last message asks him something
    if (demoMode || ls("agentDesktop.waitingQueue.guideSeen") !== "1") setTimeout(showGuide, 800);   // the first time (or in the demo) point at the bar
    var list = document.getElementById("agent-list");
    var sig = function () { return rowsWaiting().map(function (i) { return i.key + "|" + i.kind; }).join(","); }, lastSig = sig();
    if (list) new MutationObserver(function () {
      clearTimeout(start._t);
      start._t = setTimeout(function () { var s = sig(); if (!open) { lastSig = s; refresh(); } else if (s !== lastSig) { lastSig = s; refresh(); } }, 300);   // while open, redraw only when WHO is waiting changed (typed drafts are kept anyway)
    }).observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else setTimeout(start, 400);
})();
