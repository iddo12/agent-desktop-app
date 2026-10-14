// My Health visual pane (v1.114.0). Loaded on first use of the "Visual" or "Periodic" page (health.js), not at startup.
// Draws ONE precomputed feed handed over by the main process (health-pane-feed): no paths, no files, no network, no timers.
// textContent only. LIGHT: CSS/SVG charts, no libraries. PRIVACY: nothing here logs or copies the feed; the eye button blanks every
// health number in the DOM (renderer-only). The pane does no medical logic: statuses come from the feed / pane-logic.js.
(function () {
  "use strict";
  const api = window.api && window.api.health, L = window.healthPaneLogic;
  if (!api || !L || !api.paneFeed) return;
  const NS = "http://www.w3.org/2000/svg";
  const DOTS = "•••";

  // ------------------------------------------------------------------ state
  const S = { res: null, ui: null, view: "overview", metric: null, range: "week", dayIdx: null, hidden: false, open: {}, loading: false, watching: false };

  // ------------------------------------------------------------------ tiny DOM helpers
  function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function sv(tag, attrs, text) { const e = document.createElementNS(NS, tag); if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); if (text != null) e.textContent = text; return e; }
  function btn(label, cls, onClick) { const b = h("button", cls || "hv-btn", label); b.type = "button"; b.addEventListener("click", (ev) => { ev.preventDefault(); onClick(ev); }); return b; }
  // Health numbers go through N(): with the eye button on, every digit run becomes ••• (dates and labels never pass through here).
  const N = (t) => (S.hidden ? String(t).replace(/\d[\d,.−]*/g, DOTS) : String(t));
  function nEl(tag, cls, text) { const e = h(tag, (cls || "") + " hv-num", N(text)); return e; }

  const ICONS = {
    sleep: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z", steps: "M13.5 4.2a1.6 1.6 0 1 0 .01 0M10 21l1.6-6L9 12.5l1.2-5.5 3.3 2.2 3 .8M11.6 15l3.2 2.2V21",
    heart: "M12 20.5s-8-5-8-10.700A4.600 4.600 0 0 1 12 7.200a4.600 4.600 0 0 1 8 2.600c0 5.700-8 10.700-8 10.700z", hrv: "M3 12h4l2.200-6 4 12 2.200-6H21",
    spo2: "M12 3s6 6.500 6 11a6 6 0 0 1-12 0c0-4.500 6-11 6-11z", skin: "M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z", breathing: "M9 4v9c0 3-2 6-5 6 0-5 1-11 3-13M15 4v9c0 3 2 6 5 6 0-5-1-11-3-13M12 4v8",
    flame: "M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z", scale: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 10a4 4 0 0 1 8 0",
    fat: "M12 3a9 9 0 1 0 .01 0zM8 12h8", clock: "M12 3a9 9 0 1 0 .01 0zM12 7v5l3 2", pin: "M12 21s-6-6-6-11a6 6 0 0 1 12 0c0 5-6 11-6 11zM12 8a2 2 0 1 0 .01 0",
    dumbbell: "M3 9v6M6 7v10M18 7v10M21 9v6M6 12h12", flask: "M9 3h6M10 3v6L4.500 19a1.500 1.500 0 0 0 1.300 2.200h12.400a1.500 1.500 0 0 0 1.300-2.200L14 9V3", brain: "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V4a3 3 0 0 0-3 0zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1",
    food: "M12 7c-3-2-8-1-8 5 0 5 3 9 5 9 1.500 0 2-1 3-1s1.500 1 3 1c2 0 5-4 5-9 0-6-5-7-8-5zM12 7c0-2 1-4 3-4", racket: "M9 3a6 6 0 1 0 .01 0zM13.500 13.500L20 20",
    bolt: "M13 3L5 14h6l-1 7 8-11h-6z", walk: "M13.500 4.200a1.600 1.600 0 1 0 .01 0M10 21l1.600-6L9 12.500l1.200-5.500 3.300 2.200 3 .8", couch: "M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3M3 12a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v5H3z",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 .01 0", eyeoff: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM4 4l16 16", refresh: "M20 11a8 8 0 1 0-2.300 5.700M20 4v7h-7", back: "M15 5l-7 7 7 7",
  };
  function icon(name, size) {
    const s = sv("svg", { viewBox: "0 0 24 24", width: size || 22, height: size || 22, fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "hv-icon" });
    s.appendChild(sv("path", { d: ICONS[name] || ICONS.clock })); return s;
  }
  function chipEl(c, extra) { const e = h("span", "hv-chip hv-" + c.cls + (extra ? " " + extra : "")); e.append(h("span", "hv-chip-g", c.glyph), h("span", "hv-chip-w", c.word)); return e; }

  // ------------------------------------------------------------------ data
  const feed = () => (S.res && S.res.state === "ok" ? S.res.feed : null);
  const SAFE_STAGE = { deep: 1, light: 1, rem: 1, awake: 1 };
  const stageCls = (x) => (SAFE_STAGE[x] ? x : "light");
  const grow = (m) => String(S.hidden ? 1 : Math.max(1, +m || 0));
  const nowMs = () => (S.res && S.res.now) || Date.now();
  const M = (k) => { const f = feed(); return f && f.metrics[k] ? f.metrics[k] : null; };
  const goals = () => (feed() ? feed().goals : L.GOALS);

  function load() {
    if (S.loading) return Promise.resolve();
    S.loading = true;
    return api.paneFeed().then((r) => { S.res = r && r.ok ? r : { state: "invalid", reason: "The health feed could not be read." }; })
      .catch(() => { S.res = { state: "invalid", reason: "The health feed could not be read." }; })
      .then(() => { S.loading = false; if (S.ui) S.ui.rerender(); });
  }
  function watch() {
    if (S.watching || !api.onPaneChanged) return;
    S.watching = true;
    api.onPaneChanged(() => { if (S.ui) load(); });          // the event carries no content; we simply ask again (only while the view is open)
  }
  function clear() { S.res = null; S.ui = null; S.view = "overview"; S.metric = null; S.dayIdx = null; S.open = {}; }

  // ------------------------------------------------------------------ pieces
  function ring(opts) {   // {diameter, stroke, frac, text, sub, color}
    const d = opts.diameter, st = opts.stroke, r = (d - st) / 2, c = 2 * Math.PI * r;
    const wrap = h("div", "hv-ring"); wrap.style.width = d + "px"; wrap.style.height = d + "px"; wrap.dataset.d = d; wrap.dataset.stroke = st;
    const s = sv("svg", { viewBox: "0 0 " + d + " " + d, width: d, height: d, "aria-hidden": "true" });
    s.append(sv("circle", { cx: d / 2, cy: d / 2, r, fill: "none", "stroke-width": st, class: "hv-ring-bg" }));
    const fg = sv("circle", { cx: d / 2, cy: d / 2, r, fill: "none", "stroke-width": st, "stroke-linecap": "round", class: "hv-ring-fg " + (opts.cls || ""), transform: "rotate(-90 " + d / 2 + " " + d / 2 + ")" });
    fg.setAttribute("stroke-dasharray", (c * (S.hidden ? 0 : opts.frac)).toFixed(1) + " " + c.toFixed(1)); s.appendChild(fg);
    const inner = h("div", "hv-ring-in");
    const fit = L.ringFit(opts.text, d, st, { maxFont: opts.maxFont || 52, labelPx: opts.sub ? 18 : 2 });
    const num = nEl("div", "hv-ring-num", opts.text); num.style.fontSize = fit.fontPx + "px";
    inner.appendChild(num); if (opts.sub) inner.appendChild(h("div", "hv-ring-sub", N(opts.sub)));
    wrap.append(s, inner); return wrap;
  }
  // Belt and braces after layout: the real text width must sit inside the ring's inner circle; shrink until it does.
  function fitRings(root) {
    root.querySelectorAll(".hv-ring").forEach((w) => {
      const num = w.querySelector(".hv-ring-num"), inner = w.querySelector(".hv-ring-in");
      if (!num || !inner) return;
      const d = +w.dataset.d, st = +w.dataset.stroke, R = (d - 2 * st) / 2 - 4;
      let fs = parseFloat(num.style.fontSize) || 40, guard = 60;
      const ok = () => { const bw = num.getBoundingClientRect().width, bh = inner.getBoundingClientRect().height; const half = R * R - (bh / 2) * (bh / 2); return half > 0 && bw <= 2 * Math.sqrt(half) - 2; };
      while (!ok() && fs > 11 && guard-- > 0) { fs -= 1; num.style.fontSize = fs + "px"; }
    });
  }

  function barChart(values, dates, opts) {   // 7 bars, values labelled at max/min/today, outlined today, optional goal line
    const o = opts || {}, b = L.bars(values, { zeroBased: o.zeroBased }), wrap = h("div", "hv-bars"), h100 = o.height || 64;
    wrap.style.height = h100 + 22 + 14 + "px";
    const top = Math.max.apply(null, b.map((x) => (x.v == null ? 0 : x.h)).concat([1]));
    b.forEach((x, i) => {
      const col = h("div", "hv-bar" + (x.today ? " today" : "") + (x.v == null ? " none" : ""));
      const lab = h("div", "hv-bar-v hv-num", x.label ? N(o.fmt ? o.fmt(x.v) : String(x.v)) : ""); col.appendChild(lab);
      const fill = h("div", "hv-bar-f"); fill.style.height = Math.round((S.hidden ? 55 : x.h) * h100 / 100) + "px"; if (x.v == null) fill.style.height = "3px"; col.appendChild(fill);
      col.appendChild(h("div", "hv-bar-d", o.labels ? o.labels[i] : L.wdShort(dates && dates[i]))); wrap.appendChild(col);
    });
    if (o.goal != null && !S.hidden) {
      const real = values.filter((v) => v != null), max = real.length ? Math.max.apply(null, real) : 1, g = Math.min(100, (o.goal / Math.max(max, o.goal)) * 100);
      const line = h("div", "hv-goalline"); line.style.bottom = (14 + Math.round(g * h100 / 100 * (max >= o.goal ? 1 : 1))) + "px"; line.title = "your goal"; wrap.appendChild(line);
    }
    return wrap;
  }

  function stateBanner() {
    const r = S.res;
    if (!r) return null;
    if (r.state === "ok") {
      const si = L.staleInfo(r.feed.generated_at, r.now);
      if (si.stale) { const b = h("div", "hv-banner warn"); b.append(h("span", "hv-banner-t", si.future ? "▲ The numbers file is dated in the future. Check the PC clock; do not trust the numbers below." : "▲ Last sync was " + si.text + (r.feed.day ? " (" + L.dayLabel(r.feed.day) + ")" : "") + ". Numbers below are from then."), btn("Check again", "hv-btn sm", () => { S.res = null; S.ui.rerender(); })); return b; }
      return null;
    }
    return null;
  }
  function emptyState(r) {
    const c = h("div", "hv-empty");
    const t = r.state === "missing" ? "No health data yet" : r.state === "newer" ? "This screen needs an update" : "The health numbers could not be read";
    const why = r.state === "missing" ? "The Health Agent writes one numbers file at 16:30 and 18:30 every day. As soon as it exists this screen fills in by itself. Nothing else is needed."
      : r.state === "newer" ? "The numbers file is newer than this version of Agent Desktop understands. Update Agent Desktop and it will show."
        : (r.reason || "Try again in a minute.");
    c.append(icon("heart", 34), h("div", "hv-empty-t", t), h("div", "hv-empty-p", why), btn("Check again", "hv-btn pri", () => { S.res = null; S.ui.rerender(); }));
    return c;
  }

  function legend(kind) {
    const l = h("div", "hv-legend"); l.setAttribute("aria-label", "How to read this screen");
    l.appendChild(h("b", "hv-legend-t", "HOW TO READ"));
    const it = (node, txt) => { const s = h("span", "hv-legend-i"); s.append(node, h("span", "", txt)); l.appendChild(s); };
    it(chipEl(L.chip("good")), "inside your normal"); it(chipEl(L.chip("watch")), "outside your normal"); it(chipEl(L.chip("alert")), "only if it needs action"); it(chipEl(L.chip("nodata"), "dashed"), "not synced");
    const bars = h("span", "hv-lg-bars"); bars.append(h("i"), h("i", "t")); it(bars, "bar height = value, outlined bar = today");
    const gl = h("span", "hv-lg-goal"); it(gl, "your goal");
    if (kind === "overview" || kind === "activity") { const rg = h("span", "hv-lg-ring"); it(rg, "ring = share of goal"); }
    if (kind === "day") { const nw = h("span", "hv-lg-now"); it(nw, "now"); const bd = h("span", "hv-lg-band"); it(bd, "your normal range"); }
    if (kind === "activity") { const dt = h("span", "hv-lg-dot"); it(dt, "one day (big = today)"); const ex = h("span", "hv-lg-dot dashed"); it(ex, "expected, not detected"); }
    if (kind === "periodic") { it(h("span", "hv-glyph", "▲▼="), "change since the last result"); it(h("span", "hv-glyph out", "◆"), "outside the range"); }
    return l;
  }

  // ------------------------------------------------------------------ the header row (views, date, sync, eye)
  function header() {
    const f = feed(), row = h("div", "hv-bar-head");
    const seg = h("div", "hv-seg"); seg.setAttribute("role", "tablist");
    [["overview", "Overview"], ["day", "Day story"], ["activity", "Activity level"]].forEach(([id, label]) => {
      const b = btn(label, "hv-seg-b" + (S.view === id || (S.view === "history" && id === "overview" && false) ? " on" : ""), () => { S.view = id; S.metric = null; S.ui.rerender(); });
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", S.view === id ? "true" : "false"); seg.appendChild(b);
    });
    row.appendChild(seg);
    if (f) row.appendChild(h("span", "hv-date", L.dayLabel(f.day) || ""));
    row.appendChild(h("span", "hv-grow"));
    if (S.res && S.res.sample) row.appendChild(h("span", "hv-chip hv-info hv-sample", "SAMPLE DATA"));
    if (f) { const sy = h("span", "hv-sync"); sy.append(icon("clock", 14), h("span", "", L.syncText(f.generated_at, nowMs()))); row.appendChild(sy); }
    const eye = btn("", "hv-iconbtn", () => { S.hidden = !S.hidden; S.ui.rerender(); });
    eye.append(icon(S.hidden ? "eyeoff" : "eye", 18)); eye.title = S.hidden ? "Show the numbers" : "Hide the numbers (for screen sharing)"; eye.setAttribute("aria-label", eye.title); eye.setAttribute("aria-pressed", S.hidden ? "true" : "false"); eye.dataset.role = "eye";
    row.appendChild(eye);
    const rf = btn("", "hv-iconbtn", () => { S.res = null; S.ui.rerender(); }); rf.append(icon("refresh", 18)); rf.title = "Read the numbers file again"; rf.setAttribute("aria-label", rf.title); row.appendChild(rf);
    return row;
  }

  // ------------------------------------------------------------------ overview (layout A)
  const TILES = [
    ["hrv", "HRV", "hrv", "ms", "hrv"], ["spo2", "Blood oxygen", "spo2", "%", "spo2"], ["skin_temp", "Skin temp", "skin", "°C", "skin_temp", "vs your usual"], ["breathing", "Breathing", "breathing", "per min", "breathing"], ["active_kcal", "Active calories", "flame", "kcal", "active_kcal"],
    ["weight", "Weight", "scale", "kg", "weight", null, "last reading"], ["body_fat", "Body fat", "fat", "%", "body_fat", null, "last reading"], ["active_min", "Active minutes", "clock", "min", "active_min"], ["distance_km", "Distance", "pin", "km", "distance_km"], ["exercise_min", "Exercise", "dumbbell", "min", "exercise_min"],
  ];
  const ctxOf = () => ({ now: nowMs(), day: feed() ? feed().day : null, goals: goals() });
  const openHistory = (key) => { S.view = "history"; S.metric = key; S.range = "week"; S.ui.rerender(); };

  function dataDays(k) { const f = feed(); return f ? f.dates_last7 : []; }
  function tile(def) {
    const [key, title, ic, unit, mk, sub, noun] = def, m = M(mk), c = L.statusOf(mk, m, ctxOf());
    const t = h("button", "hv-tile" + (m && m.now != null ? "" : " nodata")); t.type = "button";
    const hd = h("div", "hv-tile-h"); hd.append(icon(ic, 20), h("span", "hv-tile-t", title), chipEl(c)); t.appendChild(hd);
    if (m && m.now != null) {
      const dec = L.decOf(mk), big = h("div", "hv-bigrow"); big.append(nEl("span", "hv-big", L.fmtNum(m.now, dec)), h("span", "hv-unit", unit)); t.appendChild(big);
      const cmp = L.compare(mk, m.now, m.prev, noun || "yesterday"); t.appendChild(h("div", "hv-cmp " + (cmp.dir || ""), N((cmp.dir === "up" ? "▲ " : cmp.dir === "down" ? "▼ " : "") + (sub && !m.prev ? sub : cmp.text))));
      if (m.last7.length) t.appendChild(barChart(m.last7, dataDays(), { height: 46, fmt: (v) => L.fmtNum(v, dec) }));
      t.setAttribute("aria-label", title + " " + (S.hidden ? "hidden" : L.fmtNum(m.now, dec) + " " + unit) + ", " + c.word);
      t.addEventListener("click", () => openHistory(mk));
    } else {
      t.appendChild(h("div", "hv-dash", "–"));
      const usual = m && (m.normal[0] != null ? m.normal : m.baseline[0] != null ? m.baseline : null);
      t.appendChild(h("div", "hv-cmp none", m ? "not measured (" + (usual ? "usually " + N(L.fmtNum(usual[0], L.decOf(mk)) + "–" + L.fmtNum(usual[1], L.decOf(mk))) : "no usual yet") + ")" : "not in the feed yet"));
      t.setAttribute("aria-label", title + ", no data"); if (m) t.addEventListener("click", () => openHistory(mk));
    }
    return t;
  }

  function sleepHero() {
    const f = feed(), sl = f.sleep || {}, min = sl.min != null ? sl.min : (M("sleep_min") ? M("sleep_min").now : null), g = goals().sleep_min, ms = M("sleep_min");
    const c = L.statusOf("sleep_min", { now: min, prev: null, status: ms ? ms.status : "none" }, ctxOf());
    const t = h("button", "hv-tile hero sleep" + (min == null ? " nodata" : "")); t.type = "button";
    const hd = h("div", "hv-tile-h"); hd.append(icon("sleep", 22), h("span", "hv-tile-t", "Last night"), chipEl(c)); t.appendChild(hd);
    if (min == null) { t.append(h("div", "hv-dash", "–"), h("div", "hv-cmp none", "no sleep recorded last night")); return t; }
    const body = h("div", "hv-hero-body");
    body.appendChild(ring({ diameter: 160, stroke: 14, frac: L.goalPct(min, g).frac, text: L.fmtDur(min), sub: "of " + L.fmtDur(g).replace(" 00", "") + " goal".replace(" goal", " goal"), cls: "sleep" }));
    const right = h("div", "hv-hero-r");
    if (sl.score != null) {
      const sr = h("div", "hv-bigrow"); sr.append(nEl("span", "hv-big", String(sl.score)), h("span", "hv-unit", "sleep score"));
      if (sl.prev_score != null) { const d = sl.score - sl.prev_score; sr.appendChild(nEl("span", "hv-cmp " + (d > 0 ? "up" : d < 0 ? "down" : ""), (d > 0 ? "▲ +" : d < 0 ? "▼ −" : "= ") + Math.abs(d) + " vs yesterday (" + sl.prev_score + ")")); }
      right.appendChild(sr);
    }
    const stages = (sl.stages || []).filter((s) => s.min != null && s.min > 0);
    if (stages.length) {
      const tot = stages.reduce((a, s) => a + s.min, 0), bar = h("div", "hv-stack");
      stages.forEach((s) => { const seg = h("span", "hv-stage " + stageCls(s.stage)); seg.style.flexGrow = grow(s.min); seg.title = s.stage; bar.appendChild(seg); });
      right.appendChild(bar);
      const lg = h("div", "hv-stage-lg"); ["deep", "rem", "light", "awake"].forEach((k) => { const s = stages.find((x) => x.stage === k); if (!s) return; const i = h("span", "hv-stage-i"); i.append(h("i", "hv-stage " + stageCls(k)), nEl("span", "", (k === "rem" ? "REM" : k[0].toUpperCase() + k.slice(1)) + " " + L.fmtDurShort(s.min))); lg.appendChild(i); }); right.appendChild(lg);
    } else right.appendChild(h("div", "hv-cmp none", "no stage detail in the feed"));
    if (ms && ms.last7.length) { const seven = h("div", "hv-hero-bars"); seven.appendChild(barChart(ms.last7.map((v) => (v == null ? null : Math.round(v / 6) / 10)), f.dates_last7, { height: 50, fmt: (v) => v + " h" })); right.appendChild(seven); }
    body.appendChild(right); t.appendChild(body);
    t.setAttribute("aria-label", "Last night " + (S.hidden ? "hidden" : L.fmtDur(min)) + ", " + c.word);
    t.addEventListener("click", () => openHistory("sleep_min"));
    return t;
  }
  function stepsHero() {
    const f = feed(), m = M("steps"), g = goals().steps;
    const c = L.statusOf("steps", m, ctxOf());
    const t = h("button", "hv-tile hero steps" + (m && m.now != null ? "" : " nodata")); t.type = "button";
    const hd = h("div", "hv-tile-h"); const gd = new Date(f.generated_at), asof = isNaN(gd.getTime()) ? "" : "as of " + String(gd.getHours()).padStart(2, "0") + ":" + String(gd.getMinutes()).padStart(2, "0");
    hd.append(icon("steps", 22), h("span", "hv-tile-t", "Steps today"), h("span", "hv-asof", asof), chipEl(c)); t.appendChild(hd);
    if (!m || m.now == null) { t.append(h("div", "hv-dash", "–"), h("div", "hv-cmp none", "no steps counted yet")); return t; }
    t.appendChild(ring({ diameter: 160, stroke: 14, frac: L.goalPct(m.now, g).frac, text: L.fmtNum(m.now, 0), sub: "of " + L.fmtNum(g, 0), cls: "steps" }));
    const cmp = L.compare("steps", m.now, m.prev, "yesterday"); t.appendChild(h("div", "hv-cmp " + (cmp.dir || ""), N((cmp.dir === "up" ? "▲ " : cmp.dir === "down" ? "▼ " : "") + cmp.text)));
    const a = f.activity, hard = a && a.zone2_min != null ? (a.zone2_min || 0) + (a.zone3_min || 0) : null;
    if (hard != null) {
      const q = L.classifyActivity(m.now, hard, a.steps_median), es = h("div", "hv-effort");
      es.append(icon("bolt", 16), nEl("b", "", L.fmtNum(hard, 0) + " min hard"));
      if (q === "high-effort-low-steps") es.appendChild(h("span", "hv-badge", "High effort, low steps"));
      t.appendChild(es);
    }
    t.appendChild(barChart(m.last7, f.dates_last7, { height: 46, goal: g, fmt: (v) => L.fmtNum(v, 0) }));
    t.setAttribute("aria-label", "Steps today " + (S.hidden ? "hidden" : L.fmtNum(m.now, 0) + " of " + L.fmtNum(g, 0)) + ", " + c.word + ". Opens the activity level view.");
    t.addEventListener("click", () => { S.view = "activity"; S.ui.rerender(); });
    return t;
  }
  function heartHero() {
    const m = M("resting_hr"), c = L.statusOf("resting_hr", m, ctxOf()), f = feed();
    const t = h("button", "hv-tile hero heart" + (m && m.now != null ? "" : " nodata")); t.type = "button";
    const hd = h("div", "hv-tile-h"); hd.append(icon("heart", 22), h("span", "hv-tile-t", "Resting heart"), chipEl(c)); t.appendChild(hd);
    if (!m || m.now == null) { t.append(h("div", "hv-dash", "–"), h("div", "hv-cmp none", "not measured")); return t; }
    const big = h("div", "hv-bigrow"); big.append(nEl("span", "hv-big xl", L.fmtNum(m.now, 0)), h("span", "hv-unit", "bpm")); t.appendChild(big);
    const cmp = L.compare("resting_hr", m.now, m.prev, "yesterday"); t.appendChild(h("div", "hv-cmp " + (cmp.dir || ""), N((cmp.dir === "up" ? "▲ " : cmp.dir === "down" ? "▼ " : "") + cmp.text)));
    t.appendChild(barChart(m.last7, f.dates_last7, { height: 58, fmt: (v) => L.fmtNum(v, 0) }));
    const ah = M("avg_hr"); if (m.month || ah) { const mm = h("div", "hv-mm"); if (ah && ah.now != null) mm.appendChild(nEl("span", "", "avg " + L.fmtNum(ah.now, 0))); if (m.normal[0] != null) mm.appendChild(nEl("span", "", "your normal " + m.normal[0] + "–" + m.normal[1])); t.appendChild(mm); }
    t.setAttribute("aria-label", "Resting heart " + (S.hidden ? "hidden" : L.fmtNum(m.now, 0) + " bpm") + ", " + c.word);
    t.addEventListener("click", () => openHistory("resting_hr"));
    return t;
  }

  function renderOverview(root) {
    const f = feed(), top = h("div", "hv-grid hero"); top.append(sleepHero(), stepsHero(), heartHero()); root.appendChild(top);
    const rest = h("div", "hv-grid tiles"); TILES.forEach((d) => rest.appendChild(tile(d))); root.appendChild(rest);
    const p = h("div", "hv-periodic-link"); p.append(icon("flask", 18), h("span", "", "Blood tests, nutrition and cognitive tests are slower: they live under "), btn("Periodic", "hv-link", () => S.ui.go("periodic")));
    root.appendChild(p);
  }

  // ------------------------------------------------------------------ day story (layout C)
  const tmin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
  function renderDay(root) {
    const f = feed(), dates = f.dates_last7, sl = M("sleep_min"), st = M("steps"), strip = h("div", "hv-daystrip");
    const last = dates.length - 1, sel = S.dayIdx == null ? last : S.dayIdx;
    dates.forEach((d, i) => {
      const c = h("button", "hv-daycard" + (i === sel ? " on" : "")); c.type = "button";
      c.appendChild(h("div", "hv-daycard-d", L.dayLabel(d)));
      const sm = sl && sl.last7[i + sl.last7.length - dates.length], sp = st && st.last7[i + st.last7.length - dates.length];
      const r1 = h("div", "hv-daycard-r"); r1.append(icon("sleep", 14), nEl("span", "", sm == null ? "–" : L.fmtDur(sm))); const r2 = h("div", "hv-daycard-r"); r2.append(icon("steps", 14), nEl("span", "", sp == null ? "–" : L.fmtNum(sp, 0)));
      c.append(r1, r2);
      const ctx = Object.assign(ctxOf(), { day: d });
      c.appendChild(chipEl(sp == null ? L.chip("nodata") : L.statusOf("steps", { now: sp, prev: null, status: "ok" }, ctx)));
      c.addEventListener("click", () => { S.dayIdx = i; S.ui.rerender(); }); strip.appendChild(c);
    });
    root.appendChild(strip);
    const dd = S.hidden ? null : f.day_detail, isLast = sel === last;
    const E = (t) => (S.hidden ? "numbers hidden" : t);
    if (!isLast) { root.appendChild(h("div", "hv-note", "Hour-by-hour detail is kept for the latest day only. The numbers on the card are this day's totals.")); }
    const W = 1440, axis = h("div", "hv-axis"); const mk = (label, key) => { const r = h("div", "hv-row"); const lab = h("div", "hv-row-l"); lab.append(...label); r.appendChild(lab); const cv = h("div", "hv-row-c"); r.appendChild(cv); axis.appendChild(r); return cv; };
    const xp = (m) => (m / W) * 100;
    const ticksFor = (cv) => { for (let hh = 0; hh <= 24; hh += 3) { const tk = h("span", "hv-tick"); tk.style.left = xp(hh * 60) + "%"; cv.appendChild(tk); } };
    const hdr = h("div", "hv-row hv-axis-h"); hdr.appendChild(h("div", "hv-row-l")); const hc = h("div", "hv-row-c"); for (let hh = 0; hh <= 24; hh += 3) { const tl = h("span", "hv-ticklbl", (hh < 10 ? "0" : "") + (hh === 24 ? "24" : hh) + ":00"); tl.style.left = xp(hh * 60) + "%"; hc.appendChild(tl); } hdr.appendChild(hc); axis.appendChild(hdr);
    // sleep
    const sMin = sl ? sl.last7[sl.last7.length - dates.length + sel] : null;
    const cv1 = mk([icon("sleep", 24), nEl("div", "hv-big md", sMin == null ? "–" : L.fmtDur(sMin)), chipEl(L.statusOf("sleep_min", { now: sMin, prev: null, status: "ok" }, ctxOf()))]); ticksFor(cv1);
    if (isLast && dd && dd.sleep_blocks.length) {
      let first = Math.min.apply(null, dd.sleep_blocks.map((b) => (tmin(b.from) >= 1080 ? tmin(b.from) - 1440 : tmin(b.from)))), shift = first < 0 ? -first : 0, lastEnd = 0;
      dd.sleep_blocks.forEach((b) => { let a = tmin(b.from), z = tmin(b.to); if (a == null || z == null) return; if (a >= 1080) a -= 1440; if (z >= 1080) z -= 1440; if (z < a) z += 1440; a += shift; z += shift; lastEnd = Math.max(lastEnd, z); const e = h("span", "hv-blk hv-stage " + stageCls(b.stage)); e.style.left = xp(a) + "%"; e.style.width = Math.max(0.3, xp(z - a)) + "%"; cv1.appendChild(e); });
      cv1.appendChild(h("div", "hv-row-cap", (f.sleep && f.sleep.from ? "asleep from " + f.sleep.from + " the night before until " + (f.sleep.until || "") : "")));
    } else cv1.appendChild(h("div", "hv-row-empty", isLast ? E("no sleep detail in the feed yet") : "only totals for this day"));
    // heart
    const cv2 = mk([icon("heart", 24), nEl("div", "hv-big md", M("resting_hr") && M("resting_hr").now != null && isLast ? L.fmtNum(M("resting_hr").now, 0) : "–"), h("div", "hv-unit", "bpm rest")]); ticksFor(cv2);
    const rhr = M("resting_hr");
    if (isLast && dd && dd.hr_points.length >= 2) {
      const pts = dd.hr_points.map((p) => ({ x: tmin(p.t), y: p.bpm })).filter((p) => p.x != null), ys = pts.map((p) => p.y), lo = Math.min.apply(null, ys.concat([rhr && rhr.normal[0] != null ? rhr.normal[0] : 999])) - 4, hi = Math.max.apply(null, ys) + 8;
      const s = sv("svg", { viewBox: "0 0 1000 120", preserveAspectRatio: "none", class: "hv-hr" }), yy = (v) => 110 - ((v - lo) / (hi - lo)) * 100;
      const nb = rhr && rhr.normal[0] != null ? rhr.normal : rhr && rhr.baseline[0] != null ? rhr.baseline : null;
      if (nb) s.appendChild(sv("rect", { x: 0, y: yy(nb[1]), width: 1000, height: Math.max(2, yy(nb[0]) - yy(nb[1])), class: "hv-band" }));
      s.appendChild(sv("polyline", { points: pts.map((p) => ((p.x / W) * 1000).toFixed(1) + "," + yy(p.y).toFixed(1)).join(" "), fill: "none", class: "hv-line", "vector-effect": "non-scaling-stroke" }));
      cv2.appendChild(s);
      const mx = pts.reduce((a, p) => (p.y > a.y ? p : a), pts[0]), mn = pts.reduce((a, p) => (p.y < a.y ? p : a), pts[0]);
      [[mx, "max"], [mn, "min"]].forEach(([p, w]) => { const l = nEl("span", "hv-pt-l", L.fmtNum(p.y, 0) + " " + w); l.style.left = Math.min(92, xp(p.x)) + "%"; l.style.top = w === "max" ? "2px" : "auto"; if (w === "min") l.style.bottom = "2px"; cv2.appendChild(l); });
      if (nb) cv2.appendChild(nEl("div", "hv-row-cap band", "green band = your normal " + nb[0] + "–" + nb[1]));
    } else cv2.appendChild(h("div", "hv-row-empty", isLast ? E("no hourly heart rate in the feed yet") : "only totals for this day"));
    // steps
    const spd = st ? st.last7[st.last7.length - dates.length + sel] : null;
    const cv3 = mk([icon("steps", 24), nEl("div", "hv-big md", spd == null ? "–" : L.fmtNum(spd, 0)), h("div", "hv-unit", "steps"), chipEl(spd == null ? L.chip("nodata") : L.statusOf("steps", { now: spd, prev: null, status: "ok" }, Object.assign(ctxOf(), { day: dates[sel] })))]); ticksFor(cv3);
    if (isLast && dd && dd.steps_hourly.some((v) => v != null)) {
      const mxv = Math.max.apply(null, dd.steps_hourly.map((v) => v || 0).concat([1]));
      dd.steps_hourly.forEach((v, i) => { if (v == null) return; const b = h("span", "hv-hbar"); b.style.left = xp(i * 60 + 6) + "%"; b.style.width = xp(48) + "%"; b.style.height = (v > 0 ? Math.max(3, Math.round((v / mxv) * 70)) : 0) + "px"; cv3.appendChild(b); if (v > 0 && v >= mxv * 0.2) { const l = nEl("span", "hv-pt-l bar", L.fmtNum(v, 0)); l.style.left = xp(i * 60 + 30) + "%"; l.style.bottom = Math.round((v / mxv) * 70) + 6 + "px"; cv3.appendChild(l); } });
    } else cv3.appendChild(h("div", "hv-row-empty", isLast ? E("no hourly steps in the feed yet") : "only totals for this day"));
    // exercise
    const ex = isLast && dd ? dd.exercise : [];
    const cv4 = mk([icon("dumbbell", 24), nEl("div", "hv-big md", isLast && dd ? String(ex.length) : "–"), h("div", "hv-unit", ex.length === 1 ? "session" : "sessions")]); ticksFor(cv4);
    if (ex.length) ex.forEach((e) => { const a = tmin(e.start), z = tmin(e.end); if (a == null || z == null) return; const b = h("span", "hv-ex"); b.style.left = xp(a) + "%"; b.style.width = Math.max(1, xp(z - a)) + "%"; cv4.appendChild(b); const lb = h("div", "hv-ex-l"); lb.style.left = Math.min(70, xp(z) + 0.8) + "%"; lb.append(h("b", "", e.name + " "), nEl("span", "", (z - a) + " min"), nEl("div", "hv-ex-s", (e.kcal != null ? L.fmtNum(e.kcal, 0) + " kcal" : "") + (e.max_hr != null ? " · max " + e.max_hr + " bpm" : ""))); cv4.appendChild(lb); });
    else cv4.appendChild(h("div", "hv-row-empty", isLast && dd ? "no exercise recorded" : isLast ? E("no exercise detail in the feed yet") : "only totals for this day"));
    // now line (only on today's own day)
    const n = new Date(nowMs());
    if (isLast && f.day === L.ymd(n)) { axis.querySelectorAll(".hv-row-c").forEach((cv, i) => { if (i === 0) return; const nl = h("span", "hv-now"); nl.style.left = xp(n.getHours() * 60 + n.getMinutes()) + "%"; cv.appendChild(nl); }); }
    root.appendChild(axis);
    root.appendChild(h("div", "hv-note good", "Shows cause and effect (heart rate against the session). One day only; weight, body fat and blood oxygen do not fit an hour axis, so they are left out."));
  }

  // ------------------------------------------------------------------ activity level
  function renderActivity(root) {
    const f = feed(), a = f.activity, g = goals();
    if (!a || !M("steps")) { root.appendChild(h("div", "hv-empty-p", "No activity numbers in the feed yet.")); return; }
    const pts = L.activityPoints(f), usual = a.steps_median != null ? a.steps_median : 9000, effHi = L.EFFORT_HIGH_MIN;
    const grid = h("div", "hv-act");
    const left = h("section", "hv-card"); left.appendChild(h("div", "hv-card-h", "ACTIVITY LEVEL: EACH DOT IS ONE DAY"));
    const sx = pts.map((p) => p.steps).filter((v) => v != null), ey = pts.map((p) => p.effort).filter((v) => v != null);
    const x0 = Math.floor(Math.min.apply(null, sx.concat([4000, usual - 3000])) / 1000) * 1000, x1 = Math.ceil(Math.max.apply(null, sx.concat([14000, usual + 3000])) / 1000) * 1000, y1 = Math.max(90, Math.ceil(Math.max.apply(null, ey.concat([0])) / 30) * 30 + 10);
    const VW = 640, VH = 440, PL = 56, PB = 40, PT = 12, PR = 12, X = (v) => PL + ((v - x0) / (x1 - x0)) * (VW - PL - PR), Y = (v) => PT + (1 - v / y1) * (VH - PT - PB);
    const s = sv("svg", { viewBox: "0 0 " + VW + " " + VH, class: "hv-scatter", role: "img", "aria-label": "Effort against steps, one dot per day" });
    const q = (x, y, w, hh, cls) => s.appendChild(sv("rect", { x, y, width: w, height: hh, class: "hv-q " + cls }));
    q(PL, PT, X(usual) - PL, Y(effHi) - PT, "hl"); q(X(usual), PT, VW - PR - X(usual), Y(effHi) - PT, "hh"); q(PL, Y(effHi), X(usual) - PL, VH - PB - Y(effHi), "ll"); q(X(usual), Y(effHi), VW - PR - X(usual), VH - PB - Y(effHi), "lh");
    s.append(sv("line", { x1: X(usual), y1: PT, x2: X(usual), y2: VH - PB, class: "hv-axisline" }), sv("line", { x1: PL, y1: Y(effHi), x2: VW - PR, y2: Y(effHi), class: "hv-axisline" }));
    [["hl", PL + 8, PT + 20, "High effort, low steps"], ["hh", X(usual) + 8, PT + 20, "High effort, high steps"], ["ll", PL + 8, Y(effHi) + 20, "Quiet day"], ["lh", X(usual) + 8, Y(effHi) + 20, "Easy walking day"]].forEach(([c, x, y, t]) => s.appendChild(sv("text", { x, y, class: "hv-ql " + c }, t)));
    [x0, usual, x1].forEach((v) => s.appendChild(nSv(X(v), VH - PB + 16, L.fmtNum(v, 0) + (v === usual ? " (your usual)" : ""), v === x0 ? "start" : v === x1 ? "end" : "middle")));
    [0, effHi, 60, y1 > 90 ? 90 : null].filter((v) => v != null).forEach((v) => s.appendChild(nSv(PL - 6, Y(v) + 4, L.fmtNum(v, 0), "end")));
    s.appendChild(sv("text", { x: 14, y: VH / 2, class: "hv-axt", transform: "rotate(-90 14 " + VH / 2 + ")", "text-anchor": "middle" }, "EFFORT: minutes in hard zones 2-3"));
    s.appendChild(sv("text", { x: (PL + VW - PR) / 2, y: VH - 4, class: "hv-axt", "text-anchor": "middle" }, "MOVEMENT: steps per day"));
    pts.forEach((p, pi) => { if (p.steps == null || p.effort == null) return; const cx = S.hidden ? X(x0 + ((x1 - x0) * (pi + 1)) / (pts.length + 1)) : X(p.steps), cy = S.hidden ? Y(y1 / 2) : Y(p.effort), gp = sv("g", { class: "hv-dot" + (p.today ? " today" : "") }); gp.append(sv("circle", { cx, cy, r: p.today ? 17 : 13 }), sv("text", { x: cx, y: cy + 4, "text-anchor": "middle" }, L.wdShort(p.date))); const tt = sv("title", null, L.dayLabel(p.date) + (S.hidden ? "" : ": " + L.fmtNum(p.steps, 0) + " steps, " + p.effort + " min hard")); gp.appendChild(tt); s.appendChild(gp); });
    (a.labels || []).filter((l) => !S.hidden && l.regular && !l.detected && l.date).forEach((l) => { const i = f.dates_last7.indexOf(l.date), p = i >= 0 ? pts[i] : null; if (!p || p.steps == null) return; const cx = X(p.steps), cy = Math.max(PT + 16, (p.effort == null ? Y(0) : Y(p.effort)) - 34); s.appendChild(sv("circle", { cx, cy, r: 14, class: "hv-dot-ex" })); s.appendChild(sv("text", { x: cx + 20, y: cy + 4, class: "hv-ql sm" }, "expected, not detected (" + L.dayLabel(l.date) + ")")); });
    left.appendChild(s); grid.appendChild(left);
    const right = h("div", "hv-act-r");
    const hard = (a.zone2_min || 0) + (a.zone3_min || 0), yest = a.effort_min_last7.length > 1 ? a.effort_min_last7[a.effort_min_last7.length - 2] : null;
    const c1 = h("section", "hv-card"); const h1 = h("div", "hv-card-h"); h1.append(icon("racket", 18), h("span", "", "Effort today"), chipEl(hard >= effHi ? L.chip("hard") : L.chip("info"))); c1.appendChild(h1);
    const bg = h("div", "hv-bigrow"); bg.append(nEl("span", "hv-big xl", L.fmtNum(hard, 0)), h("span", "hv-unit", "min in hard zones")); c1.appendChild(bg);
    const sc = L.compare("steps", M("steps").now, usual, "usual"); const ec = yest != null ? hard - yest : null;
    c1.appendChild(nEl("div", "hv-cmp " + (ec > 0 ? "up" : ec < 0 ? "down" : ""), (ec == null ? "" : (ec > 0 ? "▲ " + ec + " more" : ec < 0 ? "▼ " + -ec + " fewer" : "same") + " than yesterday (" + yest + ") · ") + "steps " + L.fmtNum(M("steps").now, 0) + " (usual " + L.fmtNum(usual, 0) + ")"));
    const zs = [["z1", a.zone1_min, "Zone 1 easy"], ["z2", a.zone2_min, "Zone 2 hard"], ["z3", a.zone3_min, "Zone 3 peak"]].filter((z) => z[1] != null);
    if (zs.length) { const zb = h("div", "hv-stack z"); zs.forEach((z) => { const e = nEl("span", "hv-zone " + z[0], z[1] + " min"); e.style.flexGrow = grow(z[1]); zb.appendChild(e); }); c1.appendChild(zb); const zl = h("div", "hv-stage-lg"); zs.forEach((z) => { const i = h("span", "hv-stage-i"); i.append(h("i", "hv-zone " + z[0]), h("span", "", z[2])); zl.appendChild(i); }); c1.appendChild(zl); }
    (a.labels || []).filter((l) => l.date === f.day).forEach((l) => { const r = h("div", "hv-label-row"); r.append(icon("racket", 18), nEl("b", "", l.name + ": expected " + (l.date ? L.dayLabel(l.date, true).split(" ")[0] : "") + " " + l.start + (l.detected ? ", detected " + l.detected : ", not detected")), l.detected ? chipEl(L.chip("good")) : h("span", "hv-chip hv-none dashed", "not detected")); c1.appendChild(r); });
    right.appendChild(c1);
    const wk = a.week_effort, tgt = g.hard_min_week, c2 = h("section", "hv-card"); const h2 = h("div", "hv-card-h"); h2.append(h("span", "", "This week: hard-zone minutes"), chipEl(L.weekChip(wk, tgt))); c2.appendChild(h2);
    const bg2 = h("div", "hv-bigrow"); bg2.append(nEl("span", "hv-big xl", wk == null ? "–" : L.fmtNum(wk, 0)), nEl("span", "hv-unit", "of " + tgt + " min target")); c2.appendChild(bg2);
    if (a.prev_week_effort != null && wk != null) { const d = wk - a.prev_week_effort; c2.appendChild(nEl("div", "hv-cmp " + (d > 0 ? "up" : d < 0 ? "down" : ""), (d > 0 ? "▲ " + d + " more" : d < 0 ? "▼ " + -d + " fewer" : "same") + " than last week (" + a.prev_week_effort + ")")); }
    const pb = h("div", "hv-prog"); const pf = h("div", "hv-prog-f"); const mxp = Math.max(tgt, wk || 0) * 1.12; pf.style.width = S.hidden ? "0%" : Math.min(100, ((wk || 0) / mxp) * 100) + "%"; const tk = h("div", "hv-prog-t"); tk.style.left = (tgt / mxp) * 100 + "%"; tk.title = tgt + " min weekly target"; pb.append(pf, tk); c2.appendChild(pb);
    c2.appendChild(barChart(a.effort_min_last7, f.dates_last7.slice(-a.effort_min_last7.length), { height: 56, zeroBased: true, fmt: (v) => String(v) }));
    right.appendChild(c2);
    const c3 = h("section", "hv-card hv-rules"); c3.append(h("div", "hv-card-h", "RULES IN THIS VIEW"), h("div", "", "Two axes, never one score. Dot = one day (big = today). Effort is measured from heart-rate zones. The known-activities list only names a window (\"Table tennis\") or shows a dashed empty circle when the watch missed it; it never adds points."));
    right.appendChild(c3); grid.appendChild(right); root.appendChild(grid);
  }
  function nSv(x, y, text, anchor) { const t = sv("text", { x, y, class: "hv-axl hv-num", "text-anchor": anchor || "middle" }, N(text)); return t; }

  // ------------------------------------------------------------------ history screen (shared)
  const HIST = { steps: ["Steps", "steps", "steps"], sleep_min: ["Sleep", "sleep", "min"], resting_hr: ["Resting heart", "heart", "bpm"], hrv: ["HRV", "hrv", "ms"], avg_hr: ["Average heart rate", "heart", "bpm"], skin_temp: ["Skin temp", "skin", "°C"], weight: ["Weight", "scale", "kg"], body_fat: ["Body fat", "fat", "%"], spo2: ["Blood oxygen", "spo2", "%"], breathing: ["Breathing", "breathing", "per min"], active_kcal: ["Active calories", "flame", "kcal"], distance_km: ["Distance", "pin", "km"], active_min: ["Active minutes", "clock", "min"], exercise_min: ["Exercise", "dumbbell", "min"] };
  function lineChart(vals, labels, opts) {
    const o0 = opts || {}, o = S.hidden ? Object.assign({}, o0, { band: null, goal: null }) : o0;
    if (S.hidden) vals = vals.map((v) => (v == null ? null : 1));     // hide-numbers: a flat placeholder line, no shape
    const W = 760, H = 300, PL = 46, PR = 20, PT = 18, PB = 34, pts = vals.map((v, i) => ({ v, i })).filter((p) => p.v != null);
    const s = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "hv-line-chart", role: "img", "aria-label": o.title || "history chart" });
    if (!pts.length) { s.appendChild(sv("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "hv-axl" }, "no points")); return s; }
    const all = pts.map((p) => p.v).concat(o.band ? o.band.filter((x) => x != null) : []), mn = Math.min.apply(null, all), mx = Math.max.apply(null, all), pad = (mx - mn || 1) * 0.12, lo = mn - pad, hi = mx + pad;
    const X = (i) => PL + (vals.length < 2 ? (W - PL - PR) / 2 : (i / (vals.length - 1)) * (W - PL - PR)), Y = (v) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
    if (o.band && o.band[0] != null && o.band[1] != null) { s.appendChild(sv("rect", { x: PL, y: Y(o.band[1]), width: W - PL - PR, height: Math.max(2, Y(o.band[0]) - Y(o.band[1])), class: "hv-band" })); [o.band[0], o.band[1]].forEach((b) => s.appendChild(nSv(W - PR + 2, Y(b) + 4, L.fmtNum(b, o.dec), "start"))); s.appendChild(sv("text", { x: W - PR - 4, y: Y(o.band[1]) - 4, class: "hv-axl", "text-anchor": "end" }, "your normal")); }
    if (o.goal != null && o.goal >= lo && o.goal <= hi && !S.hidden) s.appendChild(sv("line", { x1: PL, y1: Y(o.goal), x2: W - PR, y2: Y(o.goal), class: "hv-goalsvg" }));
    s.appendChild(sv("polyline", { points: pts.map((p) => X(p.i).toFixed(1) + "," + Y(p.v).toFixed(1)).join(" "), fill: "none", class: "hv-line" }));
    const maxP = pts.reduce((a, p) => (p.v > a.v ? p : a), pts[0]), minP = pts.reduce((a, p) => (p.v < a.v ? p : a), pts[0]), lastP = pts[pts.length - 1];
    pts.forEach((p) => { const c = sv("circle", { cx: X(p.i), cy: Y(p.v), r: p === lastP ? 5 : 3.5, class: "hv-pt" + (p === lastP ? " now" : "") }); c.appendChild(sv("title", null, (labels[p.i] || "") + (S.hidden ? "" : ": " + L.fmtNum(p.v, o.dec)))); s.appendChild(c); });
    [[maxP, "max", -8], [minP, "min", 16], [lastP, "now", -10]].forEach(([p, w, dy]) => { if (w !== "now" && (p === lastP)) return; s.appendChild(sv("text", { x: Math.min(X(p.i), W - PR - 26), y: Y(p.v) + dy, class: "hv-axl strong hv-num", "text-anchor": "middle" }, N(L.fmtNum(p.v, o.dec) + " " + w))); });
    const step = Math.max(1, Math.ceil(labels.length / 7)); labels.forEach((t, i) => { if (i % step === 0 || i === labels.length - 1) s.appendChild(sv("text", { x: X(i), y: H - 10, class: "hv-axl", "text-anchor": "middle" }, t)); });
    return s;
  }
  function yearBars(years, dec) {
    const wrap = h("div", "hv-years"), ys = years.filter((y) => y.avg != null), mx = Math.max.apply(null, ys.map((y) => y.avg).concat([1]));
    ys.forEach((y, i) => { const c = h("div", "hv-year" + (i === ys.length - 1 ? " today" : "")); c.append(nEl("div", "hv-year-v", L.fmtNum(y.avg, dec)), (() => { const f = h("div", "hv-year-f"); f.style.height = (S.hidden ? 50 : Math.max(8, (y.avg / mx) * 100)) + "px"; return f; })(), h("div", "hv-bar-d", y.year)); wrap.appendChild(c); });
    return wrap;
  }
  function calendar(daily, key) {
    const wrap = h("div", "hv-cal"), byDate = {}; daily.forEach((d) => { byDate[d.date] = d.v; });
    const real = daily.filter((d) => d.v != null), best = real.reduce((a, d) => (a == null || d.v > a.v ? d : a), null), worst = real.reduce((a, d) => (a == null || d.v < a.v ? d : a), null);
    const first = L.parseDay(daily[0].date), lastD = L.parseDay(daily[daily.length - 1].date), start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - ((first.getDay() + 6) % 7));
    const grid = h("div", "hv-cal-g"); const lvl = (v) => (S.hidden ? "l1" : v == null ? "n" : v < 4000 ? "l0" : v < 7000 ? "l1" : v < 10000 ? "l2" : "l3");
    for (let d = new Date(start); d <= lastD; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) { const k = L.ymd(d), v = byDate[k], cell = h("span", "hv-cal-c " + (d < first ? "pad" : lvl(v))); if (!S.hidden && best && k === best.date) { cell.classList.add("best"); } if (!S.hidden && worst && k === worst.date) { cell.classList.add("worst"); cell.textContent = "✕"; } cell.title = L.dayLabel(k) + (v != null && !S.hidden ? ": " + L.fmtNum(v, 0) : ""); grid.appendChild(cell); }
    wrap.appendChild(grid);
    const lg = h("div", "hv-cal-lg"); [["l0", "under 4,000"], ["l1", "4,000–6,999"], ["l2", "7,000–9,999"], ["l3", "10,000 +"], ["n", "no data"]].forEach(([c, t]) => { const i = h("span", "hv-stage-i"); i.append(h("i", "hv-cal-c " + c), h("span", "", t)); lg.appendChild(i); });
    if (best) lg.appendChild(nEl("span", "hv-stage-i", "□ best day " + L.fmtNum(best.v, 0) + " (" + L.dayLabel(best.date) + ")")); if (worst) lg.appendChild(nEl("span", "hv-stage-i", "✕ worst day " + L.fmtNum(worst.v, 0) + " (" + L.dayLabel(worst.date) + ")"));
    wrap.appendChild(lg); return wrap;
  }
  function renderHistory(root) {
    const f = feed(), key = S.metric, m = M(key), def = HIST[key] || [key, "clock", ""];
    const top = h("div", "hv-hist-top"); top.append(btn("Back to Overview", "hv-btn sm", () => { S.view = "overview"; S.metric = null; S.ui.rerender(); })); top.appendChild(h("span", "hv-grow"));
    const seg = h("div", "hv-seg"); [["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["all", "All"]].forEach(([id, label]) => { const b = btn(label, "hv-seg-b" + (S.range === id ? " on" : ""), () => { S.range = id; S.ui.rerender(); }); b.setAttribute("aria-pressed", S.range === id ? "true" : "false"); seg.appendChild(b); }); top.appendChild(seg); root.appendChild(top);
    const ttl = h("div", "hv-hist-t"); ttl.append(icon(def[1], 26), h("span", "", def[0])); root.appendChild(ttl);
    if (!m || m.now == null) { root.appendChild(h("div", "hv-empty-p", "No numbers for this yet.")); return; }
    const isSleep = key === "sleep_min", dec = isSleep ? 1 : L.decOf(key), conv = (v) => (v == null ? null : isSleep ? Math.round(v / 6) / 10 : v), unit = isSleep ? "h" : def[2];
    const grid = h("div", "hv-hist");
    const now = h("section", "hv-card"); const c = L.statusOf(key, m, ctxOf()); const nh = h("div", "hv-card-h"); nh.append(h("span", "", "Now"), chipEl(c)); now.appendChild(nh);
    const big = h("div", "hv-bigrow"); big.append(nEl("span", "hv-big xl", isSleep ? L.fmtDur(m.now) : L.fmtNum(m.now, dec)), isSleep ? h("span") : h("span", "hv-unit", unit)); now.appendChild(big);
    const cmp = L.compare(key, m.now, m.prev, key === "weight" || key === "body_fat" ? "last reading" : "yesterday"); now.appendChild(h("div", "hv-cmp " + (cmp.dir || ""), N((cmp.dir === "up" ? "▲ " : cmp.dir === "down" ? "▼ " : "") + cmp.text)));
    const nb = m.normal[0] != null ? m.normal : m.baseline[0] != null ? m.baseline : null; if (nb) now.appendChild(nEl("div", "hv-cmp", (m.normal[0] != null ? "Your normal: " : "Your usual (last 28 days): ") + L.fmtNum(nb[0], dec) + "–" + L.fmtNum(nb[1], dec)));
    grid.appendChild(now);
    const ch = h("section", "hv-card hv-chart"); const rl = { day: "TODAY AND YESTERDAY", week: "LAST 7 DAYS, EVERY POINT LABELLED", month: "LAST 30 DAYS", year: "AVERAGE PER YEAR", all: "AVERAGE PER YEAR" }[S.range]; ch.appendChild(h("div", "hv-card-h", rl));
    const dl = f.dates_last7.map((d) => L.dayLabel(d, false));
    if (S.range === "day") { ch.appendChild(barChart([m.prev, m.now].map(conv), null, { height: 130, labels: ["yesterday", "today"], fmt: (v) => L.fmtNum(v, dec) })); }
    else if (S.range === "week") ch.appendChild(lineChart(m.last7.map(conv), dl, { band: nb ? nb.map(conv) : null, dec, goal: key === "steps" ? goals().steps : isSleep ? goals().sleep_min / 60 : null, title: def[0] + " last 7 days" }));
    else if (S.range === "month") { if (m.last30.some((v) => v != null)) ch.appendChild(lineChart(m.last30.map(conv), m.last30.map((v, i) => "d" + (i + 1 - m.last30.length)), { band: nb ? nb.map(conv) : null, dec, title: def[0] + " last 30 days" })); else ch.appendChild(h("div", "hv-empty-p", "Daily points for the month are not in the numbers file yet. The month summary is below.")); }
    else { if (m.years.length) ch.appendChild(yearBars(m.years.map((y) => ({ year: y.year, avg: conv(y.avg) })), dec)); else ch.appendChild(h("div", "hv-empty-p", "No yearly averages in the numbers file yet.")); }
    grid.appendChild(ch); root.appendChild(grid);
    const st = h("div", "hv-stats"); const mo = m.month, bw = (title, big2, sub) => { const c2 = h("div", "hv-stat"); c2.append(h("div", "hv-stat-t", title), nEl("div", "hv-big md", big2), h("div", "hv-cmp", sub)); return c2; };
    if (mo) { if (mo.avg != null) st.appendChild(bw("Average", isSleep ? L.fmtDur(mo.avg) : L.fmtNum(mo.avg, dec), "over the last 30 days")); if (mo.best) st.appendChild(bw("Best day", L.dayLabel(mo.best, false), "highest in 30 days")); if (mo.worst) st.appendChild(bw("Worst day", L.dayLabel(mo.worst, false), "lowest in 30 days")); if (mo.in_normal) st.appendChild(bw("In your normal", mo.in_normal.replace("/", " of "), "days in the last 30")); }
    if (st.childNodes.length) root.appendChild(st);
    if (m.years.length && S.range !== "year" && S.range !== "all") { const yc = h("section", "hv-card"); yc.appendChild(h("div", "hv-card-h", "SAME METRIC ACROSS THE YEARS (AVERAGE PER YEAR)")); yc.appendChild(yearBars(m.years.map((y) => ({ year: y.year, avg: conv(y.avg) })), dec)); root.appendChild(yc); }
    if (key === "steps" && m.daily.length > 30) { const cc = h("section", "hv-card"); cc.appendChild(h("div", "hv-card-h", "WHOLE YEAR: STEPS PER DAY (CALENDAR)")); cc.appendChild(calendar(m.daily, key)); root.appendChild(cc); }
  }

  // ------------------------------------------------------------------ periodic (non-daily sections)
  function freshness(sec) {
    const row = h("div", "hv-fresh"), due = L.dueState(sec && sec.next_due, nowMs());
    const a = h("span", "hv-chip hv-info"); a.append(h("span", "hv-chip-g", "↻"), h("span", "hv-chip-w", "Last updated " + L.whenText(sec && sec.last_updated))); row.appendChild(a);
    const cls = due.id === "overdue" ? "bad" : due.id === "soon" ? "warn" : due.id === "ok" ? "ok" : "none";
    const b = h("span", "hv-chip hv-" + cls + (due.id === "none" ? " dashed" : "")); b.append(h("span", "hv-chip-g", due.id === "overdue" ? "✕" : due.id === "soon" ? "▲" : due.id === "ok" ? "✓" : "–"), h("span", "hv-chip-w", "Next due " + (sec && sec.next_due ? L.whenText(sec.next_due) + " · " : "") + due.text)); row.appendChild(b); return row;
  }
  function section(id, title, ic, sec, basic, detail) {
    const c = h("section", "hv-card hv-sec"); const hd = h("div", "hv-sec-h"); hd.append(icon(ic, 24), h("span", "hv-sec-t", title), h("span", "hv-grow")); c.appendChild(hd);
    if (!sec) { c.appendChild(h("div", "hv-row-empty", "No " + title.toLowerCase() + " in the numbers file yet.")); c.classList.add("nodata"); return c; }
    c.appendChild(freshness(sec)); c.appendChild(basic());
    const open = !!S.open[id]; const tg = btn(open ? "Hide details" : "Details", "hv-btn sm hv-details-btn", () => { S.open[id] = !open; S.ui.rerender(); }); tg.setAttribute("aria-expanded", open ? "true" : "false"); hd.appendChild(tg);
    if (open) { const dv = h("div", "hv-detail"); detail(dv); c.appendChild(dv); }
    return c;
  }
  function spark(series, w, hh) {
    const vals = series.map((p) => (S.hidden ? 1 : p.value)), s = sv("svg", { viewBox: "0 0 " + w + " " + hh, width: w, height: hh, class: "hv-spark", "aria-hidden": "true" });
    if (vals.length < 2) { s.appendChild(sv("circle", { cx: w / 2, cy: hh / 2, r: 3, class: "hv-pt now" })); return s; }
    const mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals), X = (i) => 4 + (i / (vals.length - 1)) * (w - 8), Y = (v) => 4 + (1 - (v - mn) / (mx - mn || 1)) * (hh - 8);
    s.appendChild(sv("polyline", { points: vals.map((v, i) => X(i).toFixed(1) + "," + Y(v).toFixed(1)).join(" "), fill: "none", class: "hv-line" })); vals.forEach((v, i) => s.appendChild(sv("circle", { cx: X(i), cy: Y(v), r: i === vals.length - 1 ? 3.5 : 2.5, class: "hv-pt" + (i === vals.length - 1 ? " now" : "") }))); return s;
  }
  function markerRow(mk) {
    const r = h("div", "hv-mrow" + (mk.in_range === "out" ? " out" : ""));
    const nm = h("div", "hv-m-n"); nm.append(h("span", "hv-m-name", mk.marker), h("span", "hv-m-date", L.whenText(mk.latest.date))); r.appendChild(nm);
    const v = h("div", "hv-m-v"); v.append(nEl("span", "hv-big sm", L.fmtNum(mk.latest.value, mk.latest.value % 1 ? 1 : 0)), h("span", "hv-unit", mk.unit)); r.appendChild(v);
    const tr = mk.trend ? nEl("div", "hv-m-tr", L.TREND_GLYPH[mk.trend] + (mk.previous ? " from " + L.fmtNum(mk.previous.value, mk.previous.value % 1 ? 1 : 0) + " (" + L.whenText(mk.previous.date) + ")" : "")) : h("div", "hv-m-tr none", "first result"); r.appendChild(tr);
    r.appendChild(chipEl(mk.in_range === "out" ? { glyph: "◆", word: "Out of range", cls: "warn" } : mk.in_range === "in" ? { glyph: "✓", word: "In range", cls: "ok" } : { glyph: "–", word: "No range", cls: "none" }));
    const q = (v) => String(Math.round(v * 100) / 100), lo = mk.range[0], hi = mk.range[1];
    r.appendChild(h("div", "hv-m-rng", lo == null && hi == null ? "no range set" : N(lo == null ? "up to " + q(hi) : hi == null ? "from " + q(lo) : "range " + q(lo) + " to " + q(hi))));
    const sp = h("div", "hv-m-sp"); sp.appendChild(spark(mk.series, 90, 28)); r.appendChild(sp); return r;
  }
  function renderPeriodic(root) {
    const f = feed(), wrap = h("div", "hv-periodic");
    const bt = f.blood_tests;
    wrap.appendChild(section("blood", "Blood tests", "flask", bt, () => {
      const b = h("div", "hv-basic"); const hl = bt.headline || {}; const row = h("div", "hv-bigrow"); row.append(nEl("span", "hv-big", String(hl.markers != null ? hl.markers : bt.markers.length)), h("span", "hv-unit", "markers tracked"), nEl("span", "hv-big sm warn", String(hl.out_of_range != null ? hl.out_of_range : 0)), h("span", "hv-unit", "out of range")); b.appendChild(row);
      L.bloodOrder(bt.markers).filter((m) => m.in_range === "out").slice(0, 3).forEach((m) => b.appendChild(markerRow(m))); return b;
    }, (dv) => { L.bloodOrder(bt.markers).filter((m) => m.in_range !== "out").forEach((m) => dv.appendChild(markerRow(m))); if (!bt.markers.length) dv.appendChild(h("div", "hv-row-empty", "No results yet.")); }));
    const nu = f.nutrition;
    wrap.appendChild(section("nutrition", "Nutrition", "food", nu, () => {
      const b = h("div", "hv-basic"); const row = h("div", "hv-bigrow"); const d14 = nu.headline && nu.headline.days_logged_14d != null ? nu.headline.days_logged_14d : nu.days.length; row.append(nEl("span", "hv-big", String(d14)), h("span", "hv-unit", "of the last 14 days logged")); b.appendChild(row);
      const strip = h("div", "hv-nstrip"); nu.days.slice(0, 7).slice().reverse().forEach((d) => { const c = h("div", "hv-nday" + (d.fasting ? " fasting" : d.entries ? " logged" : " none")); c.appendChild(nEl("div", "hv-nday-n", d.fasting ? "fast" : String(d.entries || 0))); c.appendChild(h("div", "hv-bar-d", L.dayLabel(d.date).split(" ")[0])); strip.appendChild(c); }); b.appendChild(strip);
      if (nu.weekly_highlights[0]) b.appendChild(nEl("div", "hv-hl", "★ " + nu.weekly_highlights[0])); return b;
    }, (dv) => {
      nu.weekly_highlights.slice(1).forEach((t) => dv.appendChild(nEl("div", "hv-hl", "★ " + t)));
      nu.days.forEach((d) => { const r = h("div", "hv-nrow"); r.append(h("span", "hv-nrow-d", L.dayLabel(d.date)), nEl("span", "", d.fasting ? "fasting day" : (d.entries || 0) + (d.entries === 1 ? " entry" : " entries")), h("span", "hv-nrow-s", (d.slots || []).join(", ")), d.usual ? h("span", "hv-chip hv-info", "usual") : h("span"), d.photos ? nEl("span", "hv-nrow-p", d.photos + (d.photos === 1 ? " photo" : " photos")) : h("span")); dv.appendChild(r); });
    }));
    const cg = f.cognitive;
    wrap.appendChild(section("cognitive", "Cognitive tests", "brain", cg, () => {
      const b = h("div", "hv-basic"); const hl = cg.headline; if (hl && hl.last_score != null) { const row = h("div", "hv-bigrow"); row.append(nEl("span", "hv-big xl", L.fmtNum(hl.last_score, 0)), h("span", "hv-unit", hl.test || "score")); b.appendChild(row); const s2 = cg.series; if (s2.length > 1) { const d = s2[s2.length - 1].score - s2[s2.length - 2].score; b.appendChild(nEl("div", "hv-cmp " + (d > 0 ? "up" : d < 0 ? "down" : ""), (d > 0 ? "▲ " + d + " higher" : d < 0 ? "▼ " + -d + " lower" : "same") + " than last time (" + s2[s2.length - 2].score + ")")); } else b.appendChild(h("div", "hv-cmp none", "first result, nothing to compare yet")); if (s2.length) { const sp = h("div", "hv-m-sp"); sp.appendChild(spark(s2.map((p) => ({ value: p.score })), 160, 40)); b.appendChild(sp); } } else b.appendChild(h("div", "hv-row-empty", "No result yet."));
      return b;
    }, (dv) => { cg.series.slice().reverse().forEach((p) => { const r = h("div", "hv-nrow"); r.append(h("span", "hv-nrow-d", L.whenText(p.date)), nEl("b", "", L.fmtNum(p.score, 0)), h("span", "hv-nrow-s", p.test || "")); dv.appendChild(r); }); }));
    root.appendChild(wrap);
  }

  // ------------------------------------------------------------------ entry point (called by health.js render)
  function render(page, body, ui) {
    S.ui = ui; watch();
    const root = h("div", "hv hv-" + page + (S.hidden ? " hidden-numbers" : "")); root.dataset.hvPage = page;
    body.appendChild(root);
    if (!S.res) { root.appendChild(h("div", "hv-empty-p", "Reading the numbers file...")); load(); return; }
    const r = S.res;
    if (r.state !== "ok") { root.appendChild(headerLite()); root.appendChild(emptyState(r)); root.appendChild(legend("overview")); return; }
    const bn = stateBanner();
    if (page === "periodic") {
      const hd = h("div", "hv-bar-head"); hd.append(h("b", "hv-title", "Periodic: slower than daily"), h("span", "hv-grow"));
      if (r.sample) hd.appendChild(h("span", "hv-chip hv-info hv-sample", "SAMPLE DATA"));
      const eye = btn("", "hv-iconbtn", () => { S.hidden = !S.hidden; S.ui.rerender(); }); eye.append(icon(S.hidden ? "eyeoff" : "eye", 18)); eye.title = S.hidden ? "Show the numbers" : "Hide the numbers (for screen sharing)"; eye.setAttribute("aria-label", eye.title); eye.setAttribute("aria-pressed", S.hidden ? "true" : "false"); eye.dataset.role = "eye"; hd.appendChild(eye);
      root.appendChild(hd); if (bn) root.appendChild(bn); renderPeriodic(root); root.appendChild(legend("periodic")); return;
    }
    root.appendChild(header()); if (bn) root.appendChild(bn);
    const v = S.view === "history" ? "history" : S.view;
    if (v === "day") renderDay(root); else if (v === "activity") renderActivity(root); else if (v === "history") renderHistory(root); else renderOverview(root);
    root.appendChild(legend(v === "history" ? "overview" : v));
    fitRings(root);
  }
  function headerLite() { const row = h("div", "hv-bar-head"); row.append(h("b", "hv-title", "My Health"), h("span", "hv-grow")); return row; }

  window.healthVisual = { render, clear };
})();
