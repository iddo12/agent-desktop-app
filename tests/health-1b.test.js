// node tests/health-1b.test.js - My Health stage 1b (v1.82.0): biological age (PhenoAge), longevity tiles, interactions, evidence map,
// weekly review, reading list, routines and challenges, reminders (single timer). SYNTHETIC data and temp folders only.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const PA = require("../src/health/phenoage");
const AF = require("../src/health/agentfiles");
const LG = require("../src/health/longevity");
const NU = require("../src/health/nutrition");
const RT = require("../src/health/routines");
const RM = require("../src/health/reminders");
const SV = require("../src/health/service");
const MH = require("../src/health/main-health");
const IM = require("../src/health/importers");
const { createStore } = require("../src/health/store");
const { makeSamples, makeAgentFiles, makeAgentFiles2, makeRoutines } = require("../tools/health-synthetic");

let n = 0, fails = 0; const queue = [];
const t = (name, fn) => queue.push({ name, fn });
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "health-1b-test-"));
const END = "2026-10-07", NOW = Date.parse(END + "T10:00:00");
const write = (root, files) => { for (const k of Object.keys(files)) { const f = path.join(root, k); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, files[k]); } };
const SRC = path.join(__dirname, "..", "src");
function svcSeeded(extra) {
  const root = path.join(tmp(), "store"); const logs = [], opened = [], rearms = [];
  const svc = SV.createService(Object.assign({ resolved: { ok: true, root }, log: (l) => logs.push(l), now: () => NOW, openExternal: (u) => opened.push(u), reminders: { rearm: () => rearms.push(1) } }, extra || {}));
  const S = makeSamples(END, 45), st = createStore({ root });
  st.addMeasurements(IM.importRenphoCsv(S["synthetic_renpho.csv"]).measurements); st.addMeasurements(IM.importHealthConnectCsv(S["synthetic_healthconnect.csv"]).measurements);
  for (const f of ["synthetic_labs.json", "synthetic_labs_blood.json", "synthetic_labs_nutrition.json"]) st.addLabs(IM.importLabEntries(JSON.parse(S[f])).labs);
  st.addMed({ name: "Synthetic magnesium", dose: "x", schedule: "Evening", start: "2026-09-01" }); st.addMed({ name: "Synthetic multivitamin", dose: "x", schedule: "Morning", start: "2026-09-01" });
  write(root, Object.assign({}, makeAgentFiles(END), makeAgentFiles2(END), { "routines.json": makeRoutines(END) }));
  return { svc, root, logs, opened, rearms, st };
}

// ------------------------------------------------------------------ PhenoAge
const NORMAL = { albumin: 45, creatinine: 80, glucose: 5, crp: 0.1, lymphocyte: 30, mcv: 90, rdw: 13, alp: 70, wbc: 5.5 };
t("phenoage: formula is monotonic (older, more CRP, higher glucose, wider RDW all raise it) and lands near age for a healthy panel", () => {
  const base = PA.phenoAge(NORMAL, 40);
  assert.ok(base > 28 && base < 50, "healthy 40-year-old gives " + base);
  assert.ok(PA.phenoAge(NORMAL, 50) > base);
  assert.ok(PA.phenoAge(Object.assign({}, NORMAL, { crp: 1.0 }), 40) > base);
  assert.ok(PA.phenoAge(Object.assign({}, NORMAL, { glucose: 7 }), 40) > base);
  assert.ok(PA.phenoAge(Object.assign({}, NORMAL, { rdw: 16 }), 40) > base);
  assert.ok(PA.phenoAge(Object.assign({}, NORMAL, { albumin: 50 }), 40) < base, "more albumin lowers it");
  assert.strictEqual(PA.FORMULA.length, 5); assert.ok(PA.FORMULA.join("\n").includes("141.50225"));
});
t("phenoage: panels use unit conversion, newest complete panel, previous panel 30+ days older, labelled experimental", () => {
  const S = makeSamples(END, 45);
  const labs = IM.importLabEntries(JSON.parse(S["synthetic_labs_blood.json"])).labs;
  const b = PA.buildBioAge(labs, "1983-05");
  assert.strictEqual(b.state, "ok"); assert.strictEqual(b.experimental, true);
  assert.ok(b.current.age > 43 && b.current.age < 44); assert.strictEqual(b.current.inputs.length, 9);
  const alb = b.current.inputs.find((i) => i.id === "albumin"); assert.ok(/46 g\/L/.test(alb.used), alb.used);
  assert.ok(/0\.92 mg\/dL/.test(b.current.inputs.find((i) => i.id === "creatinine").shown) && /81\.3/.test(b.current.inputs.find((i) => i.id === "creatinine").used));
  assert.ok(/0\.08/.test(b.current.inputs.find((i) => i.id === "crp").used), "mg/L converted to mg/dL");
  assert.ok(b.previous && b.previous.date < b.current.date);
  assert.ok(Math.abs(b.current.diff - (b.current.phenoAge - b.current.age)) < 1e-9);
});
t("phenoage: missing markers, no labs, no birth month, old results outside the 180-day window", () => {
  const S = makeSamples(END, 45); const labs = IM.importLabEntries(JSON.parse(S["synthetic_labs_blood.json"])).labs;
  assert.strictEqual(PA.buildBioAge(labs, null).state, "needs-birth");
  assert.strictEqual(PA.buildBioAge([], "1983-05").state, "no-labs");
  const partial = PA.buildBioAge(labs.filter((l) => l.key !== "mcv"), "1983-05"); assert.strictEqual(partial.state, "incomplete"); assert.deepStrictEqual(partial.partial.missing.map((m) => m.id), ["mcv"]);
  const spread = PA.buildBioAge(labs.map((l) => (l.key === "albumin" ? Object.assign({}, l, { ts: "2025-01-01T00:00:00" }) : l)), "1983-05"); assert.strictEqual(spread.state, "incomplete", "albumin 9+ months away from the rest is outside the 180-day window");
  assert.strictEqual(PA.ageAt("1983-13", "2026-01-01"), null); assert.ok(Math.abs(PA.ageAt("1983-05", "2026-10-07") - 43.4) < 0.1);
});
t("service: profile birth month validated and kept only in the health folder; longevity tiles carry previous values and bands", () => {
  const { svc, root } = svcSeeded();
  assert.strictEqual(svc.extraLoad({ tab: "longevity" }).bio.state, "needs-birth");
  for (const bad of ["1983", "1983-13", "1899-01", "2999-01", "x", null]) assert.strictEqual(svc.extraAct({ op: "profile-set", birth: bad }).ok, false);
  assert.ok(svc.extraAct({ op: "profile-set", birth: "1983-05" }).ok);
  const d = svc.extraLoad({ tab: "longevity" }); assert.strictEqual(d.bio.state, "ok");
  assert.ok(fs.readFileSync(path.join(root, "profile.json"), "utf8").includes("1983-05"));
  assert.deepStrictEqual(d.tiles.map((x) => x.id), ["grip", "vo2max", "resting_hr", "hrv", "sleep_regularity", "weight", "body_fat"]);
  assert.ok(d.tiles.find((x) => x.id === "grip").empty && d.tiles.find((x) => x.id === "vo2max").empty, "no data yet: empty tiles with a hint");
  const rhr = d.tiles.find((x) => x.id === "weight"); assert.ok(rhr.previous && rhr.band && rhr.change);
  assert.ok(svc.addReading({ metric: "grip_strength", value: "42.5" }).ok && svc.addReading({ metric: "vo2max", value: "47" }).ok);
  assert.strictEqual(svc.extraLoad({ tab: "longevity" }).tiles.find((x) => x.id === "grip").valueText, "42.5 kg");
  assert.ok(!JSON.stringify(d).includes(root));
});
t("longevity: sleep regularity is the rolling 7-night spread; needs 7 nights", () => {
  const recs = []; for (let i = 0; i < 10; i++) recs.push({ ts: "2026-10-0" + (i + 1 > 9 ? 9 : i + 1) + "T00:00:00", value: 420 + (i % 2) * 60, source: "t" });
  const uniq = recs.map((r, i) => Object.assign({}, r, { ts: "2026-09-" + String(10 + i) + "T00:00:00" }));
  const reg = LG.sleepRegularity(uniq); assert.strictEqual(reg.length, 4); assert.ok(reg[0].value > 20 && reg[0].value < 40);
  assert.strictEqual(LG.sleepRegularity(uniq.slice(0, 5)).length, 0);
});

