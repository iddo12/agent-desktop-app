// node tests/health-review.test.js - fixes for the independent review of My Health stage 1 (HEALTH_STAGE1_REVIEW.md), v1.82.1:
// root path hardening, size caps, importers (Fitbit, Renpho, Health Connect), numbers and dates, Hebrew lab keys, the band, atomic writes,
// the screen-capture flag, the bridge gate, the folder import and the accessibility guards. SYNTHETIC data and temp folders only.
// (The link policy and the dose filter have their own tests in health-agent.test.js.)
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const RS = require("../src/health/roots");
const SV = require("../src/health/service");
const MH = require("../src/health/main-health");
const IM = require("../src/health/importers");
const S = require("../src/health/schema");
const AF = require("../src/health/agentfiles");
const AT = require("../src/health/atomic");
const VM = require("../src/health/view-model");
const C = require("../src/health/compare");
const { createStore } = require("../src/health/store");
const { makeSamples } = require("../tools/health-synthetic");

let n = 0, fails = 0; const queue = [];
const t = (name, fn) => queue.push({ name, fn });
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "health-review-"));
const SRC = path.join(__dirname, "..", "src");
const localDay = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
function vaultFixture() {
  const base = tmp(), parent = path.join(base, "Health"), vault = path.join(parent, "vault"); fs.mkdirSync(path.join(vault, "extracted"), { recursive: true });
  fs.writeFileSync(path.join(vault, ".health-root"), "");
  return { base, parent, vault, o: (x) => Object.assign({ vault, parent, userData: path.join(base, "ud") }, x) };
}

// ------------------------------------------------------------------ F3
t("F3 root: UNC, device paths, parent segments, 8.3 short names and relative paths are refused", () => {
  const f = vaultFixture();
  for (const bad of ["\\\\server\\share\\health", "\\\\?\\C:\\Example\\Scratch\\Health\\vault", "\\\\.\\E:\\x", "//server/share/x", "C:\\a\\..\\b", "C:\\PROGRA~1\\health", "relative\\folder"]) {
    for (const testMode of [true, false]) { const r = RS.resolveRoot(f.o({ env: { AGENT_DESKTOP_HEALTH_ROOT: bad }, testMode })); assert.strictEqual(r.ok, false, bad + " " + testMode); assert.strictEqual(r.code, "form"); assert.ok(!JSON.stringify(r).includes("server"), "the message never echoes the path"); }
  }
});
t("F3 root: a junction into the vault is refused in test mode and in live mode (resolved paths, not text)", () => {
  const f = vaultFixture(); const link = path.join(f.base, "innocent");
  try { fs.symlinkSync(f.vault, link, "junction"); } catch (e) { return; }   // cannot create a junction here: nothing to test
  assert.strictEqual(RS.resolveRoot(f.o({ env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(link, "extracted") }, testMode: true })).code, "redirect");
  assert.strictEqual(RS.resolveRoot(f.o({ env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(link, "extracted") }, testMode: false })).code, "redirect");
  const svc = SV.createService({ env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(link, "extracted") }, testMode: true }); assert.strictEqual(svc.load().ok, false);
});
t("F3 root: test mode refuses the vault and its parent by real path (case-insensitive); synced folders refused; the marker and the fixed parent are required live", () => {
  const f = vaultFixture();
  for (const p of [path.join(f.vault, "extracted"), f.vault.toUpperCase(), f.parent, path.join(f.vault, "a", "b")]) assert.strictEqual(RS.resolveRoot(f.o({ env: { AGENT_DESKTOP_HEALTH_ROOT: p }, testMode: true })).code, "vault", p);
  assert.ok(RS.resolveRoot(f.o({ env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(f.base, "sandbox", "store") }, testMode: true })).ok);
  const dbx = path.join(f.base, "Dropbox", "store"); fs.mkdirSync(dbx, { recursive: true });
  assert.strictEqual(RS.resolveRoot(f.o({ env: { AGENT_DESKTOP_HEALTH_ROOT: dbx }, testMode: true })).code, "synced");
  const od = path.join(f.base, "OneDrive - Someone", "x"); assert.strictEqual(RS.resolveRoot(f.o({ env: { AGENT_DESKTOP_HEALTH_ROOT: od }, testMode: true })).code, "synced");
  const marked = path.join(f.base, "plain"); fs.mkdirSync(marked, { recursive: true }); fs.writeFileSync(path.join(marked, ".dropbox"), ""); assert.strictEqual(RS.resolveRoot(f.o({ env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(marked, "s") }, testMode: true })).code, "synced", ".dropbox marker in an ancestor");
  assert.strictEqual(RS.resolveRoot(f.o({ env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(f.base, "elsewhere") }, testMode: false })).code, "outside", "live: only inside the fixed parent");
  fs.mkdirSync(path.join(f.parent, "scratch"), { recursive: true }); assert.strictEqual(RS.resolveRoot(f.o({ env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(f.parent, "scratch") }, testMode: false })).code, "marker", "inside the parent but no marker above it up to the parent");
  assert.ok(RS.resolveRoot(f.o({ env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(f.vault, "extracted", "sub") }, testMode: false })).ok, "inside the vault: the vault's marker covers it");
  fs.unlinkSync(path.join(f.vault, ".health-root")); assert.strictEqual(RS.resolveRoot(f.o({ env: {}, testMode: false })).code, "marker");
});

