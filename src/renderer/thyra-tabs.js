// v1.156.0 THYRA TABS: the Task list and Ideas tabs inside the THYRA dock window (src/thyraTabs.js has the data rules, main.js the IPC).
// Lazy: nothing is read until the tab is opened (and again on Refresh). Every button shows at once that it was pressed (busy label, disabled) and
// every result is written on screen. Only the owner's real click (isTrusted) sends or records anything. Red is used only for "Stuck" (blocked) and errors.
(function (root) {
  "use strict";
  var GROUP = { needs_you: "Needs you", stuck: "Stuck", working: "Working", not_started: "Not started" };
  var ROW_CAP = 150;

  function ageText(days) { if (days == null) return ""; if (days < 1) return "today"; if (days === 1) return "1 day"; if (days < 60) return days + " days"; return Math.round(days / 30) + " months"; }
  var lc = function (s) { return String(s == null ? "" : s).toLowerCase(); };
  // search over agent name and task text; an agent whose NAME matches keeps all its tasks, otherwise only the matching tasks stay; open = auto-expand
  function filterGroups(groups, q) {
    q = lc(q).trim(); if (!q) return (groups || []).map(function (g) { return { g: g, tasks: g.tasks, open: false }; });
    var out = [];
    (groups || []).forEach(function (g) {
      if (lc(g.agent).indexOf(q) >= 0) { out.push({ g: g, tasks: g.tasks, open: true }); return; }
      var t = g.tasks.filter(function (x) { return lc(x.title + " " + x.line + " " + x.id).indexOf(q) >= 0; });
      if (t.length) out.push({ g: g, tasks: t, open: true });
    });
    return out;
  }
  function filterIdeas(ideas, q) {
    q = lc(q).trim(); if (!q) return ideas || [];
    return (ideas || []).filter(function (i) { return lc(i.title + " " + i.detail + " " + i.agent + " " + (i.tags || []).join(" ")).indexOf(q) >= 0; });
  }

  function create(opts) {
    var api = opts.api, el = opts.el, onChange = opts.onChange || function () {};
    var S = {
      tasks: { state: "idle", data: null, err: "", q: "", open: {}, full: {}, busy: false },
      ideas: { state: "idle", data: null, err: "", q: "", open: {}, form: {}, draft: {}, busy: {}, msg: {}, busyList: false },
    };
    var nodes = { tasks: el("div", "tt-pane"), ideas: el("div", "tt-pane") };
    var owner = function (ev) { return !ev || ev.isTrusted !== false; };

    // a button that answers at once: busy label + disabled while the work runs, the result is written by the caller
    function act(btn, busyLabel, work) {
      var old = btn.textContent; btn.disabled = true; btn.textContent = busyLabel; btn.classList.add("tt-busy");
      return Promise.resolve().then(work).then(function (r) { return r; }, function (e) { return { ok: false, error: String(e && e.message || e) }; }).then(function (r) { btn.classList.remove("tt-busy"); btn.disabled = false; btn.textContent = old; return r; });
    }
    function chrome(kind, placeholder) {
      var bar = el("div", "tt-bar"), inp = el("input", "tt-search"); inp.type = "search"; inp.placeholder = placeholder; inp.value = S[kind].q; inp.setAttribute("aria-label", placeholder);
      inp.addEventListener("input", function () { S[kind].q = inp.value; paint(kind, true); });
      var rf = el("button", "tt-btn", "Refresh"); rf.title = "Read it again now";
      rf.addEventListener("click", function (ev) { if (owner(ev)) load(kind, rf); });
      bar.append(inp, rf); return bar;
    }
    function statusNode(kind, what) {
      var s = S[kind];
      if (s.state === "loading" && !s.data) return el("div", "tt-note", "Loading " + what + "...");
      if (s.state === "error") { var d = el("div", "tt-note tt-err", "Could not load: " + s.err); return d; }
      return null;
    }

    // ---------- TASK LIST ----------
    function taskLegend() {
      var l = el("div", "tt-legend");
      [["tt-d-needs", "Needs you"], ["tt-d-stuck", "Stuck (blocked)"], ["tt-d-working", "Working"], ["tt-d-new", "Not started"]].forEach(function (x) { var s = el("span", "tt-leg"); s.append(el("span", "tt-dot " + x[0]), document.createTextNode(x[1])); l.append(s); });
      return l;
    }
    function paintTasks(keepBar) {
      var p = nodes.tasks, st = S.tasks, listEl = p.querySelector(".tt-list");
      if (!keepBar || !listEl) {
        p.textContent = ""; p.append(chrome("tasks", "Search agents or tasks"));
        var sum = el("div", "tt-sum"); sum.id = "tt-tasks-sum"; p.append(sum);
        listEl = el("div", "tt-list"); p.append(listEl, taskLegend());
      }
      var sumEl = p.querySelector("#tt-tasks-sum"); listEl.textContent = "";
      var sn = statusNode("tasks", "tasks"); if (sn) { listEl.append(sn); sumEl.textContent = ""; return; }
      if (!st.data) { sumEl.textContent = ""; return; }
      var t = st.data.totals; sumEl.textContent = t.open + " open task" + (t.open === 1 ? "" : "s") + " across " + t.agents + " agent" + (t.agents === 1 ? "" : "s") + (t.needs ? " - " + t.needs + " need" + (t.needs === 1 ? "s" : "") + " you" : " - none need you");
      var f = filterGroups(st.data.groups, st.q); if (!f.length) listEl.append(el("div", "tt-note", st.q ? "Nothing matches." : "No tasks."));
      f.forEach(function (x) {
        var g = x.g, isOpen = x.open || !!st.open[g.agent], blk = el("div", "tt-agent" + (g.needs ? " tt-hot" : ""));
        var head = el("button", "tt-ahead"); head.type = "button"; head.setAttribute("aria-expanded", isOpen ? "true" : "false");
        var l1 = el("span", "tt-l1"); l1.append(el("span", "tt-arrow", isOpen ? "v" : ">"), el("span", "tt-aname", g.agent), el("span", "tt-count", g.open + " open"));
        if (g.needs) l1.append(el("span", "tt-chip tt-c-needs", g.needs + " need you"));
        if (g.stuck) l1.append(el("span", "tt-chip tt-c-stuck", g.stuck + " stuck"));
        head.append(l1);
        head.append(el("span", "tt-l2", g.newest ? "Newest: " + g.newest.title + (g.newest.age != null ? " (" + ageText(g.newest.age) + ")" : "") : "No open tasks"));
        head.addEventListener("click", function (ev) { if (!owner(ev)) return; st.open[g.agent] = !isOpen; paint("tasks", true); });
        blk.append(head);
        if (isOpen) {
          var body = el("div", "tt-abody");
          x.tasks.slice(0, ROW_CAP).forEach(function (tk) {
            var key = g.agent + "|" + tk.id, row = el("div", "tt-task"), full = !!st.full[key];
            row.append(el("span", "tt-dot " + ({ needs_you: "tt-d-needs", stuck: "tt-d-stuck", working: "tt-d-working" }[tk.group] || "tt-d-new")));
            var tx = el("span", "tt-ttext" + (full ? " tt-open" : ""), tk.title + (tk.line ? " - " + tk.line : "")); tx.title = (GROUP[tk.group] || "") + (tk.age != null ? ", " + ageText(tk.age) + " old" : "");
            row.append(tx, el("span", "tt-age", GROUP[tk.group] === "Needs you" ? "needs you" : ageText(tk.age)));
            row.addEventListener("click", function (ev) { if (!owner(ev)) return; st.full[key] = !full; paint("tasks", true); });
            body.append(row);
          });
          if (g.more) body.append(el("div", "tt-note", "+ " + g.more + " more (open the Task list in the main window)"));
          blk.append(body);
        }
        listEl.append(blk);
      });
    }

    // ---------- IDEAS ----------
    function ideaLegend() {
      var l = el("div", "tt-legend");
      [["tt-b-task", "Task", "from an agent's task list"], ["tt-b-reg", "Registry", "a project at stage idea"], ["tt-b-sent", "Sent", "already sent once"]].forEach(function (x) { var s = el("span", "tt-leg"); s.title = x[2]; s.append(el("span", "tt-badge " + x[0], x[1]), document.createTextNode(x[2])); l.append(s); });
      return l;
    }
    function paintIdeas(keepBar) {
      var p = nodes.ideas, st = S.ideas, listEl = p.querySelector(".tt-list");
      if (!keepBar || !listEl) {
        p.textContent = ""; p.append(chrome("ideas", "Search ideas"));
        var sum = el("div", "tt-sum"); sum.id = "tt-ideas-sum"; p.append(sum);
        listEl = el("div", "tt-list"); p.append(listEl, ideaLegend());
      }
      var sumEl = p.querySelector("#tt-ideas-sum"); listEl.textContent = "";
      var sn = statusNode("ideas", "ideas"); if (sn) { listEl.append(sn); sumEl.textContent = ""; return; }
      if (!st.data) { sumEl.textContent = ""; return; }
      var all = st.data.ideas || [], list = filterIdeas(all, st.q);
      sumEl.textContent = all.length + " idea" + (all.length === 1 ? "" : "s") + " not built yet" + (st.q ? " (" + list.length + " shown)" : "");
      if (!list.length) listEl.append(el("div", "tt-note", st.q ? "Nothing matches." : "No open ideas."));
      list.slice(0, ROW_CAP).forEach(function (idea) { listEl.append(ideaRow(idea)); });
      if (list.length > ROW_CAP) listEl.append(el("div", "tt-note", "+ " + (list.length - ROW_CAP) + " more: narrow the search"));
    }
    function ideaRow(idea) {
      var st = S.ideas, key = idea.key, open = !!st.open[key], row = el("div", "tt-idea" + (open ? " tt-open" : ""));
      var top = el("div", "tt-itop");
      top.append(el("span", "tt-badge " + (idea.source === "task" ? "tt-b-task" : "tt-b-reg"), idea.source === "task" ? "Task" : "Registry"));
      if (idea.sent) top.append(el("span", "tt-badge tt-b-sent", "Sent to " + idea.sent.to));
      top.append(el("span", "tt-age", ageText(idea.age)));
      var body = el("div", "tt-ibody"); body.title = open ? "Click to fold" : "Click to read all of it";
      body.append(el("div", "tt-ititle", idea.title));
      if (idea.detail) body.append(el("div", "tt-idetail", idea.detail));
      body.addEventListener("click", function (ev) { if (!owner(ev)) return; st.open[key] = !open; paint("ideas", true); });
      row.append(top, body);
      var meta = el("div", "tt-imeta", (idea.source === "task" ? "In " + idea.agent + "'s task list" : "Registry, " + (idea.agent || "no agent")) + (idea.tags && idea.tags.length ? " - " + idea.tags.join(", ") : ""));
      row.append(meta);
      var btns = el("div", "tt-btns"), f = st.form[key] || "";
      var sb = el("button", "tt-btn tt-primary", "Send to..."); sb.title = "Send this idea to an agent with a one-line instruction";
      sb.addEventListener("click", function (ev) { if (!owner(ev)) return; st.form[key] = f === "send" ? "" : "send"; paint("ideas", true); });
      var mb = el("button", "tt-btn", "Mark built / moved to..."); mb.title = "It is built or handed on: it leaves this list and the place is recorded";
      mb.addEventListener("click", function (ev) { if (!owner(ev)) return; st.form[key] = f === "built" ? "" : "built"; paint("ideas", true); });
      btns.append(sb, mb); row.append(btns);
      var m = st.msg[key]; if (m) row.append(el("div", "tt-msg " + (m.ok ? "tt-ok" : "tt-err"), m.text));
      if (f === "send") row.append(sendForm(idea));
      if (f === "built") row.append(builtForm(idea));
      return row;
    }
    function selectOf(values, cur) { var s = el("select", "tt-sel"); values.forEach(function (v) { var o = el("option", "", v); o.value = v; if (v === cur) o.selected = true; s.append(o); }); return s; }
    function sendForm(idea) {
      var st = S.ideas, key = idea.key, d = st.draft[key] || (st.draft[key] = { target: "", text: "" }), targets = st.data.targets || [];
      var box = el("div", "tt-form");
      if (!targets.length) { box.append(el("div", "tt-msg tt-err", "No agents to send to are set up (Setup: thyraIdeaTargets).")); return box; }
      if (!d.target || targets.indexOf(d.target) < 0) d.target = targets[0];
      var sel = selectOf(targets, d.target); sel.setAttribute("aria-label", "Send to which agent"); sel.addEventListener("change", function () { d.target = sel.value; });
      var inp = el("input", "tt-in"); inp.type = "text"; inp.maxLength = 300; inp.placeholder = "One-line instruction (what should they do with it?)"; inp.value = d.text; inp.setAttribute("aria-label", "One-line instruction");
      inp.addEventListener("input", function () { d.text = inp.value; });
      var go = el("button", "tt-btn tt-primary", "Send");
      var run = function () {
        if (!d.text.trim()) { st.msg[key] = { ok: false, text: "Type a one-line instruction first." }; paint("ideas", true); return; }
        act(go, "Sending...", function () { return api.thyraIdeaSend({ key: key, target: d.target, text: d.text }); }).then(function (r) {
          if (r && r.ok) { st.msg[key] = { ok: true, text: "Sent to " + d.target + ". It is in their chat now." }; st.form[key] = ""; d.text = ""; return load("ideas", null, true); }
          st.msg[key] = { ok: false, text: "Not sent: " + ((r && r.error) || "unknown error") + ". Nothing was delivered." }; paint("ideas", true);
        });
      };
      go.addEventListener("click", function (ev) { if (owner(ev)) run(); });
      inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && owner(ev)) run(); });
      box.append(sel, inp, go); return box;
    }
    function builtForm(idea) {
      var st = S.ideas, key = idea.key, dests = st.data.destinations || [], d = st.draft[key] || (st.draft[key] = { target: "", text: "" });
      var box = el("div", "tt-form"); if (!d.dest || dests.indexOf(d.dest) < 0) d.dest = dests[0];
      var sel = selectOf(dests, d.dest); sel.setAttribute("aria-label", "Where it went"); sel.addEventListener("change", function () { d.dest = sel.value; });
      var go = el("button", "tt-btn tt-primary", "Record and remove");
      go.addEventListener("click", function (ev) {
        if (!owner(ev)) return;
        act(go, "Saving...", function () { return api.thyraIdeaBuilt({ key: key, dest: d.dest }); }).then(function (r) {
          if (r && r.ok) { st.open[key] = false; st.form[key] = ""; st.msg[key] = null; st.flash = "Recorded: moved to " + d.dest + (r.closed === false ? " (the task could not be closed automatically: close it in its list)" : "") + "."; return load("ideas", null, true); }
          st.msg[key] = { ok: false, text: "Not recorded: " + ((r && r.error) || "unknown error") }; paint("ideas", true);
        });
      });
      box.append(el("span", "tt-lbl", "Moved to"), sel, go); return box;
    }

    // ---------- loading ----------
    function paint(kind, keepBar) { (kind === "tasks" ? paintTasks : paintIdeas)(keepBar); if (kind === "ideas" && S.ideas.flash) { var sum = nodes.ideas.querySelector("#tt-ideas-sum"); if (sum) { var fl = el("div", "tt-msg tt-ok", S.ideas.flash); sum.after(fl); S.ideas.flash = ""; setTimeout(function () { try { fl.remove(); } catch (e) { /* gone */ } }, 8000); } } onChange(kind); }
    function load(kind, btn, quiet) {
      var s = S[kind]; if (s.busyList) return Promise.resolve();
      s.busyList = true; if (!s.data) { s.state = "loading"; paint(kind, true); }
      var call = kind === "tasks" ? api.thyraTasksLoad : api.thyraIdeasLoad;
      var work = function () { return Promise.resolve(call()); };
      var p = btn && !quiet ? act(btn, "Reading...", work) : work();
      return p.then(function (r) { if (r && r.ok) { s.data = r; s.state = "ready"; s.err = ""; } else { s.state = s.data ? "ready" : "error"; s.err = (r && r.reason) || "unknown error"; } }, function (e) { s.state = s.data ? "ready" : "error"; s.err = String(e && e.message || e); })
        .then(function () { s.busyList = false; paint(kind, true); });
    }
    function show(kind) { var s = S[kind]; if (s.state === "idle") { paint(kind, false); load(kind); } return nodes[kind]; }   // first open = first read; later opens reuse what is there (Refresh re-reads)

    paintTasks(false); paintIdeas(false);
    return {
      show: show, nodes: nodes, refresh: function (kind) { return load(kind, null, true); },
      counts: function () { var t = S.tasks.data, i = S.ideas.data; return { tasks: t && t.totals ? t.totals.needs : null, ideas: i && i.ideas ? i.ideas.length : null }; },
      _state: S,
    };
  }
  root.ThyraTabs = { create: create, filterGroups: filterGroups, filterIdeas: filterIdeas, ageText: ageText };
})(typeof window !== "undefined" ? window : globalThis);
