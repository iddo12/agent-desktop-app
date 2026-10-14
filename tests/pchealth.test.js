// node tests/pchealth.test.js - PC health panel: pure logic (src/pcHealthCore.js) and source guards for the renderer, wiring and CSS.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const C = require("../src/pcHealthCore");
const src = (p) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");
let n = 0, fails = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + (e.stack || e.message)); } }

t("dial arc and ticks match UI-UX mockup v3", () => {
  assert.strictEqual(C.arcPath(), "M32.5 139.0 A78 78 0 1 1 167.5 139.0");
  const tk = C.ticks();
  assert.strictEqual(tk.length, 11);
  assert.deepStrictEqual(tk[0], { x1: "24.7", y1: "143.5", x2: "18.6", y2: "147.0" });
  assert.deepStrictEqual(tk[5], { x1: "100.0", y1: "13.0", x2: "100.0", y2: "6.0" });
});
t("needle and fill follow the percentage, clamped", () => {
  assert.strictEqual(C.needleDeg(0), 0); assert.strictEqual(C.needleDeg(50), 120); assert.strictEqual(C.needleDeg(100), 240);
  assert.strictEqual(C.needleDeg(250), 240); assert.strictEqual(C.needleDeg(-5), 0); assert.strictEqual(C.needleDeg(null), 0);
  assert.strictEqual(C.dashOffset(100), 0); assert.ok(Math.abs(C.dashOffset(0) - C.ARC_LEN) < 0.2);
});
t("a missing value is n/a, never 0", () => {
  assert.strictEqual(C.pctText(null), "n/a"); assert.strictEqual(C.tempText(undefined), "n/a"); assert.strictEqual(C.freeText(null), "n/a");
  assert.strictEqual(C.mbitText(null), "n/a"); assert.strictEqual(C.uptimeText(null), "n/a"); assert.strictEqual(C.gbText(null), "n/a");
  assert.strictEqual(C.pctText(0), "0%"); assert.strictEqual(C.tempText(0), "0°C"); // a real zero is still shown
});
t("formatting", () => {
  assert.strictEqual(C.freeText(1222), "1.22 TB"); assert.strictEqual(C.freeText(560), "560 GB"); assert.strictEqual(C.freeText(0.2), "0.2 GB");
  assert.strictEqual(C.uptimeText(114180), "1 d 7 h since last boot"); assert.strictEqual(C.uptimeText(3700), "1 h 1 min since last boot"); assert.strictEqual(C.uptimeText(120), "2 min since last boot");
  assert.strictEqual(C.fanPct(1000), 50); assert.strictEqual(C.fanPct(5000), 100); assert.strictEqual(C.fanPct(null), 0);
  assert.strictEqual(C.mbitText(44.02), "44 Mbit/s"); assert.strictEqual(C.mbitText(3.24), "3.2 Mbit/s");
});

t("gate: a new state must hold 2 ticks before it shows (no flicker)", () => {
  const g = C.createGate(2);
  assert.strictEqual(g.update("cpu", "ok"), "ok");           // first value shows at once
  assert.strictEqual(g.update("cpu", "warn"), "ok");         // 1 tick: still ok
  assert.strictEqual(g.update("cpu", "ok"), "ok");           // blip gone
  assert.strictEqual(g.update("cpu", "warn"), "ok");
  assert.strictEqual(g.update("cpu", "warn"), "warn");       // 2 in a row: switch
  assert.strictEqual(g.update("cpu", "bad"), "warn");
  assert.strictEqual(g.update("cpu", "ok"), "warn");         // different pending state restarts the count
  assert.strictEqual(g.update("cpu", "ok"), "ok");
  assert.strictEqual(g.update("x", null), "na"); assert.strictEqual(g.shown("nothing"), "na");
});
t("sticky: last value held for the grace period, then n/a (null)", () => {
  const s = C.createSticky(1000);
  assert.strictEqual(s.get("t", 70, 0), 70);
  assert.strictEqual(s.get("t", null, 500), 70);
  assert.strictEqual(s.get("t", null, 1500), null);
  assert.deepStrictEqual(s.get("d", [1], 0), [1]); assert.deepStrictEqual(s.get("d", [], 100), [1]);
});