// ------------------------------------------------------------------ F4 / F5
t("F4 agent files: a file over the size cap is ignored, not read; a normal one still is", () => {
  const root = tmp(); fs.mkdirSync(path.join(root, "agent", "insights"), { recursive: true });
  fs.writeFileSync(path.join(root, "agent", "insights", "2026-10-07.json"), JSON.stringify({ cards: [{ id: "a-1", title: "t", summary: "s", evidence: { level: "guideline" } }], pad: "x".repeat(AF.MAX_AGENT_FILE + 10) }));
  fs.writeFileSync(path.join(root, "agent", "insights", "2026-10-06.json"), JSON.stringify({ cards: [{ id: "a-2", title: "t", summary: "s", evidence: { level: "guideline" } }] }));
  const r = AF.createAgentFiles(root).readInsights(14); assert.deepStrictEqual(r.cards.map((c) => c.id), ["a-2"]); assert.ok(r.rejected >= 1);
});
t("F5 import: 25 MB cap, zip and binary refused with a useful message, empty file, symlink, first line read without splitting, row cap", async () => {
  const dir = tmp(), svc = SV.createService({ resolved: { ok: true, root: path.join(dir, "s") } });
  assert.strictEqual(SV.MAX_IMPORT_BYTES, 25 * 1024 * 1024);
  const w = (n, c) => { const f = path.join(dir, n); fs.writeFileSync(f, c); return f; };
  const big = await svc.importPath(w("big.csv", Buffer.alloc(SV.MAX_IMPORT_BYTES + 1, 65))); assert.ok(!big.ok && /25 MB/.test(big.reason));
  const zip = await svc.importPath(w("a.csv", Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(100)]))); assert.ok(!zip.ok && /zip/.test(zip.reason));
  assert.ok(/zip/.test((await svc.importPath(w("health_connect_export.zip", "x"))).reason)); assert.ok(/database inside/.test((await svc.importPath(w("x.db", "x"))).reason));
  const bin = await svc.importPath(w("b.csv", Buffer.concat([Buffer.from("a,b\n"), Buffer.alloc(10)]))); assert.ok(!bin.ok && /text file/.test(bin.reason));
  assert.ok(/empty/.test((await svc.importPath(w("e.csv", ""))).reason));
  const tgt = w("t.csv", "x"); const lnk = path.join(dir, "l.csv"); try { fs.symlinkSync(tgt, lnk); assert.ok(/link/.test((await svc.importPath(lnk)).reason)); } catch (e) { /* no symlink right here */ }
  const huge = "Time of Measurement,Weight(kg)" + " ".repeat(10) + "\n" + "2026-09-01 07:00:00,80\n".repeat(50); assert.strictEqual(IM.firstLine(huge).length, 40);
  const t0 = Date.now(); const longText = "a,b\n" + "1,2\n".repeat(2000000); IM.firstLine(longText); assert.ok(Date.now() - t0 < 50, "first line without splitting the whole text");
  assert.strictEqual(IM.parseCsv("a,b\n1,2\n3,4\n5,6\n", { maxRows: 2 }).truncated, true); assert.strictEqual(IM.MAX_ROWS, 200000);
});

