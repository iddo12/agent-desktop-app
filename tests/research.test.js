// node tests/research.test.js - MY RESEARCH tab (v1.87.0): digest parsing (real shapes, broken/missing/oversized files), the COO's top5.json
// (curated, title match, missing, invalid, fallback), taste.json (atomic, no BOM, toggle, unreadable file untouched), IPC allow-list,
// external-link allow-list, and the privacy/lightness guards. Writes only into temp folders; never into shared_reports.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const SV = require("../src/research/service");
const MR = require("../src/research/main-research");

let n = 0, fails = 0; const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const SRC = path.join(__dirname, "..", "src");
const FX = path.join(__dirname, "fixtures", "research");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "research-test-"));
const copyFx = () => { const d = tmp(); fs.cpSync(FX, d, { recursive: true }); return d; };
const svc = (d, extra) => SV.createService(Object.assign({ researchDir: d }, extra || {}));

t("load: weeks listed newest first, only YYYY-Www folders; the latest is the default", () => {
  const d = copyFx(); fs.mkdirSync(path.join(d, "2026-W39")); fs.mkdirSync(path.join(d, "junk")); fs.writeFileSync(path.join(d, "readme.txt"), "x");
  const r = svc(d).load();
  assert.deepStrictEqual(r.weeks, ["2026-W41", "2026-W39"]); assert.strictEqual(r.week, "2026-W41");
  assert.strictEqual(svc(d).load({ week: "2026-W39" }).week, "2026-W39");
  assert.strictEqual(svc(d).load({ week: "../etc" }).week, "2026-W41", "a bad week name falls back to the latest");
});
t("digest: real shape parsed, high tier first, bad entries dropped, strings kept as text, status from the digest", () => {
  const r = svc(copyFx()).load();
  const a = r.digests.find((x) => x.agent === "Alpha Agent");
  assert.strictEqual(a.state, "ok"); assert.strictEqual(a.label, "Ran");
  assert.deepStrictEqual(a.findings.map((f) => f.title), ["High item", "Low item"], "high first; non-object and title-less entries dropped");
  const h = a.findings[0];
  assert.ok(h.worth && h.idea && h.tier === "high" && h.confidence === "confirmed");
  assert.deepStrictEqual(h.sources.map((s) => s.url), ["https://example.org/p", "https://example.org/bare"]);

});
t("digest: skipped, broken JSON and an agent that has no digest each get a word, never a crash", () => {
  const r = svc(copyFx()).load();
  assert.strictEqual(r.digests.find((x) => x.agent === "Beta Agent").state, "skipped");
  const b = r.digests.find((x) => x.file === "Broken Agent.json");
  assert.strictEqual(b.state, "unreadable"); assert.strictEqual(b.findings.length, 0);
  const g = r.digests.find((x) => x.agent === "Gamma Agent");
  assert.strictEqual(g.state, "did-not-run"); assert.ok(g.noDigest);
  assert.strictEqual(r.digests.filter((x) => x.agent === "Alpha Agent").length, 1, "a stale status row never duplicates an agent that has a digest");
});
t("digest: a wrong week, a non-list findings entry, an empty digest and a BOM are handled", () => {
  const d = copyFx(), w = path.join(d, "2026-W41");
  fs.writeFileSync(path.join(w, "Wk.json"), JSON.stringify({ agent: "Wk", week: "2026-W01", findings: [] }));
  fs.writeFileSync(path.join(w, "Nl.json"), JSON.stringify({ agent: "Nl", week: "2026-W41", findings: "oops" }));
  fs.writeFileSync(path.join(w, "Em.json"), JSON.stringify({ agent: "Em", week: "2026-W41", findings: [] }));
  fs.writeFileSync(path.join(w, "Bom.json"), "\uFEFF" + JSON.stringify({ agent: "Bom", week: "2026-W41", summary: "s", findings: [] }));
  const r = svc(d).load(), st = (a) => r.digests.find((x) => x.agent === a).state;
  assert.strictEqual(st("Wk"), "invalid"); assert.strictEqual(st("Nl"), "invalid"); assert.strictEqual(st("Em"), "empty"); assert.strictEqual(st("Bom"), "ok");
});
t("digest: a file over the size cap is skipped with a visible note; Security-sized digests (~100 KB) are fine", () => {
  assert.strictEqual(SV.MAX_FILE_BYTES, 2 * 1024 * 1024);
  const d = copyFx(), w = path.join(d, "2026-W41");
  const big = { agent: "Big", week: "2026-W41", summary: "s", findings: [{ id: "x", title: "t", whatChanged: "y".repeat(5000), soWhat: "z" }] };
  fs.writeFileSync(path.join(w, "Mid.json"), JSON.stringify(Object.assign({}, big, { agent: "Mid", findings: Array.from({ length: 30 }, (_, i) => Object.assign({}, big.findings[0], { id: "m" + i, title: "m" + i })) })));
  fs.writeFileSync(path.join(w, "Huge.json"), "{\"agent\":\"Huge\",\"pad\":\"" + "x".repeat(SV.MAX_FILE_BYTES + 10) + "\"}");
  const r = svc(d).load();
  assert.strictEqual(r.digests.find((x) => x.agent === "Mid").findings.length, 30);
  const h = r.digests.find((x) => x.file === "Huge.json");
  assert.strictEqual(h.state, "too-big"); assert.match(h.note, /2 MB/);
});
t("digest: long strings are clipped and at most 80 findings and 12 sources are kept", () => {
  const d = copyFx(), w = path.join(d, "2026-W41");
  fs.writeFileSync(path.join(w, "Lots.json"), JSON.stringify({ agent: "Lots", week: "2026-W41", summary: "s", findings: Array.from({ length: 100 }, (_, i) => ({ id: "i" + i, title: "t" + i, whatChanged: "w".repeat(9000), sources: Array.from({ length: 30 }, (_, j) => ({ title: "s", url: "https://e.org/" + j })) })) }));
  const l = svc(d).load().digests.find((x) => x.agent === "Lots");
  assert.strictEqual(l.findings.length, 80); assert.strictEqual(l.findings[0].whatChanged.length, 6000); assert.strictEqual(l.findings[0].sources.length, 12); assert.match(l.note, /first 80 of 100/);
});
t("top5: the COO's file resolves picks by agent + title (case/space-insensitive); a pick without a matching title is kept with agent + why only", () => {
  const r = svc(copyFx()).load();
  assert.strictEqual(r.top5.state, "curated"); assert.strictEqual(r.top5.pickedBy, "COO Agent"); assert.match(r.top5.pickedAt, /^2026-10-08/);
  assert.strictEqual(r.top5.picks.length, 2);
  assert.ok(r.top5.picks[0].found && r.top5.picks[0].finding.id === "a-high" && r.top5.picks[0].agent === "Alpha Agent" && r.top5.picks[0].why === "Read this first.");
  assert.ok(!r.top5.picks[1].found && r.top5.picks[1].finding === null && r.top5.picks[1].why === "Shown without its finding.");
});
t("top5: missing file -> state missing + an uncurated preview (first finding of the first five agents with findings); invalid file -> same with a note", () => {
  const d = copyFx(); fs.unlinkSync(path.join(d, "2026-W41", "_top5.json"));
  const r = svc(d).load();
  assert.strictEqual(r.top5.state, "missing"); assert.deepStrictEqual(r.top5.picks.map((p) => p.agent + ":" + p.title), ["Alpha Agent:High item"]);
  fs.writeFileSync(path.join(d, "2026-W41", "_top5.json"), "{ nope");
  assert.strictEqual(svc(d).load().top5.state, "invalid");
  fs.writeFileSync(path.join(d, "2026-W41", "_top5.json"), JSON.stringify({ picks: [] }));
  const e = svc(d).load().top5; assert.strictEqual(e.state, "invalid"); assert.match(e.note, /no usable picks/);
  fs.writeFileSync(path.join(d, "2026-W41", "_top5.json"), JSON.stringify([{ agent: "A", finding: "x" }]));
  assert.strictEqual(svc(d).load().top5.state, "invalid", "a bare list is not the agreed format");
});
t("top5: at most five picks are used", () => {
  const d = copyFx(); const picks = Array.from({ length: 9 }, () => ({ agent: "Alpha Agent", finding: "High item", why: "w" }));
  fs.writeFileSync(path.join(d, "2026-W41", "_top5.json"), JSON.stringify({ picks }));
  assert.strictEqual(svc(d).load().top5.picks.length, 5);
});
t("load: an unreadable week folder and an empty research folder give plain results, not exceptions", () => {
  const e = tmp(); assert.deepStrictEqual(svc(e).load().weeks, []); assert.strictEqual(svc(e).load().week, null);
  assert.strictEqual(svc(path.join(e, "does-not-exist")).load().week, null);
  const d = copyFx(); const s = svc(d); const orig = fs.readdirSync;
  fs.readdirSync = function (p, ...r) { if (String(p).endsWith("2026-W41")) throw Object.assign(new Error("x"), { code: "EACCES" }); return orig.call(this, p, ...r); };
  try { const r = s.load({ week: "2026-W41" }); assert.strictEqual(r.ok, false); assert.match(r.reason, /Couldn't read the week file/); } finally { fs.readdirSync = orig; }
});
t("coo + last week: contradictions appear only when coo\\weekly_<week>.json exists; last week's finding count is read from the older week", () => {
  const root = tmp(), rd = path.join(root, "research"); fs.mkdirSync(rd); fs.cpSync(FX, rd, { recursive: true });
  assert.strictEqual(svc(rd).load().coo, null);
  fs.mkdirSync(path.join(root, "coo")); fs.writeFileSync(path.join(root, "coo", "weekly_2026-W41.json"), JSON.stringify({ budgetAdvice: "Spend less.", contradictions: [{ between: ["A", "B"], about: "They disagree." }, { about: "" }] }));
  const c = svc(rd).load().coo; assert.strictEqual(c.contradictions.length, 1); assert.ok(!("budgetAdvice" in c));
  fs.mkdirSync(path.join(rd, "2026-W40")); fs.writeFileSync(path.join(rd, "2026-W40", "Alpha Agent.json"), JSON.stringify({ agent: "Alpha Agent", week: "2026-W40", spentUsd: 2, findings: [] }));
  const r = svc(rd).load({ week: "2026-W41" }); assert.strictEqual(r.digests.find((x) => x.agent === "Alpha Agent").prevFindings, 0); assert.strictEqual(r.prevWeek, "2026-W40");
});

// ------------------------------------------------------------------ taste.json
const sample = { week: "2026-W41", agent: "Alpha Agent", finding: "High item" };
t("taste: a mark creates taste.json atomically, UTF-8 WITHOUT a BOM, in the agreed shape; marking again toggles it off; no temp file is left", () => {
  const d = tmp(), s = svc(d), f = path.join(d, "taste.json");
  assert.deepStrictEqual(s.mark(Object.assign({ interesting: true }, sample)), { ok: true, interesting: true });
  const buf = fs.readFileSync(f); assert.notStrictEqual(buf[0], 0xEF, "no BOM"); assert.notStrictEqual(buf[0], 0xFF);
  const j = JSON.parse(buf.toString("utf8"));
  assert.deepStrictEqual(Object.keys(j).sort(), ["interesting", "not_interested", "updated"]);
  assert.deepStrictEqual(Object.keys(j.interesting[0]).sort(), ["agent", "finding", "marked_at", "week"]);
  assert.match(j.updated, /^\d{4}-\d\d-\d\dT/); assert.deepStrictEqual(j.not_interested, []);
  assert.deepStrictEqual(s.mark(Object.assign({ interesting: true }, sample, { agent: "alpha agent", finding: " HIGH item " })).ok, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(f, "utf8")).interesting.length, 1, "same finding (case/space-insensitive) is one entry");
  assert.deepStrictEqual(s.mark(Object.assign({ interesting: false }, sample)), { ok: true, interesting: false });
  assert.strictEqual(JSON.parse(fs.readFileSync(f, "utf8")).interesting.length, 0);
  assert.deepStrictEqual(fs.readdirSync(d).filter((x) => /\.tmp$/.test(x)), [], "temp file renamed away");
});
t("taste: the marks of the shown week come back from load(); not_interested written by someone else is kept; unreadable taste.json is never overwritten", () => {
  const d = copyFx(), s = svc(d), f = path.join(d, "taste.json");
  fs.writeFileSync(f, JSON.stringify({ updated: "x", interesting: [], not_interested: [{ week: "2026-W41", agent: "Beta Agent", finding: "Nope", marked_at: "t" }] }));
  s.mark(Object.assign({ interesting: true }, sample));
  assert.strictEqual(JSON.parse(fs.readFileSync(f, "utf8")).not_interested.length, 1);
  assert.deepStrictEqual(s.load().marked, ["2026-W41|alpha agent|high item"]);
  fs.writeFileSync(f, "{ corrupt");
  const r = s.mark(Object.assign({ interesting: true }, sample)); assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.readFileSync(f, "utf8"), "{ corrupt", "left untouched");
  assert.strictEqual(s.load().tasteOk, false);
  fs.writeFileSync(f, "\uFEFF" + JSON.stringify({ interesting: [Object.assign({ marked_at: "t" }, sample)], not_interested: [] }));
  assert.strictEqual(s.load().marked.length, 1, "a BOM written by someone else is tolerated on read");
});
t("taste: bad requests are refused (week format, empty agent/finding); the list is capped", () => {
  const s = svc(tmp());
  for (const bad of [{}, { week: "x", agent: "a", finding: "f", interesting: true }, { week: "2026-W41", agent: "", finding: "f", interesting: true }, { week: "2026-W41", agent: "a", finding: "", interesting: true }, null]) assert.strictEqual(s.mark(bad).ok, false);
  for (let i = 0; i < 520; i++) s.mark({ week: "2026-W41", agent: "a", finding: "f" + i, interesting: true });
  assert.strictEqual(s.readTaste().interesting.length, 500);
});

