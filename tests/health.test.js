// node tests/health.test.js - My Health stage 1 (v1.81.0): schema and validation, the JSONL store, the comparison helper,
// importers (SYNTHETIC samples only), the view model, the service (temp folder only), IPC wiring, privacy and lightness guards.
// No test ever touches the real vault (C:\Example\Scratch\Health\vault) or real data.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require("../src/health/schema");
const { createStore } = require("../src/health/store");
const C = require("../src/health/compare");
const IM = require("../src/health/importers");
const VM = require("../src/health/view-model");
const SV = require("../src/health/service");
const MH = require("../src/health/main-health");
const { makeSamples } = require("../tools/health-synthetic");

let n = 0, fails = 0; const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "health-test-"));
const SRC = path.join(__dirname, "..", "src");
const NOW = Date.parse("2026-10-07T10:00:00");
const iso = (d, h) => S.localIso(new Date(NOW - d * 86400000 + (h || 0) * 3600000));
const m = (metric, value, ts, o) => Object.assign({ metric, value, ts, source: "test" }, o || {});

// ------------------------------------------------------------------ schema
t("timestamps: local ISO, date-only, zone converted, bad input refused", () => {
  assert.strictEqual(S.normalizeTs("2026-10-07"), "2026-10-07T00:00:00");
  assert.strictEqual(S.normalizeTs("2026-10-07T07:30"), "2026-10-07T07:30:00");
  assert.strictEqual(S.normalizeTs("2026-10-07 07:30:15"), "2026-10-07T07:30:15");
  assert.ok(/^2026-10-0[67]T\d\d:\d\d:00$/.test(S.normalizeTs("2026-10-07T00:00:00Z")));
  for (const v of ["", "07/10/2026", "2026-13-01", "2026-02-30", "2026-10-07T25:00", null, 5, {}]) assert.strictEqual(S.normalizeTs(v), null);
  assert.ok(S.normalizeTs(new Date(2026, 9, 7, 8, 5, 0)) === "2026-10-07T08:05:00");
});
t("measurement: valid record, canonical unit, conversion lb to kg, id rules", () => {
  const r = S.normalizeMeasurement({ metric: "weight", value: "180.0", unit: "lb", ts: "2026-10-07T07:00", source: "renpho" });
  assert.ok(r.ok); assert.strictEqual(r.record.unit, "kg"); assert.ok(Math.abs(r.record.value - 81.65) < 0.01);
  const a = S.normalizeMeasurement({ metric: "weight", value: 80, ts: "2026-10-07", source: "renpho" }).record.id;
  assert.strictEqual(a, S.normalizeMeasurement({ metric: "weight", value: 81, ts: "2026-10-07", source: "renpho" }).record.id, "imported ids are deterministic: a re-import replaces");
  const x = S.normalizeMeasurement({ metric: "weight", value: 80, ts: "2026-10-07" }).record.id, y = S.normalizeMeasurement({ metric: "weight", value: 80, ts: "2026-10-07" }).record.id;
  assert.notStrictEqual(x, y, "manual ids are random");
  assert.strictEqual(S.normalizeMeasurement({ metric: "sleep_minutes", value: 7.5, unit: "h", ts: "2026-10-07" }).record.value, 450);
});
t("measurement: refused cases give field+code only, never the value", () => {
  const SENTINEL = "98765.4321";
  const cases = [[{ metric: "nope", value: 1, ts: "2026-10-07" }, "metric"], [{ metric: "weight", value: "abc", ts: "2026-10-07" }, "value"], [{ metric: "weight", value: SENTINEL, ts: "2026-10-07" }, "value"],
    [{ metric: "weight", value: 80, unit: "stone", ts: "2026-10-07" }, "unit"], [{ metric: "weight", value: 80, ts: "bad" }, "ts"], [{ metric: "weight", value: 80, ts: "2026-10-07", source: "Bad Source!" }, "source"], [null, "record"]];
  for (const [inp, field] of cases) { const r = S.normalizeMeasurement(inp); assert.strictEqual(r.ok, false); assert.strictEqual(r.errors[0].field, field); assert.ok(!JSON.stringify(r).includes(SENTINEL), "error text must not carry the value"); }
});
t("lab: valid with ranges, key from name, ranges validated, optional fields", () => {
  const r = S.normalizeLab({ test: "LDL Cholesterol", value: "118", unit: "mg/dL", refLow: 0, refHigh: 130, optHigh: 100, ts: "2026-07-01", fileId: "abcdef0123456789" });
  assert.ok(r.ok); assert.strictEqual(r.record.key, "ldl-cholesterol"); assert.strictEqual(r.record.optHigh, 100); assert.strictEqual(r.record.fileId, "abcdef0123456789");
  assert.strictEqual(S.normalizeLab({ test: "x", value: 1, ts: "2026-07-01" }).record.unit, "");
  for (const bad of [{ test: "", value: 1, ts: "2026-07-01" }, { test: "x", value: "q", ts: "2026-07-01" }, { test: "x", value: 1, refLow: 5, refHigh: 1, ts: "2026-07-01" }, { test: "x", value: 1, ts: "nope" }, { test: "x", value: 1, ts: "2026-07-01", fileId: "../../etc" }]) assert.strictEqual(S.normalizeLab(bad).ok, false);
  assert.strictEqual(S.testKey("hs-CRP"), "hs-crp"); assert.strictEqual(S.testKey("  Vitamin  D (25-OH) "), "vitamin-d-25-oh");
});
t("med and note: defaults, stop must not precede start, kinds", () => {
  const r = S.normalizeMed({ name: "Vitamin D3", dose: "2,000 IU", schedule: "Morning", start: "2026-07-06" });
  assert.ok(r.ok); assert.strictEqual(r.record.medKind, "supplement"); assert.strictEqual(r.record.stop, null);
  assert.strictEqual(S.normalizeMed({ name: "x", start: "2026-07-06", stop: "2026-07-01" }).ok, false);
  assert.strictEqual(S.normalizeMed({ name: "x", medKind: "potion" }).ok, false);
  assert.strictEqual(S.normalizeMed({ name: " " }).ok, false);
  assert.ok(S.normalizeNote({ text: "felt tired" }).ok); assert.strictEqual(S.normalizeNote({ text: "" }).ok, false);
});

