// node tests/research-figures.test.js - MY RESEARCH magazine view (v1.91.0): the deterministic figure parser (src/research/figures.js).
// A chart only from figures written in the finding, only when there are >= 2 comparable numbers (same unit) in one sentence; uncertain
// text gives no chart. Real W41 findings (tests/fixtures/research-figures-w41.json, copied read-only) plus, when the live folder exists,
// every finding in shared_reports\research\2026-W41 (read-only).
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const F = require("../src/research/figures");

let n = 0, fails = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.log("FAIL " + name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); } }
const W41 = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "research-figures-w41.json"), "utf8")).findings;
const byId = (id) => W41.find((x) => x.id === id);
const texts = (c) => c.bars.map((b) => b.text);
const one = (s) => F.extractCharts({ title: "", whatChanged: "", soWhat: s });

t("parseNum: thousands, decimals, K/M/B, %, currency, approx; years and ids are not figures", () => {
  assert.deepStrictEqual([F.parseNum("26.4K").value, F.parseNum("1,316").value, F.parseNum("~20K").value, F.parseNum("20M").value, F.parseNum("40%").value, F.parseNum("$52").value], [26400, 1316, 20000, 20000000, 40, 52]);
  assert.strictEqual(F.parseNum("~20K").approx, true);
  assert.strictEqual(F.parseNum("26.4K").cls, F.parseNum("1.2M").cls, "K and M are both abbreviated counts");
  assert.notStrictEqual(F.parseNum("790").cls, F.parseNum("39.5K").cls, "a bare count and an abbreviated count are different units");
  assert.notStrictEqual(F.parseNum("40%").cls, F.parseNum("40").cls);
  assert.notStrictEqual(F.parseNum("$5").cls, F.parseNum("€5").cls);
  for (const y of ["2024", "2026", "1999"]) assert.strictEqual(F.parseNum(y), null, y);
  assert.ok(F.parseNum("2,026"), "a comma means a count, not a year");
  assert.strictEqual(F.parseNum("abc"), null);
});

// ---------------------------------------------------------------- the real W41 findings that MUST chart
t("W41 YouTube Agent: views 26.4K -> 39.5K charts first (the so-what), engaged/daily figures chart second", () => {
  const cs = F.extractCharts(byId("yt-view-count-first-frame-2026-08-24"));
  assert.deepStrictEqual(texts(cs[0]), ["26.4K", "39.5K"]);
  assert.strictEqual(cs[0].title, "Views");
  assert.ok(cs.some((c) => texts(c).join() === "~790,~1,300,~680"), "daily views ~790 -> ~1,300 and engagedViews flat ~680 (one sentence, same unit)");
  assert.strictEqual(F.chartFor(byId("yt-view-count-first-frame-2026-08-24")).figure, "26.4K → 39.5K");
});
t("W41 Analytics Agent: ~20K engaged (flat) with 39.5K views, and daily views 790 -> 1,316", () => {
  const cs = F.extractCharts(byId("youtube-view-count-from-first-frame-2026-08-24"));
  assert.deepStrictEqual(texts(cs[0]), ["790", "1,316"]); assert.strictEqual(cs[0].title, "Daily views");
  const k = cs.find((c) => texts(c).indexOf("~20K") >= 0);
  assert.ok(k, "~20K engaged charts");
  assert.deepStrictEqual(texts(k), ["~20K", "39.5K"]);
  assert.deepStrictEqual(k.bars.map((b) => b.label), ["engagedViews, flat", "views, Sep"]);
});
t("W41 YPP: 4,000 -> 8,000 watch hours (now vs from 1 Feb 2027); Shorts 10M -> 20M as a second chart; never mixed", () => {
  const f = byId("ypp-thresholds-double-2027-02-01");
  const cs = F.extractCharts(f);
  assert.deepStrictEqual(texts(cs[0]), ["4,000", "8,000"]);
  assert.deepStrictEqual(cs[0].bars.map((b) => b.label), ["Now", "From 1 Feb 2027"]);
  assert.strictEqual(cs[0].title, "Watch hours");
  assert.deepStrictEqual(texts(cs[1]), ["10M", "20M"]);
  const c = F.chartFor(f);
  assert.strictEqual(c.figure, "4,000 → 8,000");
  assert.strictEqual(c.figureLine, "Watch hours, from 1 Feb 2027");
});
t("W41 Analytics: organic search 2,088 -> 2,184 per 28 days (unit kept in the title)", () => {
  const c = F.extractCharts(byId("review-publishers-ai-overviews-affiliate-drop"))[0];
  assert.deepStrictEqual(texts(c), ["2,088", "2,184"]); assert.strictEqual(c.title, "Organic search, per 28 days");
});

