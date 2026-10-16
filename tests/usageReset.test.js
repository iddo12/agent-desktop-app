// node tests/usageReset.test.js - reset time on the 5h / 7d usage bars (v1.124.0): pure time maths and labels with a fixed clock,
// the archive.js plumbing (buildResetInfo with a fixture usage file), and static guards on the renderer wiring.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const root = path.join(__dirname, "..", "src");
const UR = require(path.join(root, "usageReset.js"));
let n = 0, fails = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.log("FAIL " + name + "\n  " + (e && e.stack || e)); } }

const H = 3600e3, M = 60e3, D = 24 * H;
const GB = { locale: "en-GB", timeZone: "Asia/Jerusalem" };
const iso = (ms) => new Date(ms).toISOString();
// Wed 14 Oct 2026 12:00 UTC = 15:00 in Jerusalem (UTC+3 until 25 Oct)
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

t("elapsed fraction: start, middle, end, clamped, unusable", () => {
  assert.strictEqual(UR.elapsedFraction(NOW + 5 * H, NOW, "5h"), 0);
  assert.strictEqual(UR.elapsedFraction(NOW + 2.5 * H, NOW, "5h"), 0.5);
  assert.ok(Math.abs(UR.elapsedFraction(NOW + 1 * H + 50 * M, NOW, "5h") - (1 - 110 / 300)) < 1e-9);
  assert.ok(Math.abs(UR.elapsedFraction(NOW + 3.5 * D, NOW, "7d") - 0.5) < 1e-9);
  assert.strictEqual(UR.elapsedFraction(NOW + 9 * H, NOW, "5h"), 0);     // further away than a window: clamp
  assert.strictEqual(UR.elapsedFraction(NOW, NOW, "5h"), null);          // already reset
  assert.strictEqual(UR.elapsedFraction(NOW - 1, NOW, "7d"), null);
  assert.strictEqual(UR.elapsedFraction(NaN, NOW, "7d"), null);
  assert.strictEqual(UR.elapsedFraction(NOW + H, NOW, "1y"), null);
});
t("span text: Xh Ym, under an hour, days, rounds down", () => {
  assert.strictEqual(UR.formatSpan(110 * M), "1h 50m");
  assert.strictEqual(UR.formatSpan(42 * M + 59e3), "42m");
  assert.strictEqual(UR.formatSpan(2 * H), "2h");
  assert.strictEqual(UR.formatSpan(29 * H), "1d 5h");
  assert.strictEqual(UR.formatSpan(2 * D), "2d");
  assert.strictEqual(UR.formatSpan(30e3), "<1m");
  assert.strictEqual(UR.formatSpanLong(29 * H), "1 day 5 hours");
  assert.strictEqual(UR.formatSpanLong(110 * M), "1 hour 50 minutes");
  assert.strictEqual(UR.formatSpanLong(42 * M), "42 minutes");
  assert.strictEqual(UR.formatSpanLong(1 * M), "1 minute");
  assert.strictEqual(UR.formatAgo(845), "14 h ago");
  assert.strictEqual(UR.formatAgo(35), "35 min ago");
  assert.strictEqual(UR.formatAgo(3 * 1440), "3 d ago");
  assert.strictEqual(UR.formatAgo(null), null);
});
t("5h label: hours+minutes, minutes only, warning under 15 min", () => {
  const mk = (ms) => UR.describe({ resetKnown: true, resetsAt: iso(NOW + ms), lastReadingAt: iso(NOW - 10 * M) }, "5h", NOW);
  assert.deepStrictEqual(UR.label(mk(110 * M), NOW, GB), { text: "1h 50m", extra: "", warn: false, unknown: false });
  assert.deepStrictEqual(UR.label(mk(42 * M), NOW, GB), { text: "42m", extra: "", warn: false, unknown: false });
  assert.strictEqual(UR.label(mk(14 * M + 59e3), NOW, GB).warn, true);
  assert.strictEqual(UR.label(mk(15 * M), NOW, GB).warn, false);
});
t("7d label: local day name and time, today on the same local day", () => {
  const reset = Date.UTC(2026, 9, 15, 16, 0, 0);                       // Thu 15 Oct 19:00 Jerusalem
  const d = UR.describe({ resetKnown: true, resetsAt: iso(reset), lastReadingAt: iso(NOW - 845 * M) }, "7d", NOW);
  assert.deepStrictEqual(UR.label(d, NOW, GB), { text: "Thu 19:00", extra: "(in 1d 4h)", warn: false, unknown: false });
  const same = UR.describe({ resetKnown: true, resetsAt: iso(Date.UTC(2026, 9, 14, 16, 0, 0)), lastReadingAt: iso(NOW) }, "7d", NOW);
  assert.strictEqual(UR.label(same, NOW, GB).text, "today 19:00");
  // today is decided in the person's zone, not UTC: 23:30 UTC on the 14th is already the 15th in Jerusalem
  const late = Date.UTC(2026, 9, 14, 23, 30, 0);
  assert.strictEqual(UR.label(UR.describe({ resetKnown: true, resetsAt: iso(late), lastReadingAt: iso(NOW) }, "7d", NOW), NOW, GB).text, "Thu 02:30");
  const us = UR.label(d, NOW, { locale: "en-US", timeZone: "America/New_York" });
  assert.ok(/^Thu 12:00\s?PM$/.test(us.text), us.text);
});
t("DST edge: label follows the zone clock change, remaining time stays absolute", () => {
  // US clocks go back Sun 1 Nov 2026 06:00 UTC. Now = Fri 30 Oct 12:00 UTC; reset Mon 2 Nov 12:00 UTC = 07:00 EST (not 08:00)
  const now = Date.UTC(2026, 9, 30, 12, 0, 0), reset = Date.UTC(2026, 10, 2, 12, 0, 0);
  const d = UR.describe({ resetKnown: true, resetsAt: iso(reset), lastReadingAt: iso(now) }, "7d", now);
  const o = { locale: "en-GB", timeZone: "America/New_York" };
  assert.strictEqual(UR.label(d, now, o).text, "Mon 07:00");
  assert.strictEqual(UR.label(d, now, o).extra, "(in 3d)");
  assert.ok(UR.sentence(d, now, o).startsWith("Resets Mon 2 Nov, 07:00 (in 3 days)."), UR.sentence(d, now, o));
  assert.ok(UR.sameLocalDay(Date.UTC(2026, 10, 1, 4, 30), Date.UTC(2026, 10, 1, 5, 30), o));   // 00:30 EDT and 01:30 EDT, same day
  assert.ok(UR.sameLocalDay(Date.UTC(2026, 10, 1, 4, 30), Date.UTC(2026, 10, 1, 23, 0), o));   // across the repeated hour, still 1 Nov
});
t("tooltip sentence matches the agreed wording", () => {
  const reset = Date.UTC(2026, 9, 15, 16, 0, 0);
  const d = UR.describe({ resetKnown: true, resetsAt: iso(reset), lastReadingAt: iso(NOW - 14 * H) }, "7d", NOW);
  assert.strictEqual(UR.sentence(d, NOW, GB), "Resets Thu 15 Oct, 19:00 (in 1 day 4 hours). Last real reading 14 h ago.");
});
t("unknown: resetKnown false, null, past, garbage, or more than a window away", () => {
  for (const raw of [
    { resetKnown: false, resetsAt: iso(NOW + H) }, { resetKnown: true, resetsAt: null }, { resetKnown: true, resetsAt: "nope" },
    { resetKnown: true, resetsAt: iso(NOW - 1) }, { resetKnown: true, resetsAt: iso(NOW) }, { resetKnown: true, resetsAt: iso(NOW + 6 * H) },
    { resetsAt: iso(NOW + H) }, null, undefined, {},
  ]) {
    const d = UR.describe(raw, "5h", NOW);
    assert.strictEqual(d.known, false, JSON.stringify(raw));
    assert.strictEqual(d.fraction, null);
    assert.strictEqual(d.resetsAtMs, null);
    assert.deepStrictEqual(UR.label(d, NOW, GB), { text: "reset unknown", extra: "", warn: false, unknown: true });
    assert.ok(!/\d{1,2}:\d{2}/.test(UR.sentence(d, NOW, GB)), "no clock time for an unknown reset");
  }
  assert.strictEqual(UR.sentence(UR.describe({ resetKnown: false, ageMin: 845 }, "7d", NOW), NOW, GB), "Reset time unknown. Last real reading 14 h ago.");
  assert.strictEqual(UR.sentence(UR.describe({}, "7d", NOW), NOW, GB), "Reset time unknown.");
});
t("stale 5h reading (older than 300 min) makes the 5h reset unknown even if one is listed; 7d is not affected", () => {
  const raw = { resetKnown: true, resetsAt: iso(NOW + 2 * H), lastReadingAt: iso(NOW - 301 * M) };
  assert.strictEqual(UR.describe(raw, "5h", NOW).known, false);
  assert.strictEqual(UR.describe(Object.assign({}, raw, { lastReadingAt: iso(NOW - 299 * M) }), "5h", NOW).known, true);
  assert.strictEqual(UR.describe(Object.assign({}, raw, { resetsAt: iso(NOW + 2 * D) }), "7d", NOW).known, true);
});
t("reading older than its window: readingTooOld (question mark instead of a percentage)", () => {
  assert.strictEqual(UR.describe({ lastReadingAt: iso(NOW - 301 * M) }, "5h", NOW).readingTooOld, true);
  assert.strictEqual(UR.describe({ lastReadingAt: iso(NOW - 299 * M) }, "5h", NOW).readingTooOld, false);
  assert.strictEqual(UR.describe({ ageMin: 845 }, "7d", NOW).readingTooOld, false);
  assert.strictEqual(UR.describe({ ageMin: 8 * 1440 }, "7d", NOW).readingTooOld, true);
  assert.strictEqual(UR.describe({}, "5h", NOW).readingTooOld, false);
});
t("age keeps growing from the reading timestamp; falls back to ageMin", () => {
  assert.strictEqual(UR.readingAgeMin({ lastReadingAt: iso(NOW - 90 * M), ageMin: 5 }, NOW), 90);
  assert.strictEqual(UR.readingAgeMin({ ageMin: 5 }, NOW), 5);
  assert.strictEqual(UR.readingAgeMin({}, NOW), null);
});
t("fixed clock moves the label: same input, 30 s later", () => {
  const raw = { resetKnown: true, resetsAt: iso(NOW + 110 * M + 20e3), lastReadingAt: iso(NOW) };
  assert.strictEqual(UR.label(UR.describe(raw, "5h", NOW), NOW, GB).text, "1h 50m");
  assert.strictEqual(UR.label(UR.describe(raw, "5h", NOW + 30e3), NOW + 30e3, GB).text, "1h 49m");
});