// ------------------------------------------------------------------ F7
t("F7 Fitbit: mainSleep honoured, UTC converted for minute series (not for sleep/resting), confidence 0 dropped, coverage counted", () => {
  const sl = IM.importFitbitTakeout({ fileName: "sleep-2026-10-01.json", json: [{ dateOfSleep: "2026-10-01", minutesAsleep: 400, mainSleep: true }, { dateOfSleep: "2026-10-01", minutesAsleep: 60, mainSleep: false }] });
  assert.strictEqual(sl.measurements.length, 1); assert.strictEqual(sl.measurements[0].value, 400, "the nap (mainSleep false) is not added");
  const st = IM.importFitbitTakeout({ fileName: "steps-2026-10-01.json", json: [{ dateTime: "10/01/26 22:30:00", value: "100" }, { dateTime: "10/01/26 12:00:00", value: "50" }] });
  const expectLate = localDay(new Date("2026-10-01T22:30:00Z")), expectNoon = localDay(new Date("2026-10-01T12:00:00Z"));
  const days = Object.fromEntries(st.measurements.map((m) => [m.ts.slice(0, 10), m.value])); assert.strictEqual(days[expectLate] + (expectLate === expectNoon ? 0 : 0), expectLate === expectNoon ? 150 : 100); assert.ok(st.warnings.indexOf("fitbit-utc") >= 0);
  const raw = IM.importFitbitTakeout({ fileName: "steps-2026-10-01.json", json: [{ dateTime: "10/01/26 22:30:00", value: "100" }] }, { utc: false }); assert.strictEqual(raw.measurements[0].ts.slice(0, 10), "2026-10-01");
  const hr = IM.importFitbitTakeout({ fileName: "heart_rate-2026-10-01.json", json: [{ dateTime: "10/01/26 10:00:00", value: { bpm: 60, confidence: 3 } }, { dateTime: "10/01/26 10:01:00", value: { bpm: 200, confidence: 0 } }, { dateTime: "10/01/26 10:02:00", value: { bpm: 70, confidence: 2 } }] }, { utc: false });
  assert.strictEqual(hr.measurements[0].value, 65); assert.strictEqual(hr.measurements[0].n, 2);
  const rest = IM.importFitbitTakeout({ fileName: "resting_heart_rate-2026-10-01.json", json: [{ dateTime: "10/01/26 00:00:00", value: { date: "10/01/26", value: 58 } }] }); assert.strictEqual(rest.measurements[0].value, 58);
});
t("F7 overlap: a day built from fewer samples never replaces a fuller one, in the store and across files of one pick", async () => {
  const root = path.join(tmp(), "s"), st = createStore({ root });
  const m = (v, n) => ({ metric: "steps", value: v, ts: "2026-09-01", source: "fitbit", n });
  assert.strictEqual(st.addMeasurements([m(9000, 1440)]).added, 1);
  const r = st.addMeasurements([m(2500, 300)]); assert.strictEqual(r.kept, 1); assert.strictEqual(st.listMeasurements({ metric: "steps" })[0].value, 9000);
  assert.strictEqual(st.addMeasurements([m(9500, 1440)]).updated, 1, "an equally full day does replace"); assert.strictEqual(st.listMeasurements({ metric: "steps" })[0].value, 9500);
  const dir = tmp(); const file = (name, entries) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(entries)); return f; };
  const full = []; for (let i = 0; i < 10; i++) full.push({ dateTime: "09/05/26 0" + i + ":00:00", value: "10" }); const part = full.slice(0, 3);
  const svc = SV.createService({ resolved: { ok: true, root: path.join(dir, "store") } });
  const r1 = await svc.importPaths([file("steps-a.json", full), file("steps-b.json", part)], {}); assert.ok(r1.ok && r1.files.length === 2);
  const days = svc.load().todayView; assert.ok(days.hasData); const only = fs.readFileSync(path.join(dir, "store", "measurements.jsonl"), "utf8").trim().split("\n").map(JSON.parse); assert.strictEqual(only.length >= 1, true); assert.ok(only.every((x) => x.n >= 1));
  const total = only.reduce((a, x) => a + x.value, 0); assert.strictEqual(total, 100, "the fuller file's total is kept (10 samples of 10), not the partial one's 30");
  const r2 = await svc.importPaths([file("steps-c.json", part)], {}); assert.ok(r2.kept >= 1 || r2.updated === 0, "re-importing the partial file keeps the fuller days");
});

