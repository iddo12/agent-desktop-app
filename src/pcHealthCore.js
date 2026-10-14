// PC health panel (v1.111.0) - pure logic, no DOM, no Electron. The renderer (renderer/pchealth.js) draws; this decides.
// Loaded in the renderer as window.PcHealthCore and by tests/pchealth.test.js through require().
// Input is the JSON the collector prints (shared_tools\pc_health\pc_health.py, --stream or one-shot); its shape is not changed here.
(function (root) {
  "use strict";

  // ---- dial geometry (UI-UX mockup v3: 240-degree gauge, viewBox 200 wide, centre 100,100, radius 78) ----
  const CX = 100, CY = 100, R = 78, START = 150, SWEEP = 240;
  const rad = (d) => (d * Math.PI) / 180;
  const pt = (angle, r) => [CX + r * Math.cos(rad(angle)), CY + r * Math.sin(rad(angle))];
  const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
  const clampPct = (p) => (typeof p === "number" && isFinite(p) ? Math.max(0, Math.min(100, p)) : 0);

  function arcPath() {
    const a = pt(START, R), b = pt(START + SWEEP, R);
    return `M${f1(a[0])} ${f1(a[1])} A${R} ${R} 0 1 1 ${f1(b[0])} ${f1(b[1])}`;
  }
  const ARC_LEN = (R * rad(SWEEP));
  function ticks() {
    const out = [];
    for (let i = 0; i <= 10; i++) {
      const a = START + (SWEEP / 10) * i, p = pt(a, R + 9), q = pt(a, R + 16);
      out.push({ x1: f1(p[0]), y1: f1(p[1]), x2: f1(q[0]), y2: f1(q[1]) });
    }
    return out;
  }
  // The needle is drawn once pointing at 0 and rotated about the hub, so a CSS transition can ease it between ticks.
  function needleRestPoint() { const p = pt(START, 72); return { x2: f1(p[0]), y2: f1(p[1]) }; }
  const needleDeg = (pct) => Math.round(clampPct(pct) * (SWEEP / 100) * 10) / 10;
  const dashOffset = (pct) => Math.round(ARC_LEN * (1 - clampPct(pct) / 100) * 10) / 10;

  // ---- states ----
  const SYMBOL = { ok: "✓", warn: "!", bad: "✕", na: "–" };
  const WORD = { ok: "OK", warn: "Watch", bad: "Problem", na: "n/a" };
  const RANK = { na: 0, ok: 1, warn: 2, bad: 3 };
  const norm = (s) => (s === "ok" || s === "warn" || s === "bad" ? s : "na");
  const worst = (list) => list.reduce((w, s) => (RANK[norm(s)] > RANK[w] ? norm(s) : w), "na");
  // Same thresholds as the collector, for the dials the collector does not score on their own.
  const stateHi = (v, warn, bad) => (v == null || !isFinite(v) ? "na" : v >= bad ? "bad" : v >= warn ? "warn" : "ok");

  // A new state must hold for `hold` consecutive ticks before it is shown (no flicker). The first value is shown at once.
  function createGate(hold) {
    const need = hold || 2;
    const m = new Map();
    return {
      update(key, raw) {
        raw = norm(raw);
        let e = m.get(key);
        if (!e) { m.set(key, (e = { shown: raw, pending: null, n: 0 })); return raw; }
        if (raw === e.shown) { e.pending = null; e.n = 0; return e.shown; }
        if (raw === e.pending) e.n++; else { e.pending = raw; e.n = 1; }
        if (e.n >= need) { e.shown = raw; e.pending = null; e.n = 0; }
        return e.shown;
      },
      shown(key) { const e = m.get(key); return e ? e.shown : "na"; },
      reset() { m.clear(); },
    };
  }

  // Slower sensors (temps, fans, drive free space) keep their last value for `graceMs` when a tick lacks them.
  function createSticky(graceMs) {
    const m = new Map();
    return {
      get(key, value, now) {
        const t = now == null ? Date.now() : now;
        if (value != null && !(Array.isArray(value) && !value.length)) { m.set(key, { v: value, t }); return value; }
        const e = m.get(key);
        return e && t - e.t <= graceMs ? e.v : value;
      },
      reset() { m.clear(); },
    };
  }

  // ---- formatting (a missing value is "n/a", never 0) ----
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const pctText = (v) => (isNum(v) ? Math.round(v) + "%" : "n/a");
  const tempText = (v) => (isNum(v) ? Math.round(v) + "°C" : "n/a");
  const gbText = (v) => (isNum(v) ? (v < 10 ? v.toFixed(1) : String(Math.round(v))) : "n/a");
  function freeText(gb) {
    if (!isNum(gb)) return "n/a";
    if (gb >= 1000) return (gb / 1000).toFixed(2) + " TB";
    return (gb < 10 ? gb.toFixed(1) : String(Math.round(gb))) + " GB";
  }
  function mbitText(v) { return isNum(v) ? (v < 10 ? v.toFixed(1) : String(Math.round(v))) + " Mbit/s" : "n/a"; }
  function uptimeText(s) {
    if (!isNum(s)) return "n/a";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d} d ${h} h since last boot` : h ? `${h} h ${m} min since last boot` : `${m} min since last boot`;
  }
  const FAN_SCALE_RPM = 2000;
  const fanPct = (rpm) => (isNum(rpm) ? Math.max(0, Math.min(100, (rpm / FAN_SCALE_RPM) * 100)) : 0);

  // ---- what the dials show, from one collector tick ----
  function ratio(used, total) { return isNum(used) && isNum(total) && total > 0 ? (used / total) * 100 : null; }
  function dials(d) {
    const cpu = d.cpu || {}, gpu = d.gpu || {}, ram = d.ram || {}, pf = d.pagefile || {};
    const nCores = (cpu.cores || []).length;
    const vramPct = ratio(gpu.vram_used_gb, gpu.vram_total_gb);
    const ramPct = ratio(ram.used_gb, ram.total_gb), pfPct = ratio(pf.used_gb, pf.total_gb);
    const cpuLim = isNum(cpu.temp_limit_c) ? cpu.temp_limit_c : 100, gpuLim = isNum(gpu.temp_limit_c) ? gpu.temp_limit_c : 90;
    return {
      cpu: { pct: isNum(cpu.total_pct) ? cpu.total_pct : null, big: pctText(cpu.total_pct), sub: nCores ? `overall, ${nCores} cores` : "overall", state: norm(cpu.state) },
      gpu: { pct: isNum(gpu.pct) ? gpu.pct : null, big: pctText(gpu.pct), sub: "3D engine", state: norm(gpu.state) },
      ram: { pct: ramPct, big: pctText(ramPct), sub: isNum(ram.used_gb) ? `${gbText(ram.used_gb)} of ${gbText(ram.total_gb)} GB` : "", state: norm(ram.state) },
      vram: { pct: vramPct, big: pctText(vramPct), sub: isNum(gpu.vram_used_gb) ? `${gbText(gpu.vram_used_gb)} of ${gbText(gpu.vram_total_gb)} GB` : "", state: stateHi(vramPct, 85, 95) },
      pagefile: { pct: pfPct, big: pctText(pfPct), sub: isNum(pf.used_gb) ? `${gbText(pf.used_gb)} of ${gbText(pf.total_gb)} GB` : "", state: norm(pf.state) },
      cputemp: { pct: isNum(cpu.temp_c) ? (cpu.temp_c / cpuLim) * 100 : null, big: tempText(cpu.temp_c), sub: `limit ${tempText(cpuLim)}`, max: cpuLim, state: stateHi(cpu.temp_c, 90, 98) },
      gputemp: { pct: isNum(gpu.temp_c) ? (gpu.temp_c / gpuLim) * 100 : null, big: tempText(gpu.temp_c), sub: `limit ${tempText(gpuLim)}`, max: gpuLim, state: stateHi(gpu.temp_c, 80, 88) },
    };
  }

  // ---- the banner: built from the (already gated) states of the items the collector scores, so it never disagrees with the chips ----
  // items: [{label, state, text}]  text = a short sentence used when the item is in the banner
  function scoredItems(d, gate) {
    const g = (k, s) => (gate ? gate.update(k, s) : norm(s));
    const dl = dials(d);
    const items = [
      { label: "CPU", state: g("cpu", dl.cpu.state), text: (d.cpu && isNum(d.cpu.temp_c) && stateHi(d.cpu.temp_c, 90, 98) !== "ok") ? `CPU is hot (${tempText(d.cpu.temp_c)})` : `CPU is busy (${dl.cpu.big})` },
      { label: "GPU", state: g("gpu", dl.gpu.state), text: (d.gpu && stateHi(dl.vram.pct, 85, 95) !== "ok") ? `GPU memory is ${dl.vram.big} used` : (d.gpu && isNum(d.gpu.temp_c) && stateHi(d.gpu.temp_c, 80, 88) !== "ok") ? `GPU is hot (${tempText(d.gpu.temp_c)})` : `GPU is busy (${dl.gpu.big})` },
      { label: "RAM", state: g("ram", dl.ram.state), text: `RAM is ${dl.ram.big} used` },
      { label: "Page file", state: g("pagefile", dl.pagefile.state), text: `Page file is ${dl.pagefile.big} used` },
    ];
    for (const dr of d.drives || []) {
      items.push({ label: "Drive " + dr.label, state: g("drive:" + dr.letter, dr.state), text: `Drive ${dr.label} is ${Math.round(dr.used_pct)}% full (${freeText(dr.free_gb)} free)` });
    }
    for (const fan of d.fans || []) {
      items.push({ label: "Fan " + fan.name, state: g("fan:" + fan.name, fan.state), text: `${fan.name} has stopped` });
    }
    return items;
  }
  function banner(items) {
    const has = items.some((i) => i.state !== "na");
    if (!has) return { state: "na", title: "Waiting for the first reading...", detail: "" };
    const bad = items.filter((i) => i.state === "bad"), warn = items.filter((i) => i.state === "warn");
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    if (bad.length) {
      return { state: "bad", title: `Problem — ${plural(bad.length, "thing")} need${bad.length === 1 ? "s" : ""} attention`,
        detail: bad.map((i) => i.text).concat(warn.map((i) => i.text)).join("; ") + "." };
    }
    if (warn.length) {
      return { state: "warn", title: `Mostly fine — ${plural(warn.length, "thing")} to watch`,
        detail: warn.map((i) => i.text).join("; ") + ". Everything else is within normal range." };
    }
    return { state: "ok", title: "Everything looks fine", detail: "All measurements are within normal range." };
  }

  const api = {
    CX, CY, R, START, SWEEP, ARC_LEN, arcPath, ticks, needleRestPoint, needleDeg, dashOffset, clampPct,
    SYMBOL, WORD, RANK, norm, worst, stateHi, createGate, createSticky,
    pctText, tempText, gbText, freeText, mbitText, uptimeText, fanPct, FAN_SCALE_RPM,
    dials, scoredItems, banner,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PcHealthCore = api;
})(typeof window !== "undefined" ? window : this);
