// node tests/health-pane.test.js - My Health visual pane (v1.114.0): feed validation, stale logic, ring fitting, goal percentages,
// activity quadrants, tolerant parsing, the main-process reader (fixed path, test-only override, no leak), and wiring guards.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("../src/health/pane-logic");
const PF = require("../src/health/pane-feed");
const root = path.join(__dirname, "..");
let n = 0, failed = 0;
function ok(cond, msg) { n++; if (!cond) { failed++; console.error("FAIL: " + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + " (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")"); }
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const sample = JSON.parse(read("tests/fixtures/health_pane.sample.json"));

// ---- feed validation / tolerant parsing
{
  const r = L.normalizeFeed(sample);
  ok(r.ok, "the synthetic sample validates");
  ok(r.ok && Object.keys(r.feed.metrics).length === 14, "all 14 metrics kept");
  ok(r.ok && r.feed.goals.steps === 10000 && r.feed.goals.sleep_min === 480 && r.feed.goals.hard_min_week === 150, "goals from the feed (sleep 8 h, steps 10,000, 150 hard min)");
  ok(!("_comment" in r.feed), "unknown top-level keys are dropped");
  eq(L.normalizeFeed(null).code, "invalid", "null is invalid");
  eq(L.normalizeFeed([]).code, "invalid", "array is invalid");
  eq(L.normalizeFeed({ generated_at: "2026-10-11T16:30:00+03:00" }).code, "invalid", "no schema_version is invalid");
  eq(L.normalizeFeed({ schema_version: 1 }).code, "invalid", "no generated_at is invalid");
  eq(L.normalizeFeed({ schema_version: 1, generated_at: "not a date" }).code, "invalid", "bad generated_at is invalid");
  eq(L.normalizeFeed({ schema_version: 2, generated_at: "2026-10-11T16:30:00+03:00" }).code, "newer", "a newer schema is reported as newer, not parsed");
  eq(L.normalizeFeed({ schema_version: 0, generated_at: "2026-10-11T16:30:00+03:00" }).code, "invalid", "version 0 invalid");
  const min = L.normalizeFeed({ schema_version: 1, generated_at: "2026-10-11T16:30:00+03:00" });
  ok(min.ok && min.feed.sleep === null && min.feed.activity === null && min.feed.blood_tests === null && min.feed.nutrition === null && min.feed.cognitive === null && min.feed.day_detail === null, "missing blocks become null, not an error");
  ok(min.ok && Array.isArray(min.feed.sources) && Object.keys(min.feed.metrics).length === 0, "missing metrics block gives an empty metrics object");
  const odd = L.normalizeFeed({ schema_version: 1, generated_at: "2026-10-11T16:30:00+03:00", metrics: { steps: { now: "8430", prev: NaN, last7: [1, "x", null, Infinity], status: "weird", normal: "no", month: 5, years: [null, 3, { year: "2025", avg: 1 }] }, evil: { now: 1 }, __proto__: { x: 1 } }, goals: { steps: -5, sleep_min: "x", hard_min_week: 200 } });
  ok(odd.ok, "odd types do not throw");
  const m = odd.feed.metrics.steps;
  ok(m.now === null && m.prev === null && m.status === "none", "strings, NaN and unknown status are coerced to null / none");
  eq(m.last7, [1, null, null, null], "non-finite array items become null");
  eq(m.normal, [null, null], "bad range becomes [null, null]");
  ok(m.month === null && m.years.length === 1 && m.years[0].year === "2025", "bad month dropped, bad year rows dropped");
  ok(!("evil" in odd.feed.metrics), "unknown metric ids are dropped");
  ok(odd.feed.goals.steps === 10000 && odd.feed.goals.sleep_min === 480 && odd.feed.goals.hard_min_week === 200, "bad goals fall back to the defaults, good ones apply");
  const big = L.normalizeFeed({ schema_version: 1, generated_at: "2026-10-11T16:30:00+03:00", metrics: { steps: { now: 1, last7: new Array(100).fill(1), daily: new Array(2000).fill({ date: "2026-01-01", v: 1 }) } }, note: "x".repeat(5000) });
  ok(big.ok && big.feed.metrics.steps.last7.length === 7 && big.feed.metrics.steps.daily.length === 400 && big.feed.note.length === 200, "arrays and strings are capped");
  const bt = L.normalizeFeed(sample).feed.blood_tests;
  ok(bt.markers.length === 4 && bt.last_updated === "2026-05" && bt.next_due === "2026-11", "blood test block kept with month dates");
  eq(L.normalizeFeed(sample).feed.nutrition.days[0].photos, 3, "nutrition day kept");
  const asc = JSON.parse(JSON.stringify(sample)); asc.nutrition.days.reverse();
  eq(L.normalizeFeed(asc).feed.nutrition.days.map((d) => d.date), L.normalizeFeed(sample).feed.nutrition.days.map((d) => d.date), "nutrition days are newest first whatever order the generator writes (it writes oldest first)");
  ok(L.normalizeFeed(sample).feed.cognitive.series.length === 3, "cognitive series kept");
}

// ---- stale logic and sync text
{
  const g = "2026-10-11T16:30:00+03:00", t0 = Date.parse(g);
  ok(!L.staleInfo(g, t0 + 29 * 3600e3).stale, "29 h old is fresh");
  ok(L.staleInfo(g, t0 + 31 * 3600e3).stale, "31 h old is stale");
  ok(L.staleInfo(g, t0 - 5 * 3600e3).stale, "a feed dated 5 h in the future is NOT fresh");
  eq(L.staleInfo(g, t0 + 3 * 86400e3).text, "3 days ago", "3 days text");
  eq(L.staleInfo(g, t0 + 5 * 3600e3).text, "5 hours ago", "hours text");
  ok(L.staleInfo("garbage", t0).stale, "an unparsable time is stale");
  const noon = new Date(2026, 9, 11, 17, 0).getTime();
  eq(L.syncText(new Date(2026, 9, 11, 16, 2).toISOString(), noon), "Synced 16:02 today", "synced today");
  eq(L.syncText(new Date(2026, 9, 10, 16, 1).toISOString(), noon), "Synced 16:01 yesterday", "synced yesterday");
  ok(/^Synced Wed 7 Oct 16:01$/.test(L.syncText(new Date(2026, 9, 7, 16, 1).toISOString(), noon)), "synced earlier shows the date");
}

// ---- review fixes: future / time-zone-less feeds, goal caps, stage allowlist
{
  const now = Date.parse("2026-10-11T17:00:00+03:00");
  const fut = L.staleInfo("2026-10-11T18:00:00+03:00", now);
  ok(fut.stale && fut.future, "a feed dated 1 h in the future is stale/future, never fresh");
  ok(!L.staleInfo("2026-10-11T17:05:00+03:00", now).stale, "5 minutes of clock skew is tolerated");
  ok(L.staleInfo("2026-10-11T16:30:00", now).stale, "a time-zone-less string is never fresh in staleInfo");
  eq(L.normalizeFeed({ schema_version: 1, generated_at: "2026-10-11T16:30:00" }).code, "invalid", "a time-zone-less generated_at is invalid");
  ok(L.normalizeFeed({ schema_version: 1, generated_at: "2026-10-11T16:30:00Z" }).ok && L.normalizeFeed({ schema_version: 1, generated_at: "2026-10-11T16:30:00+0300" }).ok, "Z and +0300 offsets are accepted");
  const g = (o) => L.normalizeFeed({ schema_version: 1, generated_at: "2026-10-11T16:30:00Z", goals: o }).feed.goals;
  eq(g({ sleep_min: 100, steps: 999999, hard_min_week: 5 }), { sleep_min: 480, steps: 10000, hard_min_week: 150 }, "out-of-range goals fall back to the defaults");
  eq(g({ sleep_min: 420, steps: 12000, hard_min_week: 200 }), { sleep_min: 420, steps: 12000, hard_min_week: 200 }, "sane goals apply");
  const st = L.normalizeFeed({ schema_version: 1, generated_at: "2026-10-11T16:30:00Z", sleep: { stages: [{ stage: "deep", min: 5 }, { stage: "x\" onload=1", min: 5 }, { stage: "rem" }] }, day_detail: { sleep_blocks: [{ stage: "bad stage", from: "01:00", to: "02:00" }, { stage: "light", from: "02:00", to: "03:00" }] } }).feed;
  eq(st.sleep.stages.map((x) => x.stage), ["deep", "rem"], "unknown sleep stage ids are dropped");
  eq(st.day_detail.sleep_blocks.map((x) => x.stage), ["light"], "unknown sleep block stage ids are dropped");
}

// ---- ring sizing: numbers up to 5 digits (and 6 characters with the comma) fit the inner circle at any ring size
{
  const wide = (text, fs) => L.emWidth(text) * fs;
  let allFit = true;
  for (const d of [120, 140, 160, 170, 200, 240]) for (const st of [10, 14, 16]) for (const txt of ["7h 12", "8,430", "12,430", "98,765", "99,999", "0", "10,000"]) {
    const r = L.ringFit(txt, d, st, { maxFont: 52 }), R = (d - 2 * st) / 2 - 4, H = r.fontPx + 18;
    const chord = 2 * Math.sqrt(Math.max(0, R * R - (H / 2) * (H / 2)));
    if (R > 30 && !(r.fits && wide(txt, r.fontPx) <= chord)) { allFit = false; console.error("  does not fit:", d, st, txt, r); }
  }
  ok(allFit, "ringFit: every number up to 5 digits fits the inner circle for ring sizes 120-240");
  ok(L.ringFit("12,430", 160, 14).fontPx < L.ringFit("8,430", 160, 14).fontPx, "more digits give a smaller font");
  ok(L.ringFit("8", 160, 14).fontPx === 52, "a short number gets the maximum font");
  ok(L.ringFit("98,765", 160, 14).fontPx >= 24, "a 5-digit number stays readable (24 px or more) in a 160 px ring");
  const tiny = L.ringFit("98,765", 60, 12);
  ok(typeof tiny.fontPx === "number" && tiny.fits === false, "a ring too small reports fits:false instead of lying");
}

// ---- goals, comparisons, statuses
{
  eq(L.goalPct(8430, 10000), { frac: 0.843, pct: 84, over: false }, "8,430 of 10,000");
  eq(L.goalPct(12000, 10000), { frac: 1, pct: 120, over: true }, "over goal caps the ring at 1 but reports 120%");
  eq(L.goalPct(432, 480).pct, 90, "sleep 7h12 of 8h is 90%");
  eq(L.goalPct(null, 10000), { frac: 0, pct: null, over: false }, "no value, no percentage");
  eq(L.goalPct(5, 0).pct, null, "no goal, no percentage");
  eq(L.compare("steps", 8430, 9550, "yesterday"), { dir: "down", text: "1,120 fewer than yesterday (9,550)" }, "steps fewer wording");
  eq(L.compare("resting_hr", 58, 60, "yesterday").text, "2 lower than yesterday (60)", "hr lower wording");
  eq(L.compare("spo2", 96, 96, "yesterday"), { dir: "same", text: "same as yesterday (96)" }, "same wording");
  eq(L.compare("weight", 78.4, 78.6, "last reading").text, "0.2 lower than last reading (78.6)", "decimal metric");
  eq(L.compare("weight", 78.4, 78.4000001, "last reading").dir, "same", "rounding to the shown decimals counts as same");
  eq(L.compare("hrv", 46, null, "yesterday").text, "no earlier value to compare", "no previous value");
  eq(L.compare("hrv", null, 4, "yesterday").text, "", "no value, no line");
  const noon = new Date(2026, 9, 11, 16, 0).getTime(), night = new Date(2026, 9, 11, 21, 0).getTime(), ctx = (now) => ({ now, day: "2026-10-11", goals: L.GOALS });
  eq(L.statusOf("steps", { now: 8430, prev: 9550, status: "ok" }, ctx(noon)).id, "sofar", "steps below goal before 20:00 today: So far");
  eq(L.statusOf("steps", { now: 8430, prev: 9550, status: "ok" }, ctx(night)).id, "behind", "steps below goal after 20:00: Behind");
  eq(L.statusOf("steps", { now: 8430, prev: 9550, status: "ok" }, Object.assign(ctx(noon), { day: "2026-10-09" })).id, "behind", "steps of an earlier day: Behind");
  eq(L.statusOf("steps", { now: 10000, prev: 1, status: "ok" }, ctx(noon)).id, "good", "steps at goal: Good");
  eq(L.statusOf("sleep_min", { now: 432, status: "ok" }, ctx(noon)).id, "good", "7 h 12 is Good");
  eq(L.statusOf("sleep_min", { now: 400, status: "ok" }, ctx(noon)).id, "watch", "6 h 40 is Watch");
  eq(L.statusOf("sleep_min", { now: 560, status: "ok" }, ctx(noon)).id, "watch", "9 h 20 is Watch");
  eq(L.statusOf("body_fat", { now: 18.6, prev: 18.2, status: "ok" }, ctx(noon)).id, "watch", "body fat rising: Watch");
  eq(L.statusOf("body_fat", { now: 18.0, prev: 18.2, status: "ok" }, ctx(noon)).id, "good", "body fat falling: Good");
  eq(L.statusOf("hrv", { now: 46, status: "watch" }, ctx(noon)).id, "watch", "the feed's own watch is shown");
  eq(L.statusOf("hrv", { now: 46, status: "alert" }, ctx(noon)).id, "alert", "alert comes only from the feed");
  eq(L.statusOf("hrv", { now: null, status: "ok" }, ctx(noon)).id, "nodata", "no value: No data, never a zero");
  eq(L.statusOf("weight", { now: 78, status: "none" }, ctx(noon)).id, "info", "no status and no rule: Info");
  const c = L.chip("watch"); ok(c.glyph && c.word === "Watch" && c.cls === "warn", "a chip carries glyph + word + class (never colour alone)");
}

// ---- activity level quadrants
{
  eq(L.classifyActivity(8430, 77, 9000), "high-effort-low-steps", "Wednesday pattern: hard day, few steps");
  eq(L.classifyActivity(11000, 40, 9000), "high-high", "hard day, many steps");
  eq(L.classifyActivity(11000, 10, 9000), "easy-walking", "easy walking day");
  eq(L.classifyActivity(4000, 5, 9000), "quiet", "quiet day");
  eq(L.classifyActivity(9000, 30, 9000), "high-high", "boundary: exactly usual steps and 30 min count as high");
  eq(L.classifyActivity(8999, 29, 9000), "quiet", "boundary: just under both");
  eq(L.classifyActivity(null, 50, 9000), null, "missing steps: no point");
  eq(L.classifyActivity(5000, null, 9000), null, "missing effort: no point");
  eq(L.weekChip(201, 150).id, "over", "201 of 150 is over target");
  eq(L.weekChip(150, 150).id, "on", "150 is on target");
  eq(L.weekChip(90, 150).id, "under", "90 is below target");
  eq(L.weekChip(null, 150).id, "nodata", "no week number: No data");
  const f = L.normalizeFeed(sample).feed, pts = L.activityPoints(f);
  ok(pts.length === 7 && pts[6].today && pts[6].quadrant === "high-effort-low-steps" && pts[6].date === "2026-10-11", "sample: seven points, today last and in the high-effort-low-steps quadrant");
  const f2 = L.normalizeFeed({ schema_version: 1, generated_at: "2026-10-11T16:30:00+03:00", dates_last7: ["2026-10-10", "2026-10-11"], metrics: { steps: { now: 1, last7: [4000, null] } }, activity: { effort_min_last7: [50, 10] } }).feed;
  const p2 = L.activityPoints(f2);
  ok(p2[1].quadrant === null && p2[0].quadrant === "high-effort-low-steps", "a day without steps has no quadrant (dashed, never a zero)");
}

// ---- bars, periodic freshness, blood ordering
{
  const b = L.bars([100, 200, null, 50, 200, 120, 150]);
  ok(b[2].v === null && b[2].h === 0 && !b[2].label, "a missing day is an empty bar without a label");
  ok(b[1].label && b[4].label && b[3].label && b[6].label && b[6].today && !b[0].label, "max, min and today carry labels");
  ok(b[1].h === 100 && b[3].h === 25, "heights are proportional to the maximum");
  const now = new Date(2026, 9, 11).getTime();
  eq(L.dueState("2026-11", now).id, "soon", "next month is soon");
  eq(L.dueState("2026-06", now).id, "overdue", "past month is overdue");
  eq(L.dueState("2027-02", now).id, "ok", "far is ok");
  eq(L.dueState(null, now).id, "none", "no date set");
  eq(L.dueState("2026-10-20", now).text, "Due in 9 days", "day-level date");
  eq(L.dueState("2026-10-01", now).text, "Overdue by 10 days", "day-level overdue");
  eq(L.whenText("2026-05"), "May 2026", "month date text");
  eq(L.whenText(null), "never", "no date text");
  const order = L.bloodOrder(L.normalizeFeed(sample).feed.blood_tests.markers).map((m) => m.marker);
  eq(order[0], "LDL cholesterol", "out-of-range markers come first");
  eq(L.fmtDur(432), "7h 12", "7h 12"); eq(L.fmtDurShort(16), "16 min", "short minutes"); eq(L.fmtDurShort(120), "2 h", "short whole hours"); eq(L.fmtNum(12430, 0), "12,430", "thousands separator"); eq(L.fmtNum(-0.3, 1), "\u22120.3", "minus sign");
}

// ---- the main-process reader
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hpane-"));
  const w = (name, content) => { const p = path.join(tmp, name); fs.writeFileSync(p, content); return p; };
  const env = (p) => ({ AGENT_DESKTOP_HEALTH_PANE_FEED: p });
  // test mode: default = the synthetic sample, fresh by construction
  const d = PF.readFeed({ testMode: true, env: {} });
  ok(d.state === "ok" && d.sample === true && Date.parse(d.feed.generated_at) < d.now && d.now - Date.parse(d.feed.generated_at) < 3600e3, "test mode default reads the synthetic sample and reads as fresh");
  eq(PF.resolveFeedPath({ testMode: true, env: {} }).file, PF.sampleFile(), "test mode default path is the fixture");
  // override only in test mode
  const good = w("good.json", JSON.stringify(sample));
  eq(PF.resolveFeedPath({ testMode: true, env: env(good) }).file, good, "test mode honours the env override");
  const PARENT = "C:\\Example\\Scratch\\Health", LIVE = path.join(PARENT, "vault", "pane_feed", "health_pane.json");   // the original owner's folder, as the migration config sets it
  const live = PF.resolveFeedPath({ testMode: false, parent: PARENT, env: env(good), fs: { realpathSync: Object.assign((p) => p, { native: (p) => p }) } });
  eq(live.file, LIVE, "live mode ignores the env override and uses <health folder>\\vault\\pane_feed");
  eq(PF.LIVE_FEED, undefined, "no built-in feed path");
  eq(PF.resolveFeedPath({ testMode: false, env: {} }).code, "noparent", "live mode with no health folder configured: refused");
  eq(PF.resolveFeedPath({ testMode: false, parent: () => PARENT, env: {}, fs: { realpathSync: Object.assign((p) => p, { native: (p) => p }) } }).file, LIVE, "the folder may be given as a function");
  eq(PF.resolveFeedPath({ testMode: true, env: env("relative/x.json") }).code, "form", "a relative override is refused");
  eq(PF.resolveFeedPath({ testMode: true, env: env("C:\\a\\..\\b.json") }).code, "form", "a .. override is refused");
  const redirected = PF.resolveFeedPath({ testMode: false, parent: PARENT, env: {}, fs: { realpathSync: Object.assign((p) => p, { native: (p) => p.replace("Health", "Other") }) } });
  eq(redirected.code, "redirect", "a redirected live path (junction/symlink) is refused");
  // states
  eq(PF.readFeed({ testMode: true, env: env(path.join(tmp, "nope.json")) }).state, "missing", "no file: missing");
  eq(PF.readFeed({ testMode: true, env: env(tmp) }).state, "missing", "a folder is not a feed: missing");
  eq(PF.readFeed({ testMode: true, env: env(w("bad.json", "{ not json")) }).state, "invalid", "unparsable: invalid");
  eq(PF.readFeed({ testMode: true, env: env(w("bom.json", "\uFEFF" + JSON.stringify(sample))) }).state, "ok", "a BOM is tolerated");
  eq(PF.readFeed({ testMode: true, env: env(w("v2.json", JSON.stringify({ schema_version: 2, generated_at: "2026-10-11T16:30:00+03:00" }))) }).state, "newer", "newer schema: newer");
  eq(PF.readFeed({ testMode: true, env: env(w("empty.json", "{}")) }).state, "invalid", "empty object: invalid");
  eq(PF.readFeed({ testMode: true, env: env(w("huge.json", " ".repeat(L.MAX_FEED_BYTES + 10))) }).state, "invalid", "oversized file: invalid, not read");
  const inv = PF.readFeed({ testMode: true, env: env(w("bad2.json", "{ nope")) });
  ok(!("feed" in inv) && !JSON.stringify(inv).includes("nope"), "an invalid result carries no content");
  // the clock override is test-only
  const pinned = PF.readFeed({ testMode: true, env: Object.assign(env(good), { AGENT_DESKTOP_HEALTH_PANE_NOW: "2026-10-20T10:00:00+03:00" }) });
  eq(pinned.now, Date.parse("2026-10-20T10:00:00+03:00"), "test mode can pin the clock (for stale tests)");
  ok(L.staleInfo(pinned.feed.generated_at, pinned.now).stale, "...and a pinned late clock makes the sample stale");
  // watch retry: the folder does not exist at first
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hpane-r-")), fdir = path.join(base, "pane_feed"), fpath = path.join(fdir, "health_pane.json");
    let hits = 0;
    const w1 = PF.watchFeed({ testMode: true, env: env(fpath) }, () => { hits++; });
    ok(w1.active === false, "no feed folder yet: watchFeed reports active:false so the caller retries");
    setTimeout(() => { fs.mkdirSync(fdir); }, 150);
    setTimeout(() => {
      ok(hits >= 1, "the parent-folder watch noticed the feed folder appearing (got " + hits + ")");
      w1.stop();
      const w2 = PF.watchFeed({ testMode: true, env: env(fpath) }, () => { hits++; });
      ok(w2.active === true, "once the folder exists the retry gives an active watch");
      w2.stop(); fs.rmSync(base, { recursive: true, force: true });
    }, 1200);
  }
  // watch: only the feed file, content-free callback
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "hpane-w-"));
  const feedPath = path.join(wd, "health_pane.json");
  let calls = 0, args = null;
  const watcher = PF.watchFeed({ testMode: true, env: env(feedPath) }, function () { calls++; args = Array.from(arguments); });
  setTimeout(() => { fs.writeFileSync(path.join(wd, "health_pane.json.tmp"), "x"); }, 100);
  setTimeout(() => { fs.writeFileSync(feedPath + ".new", "y"); fs.renameSync(feedPath + ".new", feedPath); }, 300);
  setTimeout(() => {
    watcher.stop();
    ok(calls === 1, "one change event for the feed file (tmp files ignored, writes debounced): got " + calls);
    eq(args, [], "the change callback carries no argument (no name, no content)");
    wiring();
    fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(wd, { recursive: true, force: true });
    console.log(failed ? "health-pane: " + failed + " of " + n + " FAILED" : "health-pane: all " + n + " passed");
    process.exit(failed ? 1 : 0);
  }, 2600);
}

