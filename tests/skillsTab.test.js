// node tests/skillsTab.test.js - Skills & Plugins tab (v1.139.0): the read-only service (rotation, findings by agent ranked by score, ARGUS verdicts
// read back, sources, pinned copies), bad-file safety, schedule parsing, plus static guards on the renderer and the wiring. Temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const S = require("../src/skills/service");
let n = 0, fails = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adskills-"));
const res = path.join(tmp, "research"), rec = path.join(tmp, "recommendations"), tools = path.join(tmp, "skills");
const W = "2026-W43", P = "2026-W42";
[path.join(res, W), path.join(res, P), path.join(res, "2026-W44"), path.join(res, "sources"), path.join(rec, W), path.join(tools, "pinned", "a"), path.join(tools, "pinned", "b"), path.join(tools, "noreadme")].forEach((d) => fs.mkdirSync(d, { recursive: true }));
const item = (id, score, extra) => Object.assign({ id, title: "T " + id, class: "skill_plugin", use: "use_directly", how_it_helps: "helps " + id, integration: "Agent Desktop | X", score, url: "https://example.com/" + id, author: "a", licence: "MIT", permissions: "none", security: "unvetted", fit_agents: ["Security"] }, extra || {});
fs.writeFileSync(path.join(res, "skills_plugins_rotation.json"), "﻿" + JSON.stringify({ week: W, agents: ["Security", "UI-UX Agent", "Legal Agent"], reason: "R", schedule: "Thursday ~17:00 Israel, two hours before reset", setAt: "2026-10-20", score_rule: "rank by score" }));
fs.writeFileSync(path.join(res, W, "skills_Security.json"), JSON.stringify({ agent: "Security", week: W, generatedAt: "2026-10-22T17:04:00Z", spentUsd: 0.8, summary: "S", items: [item("low", 5), item("high", 8), item("mid", 7, { use: "borrow_idea", url: "javascript:alert(1)" }), { id: "", title: "x" }, null, item("bad", "x")] }));
fs.writeFileSync(path.join(res, W, "skills_UI-UX Agent.json"), JSON.stringify({ agent: "UI-UX Agent", items: [item("u1", 9)] }));
fs.writeFileSync(path.join(res, W, "skills_Broken.json"), "{not json");
fs.writeFileSync(path.join(res, W, "digest_Security.json"), JSON.stringify({ items: [item("x", 10)] }));   // not a skills file: ignored
fs.writeFileSync(path.join(res, P, "skills_Security.json"), JSON.stringify({ items: [item("old1", 6), item("old2", 6)] }));
fs.writeFileSync(path.join(rec, W, "Security.json"), JSON.stringify({ items: [{ id: "high", decision: { verdict: "approved", at: "2026-10-23T10:00:00Z" } }, { id: "mid", decision: { verdict: "bogus" } }, { id: "low" }] }));
fs.writeFileSync(path.join(res, "sources", "_skills_plugins.json"), JSON.stringify({ updatedAt: "2026-10-22", sources: [{ name: "B", url: "https://b.example", score: 4, barrenWeeks: 2 }, { name: "A", url: "ftp://nope", score: 10, lastUseful: "2026-10-22", note: "n" }, { name: "" }, 7, { name: "Zero", score: 0 }, { url: "https://github.com/x/nameless", score: 3 }] }));
fs.writeFileSync(path.join(tools, "pinned", "README.md"), "# Pinned thing (pinned copy)\n\nSource: https://github.com/x/y commit abc\nVetted by Security, 2026-10-24.\n\n    " + "a".repeat(64) + " *a/SKILL.md\n    " + "b".repeat(64) + " *b/SKILL.md\n");
fs.writeFileSync(path.join(tools, "pinned", "a", "SKILL.md"), "x"); fs.writeFileSync(path.join(tools, "pinned", "b", "SKILL.md"), "x");
const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();   // Saturday 24 Oct 2026, local time
const svc = S.createService({ researchDir: res, recDir: rec, skillsDir: tools, now: () => NOW });