const sample = (o) => Object.assign({
  cpu: { total_pct: 20, cores: Array.from({ length: 24 }, (_, i) => ({ id: i, type: i < 8 ? "P" : "E", pct: 5 })), temp_c: 70, temp_limit_c: 100, state: "ok" },
  gpu: { pct: 43, vram_used_gb: 3.8, vram_total_gb: 12, temp_c: 48, temp_limit_c: 84, state: "ok" },
  ram: { used_gb: 66, total_gb: 96, state: "ok" }, pagefile: { used_gb: 9, total_gb: 62, state: "ok" },
  drives: [{ letter: "C", label: "C:", used_pct: 34, free_gb: 1222, busy_pct: 0, mb_s: 1, state: "ok" }, { letter: "I", label: "I:", used_pct: 91, free_gb: 84, busy_pct: 0, mb_s: 0, state: "warn" }],
  fans: [{ name: "CPU Fan", rpm: 1000, state: "ok" }], net: {}, top_procs: [],
}, o || {});
t("dials: values, sublabels, thresholds for the dials the collector does not score", () => {
  const d = C.dials(sample());
  assert.strictEqual(d.cpu.big, "20%"); assert.strictEqual(d.cpu.sub, "overall, 24 cores");
  assert.strictEqual(d.ram.big, "69%"); assert.strictEqual(d.ram.sub, "66 of 96 GB");
  assert.strictEqual(d.vram.big, "32%"); assert.strictEqual(d.vram.sub, "3.8 of 12 GB"); assert.strictEqual(d.vram.state, "ok");
  assert.strictEqual(d.cputemp.big, "70°C"); assert.strictEqual(d.cputemp.sub, "limit 100°C"); assert.strictEqual(d.gputemp.max, 84);
  const hot = C.dials(sample({ gpu: { pct: 1, vram_used_gb: 11.5, vram_total_gb: 12, temp_c: 90, temp_limit_c: 84, state: "bad" } }));
  assert.strictEqual(hot.vram.state, "bad"); assert.strictEqual(hot.gputemp.state, "bad");
});
t("missing sensors: n/a text, na state, null pct", () => {
  const d = C.dials(sample({ cpu: { total_pct: 20, cores: [], temp_c: null, state: "ok" }, gpu: { pct: null, vram_used_gb: null, vram_total_gb: null, temp_c: null, state: null } }));
  assert.strictEqual(d.cputemp.big, "n/a"); assert.strictEqual(d.cputemp.pct, null); assert.strictEqual(d.cputemp.state, "na");
  assert.strictEqual(d.gpu.big, "n/a"); assert.strictEqual(d.vram.big, "n/a"); assert.strictEqual(d.gpu.state, "na");
});
t("banner: ok / watch / problem, built from gated states", () => {
  const g = C.createGate(2);
  let b = C.banner(C.scoredItems(sample(), g));
  assert.strictEqual(b.state, "warn"); assert.ok(/1 thing to watch/.test(b.title)); assert.ok(/Drive I: is 91% full \(84 GB free\)/.test(b.detail));
  const calm = sample({ drives: [{ letter: "C", label: "C:", used_pct: 34, free_gb: 1222, state: "ok" }] });
  const g2 = C.createGate(2);
  b = C.banner(C.scoredItems(calm, g2));
  assert.strictEqual(b.state, "ok"); assert.strictEqual(b.title, "Everything looks fine");
  // a bad tick does not flip the banner until it holds for 2 ticks
  const bad = sample({ ram: { used_gb: 95, total_gb: 96, state: "bad" }, drives: calm.drives });
  assert.strictEqual(C.banner(C.scoredItems(bad, g2)).state, "ok");
  const b2 = C.banner(C.scoredItems(bad, g2));
  assert.strictEqual(b2.state, "bad"); assert.ok(/RAM is 99% used/.test(b2.detail));
  assert.strictEqual(C.banner([]).state, "na");
});
t("every state has a symbol and a word (colour is never the only signal)", () => {
  for (const s of ["ok", "warn", "bad", "na"]) { assert.ok(C.SYMBOL[s]); assert.ok(C.WORD[s]); }
  assert.strictEqual(C.WORD.warn, "Watch"); assert.strictEqual(C.WORD.bad, "Problem");
});