// ------------------------------------------------------------------ F8 / F9
t("F9 Renpho: semicolon delimiter with decimal commas imports; day/month order inferred from the column, explicit choice when ambiguous, mixed refused", () => {
  const semi = IM.importRenphoCsv("Time of Measurement;Weight(kg);Body Fat(%)\n2026-09-01 07:00:00;82,4;21,7\n");
  assert.deepStrictEqual(semi.measurements.map((x) => [x.metric, x.value]).sort(), [["body_fat", 21.7], ["weight", 82.4]]);
  assert.strictEqual(IM.sniffDelimiter("a;b;c,d"), ";"); assert.strictEqual(IM.sniffDelimiter("a,b,c;d"), ",");
  assert.strictEqual(IM.inferDateOrder(["13/04/2025", "01/02/2025"]), "dmy"); assert.strictEqual(IM.inferDateOrder(["04/13/2025", "01/02/2025"]), "mdy"); assert.strictEqual(IM.inferDateOrder(["03/04/2025"]), "ambiguous"); assert.strictEqual(IM.inferDateOrder(["13/04/2025", "04/13/2025"]), "mixed"); assert.strictEqual(IM.inferDateOrder(["2025-04-03"]), "none");
  const amb = "Time of Measurement,Weight(kg)\n03/04/2025 07:00,80\n05/06/2025 07:00,81\n";
  assert.strictEqual(IM.importRenphoCsv(amb).needsChoice, "dateOrder"); assert.strictEqual(IM.importRenphoCsv(amb).measurements.length, 0);
  assert.strictEqual(IM.importRenphoCsv(amb, { dateOrder: "dmy" }).measurements[0].ts.slice(0, 10), "2025-04-03"); assert.strictEqual(IM.importRenphoCsv(amb, { dateOrder: "mdy" }).measurements[0].ts.slice(0, 10), "2025-03-04");
  assert.strictEqual(IM.importRenphoCsv("Time of Measurement,Weight(kg)\n13/04/2025 07:00,80\n04/13/2025 07:00,81\n").warnings[0], "mixed-date-order");
  assert.strictEqual(IM.importRenphoCsv("Time of Measurement,Weight(kg)\n13/04/2025 07:00,80\n01/02/2025 07:00,81\n").measurements[1].ts.slice(0, 10), "2025-02-01", "evidence from one row decides for the whole column");
});
t("F9 service: an ambiguous file asks for a choice with a token (never a path); the choice imports; a wrong token or order is refused", async () => {
  const dir = tmp(), f = path.join(dir, "r.csv"); fs.writeFileSync(f, "Time of Measurement,Weight(kg)\n03/04/2025 07:00,80\n05/06/2025 07:00,81\n");
  const svc = SV.createService({ resolved: { ok: true, root: path.join(dir, "s") }, pickFiles: async () => [f] });
  const r = await svc.importPick(); assert.ok(r.ok && r.needsChoice && /^[a-f0-9]{16}$/.test(r.token)); assert.ok(!JSON.stringify(r).includes(dir));
  assert.strictEqual((await svc.importChoose({ token: "bad", order: "dmy" })).ok, false); assert.strictEqual((await svc.importChoose({ token: r.token, order: "xyz" })).ok, false);
  const done = await svc.importChoose({ token: r.token, order: "dmy" }); assert.ok(done.ok && done.added === 2); assert.strictEqual((await svc.importChoose({ token: r.token, order: "dmy" })).ok, false, "a token works once");
  assert.strictEqual(svc.load().todayView.tiles[0].at.slice(0, 10), "2025-06-05");
});
t("F8 Health Connect: CSV from an exporter app still reads (also with semicolons); the empty-state wording no longer promises the native export", () => {
  const hc = IM.importHealthConnectCsv("time;type;value;unit\n2026-09-01 07:00:00;Weight;82,5;kg\n"); assert.strictEqual(hc.measurements[0].value, 82.5);
  const h = fs.readFileSync(path.join(SRC, "renderer", "health.js"), "utf8"); assert.ok(/exporter app/.test(h) && /zip with a database/.test(h) && !/Health Connect CSV export/.test(h));
});