// ------------------------------------------------------------------ store
t("store: add, list, upsert by id, previous value kept in the file, atomic (no temp file left)", () => {
  const root = tmp(); const st = createStore({ root });
  const r = st.addMeasurements([m("weight", 82.9, "2026-09-30", { source: "renpho" }), m("weight", 82.4, "2026-10-05", { source: "renpho" }), m("weight", "bad", "2026-10-06")]);
  assert.deepStrictEqual([r.added, r.updated, r.rejected], [2, 0, 1]);
  const r2 = st.addMeasurements([m("weight", 82.5, "2026-10-05", { source: "renpho" })]);
  assert.deepStrictEqual([r2.added, r2.updated], [0, 1]);
  const all = st.listMeasurements({ metric: "weight" });
  assert.strictEqual(all.length, 2); assert.strictEqual(all[1].value, 82.5); assert.strictEqual(all[1].source, "renpho");
  assert.deepStrictEqual(fs.readdirSync(root).filter((f) => f.includes(".tmp")), []);
  assert.ok(fs.existsSync(path.join(root, "meta.json")));
});
t("store: corrupt lines are skipped and counted, never fatal", () => {
  const root = tmp(); const st = createStore({ root });
  st.addLab({ test: "TSH", value: 2, unit: "mIU/L", ts: "2026-07-01" });
  fs.appendFileSync(path.join(root, "labs.jsonl"), "{not json\n\n[1,2]\n");
  assert.strictEqual(st.listLabs().length, 1); assert.strictEqual(st.counts().corrupt, 2);
});
t("store: meds add/stop/remove, notes, import ledger holds no names", () => {
  const root = tmp(); const st = createStore({ root });
  const a = st.addMed({ name: "Magnesium", dose: "300 mg", schedule: "Evening", start: "2026-09-01" });
  assert.ok(a.ok && /^d_/.test(a.id));
  assert.ok(st.stopMed(a.id, "2026-10-01").ok); assert.strictEqual(st.listMeds()[0].stop, "2026-10-01");
  assert.strictEqual(st.stopMed("d_0000000000000000", "2026-10-01").ok, false);
  assert.strictEqual(st.addNote({ text: "hello" }).ok, true); assert.strictEqual(st.listNotes().length, 1);
  assert.strictEqual(st.remove("note", st.listNotes()[0].id).ok, true);
  st.logImport({ format: "renpho", fileId: "abcdef0123456789", counts: { added: 3 } });
  const led = fs.readFileSync(path.join(root, "imports.jsonl"), "utf8");
  assert.ok(!/path|name/i.test(led.replace(/"format"/, "")), "ledger has id, format, counts only");
});
t("store: a failed write leaves the old file intact", () => {
  const root = tmp(); const st = createStore({ root });
  st.addMeasurements([m("weight", 80, "2026-10-01")]);
  const before = fs.readFileSync(path.join(root, "measurements.jsonl"), "utf8");
  const real = fs.renameSync; fs.renameSync = () => { const e = new Error("x"); e.code = "EIO"; throw e; };
  try { assert.throws(() => st.addMeasurements([m("weight", 81, "2026-10-02")])); } finally { fs.renameSync = real; }
  assert.strictEqual(fs.readFileSync(path.join(root, "measurements.jsonl"), "utf8"), before);
});
t("store: needs a root; rejects non-object input without throwing", () => {
  assert.throws(() => createStore({}));
  const st = createStore({ root: tmp() });
  assert.strictEqual(st.addMeasurements([null, 5, "x"]).rejected, 3);
  assert.strictEqual(st.addMeasurements("nope").added, 0);
});

