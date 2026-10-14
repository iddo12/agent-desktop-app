// Sandbox check of the My Health visual pane (v1.114.0): launches the worktree's Electron in TEST MODE (hidden window, CDP port),
// points the pane at a SYNTHETIC feed, drives it over CDP and writes screenshots + a JSON of DOM checks.
//   node tools/health-pane-sandbox.cjs <scenario> <outDir> [playwright-core path]
// v1.121.0: no machine-specific paths: AD_PLAYWRIGHT (or the 3rd argument) = playwright-core folder (default: found by require);
// AGENT_DESKTOP_ROOT = fixture agents (default: <AGENT_DESKTOP_WORK or temp>\AgentDesktopSandbox\agents).
// scenarios: sample | five | max | stale | missing | minimal | newer
// Never touches the live app: own userData (test mode), own debug port, killed by PID at the end.
"use strict";
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const scenario = process.argv[2] || "sample", outDir = process.argv[3] || ".";
const pwPath = process.argv[4] || process.env.AD_PLAYWRIGHT || "playwright-core";
const { chromium } = require(pwPath);
const repo = path.join(__dirname, "..");
const fx = (n) => path.join(repo, "tests", "fixtures", n).replace(/\\/g, "/");
const FEEDS = { sample: null, five: fx("health_pane_variants/five_digit_steps.json"), max: fx("health_pane_variants/max_digit_steps.json"), stale: fx("health_pane_variants/stale.json"),
  missing: fx("health_pane_variants/does_not_exist.json"), minimal: fx("health_pane_variants/minimal.json"), newer: fx("health_pane_variants/newer.json") };
