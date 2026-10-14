// node tests/health-agent.test.js - My Health stage 1, agent-written screens: the file contract (validation, atomic writes, append),
// trends rules, experiment before/after, service actions, feedback, links. SYNTHETIC data and temp folders only.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AF = require("../src/health/agentfiles");
const TR = require("../src/health/trends");
const SV = require("../src/health/service");
const IM = require("../src/health/importers");
const { createStore } = require("../src/health/store");
const { makeSamples, makeAgentFiles } = require("../tools/health-synthetic");

let n = 0, fails = 0; const queue = [];
const t = (name, fn) => queue.push({ name, fn });
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "health-agent-test-"));
const END = "2026-10-07", NOW = Date.parse(END + "T10:00:00");
const iso = (d) => { const x = new Date(NOW - d * 86400000); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0") + "T07:00:00"; };
const write = (root, files) => { for (const k of Object.keys(files)) { const f = path.join(root, k); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, files[k]); } };
function seededService(extra) {
  const root = path.join(tmp(), "store"); const logs = []; const opened = [];
  const svc = SV.createService(Object.assign({ resolved: { ok: true, root }, log: (l) => logs.push(l), now: () => NOW, openExternal: (u) => opened.push(u) }, extra || {}));
  const S = makeSamples(END, 45); const st = createStore({ root });
  st.addMeasurements(IM.importRenphoCsv(S["synthetic_renpho.csv"]).measurements); st.addMeasurements(IM.importHealthConnectCsv(S["synthetic_healthconnect.csv"]).measurements);
  st.addLabs(IM.importLabEntries(JSON.parse(S["synthetic_labs.json"])).labs);
  write(root, makeAgentFiles(END));
  return { svc, root, logs, opened };
}

