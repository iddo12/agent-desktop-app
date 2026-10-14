// My Health: the ONE chart used everywhere (Today tiles, Longevity, Trends, Labs history, Experiments, Nutrition focus, Weekly). Plain SVG, no library.
// Ported from the UI-UX "chart rule" (my_health_v3_mockups, lib.py chart()): six checks.
//   1. A marker on EVERY point (a point outside the band is a hollow diamond: shape, not only colour).
//   2. Axes with real values: y ticks at round numbers with the unit in the axis title, x labels are real dates spaced at least ~62 px apart.
//   3. Latest, minimum and maximum are written on the chart ("3.6 mg/L now", "0.8 min", "72 max").
//   4. Band edges are numbers ("your normal" / "lab range", with both edge values at the right); an optional goal line is labelled "goal N".
//   5. Tooltip and keyboard: every point is focusable (Tab, then Left/Right/Home/End) and hovering or focusing shows
//      "date: value unit / change vs the previous point | position against the band / source" in a read-out box.
//   6. A "Show numbers" button lists date and value rows (the text alternative), same points, no hidden values.
// textContent only; no timers, no storage, no clipboard.
(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayText = (ts) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ts || ""); return m ? +m[3] + " " + MON[+m[2] - 1] + " " + m[1].slice(2) : ""; };
  const dayShort = (ts) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ts || ""); return m ? +m[3] + " " + MON[+m[2] - 1] : ""; };
  const tms = (ts) => new Date(String(ts).length <= 10 ? ts + "T00:00:00" : ts).getTime();

  function fmtVal(kind, dec, v) {
    if (v == null || !isFinite(v)) return "";
    if (kind === "sleep") { const h = Math.floor(v / 60), m = Math.round(v - h * 60); return h + ":" + String(m).padStart(2, "0"); }
    if (dec === 0) return Math.round(v).toLocaleString("en-US");
    return String(Number((Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec)).toFixed(dec)));
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) { e.textContent = text; e.dir = "auto"; } return e; };
  const sv = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k of Object.keys(attrs || {})) e.setAttribute(k, String(attrs[k])); if (text != null) e.textContent = text; return e; };

  // Round tick values: 4 or 5 steps from the 1 / 2 / 2.5 / 5 / 10 series.
  function niceTicks(lo, hi) {
    const raw = (hi - lo) / 4 || 1, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const stp = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
    const out = []; for (let v = Math.ceil(lo / stp) * stp; v <= hi + 1e-9; v += stp) out.push(Math.round(v / stp) * stp);
    return out;
  }

  // opts: {series:[{ts, v, after?, s? (source)}], unit, dec, kind ("sleep" shows h:mm), band:{low, high, label?}, target (a goal value), startTs, w, h, title}
  function make(opts) {
    const o = opts || {}, W = o.w || 620, H = o.h || 190, dec = o.dec == null ? 1 : o.dec, kind = o.kind || "num", unit = o.unit || "";
    const pts = (o.series || []).filter((p) => p && isFinite(p.v) && p.ts).sort((a, b) => tms(a.ts) - tms(b.ts));
    const wrap = el("div", "hl-chart");
    if (!pts.length) { wrap.appendChild(el("div", "hl-muted hl-small", "No readings to chart.")); return wrap; }
    const f = (v) => fmtVal(kind, dec, v), withUnit = (v) => f(v) + (kind === "sleep" ? " h:min" : unit ? " " + unit : "");
    const L = 46, R = 70, T = 16, B = 28, pw = W - L - R, ph = H - T - B;
    const vals = pts.map((p) => p.v);
    let lo = Math.min.apply(null, vals.concat(o.band ? [o.band.low] : [], o.target != null ? [o.target] : [])), hi = Math.max.apply(null, vals.concat(o.band ? [o.band.high] : [], o.target != null ? [o.target] : []));
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1; lo -= pad; hi += pad;
    const t0 = tms(pts[0].ts), t1 = tms(pts[pts.length - 1].ts), span = t1 - t0, last = pts.length - 1;
    const X = (ts) => (span > 0 ? L + pw * ((tms(ts) - t0) / span) : L + pw / 2), Y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;
    const outside = (v) => !!o.band && (v < o.band.low || v > o.band.high);

    const svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "hl-chart-svg", role: "group", "aria-label": (o.title ? o.title + ": " : "") + pts.length + " readings, latest " + withUnit(pts[last].v) + " on " + dayText(pts[last].ts) + ". Use Tab then the arrow keys to read each point, or Show numbers." });
    if (o.band) {
      const y1 = Y(o.band.high), y2 = Y(o.band.low);
      svg.appendChild(sv("rect", { x: L, y: y1.toFixed(1), width: pw, height: Math.max(1, y2 - y1).toFixed(1), class: "hl-band" }));
      svg.appendChild(sv("text", { x: L + pw + 6, y: (y1 + 4).toFixed(1), class: "hl-axis hl-bandtxt" }, f(o.band.high)));
      svg.appendChild(sv("text", { x: L + pw + 6, y: (y2 + 4).toFixed(1), class: "hl-axis hl-bandtxt" }, f(o.band.low)));
      svg.appendChild(sv("text", { x: L + pw + 6, y: ((y1 + y2) / 2 + 4).toFixed(1), class: "hl-axis hl-bandlbl" }, o.band.label || "your normal"));
    }
    for (const v of niceTicks(lo, hi)) {
      svg.appendChild(sv("line", { x1: L, x2: L + pw, y1: Y(v).toFixed(1), y2: Y(v).toFixed(1), class: "hl-grid" }));
      svg.appendChild(sv("text", { x: L - 6, y: (Y(v) + 4).toFixed(1), "text-anchor": "end", class: "hl-axis" }, f(v)));
    }
    svg.appendChild(sv("text", { x: 2, y: 10, class: "hl-axis hl-axis-unit" }, kind === "sleep" ? "h:min" : unit));
    if (o.target != null) {
      const yt = Y(o.target);
      svg.appendChild(sv("line", { x1: L, x2: L + pw, y1: yt.toFixed(1), y2: yt.toFixed(1), class: "hl-goal" }));
      svg.appendChild(sv("text", { x: L + pw + 6, y: (yt + 4).toFixed(1), class: "hl-axis hl-goaltxt" }, "goal " + f(o.target)));
    }
    // x axis: real dates, a label only where there is room (about every 62 px)
    const step = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(pw / 62))));
    const longSpan = span > 200 * 86400000;
    for (let i = 0; i < pts.length; i += step) svg.appendChild(sv("text", { x: X(pts[i].ts).toFixed(1), y: H - 8, "text-anchor": "middle", class: "hl-axis" }, longSpan ? dayText(pts[i].ts) : dayShort(pts[i].ts)));
    if (last % step !== 0 && pts.length > 1 && (pw / Math.max(1, pts.length - 1)) * (last % step) > 40) svg.appendChild(sv("text", { x: X(pts[last].ts).toFixed(1), y: H - 8, "text-anchor": "middle", class: "hl-axis" }, longSpan ? dayText(pts[last].ts) : dayShort(pts[last].ts)));
    if (o.startTs) { const x = X(o.startTs); if (x >= L && x <= L + pw) { svg.appendChild(sv("line", { x1: x.toFixed(1), x2: x.toFixed(1), y1: T - 6, y2: H - B, class: "hl-startline" })); svg.appendChild(sv("text", { x: x.toFixed(1), y: 9, "text-anchor": "middle", class: "hl-axis" }, "start")); } }
    if (pts.length > 1) svg.appendChild(sv("polyline", { points: pts.map((p) => X(p.ts).toFixed(1) + "," + Y(p.v).toFixed(1)).join(" "), class: "hl-line" }));
    let iMin = 0, iMax = 0; pts.forEach((p, i) => { if (p.v < pts[iMin].v) iMin = i; if (p.v > pts[iMax].v) iMax = i; });

    const read = el("div", "hl-chart-read", "");
    const showRead = (i) => {
      const p = pts[i], prev = i > 0 ? pts[i - 1] : null; const lines = [dayText(p.ts) + ": " + withUnit(p.v)];
      const sub = []; if (prev) { const d = p.v - prev.v; sub.push((d > 0 ? "+" : d < 0 ? "-" : "") + f(Math.abs(d)) + " vs " + dayShort(prev.ts)); }
      if (o.band) sub.push(p.v > o.band.high ? "above " + (o.band.label || "your normal") + " (" + f(o.band.low) + "-" + f(o.band.high) + ") by " + f(p.v - o.band.high) : p.v < o.band.low ? "below " + (o.band.label || "your normal") + " (" + f(o.band.low) + "-" + f(o.band.high) + ") by " + f(o.band.low - p.v) : "inside " + (o.band.label || "your normal") + " (" + f(o.band.low) + "-" + f(o.band.high) + ")");
      if (sub.length) lines.push(sub.join(" | ")); if (p.s) lines.push("source: " + p.s);
      read.textContent = ""; lines.forEach((l, k) => read.appendChild(el("div", k === 0 ? "hl-read-h" : "hl-read-s", l)));
    };
    const dots = [];
    pts.forEach((p, i) => {
      const x = X(p.ts), y = Y(p.v), out = outside(p.v), after = p.after === true;
      let c;
      if (out) c = sv("rect", { x: (x - 4.5).toFixed(1), y: (y - 4.5).toFixed(1), width: 9, height: 9, transform: "rotate(45 " + x.toFixed(1) + " " + y.toFixed(1) + ")", class: "hl-pt out" + (i === last ? " last" : "") });
      else c = sv("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: i === last ? 5.4 : 3.6, class: "hl-pt" + (i === last ? " last" : "") + (after ? " after" : "") });
      c.setAttribute("tabindex", i === last ? "0" : "-1"); c.setAttribute("role", "img"); c.setAttribute("aria-label", dayText(p.ts) + ": " + withUnit(p.v) + (out ? ", outside the band" : ""));
      c.appendChild(sv("title", {}, dayText(p.ts) + ": " + withUnit(p.v)));
      c.addEventListener("mouseenter", () => { showRead(i); c.classList.add("hot"); }); c.addEventListener("focus", () => { showRead(i); c.classList.add("hot"); });
      c.addEventListener("mouseleave", () => c.classList.remove("hot")); c.addEventListener("blur", () => c.classList.remove("hot"));
      svg.appendChild(c); dots.push(c);
    });
    // latest, minimum and maximum written out (the six-point rule)
    const lbl = (i, text, dx, dy, anchor, cls) => svg.appendChild(sv("text", { x: (X(pts[i].ts) + dx).toFixed(1), y: (Y(pts[i].v) + dy).toFixed(1), "text-anchor": anchor, class: "hl-ptlbl " + (cls || "") }, text));
    if (iMin !== last && pts[iMin].v !== pts[iMax].v) lbl(iMin, f(pts[iMin].v) + " min", 6, 17, "start");
    if (iMax !== last && pts[iMin].v !== pts[iMax].v) lbl(iMax, f(pts[iMax].v) + " max", 0, -10, "middle");
    lbl(last, f(pts[last].v) + (kind === "sleep" ? "" : unit ? " " + unit : "") + " now", -8, -11, "end", "last");
    svg.addEventListener("keydown", (e) => {
      const cur = dots.findIndex((d) => d === document.activeElement); if (cur < 0) return;
      const nxt = e.key === "ArrowRight" ? Math.min(last, cur + 1) : e.key === "ArrowLeft" ? Math.max(0, cur - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
      if (nxt < 0) return; e.preventDefault(); dots[cur].setAttribute("tabindex", "-1"); dots[nxt].setAttribute("tabindex", "0"); dots[nxt].focus();
    });
    wrap.appendChild(svg);
    showRead(last); read.classList.add("hl-chart-read"); wrap.appendChild(read);
    const tb = el("button", "hl-link hl-small", "Show numbers"); tb.type = "button"; let table = null;
    tb.addEventListener("click", () => {
      if (table) { table.remove(); table = null; tb.textContent = "Show numbers"; tb.setAttribute("aria-expanded", "false"); return; }
      table = el("table", "hl-numtable"); table.appendChild(el("caption", "hl-small hl-muted", (o.title || "Readings") + (unit ? " (" + unit + ")" : "")));
      const hd = el("tr"); hd.append(el("th", "", "Date"), el("th", "", "Value")); table.appendChild(hd);
      pts.slice(-120).reverse().forEach((p) => { const r = el("tr"); const v = el("td", "", withUnit(p.v)); v.style.fontWeight = "700"; r.append(el("td", "", dayText(p.ts)), v); table.appendChild(r); });
      if (pts.length > 120) table.appendChild(el("caption", "hl-small hl-muted", "Newest 120 of " + pts.length));
      wrap.appendChild(table); tb.textContent = "Hide numbers"; tb.setAttribute("aria-expanded", "true");
    });
    tb.setAttribute("aria-expanded", "false"); wrap.appendChild(tb);
    return wrap;
  }
  window.healthChart = { make, fmtVal, dayText, dayShort, niceTicks };
})();
