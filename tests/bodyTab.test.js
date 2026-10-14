// node tests/bodyTab.test.js - My Health Body tab (v1.118.0): LEFT/RIGHT mapping, the 63 zones, entry validation, latest-wins merge, days to
// normal, heat buckets, safety rules, the pain_log.jsonl store (append-only, half-written last line), and lazy-loading / wiring guards.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("../src/health/body-logic");
const D = require("../src/health/body-data");
const S = require("../src/health/body-store");
const root = path.join(__dirname, "..");
let n = 0, failed = 0;
function ok(c, m) { n++; if (!c) { failed++; console.error("FAIL: " + m); } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + " (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")"); }
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// ---- left / right: the person's own side. FRONT: your right is on the screen's left. BACK: your right is on the screen's right.
eq(L.sideOnScreen("front", "right"), "left", "front view: your RIGHT is on the screen's LEFT");
eq(L.sideOnScreen("front", "left"), "right", "front view: your LEFT is on the screen's RIGHT");
eq(L.sideOnScreen("back", "right"), "right", "back view: your RIGHT is on the screen's RIGHT");
eq(L.sideOnScreen("back", "left"), "left", "back view: your LEFT is on the screen's LEFT");
eq(L.sideOnScreen("front", "centre"), "centre", "centre stays centre");
eq(L.personSideFromScreen("front", "left"), "right", "front: screen-left is the person's right");
eq(L.personSideFromScreen("back", "left"), "left", "back: screen-left is the person's left");
ok((() => { try { L.sideOnScreen("side", "left"); return false; } catch (e) { return true; } })(), "unknown view throws");
// every zone: its id/side agrees with where its ellipse is drawn
L.zoneList().forEach((z) => {
  eq(L.sideFromGeometry(z.view, z.cx), z.side, "zone " + z.id + " drawn on the side it is labelled");
  ok(z.side === "centre" || z.id.endsWith("-" + z.side), "zone id ends with its side: " + z.id);
  ok(z.side !== "centre" || !/-(left|right)$/.test(z.id), "centre zone has no side suffix: " + z.id);
});
ok(/your RIGHT is on the screen's left/.test(read("src/renderer/health-body.js")), "front figure caption states the right/left rule");

// ---- zones
{
  const ids = L.zoneList().map((z) => z.id);
  eq(ids.length, 63, "63 zones");
  eq(D.views.front.zones.length, 36, "36 front zones"); eq(D.views.back.zones.length, 27, "27 back zones");
  eq(new Set(ids).size, 63, "zone ids are unique");
  ok(ids.filter((i) => i.startsWith("front-")).length === 36 && ids.filter((i) => i.startsWith("back-")).length === 27, "ids carry their view");
  ok(ids.includes("back-lower-back-left") && ids.includes("front-knee-right"), "the sample ids exist");
  ok(D.safetyZones.every((z) => ids.includes(z)), "every safety zone is a real zone");
  ok(L.safetyRequired("back-lower-back-left") && L.safetyRequired("front-neck-front") && !L.safetyRequired("front-knee-right"), "safety asked for back / neck only");
  eq(L.zoneLabel(L.zones()["front-knee-right"]), "Knee (your right)", "label says your right");
  eq(L.sideWord("left"), "your LEFT side", "side word");
}

// ---- data file lists (chips are fixed keys; the requested additions exist)
{
  const keys = (l) => l.map((x) => x[0]);
  ["types", "triggers", "spread", "worseWith", "betterWith"].forEach((k) => ok(new Set(keys(D[k])).size === D[k].length, k + " keys unique"));
  ok(keys(D.types).includes("dull") && keys(D.types).includes("throbbing"), "types: Dull, Throbbing");
  ok(keys(D.triggers).includes("sport") && keys(D.triggers).includes("fall") && keys(D.triggers).includes("twisting") && keys(D.triggers).includes("lifting"), "triggers incl. Sport or playing, fall, twist, lift");
  ok(keys(D.spread).includes("below_knee") && keys(D.spread).includes("up_back"), "spread: Below the knee, Up the back");
  ok(keys(D.worseWith).includes("twisting") && keys(D.worseWith).includes("getting_up"), "worse with: Twisting, Getting up from sitting");
  ok(keys(D.betterWith).includes("ice") && keys(D.betterWith).includes("lying_down"), "better with: Ice, Lying down");
  eq(D.severity.map((x) => x[0]), [1, 2, 3, 4, 5], "strength 1-5"); eq(D.severity[3][1], "Strong", "4 = Strong");
  eq(D.safety.questions.map((q) => q.key), ["weakness_numbness", "bladder_bowel", "fever_unwell"], "exactly three safety questions");
  ok(/wording to be approved by Health Agent/.test(read("src/health/body-data.js")), "data file carries the approval comment");
  const neutral = D.safety.okTitle + " " + D.safety.okBody + " " + D.safety.notAsked;
  ok(!/\b(fine|safe|safely|okay|all clear)\b/i.test(neutral), "the neutral box never says fine or safe");
  ok(/Please get medical help today/.test(D.safety.alertTitle) && /101 in Israel/.test(D.safety.alertBody) && /cannot judge it/.test(D.safety.alertBody), "alert wording");
  ok(D.safety.alertNotSure === "Not sure is worth checking: ask a doctor today." && D.safety.saveAnyway === "Save entry anyway" && /on my way/.test(D.safety.onMyWay), "button and not-sure wording");
}

// ---- safety evaluation
{
  const a = (w, b, f) => L.evaluateSafety({ weakness_numbness: w, bladder_bowel: b, fever_unwell: f });
  ok(!a("no", "no", "no").flag && a("no", "no", "no").complete, "all No: no flag");
  ok(a("yes", "no", "no").flag, "Yes on weakness flags"); ok(a("no", "no", "yes").flag, "Yes on fever flags");
  ok(a("no", "not_sure", "no").flag, "Not sure on bladder/bowel flags");
  ok(a("not_sure", "no", "no").flag, "Not sure on weakness/numbness flags (Health Agent, 2026-10-13)");
  ok(!a("no", "no", "not_sure").flag, "Not sure on fever alone does not flag");
  ok(!L.evaluateSafety({ weakness_numbness: "no" }).complete, "incomplete answers are not complete");
}

// ---- entry validation
const base = () => ({ id: "e1", episode: "e1", zone: "back-lower-back-left", side: "left", date: "2026-10-13", startDate: "2026-10-11", severity: 4, type: ["sharp", "stiff"], trigger: ["twisting", "lifting"], spread: ["buttock_left"], worseWith: ["sitting"], betterWith: ["walking"], note: "x", safety: { weakness_numbness: "no", bladder_bowel: "no", fever_unwell: "no" } });
{
  const r = L.validateEntry(base(), { now: "2026-10-13T08:00:00.000Z" });
  ok(r.ok, "a good entry validates"); ok(r.ok && r.entry.severityWord === "Strong" && r.entry.safety_flag === false && r.entry.safety.answeredAt === "2026-10-13T08:00:00.000Z", "word, flag, answeredAt filled in by main");
  ok(r.ok && r.entry.updated === "2026-10-13T08:00:00.000Z", "updated stamped");
  const bad = (f, m) => { const e = base(); f(e); ok(!L.validateEntry(e).ok, m); };
  bad((e) => { e.zone = "nope"; }, "unknown zone refused"); bad((e) => { e.side = "right"; }, "wrong side refused"); bad((e) => { e.severity = 6; }, "severity 6 refused"); bad((e) => { e.severity = 0; }, "severity 0 refused");
  bad((e) => { e.severity = 2.5; }, "fractional severity refused"); bad((e) => { e.date = "2026-02-30"; }, "impossible date refused"); bad((e) => { e.startDate = "2026-10-14"; }, "start after entry date refused");
  bad((e) => { e.id = "../x"; }, "bad id refused"); bad((e) => { e.type = "sharp"; }, "non-array chips refused"); bad((e) => { delete e.safety; }, "back spot without safety answers refused");
  bad((e) => { e.safety.bladder_bowel = undefined; }, "incomplete safety refused for a back spot"); bad((e) => { e.betterDate = "2026-10-10"; }, "better before start refused"); bad((e) => { e.betterDate = "x"; }, "bad better date refused");
  ok(!L.validateEntry(null).ok && !L.validateEntry([]).ok && !L.validateEntry("x").ok, "non-objects refused");
  const e2 = base(); e2.type = ["sharp", "bogus", "sharp"]; e2.note = "a".repeat(5000); e2.spreadOther = "b".repeat(500); e2.safety_flag = false; e2.safety.weakness_numbness = "yes";
  const r2 = L.validateEntry(e2); ok(r2.ok && r2.entry.type.length === 1 && r2.entry.note.length === D.limits.note && r2.entry.spreadOther.length === D.limits.spreadOther, "unknown chip dropped, duplicates removed, free text capped");
  ok(r2.ok && r2.entry.safety_flag === true, "safety_flag recomputed from the answers (a Yes flags)");
  const e3 = base(); e3.safety.weakness_numbness = "yes"; e3.safety_flag = false; ok(L.validateEntry(e3).entry.safety_flag === true, "the renderer cannot clear the flag");
  const e4 = base(); e4.zone = "front-knee-right"; e4.side = "right"; delete e4.safety; ok(L.validateEntry(e4).ok, "a knee needs no safety answers");
  const e5 = base(); e5.betterDate = "2026-10-16"; e5.movingNormally = "yes"; const r5 = L.validateEntry(e5); ok(r5.ok && r5.entry.daysToNormal === 5, "daysToNormal is calculated by the validator (5)");
  const e6 = base(); e6.betterDate = "2026-10-16"; e6.daysToNormal = 99; ok(L.validateEntry(e6).entry.daysToNormal === 5, "a typed daysToNormal is ignored");
  const e7 = base(); e7.evil = "<img>"; ok(!("evil" in L.validateEntry(e7).entry), "unknown fields dropped");
  const e8 = base(); e8.zone = "front-groin-pelvis"; e8.side = "centre"; delete e8.safety; ok(L.validateEntry(e8).ok, "centre zone side is 'centre'");
}

// ---- days to normal, dates
eq(L.daysToNormal("2026-10-11", "2026-10-16"), 5, "Sun 11 Oct to Fri 16 Oct = 5 days"); eq(L.daysToNormal("2026-10-11", "2026-10-11"), 0, "same day = 0");
eq(L.daysToNormal("2026-10-11", "2026-10-10"), null, "negative is null"); eq(L.daysToNormal("2026-03-25", "2026-03-29"), 4, "across the March clock change");
eq(L.daysToNormal("2026-12-30", "2027-01-02"), 3, "across a year end"); eq(L.addDays("2026-03-01", -1), "2026-02-28", "addDays"); eq(L.dayNumber("2026-10-11", "2026-10-13"), 3, "started Sun 11, on Tue 13 = Day 3");
ok(L.validDate("2026-10-13") && !L.validDate("2026-13-01") && !L.validDate("26-10-13") && !L.validDate(""), "validDate");

// ---- the file: latest wins, half-written last line tolerated
{
  const mk = (id, sev, upd, extra) => Object.assign(L.validateEntry(Object.assign(base(), { id, severity: sev }), { now: upd }).entry, extra || {});
  const lines = [mk("a", 4, "2026-10-11T08:00:00Z"), mk("b", 2, "2026-10-11T09:00:00Z", { date: "2026-10-12" }), mk("a", 3, "2026-10-13T08:00:00Z")].map(L.serialize).join("");
  const p = L.parseLog(lines + '{"id":"c","zone":"back-low'); eq(p.entries.length, 3, "three whole lines read"); eq(p.skipped, 1, "the half-written last line is skipped, not an error");
  const m = L.mergeLatest(p.entries); eq(m.length, 2, "two ids after the merge"); eq(m.find((e) => e.id === "a").severity, 3, "latest update wins"); eq(m.find((e) => e.id === "a").severityWord, "Moderate", "word follows the number");
  const t = L.mergeLatest([mk("z", 1, "2026-10-13T08:00:00Z"), mk("z", 5, "2026-10-13T08:00:00Z")]); eq(t[0].severity, 5, "equal stamps: the later line wins");
  const old = L.mergeLatest([mk("z", 5, "2026-10-14T00:00:00Z"), mk("z", 1, "2026-10-13T00:00:00Z")]); eq(old[0].severity, 5, "an older line after a newer one does not win");
  const junk = L.parseLog('\n{"nope":1}\nnot json\n[]\n' + L.serialize(mk("q", 2, "2026-10-13T00:00:00Z"))); eq(junk.entries.length, 1, "junk lines skipped"); eq(junk.skipped, 3, "junk counted");
  ok(L.parseLog("").entries.length === 0 && L.parseLog(null).entries.length === 0, "empty file");
}

// ---- episodes, history, heat
{
  const mk = (o) => L.validateEntry(Object.assign(base(), o), { now: "2026-10-13T08:00:00Z" }).entry;
  const ents = [
    mk({ id: "a1", episode: "ep1", date: "2026-10-11", severity: 4 }), mk({ id: "a2", episode: "ep1", zone: "back-lower-back-right", side: "right", date: "2026-10-11", severity: 3 }),
    mk({ id: "a3", episode: "ep1", date: "2026-10-12", severity: 4 }), mk({ id: "a4", episode: "ep1", date: "2026-10-13", severity: 3 }),
    mk({ id: "k1", episode: "ep2", zone: "front-knee-right", side: "right", date: "2026-10-04", startDate: "2026-10-04", severity: 2, safety: undefined }),
    mk({ id: "o1", episode: "ep0", date: "2026-09-01", startDate: "2026-09-01", severity: 5, betterDate: "2026-09-09" }),
  ];
  ok(ents.every(Boolean), "fixture entries valid");
  const eps = L.buildEpisodes(ents); eq(eps.length, 3, "three episodes");
  const e1 = eps.find((e) => e.id === "ep1"); eq(e1.zones.length, 2, "both-sides spot = one episode, two zones"); eq(e1.days, ["2026-10-11", "2026-10-12", "2026-10-13"], "days"); eq(e1.severity, 3, "current strength = latest day"); ok(e1.active, "open episode is active");
  const e0 = eps.find((e) => e.id === "ep0"); ok(!e0.active && e0.daysToNormal === 8, "closed episode: 8 days"); eq(L.previousDays(eps, e1), 8, "last episode of the same spot = 8 days");
  eq(L.previousDays(eps, eps.find((e) => e.id === "ep2")), null, "no earlier episode for the knee");
  eq(L.historyByZone(ents, 7, "2026-10-13")["back-lower-back-left"], { count: 3, max: 4 }, "7 days: lower back left");
  ok(!L.historyByZone(ents, 7, "2026-10-13")["front-knee-right"], "knee entry 9 days ago is outside 7 days"); ok(!!L.historyByZone(ents, 30, "2026-10-13")["front-knee-right"], "...inside 30 days");
  ok(L.historyByZone(ents, 30, "2026-10-13")["back-lower-back-left"].count === 3 && L.historyByZone(ents, null, "2026-10-13")["back-lower-back-left"].count === 4, "30 days excludes September, All includes it");
  eq(L.historyByZone(ents, 7, "2026-10-03"), {}, "entries after 'today' are not counted");
  eq([0, 1, 2, 3, 4, 6, 7, 20].map((c) => L.heatLevel(c, D.heatEntries)), [0, 1, 2, 2, 3, 3, 4, 4], "heat buckets by entries: 1 / 2-3 / 4-6 / 7+");
  eq([1, 2, 3, 4, 5].map((c) => L.heatLevel(c, D.heatStrongest)), [1, 2, 3, 3, 4], "heat buckets by strength");
  const rk = L.rankZones({ "back-lower-back-left": { count: 9, max: 4 }, "front-knee-right": { count: 2, max: 2 }, "back-lower-back-right": { count: 5, max: 3 } }, "entries"); eq(rk.map((r) => r.id), ["back-lower-back-left", "back-lower-back-right", "front-knee-right"], "ranked most to least");
}

// ---- the store: append-only file in the health folder, half-written line healed, validation before writing, caps
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bodytab-")); const st = S.create({ root: dir, now: () => "2026-10-13T08:00:00.000Z" });
  const td = L.localDate(), b = () => Object.assign(base(), { date: td, startDate: td });
  ok(st.load().ok && st.load().entries.length === 0, "no file yet = empty log, ok");
  const r = st.save([b()]); ok(r.ok && r.saved === 1 && r.entries.length === 1, "first save"); ok(fs.existsSync(path.join(dir, "pain_log.jsonl")), "pain_log.jsonl is in the store folder");
  const r2 = st.save([Object.assign(b(), { severity: 2 })]); eq(r2.entries.length, 1, "an update with the same id is a new line, one merged entry"); eq(r2.entries[0].severity, 2, "latest wins on disk");
  eq(fs.readFileSync(path.join(dir, "pain_log.jsonl"), "utf8").split("\n").filter(Boolean).length, 2, "append-only: two lines");
  fs.appendFileSync(path.join(dir, "pain_log.jsonl"), '{"id":"half","zone":"back-mi');   // crash mid-append
  ok(st.load().ok && st.load().skipped === 1 && st.load().entries.length === 1, "half-written last line tolerated on read");
  const r3 = st.save([Object.assign(b(), { id: "e2" })]); ok(r3.ok && r3.entries.length === 2, "append after a half line heals it (a newline first)");
  ok(!st.save([Object.assign(b(), { zone: "bogus" })]).ok, "invalid entry refused"); ok(!st.save([b(), Object.assign(b(), { id: "e3", severity: 9 })]).ok, "one bad entry refuses the whole save");
  eq(st.load().entries.length, 2, "nothing written by a refused save"); ok(!st.save([]).ok && !st.save(null).ok && !st.save(new Array(20).fill(b())).ok, "empty / null / too many refused");
  ok(!st.save([Object.assign(b(), { id: "e9", date: "2030-01-01", startDate: "2030-01-01" })]).ok, "far-future date refused");
  fs.writeFileSync(path.join(dir, "pain_log.jsonl"), " ".repeat(D.limits.maxFileBytes + 1)); ok(!st.load().ok && !st.save([b()]).ok, "an oversized file is refused, not read");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- wiring guards: lazy loading, IPC, no innerHTML, no network, version
{
  const hjs = read("src/renderer/health.js");
  ok(/painmap/.test(hjs) && /ensureBody/.test(hjs) && /body-data\.js/.test(hjs) && /styles-health-body\.css/.test(hjs), "health.js lazy-loads the Body map");
  ok(!/health-body|body-logic|body-data/.test(read("src/renderer/index.html")), "index.html does not load the Body map code (zero start-up weight)");
  ok(/\["painmap", "Body map"/.test(hjs) && hjs.indexOf('["painmap"') > hjs.indexOf('["meds", "Medicines"'), "the new group tab comes after the existing ones");
  const mh = read("src/health/main-health.js"); ok(/health-body-load/.test(mh) && /health-body-save/.test(mh) && /require\("\.\/body-store"\)/.test(mh) && !/^const .*body-store/m.test(mh), "main handlers load the store on first use");
  const pre = read("src/preload.js"); ok(/health-body-load/.test(pre) && /health-body-save/.test(pre), "preload bridge");
  ["src/renderer/health-body.js", "src/health/body-logic.js", "src/health/body-store.js"].forEach((f) => { const t = read(f); ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(t), f + ": no innerHTML"); ok(!/fetch\(|XMLHttpRequest|WebSocket|require\("https?"\)|sendBeacon/.test(t), f + ": no network"); ok(!/setInterval|setTimeout/.test(t), f + ": no timers"); });
  ok(!/require\(/.test(read("src/renderer/health-body.js")), "renderer file does not require anything");
  ok(/^1\.(11[89]|12[0123])\.\d+$/.test(JSON.parse(read("package.json")).version), "version is 1.118.x - 1.123.x");
}
// ---- review fixes (v1.118.0): flagged + unfinished must save; better-mark keeps answeredAt; double-save / stale guards exist
{
  const part = (o) => Object.assign(base(), { safety: o });
  let r = L.validateEntry(part({ weakness_numbness: "yes" }), { now: "2026-10-13T08:00:00Z" });
  ok(r.ok && r.entry.safety_flag === true && r.entry.safety.bladder_bowel === "not_sure" && r.entry.safety.fever_unwell === "not_sure", "a Yes with unanswered questions still saves: missing = not_sure, flag true");
  r = L.validateEntry(part({ bladder_bowel: "not_sure" }), { now: "2026-10-13T08:00:00Z" }); ok(r.ok && r.entry.safety_flag, "Not sure on bladder/bowel alone saves flagged");
  ok(!L.validateEntry(part({ weakness_numbness: "no" })).ok, "an unflagged unfinished questionnaire is still refused");
  ok(!L.validateEntry(part({ fever_unwell: "not_sure" })).ok, "Not sure on fever alone is not a flag, so incomplete is still refused");
  const bt = base(); delete bt.safety; bt.betterDate = "2026-10-16"; ok(L.validateEntry(bt).ok, "an entry carrying betterDate needs no safety answers");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bodytab2-")), td = L.localDate(), st = S.create({ root: dir, now: () => "2026-10-13T08:00:00.000Z" });
  const b0 = Object.assign(base(), { date: td, startDate: td });
  ok(st.save([Object.assign({}, b0, { safety: { weakness_numbness: "yes" } })]).ok, "store: flagged unfinished entry is stored");
  eq(st.load().entries[0].safety_flag, true, "stored flagged");
  const st2 = S.create({ root: dir, now: () => "2026-10-14T09:00:00.000Z" });
  const cur = st2.load().entries[0], first = cur.safety.answeredAt;
  const better = Object.assign({}, cur, { betterDate: td, movingNormally: "yes" });
  const r2 = st2.save([better]); ok(r2.ok, "mark-as-better saves"); eq(r2.entries[0].safety.answeredAt, first, "answeredAt is preserved when the answers are unchanged");
  const r3 = st2.save([Object.assign({}, cur, { safety: { weakness_numbness: "no", bladder_bowel: "no", fever_unwell: "no" } })]); ok(r3.ok && r3.entries[0].safety.answeredAt !== first, "changed answers get a new answeredAt");
  fs.rmSync(dir, { recursive: true, force: true });
  const hb = read("src/renderer/health-body.js");
  ok(/S\.saving/.test(hb) && /d\.ids/.test(hb) && /d\.newEp/.test(hb), "double-save guard and ids generated once per draft");
  ok(/S\.gen\+\+/.test(hb) && /gen !== S\.gen/.test(hb), "generation counter drops results after close");
  ok(!/S\.res\.today/.test(hb) && /const today = \(\) => L\.localDate\(\)/.test(hb), "today is recomputed, not cached");
  ok(/ctlKey/.test(hb), "focus is restored after repaints");
  ok(/querySelector\('link\[href="styles-health-body\.css"\]'\)/.test(read("src/renderer/health.js")), "no second stylesheet link on retry");
  ok(/could not be read and/.test(hb), "skipped-lines notice on the history page");
}
console.log(n + " checks, " + failed + " failed"); process.exit(failed ? 1 : 0);