// ---------------------------------------------------------------- prose that must NOT chart
t("W41 prose with unrelated numbers gives no chart (Amazon rates, GA4 channel, Meta, Legal terms, FTC, Studio AI, WooCommerce versions)", () => {
  for (const id of ["amazon-associates-2026-rate-cuts-attribution", "ga4-ai-assistant-channel-may-2026", "meta-fb-insights-views-replace-reach-2026-06-15", "anthropic-agent-sdk-public-tool-auth", "disclosure-enforcement-ftc-cma-il", "made-on-youtube-2026-studio-ai", "woocommerce-9-7-3-four-open-advisories"]) {
    assert.deepStrictEqual(F.extractCharts(byId(id)), [], id);
    assert.strictEqual(F.chartFor(byId(id)), null, id);
  }
});
t("uncertain shapes are skipped: ranges, 'up to', 'vs', years, versions, ids, small ranges, mixed units", () => {
  for (const s of [
    "Some publishers lost 20-40% of affiliate revenue.",
    "Amazon cut commissions by up to 50% in some categories.",
    "Our CTR is 2.2% vs ~6% history.",
    "Traffic moved from 2024 to 2026 in steps.",
    "Upgrade WooCommerce from 9.7 to 11.1 on staging.",
    "Install KB5122878 and Graph API v25 to v26.",
    "Invite 5 to 10 people to the beta.",
    "Views went from 790 to 39.5K after the change.",
    "Revenue fell from $146 to 52 EUR.",
    "Watch hours (now 4,000) are listed.",
    "engagedViews stayed flat (~680).",
    "The rate is 4% and the cap is 8,000 hours.",
  ]) assert.deepStrictEqual(one(s), [], s);
});
t("clear shapes chart: from/to, arrows, (now X), and a flat + moved pair in one sentence", () => {
  assert.deepStrictEqual(texts(one("Subscribers grew from 1,200 to 1,850 this quarter.")[0]), ["1,200", "1,850"]);
  assert.deepStrictEqual(texts(one("The bar moves 4,000 -> 8,000 hours.")[0]), ["4,000", "8,000"]);
  assert.deepStrictEqual(texts(one("The bar moves 4,000 → 8,000 hours.")[0]), ["4,000", "8,000"]);
  assert.deepStrictEqual(texts(one("New channels need 20M Shorts views (now 10M).")[0]), ["10M", "20M"]);
  assert.deepStrictEqual(texts(one("Clicks stayed flat (~300) while sessions rose to 900 in May.")[0]), ["~300", "900"]);
  assert.deepStrictEqual(texts(one("Bounce rate dropped (48% to 31%).")[0]), ["48%", "31%"]);
});
t("only figures from the finding: every bar's text appears verbatim in the finding; a chart never has fewer than 2 or more than 6 bars", () => {
  for (const f of W41) for (const c of F.extractCharts(f)) {
    const all = [f.title, f.whatChanged, f.soWhat].join(" ");
    assert.ok(c.bars.length >= 2 && c.bars.length <= 6);
    for (const b of c.bars) assert.ok(all.indexOf(b.text) >= 0, f.id + ": " + b.text);
    assert.ok(c.bars.every((b) => b.value > 0));
  }
});
t("labels from the finding's own words where they exist ('Sep', 'Daily views, from 27 Aug'); the title is never repeated in every label", () => {
  const yt = F.extractCharts(byId("yt-view-count-first-frame-2026-08-24"));
  assert.strictEqual(yt[0].title, "Views");
  assert.deepStrictEqual(yt[0].bars.map((b) => b.label), ["Before", "Sep"], "'Sep 2026 views jump (26.4K to 39.5K)': one subject, so the bars do not say 'Views' again");
  assert.deepStrictEqual(yt[1].bars.map((b) => b.label), ["Daily views, before", "Daily views, from 27 Aug", "engagedViews, flat"]);
  assert.deepStrictEqual(one("Bounce rate dropped (48% to 31%).")[0].bars.map((b) => b.label), ["Before", "After"]);
  assert.deepStrictEqual(one("It went from 1,200 to 1,850.")[0].bars.map((b) => b.label), ["Before", "After"]);
});
t("cost cap: hostile 6000-character texts stay under 10 ms per finding (only the first 800 characters, <= 12 matches per shape)", () => {
  const L = 6000, fill = (u) => u.repeat(Math.ceil(L / u.length)).slice(0, L);
  for (const u of ["1->", "1,000 to 2,000 ", "1 a b c (now 2) ", "Views flat (1 ", "Views rose to 1,000 in Sep ", "alpha beta 100 to 200 ", "1", "from "]) {
    const t0 = process.hrtime.bigint();
    F.chartFor({ title: fill(u).slice(0, 300), whatChanged: fill(u), soWhat: fill(u) });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 10, JSON.stringify(u) + " took " + ms.toFixed(1) + " ms");
  }
});
t("pure and deterministic: same input, same output; bad input is safe", () => {
  const f = byId("ypp-thresholds-double-2027-02-01");
  assert.deepStrictEqual(F.extractCharts(f), F.extractCharts(JSON.parse(JSON.stringify(f))));
  for (const bad of [null, undefined, 5, "x", {}, { soWhat: 7 }]) assert.deepStrictEqual(F.extractCharts(bad), []);
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "research", "figures.js"), "utf8");
  assert.ok(!/require\(|Date\.now|Math\.random|process\./.test(src.replace(/\/\/.*$/gm, "")), "no I/O, clock or randomness");
});
t("live W41 folder (read-only, skipped when absent): at least 3 findings chart and every bar is a figure from its finding", () => {
  const d = "C:\\Example\\Workspace\\shared_reports\\research\\2026-W41";
  if (!fs.existsSync(d)) { console.log("  (live W41 folder not found: skipped)"); return; }
  let charted = 0;
  for (const name of fs.readdirSync(d).filter((x) => /\.json$/.test(x) && x[0] !== "_")) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(d, name), "utf8").replace(/^\uFEFF/, "")); } catch (e) { continue; }
    for (const f of Array.isArray(j.findings) ? j.findings : []) {
      if (!f || typeof f !== "object") continue;
      const c = F.chartFor(f); if (!c) continue;
      charted++;
      const all = [f.title, f.whatChanged, f.soWhat].join(" ");
      for (const b of c.bars) assert.ok(all.indexOf(b.text) >= 0, name + " " + f.id + ": " + b.text);
    }
  }
  assert.ok(charted >= 3, "charted " + charted);
});

console.log(fails ? fails + " of " + n + " FAILED" : "research-figures: all " + n + " tests passed");
process.exit(fails ? 1 : 0);