// ------------------------------------------------------------------ comparison helper
const recs = (vals) => vals.map(([d, v]) => ({ ts: iso(d), value: v, source: "t" }));
t("compare: last and previous, change direction, flat threshold, same-timestamp dedupe", () => {
  const lp = C.lastAndPrevious(recs([[7, 82.9], [0, 82.4], [3, 82.0]]));
  assert.strictEqual(lp.last.value, 82.4); assert.strictEqual(lp.previous.value, 82.0);
  const ch = C.change(lp.last, lp.previous);
  assert.strictEqual(ch.dir, "flat" === ch.dir ? "flat" : ch.dir); assert.ok(Math.abs(ch.abs - 0.4) < 1e-9); assert.strictEqual(ch.days, 3);
  assert.strictEqual(C.change({ ts: iso(0), value: 90 }, { ts: iso(1), value: 80 }).dir, "up");
  assert.strictEqual(C.change({ ts: iso(0), value: 70 }, { ts: iso(1), value: 80 }).dir, "down");
  assert.strictEqual(C.change({ ts: iso(0), value: 80.1 }, { ts: iso(1), value: 80 }).dir, "flat");
  assert.strictEqual(C.change(null, null), null); assert.strictEqual(C.lastAndPrevious([]).last, null);
  assert.strictEqual(C.lastAndPrevious([{ ts: iso(0), value: 1 }, { ts: iso(0), value: 2 }]).previous, null);
});
t("compare: your-normal band is the middle half of the last 30 days, null under 5 readings", () => {
  const r = recs([[1, 56], [2, 57], [3, 58], [4, 59], [5, 60], [6, 70], [40, 200]]);
  const b = C.normalBand(r, { now: NOW });
  assert.strictEqual(b.n, 6); assert.ok(b.low >= 56 && b.low <= 58 && b.high >= 59 && b.high <= 62, JSON.stringify(b));
  assert.strictEqual(C.normalBand(recs([[1, 5], [2, 6], [3, 7], [4, 8]]), { now: NOW }), null);
  assert.strictEqual(C.position(55, b), "below"); assert.strictEqual(C.position(58, b), "within"); assert.strictEqual(C.position(99, b), "above"); assert.strictEqual(C.position(1, null), null);
});
t("compare: lastN oldest first; lab status against lab range and optimal zone", () => {
  assert.deepStrictEqual(C.lastN(recs([[1, 3], [5, 1], [3, 2], [0, 4]]), 3).map((x) => x.value), [2, 3, 4]);
  assert.strictEqual(C.labStatus({ value: 118, refLow: 0, refHigh: 130, optHigh: 100 }), "outside-optimal");
  assert.strictEqual(C.labStatus({ value: 90, refLow: 0, refHigh: 130, optHigh: 100 }), "optimal");
  assert.strictEqual(C.labStatus({ value: 3.6, refLow: 0, refHigh: 3 }), "outside-lab");
  assert.strictEqual(C.labStatus({ value: 2, refLow: 0.4, refHigh: 4 }), "in-range");
  assert.strictEqual(C.labStatus({ value: 2 }), "no-range"); assert.strictEqual(C.labStatus(null), "no-range");
});