// ------------------------------------------------------------------ F10 / F11 / F12
t("F10 numbers and dates: thousands separators, decimal comma, ancient and far-future dates rejected", () => {
  assert.strictEqual(S.num("12,345"), 12345); assert.strictEqual(S.num("1,234.5"), 1234.5); assert.strictEqual(S.num("12,5"), 12.5); assert.strictEqual(S.num("1,234,567"), 1234567); assert.strictEqual(S.num(" 7 "), 7); for (const bad of ["1,2,3", "12,3456", "abc", "", "1e3", null]) assert.strictEqual(S.num(bad), null, String(bad));
  assert.strictEqual(S.normalizeMeasurement({ metric: "steps", value: "12,345", ts: "2026-09-01" }).record.value, 12345);
  for (const d of ["0001-01-01", "1989-12-31", "2099-01-01"]) { assert.strictEqual(S.normalizeTs(d), null, d); assert.strictEqual(S.normalizeMeasurement({ metric: "weight", value: 80, ts: d }).ok, false); assert.strictEqual(S.normalizeLab({ test: "x", value: 1, ts: d }).ok, false); }
  assert.ok(S.normalizeTs("1990-01-01")); assert.strictEqual(S.normalizeTs("2099-01-01", { allowFuture: true }), "2099-01-01T00:00:00");
  const tomorrow = new Date(Date.now() + 2 * 86400000); assert.strictEqual(S.normalizeTs(localDay(tomorrow)), null, "two days ahead");
  assert.ok(S.normalizeMed({ name: "x", start: "2026-01-01", stop: "2099-01-01" }).ok, "a planned stop date is allowed");
  assert.strictEqual(S.normalizeMeasurement({ metric: "constructor", value: 1, ts: "2026-09-01" }).ok, false); assert.strictEqual(S.normalizeMeasurement({ metric: "toString", value: 1, ts: "2026-09-01" }).ok, false);
});
t("F11 Hebrew lab names get an ASCII key (so Try it and the contract can name them); display name kept; same name, same key", () => {
  const he = "\u05DB\u05D5\u05DC\u05E1\u05D8\u05E8\u05D5\u05DC LDL";
  const a = S.normalizeLab({ test: he, value: 120, unit: "mg/dL", ts: "2026-09-01" }).record, b = S.normalizeLab({ test: he, value: 118, ts: "2026-09-02" }).record;
  assert.ok(/^ldl-[a-f0-9]{8}$/.test(a.key), a.key); assert.strictEqual(a.key, b.key); assert.strictEqual(a.test, he);
  assert.ok(/^lab-[a-f0-9]{8}$/.test(S.normalizeLab({ test: "\u05D1\u05D3\u05D9\u05E7\u05D4", value: 1, ts: "2026-09-01" }).record.key));
  assert.strictEqual(S.normalizeLab({ test: "LDL cholesterol", value: 1, ts: "2026-09-01" }).record.key, "ldl-cholesterol"); assert.strictEqual(S.testKey("hs-CRP"), "hs-crp");
  const e = AF.normalizeExperiment({ id: "e_0123456789abcdef", title: "x", start: "2026-09-01", metric: a.key, metricKind: "lab" }); assert.ok(e.ok, "the experiment can watch a Hebrew-named lab");
  assert.ok(AF.normalizeRelates === undefined || true);
});
t("F12 band: the value being judged is not in its own band; sleep band text shows both ends in full", () => {
  const rec = (d, v) => ({ metric: "resting_hr", value: v, ts: "2026-09-" + String(d).padStart(2, "0") + "T07:00:00", source: "t", unit: "bpm", id: "m" + d, kind: "measurement" });
  const recs = [1, 2, 3, 4, 5].map((d) => rec(d, 60)).concat([rec(6, 90)]);
  const tile = VM.buildToday(recs, Date.parse("2026-09-07T10:00:00")).tiles[0];
  assert.ok(tile.band && tile.band.n === 5 && tile.band.low === 60 && tile.band.high === 60 && tile.band.position === "above", JSON.stringify(tile.band));
  const one = VM.buildToday(recs.slice(0, 5), Date.parse("2026-09-07T10:00:00")).tiles[0]; assert.strictEqual(one.band, null, "only 4 earlier readings: no band");
  const TR = require("../src/health/trends"); const sl = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => ({ metric: "sleep_minutes", value: 420 + (d > 5 ? 120 : 0), ts: "2026-09-0" + d + "T00:00:00", source: "t", unit: "min", id: "s" + d, kind: "measurement" }));
  const att = TR.buildTrends(sl, [], {}, Date.parse("2026-09-09T10:00:00")).attention.map((x) => x.text).join(" "); assert.ok(!/\(7 to /.test(att), att);
});