const PORT = 9333;
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const env = Object.assign({}, process.env, { AGENT_DESKTOP_TEST_MODE: "1", AGENT_DESKTOP_ROOT: process.env.AGENT_DESKTOP_ROOT || path.join(process.env.AGENT_DESKTOP_WORK || require("os").tmpdir(), "AgentDesktopSandbox", "agents"), AGENT_DESKTOP_HIDDEN: "1" });
  if (FEEDS[scenario]) env.AGENT_DESKTOP_HEALTH_PANE_FEED = FEEDS[scenario];
  if (scenario !== "stale") env.AGENT_DESKTOP_HEALTH_PANE_NOW = "2026-10-11T17:00:00+03:00";
  const exe = path.join(repo, "node_modules", "electron", "dist", "electron.exe");
  const child = spawn(exe, [repo, "--remote-debugging-port=" + PORT], { env, stdio: "ignore", windowsHide: true });
  const result = { scenario, checks: {} };
  try {
    await sleep(9000);
    const browser = await chromium.connectOverCDP("http://127.0.0.1:" + PORT);
    const page = browser.contexts()[0].pages().find((p) => /index\.html/.test(p.url())) || browser.contexts()[0].pages()[0];
    await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
    const cdp = await browser.contexts()[0].newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await cdp.send("Page.enable").catch(() => {});
    // direct CDP capture: does not wait for a paint frame, so it also works while the window is hidden
    const shot = async (name) => { for (let k = 0; k < 3; k++) { try { const r = await Promise.race([cdp.send("Page.captureScreenshot", { format: "png" }), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000))]); fs.writeFileSync(path.join(outDir, scenario + "_" + name + ".png"), Buffer.from(r.data, "base64")); return; } catch (e) { await sleep(700); } } (result.shotErrors = result.shotErrors || []).push(name); };
    await page.evaluate(() => document.querySelector(".health-nav").click());
    await page.waitForSelector("#health-view .hv", { timeout: 15000 });
    await sleep(800);
    const ringCheck = () => page.evaluate(() => Array.from(document.querySelectorAll(".hv-ring")).map((w) => {
      const num = w.querySelector(".hv-ring-num"), r = w.getBoundingClientRect(), n = num.getBoundingClientRect(), d = +w.dataset.d, st = +w.dataset.stroke;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = (d - 2 * st) / 2;
      const corners = [[n.left, n.top], [n.right, n.top], [n.left, n.bottom], [n.right, n.bottom]].map(([x, y]) => Math.hypot(x - cx, y - cy));
      return { text: num.textContent, font: num.style.fontSize, textWidth: Math.round(n.width), innerRadius: Math.round(R), maxCornerDist: Math.round(Math.max.apply(null, corners)), insideInnerCircle: Math.max.apply(null, corners) <= R };
    }));
    const text = () => page.evaluate(() => document.querySelector("#health-view .hv").innerText);
    const click = (sel, txt) => page.evaluate(([s, t]) => { const e = Array.from(document.querySelectorAll(s)).find((x) => !t || x.textContent.trim().indexOf(t) === 0); if (!e) return false; e.click(); return true; }, [sel, txt]);

    result.checks.firstText = (await text()).slice(0, 600);
    result.checks.bannerPresent = await page.evaluate(() => !!document.querySelector(".hv-banner"));
    result.checks.emptyPresent = await page.evaluate(() => !!document.querySelector(".hv-empty"));
    result.checks.legendPresent = await page.evaluate(() => !!document.querySelector(".hv-legend"));
    result.checks.rings = await page.evaluate(() => 1) && await ringCheck();
    await shot("today");
    if (["sample", "five", "max", "minimal"].indexOf(scenario) >= 0) {
      result.checks.tiles = await page.evaluate(() => document.querySelectorAll(".hv-tile").length);
      result.checks.noDataTiles = await page.evaluate(() => document.querySelectorAll(".hv-tile.nodata").length);
      // hide numbers
      await click(".hv-iconbtn[data-role=eye]"); await sleep(300);
      result.checks.hidden = await page.evaluate(() => { const nums = Array.from(document.querySelectorAll("#health-view .hv-num")); return { numCount: nums.length, withDigits: nums.filter((n) => /\d/.test(n.textContent)).map((n) => n.textContent).slice(0, 8), sample: nums.slice(0, 4).map((n) => n.textContent) }; });
      result.checks.hiddenRings = await ringCheck();
      await shot("today_hidden");
      await click(".hv-iconbtn[data-role=eye]"); await sleep(300);
    }
    if (scenario === "sample") {
      await click(".hv-seg-b", "Day story"); await sleep(400); await shot("day"); result.checks.dayRows = await page.evaluate(() => document.querySelectorAll(".hv-row").length);
      await click(".hv-seg-b", "Activity level"); await sleep(400); await shot("activity"); result.checks.activityDots = await page.evaluate(() => document.querySelectorAll(".hv-dot").length);
      result.checks.quadrantLabels = await page.evaluate(() => Array.from(document.querySelectorAll(".hv-ql")).map((t) => t.textContent));
      await click(".hv-seg-b", "Overview"); await sleep(300);
      await click(".hv-tile.hero.sleep"); await sleep(300); await click(".hv-seg-b", "Month"); await sleep(300);
      await click(".hv-btn", "Back to Overview"); await sleep(300);
      await page.evaluate(() => { const t = Array.from(document.querySelectorAll(".hv-tile")).find((x) => /Resting heart/.test(x.textContent)); t.click(); }); await sleep(400); await shot("history_hr_week");
      await click(".hv-seg-b", "Month"); await sleep(300); await shot("history_hr_month");
      await click(".hv-btn", "Back to Overview"); await sleep(300);
      await page.evaluate(() => { const t = Array.from(document.querySelectorAll(".hv-tile")).find((x) => /Steps today/.test(x.textContent)); t.click(); }); await sleep(300);
      await click(".hv-seg-b", "Overview"); await sleep(300);
      // Periodic
      await click(".hl-tab", "Periodic"); await sleep(500); await shot("periodic");
      result.checks.periodicText = (await text()).slice(0, 900);
      await click(".hv-details-btn", "Details"); await sleep(300); await page.evaluate(() => { const b = Array.from(document.querySelectorAll(".hv-details-btn")); b.forEach((x) => { if (x.textContent === "Details") x.click(); }); }); await sleep(400); await shot("periodic_details");
      result.checks.markerRows = await page.evaluate(() => document.querySelectorAll(".hv-mrow").length);
      // narrow
      await page.setViewportSize({ width: 790, height: 900 }).catch(() => {}); await sleep(500);
      await click(".hl-tab", "Today"); await sleep(500); await shot("narrow_today");
      result.checks.narrowRings = await ringCheck();
      result.checks.horizontalScroll = await page.evaluate(() => document.querySelector("#health-view .hl-body").scrollWidth > document.querySelector("#health-view .hl-body").clientWidth + 2);
    }
    if (scenario === "five" || scenario === "max") { result.checks.stepsRingOnly = (await ringCheck()).filter((r) => /\d,\d{3}/.test(r.text)); }
    const errs = await page.evaluate(() => 1); result.ok = true;
    await browser.close().catch(() => {});
  } catch (e) { result.ok = false; result.error = String(e && e.message || e).slice(0, 500); }
  try { execSync("taskkill /PID " + child.pid + " /T /F", { stdio: "ignore" }); } catch (e) { /* gone */ }
  fs.writeFileSync(path.join(outDir, scenario + "_checks.json"), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1).slice(0, 6000));
})();