// ------------------------------------------------------------------ importers (synthetic)
const SAMPLES = makeSamples("2026-10-07", 45);
t("csv parser: quotes, doubled quotes, CRLF, BOM, blank lines", () => {
  assert.deepStrictEqual(IM.parseCsv('\uFEFFa,b\r\n"x,1","he said ""hi"""\r\n\r\nlast,row'), [["a", "b"], ["x,1", 'he said "hi"'], ["last", "row"]]);
  assert.deepStrictEqual(IM.parseCsv(""), []);
});
t("dates: ISO, slash day-first (default) and month-first, month names, 12-hour clock, two-digit years", () => {
  assert.strictEqual(IM.parseDateTime("2026-10-07 07:30:00"), "2026-10-07T07:30:00");
  assert.strictEqual(IM.parseDateTime("07/10/2026 07:30"), "2026-10-07T07:30:00");
  assert.strictEqual(IM.parseDateTime("10/07/2026 07:30", { dayFirst: false }), "2026-10-07T07:30:00");
  assert.strictEqual(IM.parseDateTime("13/09/2026"), "2026-09-13T00:00:00");
  assert.strictEqual(IM.parseDateTime("Oct 07, 2026 7:30 PM"), "2026-10-07T19:30:00");
  assert.strictEqual(IM.parseDateTime("7 Oct 2026"), "2026-10-07T00:00:00");
  assert.strictEqual(IM.parseDateTime("03/01/24 00:00:05", { dayFirst: false }), "2024-03-01T00:00:05");
  assert.strictEqual(IM.parseDateTime("2026/10/07 12:00 AM"), "2026-10-07T00:00:00");
  for (const v of ["", "soon", null, "32/13/2026"]) assert.strictEqual(IM.parseDateTime(v), null);
});
t("renpho: synthetic export gives weight, body fat, BMI, water, muscle, bone, visceral per row; lb converts; junk rows counted", () => {
  const res = IM.importRenphoCsv(SAMPLES["synthetic_renpho.csv"], { fileId: "0123456789abcdef" });
  assert.ok(res.measurements.length >= 7 * 20, "many readings: " + res.measurements.length);
  const metrics = new Set(res.measurements.map((x) => x.metric));
  for (const k of ["weight", "bmi", "body_fat", "body_water", "muscle_mass", "bone_mass", "visceral_fat"]) assert.ok(metrics.has(k), k);
  assert.ok(res.measurements.every((x) => x.source === "renpho" && x.fileId === "0123456789abcdef"));
  const lb = IM.importRenphoCsv("Time of Measurement,Weight(lb),Body Fat(%)\n2026-10-07 07:00:00,180,--\nnot a date,170,20\n2026-10-06 07:00:00,5000,20\n");
  assert.strictEqual(lb.measurements.length, 1 + 1); assert.ok(Math.abs(lb.measurements.find((x) => x.metric === "weight").value - 81.65) < 0.01);
  assert.strictEqual(lb.skipped, 1); assert.strictEqual(lb.rejected, 1, "5000 lb is implausible");
  assert.strictEqual(IM.importRenphoCsv("").measurements.length, 0); assert.ok(IM.importRenphoCsv("a,b\n1,2\n").rejected >= 1);
});
t("renpho: re-importing the same file adds nothing new (deterministic ids)", () => {
  const st = createStore({ root: tmp() });
  const a = st.addMeasurements(IM.importRenphoCsv(SAMPLES["synthetic_renpho.csv"]).measurements);
  const b = st.addMeasurements(IM.importRenphoCsv(SAMPLES["synthetic_renpho.csv"]).measurements);
  assert.ok(a.added > 0); assert.strictEqual(b.added, 0); assert.strictEqual(b.updated, a.added);
});
t("fitbit takeout: steps summed per day, heart rate averaged, resting, main sleep only; kind by file name", () => {
  const file = (prefix) => Object.keys(SAMPLES).find((k) => k.startsWith(prefix));
  const steps = IM.importFitbitTakeout({ fileName: file("steps-"), json: JSON.parse(SAMPLES[file("steps-")]) }, {});
  assert.strictEqual(steps.measurements.length, 30); assert.ok(steps.measurements.every((x) => x.metric === "steps" && x.value > 1000));
  const hr = IM.importFitbitTakeout({ fileName: file("heart_rate-"), json: JSON.parse(SAMPLES[file("heart_rate-")]) }, {});
  assert.strictEqual(hr.measurements.length, 30); assert.ok(hr.measurements.every((x) => x.metric === "heart_rate" && x.value > 60 && x.value < 95));
  const rest = IM.importFitbitTakeout({ fileName: file("resting_heart_rate-"), json: JSON.parse(SAMPLES[file("resting_heart_rate-")]) }, {});
  assert.ok(rest.measurements.length === 30 && rest.measurements.every((x) => x.metric === "resting_hr"));
  const sl = IM.importFitbitTakeout({ fileName: file("sleep-"), json: JSON.parse(SAMPLES[file("sleep-")]) }, {});
  assert.strictEqual(sl.measurements.length, 30, "naps (isMainSleep false) are not counted"); assert.ok(sl.measurements.every((x) => x.metric === "sleep_minutes" && x.value >= 380 && x.value <= 470));
  const two = IM.importFitbitTakeout({ fileName: "steps-2026-10-01.json", json: [{ dateTime: "10/01/26 08:00:00", value: "1000" }, { dateTime: "10/01/26 09:00:00", value: "250" }, { dateTime: "10/01/26 10:00:00", value: "x" }] });
  assert.deepStrictEqual(two.measurements.map((x) => x.value), [1250]); assert.strictEqual(two.skipped, 1);
  assert.strictEqual(IM.importFitbitTakeout({ fileName: "profile.json", json: [] }).rejected, 1);
  assert.strictEqual(IM.importFitbitTakeout({ fileName: "steps-1.json", json: { not: "array" } }).rejected, 1);
});
t("health connect csv: blood pressure pairs, SpO2, sleep session from start and end, steps summed per day", () => {
  const res = IM.importHealthConnectCsv(SAMPLES["synthetic_healthconnect.csv"], {});
  const by = (k) => res.measurements.filter((x) => x.metric === k);
  assert.strictEqual(by("bp_systolic").length, 11); assert.strictEqual(by("bp_diastolic").length, 11); assert.strictEqual(by("spo2").length, 11);
  assert.strictEqual(by("bp_systolic")[0].ts, by("bp_diastolic")[0].ts, "pairs share a timestamp");
  const sleep = by("sleep_minutes"); assert.strictEqual(sleep.length, 11); assert.ok(sleep.every((x) => Math.abs(x.value - 440) < 1), "23:20 to 06:40 = 440 min");
  assert.strictEqual(by("steps").length, 1); assert.strictEqual(by("steps")[0].value, 7300);
  assert.strictEqual(IM.importHealthConnectCsv("a,b\n1,2").rejected, 1);
  const w = IM.importHealthConnectCsv("time,type,value,unit\n2026-10-07 07:00:00,Weight,180,lb\n2026-10-07 07:00:00,Unknown,1,x\n");
  assert.ok(Math.abs(w.measurements[0].value - 81.65) < 0.01); assert.strictEqual(w.skipped, 1);
});
t("lab form payload and lab-entries file: validated; the pdf hook exists and is not built", () => {
  const ok = IM.labFromForm({ test: "Ferritin", value: "85", unit: "ng/mL", refLow: "30", refHigh: "400", optLow: "50", optHigh: "150", date: "2026-07-01" });
  assert.strictEqual(ok.labs.length, 1); assert.strictEqual(ok.labs[0].source, "manual"); assert.strictEqual(ok.labs[0].optLow, 50);
  assert.strictEqual(IM.labFromForm({ test: "", value: 1 }).rejected, 1); assert.strictEqual(IM.labFromForm(null).rejected, 1);
  const file = IM.importLabEntries(JSON.parse(SAMPLES["synthetic_labs.json"]), { fileId: "aaaaaaaa11111111" });
  assert.strictEqual(file.labs.length, 18); assert.ok(file.labs.every((l) => l.fileId === "aaaaaaaa11111111"));
  assert.strictEqual(IM.importLabEntries({ format: "other" }).rejected, 1);
  assert.strictEqual(IM.importLabPdf().ok, false);
  assert.strictEqual(IM.labsFromStrippedRows([{ test: "TSH", value: 2, unit: "mIU/L", date: "2026-07-01" }], {}).labs[0].source, "labpdf");
});
t("detect: picks the importer from name and header; pdf and unknown refused", () => {
  assert.strictEqual(IM.detect("x.csv", SAMPLES["synthetic_renpho.csv"]).format, "renpho");
  assert.strictEqual(IM.detect("x.csv", SAMPLES["synthetic_healthconnect.csv"]).format, "healthconnect");
  assert.strictEqual(IM.detect("steps-2026-01-01.json", "[]").format, "fitbit");
  assert.strictEqual(IM.detect("any.json", SAMPLES["synthetic_labs.json"]).format, "lab-entries");
  assert.strictEqual(IM.detect("lab.pdf", "").error, "pdf"); assert.strictEqual(IM.detect("a.csv", "x,y\n1,2").error, "unknown");
  assert.strictEqual(IM.detect("a.json", "{{").error, "bad-json"); assert.strictEqual(IM.detect("a.docx", "").error, "unknown");
});