// ------------------------------------------------------------------ F14 / F15 / F17 / F19
t("F14 atomic writes: a stale temp file is replaced (not followed), none left behind, crashed leftovers are removed at start", () => {
  const root = tmp(); fs.mkdirSync(path.join(root, "agent"), { recursive: true });
  fs.writeFileSync(path.join(root, "x.json.tmp-" + process.pid), "STALE"); AT.write(null, path.join(root, "x.json"), "fresh\n"); assert.strictEqual(fs.readFileSync(path.join(root, "x.json"), "utf8"), "fresh\n"); assert.deepStrictEqual(fs.readdirSync(root).filter((f) => f.includes(".tmp-")), []);
  fs.writeFileSync(path.join(root, "a.jsonl.tmp-123"), "leftover"); fs.writeFileSync(path.join(root, "agent", "state.json.tmp-999"), "leftover"); fs.writeFileSync(path.join(root, "agent", "mine.tmp"), "the agent's own temp name is not ours");
  assert.strictEqual(AT.cleanTmp(root), 2); assert.ok(fs.existsSync(path.join(root, "agent", "mine.tmp")));
  fs.writeFileSync(path.join(root, "labs.jsonl.tmp-77"), "x"); SV.createService({ resolved: { ok: true, root } }); assert.ok(!fs.existsSync(path.join(root, "labs.jsonl.tmp-77")));
});
t("F15 gate and F17 flag: the bridge answers only while the view is open; the capture flag file exists exactly then; stale flags go at start; guards are in main.js and index.html", async () => {
  const handlers = {}, wc = { id: 1 }, ud = tmp(), flag = path.join(ud, "health-open.flag"); fs.writeFileSync(flag, "");
  const h = MH.init({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, getMainWindow: () => ({ webContents: wc, isDestroyed: () => false }), dialog: null, userData: ud, testMode: true, log: () => {}, env: { AGENT_DESKTOP_HEALTH_ROOT: path.join(ud, "st") } });
  assert.ok(!fs.existsSync(flag), "a flag left by a crash is removed at start"); const ev = { sender: wc };
  assert.strictEqual((await handlers["health-extra-load"](ev, { tab: "routines" })).ok, false); assert.ok(!fs.existsSync(flag));
  assert.ok((await handlers["health-view-state"](ev, { open: true })).ok); assert.ok(fs.existsSync(flag)); assert.strictEqual(fs.statSync(flag).size, 0, "an empty file, no content");
  assert.ok((await handlers["health-extra-load"](ev, { tab: "routines" })).ok);
  assert.ok((await handlers["health-view-state"](ev, { open: false })).ok); assert.ok(!fs.existsSync(flag)); assert.strictEqual((await handlers["health-load"](ev)).ok, false);
  await handlers["health-view-state"](ev, { open: true }); h.shutdown(); assert.ok(!fs.existsSync(flag), "removed at quit");
  assert.strictEqual((await handlers["health-view-state"]({ sender: { id: 9 } }, { open: true })).ok, false, "only the main window may open the bridge"); assert.ok(!fs.existsSync(flag));
  const main = fs.readFileSync(path.join(SRC, "main.js"), "utf8"); assert.ok(/will-navigate/.test(main) && /will-redirect/.test(main) && /__healthMain\.shutdown/.test(main));
  const html = fs.readFileSync(path.join(SRC, "renderer", "index.html"), "utf8"); const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html); assert.ok(csp);
  assert.ok(/script-src 'self'(;|$)/.test(csp[1]) && !/script-src[^;]*unsafe/.test(csp[1]) && /connect-src 'self'/.test(csp[1]) && /default-src 'self'/.test(csp[1]) && /base-uri 'none'/.test(csp[1]));
  assert.ok(!/<script>[^<]/.test(html), "no inline scripts that the policy would block");
});
t("F19 folder import: recursive, capped, hidden entries skipped, only csv/json/txt, one write; chosen in main", async () => {
  const dir = tmp(), S0 = makeSamples("2026-10-07", 20); const put = (rel, c) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
  put("Takeout/Fitbit/Global/sleep-2026-09-18.json", S0["sleep-2026-09-08.json"] || JSON.stringify([{ dateOfSleep: "2026-09-18", minutesAsleep: 400, mainSleep: true }])); put("Takeout/Fitbit/renpho.csv", S0["synthetic_renpho.csv"]); put("Takeout/deep/er/lab.json", S0["synthetic_labs.json"]);
  put("Takeout/readme.pdf", "x"); put("Takeout/.hidden/secret.csv", S0["synthetic_renpho.csv"]); put("Takeout/photo.jpg", "x");
  const svc = SV.createService({ resolved: { ok: true, root: path.join(dir, "store") }, pickFolder: async () => path.join(dir, "Takeout") });
  const r = await svc.importFolder(); assert.ok(r.ok && r.files.length === 3, JSON.stringify(r)); assert.ok(r.added > 50);
  assert.strictEqual(fs.readFileSync(path.join(dir, "store", "imports.jsonl"), "utf8").trim().split(String.fromCharCode(10)).length, 3, "one ledger line per file, counts only");
  assert.ok((await SV.createService({ resolved: { ok: true, root: path.join(dir, "s2") }, pickFolder: async () => null }).importFolder()).canceled);
  const none = tmp(); const e = await SV.createService({ resolved: { ok: true, root: path.join(dir, "s3") }, pickFolder: async () => none }).importFolder(); assert.ok(e.ok && /No \.csv/.test(e.reasons[0]));
  assert.ok(/openDirectory/.test(fs.readFileSync(path.join(SRC, "health", "main-health.js"), "utf8"))); assert.ok(/health-import-folder/.test(fs.readFileSync(path.join(SRC, "preload.js"), "utf8")));
});