// ---- archive.js plumbing: buildResetInfo reads the usage file the app is configured with ----
const archive = require(path.join(root, "archive.js"));
function withFixture(obj, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-usagereset-"));
  const f = path.join(dir, "usage_now.json");
  fs.writeFileSync(f, obj === null ? "{ not json" : "﻿" + JSON.stringify(obj));
  const prev = process.env.AGENT_DESKTOP_THROTTLE_FILE;
  process.env.AGENT_DESKTOP_THROTTLE_FILE = f;
  try { return fn(); } finally { if (prev === undefined) delete process.env.AGENT_DESKTOP_THROTTLE_FILE; else process.env.AGENT_DESKTOP_THROTTLE_FILE = prev; fs.rmSync(dir, { recursive: true, force: true }); }
}
t("buildResetInfo: usage file with a known 7d reset and an unknown 5h reset", () => {
  const at = new Date(Date.now() - 845 * M).toISOString();
  const info = withFixture({ at: new Date().toISOString(), lastReading: { at, ageMin: 845 }, windows: { "5h": { usedPct: 12, resetsAt: null, resetKnown: false }, "7d": { usedPct: 71, resetsAt: "2026-10-15T16:00:00.000Z", resetKnown: true } } }, () => archive.buildResetInfo(null));
  assert.strictEqual(info["5h"].resetKnown, false);
  assert.strictEqual(info["5h"].resetsAt, null);
  assert.strictEqual(info["7d"].resetKnown, true);
  assert.strictEqual(info["7d"].resetsAt, "2026-10-15T16:00:00.000Z");
  assert.strictEqual(info["7d"].lastReadingAt, at);
  assert.ok(Math.abs(info["7d"].ageMin - 845) <= 1);
});
t("buildResetInfo: older sources without the fields give unknown; a statusLine reset (epoch seconds) is used when the model has none", () => {
  const bare = withFixture({ at: new Date().toISOString(), windows: { "5h": { usedPct: 1 }, "7d": { usedPct: 2 } } }, () => archive.buildResetInfo(null));
  assert.strictEqual(bare["5h"].resetKnown, false);
  assert.strictEqual(bare["7d"].resetKnown, false);
  assert.strictEqual(bare["7d"].lastReadingAt, null);
  const sec = Math.floor(Date.now() / 1000) + 3600;
  const viaStatus = withFixture(null, () => archive.buildResetInfo({ fiveHour: { usedPct: 3, resetsAt: sec, ageSeconds: 120 }, sevenDay: null }));
  assert.strictEqual(viaStatus["5h"].resetKnown, true);
  assert.strictEqual(viaStatus["5h"].resetsAt, new Date(sec * 1000).toISOString());
  assert.strictEqual(viaStatus["5h"].ageMin, 2);
  assert.strictEqual(viaStatus["7d"].resetKnown, false);
});
t("buildResetInfo: no usage file configured never throws", () => {
  const prev = process.env.AGENT_DESKTOP_THROTTLE_FILE; delete process.env.AGENT_DESKTOP_THROTTLE_FILE;
  try { const i = archive.buildResetInfo(null); assert.strictEqual(i["5h"].resetKnown, false); } finally { if (prev !== undefined) process.env.AGENT_DESKTOP_THROTTLE_FILE = prev; }
});