// ------------------------------------------------------------------ agent files 1b
t("interaction validation: severity enum, pair names, https sources only, an amount in the text is refused, no value in errors", () => {
  const ok = { id: "ix-1", a: "Magnesium", b: "Multivitamin", severity: "timing", summary: "Take at different times of day.", sources: [{ title: "x", url: "https://pubmed.ncbi.nlm.nih.gov/1/" }, { title: "bad", url: "http://insecure.example" }] };
  const r = AF.normalizeInteraction(ok); assert.ok(r.ok); assert.strictEqual(r.record.sources.length, 1);
  const dz = AF.normalizeInteraction(Object.assign({}, ok, { summary: "Take 500 mg twice. Spread them out." })); assert.ok(dz.ok && dz.record.amountRemoved && dz.record.summary.includes(AF.DF.NOTICE) && !/500/.test(dz.record.summary), "neutralised, not refused");
  for (const [patch, field] of [[{ severity: "meh" }, "severity"], [{ a: "" }, "pair"], [{ summary: "" }, "summary"], [{ id: "BAD ID" }, "id"]]) { const x = AF.normalizeInteraction(Object.assign({}, ok, patch)); assert.strictEqual(x.ok, false); assert.strictEqual(x.errors[0].field, field); assert.ok(!JSON.stringify(x).includes("500")); }
});
t("evidence validation: several evidence kinds per item, traditional is a first-class level, duplicates collapse, none refused", () => {
  const base = { id: "ev-1", name: "Turmeric", kind: "supplement", tradition: "ayurveda", evidence: [{ level: "traditional", strength: 5 }, { level: "single-study", strength: 2 }, { level: "traditional", strength: 1 }, { level: "vibes", strength: 3 }, { level: "preclinical", strength: 9 }] };
  const r = AF.normalizeEvidenceItem(base); assert.ok(r.ok); assert.deepStrictEqual(r.record.evidence.map((e) => e.level), ["traditional", "single-study"]); assert.strictEqual(r.record.max, 5);
  assert.ok(AF.EVIDENCE.indexOf("traditional") >= 0 && AF.EVIDENCE_LABEL.traditional.indexOf("Traditional") === 0);
  assert.strictEqual(AF.normalizeEvidenceItem(Object.assign({}, base, { evidence: [] })).ok, false);
  assert.strictEqual(AF.normalizeEvidenceItem(Object.assign({}, base, { kind: "potion" })).ok, false);
  const ez = AF.normalizeEvidenceItem(Object.assign({}, base, { summary: "1 g daily" })); assert.ok(ez.ok && ez.record.amountRemoved && ez.record.summary === AF.DF.NOTICE);
});
t("weekly and reading validation: week id shape, 3-6 plain points, no amounts", () => {
  assert.ok(AF.normalizeWeekly({ summary: "s", changed: ["a"] }, "2026-W40").ok); assert.strictEqual(AF.normalizeWeekly({ week: "2026-W99" }, null).ok, false); assert.ok(AF.normalizeWeekly({ summary: "take 2 g daily" }, "2026-W40").record.amountRemoved);
  const r = { id: "rd-1", title: "T", points: ["a", "b", "c"], evidence: { level: "guideline", strength: 3 }, source: { title: "s", url: "https://doi.org/10.1/x" }, minutes: 5 };
  assert.ok(AF.normalizeReading(r).ok);
  for (const pts of [["a", "b"], ["1", "2", "3", "4", "5", "6", "7"], []]) assert.strictEqual(AF.normalizeReading(Object.assign({}, r, { points: pts })).ok, false);
  const rz = AF.normalizeReading(Object.assign({}, r, { points: ["a", "b", "300 mg a day"] })); assert.ok(rz.ok && rz.record.amountRemoved && rz.record.points[2] === AF.DF.NOTICE);
  assert.strictEqual(AF.normalizeReading(Object.assign({}, r, { kind: "tweet" })).ok, false);
});
t("agent file reads: interactions, evidence, weekly list, reading with app state; the dose item is dropped", () => {
  const root = tmp(); write(root, Object.assign({}, makeAgentFiles2(END)));
  const a = AF.createAgentFiles(root);
  const ix = a.readInteractions(); assert.strictEqual(ix.pairs.length, 4); assert.strictEqual(ix.rejected, 0); assert.ok(ix.pairs.find((x) => x.id === "syn-ix-4").amountRemoved); assert.strictEqual(ix.checked, END);
  assert.strictEqual(a.readEvidenceMap().items.length, 6); assert.deepStrictEqual(a.listWeeks(), ["2026-W40"]); assert.ok(a.readWeek("2026-W40").summary); assert.strictEqual(a.readWeek("../../etc"), null); assert.strictEqual(a.readWeek("2026-W41"), null);
  const rd = a.readReading(); assert.strictEqual(rd.items.length, 2); assert.ok(rd.items.every((i) => i.read === false));
  assert.ok(a.setReading("syn-read-1", { read: true, note: "good" }).ok); const r2 = a.readReading().items.find((i) => i.id === "syn-read-1"); assert.ok(r2.read && r2.note === "good");
  assert.ok(a.setStatus("insights", "x-1", "saved").ok); assert.ok(a.readReading().items.find((i) => i.id === "syn-read-1").read, "reading state survives other state writes");
});