t("insight validation: good card, bad evidence/tradition/id refused, refs must be slugs, links must be https, errors carry no text", () => {
  const good = { id: "a-b", title: "T", summary: "S", why: { text: "w", relates: [{ type: "metric", id: "weight" }, { type: "lab", id: "Bad Id!" }, { type: "nope", id: "x" }, { type: "history", id: "Jane Doe 123456789" }] }, evidence: { level: "single-study", strength: 2 }, tradition: "tcm", topic: "practice",
    sources: [{ title: "ok", url: "https://example.org/x" }, { title: "no", url: "http://insecure.example" }, { title: "js", url: "javascript:alert(1)" }] };
  const r = AF.normalizeInsight(good, "2026-10-07");
  assert.ok(r.ok); assert.deepStrictEqual(r.record.why.relates, [{ type: "metric", id: "weight" }], "only slug-shaped refs of known types survive (no free identifiers)");
  assert.strictEqual(r.record.sources.length, 1); assert.strictEqual(r.record.intervention, true); assert.strictEqual(r.record.date, "2026-10-07");
  const SENT = "SECRETTEXT";
  for (const [patch, field] of [[{ id: "Bad Id" }, "id"], [{ evidence: { level: "vibes" } }, "evidence"], [{ tradition: "alchemy" }, "tradition"], [{ topic: "magic" }, "topic"], [{ title: "" }, "title"], [{ summary: "" }, "summary"], [{ date: "x" + SENT }, "date"]]) {
    const x = AF.normalizeInsight(Object.assign({}, good, patch), field === "date" ? undefined : "2026-10-07"); assert.strictEqual(x.ok, false); assert.strictEqual(x.errors[0].field, field); assert.ok(!JSON.stringify(x).includes(SENT));
  }
  assert.strictEqual(AF.normalizeInsight(Object.assign({}, good, { topic: "labs" }), "2026-10-07").record.intervention, false);
});
t("plan validation: groups, statuses by app, a dose in the text is refused (the app never recommends an amount)", () => {
  const base = { id: "p1", group: "vitamins", title: "Vitamin D (a topic for your doctor)", why: { text: "low", relates: [] }, evidence: { level: "guideline", strength: 3 } };
  assert.ok(AF.normalizePlanItem(base).ok);
  for (const bad of [{ group: "potions" }, { id: "BAD" }]) assert.strictEqual(AF.normalizePlanItem(Object.assign({}, base, bad)).ok, false);
  for (const patch of [{ title: "Take 5000 IU daily" }, { note: "300 mg at night" }, { why: { text: "2 g a day", relates: [] } }]) { const r = AF.normalizePlanItem(Object.assign({}, base, patch)); assert.ok(r.ok && r.record.amountRemoved, "neutralised, not dropped"); assert.ok(JSON.stringify(r.record).includes(AF.DF.NOTICE)); assert.ok(!/5000|300 mg|2 g/.test(JSON.stringify(r.record))); }
  assert.strictEqual(AF.normalizePlanItem(Object.assign({}, base, { title: "Magnesium glycinate (talk to your doctor about amounts)" })).ok, true);
});
t("experiment and feedback validation", () => {
  const e = AF.normalizeExperiment({ id: "e_0123456789abcdef", title: "x", start: "2026-10-01", metric: "weight" }); assert.ok(e.ok); assert.strictEqual(e.record.status, "running");
  assert.strictEqual(AF.normalizeExperiment({ id: "bad", title: "x", start: "2026-10-01" }).ok, false);
  assert.strictEqual(AF.normalizeExperiment({ id: "e_0123456789abcdef", title: "x", start: "2026-10-01", metric: "nonsense" }).ok, false);
  assert.ok(AF.normalizeFeedback({ type: "useful", target: "insight", id: "syn-a" }).ok);
  for (const b of [{ type: "love", target: "insight", id: "a" }, { type: "useful", target: "x", id: "a" }, { type: "useful", target: "insight", id: "A B" }]) assert.strictEqual(AF.normalizeFeedback(b).ok, false);
});
t("file reads: synthetic insights across traditions, status from state.json, newest first, bad cards counted, plan dose item dropped", () => {
  const root = tmp(); write(root, makeAgentFiles(END));
  fs.writeFileSync(path.join(root, "agent", "insights", "2026-10-05.json"), JSON.stringify({ cards: [{ id: "BAD ID" }, { id: "syn-evening-light", title: "dup", summary: "dup", evidence: { level: "guideline" } }] }));
  fs.writeFileSync(path.join(root, "agent", "insights", "2026-10-04.json"), "{not json");
  const a = AF.createAgentFiles(root);
  const r = a.readInsights(14);
  assert.strictEqual(r.cards.length, 7); assert.ok(r.rejected >= 2);
  assert.deepStrictEqual([...new Set(r.cards.map((c) => c.tradition))].sort(), ["ayurveda", "mediterranean-egyptian", "other", "south-american", "tcm", "western"]);
  assert.strictEqual(r.cards.find((c) => c.id === "syn-evening-light").title.startsWith("SYNTHETIC"), true, "a duplicate id in an older file does not replace the newer card");
  assert.ok(r.cards.every((c) => c.status === "new"));
  assert.ok(a.setStatus("insights", "syn-tai-chi", "saved").ok); assert.strictEqual(a.readInsights(14).cards.find((c) => c.id === "syn-tai-chi").status, "saved");
  assert.strictEqual(a.setStatus("insights", "syn-tai-chi", "weird").ok, false);
  const p = a.readPlan(); assert.strictEqual(p.items.length, 5); assert.strictEqual(p.rejected, 0); assert.ok(p.items.find((i) => i.id === "syn-plan-dose").amountRemoved); assert.ok(p.items.every((i) => i.status === "considering"));
  assert.ok(a.readWorldview().text.includes("SYNTHETIC")); assert.strictEqual(AF.createAgentFiles(tmp()).readWorldview().text, "");
  assert.ok(a.readTrendNotes().weight.text.length > 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, "agent")).filter((f) => f.includes(".tmp")), []);
});
t("feedback.jsonl: validated single-line appends, nothing half written, bad input appends nothing", () => {
  const root = tmp(); const a = AF.createAgentFiles(root);
  assert.ok(a.appendFeedback({ type: "useful", target: "insight", id: "syn-a" }).ok); assert.ok(a.appendFeedback({ type: "try-it", target: "insight", id: "syn-b", note: "line one\nline two" }).ok);
  assert.strictEqual(a.appendFeedback({ type: "nope", target: "insight", id: "x" }).ok, false);
  const lines = fs.readFileSync(path.join(root, "agent", "feedback.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.strictEqual(lines.length, 2); lines.forEach((l) => JSON.parse(l)); assert.ok(JSON.parse(lines[1]).note.includes("line two"));
});
t("trends: sustained drift, outside-own-normal streak, lab outside range, quiet marker; neutral wording; notes attached", () => {
  const M = (metric, vals, startDay) => vals.map((v, i) => ({ metric, value: v, ts: iso(startDay - i), source: "t", unit: "", id: metric + i, kind: "measurement" }));
  const meas = [].concat(M("weight", [80, 80.4, 80.9, 81.5, 82.2, 83], 5), M("resting_hr", [58, 59, 57, 58, 60, 58, 59, 70, 71, 72], 14), M("steps", [5000, 5200, 5100, 4900, 5300, 5000], 40));
  const labs = [{ key: "hs-crp", test: "hs-CRP", unit: "mg/L", value: 3.6, refLow: 0, refHigh: 3, ts: iso(5), source: "t", id: "l1" }, { key: "hs-crp", test: "hs-CRP", unit: "mg/L", value: 1.4, refLow: 0, refHigh: 3, ts: iso(200), source: "t", id: "l2" }];
  const tr = TR.buildTrends(meas, labs, { weight: { text: "note here", date: "2026-10-01" } }, NOW);
  const txt = tr.attention.map((a) => a.rule + ": " + a.text);
  assert.ok(txt.some((x) => x.startsWith("drift") && /Weight has gone up/.test(x)), txt.join("\n"));
  assert.ok(txt.some((x) => x.startsWith("outside-normal") && /Resting heart rate has been above/.test(x)), txt.join("\n"));
  assert.ok(txt.some((x) => x.startsWith("lab-outside-range") && /hs-CRP/.test(x)));
  assert.ok(txt.some((x) => x.startsWith("stale") && /steps/i.test(x)));
  assert.strictEqual(tr.attention[0].rule, "lab-outside-range", "a lab outside its range is listed first");
  assert.ok(!tr.attention.some((a) => /should|recommend|try|take |avoid/i.test(a.text)), "wording states numbers only, never advice");
  assert.strictEqual(tr.rows.find((r) => r.id === "weight").note.text, "note here");
  const quiet = TR.buildTrends(M("weight", [80, 80.1, 79.9, 80, 80.1, 80], 5), [], {}, NOW); assert.strictEqual(quiet.attention.length, 0);
  assert.strictEqual(TR.buildTrends([], [], {}, NOW).hasData, false);
});
t("experiment view: before mean (14 days) vs after mean, delta, enough-data flag", () => {
  const meas = []; for (let i = 14; i >= 1; i--) meas.push({ metric: "resting_hr", value: 60, ts: iso(10 + i), source: "t" }); for (let i = 9; i >= 0; i--) meas.push({ metric: "resting_hr", value: 56, ts: iso(i), source: "t" });
  const startDay = iso(10).slice(0, 10);
  const v = TR.experimentView({ id: "e_0123456789abcdef", title: "x", start: startDay, stop: null, metric: "resting_hr", metricKind: "metric", status: "running", notes: [], verdictNote: "" }, meas, [], NOW);
  assert.strictEqual(v.before.mean, 60); assert.strictEqual(v.after.mean, 56); assert.strictEqual(v.delta.text, "-4"); assert.ok(v.enough); assert.ok(v.series.some((s) => s.after) && v.series.some((s) => !s.after));
  const few = TR.experimentView({ id: "e_0123456789abcdef", title: "x", start: iso(0).slice(0, 10), metric: "weight", metricKind: "metric", status: "running", notes: [] }, [], [], NOW); assert.strictEqual(few.enough, false); assert.strictEqual(few.delta, null);
});
t("service: agentLoad carries cards with resolved refs, new-today count, trends, plan, experiments, worldview, doctor line, no store path", () => {
  const { svc, root } = seededService();
  const d = svc.agentLoad();
  assert.ok(d.ok); assert.strictEqual(d.insights.cards.length, 7); assert.strictEqual(d.insights.newToday, 6);
  const c = d.insights.cards.find((x) => x.id === "syn-olive-oil");
  assert.ok(c.why.relates.find((r) => r.type === "lab" && r.label === "LDL cholesterol" && r.last), JSON.stringify(c.why.relates));
  assert.ok(c.why.relates.find((r) => r.type === "history" && r.label === "family heart disease"));
  assert.ok(d.trends.hasData && d.trends.rows.length > 5); assert.strictEqual(d.plan.items.length, 5); assert.ok(d.worldview.text); assert.ok(/doctor/.test(d.doctorLine));
  assert.ok(!JSON.stringify(d).includes(root));
});
t("service: Useful/Not for me/Save/Try it update state, write feedback, Try it makes an experiment from the first marker; status persists", () => {
  const { svc, root } = seededService();
  assert.ok(svc.agentAct({ op: "insight", id: "syn-evening-light", action: "useful" }).ok);
  assert.ok(svc.agentAct({ op: "insight", id: "syn-tai-chi", action: "save" }).ok);
  assert.ok(svc.agentAct({ op: "insight", id: "syn-grounding", action: "not-for-me" }).ok);
  const tr = svc.agentAct({ op: "insight", id: "syn-olive-oil", action: "try-it" }); assert.ok(tr.ok && /^e_/.test(tr.experiment));
  let d = svc.agentLoad(); const st = (id) => d.insights.cards.find((c) => c.id === id).status;
  assert.deepStrictEqual([st("syn-evening-light"), st("syn-tai-chi"), st("syn-grounding"), st("syn-olive-oil")], ["new", "saved", "dismissed", "tried"]);
  assert.strictEqual(d.insights.newToday, 3);
  assert.strictEqual(d.experiments.length, 1); assert.strictEqual(d.experiments[0].metric, "ldl-cholesterol"); assert.strictEqual(d.experiments[0].metricKind, "lab"); assert.strictEqual(d.experiments[0].fromInsight, "syn-olive-oil");
  const fb = fs.readFileSync(path.join(root, "agent", "feedback.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepStrictEqual(fb.map((f) => f.type), ["useful", "save", "not-for-me", "try-it"]);
  assert.strictEqual(svc.agentAct({ op: "insight", id: "ghost", action: "save" }).ok, false); assert.strictEqual(svc.agentAct({ op: "insight", id: "syn-tai-chi", action: "weird" }).ok, false); assert.strictEqual(svc.agentAct({ op: "zzz" }).ok, false);
});
t("service: plan status, experiment note and verdict stay in the vault files", () => {
  const { svc, root } = seededService();
  assert.ok(svc.agentAct({ op: "plan", id: "syn-plan-vitd", status: "discussing" }).ok); assert.strictEqual(svc.agentAct({ op: "plan", id: "syn-plan-vitd", status: "chugging" }).ok, false);
  assert.strictEqual(svc.agentLoad().plan.items.find((i) => i.id === "syn-plan-vitd").status, "discussing");
  const id = svc.agentAct({ op: "insight", id: "syn-evening-light", action: "try-it" }).experiment;
  assert.ok(svc.agentAct({ op: "exp-note", id, text: "slept better tonight" }).ok); assert.strictEqual(svc.agentAct({ op: "exp-note", id, text: "  " }).ok, false);
  assert.ok(svc.agentAct({ op: "exp-verdict", id, status: "kept", note: "keeping it" }).ok);
  const e = svc.agentLoad().experiments[0]; assert.strictEqual(e.status, "kept"); assert.strictEqual(e.notes.length, 1); assert.strictEqual(e.verdictNote, "keeping it"); assert.ok(e.stop);
  assert.ok(fs.readFileSync(path.join(root, "agent", "experiments.json"), "utf8").includes("slept better tonight"), "typed text lives in the vault file");
  assert.strictEqual(svc.agentAct({ op: "exp-verdict", id, status: "maybe" }).ok, false);
});
t("links: parsed with new URL, https only, host allow-list, no userinfo/port/IP/localhost, query and fragment stripped, only shown links, the href is rebuilt; no URL in logs", () => {
  const { svc, opened, logs } = seededService();
  const good = "https://doi.org/10.1000/synthetic-syn-olive-oil";
  assert.strictEqual(svc.openLink(good).ok, false, "nothing allowed before the cards were loaded");
  svc.agentLoad();
  assert.ok(svc.openLink(good).ok); assert.deepStrictEqual(opened, [good]);
  assert.ok(svc.openLink(good + "?secret=weight-82.4#frag").ok); assert.strictEqual(opened[1], good, "query and fragment are stripped before opening");
  for (const bad of ["https://evil.example/x", "http://doi.org/10.1000/synthetic-syn-olive-oil", "file:///C:/x", "javascript:1", 5, null, "https://nih.gov@evil.example/x", "https://user:pw@doi.org/10.1000/synthetic-syn-olive-oil", "https://doi.org:8443/10.1000/synthetic-syn-olive-oil",
    "https://localhost/x", "https://127.0.0.1/x", "https://192.168.1.1/x", "https://[::1]/x", "https://doi.org.evil.example/10.1000/synthetic-syn-olive-oil", "https://example.org/synthetic-x", "https://xn--doi-9ta.org/x", "https://doi.org/x\u200B", "https://doi.org/a&b", "https://nas/x", "https://router.local/x"]) assert.strictEqual(svc.openLink(bad).ok, false, String(bad));
  assert.strictEqual(opened.length, 2); assert.ok(logs.every((l) => !/doi|http|example/.test(l)));
});
t("link policy unit: parse results, allow-list is replaceable by a file, sources keep non-listed hosts as plain text", () => {
  const LP = AF.LP;
  // v1.84.1 path cap: legit links pass, text-carrying paths do not
  for (const good of ["https://doi.org/10.1038/s41586-020-2649-2", "https://pubmed.ncbi.nlm.nih.gov/12345678/", "https://www.who.int/news-room/fact-sheets/detail/obesity-and-overweight", "https://doi.org/10.1/x_y~z.v2", "https://doi.org/" + "a".repeat(119)]) assert.ok(LP.parse(good).ok, good);
  for (const bad of ["https://doi.org/my%20ldl%20is%20142", "https://doi.org/%E2%82%AC", "https://doi.org/כול", "https://doi.org/café", "https://doi.org/" + "a".repeat(120), "https://doi.org/" + ("ab/".repeat(50)), "https://doi.org/a+b", "https://doi.org/a,b", "https://doi.org/a;b", "https://doi.org/a:b", "https://doi.org/a@b", "https://doi.org/a(1)", "https://doi.org/a=1", "https://doi.org/a!b", "https://doi.org/a'b", "https://doi.org/a*b", "https://doi.org/a$b"]) assert.strictEqual(LP.parse(bad).ok, false, bad);
  assert.strictEqual(LP.MAX_PATH, 120); assert.strictEqual(LP.parse("https://doi.org/" + "a".repeat(120)).reason, "path-length");
  assert.ok(LP.parse("https://doi.org/123abc-my-ldl-is-142").ok, "documented residual: short letters/digits/hyphen text still passes (the cap bounds bandwidth, it does not read meaning)");
  const p = LP.parse("https://pubmed.ncbi.nlm.nih.gov/123/?term=secret#x"); assert.ok(p.ok && p.allowed && p.href === "https://pubmed.ncbi.nlm.nih.gov/123/" && p.host === "pubmed.ncbi.nlm.nih.gov");
  assert.ok(LP.parse("https://www.nih.gov/a").allowed, "sub-domains of a listed host"); assert.strictEqual(LP.parse("https://notnih.gov/a").allowed, false);
  const other = LP.parse("https://example.org/x"); assert.ok(other.ok && !other.allowed);
  for (const r of ["http://a.org/x", "https://a.org:1/x", "https://u@a.org/x", "https://1.2.3.4/x", "https://a/x", "https://a.org/" + "x".repeat(400)]) assert.strictEqual(LP.parse(r).ok, false, r);
  const root = tmp(); const svc = SV.createService({ resolved: { ok: true, root: path.join(root, "s") }, openExternal: () => {} }); fs.mkdirSync(path.join(root, "s"), { recursive: true }); fs.writeFileSync(path.join(root, "s", "link-allowlist.json"), JSON.stringify({ hosts: ["example.org", "bad host", "10.0.0.1"] }));
  SV.createService({ resolved: { ok: true, root: path.join(root, "s") } }); assert.deepStrictEqual(LP.allowedHosts(), ["example.org"]); assert.ok(LP.parse("https://example.org/x").allowed); assert.strictEqual(LP.parse("https://doi.org/x").allowed, false);
  fs.unlinkSync(path.join(root, "s", "link-allowlist.json")); SV.createService({ resolved: { ok: true, root: path.join(root, "s") } }); assert.ok(LP.allowedHosts().indexOf("doi.org") >= 0);
  const src = AF.normalizeInsight({ id: "a-1", title: "t", summary: "s", evidence: { level: "guideline" }, sources: [{ title: "Not listed", url: "https://example.org/p" }, { title: "ok", url: "https://doi.org/10.1/x?y=1" }, { title: "bad", url: "https://a.org:99/x" }] }, "2026-10-07").record.sources;
  assert.deepStrictEqual(src.map((x) => [x.host, x.allowed, x.url]), [["example.org", false, "https://example.org/p"], ["doi.org", true, "https://doi.org/10.1/x"]]);
});
t("dose filter: the review probe list is neutralised (zero-width, full-width and Arabic-Indic digits, number words, Hebrew, glued and spaced units), clean text is left alone", () => {
  const DF = AF.DF;
  const probes = ["two grams daily", "half a gram", "500 milligrams", "1 tablet", "2 capsules", "1 scoop", "1 tsp", "2 drops", "1/2 teaspoon", "1.5 oz", "5\u200Bmg", "\uFF15\uFF10\uFF10 mg", "\u0665\u0660\u0660 mg", "500 \u05DE\"\u05D2", "3x500mg", "5 m g", "take a capsule", "\u05DB\u05D3\u05D5\u05E8 \u05D0\u05D7\u05D3 \u05D1\u05D9\u05D5\u05DD", "\u00BD tsp", "2000 IU", "take 2 tablets", "ten drops", "a couple of capsules", "two scoops of powder", "100\u00A0mg", "1000 \u00B5g"];
  for (const t0 of probes) { assert.ok(DF.hasAmount(t0), "missed: " + t0); const r = DF.clean("Intro sentence. " + t0 + " daily. Closing sentence."); assert.ok(r.removed >= 1 && r.text.includes(DF.NOTICE) && r.text.includes("Intro sentence.") && r.text.includes("Closing sentence."), t0); }
  for (const ok of ["Walk for 30 minutes after dinner.", "Sleep 7 to 8 hours.", "Studies from 2021 show a benefit.", "Eat more leafy greens.", "Vitamin D3 and omega-3 are discussed.", "Do 3 sets of 10 reps."]) assert.ok(!DF.hasAmount(ok), "false positive: " + ok);
  assert.ok(DF.clean("Take 3 of these.", { strict: true }).removed === 1 && DF.clean("Rest for 2 days in 2024.", { strict: true }).removed === 0);
  const ins = AF.normalizeInsight({ id: "a-2", title: "Try 5000 IU of D3", summary: "Safe and simple.", why: { text: "low", relates: [] }, evidence: { level: "guideline" }, topic: "supplement" }, "2026-10-07"); assert.ok(ins.ok && ins.record.amountRemoved && ins.record.title === DF.NOTICE);
  const notes = AF.createAgentFiles(tmp()); assert.deepStrictEqual(Object.assign({}, notes.readTrendNotes()), {});
  const root = tmp(); fs.mkdirSync(path.join(root, "agent"), { recursive: true }); fs.writeFileSync(path.join(root, "agent", "trend_notes.json"), JSON.stringify({ notes: { weight: { text: "Steady. Take 2 capsules.", date: "2026-10-01" } } })); fs.writeFileSync(path.join(root, "agent", "worldview.md"), "Likes evidence. 500 mg daily is what I take.");
  const a = AF.createAgentFiles(root); assert.ok(a.readTrendNotes().weight.text.includes(DF.NOTICE) && !/capsules/.test(a.readTrendNotes().weight.text)); assert.ok(a.readWorldview().text.includes(DF.NOTICE));
  const sc = AF.normalizeInsight({ id: "a-3", title: "t", summary: "s", evidence: { level: "guideline" }, sources: [{ title: "Use 2 tablets", url: "https://doi.org/1/x" }] }, "2026-10-07").record.sources[0].title; assert.strictEqual(sc, DF.NOTICE);
  const rc = AF.normalizeRecipe({ id: "r-1", title: "Stew", vegan: true, ingredients: [{ item: "Lentils", amount: "500 g" }], steps: ["Simmer 2 cups of stock for 20 minutes."], nutrients: [{ name: "Iron", perServing: "5 mg" }] }, "2026-10-07"); assert.ok(rc.ok && rc.record.steps[0].includes("2 cups") && rc.record.ingredients[0].amount === "500 g", "recipes are not filtered");
});
t("text hygiene: bidi overrides and zero-width characters are stripped from agent and user text, LRM/RLM kept; insight date comes from the file", () => {
  const r = AF.normalizeInsight({ id: "a-4", title: "a\u202Eb\u200Bc\u200Fd", summary: "s", date: "2030-01-01", evidence: { level: "guideline" } }, "2026-10-07"); assert.strictEqual(r.record.title, "abc\u200Fd"); assert.strictEqual(r.record.date, "2026-10-07");
  const l = require("../src/health/schema").normalizeLab({ test: "x\u202Ey", value: 1, ts: "2026-09-01" }); assert.strictEqual(l.record.test, "xy");
});
t("service: every log line from the new actions is counts/ids only", () => {
  const { svc, logs } = seededService();
  svc.agentLoad(); svc.agentAct({ op: "insight", id: "syn-tai-chi", action: "save" }); svc.agentAct({ op: "plan", id: "syn-plan-vitd", status: "trying" }); svc.agentAct({ op: "exp-note", id: "e_0000000000000000", text: "SECRETNOTE" });
  for (const l of logs) assert.ok(/^(agent act|link open|health error): /.test(l) && !/SECRET|syn-|ldl|weight/i.test(l), l);
});
t("empty vault: agentLoad works with no agent files at all", () => {
  const svc = SV.createService({ resolved: { ok: true, root: path.join(tmp(), "s") }, now: () => NOW });
  const d = svc.agentLoad(); assert.ok(d.ok); assert.strictEqual(d.insights.cards.length, 0); assert.strictEqual(d.plan.items.length, 0); assert.deepStrictEqual(d.experiments, []); assert.strictEqual(d.worldview.text, "");
});
t("renderer: agent screens are lazy, textContent only, links go through the main process, no persistence or network", () => {
  const SRC = path.join(__dirname, "..", "src", "renderer");
  const v = fs.readFileSync(path.join(SRC, "health-agent.js"), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|fetch\(|XMLHttpRequest|window\.open|<a |href/.test(v.replace(/https:\/\//g, "")));
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(v));
  assert.ok(/openLink/.test(v));
  const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8"); assert.ok(!html.includes("health-agent.js"), "loaded on first use of those tabs only");
  assert.ok(fs.readFileSync(path.join(SRC, "health.js"), "utf8").includes('"health-agent.js"'));
  for (const w of ["Useful", "Not for me", "Try it", "Save", "discuss", "new today"]) assert.ok(new RegExp(w, "i").test(v + AF.DOCTOR_LINE), w);
  const pre = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8"); assert.ok(/health-open-link/.test(pre) && /health-agent-act/.test(pre));
});

(async () => {
  for (const q of queue) { n++; try { await q.fn(); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); } }
  console.log(fails ? fails + " of " + n + " FAILED" : "health-agent: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
