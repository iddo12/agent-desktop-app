// ANSWER ONCE (v1.152.0, Security, 2026-10-31). An agent registers a question with shared_tools\ask_iddo.py (id like 20261031-014211-9f54). The owner must
// never have to answer it twice. Two ways in, both ending in the SAME delivery as a "waiting for you" queue button (window.queueSendToAgent types the
// answer into the ASKING agent's chat as a genuine user message, then resolve-open-question moves the file to answered\):
//  1. INLINE: any chat bubble (agent or user) that mentions an id of a still-open question gets that question's text and quick buttons under it.
//  2. THE CONFIRM WINDOW: shared_tools\ask_confirm.py pops a window; the owner's click writes a signed request; main (src/answerOnce.js) verifies it and
//     sends "answer-once-deliver" here. No agent can produce either click. textContent only; nothing is typed that is not one of the ask's own quick answers.
(function () {
  "use strict";
  var ID_RX = /\b\d{8}-\d{6}-[0-9a-f]{4}\b/g;
  var norm = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); };

  // ---- pure helpers (window.AnswerOncePure, tested) ----
  function findIds(text) { var m = String(text || "").match(ID_RX) || [], out = []; m.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); }); return out.slice(0, 3); }
  // rows = [{folder, display, path}]; same matching as the waiting queue: equal names, or one starts with the other plus a space
  function matchAgent(askAgent, rows) {
    var a = norm(askAgent); if (!a) return null;
    for (var i = 0; i < rows.length; i++) { var f = norm(rows[i].folder), d = norm(rows[i].display); if (a === f || a === d || (f && f.indexOf(a + " ") === 0) || (d && d.indexOf(a + " ") === 0)) return rows[i]; }
    return null;
  }
  window.AnswerOncePure = { findIds: findIds, matchAgent: matchAgent };   // bubbleText is DOM-bound, checked in the sandbox

  var asks = {}, answeredHere = {}, inflight = {}, ver = 0, lastLoad = 0, loading = null;
  function rows() {
    var out = [];
    document.querySelectorAll("#agent-list .agent-item").forEach(function (r) { var nm = r.querySelector(".agent-item-name"); out.push({ folder: r.dataset.folderName || "", display: nm ? nm.textContent : "", path: r.dataset.agentPath || "" }); });
    return out;
  }
  function refresh(force) {
    if (!window.api || !window.api.listOpenQuestions) return Promise.resolve();
    if (loading) return loading;
    if (!force && Date.now() - lastLoad < 8000) return Promise.resolve();
    loading = Promise.resolve(window.api.listOpenQuestions()).then(function (qs) {
      var next = {}; (Array.isArray(qs) ? qs : []).forEach(function (q) { if (q && q.id) next[q.id] = q; });
      var changed = Object.keys(next).sort().join() !== Object.keys(asks).sort().join();
      asks = next; lastLoad = Date.now(); if (changed) ver++; updateCards();
    }).catch(function () { /* next time */ }).then(function () { loading = null; });
    return loading;
  }

  // ---- the one delivery path ----
  // Returns {ok, error?, retry?}. Re-reads the question first, so a stale card can never answer something already answered or changed.
  function answer(id, label) {
    if (inflight[id]) return Promise.resolve({ ok: false, error: "already sending" });
    inflight[id] = true; updateCards();
    var fin = function (r) {
      delete inflight[id];
      if (r.ok) { answeredHere[id] = { label: label, agent: (asks[id] || {}).agent || "" }; delete asks[id]; ver++; try { window.dispatchEvent(new CustomEvent("answer-once-resolved", { detail: { id: id } })); } catch (e) { /* old engine */ } }
      updateCards(); return r;
    };
    if (!window.queueSendToAgent || !window.api) return Promise.resolve(fin({ ok: false, retry: true, error: "chat not ready" }));
    return Promise.resolve(window.api.listOpenQuestions()).then(function (qs) {
      var ask = (qs || []).filter(function (q) { return q && q.id === id; })[0];
      if (!ask) return { ok: false, error: "that question is already answered or withdrawn" };
      if (!Array.isArray(ask.quick) || ask.quick.indexOf(label) < 0) return { ok: false, error: "not one of the question's quick answers" };
      asks[id] = ask;
      var rs = rows(); if (!rs.length) return { ok: false, retry: true, error: "agent list not loaded yet" };
      var hit = matchAgent(ask.agent, rs); if (!hit || !hit.path) return { ok: false, error: "the asking agent (" + ask.agent + ") is not in the list" };
      return Promise.resolve(window.queueSendToAgent(hit.path, label)).then(function (r) {
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || "unknown error" };
        // delivered; a failed move only means the question may reappear in the list
        return Promise.resolve(window.api.resolveOpenQuestion(id)).then(function () { return { ok: true }; }, function () { return { ok: true }; });
      });
    }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; }).then(fin);
  }

  // ---- inline cards ----
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function paint(card) {
    var id = card.dataset.askId, ask = asks[id], done = answeredHere[id];
    card.textContent = "";
    if (done) { card.className = "ao-card ao-done"; card.appendChild(el("span", "ao-tick", "Answered")); card.appendChild(el("span", "ao-msg", ": " + done.label + (done.agent ? " (sent to " + done.agent + ")" : ""))); return; }
    if (!ask) { card.className = "ao-card ao-gone"; card.appendChild(el("span", "ao-msg", "Question " + id + " is no longer open.")); return; }
    card.className = "ao-card";
    card.appendChild(el("div", "ao-head", "Open question from " + ask.agent + " (" + id + ")"));
    var q = el("div", "ao-q", ask.question); q.dir = "auto"; card.appendChild(q);
    var row = el("div", "ao-btns"), quick = Array.isArray(ask.quick) ? ask.quick : [];
    if (!quick.length) row.appendChild(el("span", "ao-msg", "No quick answers on this one: answer it in the \"waiting for you\" bar."));
    quick.forEach(function (label) {
      var b = el("button", "ao-btn", label); b.type = "button"; b.disabled = !!inflight[id];
      b.addEventListener("click", function () {
        answer(id, label).then(function (r) { if (!r.ok) { var old = card.querySelector(".ao-err"); if (old) old.remove(); card.appendChild(el("div", "ao-err", "Could not send: " + r.error + ". Nothing was sent.")); } });
      });
      row.appendChild(b);
    });
    card.appendChild(row);
    if (inflight[id]) card.appendChild(el("div", "ao-msg", "Sending..."));
  }
  // the bubble's own text without its time label (it sits right behind the last word: "...503b02:06 PM" hides the id from ) and without our cards
  function bubbleText(b) { var t = ""; b.childNodes.forEach(function (n) { if (n.nodeType === 1 && n.classList && (n.classList.contains("chat-block-time") || n.classList.contains("ao-card"))) return; t += n.textContent; }); return t; }
  function updateCards() { document.querySelectorAll(".ao-card").forEach(paint); }
  function scan(root) {
    root = root || document; var need = false;
    root.querySelectorAll(".chat-bubble").forEach(function (b) {
      if (b.dataset.aoV === String(ver)) return;
      b.dataset.aoV = String(ver);
      var ids = findIds(bubbleText(b)); if (!ids.length) return;
      ids.forEach(function (id) {
        if (!asks[id] && !answeredHere[id]) { need = true; return; }
        if (b.querySelector('.ao-card[data-ask-id="' + id + '"]')) return;
        var c = el("div", "ao-card"); c.dataset.askId = id; paint(c); b.appendChild(c);
      });
    });
    // an id was seen that is not in the list yet: load once; if the list changed, ver moved and the next pass places the card
    if (need) refresh().then(function () { if (Object.keys(asks).length) scan(root); });
  }
  window.AnswerOnce = { answer: answer, scan: scan, refresh: refresh, markClosed: function (id) { delete asks[id]; ver++; updateCards(); } };

  if (window.api && window.api.onAnswerOnceDeliver) {
    window.api.onAnswerOnceDeliver(function (p) {
      if (!p || !p.reqId) return;
      answer(String(p.id || ""), String(p.answer || "")).then(function (r) { window.api.answerOnceResult({ reqId: p.reqId, ok: !!r.ok, error: r.error || "", retry: !!r.retry }); });
    });
  }
  setInterval(function () { if (document.querySelector(".ao-card")) refresh(true); }, 15000);
})();