// ------------------------------------------------------------------ weekly
t("iso weeks: known dates, ranges, previous week, year boundaries", () => {
  assert.strictEqual(LG.isoWeek(new Date(2026, 9, 7)), "2026-W41"); assert.strictEqual(LG.isoWeek(new Date(2021, 0, 3)), "2020-W53"); assert.strictEqual(LG.isoWeek(new Date(2024, 11, 30)), "2025-W01");
  assert.deepStrictEqual(LG.weekRange("2026-W41"), { start: "2026-10-05", end: "2026-10-11" }); assert.strictEqual(LG.prevWeek("2026-W41"), "2026-W40"); assert.strictEqual(LG.prevWeek("2026-W01"), "2025-W52"); assert.strictEqual(LG.weekRange("nope"), null);
});
t("service weekly: week list (agent notes plus last weeks), stats beside the note, routines and experiments counts, selecting a week", () => {
  const { svc } = svcSeeded();
  const d = svc.extraLoad({ tab: "weekly" });
  assert.strictEqual(d.current, "2026-W41"); assert.strictEqual(d.selected, "2026-W40"); assert.ok(d.note && d.note.summary); assert.ok(d.weeks.find((w) => w.week === "2026-W40").hasNote); assert.ok(!d.weeks.find((w) => w.week === "2026-W41").hasNote);
  assert.ok(d.stats.rows.length > 3 && d.stats.rows.every((r) => r.label)); assert.ok(d.stats.routines.length === 3); assert.ok(d.stats.rows.some((r) => r.change));
  const w41 = svc.extraLoad({ tab: "weekly", week: "2026-W41" }); assert.strictEqual(w41.selected, "2026-W41"); assert.strictEqual(w41.note, null); assert.ok(w41.stats.rows.length > 0);
  assert.strictEqual(svc.extraLoad({ tab: "weekly", week: "bogus" }).selected, "2026-W40");
});

// ------------------------------------------------------------------ interactions, evidence, reading through the service
t("service interactions: pairs split into on-your-list and others, severity order, hosts shown, links allow-set, no lookups", () => {
  const { svc, opened } = svcSeeded();
  const d = svc.extraLoad({ tab: "interactions" });
  assert.strictEqual(d.meds.length, 2); assert.strictEqual(d.pairs.length, 4); assert.deepStrictEqual(d.pairs.map((p) => p.severity), ["serious", "caution", "timing", "info"]);
  assert.ok(d.pairs.find((p) => p.id === "syn-ix-1").onList); assert.ok(!d.pairs.find((p) => p.id === "syn-ix-3").onList);
  assert.strictEqual(d.pairs.find((p) => p.id === "syn-ix-1").sources[0].host, "pubmed.ncbi.nlm.nih.gov"); assert.ok(/doctor or pharmacist/.test(d.doctorLine));
  assert.ok(svc.openLink("https://pubmed.ncbi.nlm.nih.gov/12345678/").ok); assert.strictEqual(opened.length, 1);
});
t("service evidence: sorted by strongest evidence of any kind, traditional counted at face value, enums offered", () => {
  const { svc } = svcSeeded(); const d = svc.extraLoad({ tab: "evidence" });
  assert.strictEqual(d.items[0].name, "Turmeric (synthetic)", "traditional 5 outranks guideline 4: it is not discounted"); assert.ok(d.items.some((i) => i.evidence.some((e) => e.level === "traditional")));
  assert.ok(d.enums.traditions.length === 6 && d.enums.kinds.length === 4); assert.ok(d.items.every((i) => i.max === Math.max(...i.evidence.map((e) => e.strength))));
});
t("service reading: mark read and notes go to state.json and feedback.jsonl, nowhere else", () => {
  const { svc, root } = svcSeeded();
  assert.ok(svc.extraAct({ op: "reading-read", id: "syn-read-1", read: true }).ok); assert.ok(svc.extraAct({ op: "reading-note", id: "syn-read-1", text: "my private note" }).ok);
  const d = svc.extraLoad({ tab: "reading" }); const i = d.items.find((x) => x.id === "syn-read-1"); assert.ok(i.read && i.note === "my private note"); assert.strictEqual(i.host, "pubmed.ncbi.nlm.nih.gov"); assert.ok(i.points.length >= 3);
  const fb = fs.readFileSync(path.join(root, "agent", "feedback.jsonl"), "utf8").trim().split("\n").map(JSON.parse); assert.deepStrictEqual(fb.map((f) => f.type), ["reading-read", "reading-note"]);
  assert.strictEqual(svc.extraAct({ op: "reading-read", id: "BAD ID", read: true }).ok, false);
});