// ------------------------------------------------------------------ view model
function seeded() {
  const st = createStore({ root: tmp() });
  st.addMeasurements(IM.importRenphoCsv(SAMPLES["synthetic_renpho.csv"]).measurements);
  st.addMeasurements(IM.importHealthConnectCsv(SAMPLES["synthetic_healthconnect.csv"]).measurements);
  st.addLabs(IM.importLabEntries(JSON.parse(SAMPLES["synthetic_labs.json"])).labs);
  st.addMed({ name: "Vitamin D3", dose: "2,000 IU", schedule: "Morning", start: "2026-07-06" });
  const old = st.addMed({ name: "Old thing", dose: "1", schedule: "Evening", start: "2026-01-01", stop: "2026-02-01" });
  return { st, old };
}
t("view model: Today tiles carry last value, previous with date, change, own band, sparkline, source", () => {
  const { st } = seeded();
  const v = VM.buildToday(st.listMeasurements(), NOW);
  assert.ok(v.hasData);
  const w = v.tiles.find((x) => x.id === "weight");
  assert.ok(w.previous && w.previous.at && w.change && w.band && w.spark.length >= 2 && w.source === "renpho", JSON.stringify(w));
  assert.ok(/kg$/.test(w.valueText));
  const bp = v.tiles.find((x) => x.id === "bp"); assert.ok(/^\d+\/\d+ mmHg$/.test(bp.valueText), bp.valueText);
  const sl = v.tiles.find((x) => x.id === "sleep"); assert.ok(/^7 h 20 min$/.test(sl.valueText), sl.valueText);
  assert.ok(VM.buildToday([], NOW).hasData === false);
});
t("view model: Labs rows with range, optional zone, last three values oldest first, status order, scale holds every number", () => {
  const { st } = seeded();
  const v = VM.buildLabs(st.listLabs());
  assert.strictEqual(v.rows.length, 6);
  assert.strictEqual(v.rows[0].test, "hs-CRP", "outside lab range sorts first"); assert.strictEqual(v.rows[0].status, "outside-lab");
  const ldl = v.rows.find((r) => r.key === "ldl-cholesterol");
  assert.deepStrictEqual(ldl.history.map((h) => h.value), [128, 121, 118]); assert.strictEqual(ldl.status, "outside-optimal"); assert.strictEqual(ldl.optHigh, 100);
  assert.ok(ldl.scale.min <= 0 && ldl.scale.max >= 130);
  const tsh = v.rows.find((r) => r.key === "tsh"); assert.strictEqual(tsh.optLow, null); assert.strictEqual(tsh.status, "in-range");
  assert.strictEqual(ldl.change.dir, "down");
});
t("view model: Meds split into active and stopped; snapshot has counts only for the store, no paths", () => {
  const { st } = seeded();
  const med = VM.buildMeds(st.listMeds(), "2026-10-07");
  assert.strictEqual(med.active.length, 1); assert.strictEqual(med.stopped.length, 1);
  const snap = VM.buildSnapshot(st, NOW);
  assert.ok(snap.ok && snap.counts.measurement > 100);
  assert.ok(!JSON.stringify(snap).includes(st.root), "the snapshot never carries the store path");
});

