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
    var rows = [], showOlder = false, changedAt = 0, lastKey = "", busy = {}, done = [], expanded = {}, errors = {};

    function keyOf() { return rows.map(function (r) { return r.id + "|" + (r.older ? 1 : 0) + "|" + (r.quick || []).join("\u0001"); }).join("\n"); }
    function recent() { return rows.filter(function (r) { return !r.older; }); }
    function older() { return rows.filter(function (r) { return r.older; }); }
    function settling() { return clock() - changedAt < SETTLE_MS; }

    function refresh() {
      return Promise.resolve(api.dockAsksList()).then(function (r) {
        rows = r && r.ok && Array.isArray(r.rows) ? r.rows : [];
      }, function () { rows = []; }).then(function () {
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
      var rec = recent(), old = older(), set = settling();
      if (!rec.length && !old.length && !done.length) return 0;
      var head = el("div", "ap-sec", "Questions for you" + (rec.length ? " (" + rec.length + ")" : ""));
      parent.append(head);
      done.forEach(function (d) { parent.append(el("div", d.bad ? "ap-msg ap-fail" : "ap-done", d.text)); });
      if (!rec.length) parent.append(el("div", "ap-msg ap-none", "Nothing new in the last 3 days."));
      var draw = function (r) {
        var item = el("div", "ap-item ap-ask"), top = el("div", "ap-top");
        top.append(el("span", "ap-name", r.agent), el("span", "ap-wait", ageText(r.ageMs)));
        var q = el("div", expanded[r.id] ? "ap-q ap-open" : "ap-q", r.question);
        q.title = r.question + (r.context ? "\n\n" + r.context : ""); q.dir = "auto";
        q.addEventListener("click", function (ev) { if (!ev.isTrusted) return; if (expanded[r.id]) delete expanded[r.id]; else expanded[r.id] = true; onChange(); });   // full text on click; hover shows it too
        item.append(top, q);
        var btns = el("div", "ap-btns"), quick = r.quick || [];
        if (!quick.length) btns.append(el("span", "ap-msg", "No quick answers: answer in the agent's chat."));
        quick.forEach(function (label) {
          var b = el("button", "ap-qbtn", label); b.disabled = !!busy[r.id] || set;
          b.addEventListener("click", function (ev) { click(ev, r, label); });
          btns.append(b);
        });
        if (api.dockAskDismiss) { var dm = el("button", "ap-dismiss", "No longer needed"); dm.title = "Clear this question without answering it (nothing is sent to the agent)"; dm.disabled = !!busy[r.id] || set; dm.addEventListener("click", function (ev) { dismiss(ev, r); }); btns.append(dm); }
        if (errors[r.id]) btns.append(el("span", "ap-msg", errors[r.id]));
        if (busy[r.id]) btns.append(el("span", "ap-msg", "Sending..."));
        item.append(btns); parent.append(item);
      };
      rec.forEach(draw);
      if (old.length) {
        var tg = el("button", "ap-older", showOlder ? "Hide older (" + old.length + ")" : "Show older (" + old.length + ")");
        tg.addEventListener("click", function (ev) { if (!ev.isTrusted) return; showOlder = !showOlder; onChange(); });
        parent.append(tg);
        if (showOlder) { old.slice(0, OLDER_CAP).forEach(draw); if (old.length > OLDER_CAP) parent.append(el("div", "ap-msg", (old.length - OLDER_CAP) + " more not shown.")); }
      }
      return rec.length;
    }
    // part of the repaint signature: anything that changes what render() would draw
    function sig() { return [keyOf(), showOlder, settling(), Object.keys(busy).join(), done.length, Object.keys(expanded).join(), Object.keys(errors).join()].join("#"); }

    return { refresh: refresh, click: click, dismiss: dismiss, ageText: ageText, render: render, sig: sig, recentCount: function () { return recent().length; }, olderCount: function () { return older().length; }, rows: function () { return rows; }, setShowOlder: function (v) { showOlder = !!v; }, settling: settling };
  }
  root.ThyraAsks = { create: create, ageText: ageText, SETTLE_MS: SETTLE_MS };
})(typeof window !== "undefined" ? window : globalThis);
