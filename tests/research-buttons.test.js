// node tests/research-buttons.test.js - My Research v1.104.0: sticky layout (find bar sticky; Ask row and Legend scroll away), the Magazine
// reply status line keeps its own painter, and the pending-notes destination of an agent that is not running. Static + pure checks.
"use strict";
// v1.121.0: the agent roles come from the configuration; this test plays the original owner's roster through the environment layer
process.env.AGENT_DESKTOP_ROLE_COO = "COO Agent"; process.env.AGENT_DESKTOP_ROLE_SECURITY = "Security"; process.env.AGENT_DESKTOP_ROLE_OPTIMIZATION = "System Optimization*";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const js = read("src/renderer/research.js"), css = read("src/renderer/styles-research.css");
let n = 0, fails = 0;
function t(name, fn) { try { fn(); n++; console.log("ok  " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n  " + (e && e.stack || e)); } }
// the body of the first top-level CSS rule that starts with the selector
const rule = (sel) => { const i = css.indexOf("\n" + sel + " {"); if (i < 0) return ""; return css.slice(i, css.indexOf("}", i)); };

t("the find bar (Show + Search + chips + Showing N of M) is sticky at the top of the scrolling area", () => {
  const r = rule(".rs-findbar"); assert.ok(/position: sticky/.test(r) && /top: 0/.test(r), r); assert.ok(/z-index: \d+/.test(r));
});
t("the legend is not sticky (wide and narrow)", () => {
  assert.ok(!/position: sticky/.test(rule(".rs-legend")));
  const i = css.indexOf(".rs-lg-toggle { display: flex"); assert.ok(i > 0); assert.ok(!/position: sticky/.test(css.slice(i, css.indexOf("}", i))));
});
t("scroll-padding keeps focus/scrollIntoView targets out from under the sticky bar", () => { assert.ok(/\.rs-body \{[^}]*scroll-padding-top: \d+px/.test(css)); });
t("the Ask row is built into the scrolling page, not the fixed header", () => {
  const head = js.slice(js.indexOf("function renderHeader"), js.indexOf("function renderAskBar"));
  assert.ok(head.indexOf("renderAskBar(S)") < 0, "header must not append the ask bar");
  assert.ok(js.indexOf("main.appendChild(renderAskBar(S))") > 0);
});
t("onWrite paints the Magazine status line with the Magazine painter", () => {
  const s = js.slice(js.indexOf("S.onWrite = "), js.indexOf("S.setView = "));
  assert.ok(s.indexOf('classList.contains("rm-state")') > 0 && s.indexOf("paintMagState(o, r, agent)") > 0);
  assert.ok(s.indexOf("paintResult(out,") < 0, "onWrite must go through the mag-aware painter");
});
const W = require("../src/research/write.js");
t("pending note for the Optimization agent goes to the file that agent reads", () => {
  assert.strictEqual(W.pendingSlugs("System Optimization & Maintenance Agent")[0], "optimization_agent");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rsb-"));
  assert.strictEqual(path.basename(W.pendingFileFor(d, "System Optimization & Maintenance Agent")), "optimization_agent_pending_notes.md");
  fs.writeFileSync(path.join(d, "coo_pending_notes.md"), "x");
  assert.strictEqual(path.basename(W.pendingFileFor(d, "COO Agent")), "coo_pending_notes.md");
  assert.strictEqual(path.basename(W.pendingFileFor(d, "Security")), "security_pending_notes.md");
  fs.rmSync(d, { recursive: true, force: true });
});
console.log("\n" + n + " passed, " + fails + " failed"); process.exit(fails ? 1 : 0);