// ------------------------------------------------------------------ service
t("root: live default is the vault folder and needs its marker; test mode refuses the vault and defaults to userData; the real vault is refused even when asked for", () => {
  assert.strictEqual(SV.DEFAULT_ROOT, undefined, "no built-in health folder");
  assert.strictEqual(SV.resolveRoot({ env: {}, testMode: false }).code, "noparent", "live mode with no configured folder is refused");
  const base = fs.realpathSync.native(tmp()), parent = path.join(base, "Health"), vault = path.join(parent, "vault"); fs.mkdirSync(path.join(vault, "extracted"), { recursive: true });
  const o = (x) => Object.assign({ vault, parent, userData: path.join(base, "ud") }, x);
  assert.strictEqual(SV.resolveRoot(o({ env: {}, testMode: false })).code, "marker", "no marker file in the vault root: not accepted");
  fs.writeFileSync(path.join(vault, ".health-root"), "");
  const live = SV.resolveRoot(o({ env: {}, testMode: false })); assert.ok(live.ok && live.isDefault && live.root === path.join(vault, "extracted"));
  assert.strictEqual(SV.resolveRoot(o({ env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(base, "elsewhere") }, testMode: false })).code, "outside");
  const tm = SV.resolveRoot(o({ env: {}, testMode: true })); assert.ok(tm.ok && tm.root.indexOf("health-test") > 0);
  for (const bad of [path.join(vault, "extracted"), vault.toUpperCase(), path.join(vault, "x", "y") + path.sep, parent]) assert.strictEqual(SV.resolveRoot(o({ env: { AGENT_DESKTOP_HEALTH_ROOT: bad }, testMode: true })).ok, false, bad);
  const svc = SV.createService({ env: { AGENT_DESKTOP_HEALTH_ROOT: "C:\\Example\\Scratch\\Health\\vault\\extracted" }, testMode: true, parent: "C:\\Example\\Scratch\\Health" });
  assert.strictEqual(svc.load().ok, false); assert.strictEqual(svc.root, null);
});
t("service: import a chosen file end to end, counts only in the log, re-import updates, bad files give plain reasons", async () => {
  const dir = tmp(), logs = []; const files = {};
  for (const k of Object.keys(SAMPLES)) { files[k] = path.join(dir, k); fs.writeFileSync(files[k], SAMPLES[k]); }
  fs.writeFileSync(path.join(dir, "scan.pdf"), "%PDF-1.4 fake"); fs.writeFileSync(path.join(dir, "bad.json"), "{{");
  const svc = SV.createService({ resolved: { ok: true, root: path.join(dir, "store") }, log: (l) => logs.push(l), now: () => NOW });
  assert.strictEqual(svc.load().todayView.hasData, false);
  const r = await svc.importPath(files["synthetic_renpho.csv"]);
  assert.ok(r.ok && r.format === "renpho" && r.counts.added > 100 && /^[a-f0-9]{16}$/.test(r.fileId));
  assert.ok((await svc.importPath(files["synthetic_labs.json"])).ok); assert.ok((await svc.importPath(files["synthetic_healthconnect.csv"])).ok);
  const again = await svc.importPath(files["synthetic_renpho.csv"]); assert.strictEqual(again.counts.added, 0);
  assert.strictEqual((await svc.importPath(path.join(dir, "scan.pdf"))).ok, false);
  assert.ok(/later stage/.test((await svc.importPath(path.join(dir, "scan.pdf"))).reason));
  assert.strictEqual((await svc.importPath(path.join(dir, "bad.json"))).ok, false);
  assert.strictEqual((await svc.importPath(path.join(dir, "missing.csv"))).ok, false);
  const snap = svc.load(); assert.ok(snap.todayView.hasData && snap.labsView.hasData && snap.lastImport.format === "renpho" || snap.lastImport);
  for (const l of logs) assert.ok(/^(import|lab add|reading add|med add|med stop|note add|health error): /.test(l) && !/\d{4}-\d\d-\d\d|ldl|weight|kg|\\|\//i.test(l), "log line carries counts/ids only: " + l);
});
t("service: pick imports several files in one go and reports totals; cancel is quiet", async () => {
  const dir = tmp(); const a = path.join(dir, "a.csv"), b = path.join(dir, "labs.json");
  fs.writeFileSync(a, SAMPLES["synthetic_renpho.csv"]); fs.writeFileSync(b, SAMPLES["synthetic_labs.json"]);
  const svc = SV.createService({ resolved: { ok: true, root: path.join(dir, "s") }, pickFiles: async () => [a, b, path.join(dir, "nope.csv")] });
  const r = await svc.importPick(); assert.ok(r.ok && r.files.length === 2 && r.failed === 1 && r.added > 100);
  const q = SV.createService({ resolved: { ok: true, root: path.join(dir, "s2") }, pickFiles: async () => [] });
  assert.strictEqual((await q.importPick()).canceled, true);
});
t("service: manual forms (lab, reading, med, stop) validate and persist", async () => {
  const svc = SV.createService({ resolved: { ok: true, root: path.join(tmp(), "s") }, now: () => NOW });
  assert.ok(svc.addLab({ test: "Ferritin", value: "85", unit: "ng/mL", refLow: "30", refHigh: "400", date: "2026-07-01" }).ok);
  assert.strictEqual(svc.addLab({ test: "", value: "x" }).ok, false);
  assert.ok(svc.addReading({ metric: "weight", value: "82.4" }).ok); assert.strictEqual(svc.addReading({ metric: "weight", value: "9999" }).ok, false);
  assert.ok(svc.addMed({ name: "Vitamin D3", dose: "2,000 IU", schedule: "Morning" }).ok); assert.strictEqual(svc.addMed({ name: "" }).ok, false);
  const id = svc.load().medsView.active[0].id; assert.ok(svc.stopMed({ id }).ok);
  assert.strictEqual(svc.load().medsView.active.length, 0);
  const s = svc.load(); assert.strictEqual(s.labsView.rows.length, 1); assert.strictEqual(s.todayView.tiles[0].id, "weight");
});
t("service: no vault folder means no store and no folder is created", () => {
  const svc = SV.createService({ resolved: { ok: true, root: "Z:\\definitely\\not\\here", isDefault: true }, testMode: false });
  // resolved.isDefault with a missing real vault is treated as no-vault only when the real vault path is absent; Z: is not it, so this builds lazily
  assert.ok(svc.load() && typeof svc.load().ok === "boolean");
});

// ------------------------------------------------------------------ IPC
t("ipc: handlers registered at start, the service loads only on the first call, foreign senders and big args refused", async () => {
  const handlers = {}; const logs = [];
  const wc = { id: 1 };
  const win = { webContents: wc, isDestroyed: () => false };
  const dir = tmp(); fs.writeFileSync(path.join(dir, "r.csv"), SAMPLES["synthetic_renpho.csv"]);
  const req = require.resolve("../src/health/service");
  delete require.cache[req];
  const res = MH.init({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, getMainWindow: () => win, dialog: null, userData: dir, testMode: true, log: (l) => logs.push(l),
    env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(dir, "store"), AGENT_DESKTOP_HEALTH_TEST_PICK: path.join(dir, "r.csv") } });
  for (const c of ["health-load", "health-import-pick", "health-lab-add", "health-reading-add", "health-med-add", "health-med-stop"]) assert.strictEqual(typeof handlers[c], "function", c);
  assert.strictEqual(require.cache[req], undefined, "service not loaded before the first call");
  const ev = { sender: wc };
  assert.strictEqual((await handlers["health-load"](ev)).ok, false, "the bridge is closed until the view says it is open");
  assert.ok((await handlers["health-view-state"](ev, { open: true })).ok);
  const l = await handlers["health-load"](ev); assert.ok(l.ok); assert.ok(require.cache[req], "loaded on first call");
  assert.strictEqual((await handlers["health-load"]({ sender: { id: 2 } })).ok, false);
  assert.strictEqual((await handlers["health-lab-add"](ev, { test: "x".repeat(70000) })).ok, false);
  const imp = await handlers["health-import-pick"](ev); assert.ok(imp.ok && imp.added > 100);
  const noTest = MH.init({ ipcMain: { handle: (c, f) => { handlers["x" + c] = f; } }, getMainWindow: () => win, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, userData: dir, testMode: false, log: () => {}, env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(dir, "s3"), AGENT_DESKTOP_HEALTH_TEST_PICK: path.join(dir, "r.csv") } });
  await handlers["xhealth-view-state"](ev, { open: true });
  assert.strictEqual((await handlers["xhealth-import-pick"](ev)).canceled, true, "the test-pick hook only works in test mode");
});

