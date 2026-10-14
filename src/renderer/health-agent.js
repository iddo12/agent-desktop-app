// My Health: the screens that show what the Health agent wrote (Insights, Trends, Plan, Experiments). Loaded lazily by health.js.
// Layout follows the UI-UX v3 mockups (compact insight rows, one row per marker with a wide chart, status words as well as colours).
// textContent only; nothing is logged, copied or sent anywhere except the app's own health-* handlers (feedback lines stay in the vault).
(function () {
  "use strict";
  const api = window.api && window.api.health;
  if (!api) return;
  const DIR = { up: "▲", down: "▼", flat: "=" };
  const flt = { show: "all", evidence: "", tradition: "", topic: "", status: "open", trend: "all", range: "all", view: "rows" };
  let ui = null, data = null;
  const openIns = new Set(), openPlan = new Set();

  const el = (...a) => ui.el(...a);
  const chip = (text, cls) => el("span", "hl-chip2" + (cls ? " " + cls : ""), text);
  const dots = (n) => (n ? "●".repeat(n) + "○".repeat(5 - n) : "");
  function act(promise, okText) { return promise.then((r) => { if (r && r.ok) { if (okText) ui.say(okText); } else ui.say((r && r.reason) || "That did not work."); return ui.reloadAgent(); }).catch(() => ui.say("That did not work.")); }

  function refChips(rel) { const w = el("div", "hl-refs"); rel.forEach((r) => w.appendChild(chip(r.label + (r.last ? " · " + r.last : ""), "ref " + r.type))); return w; }
  // A source is a button only when its host is on the allow-list; the real hostname is always shown (never only the agent's title).
  function sourceLinks(list) {
    const w = el("div", "hl-sources");
    list.forEach((x) => {
      if (x.allowed) { const b = ui.btn((x.title || x.host) + " (" + x.host + ")", "hl-link", () => api.openLink(x.url).then((r) => { if (!(r && r.ok)) ui.say((r && r.reason) || "Could not open the link."); })); b.title = "Opens " + x.host + " in your browser"; w.appendChild(b); }
      else w.appendChild(el("span", "hl-small hl-muted", (x.title || x.host) + " (" + x.host + ": not on the allow-list, not clickable)"));
    });
    return w;
  }
  const evChip = (e) => { const lab = data.enums.evidence.find((x) => x[0] === e.level); return chip((lab ? lab[1] : e.level) + (e.strength ? " " + dots(e.strength) : ""), "ev ev-" + e.level); };
  const trChip = (t) => { const lab = data.enums.traditions.find((x) => x[0] === t); return chip(lab ? lab[1] : t, "tr"); };
  const doctor = () => el("div", "hl-doctor", data.doctorLine);
  function select(options, value, onChange, label) { const s = el("select", "hl-input hl-filter"); s.setAttribute("aria-label", label || "Filter"); options.forEach(([v, l]) => { const o = el("option", "", l); o.value = v; if (v === value) o.selected = true; s.appendChild(o); }); s.addEventListener("change", () => onChange(s.value)); return s; }
  function pills(options, value, onChange, label) { const w = el("div", "hl-pills"); w.setAttribute("role", "group"); w.setAttribute("aria-label", label); options.forEach(([v, l]) => { const b = ui.btn(l, "hl-pill" + (v === value ? " on" : ""), () => onChange(v)); b.setAttribute("aria-pressed", v === value ? "true" : "false"); w.appendChild(b); }); return w; }

  // ------------------------------------------------------------ Insights
  const sourceTag = (c) => (c.evidence.level === "traditional" ? "Traditional" : c.why.relates.some((r) => r.type === "lab" || r.type === "metric" || r.type === "med") ? "Your data" : "Study");
  function insights(body) {
    const I = data.insights;
    const head = el("div", "hl-ins-head");
    head.appendChild(el("b", "", I.newToday + " new today"));
    head.appendChild(el("span", "hl-muted hl-small", I.cards.length + " cards from the last 14 days" + (I.rejected ? ", " + I.rejected + " not readable" : "")));
    body.appendChild(head);
    const bar = el("div", "hl-filterbar"); bar.appendChild(el("span", "hl-flabel", "SHOW"));
    bar.appendChild(pills([["all", "All"], ["data", "Your data"], ["study", "Studies"], ["trad", "Traditional"]], flt.show, (v) => { flt.show = v; ui.rerender(); }, "Show which cards"));
    bar.appendChild(el("span", "hl-sp"));
    bar.appendChild(select([["", "Evidence: any"]].concat(data.enums.evidence), flt.evidence, (v) => { flt.evidence = v; ui.rerender(); }, "Filter by evidence level"));
    body.appendChild(bar);
    const more = el("details", "hl-more"); more.appendChild(el("summary", "hl-small", "More filters"));
    const mf = el("div", "hl-filters");
    mf.append(select([["", "Any tradition"]].concat(data.enums.traditions), flt.tradition, (v) => { flt.tradition = v; ui.rerender(); }, "Filter by tradition"), select([["", "Any topic"]].concat(data.enums.topics.map((t) => [t, t[0].toUpperCase() + t.slice(1)])), flt.topic, (v) => { flt.topic = v; ui.rerender(); }, "Filter by topic"),
      select([["open", "Open (not dismissed)"], ["", "All"]].concat(data.enums.insightStatus.map((s) => [s, s[0].toUpperCase() + s.slice(1)])), flt.status, (v) => { flt.status = v; ui.rerender(); }, "Filter by status"));
    more.appendChild(mf); body.appendChild(more);
    if (!I.cards.length) { body.appendChild(ui.empty("No insights yet.", ["The Health agent writes a few cards each day into the health folder (agent\\insights).", "Until it does, nothing is shown here. Nothing is invented by the app."])); return; }
    const shown = I.cards.filter((c) => (flt.show === "all" || (flt.show === "data" ? sourceTag(c) === "Your data" : flt.show === "trad" ? c.evidence.level === "traditional" : c.evidence.level !== "traditional" && sourceTag(c) !== "Your data")) &&
      (!flt.tradition || c.tradition === flt.tradition) && (!flt.evidence || c.evidence.level === flt.evidence) && (!flt.topic || c.topic === flt.topic) && (!flt.status || (flt.status === "open" ? c.status !== "dismissed" : c.status === flt.status)));
    if (!shown.length) body.appendChild(el("div", "hl-muted hl-pad", "No cards match these filters."));
    for (const c of shown) {
      const k = ui.card(null); k.classList.add("hl-ins");
      const top = el("div", "hl-ins-top"), chips = el("div", "hl-chips");
      chips.append(chip(sourceTag(c), "tag"), evChip(c.evidence), trChip(c.tradition), el("span", "hl-muted hl-small", c.date), c.status !== "new" ? chip(c.status, "st st-" + c.status) : chip("new", "st st-new"));
      if (c.amountRemoved) chips.appendChild(chip("amount removed", "ev ev-anecdote"));
      const btns = el("div", "hl-ins-btns");
      const open = openIns.has(c.id);
      btns.append(ui.btn("Useful", "hl-btn sm", () => act(api.agentAct({ op: "insight", id: c.id, action: "useful" }), "Noted.")), ui.btn("Not for me", "hl-btn sm", () => act(api.agentAct({ op: "insight", id: c.id, action: "not-for-me" }), "Hidden. The agent will see you did not want this.")),
        (() => { const b = ui.btn(open ? "Close" : "Open", "hl-btn sm", () => { if (open) openIns.delete(c.id); else openIns.add(c.id); ui.rerender(); }); b.setAttribute("aria-expanded", open ? "true" : "false"); return b; })());
      top.append(chips, btns);
      k.append(top, el("div", "hl-ins-title", c.title), el("p", "hl-p hl-ins-sum", c.summary));
      if (open) {
        const why = el("div", "hl-why"); why.append(el("b", "hl-small", "Why this is for you"), el("div", "", c.why.text || "The agent gave no reason.")); if (c.why.relates.length) why.appendChild(refChips(c.why.relates)); k.appendChild(why);
        if (c.sources.length) k.appendChild(sourceLinks(c.sources));
        const row = el("div", "hl-actions"); row.append(ui.btn("Try it", "hl-btn sm pri", () => act(api.agentAct({ op: "insight", id: c.id, action: "try-it" }), "Experiment started. See the Experiments page.")), ui.btn(c.status === "saved" ? "Saved" : "Save", "hl-btn sm", () => act(api.agentAct({ op: "insight", id: c.id, action: "save" }), "Saved.")));
        k.appendChild(row);
        if (c.intervention || c.amountRemoved) k.appendChild(doctor());
      }
      body.appendChild(k);
    }
    body.appendChild(doctor());
    body.appendChild(el("div", "hl-muted hl-small hl-pad", "Useful and Not for me teach the agent what to show next; neither deletes anything. Your button presses are written to a file in the health folder. Nothing is sent anywhere from here."));
  }

  // ------------------------------------------------------------ Trends: one row per marker, a wide chart, status words
  const POS = { above: ["▲ above", "hl-pos-out"], below: ["▼ below", "hl-pos-out"], inside: ["✓ inside", "hl-pos-in"], none: ["", ""] };
  function inRange(series) {
    if (flt.range === "all" || !series.length) return series;
    const months = flt.range === "3m" ? 3 : 12, end = new Date(series[series.length - 1].ts), from = new Date(end.getFullYear(), end.getMonth() - months, end.getDate()).getTime();
    const out = series.filter((p) => new Date(p.ts).getTime() >= from); return out.length >= 2 ? out : series;
  }
  function trendRow(r, grid) {
    const row = el("div", "hl-trow" + (grid ? " grid" : ""));
    const info = el("div", "hl-trow-i");
    const pos = POS[r.pos] || POS.none;
    info.append(el("b", "", r.label), el("div", "hl-trow-v", r.valueText));
    if (pos[0]) info.appendChild(el("span", "hl-pos " + pos[1], pos[0] + (r.kind === "lab" ? " the lab range" : " your normal")));
    info.appendChild(el("div", "hl-small hl-muted", (r.previous && r.change ? (DIR[r.change.dir] || "") + " " + (r.change.dir === "flat" ? "no change" : r.change.text) + " vs " + ui.dayText(r.previous.at) + " (" + r.previous.valueText + ")" : "first reading") + (r.normalText ? " | " + r.normalText : "")));
    const ch = el("div", "hl-trow-c");
    ch.appendChild(ui.chart({ series: inRange(r.series), unit: r.unit, dec: r.dec, kind: r.kind, w: grid ? 420 : 620, h: grid ? 170 : 190, title: r.label, band: r.band ? { low: r.band.low, high: r.band.high, label: "your normal" } : r.refBand }));
    row.append(info, ch);
    if (!grid) { const note = el("div", "hl-trend-note hl-small" + (r.note ? "" : " hl-muted")); note.textContent = r.note ? "Agent's note (" + (r.note.date || "undated") + "): " + r.note.text : "No note from the agent yet."; row.appendChild(note); }
    return row;
  }
  function trends(body) {
    const T = data.trends;
    if (!T.hasData) { body.appendChild(ui.empty("No numbers to show a trend for yet.", ["Import a file on the Today page or add lab results on the Labs page."])); return; }
    const a = ui.card("Worth attention", "simple rules, no model");
    if (!T.attention.length) a.appendChild(el("div", "hl-muted hl-pad", "Nothing stands out by the rules: no sustained drift, nothing outside your own normal for three readings, no lab outside its range."));
    else { const ul = el("ul", "hl-ul"); T.attention.forEach((x) => ul.appendChild(el("li", "", x.text))); a.appendChild(ul); }
    a.appendChild(el("div", "hl-muted hl-small", "These lines only say what the numbers did. They are not advice and not a diagnosis."));
    body.appendChild(a);
    const needs = T.rows.filter((r) => r.needs).length, inside = T.rows.filter((r) => r.pos === "inside").length;
    const bar = el("div", "hl-filterbar"); bar.appendChild(el("span", "hl-flabel", "SHOW"));
    bar.appendChild(pills([["all", "All " + T.rows.length], ["needs", "Needs attention " + needs], ["inside", "Inside normal " + inside]], flt.trend, (v) => { flt.trend = v; ui.rerender(); }, "Which markers to show"));
    bar.appendChild(el("span", "hl-sp"));
    bar.appendChild(pills([["rows", "Rows"], ["grid", "Grid"]], flt.view, (v) => { flt.view = v; ui.rerender(); }, "Layout"));
    bar.appendChild(select([["3m", "Range: 3 months"], ["1y", "Range: 1 year"], ["all", "Range: all time"]], flt.range, (v) => { flt.range = v; ui.rerender(); }, "Time range"));
    body.appendChild(bar);
    const rows = T.rows.filter((r) => flt.trend === "all" || (flt.trend === "needs" ? r.needs : r.pos === "inside"));
    if (!rows.length) body.appendChild(el("div", "hl-muted hl-pad", "No markers in this view."));
    if (flt.view === "grid") { const g = el("div", "hl-tgrid"); rows.forEach((r) => g.appendChild(trendRow(r, true))); body.appendChild(g); }
    else rows.forEach((r) => body.appendChild(trendRow(r, false)));
  }

  // ------------------------------------------------------------ Plan
  const GROUPS = [["vitamins", "Vitamins & minerals"], ["exercise", "Exercises"], ["practice", "Practices"]];
  const PLAN_LABEL = { considering: "Considering", discussing: "Discussing with doctor", trying: "Trying", stopped: "Stopped" };
  function plan(body) {
    body.appendChild(el("div", "hl-note", "The app never suggests an amount of anything. Ask your doctor or pharmacist about doses, interactions and whether something suits you. The status words are yours to set."));
    if (!data.plan.items.length) { body.appendChild(ui.empty("No suggestions yet.", ["The Health agent lists vitamins and minerals, exercises and practices to consider in agent\\plan.json.", "Each one shows its evidence level and why it is for you."])); return; }
    for (const [g, label] of GROUPS) {
      const items = data.plan.items.filter((i) => i.group === g); if (!items.length) continue;
      const c = ui.card(label);
      for (const it of items) {
        const row = el("div", "hl-plan");
        const top = el("div", "hl-plan-top"), open = openPlan.has(it.id);
        top.append(chip(PLAN_LABEL[it.status] || it.status, "st st-" + it.status), el("b", "hl-plan-t", it.title), evChip(it.evidence), trChip(it.tradition));
        if (it.amountRemoved) top.appendChild(chip("amount removed", "ev ev-anecdote"));
        top.appendChild(el("span", "hl-sp"));
        top.appendChild(select(data.enums.planStatus.map((s) => [s, PLAN_LABEL[s]]), it.status, (v) => act(api.agentAct({ op: "plan", id: it.id, status: v })), "Status of " + it.title));
        const ob = ui.btn(open ? "Close" : "Open", "hl-btn sm", () => { if (open) openPlan.delete(it.id); else openPlan.add(it.id); ui.rerender(); }); ob.setAttribute("aria-expanded", open ? "true" : "false"); top.appendChild(ob);
        row.appendChild(top);
        if (open) {
          if (it.note) row.appendChild(el("div", "hl-small", it.note));
          const why = el("div", "hl-why"); why.append(el("b", "hl-small", "Why this is for you"), el("div", "", it.why.text || "The agent gave no reason.")); if (it.why.relates.length) why.appendChild(refChips(it.why.relates)); row.appendChild(why);
          if (it.sources.length) row.appendChild(sourceLinks(it.sources));
          row.appendChild(doctor());
        }
        c.appendChild(row);
      }
      body.appendChild(c);
    }
    if (data.plan.rejected) body.appendChild(el("div", "hl-muted hl-small", data.plan.rejected + " item(s) in the plan file were not shown (unreadable)."));
  }

  // ------------------------------------------------------------ Experiments (the real chart)
  function experiments(body) {
    body.appendChild(el("div", "hl-note", "One person, one change: this suggests rather than proves. Use it to decide, with your doctor, whether to keep something."));
    if (!data.experiments.length) { body.appendChild(ui.empty("No experiments yet.", ["Press Try it on an Insight to start one: it records the start date and the number to watch.", "Then come back here to compare before and after, add notes and decide to keep or drop it."])); return; }
    for (const e of data.experiments) {
      const c = ui.card(null);
      const top = el("div", "hl-ins-t"); top.append(el("b", "", e.title), chip(e.status === "running" ? "running, day " + e.days : e.status, "st st-" + e.status), chip("Single case (n=1)", "ev ev-single-study"));
      c.append(top, el("div", "hl-muted hl-small", "Started " + ui.dayText(e.start + "T00:00:00") + (e.stop ? ", ended " + ui.dayText(e.stop + "T00:00:00") : "") + (e.metric ? " · watching " + e.metricLabel : " · no number chosen to watch")));
      if (e.metric) {
        const cmp = el("div", "hl-exp-cmp");
        cmp.append(el("div", "", "Before: " + (e.before.n ? e.before.text + " (" + e.before.n + " readings, 14 days)" : "no readings")), el("div", "", "After: " + (e.after.n ? e.after.text + " (" + e.after.n + " readings)" : "no readings yet")));
        if (e.delta) cmp.appendChild(el("b", "", "Change " + e.delta.text)); c.appendChild(cmp);
        c.appendChild(ui.chart({ series: e.series, unit: e.unit, dec: e.dec, kind: e.kind, w: 620, h: 190, title: e.title + ", " + e.metricLabel, startTs: e.start }));
        c.appendChild(el("div", "hl-muted hl-small", e.enough ? "Dashed line: the day you started. Filled markers are after the start." : "At least 3 readings before and 3 after are needed before a comparison means anything."));
      }
      if (e.notes.length) { const ul = el("ul", "hl-ul"); e.notes.slice(-6).forEach((n) => ul.appendChild(el("li", "hl-small", n.ts.slice(0, 10) + ": " + n.text))); c.appendChild(ul); }
      if (e.verdictNote) c.appendChild(el("div", "hl-small", "Verdict note: " + e.verdictNote));
      const note = ui.input("text", "add a note", { "aria-label": "Add a note to " + e.title }); const row = el("div", "hl-actions");
      row.append(note, ui.btn("Add note", "hl-btn sm", () => { if (note.value.trim()) act(api.agentAct({ op: "exp-note", id: e.id, text: note.value }), "Note saved in the health folder."); }));
      if (e.status === "running") row.append(ui.btn("Keep", "hl-btn sm pri", () => act(api.agentAct({ op: "exp-verdict", id: e.id, status: "kept", note: note.value }), "Marked as kept.")), ui.btn("Drop", "hl-btn sm", () => act(api.agentAct({ op: "exp-verdict", id: e.id, status: "dropped", note: note.value }), "Marked as dropped.")));
      else row.appendChild(ui.btn("Run again", "hl-btn sm", () => act(api.agentAct({ op: "exp-verdict", id: e.id, status: "running" }))));
      c.appendChild(row); body.appendChild(c);
    }
  }

  window.healthAgentUi = { render(tab, body, d, u) { ui = u; data = d; ({ insights, trends, plan, experiments })[tab](body); } };
})();
