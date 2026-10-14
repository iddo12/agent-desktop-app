// My Health (stage 1b): Routines, Longevity, Evidence map, Interactions, Weekly review, Reading list (+ Worldview), Nutrition. Loaded lazily by
// health.js the first time one of these pages opens. Layout follows the UI-UX v3 mockups. textContent only; nothing is logged, copied or sent
// anywhere except the app's own health-* handlers. No timers and no polling here (the reminder scheduler lives in the main process and exists
// only while a reminder is enabled).
(function () {
  "use strict";
  const api = window.api && window.api.health;
  if (!api) return;
  const NS = "http://www.w3.org/2000/svg";
  const DIR = { up: "▲", down: "▼", flat: "=" };
  const WD = ["S", "M", "T", "W", "T", "F", "S"];
  const flt = { evidence: { tradition: "", kind: "", min: "0", sel: "" }, reading: "unread", recipes: "open" };
  const wkOpen = new Set(), focusOpen = new Set(), methodOpen = new Set();
  let ui = null, data = null, showForm = false, showBirth = false, confirmDel = null, showRem = null, hero = null, moreOpen = null;

  const el = (...a) => ui.el(...a);
  const chip = (text, cls) => el("span", "hl-chip2" + (cls ? " " + cls : ""), text);
  const dots = (n) => "●".repeat(n) + "○".repeat(5 - n);
  const act = (op, extra, okText) => ui.act(api.extraAct(Object.assign({ op }, extra)), okText).then((r) => { ui.reloadMore(); return r; });
  function select(options, value, onChange, label) { const s = el("select", "hl-input hl-filter"); s.setAttribute("aria-label", label || "Filter"); options.forEach(([v, l]) => { const o = el("option", "", l); o.value = v; if (v === value) o.selected = true; s.appendChild(o); }); s.addEventListener("change", () => onChange(s.value)); return s; }
  function refChips(rel) { const w = el("div", "hl-refs"); rel.forEach((r) => w.appendChild(chip(r.label + (r.last ? " · " + r.last : ""), "ref " + r.type))); return w; }
  function links(list) {
    const w = el("div", "hl-sources");
    (list || []).forEach((x) => {
      if (x.allowed) { const b = ui.btn((x.title || x.host) + (x.host ? " (" + x.host + ")" : ""), "hl-link", () => api.openLink(x.url).then((r) => { if (!(r && r.ok)) ui.say((r && r.reason) || "Could not open the link."); })); b.title = "Opens " + x.host + " in your browser"; w.appendChild(b); }
      else w.appendChild(el("span", "hl-small hl-muted", (x.title || x.host) + " (" + x.host + ": not on the allow-list, not clickable)"));
    });
    return w;
  }
  const evLabel = (lv) => { const e = (data.enums && data.enums.evidence || []).find((x) => x[0] === lv); return e ? e[1] : lv; };
  const trLabel = (t) => { const e = (data.enums && data.enums.traditions || []).find((x) => x[0] === t); return e ? e[1] : t; };
  const evChip = (e) => chip(evLabel(e.level) + (e.strength ? " " + dots(e.strength) : ""), "ev ev-" + e.level);

  // ------------------------------------------------------------ Longevity
  function dial(bio) {
    const w = 220, h = 124, cx = 110, cy = 112, r = 92, min = 20, max = 90;
    const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 " + w + " " + h); svg.setAttribute("class", "hl-dial"); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Biological age " + bio.phenoAge.toFixed(1) + " years against calendar age " + bio.age.toFixed(1));
    const pt = (v, rr) => { const t = Math.PI * (1 - (Math.max(min, Math.min(max, v)) - min) / (max - min)); return [cx + rr * Math.cos(t), cy - rr * Math.sin(t)]; };
    const arc = (a, b, cls) => { const [x1, y1] = pt(a, r), [x2, y2] = pt(b, r); const p = document.createElementNS(NS, "path"); p.setAttribute("d", "M" + x1.toFixed(1) + " " + y1.toFixed(1) + " A" + r + " " + r + " 0 0 1 " + x2.toFixed(1) + " " + y2.toFixed(1)); p.setAttribute("class", cls); svg.appendChild(p); };
    arc(min, max, "hl-dial-track"); arc(Math.min(bio.age, bio.phenoAge), Math.max(bio.age, bio.phenoAge), bio.phenoAge <= bio.age ? "hl-dial-good" : "hl-dial-warn");
    const [mx, my] = pt(bio.age, r + 8), [mx2, my2] = pt(bio.age, r - 8); const l = document.createElementNS(NS, "line"); l.setAttribute("x1", mx.toFixed(1)); l.setAttribute("y1", my.toFixed(1)); l.setAttribute("x2", mx2.toFixed(1)); l.setAttribute("y2", my2.toFixed(1)); l.setAttribute("class", "hl-dial-cal"); svg.appendChild(l);
    const [dx, dy] = pt(bio.phenoAge, r); const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", dx.toFixed(1)); c.setAttribute("cy", dy.toFixed(1)); c.setAttribute("r", "6"); c.setAttribute("class", "hl-dial-dot"); svg.appendChild(c);
    const t = document.createElementNS(NS, "text"); t.setAttribute("x", String(cx)); t.setAttribute("y", String(cy - 18)); t.setAttribute("text-anchor", "middle"); t.setAttribute("class", "hl-dial-num"); t.textContent = bio.phenoAge.toFixed(1); svg.appendChild(t);
    const t2 = document.createElementNS(NS, "text"); t2.setAttribute("x", String(cx)); t2.setAttribute("y", String(cy - 2)); t2.setAttribute("text-anchor", "middle"); t2.setAttribute("class", "hl-dial-sub"); t2.textContent = "PhenoAge, years"; svg.appendChild(t2);
    return svg;
  }
  function birthForm() {
    const row = el("div", "hl-form"); const y = ui.input("text", "YYYY-MM", { inputmode: "numeric", maxlength: "7", "aria-label": "Birth year and month" });
    const lab = el("label", "hl-field"); lab.append(el("span", "hl-flabel", "Birth year and month (stored only in the health folder)"), y); row.appendChild(lab);
    row.appendChild(ui.btn("Save", "hl-btn pri", () => act("profile-set", { birth: y.value }, "Saved.").then((r) => { if (r && r.ok) showBirth = false; })));
    return row;
  }
  function longevity(body) {
    const b = data.bio, grid = el("div", "hl-lg2");
    // 1. the estimate
    const c = ui.card("Biological age (estimate)", "experimental");
    if (b.state === "ok") {
      const diff = Math.abs(b.current.diff), below = b.current.diff < 0;
      const row = el("div", "hl-bio"); row.appendChild(dial(b.current));
      const side = el("div", "hl-bio-side");
      side.append(el("div", "hl-bio-big", b.current.phenoAge.toFixed(1) + " years"), el("div", "hl-small hl-muted", "vs calendar age " + b.current.age.toFixed(1) + " | " + (diff < 0.05 ? "about the same" : diff.toFixed(1) + " years " + (below ? "younger" : "older")) + " | calculated " + ui.dayText(b.current.date + "T00:00:00") + " from 9 of 9 inputs"));
      const chips = el("div", "hl-chips"); chips.append(chip("Single study (PhenoAge formula)", "ev ev-single-study"), chip((below ? "✓ below" : "▲ above") + " your calendar age", below ? "st st-kept" : "ev ev-preclinical")); side.appendChild(chips);
      if (b.previous) side.appendChild(el("div", "hl-small", "Previous panel (" + ui.dayText(b.previous.date + "T00:00:00") + "): " + b.previous.phenoAge.toFixed(1) + ", " + Math.abs(b.previous.diff).toFixed(1) + " years " + (b.previous.diff < 0 ? "younger" : "older") + ". Change in the gap: " + ((b.current.diff - b.previous.diff) > 0 ? "+" : "") + (b.current.diff - b.previous.diff).toFixed(1) + " years."));
      row.appendChild(side); c.appendChild(row);
    } else if (b.state === "needs-birth") { c.appendChild(el("p", "hl-p", "All nine markers are on file. To compute the number the formula needs your age: add your birth year and month.")); c.appendChild(birthForm()); }
    else c.appendChild(el("p", "hl-p", b.state === "no-labs" ? "No blood tests that the formula uses are on file yet." : b.state === "incomplete" ? "Not all nine markers are on file within 180 days of each other, so no number is shown (a missing input is never guessed)." : "The numbers on file do not give a usable result."));
    c.appendChild(el("p", "hl-note", "An estimate, not a diagnosis. Different formulas give different answers; the trend matters more than the number. Experimental: a research formula, not medical advice."));
    grid.appendChild(c);
    // 2. the inputs table, with missing inputs stated in words
    const ic = ui.card("Inputs"); const t = el("div", "hl-pheno-in"); const hd = el("div", "hl-pin hl-lab-h"); ["INPUT", "VALUE", "USED IN FORMULA AS", "TAKEN"].forEach((x) => hd.appendChild(el("div", "", x))); t.appendChild(hd);
    const shown = b.state === "ok" ? b.current.inputs : (b.partial ? b.partial.inputs : b.inputs || []); shown.forEach((i) => { const r = el("div", "hl-pin"); r.append(el("div", "", i.label), el("div", "hl-b", i.shown), el("div", "hl-small", i.used), el("div", "hl-small hl-muted", i.date)); t.appendChild(r); });
    const missing = b.partial ? b.partial.missing : b.state === "no-labs" ? b.markers : [];
    missing.forEach((m) => { const r = el("div", "hl-pin"); r.append(el("div", "", m.label), chip("⚠ missing", "ev ev-preclinical"), el("div", "hl-small", "needed in " + m.want), el("div", "hl-small hl-muted", "not in any report")); t.appendChild(r); });
    ic.appendChild(t); grid.appendChild(ic);
    // 3. what to do about a missing input
    if (missing.length) { const mc = ui.card("Missing input state"); mc.append(chip("⚠ " + missing.length + " input" + (missing.length === 1 ? "" : "s") + " missing", "ev ev-preclinical"), el("p", "hl-p", missing.map((m) => m.label).join(", ") + (missing.length === 1 ? " is" : " are") + " not in your lab results. Add them to get an estimate.")); const ar = el("div", "hl-actions"); ar.append(ui.btn("Import a lab report", "hl-btn pri", () => ui.go("labs")), ui.btn("Enter value by hand", "hl-btn", () => ui.go("labs"))); mc.appendChild(ar); grid.appendChild(mc); }
    // 4. the estimate over time against the calendar age
    const hc = ui.card("Estimate over time");
    if (b.history && b.history.length) hc.appendChild(ui.chart({ series: b.history, unit: "years", dec: 1, w: 620, h: 190, title: "PhenoAge over time", target: b.current ? b.current.age : undefined })); else hc.appendChild(el("div", "hl-muted hl-pad", "Needs at least one complete panel."));
    grid.appendChild(hc);
    body.appendChild(grid);
    const f = el("pre", "hl-formula", b.formula.join("\n")); f.setAttribute("aria-label", "The PhenoAge formula"); const fc = ui.card("The formula, as published (Levine et al. 2018)"); fc.appendChild(f);
    fc.appendChild(ui.btn(showBirth ? "Close" : "Birth month", "hl-btn sm", () => { showBirth = !showBirth; ui.rerender(); })); if (showBirth && b.state !== "needs-birth") fc.appendChild(birthForm()); body.appendChild(fc);
    body.appendChild(el("div", "hl-doctor", data.doctorLine || "Discuss with your doctor before acting on this."));
    const g = el("div", "hl-tiles");
    data.tiles.forEach((tl) => { if (tl.empty) { const e = el("div", "hl-tile"); e.append(el("div", "hl-tile-t", tl.title), el("div", "hl-tile-s hl-muted", tl.hint)); g.appendChild(e); } else { const e = ui.tile(tl); if (tl.note) e.appendChild(el("div", "hl-tile-s hl-muted", tl.note)); g.appendChild(e); } });
    body.appendChild(g);
    body.appendChild(el("div", "hl-muted hl-small", "Tiles show each number against your own previous value and your own 30-day normal band. Add grip strength and VO2max with Add a reading on the Today page."));
  }

  // ------------------------------------------------------------ Routines: the big +1
  function ring(pct, done, target) {
    const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 64 64"); svg.setAttribute("class", "hl-ring"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", done + " of " + target + " chunks");
    const C = 2 * Math.PI * 26;
    const bg = document.createElementNS(NS, "circle"); bg.setAttribute("cx", "32"); bg.setAttribute("cy", "32"); bg.setAttribute("r", "26"); bg.setAttribute("class", "hl-ring-bg"); svg.appendChild(bg);
    const fg = document.createElementNS(NS, "circle"); fg.setAttribute("cx", "32"); fg.setAttribute("cy", "32"); fg.setAttribute("r", "26"); fg.setAttribute("class", "hl-ring-fg" + (pct >= 100 ? " full" : "")); fg.setAttribute("stroke-dasharray", (C * pct / 100).toFixed(1) + " " + C.toFixed(1)); fg.setAttribute("transform", "rotate(-90 32 32)"); svg.appendChild(fg);
    return svg;
  }
  function remForm(r) {
    const w = el("div", "hl-rem"); const times = r.reminders.times.slice(); const list = el("div", "hl-chips");
    const draw = () => { list.textContent = ""; times.forEach((tm, i) => { const b = ui.btn(tm + "  ×", "hl-chip2 hl-chip-btn", () => { times.splice(i, 1); draw(); }); b.setAttribute("aria-label", "Remove " + tm); list.appendChild(b); }); if (!times.length) list.appendChild(el("span", "hl-muted hl-small", "No times yet")); };
    draw();
    const inp = ui.input("time", "", { "aria-label": "Reminder time" }); const on = ui.input("checkbox", "", { "aria-label": "Reminders on" }); on.checked = r.reminders.enabled;
    const lab = el("label", "hl-small"); lab.append(on, document.createTextNode(" Remind me at these times"));
    w.append(lab, list, ui.btn("Add time", "hl-btn sm", () => { if (inp.value && times.indexOf(inp.value) < 0 && times.length < 12) { times.push(inp.value); times.sort(); draw(); } }), inp);
    w.appendChild(ui.btn("Save reminders", "hl-btn sm pri", () => act("routine-reminders", { id: r.id, enabled: on.checked, times }, "Reminders saved.").then(() => { showRem = null; })));
    w.appendChild(el("div", "hl-muted hl-small", "The notification only says \"Routine: time for a chunk\". It never names the routine or anything about your health."));
    return w;
  }
  function routineForm(templates) {
    const c = ui.card("Add a routine"); const tr = el("div", "hl-chips");
    templates.forEach((tp) => tr.appendChild(ui.btn(tp.title + ": " + tp.chunk + " " + tp.unit + " x " + tp.perDay, "hl-chip2 hl-chip-btn", () => { showForm = false; act("routine-add", { template: tp.id }, "Added."); })));
    c.append(el("div", "hl-small hl-muted", "Start from a template:"), tr);
    const name = ui.input("text", "e.g. Mobility", { "aria-label": "Routine name" }), unit = ui.input("text", "e.g. reps", { "aria-label": "Unit" }), chunk = ui.input("text", "10", { inputmode: "numeric", "aria-label": "Chunk size" }), per = ui.input("text", "5", { inputmode: "numeric", "aria-label": "Chunks per day" });
    const row = el("div", "hl-form"); const f = (l, i, cls) => { const w = el("label", "hl-field" + (cls ? " " + cls : "")); w.append(el("span", "hl-flabel", l), i); return w; };
    row.append(f("Or your own: name", name, "wide"), f("Unit", unit), f("Chunk size", chunk), f("Chunks a day", per), ui.btn("Add", "hl-btn pri", () => act("routine-add", { title: name.value, unit: unit.value, chunk: chunk.value, perDay: per.value }, "Added.").then((r) => { if (r && r.ok) showForm = false; })));
    c.appendChild(row); return c;
  }
  function routines(body) {
    const D = data;
    const top = el("div", "hl-actions");
    top.appendChild(ui.btn(showForm ? "Close" : "Add a routine", "hl-btn", () => { showForm = !showForm; ui.rerender(); }));
    if (D.remindersOn) { top.appendChild(ui.btn("Snooze reminders 1 h", "hl-btn sm", () => act("routine-snooze", { minutes: 60 }, "Reminders snoozed for an hour."))); if (D.snoozeUntil) top.appendChild(ui.btn("Clear snooze", "hl-btn sm", () => act("routine-snooze", { minutes: 0 }))); }
    body.appendChild(top);
    if (showForm) body.appendChild(routineForm(D.templates));
    if (!D.items.length) { body.appendChild(ui.empty("No routines yet.", ["Pick a template (push-ups, pull-ups, squats, stretch, water, walk, breathing) with Add a routine, or make your own.", "Each day is split into small chunks. Tap +1 whenever you do one.", "Skipping or pausing never costs you anything."])); return; }
    const sel = D.items.find((x) => x.id === hero) || D.items.find((x) => !x.complete && !x.paused && !x.skipped) || D.items[0]; hero = sel.id;
    const hc = ui.card(null); hc.classList.add("hl-hero"); if (sel.complete) hc.classList.add("done");
    const lab = el("div", "hl-hero-l", sel.title + " today"); const big = el("div", "hl-hero-n", String(sel.done * sel.chunk)); big.setAttribute("aria-label", sel.done * sel.chunk + " " + sel.unit + " so far");
    hc.append(lab, big, el("div", "hl-small hl-muted", "of " + sel.target * sel.chunk + " | " + Math.max(0, sel.target - sel.done) + " to go | " + sel.done + " of " + sel.target + " chunks done"));
    const plus = ui.btn(sel.complete ? "+1 more" : "+1", "hl-btn pri hl-plus", () => act("routine-chunk", { id: sel.id }).then((x) => { if (x && x.ok && x.cheer) ui.say(x.cheer); })); plus.setAttribute("aria-label", "Add one chunk of " + sel.title); if (sel.paused || sel.skipped) plus.disabled = true;
    hc.appendChild(plus);
    hc.appendChild(el("div", "hl-small hl-muted", "One tap per chunk (" + sel.chunk + " " + sel.unit + "). Undo is always next to it."));
    const ur = el("div", "hl-actions hl-center"); ur.appendChild(ui.btn("Undo last", "hl-btn sm", () => act("routine-chunk", { id: sel.id, delta: -1 })));
    ur.appendChild(ui.btn(sel.skipped ? "Unskip today" : "Skip today", "hl-btn sm", () => act("routine-skip", { id: sel.id, undo: sel.skipped }))); ur.appendChild(ui.btn(sel.paused ? "Resume" : "Pause", "hl-btn sm", () => act("routine-" + (sel.paused ? "resume" : "pause"), { id: sel.id })));
    ur.appendChild(ui.btn(showRem === sel.id ? "Close reminders" : (sel.reminders.enabled ? "Reminders on" : "Reminders"), "hl-btn sm", () => { showRem = showRem === sel.id ? null : sel.id; ui.rerender(); }));
    if (confirmDel === sel.id) ur.append(el("span", "hl-small", "Delete this routine?"), ui.btn("Yes, delete", "hl-btn sm", () => { confirmDel = null; act("routine-remove", { id: sel.id }); }), ui.btn("No", "hl-btn sm", () => { confirmDel = null; ui.rerender(); })); else ur.appendChild(ui.btn("Delete", "hl-btn sm", () => { confirmDel = sel.id; ui.rerender(); }));
    hc.appendChild(ur);
    if (showRem === sel.id) hc.appendChild(remForm(sel));
    const wk = el("div", "hl-week"); wk.setAttribute("aria-label", "Last 7 days");
    sel.week.forEach((d) => { const cell = el("div", "hl-day" + (d.met ? " met" : d.skipped ? " skip" : d.done > 0 ? " part" : "")); cell.title = d.date + ": " + d.done + " of " + d.target + (d.skipped ? ", skipped" : ""); cell.tabIndex = 0; cell.setAttribute("role", "img"); cell.setAttribute("aria-label", d.date + ": " + d.done + " of " + d.target + " chunks" + (d.skipped ? ", skipped" : "")); cell.appendChild(el("span", "hl-day-l", WD[new Date(d.date + "T12:00:00").getDay()])); cell.appendChild(el("span", "hl-day-n", String(d.done))); wk.appendChild(cell); });
    hc.appendChild(wk);
    const tg = ui.btn("Show numbers", "hl-link hl-small", () => { const ex = hc.querySelector(".hl-numlist"); if (ex) { ex.remove(); tg.textContent = "Show numbers"; return; } const ul = el("ul", "hl-ul hl-numlist"); sel.week.forEach((d) => ul.appendChild(el("li", "hl-small", d.date + ": " + d.done + " of " + d.target + (d.skipped ? " (skipped)" : "")))); wk.after(ul); tg.textContent = "Hide numbers"; });
    hc.appendChild(tg);
    body.appendChild(hc);
    const list = el("div", "hl-rlist");
    D.items.forEach((r) => {
      const row = el("button", "hl-rrow" + (r.id === sel.id ? " sel" : "")); row.type = "button"; row.setAttribute("aria-pressed", r.id === sel.id ? "true" : "false");
      const mark = el("span", "hl-rcheck" + (r.complete ? " on" : ""), r.complete ? "✓" : ""); row.append(mark, el("b", "", r.title), el("span", "hl-sp"), el("span", "hl-small hl-muted", r.paused ? "paused" : r.skipped ? "skipped today" : r.done + " of " + r.target + " chunks"));
      row.addEventListener("click", () => { hero = r.id; ui.rerender(); }); list.appendChild(row);
    });
    body.appendChild(list);
    const tot = D.items.reduce((a, x) => a + x.weekChunks, 0), prev = D.items.reduce((a, x) => a + x.prevWeekChunks, 0);
    body.appendChild(el("div", "hl-note hl-gentle", "Missed a chunk? Nothing is lost and nothing is scolded. The count just carries on; tomorrow starts fresh. This week: " + tot + " chunks so far (last week " + prev + ")."));
    const q = ui.card("Quiet hours"); const s = ui.input("time", "", { "aria-label": "Quiet from" }), e = ui.input("time", "", { "aria-label": "Quiet until" }); s.value = D.quiet.start; e.value = D.quiet.end;
    const row = el("div", "hl-form"); row.append(el("span", "hl-small", "No reminders from"), s, el("span", "hl-small", "until"), e, ui.btn("Save", "hl-btn sm", () => act("routine-quiet", { start: s.value, end: e.value }, "Quiet hours saved.")));
    q.append(row, el("div", "hl-muted hl-small", "Reminders are optional, one notification at a time, and only while a reminder is switched on.")); body.appendChild(q);
  }

  // ------------------------------------------------------------ Interaction check (agent-written list, read only)
  const SEV_CLASS = { info: "st st-tried", timing: "st st-saved", caution: "ev ev-single-study", serious: "ev ev-preclinical" };
  function interactions(body) {
    const D = data;
    body.appendChild(el("div", "hl-note", "This list is written by the Health agent from official label text. The app never looks anything up online and never recommends an amount. A result that says nothing found never means safe. " + D.doctorLine));
    const m = ui.card("Your current list"); const w = el("div", "hl-chips");
    if (!D.meds.length) m.appendChild(el("div", "hl-muted hl-pad", "Nothing active. Add supplements and medicines on the Meds page."));
    D.meds.forEach((x) => w.appendChild(chip(x.name + (x.medKind === "prescription" ? " (prescription)" : " (yours)"), "tag"))); m.appendChild(w); body.appendChild(m);
    if (!D.pairs.length) { body.appendChild(ui.empty("No interaction notes yet.", ["The Health agent writes agent\\interactions.json after it checks your list against label text.", "Until then, no check has been made. No news is not the same as no interaction."])); return; }
    const mine = D.pairs.filter((p) => p.onList), other = D.pairs.filter((p) => !p.onList);
    const draw = (p) => { const k = ui.card(null); k.classList.add("hl-ix"); const t = el("div", "hl-ins-t"); t.append(chip((D.severity.find((x) => x[0] === p.severity) || [0, p.severity])[1], SEV_CLASS[p.severity]), el("b", "", p.a + " + " + p.b)); if (p.amountRemoved) t.appendChild(chip("amount removed", "ev ev-anecdote")); k.append(t, el("p", "hl-p", p.summary)); if (p.sources.length) k.appendChild(links(p.sources)); k.appendChild(el("div", "hl-doctor", D.doctorLine)); return k; };
    const c = ui.card("Result" + (D.checked ? " (checked " + D.checked + ")" : ""));
    if (!mine.length) c.appendChild(el("div", "hl-muted hl-pad", "No notes for the items currently on your list.")); body.appendChild(c);
    mine.forEach((p) => body.appendChild(draw(p)));
    if (other.length) { const o = ui.card("Other pairs the agent checked, not both on your list now"); other.forEach((p) => o.appendChild(draw(p))); body.appendChild(o); }
    if (D.rejected) body.appendChild(el("div", "hl-muted hl-small", D.rejected + " note(s) were not shown (unreadable)."));
  }

  // ------------------------------------------------------------ Evidence map: columns by the strongest kind of evidence
  const COLS = [["guideline", "Guideline / meta-analysis", ["guideline", "meta-analysis"]], ["single-study", "Single studies", ["single-study"]], ["preclinical", "Preclinical", ["preclinical"]], ["traditional", "Traditional / historical", ["traditional"]], ["anecdote", "Anecdote", ["anecdote"]]];
  function evidence(body) {
    const D = data, f = flt.evidence;
    body.appendChild(el("div", "hl-note", "Evidence is not only modern trials. Traditional and historical use is its own column here, beside guidelines and studies, not \"no evidence\". An item sits in the column of its strongest kind of evidence; click it to see all its kinds and sources. " + D.doctorLine));
    const fl = el("div", "hl-filters");
    fl.append(select([["", "Any tradition"]].concat(D.enums.traditions), f.tradition, (v) => { f.tradition = v; ui.rerender(); }, "Filter by tradition"), select([["", "Any kind"]].concat(D.enums.kinds.map((k) => [k, k[0].toUpperCase() + k.slice(1)])), f.kind, (v) => { f.kind = v; ui.rerender(); }, "Filter by kind"),
      select([["0", "Any strength"], ["2", "Strength 2 or more"], ["3", "Strength 3 or more"], ["4", "Strength 4 or more"]], f.min, (v) => { f.min = v; ui.rerender(); }, "Filter by minimum strength"));
    body.appendChild(fl);
    if (!D.items.length) { body.appendChild(ui.empty("No evidence map yet.", ["The Health agent writes agent\\evidence.json: each supplement, practice, exercise or therapy with the kinds of evidence behind it."])); return; }
    const min = +f.min;
    const shown = D.items.filter((i) => (!f.tradition || i.tradition === f.tradition) && (!f.kind || i.kind === f.kind) && i.max >= min);
    if (!shown.length) body.appendChild(el("div", "hl-muted hl-pad", "Nothing matches these filters."));
    const top = (i) => i.evidence.slice().sort((a, b) => b.strength - a.strength || ["guideline", "meta-analysis", "single-study", "preclinical", "traditional", "anecdote"].indexOf(a.level) - ["guideline", "meta-analysis", "single-study", "preclinical", "traditional", "anecdote"].indexOf(b.level))[0];
    const map = el("div", "hl-emap");
    COLS.forEach(([id, label, levels]) => {
      const col = el("div", "hl-ecol"); col.appendChild(el("h4", "hl-ecol-h", label));
      shown.filter((i) => levels.indexOf(top(i).level) >= 0).forEach((i) => { const b = ui.btn(i.name + "  " + dots(top(i).strength), "hl-eitem ev-" + top(i).level + (f.sel === i.id ? " sel" : ""), () => { f.sel = f.sel === i.id ? "" : i.id; ui.rerender(); }); b.setAttribute("aria-pressed", f.sel === i.id ? "true" : "false"); col.appendChild(b); });
      map.appendChild(col);
    });
    body.appendChild(map);
    const it = shown.find((i) => i.id === f.sel);
    if (it) {
      const k = ui.card(null); const t = el("div", "hl-ins-t"); t.append(el("b", "", it.name), chip(it.kind), chip(trLabel(it.tradition), "tr")); if (it.amountRemoved) t.appendChild(chip("amount removed", "ev ev-anecdote")); k.appendChild(t);
      if (it.summary) k.appendChild(el("p", "hl-p", it.summary));
      const bars = el("div", "hl-ebars");
      it.evidence.slice().sort((a, b) => b.strength - a.strength).forEach((e) => { const r = el("div", "hl-ebar"); r.append(chip(evLabel(e.level), "ev ev-" + e.level), (() => { const mt = el("span", "hl-meter lv-" + e.level); mt.setAttribute("role", "img"); mt.setAttribute("aria-label", "Strength " + e.strength + " of 5"); for (let n = 1; n <= 5; n++) mt.appendChild(el("i", n <= e.strength ? "on" : "")); return mt; })(), el("span", "hl-small", "strength " + e.strength + " of 5" + (e.note ? ": " + e.note : ""))); bars.appendChild(r); });
      k.appendChild(bars); if (it.sources.length) k.appendChild(links(it.sources)); k.appendChild(el("div", "hl-doctor", D.doctorLine)); body.appendChild(k);
    } else body.appendChild(el("div", "hl-muted hl-small hl-pad", "Click a topic to see its sources."));
    body.appendChild(el("div", "hl-doctor", D.doctorLine));
  }

  // ------------------------------------------------------------ Weekly review (opens from the Today card)
  function weekly(body) {
    const D = data, layout = el("div", "hl-weekly");
    const list = el("div", "hl-weeks"); list.appendChild(el("b", "hl-small", "Weeks"));
    D.weeks.forEach((w) => { const b = ui.btn(w.week + (w.hasNote ? "" : " (numbers only)"), "hl-btn sm" + (w.week === D.selected ? " pri" : ""), () => ui.reloadMore({ week: w.week })); b.title = w.range ? w.range.start + " to " + w.range.end : ""; list.appendChild(b); });
    const main = el("div", "hl-week-main"); const r = D.stats ? D.stats : null;
    main.appendChild(el("h3", "hl-h3", D.selected + (r ? " (" + r.start + " to " + r.end + ")" : "")));
    const n = D.note, nc = ui.card("The agent's review");
    if (!n) nc.appendChild(el("div", "hl-muted hl-pad", "No review written for this week yet. The Health agent writes agent\\weekly\\" + D.selected + ".json."));
    else {
      if (n.summary) nc.appendChild(el("p", "hl-p", n.summary));
      const sec = (title, items, cls) => { if (!items.length) return; nc.appendChild(el("b", "hl-small", title)); const ul = el("ul", "hl-ul " + (cls || "")); items.forEach((x) => ul.appendChild(el("li", "", typeof x === "string" ? x : (x.label ? x.label + ": " : "") + x.text))); nc.appendChild(ul); };
      sec("What changed", n.changed); sec("Improved vs last week", n.improved, "hl-ok"); sec("Worse vs last week", n.worsened, "hl-warn"); sec("Experiments", n.experiments); sec("Questions to think about or ask your doctor", n.questions);
      nc.appendChild(el("div", "hl-doctor", "Discuss with your doctor before acting on this."));
    }
    main.appendChild(nc);
    if (r) {
      const sc = ui.card("The numbers (worked out by the app)");
      if (!r.rows.length) sc.appendChild(el("div", "hl-muted hl-pad", "No readings in this week or the one before."));
      else { const t = el("div", "hl-wk-stats"); const hd = el("div", "hl-wkrow hl-lab-h"); ["MARKER", "THIS WEEK", "PREVIOUS WEEK", "CHANGE", ""].forEach((x) => hd.appendChild(el("div", "", x))); t.appendChild(hd);
        r.rows.forEach((x) => {
          const row = el("div", "hl-wkrow"); const open = wkOpen.has(x.metric);
          const cb = ui.btn(open ? "Hide chart" : "Chart", "hl-btn sm", () => { if (open) wkOpen.delete(x.metric); else wkOpen.add(x.metric); ui.rerender(); }); cb.setAttribute("aria-expanded", open ? "true" : "false");
          row.append(el("div", "", x.label), el("div", "", (x.cur || "no readings") + (x.cur ? " (" + x.n + ")" : "") + (x.total ? ", total " + x.total : "")), el("div", "hl-muted", x.prev ? x.prev + " (" + x.nPrev + ")" : "no readings"), el("div", "", x.change ? (DIR[x.change.dir] || "") + " " + (x.change.dir === "flat" ? "no change" : x.change.text) : ""), cb); t.appendChild(row);
          if (open) { const cr = el("div", "hl-lab-chart"); cr.appendChild(ui.chart({ series: x.series, unit: x.unit, dec: x.dec, kind: x.kind, w: 620, h: 190, title: x.label + ", two weeks", startTs: x.startTs })); t.appendChild(cr); }
        }); sc.appendChild(t); }
      if (r.routines.length) { sc.appendChild(el("b", "hl-small", "Routines")); const ul = el("ul", "hl-ul"); r.routines.forEach((x) => ul.appendChild(el("li", "", x.title + ": " + x.chunks + " of " + x.target + " chunks, " + x.daysMet + " day" + (x.daysMet === 1 ? "" : "s") + " completed"))); sc.appendChild(ul); }
      sc.appendChild(el("div", "hl-small hl-muted", "Experiments now: " + r.experiments.running + " running, " + r.experiments.kept + " kept, " + r.experiments.dropped + " dropped.")); main.appendChild(sc);
    }
    layout.append(list, main); body.appendChild(layout);
  }

  // ------------------------------------------------------------ Reading list and Worldview
  function reading(body) {
    const D = data;
    body.appendChild(el("div", "hl-note", "Each item has a plain summary of its key points, so you can take it in without reading the paper. The source link opens in your browser."));
    const unread = D.items.filter((i) => !i.read).length;
    const bar = el("div", "hl-filterbar"); bar.append(el("span", "hl-flabel", "SHOW"), select([["unread", "Unread"], ["read", "Read"], ["", "All"]], flt.reading, (v) => { flt.reading = v; ui.rerender(); }, "Filter by read status"), el("span", "hl-sp"), el("span", "hl-small hl-muted", unread + " unread")); body.appendChild(bar);
    if (!D.items.length) body.appendChild(ui.empty("Nothing saved to read yet.", ["The Health agent saves papers and historical sources into agent\\reading.json, each with 3 to 6 plain key points."]));
    const shown = D.items.filter((i) => !flt.reading || (flt.reading === "read" ? i.read : !i.read));
    if (D.items.length && !shown.length) body.appendChild(el("div", "hl-muted hl-pad", "Nothing in this list."));
    shown.forEach((i) => {
      const k = ui.card(null); const t = el("div", "hl-ins-t"); t.append(el("b", "", i.title), chip(i.read ? "read" : "unread", i.read ? "st st-kept" : "st st-new")); k.appendChild(t);
      const cs = el("div", "hl-chips"); cs.append(evChip(i.evidence), chip(trLabel(i.tradition), "tr"), chip(i.kind)); if (i.amountRemoved) cs.appendChild(chip("amount removed", "ev ev-anecdote")); if (i.minutes) cs.appendChild(chip(i.minutes + " min read")); if (i.year || i.authors) cs.appendChild(el("span", "hl-muted hl-small", [i.authors, i.year].filter(Boolean).join(", "))); k.appendChild(cs);
      const ul = el("ul", "hl-ul hl-points"); i.points.forEach((x) => ul.appendChild(el("li", "", x))); k.appendChild(ul);
      if (i.source) k.appendChild(links([{ title: i.source.title, url: i.source.url, host: i.host, allowed: i.allowed }]));
      const note = ui.input("text", "your note", { "aria-label": "Your note on " + i.title }); note.value = i.note || "";
      const row = el("div", "hl-actions"); row.append(note, ui.btn("Save note", "hl-btn sm", () => act("reading-note", { id: i.id, text: note.value }, "Note saved in the health folder.")), ui.btn(i.read ? "Mark unread" : "Read", "hl-btn sm" + (i.read ? "" : " pri"), () => act("reading-read", { id: i.id, read: !i.read })));
      k.appendChild(row); body.appendChild(k);
    });
    const wv = ui.card("Worldview", "your preferences, applied to everything"); const w = D.worldview || { text: "" };
    if (w.text) { wv.appendChild(el("div", "hl-worldview", w.text)); wv.appendChild(el("div", "hl-muted hl-small", "Kept by the Health agent" + (w.mtime ? " (updated " + w.mtime + ")" : "") + ". Changed by telling the Health agent; this screen only shows it, so nothing is hidden from you.")); }
    else wv.appendChild(el("div", "hl-muted hl-pad", w.tooBig ? "The worldview file is too large to show here." : "The Health agent has not written a summary yet. Change it by telling the agent; this screen only shows it."));
    body.appendChild(wv);
  }

  // ------------------------------------------------------------ Nutrition (vegan recipes, focus from labs, shopping list)
  function recipeCard(r, D, hero) {
    const k = ui.card(null); k.classList.add("hl-recipe"); if (hero) k.classList.add("hero");
    const cap = hero ? el("div", "hl-hero-l", "Today's vegan recipe") : null; if (cap) k.appendChild(cap);
    const t = el("div", "hl-ins-t"); t.append(el("b", "hl-recipe-t", r.title), chip("vegan", "st st-kept"), r.status !== "new" ? chip(r.status === "dismissed" ? "not for me" : r.status, "st st-" + (r.status === "cooked" ? "kept" : r.status === "dismissed" ? "dismissed" : "saved")) : "");
    const meta = el("div", "hl-chips"); if (r.minutes) meta.appendChild(el("span", "hl-small hl-muted", r.minutes + " min")); if (r.servings) meta.appendChild(el("span", "hl-small hl-muted", "serves " + r.servings)); meta.appendChild(el("span", "hl-small hl-muted", r.season === "all-year" ? "all year" : r.season + " season")); if (r.availability) meta.appendChild(el("span", "hl-small hl-muted", r.availability));
    const head = el("div", "hl-recipe-head");
    if (r.imageData) { const im = document.createElement("img"); im.src = r.imageData; im.alt = ""; im.className = "hl-recipe-img"; head.appendChild(im); } else if (hero) head.appendChild(el("div", "hl-photo", "photo slot"));
    const hb = el("div", "hl-recipe-hb"); hb.append(t, meta);
    if (r.nutrients.length) { const nc = el("div", "hl-chips"); r.nutrients.forEach((n) => { const c2 = chip(n.name, "ref"); c2.title = n.perServing + (n.note ? " (" + n.note + ")" : ""); nc.appendChild(c2); }); hb.appendChild(nc); }
    if (r.evidence) hb.appendChild(el("div", "hl-chips")).append(evChip(r.evidence), chip(r.season === "all-year" ? "Plant-based" : "In season", "tr"));
    head.appendChild(hb); k.appendChild(head);
    if (r.veganCheck.length) k.appendChild(el("div", "hl-doctor", "Check before cooking: " + r.veganCheck.join(", ") + " may not be vegan."));
    const why = el("div", "hl-why"); why.append(el("b", "hl-small", "Why this is for you"), el("div", "", r.why.text || "The agent gave no reason.")); if (r.why.relates.length) why.appendChild(refChips(r.why.relates)); if (r.evidenceNote) why.appendChild(el("div", "hl-small", r.evidenceNote)); k.appendChild(why);
    if (r.nutrients.length) { const nl = el("ul", "hl-ul hl-nuts"); r.nutrients.forEach((n) => nl.appendChild(el("li", "hl-small", n.name + " " + n.perServing + " per serving" + (n.note ? " (" + n.note + ")" : "")))); k.appendChild(nl); }
    const ing = el("ul", "hl-ul hl-ing"); r.ingredients.forEach((x) => ing.appendChild(el("li", "", (x.amount ? x.amount + " " : "") + x.item))); k.append(el("b", "hl-small", "Ingredients"), ing);
    const mo = methodOpen.has(r.id); k.appendChild(ui.btn(mo ? "Hide method" : "Show method", "hl-btn sm", () => { if (mo) methodOpen.delete(r.id); else methodOpen.add(r.id); ui.rerender(); }));
    if (mo) { const ol = el("ol", "hl-ul"); r.steps.forEach((x) => ol.appendChild(el("li", "", x))); k.appendChild(ol); }
    if (r.sources.length) k.appendChild(links(r.sources));
    if (r.medical || r.why.relates.some((q) => q.type === "lab" || q.type === "history")) k.appendChild(el("div", "hl-doctor", D.doctorLine + " No amounts or doses are suggested."));
    const row = el("div", "hl-actions");
    row.append(ui.btn(r.status === "cooked" ? "Cooked again" : "Cooked it", "hl-btn pri", () => act("recipe-cooked", { id: r.id }, "Noted. The agent will see you liked cooking it.")), ui.btn("Not for me", "hl-btn", () => act("recipe-not-for-me", { id: r.id }, "Hidden. The agent will see it was not for you.")),
      ui.btn(r.status === "saved" ? "Saved" : "Save", "hl-btn", () => act("recipe-save", { id: r.id }, "Saved.")), r.inShop ? ui.btn("On the shopping list (remove)", "hl-btn", () => act("recipe-unshop", { id: r.id })) : ui.btn("Add to shopping list", "hl-btn", () => act("recipe-shop", { id: r.id }, "Added to the shopping list.")));
    k.appendChild(row); return k;
  }
  function shoppingCard(D) {
    const sh = D.shopping, sc = ui.card("Shopping list", sh.items.length ? sh.left + " to buy" : "");
    if (!sh.items.length) sc.appendChild(el("div", "hl-muted hl-pad", "Empty. Use Add to shopping list on a recipe: the ingredients are combined here."));
    else {
      const rr = el("div", "hl-chips"); sh.recipes.forEach((r) => { const b = ui.btn(r.title + "  ×", "hl-chip2 hl-chip-btn", () => act("recipe-unshop", { id: r.id })); b.setAttribute("aria-label", "Remove " + r.title + " from the list"); rr.appendChild(b); }); sc.appendChild(rr);
      sh.items.forEach((i) => { const row = el("label", "hl-shop" + (i.checked ? " done" : "")); const cbx = ui.input("checkbox", "", { "aria-label": i.item }); cbx.checked = i.checked; cbx.addEventListener("change", () => act("shop-check", { key: i.key, checked: cbx.checked })); row.append(cbx, el("span", "hl-shop-n", i.item), el("span", "hl-muted hl-small", i.amount)); sc.appendChild(row); });
      const bar = el("div", "hl-actions"); bar.append(ui.btn("Remove checked items", "hl-btn sm", () => act("shop-clear-checked", {})), ui.btn("Clear the list", "hl-btn sm", () => act("shop-clear-all", {}))); sc.appendChild(bar);
    }
    return sc;
  }
  function nutrition(body) {
    const D = data;
    body.appendChild(el("div", "hl-note hl-planned", "Planned from: your blood work (the markers below), and a plant-based preference. The amounts here are food amounts. The links between a lab marker and a nutrient are simple rules, not medical advice. Edit by telling the Health agent; this screen only shows it."));
    const strip = el("div", "hl-focus");
    if (!D.focus.length) strip.appendChild(el("div", "hl-muted hl-pad", "None of your nutrition-linked markers is outside its lab range or optimal zone, or trending the wrong way."));
    D.focus.forEach((f) => {
      const k = el("div", "hl-focus-i"); const open = focusOpen.has(f.key + f.nutrient);
      k.append(el("div", "hl-lab", f.nutrient.toUpperCase()), el("div", "hl-small", f.test + ": " + ui.num(f.value) + (f.unit ? " " + f.unit : "") + " | " + f.reason + (f.previous != null ? " (previous " + ui.num(f.previous) + ")" : "") + " | " + ui.dayText(f.ts)),
        el("div", "hl-small " + (f.recipeCount ? "hl-ok" : "hl-muted"), f.recipeCount ? "✓ in " + f.recipeCount + " of the recipes below" : "▲ no recipe below lists this nutrient yet"));
      const cb = ui.btn(open ? "Hide chart" : "Chart", "hl-btn sm", () => { if (open) focusOpen.delete(f.key + f.nutrient); else focusOpen.add(f.key + f.nutrient); ui.rerender(); }); cb.setAttribute("aria-expanded", open ? "true" : "false"); k.appendChild(cb);
      if (open) k.appendChild(ui.chart({ series: f.series, unit: f.unit, dec: 2, w: 460, h: 170, title: f.test + " results", band: f.refBand }));
      strip.appendChild(k);
    });
    body.appendChild(strip);
    const fl = el("div", "hl-filterbar"); fl.append(el("span", "hl-flabel", "SHOW"), select([["open", "New and saved"], ["saved", "Saved"], ["cooked", "Cooked"], ["dismissed", "Not for me"], ["all", "All"]], flt.recipes, (v) => { flt.recipes = v; ui.rerender(); }, "Filter recipes")); body.appendChild(fl);
    if (!D.recipes.length) { body.appendChild(ui.empty("No recipes yet.", ["The Health agent writes a few vegan recipes each day into agent\\recipes\\YYYY-MM-DD.json.", "Each one shows why it was chosen for your numbers."])); body.appendChild(shoppingCard(D)); return; }
    const shown = D.recipes.filter((r) => flt.recipes === "all" || (flt.recipes === "open" ? r.status === "new" || r.status === "saved" : r.status === flt.recipes));
    const two = el("div", "hl-nut2"); const main = el("div", "hl-nut-main"); two.append(main, shoppingCard(D));
    if (!shown.length) main.appendChild(el("div", "hl-muted hl-pad", "No recipes in this view."));
    shown.forEach((r, i) => main.appendChild(recipeCard(r, D, i === 0 && flt.recipes === "open")));
    body.appendChild(two);
  }

  window.healthMoreUi = { render(tab, body, d, u) { ui = u; data = d; ({ longevity, routines, interactions, evidence, weekly, reading, nutrition })[tab](body); } };
})();