// ---- source guards: renderer, wiring, CSS ----
const js = src("renderer/pchealth.js"), css = src("renderer/styles-pchealth.css"), html = src("renderer/index.html"), pre = src("preload.js"), main = src("main.js"), pm = src("pcHealthMain.js");
t("sources compile", () => { for (const [f, s] of [["pchealth.js", js], ["pcHealthCore.js", src("pcHealthCore.js")], ["pcHealthMain.js", pm]]) new vm.Script(s, { filename: f }); });
t("renderer: textContent only, no timers, no eval", () => {
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setInterval(", "setTimeout("]) assert.ok(!js.includes(bad), "uses " + bad);
});
t("renderer: starts the collector only on open/resume and stops on leave / Esc / Bridge closed / unload", () => {
  assert.ok(/function open\(\)[\s\S]*startLive\(\)/.test(js));
  assert.ok(/function close\(\)[\s\S]*pcHealthStop\("left"\)/.test(js));
  assert.ok(/Escape/.test(js) && /argus-open/.test(js) && /beforeunload/.test(js));
  assert.strictEqual((js.match(/api\.pcHealthStart\(\)\.then/g) || []).length, 1, "pcHealthStart only inside startLive");
});
t("renderer: legend, placeholder, snapshot button, Resume live, tab and title-bar icon", () => {
  for (const s of ["Collecting top processes...", "Snapshot (15 s)", "Resume live", "stops when you leave this page", "normal range", "Colour is never the only signal", "PC health"]) assert.ok(js.includes(s), "missing: " + s);
  assert.ok(/\.xp-controls/.test(js) && /argus-head/.test(js));
});
t("css: reduced motion respected, 1 s ease, own tokens, no external urls", () => {
  assert.ok(/prefers-reduced-motion: reduce/.test(css)); assert.ok(/1s ease/.test(css));
  assert.ok(!/url\(/.test(css)); assert.ok(!/@import/.test(css));
});
t("wiring: html loads css + core + panel after argus.js; preload channels; main init", () => {
  assert.ok(html.indexOf("styles-pchealth.css") > 0);
  const a = html.indexOf('src="argus.js"'), b = html.indexOf('src="../pcHealthCore.js"'), c = html.indexOf('src="pchealth.js"');
  assert.ok(a > 0 && b > a && c > b);
  for (const ch of ["pchealth-start", "pchealth-stop", "pchealth-snapshot", "pchealth-data", "pchealth-status"]) assert.ok(pre.includes('"' + ch + '"'), "preload " + ch);
  for (const ch of ["pchealth-start", "pchealth-stop", "pchealth-snapshot", "pchealth-data", "pchealth-status"]) assert.ok(pm.includes('"' + ch + '"'), "main " + ch);
  assert.ok(/require\("\.\/pcHealthMain"\)\.init\(/.test(main));
});
t("main: hidden window, kill by PID tree, quit hooks, reload hook, only the main window may ask", () => {
  assert.ok(/windowsHide: true/.test(pm)); assert.ok(/taskkill/.test(pm) && /"\/T"/.test(pm));
  for (const ev of ["minimize", "restore", "before-quit", "will-quit", "did-start-navigation", "closed"]) assert.ok(pm.includes('"' + ev + '"'), ev);
  assert.ok(/fromApp\(event\)/.test(pm));
  assert.ok(!/shell: true/.test(pm));
});

console.log(fails ? `pchealth: ${fails} of ${n} FAILED` : `pchealth: all ${n} passed`);
process.exit(fails ? 1 : 0);
