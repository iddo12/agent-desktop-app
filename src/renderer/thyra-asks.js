// v1.154.0 THYRA "Questions for you": the open asks (shared_tools\ask_iddo.py) as a second section under the permission prompts in the dock window and the
// in-app pop-up. Rules are in src/dockAsks.js. Only the owner's real click (isTrusted) sends anything; each click carries exactly the question that was
// drawn, main re-reads the ask file and refuses on any difference, then delivers through the same path as the inline cards (answer-once.js).
// Nothing is answered on a timer, an ask without quick answers gets no button. Shared by approvals-popup.js (loaded before it).
(function (root) {
  "use strict";
  var SETTLE_MS = 1000, NOTE_MS = 6000, OLDER_CAP = 200;

  // "5 min", "2 h", "1 day", "3 days": how old the ask is, shown on every row so stale ones stand out
  function ageText(ms) {
    var m = Math.round(ms / 60000);
    if (m < 1) return "now"; if (m < 60) return m + " min";
    var h = Math.round(m / 60); if (h < 48) return h + " h";
    var d = Math.floor(ms / 86400000); return d + (d === 1 ? " day" : " days");
  }

  function create(opts) {
    var api = opts.api, el = opts.el, fmt = opts.fmt, onChange = opts.onChange || function () {}, clock = opts.now || Date.now, later = opts.later || setTimeout;
    var rows = [], showOlder = false, changedAt = 0, lastKey = "", busy = {}, done = [], expanded = {}, errors = {}, drafts = {}, cleared = [], showMaybe = false, showCleared = false;

    function keyOf() { return rows.map(function (r) { return r.id + "|" + (r.older ? 1 : 0) + "|" + (r.maybeAnswered ? 1 : 0) + "|" + (r.kind || "ask") + "|" + (r.quick || []).join("\u0001"); }).join("\n") + "#" + cleared.map(function (c) { return c.id; }).join(","); }
    function recent() { return rows.filter(function (r) { return !r.older; }); }
    function older() { return rows.filter(function (r) { return r.older; }); }
    function maybe() { return []; }   // hint only: such rows stay in the main list
    function settling() { return clock() - changedAt < SETTLE_MS; }

    function refresh() {
      return Promise.resolve(api.dockAsksList()).then(function (r) {
        rows = r && r.ok && Array.isArray(r.rows) ? r.rows : []; cleared = r && r.ok && Array.isArray(r.cleared) ? r.cleared : [];
      }, function () { rows = []; cleared = []; }).then(function () {
        var k = keyOf();
        if (k !== lastKey) { lastKey = k; changedAt = clock(); later(onChange, SETTLE_MS + 100); }   // buttons stay disabled 1 s after the list changes, like the permission rows
        onChange();
      });
    }

    function note(text, bad) {
      var n = { text: text, bad: bad }; done.push(n);
      later(function () { done = done.filter(function (d) { return d !== n; }); onChange(); }, NOTE_MS);
    }
    // "No longer needed": clears the ask without sending or sealing anything. Real click only; main re-reads the file and refuses if it changed.
    function dismiss(ev, row) {
      if (!ev || ev.isTrusted !== true) return null;
      if (busy[row.id] || settling()) return null;
      busy[row.id] = true; delete errors[row.id]; onChange();
      var req = { id: row.id, shown: { question: row.question, agent: row.agent, quick: row.quick || [], context: row.context || "", merav: !!row.merav, created: row.created || "" } };
      return Promise.resolve().then(function () { return api.dockAskDismiss(req); }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; }).then(function (r) {
        delete busy[row.id];
        if (r && r.ok) { rows = rows.filter(function (x) { return x.id !== row.id; }); note("Cleared (" + row.agent + "): no answer was sent", false); }
        else errors[row.id] = "Not cleared: " + String((r && r.error) || "unknown error");
        return refresh().then(function () {
          if (!(r && r.ok) && !rows.some(function (x) { return x.id === row.id; })) note("Not cleared (" + row.agent + "): " + String((r && r.error) || "unknown error"), true);
          return r || { ok: false };
        });
      });
    }
    // v1.155.0 free-text reply: the owner's own words typed to the asking agent. keep=true leaves the question open. Real click / Enter only.
    function reply(ev, row, text, keep) {
      if (!ev || ev.isTrusted !== true) return null;
      text = String(text || "").trim();
      if (!text) { errors[row.id] = "Type something first"; onChange(); return null; }
      if (busy[row.id] || settling() || !api.dockAskReply) return null;
      busy[row.id] = true; delete errors[row.id]; onChange();
      var req = { id: row.id, text: text, keep: !!keep, shown: { question: row.question, agent: row.agent, quick: row.quick || [], context: row.context || "", merav: !!row.merav, created: row.created || "" } };
      return Promise.resolve().then(function () { return api.dockAskReply(req); }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; }).then(function (r) {
        delete busy[row.id];
        if (r && r.ok) {
          delete drafts[row.id];
          if (!keep) rows = rows.filter(function (x) { return x.id !== row.id; });
          note("Sent to " + row.agent + (keep ? " (question stays open)" : " (question closed)"), false);
        } else errors[row.id] = "Not sent: " + String((r && r.error) || "unknown error");
        return refresh().then(function () {
          if (!(r && r.ok) && !rows.some(function (x) { return x.id === row.id; })) note("Not sent (" + row.agent + "): " + String((r && r.error) || "unknown error"), true);
          return r || { ok: false };
        });
      });
    }
    // one-id action (Still waiting / Undo): real click only; main does the file work and refuses on any problem
    function act(ev, id, label, call, okText) {
      if (!ev || ev.isTrusted !== true) return null;
      if (busy[id] || settling() || !call) return null;
      busy[id] = true; delete errors[id]; onChange();
      return Promise.resolve().then(function () { return call({ id: id }); }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; }).then(function (r) {
        delete busy[id];
        if (r && r.ok) note(okText, false); else errors[id] = label + ": " + String((r && r.error) || "unknown error");
        return refresh().then(function () { return r || { ok: false }; });
      });
    }
    function keep(ev, row) { return act(ev, row.id, "Not changed", api.dockAskKeep, "Back in the list (" + row.agent + ")"); }
    function undo(ev, c) { return act(ev, c.id, "Not restored", api.dockAskUndo, "Restored (" + c.agent + ")"); }
    // ev = the click event. Returns a promise of {ok, error?} or null when the click was ignored.
    function click(ev, row, label) {
      if (!ev || ev.isTrusted !== true) return null;                      // scripted clicks never answer anything
      if (busy[row.id] || settling()) return null;
      busy[row.id] = true; delete errors[row.id]; onChange();
      var req = { id: row.id, label: label, shown: { question: row.question, agent: row.agent, quick: row.quick || [], context: row.context || "", merav: !!row.merav, created: row.created || "" } };
      return Promise.resolve().then(function () { return api.dockAskAnswer(req); }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; }).then(function (r) {
        delete busy[row.id];
        if (r && r.ok) {
          rows = rows.filter(function (x) { return x.id !== row.id; });
          note("Answered: " + label + " (sent to " + row.agent + ")", false);
        } else errors[row.id] = "Not answered: " + String((r && r.error) || "unknown error");
        return refresh().then(function () {
          // refused because the ask is gone (answered elsewhere / withdrawn): its row disappears with the refresh, so keep the reason visible for a moment
          if (!(r && r.ok) && !rows.some(function (x) { return x.id === row.id; })) note("Not answered (" + row.agent + "): " + String((r && r.error) || "unknown error"), true);
          return r || { ok: false };
        });
      });
    }

    // Appends the section to `parent`. Returns the number of recent asks (what the header and chip count).
    function render(parent) {
      var rec = recent(), old = older(), may = maybe(), set = settling();
      if (!rec.length && !old.length && !done.length && !may.length && !cleared.length) return 0;
      var head = el("div", "ap-sec", "Questions for you" + (rec.length ? " (" + rec.length + ")" : ""));
      parent.append(head);
      done.forEach(function (d) { parent.append(el("div", d.bad ? "ap-msg ap-fail" : "ap-done", d.text)); });
      if (!rec.length) parent.append(el("div", "ap-msg ap-none", "Nothing new in the last 3 days."));
      var isNote = function (r) { return r.kind === "note"; };
      var draw = function (r) {
        var item = el("div", "ap-item ap-ask"), top = el("div", "ap-top");
        top.append(el("span", "ap-name", r.agent), el("span", "ap-wait", ageText(r.ageMs)));
        var q = el("div", expanded[r.id] ? "ap-q ap-open" : "ap-q", r.question);
        q.title = r.question + (r.context ? "\n\n" + r.context : ""); q.dir = "auto";
        q.addEventListener("click", function (ev) { if (!ev.isTrusted) return; if (expanded[r.id]) delete expanded[r.id]; else expanded[r.id] = true; onChange(); });   // full text on click; hover shows it too
        item.append(top, q);
        var btns = el("div", "ap-btns"), quick = r.quick || [];
        if (isNote(r)) { var gb = el("button", "ap-qbtn", "Got it"); gb.title = "Clear this note (nothing is sent to the agent)"; gb.disabled = !!busy[r.id] || set; gb.addEventListener("click", function (ev) { dismiss(ev, r); }); btns.append(gb); }
        else if (!quick.length) btns.append(el("span", "ap-msg", "No quick answers: write below or answer in the agent's chat."));
        if (r.stale14) btns.append(el("span", "ap-stale", "14+ days old: still wanted?"));
        if (r.maybeAnswered) {
          btns.append(el("span", "ap-msg", "You messaged " + r.agent + " after this was asked. Answered already?"));
          var kb2 = el("button", "ap-keepwait", "Still waiting"); kb2.title = "This is still open: put it back in the list"; kb2.disabled = !!busy[r.id] || set; kb2.addEventListener("click", function (ev) { keep(ev, r); }); btns.append(kb2);
        }
        quick.forEach(function (label) {
          var b = el("button", "ap-qbtn", label); b.disabled = !!busy[r.id] || set;
          b.addEventListener("click", function (ev) { click(ev, r, label); });
          btns.append(b);
        });
        if (api.dockAskDismiss && !isNote(r)) { var dm = el("button", "ap-dismiss", r.maybeAnswered ? "Yes, answered: clear" : "No longer needed"); dm.title = "Clear this question without answering it (nothing is sent to the agent)"; dm.disabled = !!busy[r.id] || set; dm.addEventListener("click", function (ev) { dismiss(ev, r); }); btns.append(dm); }
        if (errors[r.id]) btns.append(el("span", "ap-msg", errors[r.id]));
        if (busy[r.id]) btns.append(el("span", "ap-msg", "Sending..."));
        item.append(btns);
        if (api.dockAskReply && !isNote(r)) {
          var rb = el("div", "ap-reply"), ta = el("input", "ap-reply-in"); ta.type = "text"; ta.dataset.rid = r.id; ta.maxLength = 600; ta.placeholder = "Write to " + r.agent + "..."; ta.value = drafts[r.id] || ""; ta.dir = "auto"; ta.disabled = !!busy[r.id];
          ta.addEventListener("input", function () { drafts[r.id] = ta.value; });
          ta.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && ev.isTrusted && !ev.isComposing) { ev.preventDefault(); reply(ev, r, ta.value, false); } });
          var sb = el("button", "ap-send", "Send"); sb.title = "Send this to the agent and close the question"; sb.disabled = !!busy[r.id] || set;
          sb.addEventListener("click", function (ev) { reply(ev, r, ta.value, false); });
          var kb = el("button", "ap-keep", "Send, keep open"); kb.title = "Send this to the agent but leave the question open"; kb.disabled = !!busy[r.id] || set;
          kb.addEventListener("click", function (ev) { reply(ev, r, ta.value, true); });
          rb.append(ta, sb, kb); item.append(rb);
        }
        parent.append(item);
      };
      rec.forEach(draw);
      if (old.length) {
        var tg = el("button", "ap-older", showOlder ? "Hide older (" + old.length + ")" : "Show older (" + old.length + ")");
        tg.addEventListener("click", function (ev) { if (!ev.isTrusted) return; showOlder = !showOlder; onChange(); });
        parent.append(tg);
        if (showOlder) { old.slice(0, OLDER_CAP).forEach(draw); if (old.length > OLDER_CAP) parent.append(el("div", "ap-msg", (old.length - OLDER_CAP) + " more not shown.")); }
      }
      if (may.length) {
        var tm = el("button", "ap-older ap-maybe", showMaybe ? "Hide maybe already answered (" + may.length + ")" : "Maybe already answered (" + may.length + ")");
        tm.title = "You wrote to these agents after they asked. The sweep archives them 24 h later unless you press Still waiting.";
        tm.addEventListener("click", function (ev) { if (!ev.isTrusted) return; showMaybe = !showMaybe; onChange(); });
        parent.append(tm); if (showMaybe) may.slice(0, OLDER_CAP).forEach(draw);
      }
      if (cleared.length) {
        var tc = el("button", "ap-older ap-clearedtg", showCleared ? "Hide cleared automatically (" + cleared.length + ")" : "Cleared automatically (" + cleared.length + ", last 7 days)");
        tc.addEventListener("click", function (ev) { if (!ev.isTrusted) return; showCleared = !showCleared; onChange(); });
        parent.append(tc);
        if (showCleared) cleared.forEach(function (c) {
          var it = el("div", "ap-item ap-cleared"), tp = el("div", "ap-top"); tp.append(el("span", "ap-name", c.agent), el("span", "ap-wait", c.reason || "cleared"));
          var q = el("div", "ap-q", c.question); q.title = c.question; q.dir = "auto";
          var bt = el("div", "ap-btns"), ub = el("button", "ap-qbtn", "Undo"); ub.title = "Put this question back in the list"; ub.disabled = !!busy[c.id] || set; ub.addEventListener("click", function (ev) { undo(ev, c); });
          bt.append(ub); if (errors[c.id]) bt.append(el("span", "ap-msg", errors[c.id])); it.append(tp, q, bt); parent.append(it);
        });
      }
      return rec.length;
    }
    // part of the repaint signature: anything that changes what render() would draw
    function sig() { return [keyOf(), showOlder, settling(), Object.keys(busy).join(), done.length, Object.keys(expanded).join(), Object.keys(errors).join(), showMaybe, showCleared].join("#"); }

    return { refresh: refresh, click: click, dismiss: dismiss, keep: keep, undo: undo, reply: reply, ageText: ageText, render: render, sig: sig, recentCount: function () { return recent().length; }, olderCount: function () { return older().length; }, rows: function () { return rows; }, setShowOlder: function (v) { showOlder = !!v; }, settling: settling };
  }
  root.ThyraAsks = { create: create, ageText: ageText, SETTLE_MS: SETTLE_MS };
})(typeof window !== "undefined" ? window : globalThis);
