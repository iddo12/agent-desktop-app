// node tests/leftpane.test.js - left pane layouts F / C / classic (v1.80.0): pure logic (src/leftpane.js) and static guards on the renderer wiring.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const root = path.join(__dirname, "..", "src");
const LP = require(path.join(root, "leftpane.js"));
const rsrc = fs.readFileSync(path.join(root, "renderer", "leftpane.js"), "utf8");
const css = fs.readFileSync(path.join(root, "renderer", "styles-leftpane.css"), "utf8");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const ht = fs.readFileSync(path.join(root, "renderer", "header-tasks.js"), "utf8");
let n = 0, fails = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.log("FAIL " + name + "\n  " + (e && e.message)); } }

t("layout setting: three values, default dock, anything else falls back to the default", () => {
  assert.deepStrictEqual(LP.LAYOUTS, ["dock", "grid", "classic"]);
  assert.strictEqual(LP.DEFAULT_LAYOUT, "dock");
  for (const v of ["dock", "grid", "classic"]) assert.strictEqual(LP.normalizeLayout(v), v);
  for (const v of [null, undefined, "", "compact", "C", "DOCK", {}, 7, "classic "]) assert.strictEqual(LP.normalizeLayout(v), "dock");
  for (const v of LP.LAYOUTS) assert.ok(LP.LAYOUT_LABELS[v]);
});
t("collapsed state round-trips and only '1'/true mean collapsed", () => {
  assert.strictEqual(LP.parseCollapsed(LP.serializeCollapsed(true)), true);
  assert.strictEqual(LP.parseCollapsed(LP.serializeCollapsed(false)), false);
  for (const v of [null, undefined, "", "0", "x", 0]) assert.strictEqual(LP.parseCollapsed(v), false);
});
t("tiles: live systems in fixed order, then the soon tiles; a real entry replaces its placeholder", () => {
  const ids = (a) => a.map((x) => x.id + ":" + x.kind).join(" ");
  assert.strictEqual(ids(LP.planTiles(["library", "argus", "iris", "memory", "daily"], [])),
    "argus:live memory:live daily:live iris:live library:live health:soon tasks:soon reviews:soon tools:soon");
  assert.strictEqual(ids(LP.planTiles(["argus"], ["health"])), "argus:live health:live tasks:soon reviews:soon tools:soon");
  assert.strictEqual(ids(LP.planTiles([], [])), "health:soon tasks:soon reviews:soon tools:soon");
  assert.strictEqual(ids(LP.planTiles(null, null)), "health:soon tasks:soon reviews:soon tools:soon");
});
t("tiles: new systems add a tile (not a row); bad or duplicate extra ids are ignored", () => {
  const tiles = LP.planTiles(["argus"], ["finance", "finance", "Bad Id", "", 5, "argus", "x".repeat(40)]);
  assert.deepStrictEqual(tiles.filter((x) => x.kind === "live").map((x) => x.id), ["argus", "finance"]);
});
t("memory line: three bars as percentages, clamped; incomplete input gives nothing", () => {
  assert.strictEqual(LP.memoryLine(["97%", "30%", "60%"]), "L1 97% \u00B7 L2 30% \u00B7 L3 60%");
  assert.strictEqual(LP.memoryLine([120, -5, "60.4%"]), "L1 100% \u00B7 L2 0% \u00B7 L3 60%");
  for (const v of [null, [], ["1%"], ["a", "b", "c"], "x"]) assert.strictEqual(LP.memoryLine(v), "");
});
t("dock model: nothing selected -> null; pause/resume label; sig changes only with visible facts", () => {
  assert.strictEqual(LP.dockModel(null), null);
  assert.strictEqual(LP.dockModel({}), null);
  const base = { folder: "Sec", name: "Security", role: "audit", state: "working", widths: ["97%", "30%", "60%"] };
  const a = LP.dockModel(base), b = LP.dockModel(Object.assign({}, base));
  assert.strictEqual(a.action, "Pause"); assert.strictEqual(a.sig, b.sig);
  assert.strictEqual(LP.dockModel(Object.assign({}, base, { paused: true })).action, "Resume");
  assert.notStrictEqual(LP.dockModel(Object.assign({}, base, { state: "ready" })).sig, a.sig);
  assert.notStrictEqual(LP.dockModel(Object.assign({}, base, { widths: ["98%", "30%", "60%"] })).sig, a.sig);
  assert.strictEqual(LP.dockModel({ folder: "x" }).name, "x");
});
t("legend has the six states with the existing swatch classes", () => {
  assert.strictEqual(LP.LEGEND.length, 6);
  for (const l of LP.LEGEND) assert.ok(/^xp-lg/.test(l.cls) && l.label);
});
t("renderer: compiles, textContent only, no timers/polling, one observer, falls back to classic on error", () => {
  new vm.Script(rsrc, { filename: "leftpane.js" });
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setInterval", "setTimeout"]) assert.ok(!rsrc.includes(bad), "uses " + bad);
  assert.strictEqual((rsrc.match(/new MutationObserver/g) || []).length, 1);
  assert.ok(/falling back to classic/.test(rsrc) && /layoutOff\(\)/.test(rsrc));
  assert.ok(/KEY_STRIP/.test(rsrc) && /localStorage/.test(rsrc) && /try \{ return window\.localStorage/.test(rsrc));
});
t("wiring: pure helper loads before renderer.js/header-tasks.js/library.js (they use it), DOM script after iris.js, css loaded, Restart agents is in the Session menu, original button kept", () => {
  const i = (x) => html.indexOf('src="' + x + '"');
  assert.ok(i("../leftpane.js") > 0 && i("../leftpane.js") < i("renderer.js") && i("../leftpane.js") < i("header-tasks.js") && i("../leftpane.js") < i("library.js"));
  assert.ok(i("iris.js") < i("leftpane.js") && i("tools-nav.js") < i("leftpane.js"));
  assert.ok(html.includes("styles-leftpane.css"));
  assert.ok(/"restart-all-btn"/.test(ht.slice(ht.indexOf("SESSION_ACTIONS"), ht.indexOf("SESSION_ACTIONS") + 600)));
  assert.ok(html.includes('id="restart-all-btn"'));
});
t("css: layout rules only apply under body.lp-on / lp-f / lp-c, the legend of the chat header is never touched", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.split("{")[0].trim()).filter(Boolean);
  for (const sel of rules.join(",").replace(/\([^()]*,[^()]*\)/g, "()").split(",").map((x) => x.trim())) { // commas inside :is(...)/:not(...) are not selector separators
    if (/^(#lp-layout-row|#lp-layout-select|#lp-restart-row|#lp-restart-btn|body\.argus-open|#systems-group|\.lp-|#lp-dock|#lp-legend-bar|@container|body\.lp-|body:not\(\.lp-|body\.lp-)/.test(sel) || /^\{?$/.test(sel)) continue;
    assert.fail("unscoped selector: " + sel);
  }
  assert.ok(!/\.xp-legend/.test(css));
  assert.ok(/body\.lp-on #restart-all-btn \{ display: none; \}/.test(css));
});

t("v1.80.1: foot Restart agents button clicks the original; dock Pause goes through toggleAgentPaused (which confirms)", () => {
  assert.ok(/lp-restart-btn/.test(rsrc) && /getElementById\("restart-all-btn"\)/.test(rsrc) && /lp-restart-row/.test(css));
  assert.ok(/toggleAgentPaused\(a\)/.test(rsrc));
  const r = fs.readFileSync(path.join(root, "renderer", "renderer.js"), "utf8");
  assert.ok(/async function toggleAgentPaused[\s\S]{0,300}confirm\(/.test(r));
});

// ---- v1.83.2 refinements ----
const lib = fs.readFileSync(path.join(root, "renderer", "library.js"), "utf8");
const rr = fs.readFileSync(path.join(root, "renderer", "renderer.js"), "utf8");
t("v1.83.2 #1: Library counts show an en dash until loaded; a loaded zero is a real 0", () => {
  assert.strictEqual(LP.countText(0, false), "–");
  assert.strictEqual(LP.countText(7, false), "–");
  assert.strictEqual(LP.countText(0, true), "0");
  assert.strictEqual(LP.countText(12, true), "12");
  assert.strictEqual(LP.countText(NaN, true), "0");
  assert.ok(/entriesLoaded = true;/.test(lib) && /countText\(n, entriesLoaded\)/.test(lib) && /countText\(0, false\)/.test(lib));
});
t("v1.83.2 #2: legend card starts open once, then closed; the choice is remembered", () => {
  assert.deepStrictEqual(LP.legendInitial(null), { open: true, persist: true });
  assert.deepStrictEqual(LP.legendInitial(undefined), { open: true, persist: true });
  assert.deepStrictEqual(LP.legendInitial("0"), { open: false, persist: false });
  assert.deepStrictEqual(LP.legendInitial("1"), { open: true, persist: false });
  assert.deepStrictEqual(LP.legendInitial("junk"), { open: false, persist: false });
  assert.ok(/lp-help/.test(rsrc) && /KEY_LEGEND/.test(rsrc) && /legendInitial/.test(rsrc) && /\.lp-help \{ display: none/.test(css) && /body\.lp-c \.lp-help \{ display: inline-flex/.test(css));
  assert.ok(/#lp-legend-bar\[hidden\]/.test(css));
});
t("v1.83.2 #3: row state shape + words; needs and health words; aria-labels wired", () => {
  assert.strictEqual(LP.stateWord("working"), "Working now"); assert.strictEqual(LP.stateShape("working"), "triangle");
  assert.strictEqual(LP.stateWord("ready"), "Open, waiting"); assert.strictEqual(LP.stateShape("ready"), "pause bars");
  for (const v of ["off", "idle", "", null, undefined, "x"]) { assert.strictEqual(LP.stateWord(v), "Not running"); assert.strictEqual(LP.stateShape(v), "hollow square"); }
  assert.strictEqual(LP.needsWord("blocked", "Blocked: waiting on a permission prompt"), "Blocked: waiting on a permission prompt");
  assert.ok(/^Blocked/.test(LP.needsWord("blocked", ""))); assert.ok(/^Pending/.test(LP.needsWord("pending"))); assert.ok(/^Stopped/.test(LP.needsWord("stopped")));
  assert.strictEqual(LP.needsWord(null, "x"), ""); assert.strictEqual(LP.needsWord("bogus", "x"), "");
  assert.strictEqual(LP.healthWord("Healthy"), "Health: healthy"); assert.strictEqual(LP.healthWord("Critical"), "Health: critical");
  assert.strictEqual(LP.healthWord("Warning"), "Health: warning"); assert.strictEqual(LP.healthWord("Unknown"), "Health: no reading"); assert.strictEqual(LP.healthWord(undefined), "Health: no reading");
  assert.ok(/aria-label", window\.LeftPane \? "Run state: "/.test(ht) && /badge\.setAttribute\("aria-label"/.test(ht));
  assert.ok(/dot\.setAttribute\("aria-label"/.test(rr));
  // red stays reserved for blocked: the left pane CSS never sets a red/blocked colour for anything else
  assert.ok(!/needs-blocked|health-critical|#b6342f|#dc2626/.test(css));
  // legend shapes in the dock and in C's card are the same classes the rows use
  assert.ok(LP.LEGEND.slice(0, 3).every((l, k) => l.cls === ["xp-lg xp-lg-off", "xp-lg xp-lg-ready", "xp-lg xp-lg-working"][k]));
});
t("v1.83.2 #4: one 'N coming' line instead of 'soon' on every tile; soon tiles keep contrast (no opacity)", () => {
  assert.strictEqual(LP.comingLine(4), "4 coming"); assert.strictEqual(LP.comingLine(1), "1 coming"); assert.strictEqual(LP.comingLine(0), "");
  assert.ok(!/lp-soon-tag/.test(rsrc) && !/lp-soon-tag/.test(css));
  const soonRule = css.match(/#systems-group \.lp-soon \{[^}]*\}/)[0];
  assert.ok(!/opacity/.test(soonRule) && !/dashed/.test(soonRule));
  // live tiles: Health and Tools (data-system-nav) replace their placeholders, so with both live only Tasks and Reviews are coming
  assert.strictEqual(LP.planTiles(["argus"], ["health", "tools"]).filter((x) => x.kind === "soon").length, 2);
});
t("v1.84.3: the dock border is neutral, accent only while the selected agent is working (.lp-dock-working)", () => {
  const base = css.match(/#lp-dock \{[^}]*\}/)[0];
  assert.ok(/min-height: 24px|height: 28px/.test(css), "Pause and (i) keep a 24-28px hit area");
  assert.ok(/1px solid var\(--border\)/.test(base) && !/accent/.test(base));
  assert.ok(/#lp-dock\.lp-dock-working \{[^}]*accent/.test(css) && /lp-dock-working/.test(rsrc));
});
t("v1.83.2 #6: one tile label style (weight 500, mixed case) for both layouts, covering every tile type", () => {
  const blk = css.slice(css.indexOf("v1.83.2: one label style"));
  for (const c of ["argus-nav-title", "memory-nav-title", "iris-nav-title", "daily-nav-name", "health-nav-name", "tools-nav-name", "library-nav-title", "lp-soon-name"]) assert.ok(blk.includes(c), c);
  assert.ok(/font-weight: 500; letter-spacing: \.01em; text-transform: none;/.test(blk) && /body\.lp-c #systems-group #library-nav::after/.test(blk));
  assert.ok(!/text-transform: uppercase;/.test(css.replace(/::first-letter \{ text-transform: uppercase; \}/g, "")));
});
console.log(`leftpane.test.js: ${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