// ---- wiring guards (privacy contract)
function wiring() {
  const vis = read("src/renderer/health-visual.js"), logic = read("src/health/pane-logic.js"), mh = read("src/health/main-health.js"), pre = read("src/preload.js"), pf = read("src/health/pane-feed.js"), hl = read("src/renderer/health.js");
  ok(/paneWatch\.active/.test(mh), "main retries the watch on every read while it is not active");
  ok(/handle\("health-pane-feed"/.test(mh) && /"health-pane-changed"/.test(mh), "main registers the feed handler and the change event");
  ok(/paneFeed: \(\) => ipcRenderer\.invoke\("health-pane-feed"\)/.test(pre), "the preload bridge takes no arguments: the renderer cannot name a file");
  ok(!/health-pane-feed", *\{/.test(pre), "the preload sends no payload for the feed");
  ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(vis), "health-visual.js uses textContent only (no HTML injection)");
  ok(!/console\.|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|clipboard|document\.title|window\.open/.test(vis), "health-visual.js never logs, calls the network, stores or copies");
  ok(!/vault|E:\\\\|pane_feed|health_pane/i.test(vis + logic) , "renderer and logic code contain no vault path");
  ok(!/console\./.test(pf) && !/require\("(https?|net|child_process)"\)/.test(pf), "pane-feed.js neither logs nor touches the network");
  ok(/AGENT_DESKTOP_HEALTH_PANE_FEED/.test(pf) && /if \(o\.testMode\)/.test(pf), "the path override sits inside the test-mode branch");
  ok(!/setInterval/.test(vis + pf + mh.slice(mh.indexOf("health-pane-feed"))), "no polling timers in the pane");
  ok(/window\.healthVisual\.clear\(\)/.test(hl), "closing My Health clears the feed from the page");
  const pkg = JSON.parse(read("package.json"));
  ok(/^1\.114\.\d+$/.test(pkg.version) || /^1\.(11[5-9]|1[2-9]\d)\./.test(pkg.version), "version is 1.114.0 or later");
  ok(pkg.scripts.test.indexOf("node tests/health-pane.test.js") >= 0, "this test is in the npm test line");
  for (const f of ["src/renderer/health-visual.js", "src/renderer/styles-health-visual.css", "src/health/pane-logic.js"]) ok(fs.existsSync(path.join(root, f)), f + " exists");
  // every function the renderer calls on L exists in the logic's exports
  const used = new Set([...vis.matchAll(/\bL\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !(k in L));
  ok(!missing.length, "every L.* used by health-visual.js is exported by pane-logic.js" + (missing.length ? ": " + missing.join(", ") : ""));
  const declared = new Set([...vis.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]));
  const called = new Set([...vis.matchAll(/(?<![.\w])((?:render|open|stateBanner|emptyState|header|legend|section|spark|markerRow|ring|fitRings|barChart|lineChart|yearBars|calendar|sleepHero|stepsHero|heartHero|tile|freshness|headerLite|nSv|nEl|chipEl|icon)[A-Za-z0-9]*)\s*\(/g)].map((m) => m[1]));
  const arrowNames = new Set([...vis.matchAll(/const\s+(\w+)\s*=\s*\(/g)].map((m) => m[1]));
  const undeclared = [...called].filter((k) => !declared.has(k) && !arrowNames.has(k));
  ok(!undeclared.length, "every helper health-visual.js calls is declared in the file" + (undeclared.length ? ": " + undeclared.join(", ") : ""));
}
