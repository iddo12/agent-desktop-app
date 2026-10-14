"use strict";
// Demo mode (v1.86.0): the fictional-data world, the fake session, the My Health data source, and the LEAK TEST over every fixture.
// Run on its own:  NODE_PATH=... node tests/demo.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const FIX = path.join(REPO, "demo", "fixtures");
const { resolvePaths, VIRTUAL_REPORTS } = require("../src/demo/paths");
const { materialize, transcriptLines } = require("../src/demo/materialize");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "ad-demo-test-"));
const P = resolvePaths({ AGENT_DESKTOP_DEMO_USERDATA: base });
const world = materialize(P, { now: Date.now(), pid: process.pid });

function walk(dir, out) {
  out = out || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ world
test("nine agents in four coloured groups, with all three states", () => {
  assert.strictEqual(world.studio.agents.length, 9);
  const doc = JSON.parse(fs.readFileSync(path.join(P.root, "agent_groups.json"), "utf8"));
  assert.deepStrictEqual(doc.groups.map((g) => g.name), ["Studio", "Business", "Online", "Personal"]);
  const members = doc.groups.flatMap((g) => g.members).sort();
  assert.deepStrictEqual(members, world.studio.agents.map((a) => a.folder).sort());
  const states = new Set(world.studio.agents.map((a) => a.state));
  for (const s of ["working", "needs", "idle"]) assert.ok(states.has(s), "missing state " + s);
});

test("every JSON the world writes is BOM-free and parses", () => {
  for (const f of walk(base).filter((p) => /\.json$/.test(p))) {
    const buf = fs.readFileSync(f);
    assert.notStrictEqual(buf[0], 0xef, "BOM in " + f);
    JSON.parse(buf.toString("utf8"));
  }
});

test("four real PDFs, copied next to the agents that wrote them", () => {
  const pdfs = walk(path.join(FIX, "reports")).filter((p) => p.endsWith(".pdf"));
  assert.strictEqual(pdfs.length, 4);
  for (const p of pdfs) assert.strictEqual(fs.readFileSync(p).subarray(0, 5).toString(), "%PDF-");
  assert.ok(fs.existsSync(path.join(P.root, "Research", "reports", "Gimbal comparison, spring 2027.pdf")));
});

test("activity states come out right through the app's own reader", () => {
  const savedHome = process.env.USERPROFILE, savedHome2 = process.env.HOME;
  process.env.USERPROFILE = P.home; process.env.HOME = P.home;
  try {
    const { getSessionActivity, getLatestUsage } = require("../src/archive");
    const act = (f) => getSessionActivity(path.join(P.root, f, ".claude-session"));
    for (const f of ["Writer", "Research", "Email", "Personal Assistant"]) assert.strictEqual(act(f).working, true, f + " should be working");
    for (const f of ["Video", "Shopping", "Finance", "Web", "Health"]) assert.strictEqual(act(f).working, false, f + " should not be working");
    assert.ok(getLatestUsage(path.join(P.root, "Research", ".claude-session")).contextTokens > 1000);
  } finally { process.env.USERPROFILE = savedHome; process.env.HOME = savedHome2; }
});

test("the usage header reads 38% session and 54% week", () => {
  const savedHome = process.env.USERPROFILE;
  process.env.USERPROFILE = P.home;
  try {
    const r = JSON.parse(fs.readFileSync(world.rateFile, "utf8"));
    assert.strictEqual(r.fiveHourUsedPct, 38);
    assert.strictEqual(r.sevenDayUsedPct, 54);
    assert.ok(r.fiveHourResetsAt > Date.now() / 1000 && r.sevenDayResetsAt > Date.now() / 1000);
  } finally { process.env.USERPROFILE = savedHome; }
});

test("the Research thread ends in a table and carries a clickable report path", () => {
  const lines = transcriptLines(JSON.parse(fs.readFileSync(path.join(FIX, "agents", "Research", "thread.json"), "utf8")), "00000000-0000-4000-a000-000000000000", Date.now(), { REPORTS: VIRTUAL_REPORTS });
  assert.ok(/\| Model A \|/.test(lines) && /Gimbal comparison, spring 2027\.pdf/.test(lines));
  assert.ok(lines.indexOf(VIRTUAL_REPORTS.replace(/\\/g, "\\\\")) > 0, "virtual report folder in the text");
});

test("Library: 3 ideas, 3 researched, 2 active, 4 documents, 3 images", () => {
  const entries = fs.readdirSync(path.join(P.root, "shared_registry")).map((f) => JSON.parse(fs.readFileSync(path.join(P.root, "shared_registry", f), "utf8")));
  const n = (t, s) => entries.filter((e) => e.type === t && (s == null || e.stage === s)).length;
  assert.deepStrictEqual([n("project", "idea"), n("project", "researched"), n("project", "active"), n("document"), n("image")], [3, 3, 2, 4, 3]);
  for (const e of entries.filter((x) => x.type !== "project" || x.link)) if (e.link) assert.ok(fs.existsSync(e.link), "missing " + e.link);
});

// ------------------------------------------------------------------------------------------------ fake session
test("the fake terminal answers a typed message and writes both sides to the transcript", async () => {
  const { createFakePty } = require("../src/demo/fakePty");
  const thread = JSON.parse(fs.readFileSync(path.join(FIX, "agents", "Shopping", "thread.json"), "utf8"));
  const projDir = path.join(base, "fakeproj");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "11111111-1111-4111-a111-111111111111.jsonl"), "");
  const f = createFakePty({ agent: { name: "Shopping", role: "x", folder: "Shopping" }, thread, projDir, working: false });
  const seen = [];
  f.proc.onData((d) => seen.push(d));
  f.proc.write("\x1b[200~Lens Y please\x1b[201~");
  f.proc.write("\r");
  await new Promise((r) => setTimeout(r, 2600));
  const lines = fs.readFileSync(path.join(projDir, "11111111-1111-4111-a111-111111111111.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.strictEqual(lines[0].type, "user");
  assert.strictEqual(lines[0].origin.kind, "human");
  assert.strictEqual(lines[0].message.content, "Lens Y please");
  assert.strictEqual(lines[1].type, "assistant");
  assert.ok(/Lens Y it is/.test(lines[1].message.content[0].text), "rule for Y");
  assert.ok(seen.join("").indexOf("Lens Y it is") > 0);
  f.proc.kill();
});

test("a slash command is not treated as a message", async () => {
  const { createFakePty } = require("../src/demo/fakePty");
  const projDir = path.join(base, "fakeproj2");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "22222222-2222-4222-a222-222222222222.jsonl"), "");
  const f = createFakePty({ agent: { name: "A", role: "", folder: "A" }, thread: { messages: [] }, projDir, working: false });
  f.proc.write("/clear\r");
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(fs.readFileSync(path.join(projDir, "22222222-2222-4222-a222-222222222222.jsonl"), "utf8"), "");
  f.proc.kill();
});

