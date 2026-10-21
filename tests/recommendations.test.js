// node tests/recommendations.test.js - My Recommendations service (v1.133.0): loading (async), clipping, bad files, findRef safety, Replied chips, 8-week cap. Temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { createService, needsText } = require("../src/recommendations/service");
let n = 0, fails = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adrecs-"));
const rec = path.join(tmp, "recommendations"), coo = path.join(tmp, "coo");
fs.mkdirSync(path.join(rec, "2026-W41"), { recursive: true }); fs.mkdirSync(path.join(rec, "2026-W42"), { recursive: true }); fs.mkdirSync(path.join(rec, "notaweek"), { recursive: true }); fs.mkdirSync(coo);
const item = (id, needs) => ({ id, title: "T " + id, kind: "do", why: "w", impact: 4, effort: "S", cost: "none", needsIddo: needs, firstStep: "f", status: "new" });
fs.writeFileSync(path.join(rec, "2026-W42", "Security.json"), "﻿" + JSON.stringify({ agent: "Security", headline: "H", items: [item("a", "Approve it"), item("b", "Nothing for him"), { id: "", title: "x" }, null] }));
fs.writeFileSync(path.join(rec, "2026-W42", "Broken.json"), "{not json");
fs.writeFileSync(path.join(rec, "2026-W42", "NoItems.json"), JSON.stringify({ headline: "x" }));
fs.writeFileSync(path.join(rec, "2026-W41", "Legal.json"), JSON.stringify({ items: [item("z", "")] }));
fs.writeFileSync(path.join(coo, "weekly_2026-W42.json"), JSON.stringify({ headline: "C", topIdeas: [{ rank: 1, agent: "Security", ideaId: "a", title: "Top", why: "y" }, { title: "" }, 5] }));
const s = createService({ recDir: rec, cooDir: coo });
t("weeks newest first, non-week folders ignored", async () => { const r = await s.load(); assert.deepStrictEqual(r.weeks.map((w) => w.week), ["2026-W42", "2026-W41"]); assert.strictEqual(r.more, false); });
t("bad files skipped and counted, BOM tolerated, bad items dropped", async () => { const w = (await s.load()).weeks[0]; assert.strictEqual(w.skipped, 2); assert.strictEqual(w.agents.length, 1); assert.strictEqual(w.agents[0].items.length, 2); });
t("needs Iddo: text means yes, 'Nothing...' / empty mean no", async () => { const w = (await s.load()).weeks[0]; assert.strictEqual(w.needs, 1); assert.strictEqual(needsText("none"), ""); assert.ok(needsText("Approve it")); });
t("COO top list cleaned; missing COO file flagged", async () => { const r = await s.load(); assert.strictEqual(r.weeks[0].top.length, 1); assert.strictEqual(r.weeks[0].top[0].ideaId, "a"); assert.strictEqual(r.weeks[1].cooMissing, true); });
t("findRef accepts a real item only", async () => { assert.ok(await s.findRef("2026-W42", "Security", "rec:a")); assert.strictEqual(await s.findRef("2026-W42", "Security", "rec:nope"), null); assert.strictEqual(await s.findRef("2026-W42", "Security", "a"), null); });
t("findRef refuses traversal and bad weeks", async () => { assert.strictEqual(await s.findRef("2026-W42", "..\\x", "rec:a"), null); assert.strictEqual(await s.findRef("2026-W42", "../Security", "rec:a"), null); assert.strictEqual(await s.findRef("../x", "Security", "rec:a"), null); });
t("item ids are clipped to 116 so 'rec:' + id fits the writer's 120", async () => {
  const long = "x".repeat(130);
  fs.writeFileSync(path.join(rec, "2026-W41", "Long.json"), JSON.stringify({ items: [item(long, "")] }));
  assert.ok(await s.findRef("2026-W41", "Long", "rec:" + long.slice(0, 116)));
});
t("replied reads only successful rec: lines", async () => {
  const log = path.join(tmp, "_writes.jsonl");
  fs.writeFileSync(log, [{ time: "2026-10-18T20:00:00Z", week: "2026-W42", agent: "Security", finding: "rec:a", delivery: "sent" }, { time: "2026-10-19T20:00:00Z", week: "2026-W42", agent: "Security", finding: "rec:b", delivery: "failed" },
    { time: "2026-10-18T20:00:00Z", week: "2026-W42", agent: "Security", finding: "other", delivery: "sent" }].map((x) => JSON.stringify(x)).join("\n") + "\nnot json\n");
  assert.deepStrictEqual(await s.replied(log), { "2026-W42|security|a": "2026-10-18" }); assert.deepStrictEqual(await s.replied(path.join(tmp, "none")), {});
});
t("default load is the newest 8 weeks; all:true lifts the cap", async () => {
  for (let w = 10; w <= 30; w++) fs.mkdirSync(path.join(rec, "2026-W" + w), { recursive: true });
  const r = await s.load(); assert.strictEqual(r.weeks.length, 8); assert.strictEqual(r.weeks[0].week, "2026-W42"); assert.strictEqual(r.more, true);
  const all = await s.load({ all: true }); assert.ok(all.weeks.length > 8); assert.strictEqual(all.more, false);
});
t("the service never uses sync fs calls", () => { assert.ok(!/(?:lstat|readdir|readFile|open|read)Sync/.test(fs.readFileSync(path.join(__dirname, "..", "src", "recommendations", "service.js"), "utf8"))); });
(async () => {
  for (const [name, fn] of queue) { n++; try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + ": " + e.message); } }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(n - fails + "/" + n + " passed"); process.exit(fails ? 1 : 0);
})();