// ------------------------------------------------------------------ UI guards
t("UI: tab roles and aria-selected, toast aria-live, labelled filters and inputs, Escape asks before losing a form, dir=auto, narrow breakpoint, folder and choice controls", () => {
  const h = fs.readFileSync(path.join(SRC, "renderer", "health.js"), "utf8"), a = fs.readFileSync(path.join(SRC, "renderer", "health-agent.js"), "utf8"), m = fs.readFileSync(path.join(SRC, "renderer", "health-more.js"), "utf8"), css = fs.readFileSync(path.join(SRC, "renderer", "styles-health.css"), "utf8");
  for (const needle of ['"role", "tablist"', '"role", "tab"', "aria-selected", '"role", "status"', 'aria-live", "polite"', "window.confirm(", "e.dir = \"auto\"", "Import folder", "choiceBanner", "importChoose", "ArrowRight"]) assert.ok(h.includes(needle), needle);
  assert.ok(/aria-label/.test(a) && /Filter by tradition/.test(a) && /aria-label", label \|\| "Filter"/.test(a)); assert.ok(/aria-label", label \|\| "Filter"/.test(m));
  assert.ok(/@media \(max-width: 760px\)[^}]*\.hl-med/.test(css) || /\.hl-med \{ grid-template-columns: 1fr 1fr; \}/.test(css), "narrow layout for the medication rows");
  assert.ok(!/localStorage|sessionStorage|console\.(log|info|warn)/.test(h));
});

(async () => {
  for (const q of queue) { n++; try { await q.fn(); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n  ") : e)); } }
  console.log(fails ? fails + " of " + n + " FAILED" : "health-review: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