// ------------------------------------------------------------------ IPC
function world() {
  const handlers = {}, logs = [], opened = [];
  const wc = { mainFrame: {} }, win = { webContents: wc, isDestroyed: () => false };
  const d = copyFx(), ud = tmp();
  MR.init({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, getMainWindow: () => win, workspaceRoot: path.join(d, "ws"), userData: ud, testMode: true, log: (l) => logs.push(l), env: { AGENT_DESKTOP_RESEARCH_DIR: d }, openExternal: (u) => opened.push(u) });
  return { handlers, logs, opened, good: { sender: wc, senderFrame: wc.mainFrame }, wc, d, ud };
}
t("ipc: the allow-list of channels; only the main window's own frame may call; an oversized argument is refused", async () => {
  const w = world();
  assert.deepStrictEqual(Object.keys(w.handlers).sort(), ["recs-load", "recs-write", "research-badge", "research-export", "research-idea", "research-image", "research-image-cancel", "research-load", "research-mark", "research-open", "research-prefs-get", "research-prefs-set", "research-seen", "research-seen-all", "research-thread", "research-write", "skills-load", "skills-rotation-set"]);
  assert.strictEqual((await w.handlers["research-load"](w.good, {})).ok, true);
  assert.strictEqual((await w.handlers["research-load"]({ sender: {}, senderFrame: {} })).ok, false);
  assert.strictEqual((await w.handlers["research-load"]({ sender: w.wc, senderFrame: {} })).ok, false, "a sub-frame is refused");
  assert.strictEqual((await w.handlers["research-mark"](w.good, { week: "2026-W41", agent: "a", finding: "x".repeat(5000), interesting: true })).ok, false);
  assert.ok(w.logs.some((l) => /refused/.test(l)));
  assert.strictEqual((await w.handlers["research-mark"](w.good, Object.assign({ interesting: true }, sample))).ok, true);
  assert.ok(fs.existsSync(path.join(w.d, "taste.json")));
});
t("ipc: research-open opens only plain http(s) links (no file:, javascript:, credentials, over-long)", async () => {
  const w = world();
  for (const u of ["file:///C:/x", "javascript:alert(1)", "https://user:pw@example.org/", "ftp://example.org", "not a url", "https://" + "a".repeat(1100) + ".org", "", null, 5]) assert.strictEqual((await w.handlers["research-open"](w.good, { url: u })).ok, false, String(u).slice(0, 30));
  assert.strictEqual((await w.handlers["research-open"](w.good, { url: "https://example.org/a?b=1" })).ok, true);
  assert.deepStrictEqual(w.opened, ["https://example.org/a?b=1"]);
});
t("ipc: the last-opened marker lives in research_prefs.json (not localStorage) and is validated both ways", async () => {
  const w = world();
  assert.deepStrictEqual((await w.handlers["research-prefs-get"](w.good)).prefs, { lastOpened: null, legendOpen: true, view: "magazine", imageWrong: [], agentFilter: "" });
  assert.strictEqual((await w.handlers["research-prefs-set"](w.good, { lastOpened: { week: "bad", agent: "a", finding: "f" } })).ok, false);
  assert.strictEqual((await w.handlers["research-prefs-set"](w.good, { lastOpened: { week: "2026-W41", agent: "Alpha Agent", finding: "High item" } })).ok, true);
  assert.deepStrictEqual((await w.handlers["research-prefs-get"](w.good)).prefs.lastOpened, { week: "2026-W41", agent: "Alpha Agent", finding: "High item" });
  assert.ok(fs.existsSync(path.join(w.ud, "research_prefs.json")));
});
t("ipc: the renderer never sends a path; the folder is fixed in main (test override only in test mode)", () => {
  const pre = fs.readFileSync(path.join(SRC, "preload.js"), "utf8"), blk = pre.slice(pre.indexOf("research: {"), pre.indexOf("research: {") + 600);
  assert.ok(/load: \(week\)/.test(blk) && !/path|command/i.test(blk.split("tools: {")[0].replace(/\/\/.*$/gm, "")));
  const main = fs.readFileSync(path.join(SRC, "research", "main-research.js"), "utf8");
  assert.ok(/testMode && e\.AGENT_DESKTOP_RESEARCH_DIR/.test(main));
  assert.strictEqual((fs.readFileSync(path.join(SRC, "main.js"), "utf8").match(/require\("\.\/research\//g) || []).length, 1, "one lazy require in main.js");
});

// ------------------------------------------------------------------ guards (static)
const files = () => fs.readdirSync(path.join(SRC, "research")).map((f) => path.join(SRC, "research", f)).concat(["research.js", "research-nav.js"].map((f) => path.join(SRC, "renderer", f)));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
t("guards: no console output, no shell/eval/storage/clipboard/innerHTML/title in the research code; only main-research opens links, with no spawn", () => {
  for (const f of files()) {
    const s = strip(fs.readFileSync(f, "utf8")), name = path.basename(f);
    assert.ok(!/console\.(log|info|debug|warn|trace|dir|table)\s*\(/.test(s), "console output in " + name);
    for (const re of [/document\.title/, /clipboard/i, /localStorage/, /sessionStorage/, /indexedDB/, /\beval\s*\(/, /new Function/, /innerHTML/, /insertAdjacentHTML/, /child_process/, /\bexec\s*\(/, /shell:\s*true/, /crashReporter/]) assert.ok(!re.test(s), name + " matches " + re);
  }
  const ren = strip(fs.readFileSync(path.join(SRC, "renderer", "research.js"), "utf8"));
  assert.ok(!/openExternal|shell\./.test(ren), "the renderer never opens links itself; it asks main");
});
t("guards: lightness - no setInterval/observers, view code and css load lazily, only the nav runs at startup, one toast timer", () => {
  for (const f of files()) { const s = strip(fs.readFileSync(f, "utf8")); assert.ok(!/setInterval|requestAnimationFrame|MutationObserver/.test(s), path.basename(f)); assert.ok((s.match(/new IntersectionObserver/g) || []).length <= (path.basename(f) === "research.js" ? 2 : 0), path.basename(f) + ": v1.91.0 allows one lazy-image observer in the view only"); }
  const view = strip(fs.readFileSync(path.join(SRC, "renderer", "research.js"), "utf8"));
  assert.strictEqual((view.match(/setTimeout/g) || []).length, 3, "the toast fade, plus v1.107.0: the batched read-flush and the on-screen dwell timer");
  const html = fs.readFileSync(path.join(SRC, "renderer", "index.html"), "utf8");
  assert.ok(html.includes("research-nav.js") && html.includes("styles-research-nav.css")); assert.ok(!/"research\.js"/.test(html) && !html.includes("styles-research.css"));
  assert.ok(html.indexOf("research-nav.js") < html.indexOf("<script src=\"leftpane.js\">"), "the nav exists before the left pane builds its tiles");
  assert.ok(/data-system-nav|dataset\.systemNav = "research"/.test(fs.readFileSync(path.join(SRC, "renderer", "research-nav.js"), "utf8")));
  assert.ok(/id: "research"[^}]*research-open/.test(fs.readFileSync(path.join(SRC, "renderer", "viewmanager.js"), "utf8")));
  assert.ok(/"research-open"\]/.test(fs.readFileSync(path.join(SRC, "renderer", "renderer.js"), "utf8")), "dictation does not type into the chat while My Research is open");
  assert.ok(/view\.classList\.add\("hidden"\)/.test(view) && /S\.snap = null/.test(view), "content is dropped when the view closes");
});
t("guards: accessibility and design - headers are buttons with aria-expanded, Hebrew uses dir=auto, 15 px body, tokens only, named render functions", () => {
  const js = fs.readFileSync(path.join(SRC, "renderer", "research.js"), "utf8");
  assert.ok((js.match(/aria-expanded/g) || []).length >= 5 && /aria-pressed/.test(js) && /dir", "auto"/.test(js) && /role", "status"|setAttribute\("role", "status"\)/.test(js));
  for (const fn of ["renderHeader", "renderAskBar", "renderLegend", "renderTopFive", "renderPickCard", "renderCoo", "renderGlance", "renderThemes", "renderFilters", "renderAgentTile", "renderTierBar", "renderFindingCard", "renderFindingBody", "renderSources", "renderState"]) assert.ok(new RegExp("function " + fn + "\\(").test(js), fn);
  const css = fs.readFileSync(path.join(SRC, "renderer", "styles-research.css"), "utf8");
  assert.ok(/:root\s*\{[^}]*--rs-gap/.test(css) && /font-size: 15px/.test(css) && /max-width: 80ch/.test(css));
  const body = css.slice(css.indexOf("#research-view {"));
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(body.replace(/#research-view/g, "").replace(/(:root|body\.dark, html\[data-theme="dark"\] body)\s*\{[^}]*\}/g, "")), "no literal colours outside the token blocks");
  assert.ok(!/font-size:\s*(9|10|11)(\.\d)?px/.test(css.replace(/\.rs-kind[^}]*\}|\.rs-av[^}]*\}|\.rs-tier[^}]*\}/g, "")), "text under 12 px only in the avatar initials and tiny caps labels");
});
t("leftpane: a tile with data-system-nav=research is a live tile, and its label style is covered", () => {
  const LP = require("../src/leftpane");
  const tiles = LP.planTiles(["argus"], ["research"]);
  assert.strictEqual(tiles.find((x) => x.id === "research").kind, "live");
  const css = fs.readFileSync(path.join(SRC, "renderer", "styles-leftpane.css"), "utf8");
  assert.ok(css.includes("research-nav-name"));
  assert.ok(/research:\s*\[\["circle"/.test(fs.readFileSync(path.join(SRC, "renderer", "leftpane.js"), "utf8")));
});

// ------------------------------------------------------------------ extras and the visual rules
t("load: last week's numbers (totals and per agent) come from the older week for the 'last week N' figures; none when there is no older week", () => {
  const root = tmp(), rd = path.join(root, "research"); fs.mkdirSync(rd); fs.cpSync(FX, rd, { recursive: true });
  assert.strictEqual(svc(rd).load().prevStats, null);
  fs.mkdirSync(path.join(rd, "2026-W40"));
  fs.writeFileSync(path.join(rd, "2026-W40", "Alpha Agent.json"), JSON.stringify({ agent: "Alpha Agent", week: "2026-W40", spentUsd: 2, findings: [{ title: "a", tier: "high", worthOwnerKnowing: true }, { title: "b", tier: "low", couldBecomeIdea: true }] }));
  const r = svc(rd).load({ week: "2026-W41" });
  assert.deepStrictEqual(r.prevStats, { findings: 2, high: 1, worth: 1, idea: 1, ran: 1, skipped: 0 });
  assert.strictEqual(r.digests.find((x) => x.agent === "Alpha Agent").prevFindings, 2);
  assert.strictEqual(r.digests.find((x) => x.agent === "Beta Agent").prevFindings, null);
});
t("cost is intentionally NOT shown: no spend, budget or boost figure in the service output, the tab code, the css or the week summary", () => {
  const d = copyFx(); fs.writeFileSync(path.join(d, "2026-W41", "Boost.json"), JSON.stringify({ agent: "Boost", week: "2026-W41", summary: "s", spentUsd: 35, budgetUsd: 72, boostTargetUsd: 252, findings: [] }));
  const r = svc(d).load();
  assert.ok(!/"(spentUsd|budgetUsd|boostUsd|prevSpentUsd|budgetAdvice)"/.test(JSON.stringify(r)), "no money field leaves the service");
  assert.ok(!/spent|budget|boost|usd|renderMeter/i.test(fs.readFileSync(path.join(SRC, "renderer", "research.js"), "utf8").replace(/Research cost is intentionally not shown anywhere\./, "")));
  assert.ok(!/rs-bar|rs-tick|rs-meter|rs-spent/.test(fs.readFileSync(path.join(SRC, "renderer", "styles-research.css"), "utf8")));
  assert.ok(!/Research spend|Budget advice|\$\d/.test(require("../src/research/summary").buildSummary(r)));
});
t("extra ideas inbox: adds once (no duplicates), UTF-8 without BOM, kept apart from taste.json; load() reports what was added for the week", () => {
  const d = copyFx(), s = svc(d), f = path.join(d, "ideas_inbox.json");
  assert.deepStrictEqual(s.addIdea(sample), { ok: true });
  assert.deepStrictEqual(s.addIdea(Object.assign({}, sample, { finding: " high ITEM" })), { ok: true, already: true });
  const buf = fs.readFileSync(f); assert.notStrictEqual(buf[0], 0xEF);
  const j = JSON.parse(buf.toString("utf8")); assert.strictEqual(j.ideas.length, 1); assert.deepStrictEqual(Object.keys(j.ideas[0]).sort(), ["added_at", "agent", "finding", "week"]);
  assert.deepStrictEqual(s.load().ideasAdded, ["2026-W41|alpha agent|high item"]);
  assert.ok(!fs.existsSync(path.join(d, "taste.json")));
  assert.strictEqual(s.addIdea({ week: "x", agent: "a", finding: "f" }).ok, false);
  fs.writeFileSync(f, "{ corrupt"); assert.strictEqual(s.addIdea(Object.assign({}, sample, { finding: "other" })).ok, false); assert.strictEqual(fs.readFileSync(f, "utf8"), "{ corrupt");
});
t("extra week summary: readable markdown with counts, the five, every agent and finding; same text from the service and the command line tool", () => {
  const root = tmp(), rd = path.join(root, "shared_reports", "research"); fs.mkdirSync(rd, { recursive: true }); fs.cpSync(FX, rd, { recursive: true });
  const s = svc(rd);
  const r = s.exportSummary("2026-W41"); assert.strictEqual(r.ok, true);
  assert.strictEqual(r.file, path.join(rd, "2026-W41", "_week_summary.md"));
  const md = fs.readFileSync(r.file, "utf8");
  for (const needle of ["# Research summary 2026-W41", "2 findings from 1 agents", "Curated by COO Agent", "**Alpha Agent**: High item - Read this first.", "#### [high, confirmed] High item", "What changed: c2", "primary: P <https://example.org/p>", "### Beta Agent - Skipped", "### Gamma Agent - Did not run"]) assert.ok(md.includes(needle), needle);
  assert.ok(md.indexOf("#### [high") < md.indexOf("#### [low"), "high tier first");
  assert.strictEqual(s.exportSummary("../x").ok, false); assert.strictEqual(s.exportSummary("2026-W01").ok, false);
  const cp = require("child_process"), tool = path.join(__dirname, "..", "tools", "research-aggregate.js");
  const out = cp.spawnSync(process.execPath, [tool, "2026-W41", "--root", root, "--print"], { encoding: "utf8" });
  assert.strictEqual(out.status, 0, out.stderr); assert.strictEqual(out.stdout, md, "CLI output equals the app's file");
  assert.strictEqual(cp.spawnSync(process.execPath, [tool, "nonsense"], { encoding: "utf8" }).status, 2);
});
t("ipc: research-idea and research-export work through the allow-listed channels and write only in the research folder", async () => {
  const w = world();
  assert.strictEqual((await w.handlers["research-idea"](w.good, sample)).ok, true); assert.ok(fs.existsSync(path.join(w.d, "ideas_inbox.json")));
  const e = await w.handlers["research-export"](w.good, { week: "2026-W41" }); assert.strictEqual(e.ok, true); assert.ok(e.file.startsWith(w.d));
  assert.strictEqual((await w.handlers["research-export"](w.good, { week: "../../etc" })).ok, false);
});
t("visual rules (UI-UX + Alex): legend is never collapsible (not sticky since v1.104.0), 6 glance tiles that filter, themes, 4-up agent tiles, so-what headline 26px, 14px floor, shapes with colours", () => {
  const js = fs.readFileSync(path.join(SRC, "renderer", "research.js"), "utf8"), css = fs.readFileSync(path.join(SRC, "renderer", "styles-research.css"), "utf8");
  assert.ok(/\.rs-legend \{[^}]*position: static/.test(css) && /@media \(max-width: 999px\)[^]*rs-lg-toggle \{ display: flex/.test(css) && /\.rs-lg-toggle \{ display: none/.test(css), "toggle only below 1000 px");
  for (const w of ["Findings", "High tier", "Needs your eye", "Idea candidates", "Agents ran", "Did not run"]) assert.ok(js.includes('"' + w + '"'), w);
  assert.ok(/last week/.test(js) && /\.rs-gl-n \{[^}]*font-size: 46px/.test(css) && /\.rs-so \{[^}]*font-size: 26px/.test(css) && /\.rs-tile-ct \{[^}]*font-size: 40px/.test(css));
  assert.ok(/border-left: 10px solid var\(--rs-c\)/.test(css) && /border-left: 12px solid/.test(css) && /\.rs-tile-bad \{[^}]*dashed/.test(css));
  assert.ok(!/font-size:\s*(9|10|11)(\.\d)?px/.test(css.replace(/\.rs-secl[^}]*\}|\.rs-h4[^}]*\}|\.rs-lg-h[^}]*\}|\.rs-kind[^}]*\}/g, "")), "nothing under 12 px (v1.88.2 polish: chips 13, section labels 12)");
  assert.ok(js.includes('shape: "▲"') && js.includes('shape: "■"') && js.includes('shape: "▼"') && /renderTierChip/.test(js), "tier is shape + word, never colour alone");
  assert.ok(/aria-pressed/.test(js) && /👁/.test(js) && /💡/.test(js));
});