// ---- renderer wiring (static, like topbar.test.js: the repo has no DOM harness) ----
const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");
const ht = rd("renderer/header-tasks.js"), rj = rd("renderer/renderer.js"), html = rd("renderer/index.html"), css = rd("renderer/styles-topbar.css");
t("wiring: pure helper loads before header-tasks.js; renderer.js hands resetInfo over; archive returns it", () => {
  assert.ok(html.indexOf("../usageReset.js") > 0 && html.indexOf("../usageReset.js") < html.indexOf("header-tasks.js"));
  assert.ok(/xpUsageReset\.set\(windows\.resetInfo/.test(rj));
  assert.ok(/resetInfo: buildResetInfo\(confirmed\)/.test(rd("archive.js")));
});
t("header: tick, label, role=meter, aria-label sentence, focusable, one shared tooltip, one cleaned-up 30 s timer, no innerHTML", () => {
  assert.ok(/xp-m-tick/.test(ht) && /xp-m-rt/.test(ht));
  assert.ok(/setAttribute\("tabindex", "0"\)/.test(ht) && /addEventListener\("focus"/.test(ht) && /addEventListener\("blur"/.test(ht));
  assert.ok(/setAttribute\("role", "tooltip"\)/.test(ht) && /role", "meter"/.test(ht));
  assert.strictEqual((ht.slice(ht.indexOf("v1.124.0"), ht.indexOf("function buildMeterLegend")).match(/setInterval\(/g) || []).length, 1);
  assert.ok(/setInterval\([\s\S]*?30000\)/.test(ht) && /clearInterval\(resetTimer\)/.test(ht));
  const sect = ht.slice(ht.indexOf("v1.124.0"), ht.indexOf("function buildMeterLegend"));
  assert.ok(!/innerHTML/.test(sect));
});
t("css: tick uses logical (RTL-safe) offsets, unknown fill is hatched, label is 11px, narrow header drops the in-part", () => {
  assert.ok(/\.xp-m-tick[^}]*inset-inline-start/.test(css));
  assert.ok(/data-xp-reset="unknown"\][^}]*repeating-linear-gradient/.test(css));
  assert.ok(/\.xp-m-rt \{[^}]*font-size: 11px/.test(css));
  assert.ok(/\.xp-m-rin \{ display: none/.test(css));
});

console.log(n - fails + "/" + n + " usageReset checks passed");
process.exit(fails ? 1 : 0);