t("newest week WITH skills files is shown; empty week folders are ignored", async () => { const r = await svc.load(); assert.strictEqual(r.ok, true); assert.strictEqual(r.week, W); assert.deepStrictEqual(r.weeks, [W, P]); assert.strictEqual(r.thisWeek, "2026-W43"); });
t("items grouped by agent, ranked by score, bad items and bad files dropped and counted", async () => {
  const r = await svc.load();
  assert.deepStrictEqual(r.agents.map((a) => a.agent), ["UI-UX Agent", "Security"]);       // agent with the best item first
  const sec = r.agents.find((a) => a.agent === "Security");
  assert.deepStrictEqual(sec.items.map((i) => i.id), ["high", "mid", "low", "bad"]);
  assert.strictEqual(sec.items[3].score, null); assert.strictEqual(r.skipped, 1); assert.strictEqual(r.total, 5); assert.strictEqual(sec.spent, 0.8);
});
t("verdict from ARGUS (recommendations file) is read back; unknown verdicts ignored", async () => {
  const sec = (await svc.load()).agents.find((a) => a.agent === "Security");
  assert.deepStrictEqual(sec.items[0].decision, { verdict: "approved", at: "2026-10-23T10:00:00Z" });
  assert.strictEqual(sec.items[1].decision, null); assert.strictEqual(sec.items[2].decision, null);
});
t("only http(s) links survive", async () => { const sec = (await svc.load()).agents.find((a) => a.agent === "Security"); assert.strictEqual(sec.items[0].url, "https://example.com/high"); assert.strictEqual(sec.items[1].url, ""); });
t("comparison: the week before is counted", async () => { const r = await svc.load(); assert.strictEqual(r.prevWeek, P); assert.strictEqual(r.prevTotal, 2); });
t("week picker: an older week loads; a bad or unknown week falls back to the newest", async () => {
  assert.strictEqual((await svc.load({ week: P })).week, P); assert.strictEqual((await svc.load({ week: P })).prevWeek, "");
  assert.strictEqual((await svc.load({ week: "../x" })).week, W); assert.strictEqual((await svc.load({ week: "2026-W01" })).week, W);
});
t("rotation: agents, reason, next run next Thursday 17:00 on the PC clock", async () => {
  const r = (await svc.load()).rotation;
  assert.deepStrictEqual(r.agents, ["Security", "UI-UX Agent", "Legal Agent"]); assert.strictEqual(r.week, W); assert.strictEqual(r.reason, "R");
  const d = new Date(r.nextRunAt); assert.strictEqual(d.getDay(), 4); assert.strictEqual(d.getHours(), 17); assert.strictEqual(d.getDate(), 29); assert.strictEqual(d.getMonth(), 9);
});
t("schedule parsing and next-run edge cases", () => {
  assert.deepStrictEqual(S.parseSchedule("Thursday ~17:00 Israel"), { day: 4, hour: 17, minute: 0 });
  assert.strictEqual(S.parseSchedule("sometime"), null); assert.strictEqual(S.parseSchedule("Thursday 25:00"), null);
  const thu1600 = new Date(2026, 9, 29, 16, 0).getTime(), thu1800 = new Date(2026, 9, 29, 18, 0).getTime(), sch = S.parseSchedule("Thursday 17:00");
  assert.strictEqual(new Date(S.nextRun(sch, thu1600)).getDate(), 29); assert.strictEqual(new Date(S.nextRun(sch, thu1800)).getDate(), 5);
  assert.strictEqual(S.nextRun(null, thu1600), null);
});
t("sources: cleaned, best first, bad entries dropped, bad URL emptied", async () => {
  const s = (await svc.load()).sources;
  assert.strictEqual(s.updatedAt, "2026-10-22"); assert.deepStrictEqual(s.list.map((x) => x.name), ["A", "B", "github.com/x/nameless", "Zero"]);
  assert.strictEqual(s.list[0].url, ""); assert.strictEqual(s.list[1].barrenWeeks, 2); assert.strictEqual(s.list[3].score, 0);
});
t("adopted: README title, source, vetted line, fingerprints and skills counted; folder without README ignored", async () => {
  const a = (await svc.load()).adopted;
  assert.strictEqual(a.length, 1); assert.strictEqual(a[0].title, "Pinned thing (pinned copy)"); assert.strictEqual(a[0].hashes, 2); assert.strictEqual(a[0].skills, 2);
  assert.ok(/^Source:/.test(a[0].source)); assert.ok(/^Vetted by Security/.test(a[0].vetted));
});
t("missing everything: calm empty result, never a throw", async () => {
  const e = S.createService({ researchDir: path.join(tmp, "nope"), recDir: path.join(tmp, "nope2"), skillsDir: null, now: () => NOW });
  const r = await e.load();
  assert.strictEqual(r.ok, true); assert.strictEqual(r.week, ""); assert.deepStrictEqual(r.agents, []); assert.strictEqual(r.rotation.missing, true); assert.strictEqual(r.sources.missing, true); assert.deepStrictEqual(r.adopted, []);
});
t("oversized file is skipped", async () => {
  fs.writeFileSync(path.join(res, W, "skills_Huge.json"), JSON.stringify({ items: [item("h", 9, { how_it_helps: "x".repeat(600 * 1024) })] }));
  const r = await svc.load(); assert.strictEqual(r.skipped, 2); assert.ok(!r.agents.some((a) => a.agent === "Huge"));
  fs.unlinkSync(path.join(res, W, "skills_Huge.json"));
});
const src = (p) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");
t("service is read-only and async (no sync fs, no writes)", () => { const s = src("skills/service.js"); assert.ok(!/Sync\(/.test(s)); assert.ok(!/writeFile|appendFile|rename|unlink|mkdir/.test(s)); });
t("renderer: textContent only, no innerHTML, no timers, no localStorage, writes nothing", () => {
  const r = src("renderer/skills.js");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(r)); assert.ok(!/setInterval|setTimeout/.test(r)); assert.ok(!/localStorage/.test(r));
  assert.ok(!/recsWrite|research-write|argusSetIdeaDecision/.test(r));
});
t("wiring: tab in research.js, IPC in main-research.js, preload bridge, CSS uses --rs- tokens only", () => {
  assert.ok(/\["skills", "Skills & Plugins"\]/.test(src("renderer/research.js"))); assert.ok(/skills\.js/.test(src("renderer/research.js")));
  assert.ok(/handle\("skills-load"/.test(src("research/main-research.js"))); assert.ok(/skillsLoad: \(week\) => ipcRenderer\.invoke\("skills-load"/.test(src("preload.js")));
  const css = src("renderer/styles-skills.css"); const vars = css.match(/var\(--[a-z0-9-]+/g) || []; assert.ok(vars.length && vars.every((v) => v.indexOf("var(--rs-") === 0));
});
(async () => {
  for (const [name, fn] of queue) { n++; try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + ": " + e.message); } }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(n - fails + "/" + n + " passed"); process.exit(fails ? 1 : 0);
})();