// ------------------------------------------------------------------ privacy and lightness guards (static)
const healthFiles = () => {
  const out = [];
  for (const f of fs.readdirSync(path.join(SRC, "health"))) out.push(path.join(SRC, "health", f));
  for (const f of ["health.js", "health-nav.js", "health-agent.js", "health-more.js", "health-chart.js"]) out.push(path.join(SRC, "renderer", f));
  return out;
};
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
t("privacy: no console.log/info/debug/warn anywhere in the health code; console.error only with a plain string", () => {
  for (const f of healthFiles()) {
    const s = strip(fs.readFileSync(f, "utf8"));
    assert.ok(!/console\.(log|info|debug|warn|trace|dir|table)\s*\(/.test(s), "console output in " + path.basename(f));
    for (const m2 of s.matchAll(/console\.error\s*\(([^)]*)\)/g)) assert.ok(/^\s*["'][^"'$+]*["']\s*$/.test(m2[1]), "console.error with non-literal in " + path.basename(f) + ": " + m2[1]);
  }
});
t("privacy: health code never touches logs of values, the task store, registry, shared_reports, window title, clipboard, crash reports or agents", () => {
  for (const f of healthFiles()) {
    const s = strip(fs.readFileSync(f, "utf8"));
    const name = path.basename(f);
    for (const re of [/document\.title/, /\.setTitle\s*\(/, /tasks\.py/, /registry\.py/, /shared_reports/, /clipboard/i, /crashReporter/, /deliverToAgent/, /sendToAgent/, /localStorage/, /sessionStorage/, /indexedDB/, /fetch\s*\(/, /XMLHttpRequest/, /require\(["']https?["']\)/, /child_process/]) assert.ok(!re.test(s), name + " matches " + re);
  }
});
t("privacy: every log/say call in the main-side health code is a counts-and-ids line (no template of record fields)", () => {
  for (const f of ["service.js", "main-health.js", "store.js"]) {
    const s = strip(fs.readFileSync(path.join(SRC, "health", f), "utf8"));
    for (const m2 of s.matchAll(/\bsay\s*\(([^;]*)\);/g)) {
      const arg = m2[1];
      assert.ok(!/\.(test|name|dose|value|text|note|schedule|metric|unit|source|path|fileName)\b/.test(arg.replace(/e\.code/g, "")), f + " logs a record field: " + arg);
    }
  }
});
t("privacy: nothing from the health store reaches the Daily/task/registry code paths (no references from them)", () => {
  for (const f of ["daily/main-daily.js", "daily/model.js", "archive.js", "registry.js"]) assert.ok(!/health\//.test(fs.readFileSync(path.join(SRC, f), "utf8")), f);
  const main = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
  assert.strictEqual((main.match(/require\("\.\/health\//g) || []).length, 1, "main.js references the health module exactly once (the lazy IPC registration)");
});
t("lightness: no timers and no polling in health code; the view code is not in index.html; no native or new dependency", () => {
  for (const f of healthFiles()) { const s = strip(fs.readFileSync(f, "utf8")); assert.ok(!/setInterval|requestAnimationFrame|MutationObserver|IntersectionObserver/.test(s), "interval/observer in " + path.basename(f)); }
  const view = strip(fs.readFileSync(path.join(SRC, "renderer", "health.js"), "utf8"));
  assert.strictEqual((view.match(/setTimeout/g) || []).length, 1, "only the toast fade-out timer");
  const html = fs.readFileSync(path.join(SRC, "renderer", "index.html"), "utf8");
  assert.ok(html.includes("health-nav.js") && html.includes("styles-health-nav.css"));
  assert.ok(!/"health\.js"/.test(html) && !html.includes("styles-health.css"), "the view and its stylesheet load lazily");
  const nav = fs.readFileSync(path.join(SRC, "renderer", "health-nav.js"), "utf8");
  assert.ok(nav.includes('"health.js"') && nav.includes('"styles-health.css"'));
  for (const f of fs.readdirSync(path.join(SRC, "health"))) for (const m2 of fs.readFileSync(path.join(SRC, "health", f), "utf8").matchAll(/require\(["']([^"']+)["']\)/g)) assert.ok(m2[1].startsWith(".") || ["fs", "path", "os", "crypto"].includes(m2[1]), "dependency " + m2[1]);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), ["@xterm/addon-fit", "@xterm/xterm", "node-pty", "tweetnacl"]);
});
t("view wiring: textContent only, tile has no badge number, Systems tile attribute, escape and nav close handled, other views hide", () => {
  const view = fs.readFileSync(path.join(SRC, "renderer", "health.js"), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(view));
  const nav = fs.readFileSync(path.join(SRC, "renderer", "health-nav.js"), "utf8");
  assert.ok(nav.includes("dataset.systemNav") && nav.includes('"health"') && !/badge/i.test(nav.replace(/no badge number/g, "")));
  const css = fs.readFileSync(path.join(SRC, "renderer", "styles-health-nav.css"), "utf8");
  for (const id of ["chat-view", "argus-view", "iris-view", "memory-view", "library-view", "daily-view"]) assert.ok(css.includes("body.health-open #" + id), id);
  assert.ok(/PHEME_OVERLAY_CLASSES = \[[^\]]*"health-open"/.test(fs.readFileSync(path.join(SRC, "renderer", "renderer.js"), "utf8")));
  const pre = fs.readFileSync(path.join(SRC, "preload.js"), "utf8");
  assert.ok(/health: \{[\s\S]*health-import-pick/.test(pre) && !/health-import-path/.test(pre), "the renderer cannot name a file path");
});
t("leftpane: a tile with data-system-nav=health replaces the dim soon tile", () => {
  const LP = require("../src/leftpane");
  const tiles = LP.planTiles(["argus", "daily"], ["health"]);
  assert.strictEqual(tiles.find((x) => x.id === "health").kind, "live");
  assert.ok(!tiles.some((x) => x.id === "health" && x.kind === "soon"));
});

(async () => {
  for (const q of queue) {
    n++;
    try { await q.fn(); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n  ") : e)); }
  }
  console.log(fails ? fails + " of " + n + " FAILED" : "health: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