t("fix2: headline is never truncated (first sentence; rest moves to the top of Why it matters when over ~140 chars); prose 75ch; toast in flow; themes wrap with aria-label", () => {
  const js = fs.readFileSync(path.join(SRC, "renderer", "research.js"), "utf8"), css = fs.readFileSync(path.join(SRC, "renderer", "styles-research.css"), "utf8");
  const so = css.match(/\.rs-so \{[^}]*\}/)[0]; assert.ok(!/line-clamp|text-overflow|overflow: hidden/.test(so));
  assert.ok(/\.rs-so\.rs-so-sm \{ font-size: 22px/.test(css) && /@media \(max-width: 999px\)[^]*\.rs-legend \{ display: contents/.test(css) && /\.rs-lg-toggle \{[^}]*position: static/.test(css), "22px over 90 chars; narrow legend toggle row (v1.104.0: no longer sticky)");
  assert.ok(/\.rs-text \{[^}]*max-width: 75ch/.test(css));
  assert.ok(!/\.rs-toast \{[^}]*position: absolute/.test(css) && /\.rs-toast \{[^}]*align-self: center/.test(css));
  assert.ok(/\.rs-theme-n \{[^}]*max-width: 28ch[^}]*white-space: normal/.test(css) && /setAttribute\("aria-label", t \+ ", "/.test(js) && !/slice\(0, 34\)/.test(js));
  assert.ok(/\.rs-ask-t \{ flex: 1 1 calc\(100% - 150px\)/.test(css));
  // pure headline logic, extracted from the source and run
  const m = js.match(/function splitHeadline[^]*?const whyText = [^\n]*/)[0];
  const f = new Function(m + "; return { splitHeadline, whyText };")();
  const long = "Every Chromium and Electron fix since 33 went EOL is absent from Agent Desktop. " + "More detail that matters here. ".repeat(6);
  const h = f.splitHeadline(long); assert.strictEqual(h.head, "Every Chromium and Electron fix since 33 went EOL is absent from Agent Desktop."); assert.ok(f.whyText({ soWhat: long }).startsWith("More detail"));
  assert.strictEqual(f.whyText({ soWhat: "Short one. Two." }), "Short one. Two.", "short texts keep the whole text in Why it matters");
  assert.strictEqual(f.splitHeadline("No sentence break here at all and it just goes on").head, "No sentence break here at all and it just goes on");
  const nb = "Word ".repeat(40).trim(), hb = f.splitHeadline(nb);
  assert.ok(hb.cut && hb.head.endsWith("…") && hb.head.length <= 111 && !/\sWo?r?…$/.test(hb.head.replace(/Word…$/, "")), "cut at a whole word with an ellipsis");
  assert.strictEqual(f.whyText({ soWhat: nb }), nb, "the full text leads Why it matters when the headline was cut");
  assert.strictEqual(f.splitHeadline("Fixed in 44.6.0 and later versions ship it. Next.").head, "Fixed in 44.6.0 and later versions ship it.", "version numbers do not end a sentence");
});
t("fix2: findings sort high first, then worth-knowing, then the rest; prefs file keeps lastOpened and legendOpen together", async () => {
  const d = tmp(), w = path.join(d, "2026-W41"); fs.mkdirSync(w);
  fs.writeFileSync(path.join(w, "A.json"), JSON.stringify({ agent: "A", week: "2026-W41", summary: "s", findings: [{ title: "n1", tier: "normal" }, { title: "n2w", tier: "normal", worthOwnerKnowing: true }, { title: "h1", tier: "high" }, { title: "h2w", tier: "high", worthOwnerKnowing: true }] }));
  assert.deepStrictEqual(svc(d).load().digests[0].findings.map((x) => x.title), ["h2w", "h1", "n2w", "n1"]);
  const wd = world();
  assert.strictEqual((await wd.handlers["research-prefs-get"](wd.good)).prefs.legendOpen, true);
  await wd.handlers["research-prefs-set"](wd.good, { legendOpen: false });
  await wd.handlers["research-prefs-set"](wd.good, { lastOpened: { week: "2026-W41", agent: "A", finding: "f" } });
  const p = (await wd.handlers["research-prefs-get"](wd.good)).prefs; assert.strictEqual(p.legendOpen, false); assert.strictEqual(p.lastOpened.finding, "f");
  assert.strictEqual((await wd.handlers["research-prefs-set"](wd.good, { legendOpen: "x" })).ok, false);
});

(async () => {
  for (const q of queue) {
    n++;
    try { await q.fn(); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); }
  }
  console.log(fails ? fails + " of " + n + " FAILED" : "research: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
