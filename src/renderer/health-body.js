// My Health "Body map" page (v1.118.0): pain-spot map + pain log. Loaded lazily by health.js the first time the page opens (with
// ../health/body-data.js and ../health/body-logic.js and styles-health-body.css), so start-up weight is zero.
// The data lives in pain_log.jsonl in the health store folder, read and appended ONLY by the main process (health-body-load / -save).
// textContent only. No timers, no polling, no network. Screens follow UI-UX body_tab_pain_flow.html.
// LEFT / RIGHT: always the person's own side. FRONT view: your RIGHT is on the screen's LEFT. BACK view: your RIGHT is on the screen's RIGHT.
(function () {
  "use strict";
  const api = window.api && window.api.health, L = window.healthBodyLogic, D = window.healthBodyData;
  if (!api || !api.bodyLoad || !L || !D) return;
  const NS = "http://www.w3.org/2000/svg";
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ZONES = L.zones();
  const S = { ui: null, host: null, res: null, eps: [], loading: false, gen: 0, saving: false, screen: "home", listMode: false, draft: null, epId: null, hist: { days: 30, metric: "entries", zone: null }, better: null, lastFocus: null, msg: "" };

  // ------------------------------------------------------------------ helpers
  function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) { e.textContent = text; } return e; }
  function sv(tag, attrs, text) { const e = document.createElementNS(NS, tag); if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); if (text != null) e.textContent = text; return e; }
  function btn(label, cls, onClick, extra) { const b = h("button", cls || "hb-btn", label); b.type = "button"; if (extra) Object.keys(extra).forEach((k) => b.setAttribute(k, extra[k])); b.addEventListener("click", (ev) => { ev.preventDefault(); onClick(ev); }); return b; }
  function dateText(s, withYear) { if (!L.validDate(s)) return ""; const d = new Date(s + "T00:00:00Z"); return WD[d.getUTCDay()] + " " + d.getUTCDate() + " " + MON[d.getUTCMonth()] + (withYear ? " " + d.getUTCFullYear() : ""); }
  const sevText = (n) => n + " · " + (D.severity.find((x) => x[0] === n) || [0, ""])[1];
  const label = (list, key) => { const e = list.find((x) => x[0] === key); return e ? e[1] : key; };
  const today = () => L.localDate();   // recomputed every time: a tab left open past midnight must not keep yesterday
  const ucfirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  function pill(n) { return h("span", "hb-pill st" + n, sevText(n)); }
  function listText(list, key) { return (list || []).map((k) => label(D[key], k)).join(", "); }
  function lc1(t) { return t.charAt(0).toLowerCase() + t.slice(1); }
  function boldify(parent, text, bold) {
    let rest = text;
    (bold || []).forEach((b) => { const i = rest.indexOf(b); if (i < 0) return; });
    const marks = []; (bold || []).forEach((b) => { const i = text.indexOf(b); if (i >= 0) marks.push([i, i + b.length]); });
    marks.sort((a, b) => a[0] - b[0]); let pos = 0;
    marks.forEach(([a, b]) => { if (a < pos) return; if (a > pos) parent.appendChild(document.createTextNode(text.slice(pos, a))); parent.appendChild(h("strong", "", text.slice(a, b))); pos = b; });
    if (pos < text.length) parent.appendChild(document.createTextNode(text.slice(pos)));
    return parent;
  }
  function focusHeading() { const t = S.host && S.host.querySelector("[data-hb-focus]"); if (t) { t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: false }); } }

  // ------------------------------------------------------------------ data
  function reload(thenRender) {
    S.loading = true; const gen = S.gen;
    return api.bodyLoad().then((r) => { if (gen !== S.gen) return; S.loading = false; S.res = r; S.eps = r && r.ok ? L.buildEpisodes(r.entries) : []; if (thenRender !== false) paint(); })
      .catch(() => { if (gen !== S.gen) return; S.loading = false; S.res = { ok: false, reason: "The pain log could not be read." }; if (thenRender !== false) paint(); });
  }
  function save(entries, okText) {
    const gen = S.gen;
    return api.bodySave(entries).then((r) => {
      if (gen !== S.gen) return { ok: false, stale: true };   // the view was closed meanwhile: keep nothing in memory
      if (!r || !r.ok) { S.ui.say((r && r.reason) || "That did not save."); return r; }
      S.res = r; S.eps = L.buildEpisodes(r.entries); if (okText) S.ui.say(okText); return r;
    }).catch(() => { if (gen === S.gen) S.ui.say("That did not save."); return { ok: false }; });
  }

  // ------------------------------------------------------------------ the figure
  // opts: {sel:Set of zone ids, level:{id:1-4}, badge:{id:number}, act:Set (active spots), onZone(id), w}
  function figure(view, opts) {
    const o = opts || {}, V = D.views[view], sel = o.sel || new Set(), zs = V.zones;
    const wrap = h("figure", "hb-fig"); wrap.dataset.view = view;
    const cap = h("figcaption", "hb-figcap"); cap.append(h("b", "", V.label), h("span", "hb-figsub", view === "front" ? "your RIGHT is on the screen's left" : "your RIGHT is on the screen's right"));
    wrap.appendChild(cap);
    const svg = sv("svg", { "class": "hb-svg", viewBox: D.viewBox, role: "group", "aria-label": "Body, " + V.label.toLowerCase() + " view, " + zs.length + " spots. Tab moves between spots, Enter selects. Your RIGHT is on the " + (view === "front" ? "left" : "right") + " of the screen." });
    const defs = sv("defs"); [["3", 5], ["4", 3]].forEach(([n, gap]) => { const p = sv("pattern", { id: "hbp" + n + "-" + view, width: String(gap), height: String(gap), patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }); p.appendChild(sv("rect", { width: String(gap), height: String(gap), fill: "none" })); p.appendChild(sv("line", { x1: "0", y1: "0", x2: "0", y2: String(gap), "class": "hb-hatch" + n, "stroke-width": "2" })); defs.appendChild(p); });
    svg.appendChild(defs);
    const g = sv("g"); V.shapes.forEach(([tag, a]) => { const e = sv(tag, a); e.setAttribute("class", "hb-sil"); g.appendChild(e); }); svg.appendChild(g);
    const left = view === "front" ? "RIGHT" : "LEFT", right = view === "front" ? "LEFT" : "RIGHT";
    [[-28, "start", left], [228, "end", right]].forEach(([x, anchor, word]) => { svg.appendChild(sv("text", { x: String(x), y: "196", "text-anchor": anchor, "class": "hb-side hb-side1", "aria-hidden": "true" }, "YOUR")); svg.appendChild(sv("text", { x: String(x), y: "210", "text-anchor": anchor, "class": "hb-side", "aria-hidden": "true" }, word)); });
    const els = [];
    zs.forEach((zr) => {
      const z = ZONES[zr[0]], lv = (o.level || {})[z.id] || 0, isSel = sel.has(z.id), isAct = o.act && o.act.has(z.id);
      const name = L.zoneLabel(z), cnt = (o.count || {})[z.id];
      const e = sv("ellipse", { "class": "hb-zone" + (isSel ? " sel" : "") + (lv ? " h" + lv : "") + (isAct ? " act" : ""), "data-id": z.id, cx: String(z.cx), cy: String(z.cy), rx: String(z.rx), ry: String(z.ry), tabindex: "0", role: "button",
        "aria-label": name + (isSel ? ", selected" : "") + (isAct ? ", active now" : "") + (cnt ? ", " + cnt + (cnt === 1 ? " entry" : " entries") : ""), "aria-pressed": isSel ? "true" : "false" });
      const t = sv("title", null, name); e.appendChild(t);
      const fire = () => { if (o.onZone) o.onZone(z.id); };
      e.addEventListener("click", fire);
      e.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fire(); return; }
        const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key]; if (!dir) return;
        let best = null, bd = 1e9; zs.forEach((q) => { if (q[0] === z.id) return; const dx = q[3] - z.cx, dy = q[4] - z.cy, along = dx * dir[0] + dy * dir[1]; if (along <= 0.5) return; const d = along + 2.5 * Math.abs(dx * dir[1] + dy * dir[0]); if (d < bd) { bd = d; best = q[0]; } });
        if (best) { ev.preventDefault(); const t2 = svg.querySelector('[data-id="' + best + '"]'); if (t2) t2.focus(); }
      });
      els.push([z, e, lv]); svg.appendChild(e);
      if (lv >= 3) svg.appendChild(sv("ellipse", { "class": "hb-hz", cx: String(z.cx), cy: String(z.cy), rx: String(z.rx), ry: String(z.ry), fill: "url(#hbp" + (lv === 3 ? "3" : "4") + "-" + view + ")", "pointer-events": "none" }));
    });
    const badge = (z, text, cls) => { const b = sv("g", { "class": cls, "pointer-events": "none" }); b.appendChild(sv("circle", { cx: String(z.cx), cy: String(z.cy), r: "8" })); b.appendChild(sv("text", { x: String(z.cx), y: String(z.cy + 3.5) }, String(text))); svg.appendChild(b); };
    Object.keys(o.badge || {}).forEach((id) => { const z = ZONES[id]; if (z && z.view === view) badge(z, o.badge[id], "hb-bd"); });
    sel.forEach((id) => { const z = ZONES[id]; if (z && z.view === view) { const b = sv("g", { "class": "hb-pin", "pointer-events": "none" }); b.appendChild(sv("circle", { cx: String(z.cx), cy: String(z.cy - 2), r: "10" })); b.appendChild(sv("text", { x: String(z.cx), y: String(z.cy + 2) }, "!")); svg.appendChild(b); } });
    wrap.appendChild(svg); return wrap;
  }
  function zoneList(onZone, sel) {
    const w = h("div", "hb-zlist");
    ["front", "back"].forEach((view) => {
      const sec = h("section", "hb-zsec"); const hd = h("h4", "", D.views[view].label.charAt(0) + D.views[view].label.slice(1).toLowerCase() + " view"); sec.appendChild(hd);
      const ul = h("ul", ""); D.views[view].zones.forEach((zr) => { const z = ZONES[zr[0]], li = h("li"); li.appendChild(btn(L.zoneLabel(z), "hb-zbtn" + (sel && sel.has(z.id) ? " on" : ""), () => onZone(z.id), { "aria-pressed": sel && sel.has(z.id) ? "true" : "false" })); ul.appendChild(li); });
      sec.appendChild(ul); w.appendChild(sec);
    }); return w;
  }

  // ------------------------------------------------------------------ shell / router
  function activeSet() { const s = new Set(); S.eps.forEach((e) => { if (e.active) e.zones.forEach((z) => s.add(z)); }); return s; }
  // Focus survives in-place repaints: remember which control had it and give it to the same control afterwards.
  function ctlKey(e) { if (!e || !e.getAttribute) return ""; if (e.getAttribute("data-hbkey")) return e.getAttribute("data-hbkey"); if (e.getAttribute("data-id")) return "z:" + e.getAttribute("data-id"); if (!/^(button|input|textarea|select)$/i.test(e.tagName)) return ""; return e.tagName + ":" + (e.name || "") + ":" + (e.value || "") + ":" + (e.textContent || "").trim().slice(0, 40); }
  function paint() {
    const host = S.host; if (!host) return;
    const ae = document.activeElement, key = ae && host.contains(ae) ? ctlKey(ae) : "";
    paintInner(host);
    if (key && host.isConnected) { const hit = Array.from(host.querySelectorAll("button,input,textarea,select,[data-id]")).find((x) => ctlKey(x) === key); if (hit && document.activeElement !== hit) hit.focus({ preventScroll: true }); }
  }
  function paintInner(host) {
    host.textContent = "";
    if (!S.res) { host.appendChild(h("div", "hl-muted hl-pad", "Reading your pain log...")); return; }
    if (!S.res.ok) { host.appendChild(h("div", "hl-error hl-pad", S.res.reason || "The pain log is not available.")); return; }
    if (S.screen === "log") return logScreen(host);
    if (S.screen === "detail") return detailScreen(host);
    host.appendChild(topNav());
    if (S.screen === "history") historyScreen(host); else homeScreen(host);
    if (S.screen === "better") betterDialog(host);
  }
  function topNav() {
    const n = h("div", "hb-nav"); n.setAttribute("role", "group"); n.setAttribute("aria-label", "Body map views");
    [["home", "My spots"], ["history", "History"]].forEach(([k, t]) => { const on = S.screen === k || (k === "home" && S.screen === "better"); n.appendChild(btn(t, "hb-seg" + (on ? " on" : ""), () => { S.screen = k; paint(); }, { "aria-pressed": on ? "true" : "false" })); });
    return n;
  }

  // ------------------------------------------------------------------ home
  function homeScreen(host) {
    const act = S.eps.filter((e) => e.active), actZ = activeSet(), badge = {};
    act.forEach((e) => e.entries.filter((x) => x.date === e.lastDate).forEach((x) => { badge[x.zone] = Math.max(badge[x.zone] || 0, x.severity); }));
    const root = h("div", "hb-two");
    const figs = h("div", "hb-figcol"), row = h("div", "hb-figs");
    const pick = (id) => startLog({ zones: [id] });
    if (S.listMode) { figs.appendChild(zoneList(pick)); }
    else { ["front", "back"].forEach((v) => row.appendChild(figure(v, { act: actZ, badge, onZone: pick }))); figs.appendChild(row); }
    const hint = h("div", "hb-hint"); hint.append(h("b", "", "Tap or press Enter on a spot"), document.createTextNode(" where it hurts. "));
    hint.appendChild(btn(S.listMode ? "Show the figure again" : "Switch to a list instead", "hb-link", () => { S.listMode = !S.listMode; paint(); }, { "data-hbkey": "listmode" }));
    figs.appendChild(hint); root.appendChild(figs);
    const side = h("div", "hb-side-col");
    const sh = h("h3", "hb-sh"); sh.append(document.createTextNode("Active now "), h("span", "hb-n", String(act.length))); side.appendChild(sh);
    if (!act.length) side.appendChild(h("p", "hb-mut", S.eps.length ? "Nothing active. Everything logged so far is marked better." : "Nothing logged yet. Tap where it hurts on the figure, or use the button below."));
    act.forEach((e) => side.appendChild(episodeCard(e)));
    side.appendChild(btn("+ Log a new spot", "hb-btn pri big", () => startLog({ zones: [] })));
    const last = S.res.entries.length ? S.res.entries.reduce((m, x) => (x.date > m ? x.date : m), "") : "";
    side.appendChild(h("div", "hb-mut", (last ? "Last check-in: " + dateText(last) + ". " : "") + "Your log stays on this PC."));
    root.appendChild(side); host.appendChild(root);
    if (S.msg) { S.msg = ""; }
  }
  function epTitle(e) {
    const zs = e.zones.map((id) => ZONES[id]), base = zs[0].name;
    if (zs.length === 1) return L.zoneLabel(zs[0]);
    const sames = zs.every((z) => z.name === base);
    return sames ? base : zs.map(L.zoneLabel).join(" + ");
  }
  function epSides(e) { const zs = e.zones.map((id) => ZONES[id]); if (zs.length > 1 && zs.every((z) => z.name === zs[0].name)) return "your " + zs.map((z) => z.side.toUpperCase()).join(" + "); return ""; }
  function episodeCard(e) {
    const c = h("article", "hb-ep"), hd = h("div", "hb-eh");
    const t = btn(epTitle(e), "hb-eplink", () => { S.epId = e.id; S.screen = "detail"; paint(); focusHeading(); }); hd.appendChild(t);
    if (epSides(e)) hd.appendChild(h("span", "hb-sd2", epSides(e)));
    const p = pill(e.severity); hd.appendChild(p); c.appendChild(hd);
    const last = e.entries[e.entries.length - 1], bits = ["Day " + L.dayNumber(e.start, today()), "started " + dateText(e.start)];
    const ty = listText(e.union("type"), "types").toLowerCase(); if (ty) bits.push(ty);
    const sp = e.union("spread").filter((k) => k !== "stays_here"); if (sp.length) bits.push("spreads: " + listText(sp, "spread").toLowerCase());
    c.appendChild(h("div", "hb-em", bits.join(" · ")));
    const w = listText(last.worseWith, "worseWith"), b = listText(last.betterWith, "betterWith");
    if (w || b) c.appendChild(h("div", "hb-em", (w ? "Worse with: " + w.toLowerCase() : "") + (w && b ? " · " : "") + (b ? "Better with: " + b.toLowerCase() : "")));
    if (e.flagged) c.appendChild(h("div", "hb-em hb-flag", "⚠ Safety flag on file"));
    const ea = h("div", "hb-ea");
    ea.appendChild(btn("Update today", "hb-btn", () => startLog({ episode: e, date: today() })));
    ea.appendChild(btn("Mark as better", "hb-btn", (ev) => openBetter(e, ev.currentTarget)));
    c.appendChild(ea); return c;
  }

  // ------------------------------------------------------------------ log (3 steps)
  function newId(zone, date) { return "e" + date.replace(/-/g, "") + "_" + zone.replace(/[^a-z0-9]/g, "").slice(0, 20) + "_" + Math.random().toString(36).slice(2, 8); }
  function startLog(o) {
    const d = { step: 1, zones: (o.zones || []).slice(0, 2), view: "back", severity: 0, startChoice: "today", startDate: today(), type: [], trigger: [], spread: [], spreadOther: "", worseWith: [], betterWith: [], note: "", safety: {}, addSecond: false, flagged: false, episode: null, date: o.date || today(), fixed: false, view2: null };
    if (o.episode) {
      const e = o.episode, ent = e.entries.filter((x) => x.date === e.lastDate), last = ent[0];
      Object.assign(d, { zones: e.zones.slice(), episode: e.id, fixed: true, startDate: e.start, startChoice: "pick", severity: 0, type: e.union("type"), trigger: last.trigger.slice(), spread: last.spread.slice(), spreadOther: last.spreadOther || "", worseWith: last.worseWith.slice(), betterWith: last.betterWith.slice(), note: "", date: o.date || today() });
      const same = e.entries.filter((x) => x.date === d.date); if (same.length) { d.severity = Math.max.apply(null, same.map((x) => x.severity)); d.note = same[0].note || ""; }
    }
    if (d.zones.length) d.view = ZONES[d.zones[0]].view;
    S.draft = d; S.screen = "log"; paint(); focusHeading();
  }
  function needSafety(d) { return d.zones.some(L.safetyRequired); }
  function logScreen(host) {
    const d = S.draft, root = h("div", "hb-two hb-logwrap");
    const figs = h("div", "hb-figcol hb-logfig");
    const set = new Set(d.zones);
    const onZone = (id) => {
      if (d.fixed) return;
      if (d.addSecond && d.zones.length === 1 && d.zones[0] !== id) { d.zones.push(id); d.addSecond = false; }
      else if (d.zones.indexOf(id) >= 0 && d.zones.length === 2) d.zones.splice(d.zones.indexOf(id), 1);
      else if (d.zones.length === 2) d.zones = [id]; else d.zones = [id];
      d.view = ZONES[id].view; d.step = 1; paint(); focusHeading();
    };
    const vt = h("div", "hb-seg-row"); vt.setAttribute("role", "group"); vt.setAttribute("aria-label", "Which side of the body to show");
    ["back", "front"].forEach((v) => vt.appendChild(btn(D.views[v].label.charAt(0) + D.views[v].label.slice(1).toLowerCase() + " view", "hb-seg" + (d.view === v ? " on" : ""), () => { d.view = v; paint(); const f = S.host.querySelector(".hb-seg.on"); if (f) f.focus(); }, { "aria-pressed": d.view === v ? "true" : "false" })));
    if (!d.fixed) figs.appendChild(vt);
    figs.appendChild(figure(d.view, { sel: set, onZone }));
    root.appendChild(figs);
    const form = h("form", "hb-form"); form.addEventListener("submit", (e) => e.preventDefault());
    const steps = ["Where & how bad", "What it’s like", "Safety check"];
    const crumb = h("div", "hb-crumb"); crumb.appendChild(document.createTextNode("Step " + d.step + " of 3 · ")); steps.forEach((s, i) => { crumb.appendChild(i + 1 === d.step ? h("b", "", s) : document.createTextNode(s)); if (i < 2) crumb.appendChild(document.createTextNode(" → ")); });
    form.appendChild(crumb);
    const hd = h("h3", "hb-h3", d.episode ? "Update: " + (S.eps.find((x) => x.id === d.episode) ? epTitle(S.eps.find((x) => x.id === d.episode)) : "spot") : steps[d.step - 1]); hd.setAttribute("data-hb-focus", "1"); form.appendChild(hd);
    if (d.step === 1) step1(form, d); else if (d.step === 2) step2(form, d); else step3(form, d);
    root.appendChild(form); host.appendChild(root);
  }
  function spotRow(d) {
    const w = h("div", "hb-fld"); w.appendChild(h("div", "hb-lb", "Spot"));
    if (!d.zones.length) { w.appendChild(h("div", "hb-spot hb-needs", "Tap a spot on the figure or pick from the list.")); w.appendChild(zoneListToggle(d)); return w; }
    d.zones.forEach((id) => { const z = ZONES[id], r = h("div", "hb-spot"); const b = h("b", "", z.side === "centre" ? z.name : z.name + " — " + L.sideWord(z.side)); r.append(b, document.createTextNode(" (" + z.view + " view) ")); if (!d.fixed && d.zones.length > 1) r.appendChild(btn("Remove", "hb-link", () => { d.zones = d.zones.filter((x) => x !== id); paint(); focusHeading(); }, { "data-hbkey": "rm:" + id })); w.appendChild(r); });
    if (!d.fixed) { const m = h("div", "hb-mut"); m.appendChild(document.createTextNode("Wrong spot? Tap another one on the figure, or ")); if (d.zones.length < 2) m.appendChild(btn(d.addSecond ? "tap the second spot now" : "add a second spot", "hb-link", () => { d.addSecond = true; paint(); focusHeading(); })); else m.appendChild(document.createTextNode("(two spots chosen)")); m.appendChild(document.createTextNode(" (e.g. the other side).")); w.appendChild(m); w.appendChild(zoneListToggle(d)); }
    return w;
  }
  function zoneListToggle(d) {
    const box = h("div", "hb-ztog"); const open = !!d.listOpen;
    box.appendChild(btn(open ? "Hide the list" : "Choose from a list", "hb-link", () => { d.listOpen = !open; paint(); }, { "data-hbkey": "logzlist" }));
    if (open) box.appendChild(zoneList((id) => { if (d.addSecond && d.zones.length === 1 && d.zones[0] !== id) { d.zones.push(id); d.addSecond = false; } else d.zones = [id]; d.view = ZONES[id].view; paint(); focusHeading(); }, new Set(d.zones)));
    return box;
  }
  function radioGroup(name, labelText, options, value, onChange, cls) {
    const fs = h("fieldset", "hb-fs " + (cls || "")); const lg = h("legend", "hb-lb", labelText); fs.appendChild(lg);
    const row = h("div", "hb-radios"); row.setAttribute("role", "radiogroup"); row.setAttribute("aria-label", labelText);
    options.forEach(([k, lbl, sub]) => {
      const l = h("label", "hb-rad" + (String(value) === String(k) ? " on" : "")); const i = h("input"); i.type = "radio"; i.name = name; i.value = String(k); i.checked = String(value) === String(k);
      i.addEventListener("change", () => { row.querySelectorAll(".hb-rad").forEach((x) => x.classList.remove("on")); l.classList.add("on"); onChange(k); });
      const t = h("span", "hb-radt"); if (sub != null) t.appendChild(h("b", "", String(sub))); t.appendChild(h("span", "", lbl)); l.append(i, t); row.appendChild(l);
    });
    fs.appendChild(row); return fs;
  }
  function chips(labelText, list, sel, onToggle, hint) {
    const w = h("div", "hb-fld"); const lb = h("div", "hb-lb", labelText); if (hint) lb.appendChild(h("span", "hb-mut", " " + hint)); w.appendChild(lb);
    const row = h("div", "hb-chips"); row.setAttribute("role", "group"); row.setAttribute("aria-label", labelText);
    list.forEach(([k, lbl]) => {
      const on = sel.indexOf(k) >= 0, b = h("button", "hb-chip" + (on ? " on" : ""), (on ? "✓ " : "") + lbl); b.type = "button"; b.setAttribute("aria-pressed", on ? "true" : "false");
      b.addEventListener("click", () => { const i = sel.indexOf(k); if (i >= 0) sel.splice(i, 1); else sel.push(k); const now = sel.indexOf(k) >= 0; b.classList.toggle("on", now); b.setAttribute("aria-pressed", now ? "true" : "false"); b.textContent = (now ? "✓ " : "") + lbl; if (onToggle) onToggle(); });
      row.appendChild(b);
    });
    w.appendChild(row); return w;
  }
  function step1(form, d) {
    form.appendChild(spotRow(d));
    form.appendChild(radioGroup("hb-sev", "How strong is it right now?", D.severity.map(([n, w]) => [n, w, n]), d.severity, (v) => { d.severity = Number(v); updNav(); }, "hb-seg5"));
    if (!d.fixed) {
      const dt = h("div", "hb-fld");
      dt.appendChild(radioGroup("hb-start", "When did it start?", [["today", "Today"], ["yesterday", "Yesterday"], ["pick", "Pick a date"]], d.startChoice, (v) => { d.startChoice = v; if (v === "today") d.startDate = today(); else if (v === "yesterday") d.startDate = L.addDays(today(), -1); inp.hidden = v !== "pick"; shown.textContent = dateText(d.startDate, true); }, "hb-seg"));
      const inp = h("input", "hb-input"); inp.type = "date"; inp.max = today(); inp.min = "2000-01-01"; inp.value = d.startDate; inp.hidden = d.startChoice !== "pick"; inp.setAttribute("aria-label", "Start date");
      const shown = h("span", "hb-mut", dateText(d.startDate, true));
      inp.addEventListener("change", () => { if (L.validDate(inp.value) && inp.value <= today()) { d.startDate = inp.value; shown.textContent = dateText(d.startDate, true); } });
      dt.append(inp, shown); form.appendChild(dt);
      form.appendChild(chips("What does it feel like?", D.types, d.type, null, "(pick any)"));
      form.appendChild(chips("What set it off?", D.triggers, d.trigger, null, "(pick any)"));
    } else { form.appendChild(h("div", "hb-mut", "Started " + dateText(d.startDate, true) + ". Entry for " + dateText(d.date, true) + ".")); }
    const nav = h("div", "hb-navrow"); nav.setAttribute("data-nav", "1");
    nav.appendChild(btn("Back", "hb-btn", () => { S.draft = null; S.screen = d.episode ? "home" : "home"; paint(); }));
    form.appendChild(nav); updNav();
    function updNav() { const old = form.querySelector("[data-next]"); if (old) old.remove(); const ok = d.zones.length && d.severity >= 1; const nx = btn("Next: more detail →", "hb-btn pri", () => { if (!ok) return; d.step = 2; paint(); focusHeading(); }); nx.setAttribute("data-next", "1"); nx.disabled = !ok; if (!ok) nx.title = "Choose a spot and how strong it is first."; const sp = nav.querySelector(".hb-sp") || nav.appendChild(h("span", "hb-sp")); nav.appendChild(nx); }
  }
  function step2(form, d) {
    form.appendChild(chips("Does it spread anywhere?", D.spread, d.spread, null));
    const oth = h("label", "hb-fld"); oth.appendChild(h("span", "hb-lb", "Other spread (type it)")); const oi = h("input", "hb-input"); oi.type = "text"; oi.maxLength = D.limits.spreadOther; oi.value = d.spreadOther; oi.addEventListener("input", () => { d.spreadOther = oi.value; }); oth.appendChild(oi); form.appendChild(oth);
    form.appendChild(chips("Makes it worse", D.worseWith, d.worseWith, null));
    form.appendChild(chips("Makes it better", D.betterWith, d.betterWith, null));
    const nt = h("label", "hb-fld"); nt.appendChild(h("span", "hb-lb", "Note (optional)")); const ta = h("textarea", "hb-input"); ta.rows = 3; ta.maxLength = D.limits.note; ta.value = d.note; ta.addEventListener("input", () => { d.note = ta.value; }); nt.appendChild(ta); form.appendChild(nt);
    const nav = h("div", "hb-navrow"); nav.appendChild(btn("← Back", "hb-btn", () => { d.step = 1; paint(); focusHeading(); })); nav.appendChild(h("span", "hb-sp"));
    nav.appendChild(btn("Next: safety check →", "hb-btn pri", () => { d.step = 3; paint(); focusHeading(); })); form.appendChild(nav);
  }
  function step3(form, d) {
    const need = needSafety(d), SF = D.safety, alertBox = h("div", "hb-alertslot"); alertBox.setAttribute("role", "alert");
    if (need) {
      form.appendChild(h("p", "hb-mut", SF.heading));
      SF.questions.forEach((q, i) => {
        const fs = h("fieldset", "hb-q"), lg = h("legend", ""); lg.appendChild(document.createTextNode((i + 1) + ". ")); boldify(lg, q.text, q.bold); fs.appendChild(lg);
        const row = h("div", "hb-radios hb-yn"); row.setAttribute("role", "radiogroup"); row.setAttribute("aria-label", q.text);
        SF.answers.forEach(([k, lbl]) => { const l = h("label", "hb-rad" + (d.safety[q.key] === k ? " on" : "")), inp = h("input"); inp.type = "radio"; inp.name = "hb-q-" + q.key; inp.value = k; inp.checked = d.safety[q.key] === k; inp.addEventListener("change", () => { d.safety[q.key] = k; row.querySelectorAll(".hb-rad").forEach((x) => x.classList.remove("on")); l.classList.add("on"); drawAlert(); }); l.append(inp, h("span", "hb-radt", lbl)); row.appendChild(l); });
        fs.appendChild(row); form.appendChild(fs);
      });
    } else form.appendChild(h("p", "hb-mut", SF.notAsked));
    form.appendChild(alertBox);
    const nav = h("div", "hb-navrow"); nav.appendChild(btn("← Back", "hb-btn", () => { d.step = 2; paint(); focusHeading(); })); nav.appendChild(h("span", "hb-sp"));
    const actions = h("span", "hb-actions"); nav.appendChild(actions); form.appendChild(nav);
    const foot = h("div", "hb-mut"); form.appendChild(foot);
    function drawAlert() {
      alertBox.textContent = ""; actions.textContent = ""; foot.textContent = "";
      const ev = L.evaluateSafety(d.safety);
      if (need && ev.flag) {
        const a = h("div", "hb-alert"); a.appendChild(h("div", "hb-at", "⚠ " + SF.alertTitle));
        ev.reasons.forEach((r) => { const q = SF.questions.find((x) => x.key === r.key); a.appendChild(h("p", "", r.answer === "yes" ? "You answered Yes to " + q.yesAlert + "." : SF.alertNotSure)); });
        a.appendChild(h("p", "", SF.alertBody));
        alertBox.appendChild(a);
        actions.appendChild(btn(SF.saveAnyway, "hb-btn", () => doSave(false)));
        actions.appendChild(btn(SF.onMyWay, "hb-btn pri", () => doSave(true)));
        foot.textContent = SF.savedFootnote;
      } else {
        if (need && ev.complete) { const k = h("div", "hb-okb"); k.appendChild(h("strong", "", SF.okTitle)); k.appendChild(document.createTextNode(" " + SF.okBody)); alertBox.appendChild(k); }
        const sv2 = btn("Save entry", "hb-btn pri", () => doSave(false)); if (need && !ev.complete) { sv2.disabled = true; sv2.title = "Answer the three questions first."; }
        actions.appendChild(sv2);
      }
    }
    drawAlert();
  }
  function doSave(onMyWay) {
    if (S.saving) return Promise.resolve({ ok: false, busy: true });
    const d = S.draft, at = today(), entries = [];
    if (!d.ids) d.ids = {};
    const ep = d.episode ? S.eps.find((x) => x.id === d.episode) : null, epId = d.episode || (d.newEp || (d.newEp = newId(d.zones[0], at)));
    const ev = L.evaluateSafety(d.safety), need = needSafety(d);
    for (const id of d.zones) {
      const z = ZONES[id], existing = S.res.entries.find((x) => x.zone === id && x.date === d.date && x.episode === epId);
      const e = { id: existing ? existing.id : (d.ids[id] || (d.ids[id] = newId(id, d.date))), episode: epId, zone: id, side: z.side, date: d.date, startDate: d.startDate, severity: d.severity, type: d.type, trigger: d.trigger, spread: d.spread, spreadOther: d.spreadOther, worseWith: d.worseWith, betterWith: d.betterWith, note: d.note };
      if (need) e.safety = Object.assign({}, d.safety);
      if (existing && existing.betterDate) { e.betterDate = existing.betterDate; e.movingNormally = existing.movingNormally; }
      entries.push(e);
    }
    S.saving = true; Array.from(S.host.querySelectorAll(".hb-actions button")).forEach((b) => { b.disabled = true; });
    return save(entries, onMyWay ? D.safety.onMyWayDone : (ev.flag && need ? "Saved with a safety flag." : "Saved.")).then((r) => { S.saving = false; if (r && r.stale) return; if (!r || !r.ok) { if (S.host) Array.from(S.host.querySelectorAll(".hb-actions button")).forEach((b) => { b.disabled = false; }); return; } if (r && r.ok) { S.draft = null; S.screen = ep ? "detail" : "home"; if (!ep) S.epId = null; else S.epId = ep.id; if (S.screen === "detail" && !S.eps.find((x) => x.id === S.epId)) S.screen = "home"; paint(); focusHeading(); } });
  }

  // ------------------------------------------------------------------ episode detail
  function kv(parent, k, v) { parent.appendChild(h("span", "", k)); parent.appendChild(h("div", "", v)); }
  function detailScreen(host) {
    const e = S.eps.find((x) => x.id === S.epId); if (!e) { S.screen = "home"; return paint(); }
    const root = h("div", "hb-two"), figs = h("div", "hb-figcol hb-logfig"), views = []; e.zones.forEach((z) => { if (views.indexOf(ZONES[z].view) < 0) views.push(ZONES[z].view); });
    views.forEach((v) => figs.appendChild(figure(v, { sel: new Set(e.zones) })));
    root.appendChild(figs);
    const side = h("div", "hb-side-col");
    side.appendChild(btn("← All spots", "hb-link", () => { S.screen = "home"; paint(); focusHeading(); }));
    const t = h("h3", "hb-h3", epTitle(e) + (epSides(e) ? " (" + epSides(e) + ")" : "")); t.setAttribute("data-hb-focus", "1"); side.appendChild(t);
    const g = h("div", "hb-kv"), last = e.entries[e.entries.length - 1];
    kv(g, "Started", dateText(e.start, true));
    kv(g, e.better ? "Better" : "Now", e.better ? dateText(e.better, true) + " · " + e.daysToNormal + (e.daysToNormal === 1 ? " day" : " days") + " to normal" + (e.movingNormally === "mostly" ? " (mostly)" : "") : "Day " + L.dayNumber(e.start, today()) + " · " + sevText(e.severity));
    const ty = listText(e.union("type"), "types"); kv(g, "Type", ty || "Not set");
    const tr = listText(e.union("trigger"), "triggers"); kv(g, "Trigger", tr || "Not set");
    const sp = listText(e.union("spread"), "spread") + (last.spreadOther ? (e.union("spread").length ? ", " : "") + last.spreadOther : ""); kv(g, "Spreads to", sp || "Not set");
    kv(g, "Worse / better", (listText(e.union("worseWith"), "worseWith") || "–") + " / " + (listText(e.union("betterWith"), "betterWith") || "–"));
    const flags = e.entries.filter((x) => x.safety_flag); kv(g, "Safety flags", flags.length ? "⚠ Yes, on " + flags.map((x) => dateText(x.date)).filter((v, i, a) => a.indexOf(v) === i).join(", ") : "None (" + (e.entries.some((x) => x.safety) ? "last asked " + dateText(e.entries.filter((x) => x.safety).pop().date) : "not asked for this spot") + ")");
    side.appendChild(g);
    side.appendChild(chart(e));
    const tb = h("table", "hb-tl"); const cap = h("caption", "hb-sr", "Strength by day, same data as the chart"); tb.appendChild(cap);
    const hr = h("tr"); ["Date", "Strength", "Note"].forEach((c) => hr.appendChild(h("th", "", c))); const th = h("thead"); th.appendChild(hr); tb.appendChild(th);
    const tbd = h("tbody"); e.days.forEach((day) => { const on = e.entries.filter((x) => x.date === day); const tr2 = h("tr"); tr2.appendChild(h("td", "", dateText(day))); const sevs = Math.max.apply(null, on.map((x) => x.severity)); tr2.appendChild(h("td", "hb-num", sevText(sevs))); tr2.appendChild(h("td", "", on.map((x) => x.note).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" / "))); tbd.appendChild(tr2); }); tb.appendChild(tbd); side.appendChild(tb);
    const ea = h("div", "hb-ea");
    if (e.active) { ea.appendChild(btn("Update today", "hb-btn pri", () => startLog({ episode: e, date: today() }))); ea.appendChild(btn("Mark as better…", "hb-btn", (ev) => openBetter(e, ev.currentTarget))); }
    ea.appendChild(btn("Edit last entry", "hb-btn", () => startLog({ episode: e, date: e.lastDate })));
    side.appendChild(ea);
    if (S.screen === "detail" && S.better) side.appendChild(betterPanel());
    root.appendChild(side); host.appendChild(root);
  }
  function chart(e) {
    const days = e.days, W = 340, H = 150, px = 36, py = 18, w = W - px - 26, hh = H - py - 28, n = days.length;
    const svg = sv("svg", { "class": "hb-mini", viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Strength by day, 1 to 5. " + days.map((d0) => dateText(d0) + " " + Math.max.apply(null, e.entries.filter((x) => x.date === d0).map((x) => x.severity))).join("; ") });
    for (let v = 1; v <= 5; v++) { const y = py + hh - ((v - 1) / 4) * hh; svg.appendChild(sv("line", { x1: String(px), x2: String(px + w), y1: String(y), y2: String(y), "class": "hb-gr" })); svg.appendChild(sv("text", { x: String(px - 6), y: String(y + 3), "text-anchor": "end", "class": "hb-tk" }, String(v))); }
    const pts = days.map((d0, i) => { const v = Math.max.apply(null, e.entries.filter((x) => x.date === d0).map((x) => x.severity)); return [n === 1 ? px + w / 2 : px + (i / (n - 1)) * w, py + hh - ((v - 1) / 4) * hh, v, d0]; });
    if (pts.length > 1) svg.appendChild(sv("polyline", { points: pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" "), "class": "hb-ln" }));
    pts.forEach((p, i) => { svg.appendChild(sv("circle", { cx: String(p[0]), cy: String(p[1]), r: "5", "class": "hb-pt" })); svg.appendChild(sv("text", { x: String(p[0]), y: String(p[1] - 9), "class": "hb-pl" }, String(p[2]))); if (n <= 8 || i % Math.ceil(n / 8) === 0) svg.appendChild(sv("text", { x: String(p[0]), y: String(H - 8), "text-anchor": "middle", "class": "hb-tk" }, dateText(p[3]).slice(4))); });
    return svg;
  }

  // ------------------------------------------------------------------ mark as better
  function openBetter(e, trigger) { S.better = { epId: e.id, choice: "today", date: today(), normal: "yes", trigger }; if (S.screen === "detail") { paint(); } else { S.screen = "better"; paint(); } const dlg = S.host.querySelector(".hb-dialog"); if (dlg) { const f = dlg.querySelector("input:checked") || dlg.querySelector("input,button"); if (f) f.focus(); } }
  function closeBetter() { const t = S.better && S.better.trigger; S.better = null; if (S.screen === "better") S.screen = "home"; paint(); if (t && t.isConnected) t.focus(); else if (S.host) { const f = S.host.querySelector(".hb-ea .hb-btn"); if (f) f.focus(); } }
  function betterDialog(host) { host.appendChild(betterPanel(true)); }
  function betterPanel() {
    const B = S.better, e = S.eps.find((x) => x.id === B.epId); const dlg = h("div", "hb-dialog"); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "false"); dlg.setAttribute("aria-labelledby", "hb-bt");
    dlg.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeBetter(); } });
    const t = h("h3", "hb-h3", "Mark “" + epTitle(e) + "” as better"); t.id = "hb-bt"; dlg.appendChild(t);
    const calc = h("div", "hb-calc"); calc.setAttribute("aria-live", "polite");
    const inp = h("input", "hb-input"); inp.type = "date"; inp.min = e.start; inp.max = today(); inp.value = B.date; inp.hidden = B.choice !== "pick"; inp.setAttribute("aria-label", "Date it felt better");
    const redo = () => { calc.textContent = ""; if (B.normal === "not_yet") { calc.textContent = "Not counted as better yet. Keep updating it, and mark it better when you are moving normally."; return; } const n = L.daysToNormal(e.start, B.date); if (n == null) { calc.textContent = "That date is before it started."; return; } const prev = L.previousDays(S.eps, e); calc.append(h("b", "", "Calculated for you: "), document.createTextNode("Started " + dateText(e.start) + " → normal on " + dateText(B.date) + " = " + n + (n === 1 ? " day" : " days") + (prev != null ? " (your last episode: " + prev + (prev === 1 ? " day)" : " days)") : ""))); };
    dlg.appendChild(radioGroup("hb-bd", "When did it feel better?", [["today", "Today"], ["yesterday", "Yesterday"], ["pick", "Pick a date"]], B.choice, (v) => { B.choice = v; if (v === "today") B.date = today(); else if (v === "yesterday") B.date = L.addDays(today(), -1); inp.hidden = v !== "pick"; inp.value = B.date; redo(); }, "hb-seg"));
    inp.addEventListener("change", () => { if (L.validDate(inp.value) && inp.value <= today()) { B.date = inp.value; redo(); } }); dlg.appendChild(inp);
    dlg.appendChild(radioGroup("hb-nm", "Moving normally again?", D.normal, B.normal, (v) => { B.normal = v; redo(); }, "hb-seg"));
    redo(); dlg.appendChild(calc);
    const row = h("div", "hb-navrow"); row.appendChild(btn("Cancel", "hb-btn", closeBetter)); row.appendChild(h("span", "hb-sp"));
    row.appendChild(btn("Save", "hb-btn pri", () => {
      if (B.normal === "not_yet") { S.ui.say("Not marked as better yet."); return closeBetter(); }
      if (L.daysToNormal(e.start, B.date) == null || B.date > today()) { S.ui.say("Pick a date after it started, not in the future."); return; }
      const out = []; e.zones.forEach((z) => { const latest = e.entries.filter((x) => x.zone === z).pop(); if (latest) out.push(Object.assign({}, latest, { startDate: e.start, betterDate: B.date, movingNormally: B.normal })); });
      save(out, "Marked as better.").then((r) => { if (r && r.ok) { S.better = null; S.screen = "detail"; S.epId = e.id; paint(); focusHeading(); } });
    })); dlg.appendChild(row); return dlg;
  }

  // ------------------------------------------------------------------ history
  function historyScreen(host) {
    const H = S.hist, by = L.historyByZone(S.res.entries, H.days, today()), level = {}, badge = {}, count = {};
    Object.keys(by).forEach((id) => { const lv = L.heatFor(by[id], H.metric); if (lv) level[id] = lv; badge[id] = H.metric === "strongest" ? by[id].max : by[id].count; count[id] = by[id].count; });
    if (S.res.skipped > 0) { const sk = h("div", "hb-mut hb-skip", "⚠ " + S.res.skipped + (S.res.skipped === 1 ? " line" : " lines") + " in the pain log could not be read and " + (S.res.skipped === 1 ? "is" : "are") + " left out of these numbers."); host.appendChild(sk); }
    const ctl = h("div", "hb-ctl");
    const r = h("div", "hb-seg-row"); r.setAttribute("role", "group"); r.setAttribute("aria-label", "Period"); D.ranges.forEach(([d0, lbl]) => r.appendChild(btn(lbl, "hb-seg" + (H.days === d0 ? " on" : ""), () => { H.days = d0; paint(); }, { "aria-pressed": H.days === d0 ? "true" : "false" })));
    const m = h("div", "hb-seg-row"); m.setAttribute("role", "group"); m.setAttribute("aria-label", "Show"); [["entries", "Entries"], ["strongest", "Strongest"]].forEach(([k, lbl]) => m.appendChild(btn(lbl, "hb-seg" + (H.metric === k ? " on" : ""), () => { H.metric = k; paint(); }, { "aria-pressed": H.metric === k ? "true" : "false" })));
    ctl.append(r, m); host.appendChild(ctl);
    const root = h("div", "hb-two"), figs = h("div", "hb-figcol"), row = h("div", "hb-figs");
    const sel = new Set(H.zone ? [H.zone] : []); const onZone = (id) => { H.zone = H.zone === id ? null : id; paint(); };
    ["front", "back"].forEach((v) => row.appendChild(figure(v, { level, badge, count, sel, onZone }))); figs.appendChild(row);
    const leg = h("div", "hb-leg"); leg.appendChild(h("span", "", H.metric === "strongest" ? "Strongest strength:" : "Entries:")); D.heatLegend[H.metric].forEach((t, i) => { const s = h("span", "hb-lg"); s.append(h("i", "hb-sw h" + (i + 1)), document.createTextNode(t)); leg.appendChild(s); }); leg.appendChild(h("span", "hb-mut", "Number in the spot = " + (H.metric === "strongest" ? "strongest strength" : "entries") + " in the period. Darker + hatched = more."));
    figs.appendChild(leg); root.appendChild(figs);
    const side = h("div", "hb-side-col"); const rk = L.rankZones(by, H.metric);
    side.appendChild(h("h3", "hb-sh", "Spots, most to least"));
    if (!rk.length) side.appendChild(h("p", "hb-mut", "No entries in this period."));
    const ul = h("ul", "hb-rank"); rk.forEach((x) => { const li = h("li"); const b = btn("", "hb-rankbtn" + (H.zone === x.id ? " on" : ""), () => { H.zone = H.zone === x.id ? null : x.id; paint(); }, { "aria-pressed": H.zone === x.id ? "true" : "false" }); b.append(h("span", "hb-rname", L.zoneLabel(x.z) + " · " + x.z.view), h("span", "hb-rnum", String(H.metric === "strongest" ? x.rec.max : x.rec.count)), h("span", "hb-rbar", "")); b.lastChild.style.width = Math.min(100, (H.metric === "strongest" ? x.rec.max * 20 : Math.min(x.rec.count, 10) * 10)) + "%"; li.appendChild(b); ul.appendChild(li); }); side.appendChild(ul);
    if (H.zone) {
      const z = ZONES[H.zone], box = h("section", "hb-zdet"); box.appendChild(h("h4", "", L.zoneLabel(z) + " · entries and episodes"));
      const eps = S.eps.filter((e) => e.zones.indexOf(H.zone) >= 0);
      if (!eps.length) box.appendChild(h("p", "hb-mut", "Nothing logged for this spot."));
      eps.forEach((e) => { const b = btn("", "hb-epline", () => { S.epId = e.id; S.screen = "detail"; paint(); focusHeading(); }); b.textContent = dateText(e.start, true) + " → " + (e.better ? dateText(e.better) + " (" + e.daysToNormal + (e.daysToNormal === 1 ? " day" : " days") + ")" : "still active") + " · strongest " + Math.max.apply(null, e.entries.filter((x) => x.zone === H.zone).map((x) => x.severity)); box.appendChild(b); });
      side.appendChild(box);
    } else side.appendChild(h("div", "hb-hint", "Tap a spot on the figure or a row to see its entries and episodes."));
    root.appendChild(side); host.appendChild(root);
  }

  // ------------------------------------------------------------------ public
  function render(tab, body, UI) {
    S.ui = UI;
    if (!S.host || S.host.parentNode !== body) { S.host = h("div", "hb"); }
    body.appendChild(S.host);
    if (!S.res && !S.loading) reload();
    paint();
  }
  function clear() { S.res = null; S.eps = []; S.draft = null; S.better = null; S.screen = "home"; S.host = null; S.hist = { days: 30, metric: "entries", zone: null }; S.epId = null; S.listMode = false; S.gen++; S.saving = false; S.loading = false; }
  window.healthBody = { render, clear };
})();