// ------------------------------------------------------------------ routines
t("routines: templates, add, +1 chunk with cheers, undo, never below zero, ring percentage", () => {
  const root = path.join(tmp(), "s"); const f = RT.createRoutineFile(root); const T0 = NOW;
  assert.ok(RT.TEMPLATES.length >= 7 && ["pushups", "pullups", "squats", "stretch", "water", "walk", "breathing"].every((id) => RT.TEMPLATES.some((x) => x.id === id)));
  const a = f.act("add", { template: "pushups" }, T0); assert.ok(a.ok); const id = a.id;
  const msgs = []; for (let i = 0; i < 5; i++) msgs.push(f.act("chunk", { id }, T0).cheer);
  assert.strictEqual(msgs[0], "First chunk in. Good start."); assert.strictEqual(msgs[2], "Halfway there."); assert.strictEqual(msgs[4], "All done for today. Nicely done!");
  const sum = RT.summarize(f.load().items[0], "2026-10-07"); assert.strictEqual(sum.done, 5); assert.strictEqual(sum.pct, 100); assert.ok(sum.complete);
  f.act("chunk", { id, delta: -1 }, T0); assert.strictEqual(RT.summarize(f.load().items[0], "2026-10-07").done, 4);
  for (let i = 0; i < 8; i++) f.act("chunk", { id, delta: -1 }, T0); assert.strictEqual(RT.summarize(f.load().items[0], "2026-10-07").done, 0);
  assert.ok(!msgs.concat(RT.cheer(1, 5)).some((m) => /fail|miss|lazy|behind|should/i.test(m)), "no guilt wording");
  assert.strictEqual(f.act("add", { title: "", unit: "", chunk: 0, perDay: 0 }, T0).ok, false); assert.ok(f.act("add", { title: "Mobility", unit: "reps", chunk: "12", perDay: "3" }, T0).ok);
  assert.strictEqual(f.act("chunk", { id: "r_ffffffffffffffff" }, T0).ok, false); assert.strictEqual(f.act("zzz", {}, T0).ok, false);
  assert.deepStrictEqual(fs.readdirSync(root).filter((x) => x.includes(".tmp")), []);
});
t("routines: streak counts completed days, a skipped or paused day never breaks it, an open today is not counted against you", () => {
  const item = RT.normalizeRoutine({ title: "x", unit: "u", chunk: 1, perDay: 2, created: "2026-09-01", log: { "2026-10-03": { done: 2 }, "2026-10-04": { done: 2 }, "2026-10-05": { done: 0, skipped: true }, "2026-10-06": { done: 2 } } });
  assert.strictEqual(RT.streak(item, "2026-10-07"), 3, "today open, yesterday and two earlier done, the skip bridges");
  item.log["2026-10-07"] = { done: 2, skipped: false }; assert.strictEqual(RT.streak(item, "2026-10-07"), 4);
  item.log["2026-10-06"] = { done: 1, skipped: false }; assert.strictEqual(RT.streak(item, "2026-10-07"), 1, "a real miss ends the run");
  const st = RT.normalizeState({ items: [{ title: "x", unit: "u", chunk: 1, perDay: 1, created: "2026-10-02", log: { "2026-10-02": { done: 1 } } }] });
  const o = RT.OPS; const id = st.items[0].id;
  o.pause(st, { id }, "2026-10-03"); o.resume(st, { id }, "2026-10-07"); const it = st.items[0];
  assert.ok(it.log["2026-10-03"].skipped && it.log["2026-10-06"].skipped && !it.log["2026-10-07"], "paused days are filled as skipped on resume");
  assert.strictEqual(RT.streak(it, "2026-10-07"), 1, "the pause did not break the earlier day");
});
t("routines: week view, next-chunk hint, state normalization caps and cleans", () => {
  const st = RT.normalizeState(JSON.parse(makeRoutines(END)));
  const s = RT.summarize(st.items[0], "2026-10-07"); assert.strictEqual(s.week.length, 7); assert.strictEqual(s.week[6].date, "2026-10-07"); assert.ok(s.weekChunks >= 20);
  const hint = RT.nextChunk(st, "2026-10-07"); assert.ok(hint && /push-ups|glass|pull-up/.test(hint.text));
  assert.strictEqual(RT.nextChunk(RT.normalizeState({ items: [] }), "2026-10-07"), null);
  const evil = RT.normalizeState({ quiet: { start: "99:99", end: "07:00" }, items: [{ title: "a‮b", unit: "u", chunk: 5, perDay: 99 }, { title: "ok", unit: "u", chunk: 1, perDay: 3, log: { "bad": { done: 1 }, "2026-10-01": { done: 9999 } }, reminders: { enabled: true, times: ["09:00", "25:00", "09:00", "x"] } }] });
  assert.strictEqual(evil.quiet.start, "22:00"); assert.strictEqual(evil.items.length, 1); assert.deepStrictEqual(evil.items[0].reminders.times, ["09:00"]); assert.strictEqual(evil.items[0].log["2026-10-01"].done, 0, "absurd counts become 0"); assert.strictEqual(evil.items[0].log.bad, undefined);
});
t("reminder rules: next due time, quiet hours across midnight, snooze, done/skipped/paused routines stay quiet, 5 minute grace", () => {
  const mk = (extra) => RT.normalizeState({ items: [Object.assign({ title: "x", unit: "u", chunk: 1, perDay: 2, reminders: { enabled: true, times: ["09:00", "15:30"] }, created: "2026-10-01" }, extra)] });
  const at = (h, m) => new Date(2026, 9, 7, h, m, 0).getTime();
  assert.strictEqual(RT.nextDue(mk(), at(10, 0)), at(15, 30)); assert.strictEqual(RT.nextDue(mk(), at(16, 0)), new Date(2026, 9, 8, 9, 0, 0).getTime());
  assert.strictEqual(RT.nextDue(mk({ reminders: { enabled: false, times: ["09:00"] } }), at(8, 0)), null); assert.strictEqual(RT.nextDue(mk({ paused: true }), at(8, 0)), null);
  assert.ok(RT.shouldNotify(mk(), at(9, 0))); assert.ok(RT.shouldNotify(mk(), at(9, 4))); assert.ok(!RT.shouldNotify(mk(), at(9, 6)), "late: skipped");
  assert.ok(RT.inQuiet({ start: "22:00", end: "07:00" }, new Date(2026, 9, 7, 23, 0))); assert.ok(RT.inQuiet({ start: "22:00", end: "07:00" }, new Date(2026, 9, 7, 6, 59))); assert.ok(!RT.inQuiet({ start: "22:00", end: "07:00" }, new Date(2026, 9, 7, 12, 0)));
  const quiet = mk(); quiet.quiet = { start: "08:00", end: "10:00" }; assert.ok(!RT.shouldNotify(quiet, at(9, 0)));
  const snz = mk(); snz.snoozeUntil = new Date(at(9, 30)).toISOString(); assert.ok(!RT.shouldNotify(snz, at(9, 0)));
  assert.ok(!RT.shouldNotify(mk({ log: { "2026-10-07": { done: 2 } } }), at(9, 0)), "target met"); assert.ok(!RT.shouldNotify(mk({ log: { "2026-10-07": { done: 0, skipped: true } } }), at(9, 0)), "skipped");
});
t("reminder scheduler: NO timer when nothing is enabled; exactly one when enabled; neutral fixed text; cleared when disabled; late fire stays silent", () => {
  let state = RT.normalizeState({ items: [{ title: "Secret routine name", unit: "u", chunk: 1, perDay: 3, reminders: { enabled: false, times: ["09:00"] }, created: "2026-10-01" }] });
  let clock = new Date(2026, 9, 7, 8, 0, 0).getTime(); const timers = new Map(); let id = 0; const shown = [], logs = [];
  const rm = RM.create({ load: () => state, now: () => clock, notify: (x) => shown.push(x), log: (l) => logs.push(l), setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: (h) => timers.delete(h) });
  assert.deepStrictEqual(rm.boot(), { armed: false }); assert.strictEqual(timers.size, 0, "no timer when no reminder is enabled");
  state.items[0].reminders.enabled = true; assert.ok(rm.rearm().armed); assert.strictEqual(timers.size, 1); assert.strictEqual([...timers.values()][0].ms, 3600000);
  rm.rearm(); rm.rearm(); assert.strictEqual(timers.size, 1, "never more than one handle");
  clock = new Date(2026, 9, 7, 9, 0, 1).getTime(); const [h, tm] = [...timers.entries()][0]; timers.delete(h); tm.fn();
  assert.deepStrictEqual(shown, ["Routine: time for a chunk"]); assert.ok(!shown.join("").includes("Secret")); assert.strictEqual(RM.NEUTRAL_TEXT, "Routine: time for a chunk");
  assert.strictEqual(timers.size, 1, "re-armed for tomorrow"); assert.ok(logs.every((l) => /^reminder: shown=[01]$/.test(l)));
  clock = new Date(2026, 9, 8, 9, 20, 0).getTime(); const [h2, t2] = [...timers.entries()][0]; timers.delete(h2); t2.fn(); assert.strictEqual(shown.length, 1, "fired 20 minutes late (e.g. after sleep): silent");
  state.items[0].reminders.enabled = false; rm.rearm(); assert.strictEqual(timers.size, 0, "disabling clears the timer"); assert.ok(!rm.armed());
  state.items[0].reminders.enabled = true; rm.rearm(); rm.stop(); assert.strictEqual(timers.size, 0);
});
t("service routines: ops through extraAct, reminders re-armed on changes only, hint on Today, summaries, no logs of names", () => {
  const { svc, logs, rearms } = svcSeeded();
  const r = svc.extraLoad({ tab: "routines" }); assert.strictEqual(r.items.length, 3); assert.ok(r.templates.length >= 7); assert.strictEqual(r.today, "2026-10-07"); assert.strictEqual(r.remindersOn, false);
  const id = r.items[0].id; const before = rearms.length;
  assert.ok(svc.extraAct({ op: "routine-chunk", id }).ok); assert.strictEqual(rearms.length, before, "a chunk never touches the scheduler");
  assert.ok(svc.extraAct({ op: "routine-reminders", id, enabled: true, times: ["09:00", "18:00"] }).ok); assert.strictEqual(rearms.length, before + 1);
  assert.ok(svc.extraLoad({ tab: "routines" }).remindersOn); assert.ok(svc.extraAct({ op: "routine-snooze", minutes: 60 }).ok); assert.ok(svc.extraLoad({ tab: "routines" }).snoozeUntil);
  assert.ok(svc.extraAct({ op: "routine-quiet", start: "21:00", end: "06:30" }).ok); assert.strictEqual(svc.extraAct({ op: "routine-quiet", start: "9pm", end: "6" }).ok, false);
  assert.ok(svc.extraAct({ op: "routine-pause", id }).ok); assert.ok(svc.extraAct({ op: "routine-resume", id }).ok); assert.ok(svc.extraAct({ op: "routine-skip", id }).ok); assert.ok(svc.extraAct({ op: "routine-remove", id }).ok);
  assert.strictEqual(svc.extraLoad({ tab: "routines" }).items.length, 2); assert.strictEqual(svc.extraAct({ op: "routine-nope" }).ok, false); assert.strictEqual(svc.extraAct({ op: "bad" }).ok, false);
  const snap = svc.load(); assert.ok(snap.nextChunk && snap.nextChunk.text);
  for (const l of logs) assert.ok(/^(extra act|agent act|health error|import|lab add|reading add|link open): /.test(l) && !/push|water|pull|Synthetic/i.test(l), l);
});