test("tables are drawn with box characters in the raw terminal", () => {
  const { boxTable } = require("../src/demo/fakePty");
  const t = boxTable(["| A | B |", "|---|---|", "| 1 | 2 |"]);
  assert.ok(t.indexOf("\u250c") === 0 && t.indexOf("\u2514") > 0 && t.indexOf("\u2502 1 \u2502 2 \u2502") > 0);
});

test("a report path shown on screen maps onto the file in the demo folder", () => {
  const { findReport } = require("../src/demo/overrides");
  const f = findReport({ P }, VIRTUAL_REPORTS + "\\Gimbal comparison, spring 2027.pdf");
  assert.ok(f && f.toLowerCase().startsWith(P.root.toLowerCase()) && fs.existsSync(f));
  assert.strictEqual(findReport({ P }, VIRTUAL_REPORTS + "\\No such report.pdf"), null);
});

test("demo mail and calendar have the shapes My Daily expects", () => {
  const d = require("../src/demo/dailyProvider");
  const e = d.emails(Date.now());
  for (const k of ["top", "needAnswer", "sentNoReply", "peopleToWrite"]) assert.ok(Array.isArray(e[k]) && e[k].length, k);
  const ev = d.events(Date.now());
  assert.ok(ev.length > 5 && ev.every((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.title));
});

// ------------------------------------------------------------------------------------------------ My Health reads only the demo folder
test("My Health: every file it touches is inside the demo health folder", () => {
  const { resolveRoot } = require("../src/health/roots");
  const ENV = { AGENT_DESKTOP_HEALTH_ROOT: P.health, AGENT_DESKTOP_DEMO: "1" };
  const rr = resolveRoot({ env: ENV, testMode: true, userData: P.userData });
  assert.strictEqual(rr.ok, true, "the health root is accepted: " + JSON.stringify(rr));
  const { createService } = require("../src/health/service");
  const svc = createService({ env: ENV, testMode: true, userData: P.userData, log: () => {} });
  const touched = [];
  const orig = {};
  for (const n of ["readFileSync", "readdirSync", "statSync", "lstatSync", "existsSync", "openSync", "realpathSync", "accessSync"]) {
    orig[n] = fs[n];
    fs[n] = function (p, ...a) { if (typeof p === "string" || p instanceof URL) touched.push(String(p)); return orig[n].call(fs, p, ...a); };
  }
  const origNative = fs.realpathSync.native;
  fs.realpathSync.native = function (p, ...a) { touched.push(String(p)); return origNative.call(fs.realpathSync, p, ...a); };
  let loaded, agent, lon, inter, nutr, routines;
  try {
    loaded = svc.load(); agent = svc.agentLoad();
    lon = svc.extraLoad({ tab: "longevity" }); inter = svc.extraLoad({ tab: "interactions" });
    nutr = svc.extraLoad({ tab: "nutrition" }); routines = svc.extraLoad({ tab: "routines" });
  } finally { for (const n of Object.keys(orig)) fs[n] = orig[n]; fs.realpathSync.native = origNative; }
  assert.strictEqual(loaded.ok, true);
  assert.ok(agent.ok && agent.insights.cards.length === 3);
  assert.ok(lon.ok && lon.bio && lon.bio.state === "ok", "longevity estimate is computed from the invented panel");
  assert.ok(inter.ok && inter.pairs.length === 4);
  const inside = (p) => path.resolve(p).toLowerCase().startsWith(P.health.toLowerCase());
  const code = (p) => /[\\/](node_modules|src)[\\/]/i.test(p) || /\.js$/i.test(p) || /^node:/.test(p);
  const outside = touched.filter((p) => !inside(p) && !code(p));
  assert.deepStrictEqual(outside, [], "health read outside the demo folder: " + outside.join(", "));
  assert.ok(touched.some(inside), "it did read the demo folder");
});

test("My Health: the real vault path is refused in test mode, so a missing override can never reach it", () => {
  const { resolveRoot } = require("../src/health/roots");
  const r = resolveRoot({ env: { AGENT_DESKTOP_HEALTH_ROOT: "C:\\Example\\Scratch\\Health\\vault\\extracted" }, parent: "C:\\Example\\Scratch\\Health", testMode: true, userData: P.userData });
  assert.strictEqual(r.ok, false);
});

// ------------------------------------------------------------------------------------------------ guards
test("main.js: every demo hook is guarded by demo.ON", () => {
  const src = fs.readFileSync(path.join(REPO, "src", "main.js"), "utf8").split("\n");
  const hooks = src.filter((l) => /\bdemo\./.test(l) && !/^\s*\/\//.test(l));
  assert.ok(hooks.length >= 8);
  for (const l of hooks) assert.ok(/demo\.ON/.test(l), "unguarded demo hook: " + l.trim());
  assert.ok(src.some((l) => /require\("\.\/demo"\)/.test(l)));
});

test("with the variable unset the demo module loads nothing", () => {
  const saved = process.env.AGENT_DESKTOP_DEMO;
  delete process.env.AGENT_DESKTOP_DEMO;
  delete require.cache[require.resolve("../src/demo/index.js")];
  try { assert.deepStrictEqual(require("../src/demo"), { ON: false }); } finally { if (saved !== undefined) process.env.AGENT_DESKTOP_DEMO = saved; }
});

test("main-daily and the renderer never name the demo provider unless demo mode is on", () => {
  const src = fs.readFileSync(path.join(REPO, "src", "daily", "main-daily.js"), "utf8");
  assert.ok(/const demoP = process\.env\.AGENT_DESKTOP_DEMO === "1" \? require/.test(src));
});

// ------------------------------------------------------------------------------------------------ the leak test
const FORBIDDEN = [
  /Alex/i, /Sarah/i, /Acmeco/i, /gadgetry/i, /greenery/i, /cafeshoot/i, /Id{2}o/i, /Mer[a]v/i, /Lens[V]id/i, /mega[p]ixel/i, /vegg[i]ez/i, /shoot[e]at/i, /zorg4{2}/i,
  /Dropbox/i, /E:\\+Claude[ ]work/i, /C:\\+Users/i, /owner.example/i, /gmail/i,
  /D:\\+/i, /@[a-z0-9-]+\.(com|co\.il|net|org)\b/i, /AppData/i, /Claude[ ]stuff/i, /\bAmit\b|\bYossi\b/,
];
function scanText(label, text, hits) {
  for (const re of FORBIDDEN) { const m = re.exec(text); if (m) hits.push(label + ": " + re + " -> " + JSON.stringify(text.slice(Math.max(0, m.index - 30), m.index + 50))); }
}

test("LEAK TEST: no fixture file holds anything that looks real", () => {
  const hits = [];
  for (const f of walk(FIX)) {
    const rel = path.relative(FIX, f);
    const buf = fs.readFileSync(f);
    if (/\.(json|md|txt)$/i.test(f)) scanText(rel, buf.toString("utf8"), hits);
    else scanText(rel + " (bytes)", buf.toString("latin1"), hits);   // PDFs and pictures: metadata and uncompressed text
  }
  assert.deepStrictEqual(hits, []);
});

test("LEAK TEST: nothing in the materialized world looks real either (paths of this test's own folder aside)", () => {
  const hits = [];
  const baseRe = new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  for (const f of walk(base)) {
    if (/\.(png|pdf)$/i.test(f)) continue;
    let text = fs.readFileSync(f, "utf8");
    text = text.replace(/needsOwner/g, "needsOwner");   // the task-store schema's own field name (a key the app reads, never shown)
    text = text.replace(baseRe, "<base>").split(base.replace(/\\/g, "\\\\")).join("<base>");
    scanText(path.relative(base, f), text, hits);
  }
  assert.deepStrictEqual(hits, []);
});

test("LEAK TEST: the PDFs carry the fictional author and no real name in their text", () => {
  for (const f of walk(path.join(FIX, "reports"))) {
    const s = fs.readFileSync(f).toString("latin1");
    assert.ok(/Aurora Studio/.test(s), f + " should name the fictional studio in its metadata");
  }
});

test("cleanup", () => { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }); });