// ------------------------------------------------------------------ nutrition
const RC = () => JSON.parse(makeAgentFiles2(END)["agent/recipes/" + END + ".json"]).recipes;
t("recipe validation: vegan must be true, FOOD amounts are allowed (no dose filter), local image path rules, season default, vegan check flags", () => {
  const [lentil, b12, tahini, bad] = RC();
  const r = AF.normalizeRecipe(lentil, END); assert.ok(r.ok); assert.ok(r.record.ingredients.some((i) => i.amount === "200 g"), "200 g of lentils is a food amount, not refused"); assert.ok(r.record.nutrients.some((n) => n.perServing === "5 mg"), "nutrient mg per serving is fine");
  assert.strictEqual(AF.normalizeRecipe(bad, END).ok, false); assert.strictEqual(AF.normalizeRecipe(bad, END).errors[0].field, "vegan");
  for (const v of [undefined, "true", 1, null]) assert.strictEqual(AF.normalizeRecipe(Object.assign({}, lentil, { vegan: v }), END).ok, false, "vegan " + v);
  assert.deepStrictEqual(AF.normalizeRecipe(tahini, END).record.veganCheck, ["Honey"]); assert.deepStrictEqual(AF.normalizeRecipe(lentil, END).record.veganCheck, []);
  assert.deepStrictEqual(AF.normalizeRecipe(Object.assign({}, lentil, { ingredients: [{ item: "Coconut milk", amount: "1 can" }, { item: "Butter beans", amount: "1" }, { item: "Peanut butter", amount: "2 tbsp" }, { item: "Eggplant", amount: "1" }] }), END).record.veganCheck, [], "plant milks and butters are not flagged");
  assert.strictEqual(AF.normalizeRecipe(Object.assign({}, lentil, { image: "images/ok-1.png" }), END).record.image, "images/ok-1.png");
  for (const img of ["../x.png", "C:/x.png", "https://evil.example/x.png", "images/../x.png", "/etc/passwd", "images/x.gif", "images/a b.png"]) assert.strictEqual(AF.normalizeRecipe(Object.assign({}, lentil, { image: img }), END).record.image, null, img);
  assert.strictEqual(AF.normalizeRecipe(Object.assign({}, lentil, { season: "monsoon" }), END).record.season, "all-year"); assert.strictEqual(AF.normalizeRecipe(Object.assign({}, lentil, { ingredients: [] }), END).ok, false); assert.strictEqual(AF.normalizeRecipe(Object.assign({}, lentil, { steps: [] }), END).ok, false);
  assert.strictEqual(AF.normalizeRecipe(Object.assign({}, lentil, { sources: [{ title: "x", url: "http://a.example" }] }), END).record.sources.length, 0);
});
t("recipe image: only a small file inside agent\\recipes\\images, returned as a data URL, nothing remote", () => {
  const root = tmp(); const a = AF.createAgentFiles(root); fs.mkdirSync(path.join(root, "agent", "recipes", "images"), { recursive: true });
  fs.writeFileSync(path.join(root, "agent", "recipes", "images", "ok.png"), Buffer.from("89504e470d0a1a0a", "hex")); fs.writeFileSync(path.join(root, "agent", "recipes", "images", "big.png"), Buffer.alloc(500000));
  assert.ok(/^data:image\/png;base64,/.test(a.readRecipeImage("images/ok.png"))); assert.strictEqual(a.readRecipeImage("images/big.png"), null); assert.strictEqual(a.readRecipeImage("images/missing.png"), null);
  for (const bad of ["../../state.json", "images/../ok.png", "http://x/y.png", null, 5]) assert.strictEqual(a.readRecipeImage(bad), null);
});
t("nutrition focus: low/high markers outside the lab range or optimal zone, or trending the wrong way; coverage counts recipes", () => {
  const S = makeSamples(END, 45);
  const labs = [].concat(IM.importLabEntries(JSON.parse(S["synthetic_labs_nutrition.json"])).labs, IM.importLabEntries(JSON.parse(S["synthetic_labs.json"])).labs);
  const f = NU.focusFor(labs); const by = (n) => f.filter((x) => x.nutrient === n);
  assert.strictEqual(f[0].rank, 0); assert.ok(f.some((x) => x.nutrient === "Zinc" && /below the lab range/.test(x.reason))); assert.ok(by("B12").length === 1 && /optimal zone/.test(by("B12")[0].reason)); assert.ok(f.some((x) => x.nutrient === "Omega-3" && /above the lab range/.test(x.reason)));
  assert.ok(f.some((x) => x.nutrient === "Iron" && /trending down/.test(x.reason)), "ferritin 92, 88, 85");
  assert.ok(!f.some((x) => x.key === "tsh"), "unlinked markers are not shown"); assert.ok(f.every((x) => x.series.length >= 1 && x.series.every((p) => p.ts)));
  const high = NU.focusFor([{ key: "ferritin", test: "Ferritin", unit: "ng/mL", value: 500, refLow: 30, refHigh: 400, ts: "2026-09-01T00:00:00", source: "t", id: "a" }]); assert.strictEqual(high.length, 0, "high ferritin is not an iron focus");
  const recipes = RC().map((r) => AF.normalizeRecipe(r, END)).filter((x) => x.ok).map((x) => Object.assign(x.record, { status: "new" }));
  const cov = NU.coverage(f, recipes); assert.ok(cov.find((x) => x.nutrient === "Zinc").recipeCount === 2); assert.ok(cov.find((x) => x.nutrient === "B12").recipeCount === 1); assert.strictEqual(cov.find((x) => x.nutrient === "Omega-3").recipeCount, 1);
  recipes[0].status = "dismissed"; assert.strictEqual(NU.coverage(f, recipes).find((x) => x.nutrient === "Zinc").recipeCount, 1, "dismissed recipes do not count");
});
t("shopping aggregation: same unit is summed, different units are listed, case-insensitive items, sources tracked", () => {
  const items = NU.aggregate({ a: { title: "A", ingredients: [{ item: "Lemon", amount: "1" }, { item: "Red lentils", amount: "200 g" }, { item: "Olive oil", amount: "2 tbsp" }] }, b: { title: "B", ingredients: [{ item: "lemon", amount: "2" }, { item: "Red lentils", amount: "100 g" }, { item: "Olive oil", amount: "1 tbsp" }, { item: "Salt", amount: "to taste" }, { item: "Olive Oil", amount: "50 ml" }] } });
  const g = (k) => items.find((i) => i.key === k); assert.strictEqual(g("lemon").amount, "3"); assert.strictEqual(g("red lentils").amount, "300 g"); assert.strictEqual(g("olive oil").amount, "2 tbsp + 1 tbsp + 50 ml"); assert.strictEqual(g("salt").amount, "to taste"); assert.deepStrictEqual(g("lemon").from.sort(), ["a", "b"]);
});
t("service nutrition: recipes with refs, focus with coverage, actions write state and feedback, shopping list keeps snapshots", () => {
  const { svc, root, logs, opened } = svcSeeded();
  const d = svc.extraLoad({ tab: "nutrition" });
  assert.strictEqual(d.recipes.length, 3); assert.strictEqual(d.rejected, 1); assert.ok(d.recipes.every((r) => r.vegan === true && r.status === "new")); assert.ok(d.focus.length >= 4 && d.focus.every((f) => f.recipeCount >= 0));
  const lentil = d.recipes.find((r) => r.id === "syn-rc-lentil"); assert.ok(lentil.why.relates.find((q) => q.type === "lab" && q.label === "Zinc" && q.last)); assert.strictEqual(lentil.sources[0].host, "pubmed.ncbi.nlm.nih.gov"); assert.ok(!JSON.stringify(d).includes(root));
  assert.ok(svc.extraAct({ op: "recipe-cooked", id: "syn-rc-lentil" }).ok); assert.ok(svc.extraAct({ op: "recipe-not-for-me", id: "syn-rc-tahini" }).ok); assert.ok(svc.extraAct({ op: "recipe-save", id: "syn-rc-b12" }).ok);
  assert.strictEqual(svc.extraAct({ op: "recipe-save", id: "ghost" }).ok, false);
  const st = (id) => svc.extraLoad({ tab: "nutrition" }).recipes.find((r) => r.id === id).status; assert.deepStrictEqual([st("syn-rc-lentil"), st("syn-rc-tahini"), st("syn-rc-b12")], ["cooked", "dismissed", "saved"]);
  const fb = fs.readFileSync(path.join(root, "agent", "feedback.jsonl"), "utf8").trim().split("\n").map(JSON.parse); assert.deepStrictEqual(fb.map((x) => x.type), ["cooked", "recipe-dismiss", "recipe-save"]); assert.ok(fb.every((x) => x.target === "recipe"));
  assert.ok(svc.extraAct({ op: "recipe-shop", id: "syn-rc-lentil" }).ok); assert.ok(svc.extraAct({ op: "recipe-shop", id: "syn-rc-b12" }).ok);
  let sh = svc.extraLoad({ tab: "nutrition" }).shopping; assert.strictEqual(sh.recipes.length, 2); assert.ok(sh.items.find((i) => i.key === "olive oil").amount === "3 tbsp"); assert.strictEqual(sh.left, sh.items.length);
  assert.ok(svc.extraAct({ op: "shop-check", key: "lemon", checked: true }).ok); sh = svc.extraLoad({ tab: "nutrition" }).shopping; assert.ok(sh.items.find((i) => i.key === "lemon").checked); assert.strictEqual(sh.left, sh.items.length - 1);
  fs.rmSync(path.join(root, "agent", "recipes"), { recursive: true, force: true });
  assert.strictEqual(svc.extraLoad({ tab: "nutrition" }).shopping.items.length > 5, true, "the list survives the recipe file going away");
  assert.ok(svc.extraAct({ op: "shop-clear-checked" }).ok); sh = svc.extraLoad({ tab: "nutrition" }).shopping; assert.ok(!sh.items.find((i) => i.key === "lemon"));
  assert.ok(svc.extraAct({ op: "recipe-unshop", id: "syn-rc-b12" }).ok); assert.ok(svc.extraAct({ op: "shop-clear-all" }).ok); assert.strictEqual(svc.extraLoad({ tab: "nutrition" }).shopping.items.length, 0);
  assert.strictEqual(svc.extraAct({ op: "shop-check", key: "", checked: true }).ok, false);
  for (const l of logs) assert.ok(/^(extra act|agent act|health error|link open): /.test(l) && !/lentil|lemon|syn-|Zinc/i.test(l), l);
  assert.ok(opened.length === 0, "no browser or network use from nutrition");
});
t("nutrition wiring: no remote requests, images are data URLs only, textContent only, shopping.json atomic and app-owned", () => {
  const more = fs.readFileSync(path.join(SRC, "renderer", "health-more.js"), "utf8");
  assert.ok(/im\.src = r\.imageData/.test(more) && !/\.src = ["'`]http/.test(more)); assert.ok(!/innerHTML|outerHTML|fetch\(|XMLHttpRequest/.test(more));
  for (const w of ["Cooked it", "Not for me", "Save", "Add to shopping list", "Planned from", "Remove checked items", "Show method"]) assert.ok(more.includes(w), w);
  const svcSrc = fs.readFileSync(path.join(SRC, "health", "service.js"), "utf8"); assert.ok(/AT\.write\(fsMod, shopFile/.test(svcSrc), "shopping.json goes through the atomic writer");
  assert.ok(!/https?:\/\//.test(fs.readFileSync(path.join(SRC, "health", "nutrition.js"), "utf8").replace(/\/\/.*$/gm, "")));
});

// ------------------------------------------------------------------ charts: real points, dates, units, bands
t("chart data: every chart series carries real dates and values plus unit and decimals (tiles, trends, labs, experiments, weekly)", () => {
  const { svc } = svcSeeded();
  const today = svc.load().todayView.tiles; assert.ok(today.length > 3);
  for (const x of today) { assert.ok(x.series.length >= 1 && x.series.every((p) => /^\d{4}-\d\d-\d\dT/.test(p.ts) && isFinite(p.v)), x.id); assert.ok(typeof x.unit === "string" && Number.isInteger(x.dec)); }
  assert.strictEqual(today.find((x) => x.id === "sleep").kind, "sleep");
  const w = today.find((x) => x.id === "weight"); assert.ok(w.band && w.band.low < w.band.high && w.series.length <= 14);
  const labs = svc.load().labsView.rows; assert.ok(labs.every((r) => r.series.length >= 1 && r.series.every((p) => p.ts && isFinite(p.v)))); assert.ok(labs.find((r) => r.key === "ldl-cholesterol").refBand.high === 130);
  const tr = svc.agentLoad().trends.rows; assert.ok(tr.every((r) => r.series.length >= 1 && r.series.every((p) => p.ts)) && tr.some((r) => r.refBand));
  const id = svc.agentAct({ op: "insight", id: "syn-evening-light", action: "try-it" }).experiment; const e = svc.agentLoad().experiments.find((x) => x.id === id);
  assert.ok(e.series.every((p) => p.ts) && e.unit === "min");
  const wk = svc.extraLoad({ tab: "weekly", week: "2026-W40" }).stats.rows; assert.ok(wk.every((r) => r.series.every((p) => p.ts && isFinite(p.v)) && r.startTs === "2026-09-28"));
  assert.ok(svc.extraLoad({ tab: "longevity" }).tiles.filter((x) => !x.empty).every((x) => x.series.length >= 1));
});
t("chart module: markers for every point, labelled latest/min/max (all values at 14 or fewer), axes with numbers, band numbers, tooltip, keyboard, numbers table; no bare sparkline left", () => {
  const c = fs.readFileSync(path.join(SRC, "renderer", "health-chart.js"), "utf8");
  for (const needle of ["pts.forEach((p, i) =>", "hl-ptlbl", "hl-axis", "hl-bandtxt", "niceTicks", "hl-goal", "rotate(", " now", " min", " max", 'sv("title"', "tabindex", "ArrowRight", "ArrowLeft", "Show numbers", "hl-numtable", "dayText(p.ts)", "withUnit(", "aria-label", "mouseenter", '"focus"', "startTs"]) assert.ok(c.includes(needle), needle);
  assert.ok(!/innerHTML|outerHTML|setTimeout|setInterval|requestAnimationFrame|localStorage|fetch\(|console\./.test(c));
  for (const f of ["health.js", "health-agent.js", "health-more.js"]) { const r = fs.readFileSync(path.join(SRC, "renderer", f), "utf8"); assert.ok(!/hl-spark|function spark|\.spark\b/.test(r), f + " still has a bare sparkline"); }
  const nav = fs.readFileSync(path.join(SRC, "renderer", "health-nav.js"), "utf8"); assert.ok(nav.indexOf("health-chart.js") > 0 && nav.indexOf("health-chart.js") < nav.indexOf('"health.js"'), "chart module loads before the view, lazily");
  assert.ok(!fs.readFileSync(path.join(SRC, "renderer", "index.html"), "utf8").includes("health-chart.js"));
  assert.ok(/ui\.chart\(|healthChart\.make\(/.test(fs.readFileSync(path.join(SRC, "renderer", "health.js"), "utf8")));
});

// ------------------------------------------------------------------ wiring and guards
t("ipc: extra channels registered; the reminder scheduler exists at start but arms nothing without enabled reminders; boot is one read", () => {
  const handlers = {}; const wc = { id: 1 }; const dir = tmp(); const shown = [];
  const h = MH.init({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, getMainWindow: () => ({ webContents: wc, isDestroyed: () => false }), dialog: null, userData: dir, testMode: true, log: () => {}, env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(dir, "st") }, notify: (x) => shown.push(x) });
  for (const c of ["health-extra-load", "health-extra-act"]) assert.strictEqual(typeof handlers[c], "function", c);
  assert.deepStrictEqual(h.boot(), { armed: false }); assert.strictEqual(h.reminders.armed(), false);
  fs.mkdirSync(path.join(dir, "st"), { recursive: true }); fs.writeFileSync(path.join(dir, "st", "routines.json"), makeRoutines(END).replace('"enabled":false,"times":[]', '"enabled":true,"times":["23:59"]'));
  const r = h.boot(); assert.ok(r.armed); h.reminders.stop(); assert.strictEqual(h.reminders.armed(), false);
});
t("main/preload/renderer wiring: one lazy require in main, boot after ready, neutral notification, lazy stage 1b renderer, no timers or persistence", () => {
  const main = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
  assert.strictEqual((main.match(/require\("\.\/health\//g) || []).length, 1); assert.ok(/healthMain\.boot\(\)/.test(main) && /app\.whenReady\(\)\.then\(\(\) => healthMain\.boot/.test(main));
  assert.ok(/new Notification\(\{ title: "Routine", body: text \}\)/.test(main), "title and body are neutral and fixed");
  const pre = fs.readFileSync(path.join(SRC, "preload.js"), "utf8"); assert.ok(/health-extra-load/.test(pre) && /health-extra-act/.test(pre));
  const more = fs.readFileSync(path.join(SRC, "renderer", "health-more.js"), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|fetch\(|XMLHttpRequest|setTimeout|setInterval|requestAnimationFrame|console\.(log|info|debug|warn)|Notification|window\.open/.test(more));
  assert.ok(!fs.readFileSync(path.join(SRC, "renderer", "index.html"), "utf8").includes("health-more.js")); assert.ok(fs.readFileSync(path.join(SRC, "renderer", "health.js"), "utf8").includes('"health-more.js"'));
  const rem = fs.readFileSync(path.join(SRC, "health", "reminders.js"), "utf8").replace(/\/\/.*$/gm, ""); assert.strictEqual((rem.match(/setT\(/g) || []).length, 1, "one place creates a timer"); assert.ok(!/setInterval|Notification|require\("electron"\)/.test(rem));
  for (const f of ["reminders.js", "routines.js", "longevity.js", "phenoage.js"]) assert.ok(!/console\.|document\.title|clipboard|fetch\(|child_process/.test(fs.readFileSync(path.join(SRC, "health", f), "utf8")), f);
});

(async () => {
  for (const q of queue) { n++; try { await q.fn(); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); } }
  console.log(fails ? fails + " of " + n + " FAILED" : "health-1b: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
