// node tests/research-badge.test.js - My Research unread badge + picture order own-image -> Graphics art -> letter card (v1.107.0). No gating.
// Pure rules (src/research/unread.js), the art finder (src/research/art.js) and the IPC wiring (main-research.js + service.js flags).
// Writes only into temp folders.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const U = require("../src/research/unread");
const A = require("../src/research/art");
const MR = require("../src/research/main-research");

let n = 0, fails = 0; const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "research-badge-"));
const H = 3600 * 1000, T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const it = (week, agent, id) => ({ week, agent, id });
const W41 = [it("2026-W41", "Security", "s1"), it("2026-W41", "Security", "s2"), it("2026-W41", "News Agent", "n1")];

t("first evaluation grandfathers everything as read: badge 0 (not N); a second call changes nothing", () => {
  const r = U.evaluate({ items: W41, state: {}, now: T0 });
  assert.strictEqual(r.count, 0); assert.strictEqual(r.state.gatingStart, T0); assert.strictEqual(r.state.seen.length, 3); assert.ok(r.changed);
  const again = U.evaluate({ items: W41, state: r.state, now: T0 + H });
  assert.strictEqual(again.changed, false); assert.strictEqual(again.count, 0);
});
t("an empty first listing does not start the clock (a folder that could not be read must not turn the backlog into 'new')", () => {
  const r = U.evaluate({ items: [], state: {}, now: T0 });
  assert.strictEqual(r.state.gatingStart, null); assert.strictEqual(r.changed, false);
  assert.strictEqual(U.evaluate({ items: W41, state: r.state, now: T0 + H }).count, 0, "the later full listing is still grandfathered");
});
t("every finding that appears after the update counts as unread at once (no gating, nothing waits for a picture)", () => {
  const s0 = U.evaluate({ items: W41, state: {}, now: T0 }).state;
  const items = W41.concat([it("2026-W42", "Security", "s9"), it("2026-W42", "News Agent", "n9"), it("2026-W41", "Security", "late")]);
  const r = U.evaluate({ items, state: s0, now: T0 + H });
  assert.strictEqual(r.count, 3); assert.ok(r.unread.has(U.keyOf("2026-W42", "Security", "s9"))); assert.ok(r.unread.has(U.keyOf("2026-W41", "Security", "late")));
  assert.strictEqual(r.changed, false, "no state change: unread is derived from seen");
});
t("markSeen: only findings that exist are accepted; the badge goes down; garbage is ignored; the same key twice counts once", () => {
  const s0 = U.evaluate({ items: W41, state: {}, now: T0 }).state;
  const items = W41.concat([it("2026-W42", "Security", "s9"), it("2026-W42", "Security", "s8")]);
  const existing = new Set(items.map((x) => U.keyOf(x.week, x.agent, x.id)));
  const k = U.keyOf("2026-W42", "Security", "s9");
  const m = U.markSeen(s0, [k, k, U.keyOf("2026-W42", "Ghost", "zz"), "junk", 42, null, "2026-W42|x|"], existing);
  assert.strictEqual(m.added, 1);
  assert.strictEqual(U.evaluate({ items, state: m.state, now: T0 + 2 * H }).count, 1, "s8 is still unread");
  assert.strictEqual(m.state.gatingStart, T0, "marking keeps gatingStart");
});
t("cleanState: wrong types dropped, list de-duplicated and bounded, newest kept", () => {
  const k = U.keyOf("2026-W41", "a", "x");
  const c = U.cleanState({ gatingStart: "x", seen: [k, k, 5, "bad"] });
  assert.strictEqual(c.gatingStart, null); assert.deepStrictEqual(c.seen, [k]);
  assert.deepStrictEqual(U.cleanState(null), { gatingStart: null, seen: [] });
  assert.deepStrictEqual(U.cleanState([1, 2]).seen, []); assert.deepStrictEqual(U.cleanState({ seen: "no" }).seen, []);
  const big = Array.from({ length: U.MAX_SEEN + 50 }, (_, i) => U.keyOf("2026-W41", "a", "id" + i));
  const c2 = U.cleanState({ seen: big }); assert.strictEqual(c2.seen.length, U.MAX_SEEN); assert.strictEqual(c2.seen[c2.seen.length - 1], big[big.length - 1]);
});
t("slug and manifest keys: lower case, non-alphanumerics become one dash; both manifest shapes parse; junk entries are skipped", () => {
  assert.strictEqual(U.slugOf("Security & Infrastructure Agent"), "security-infrastructure-agent");
  assert.strictEqual(U.slugOf("Acmeco  Business_Context"), "acmeco-business-context");
  const m = U.manifestIndex({ "News Agent/n1": { image: "C:\\a.png", label: "x" }, "Security/s1": "C:\\b.png", "nokey": { image: "z" }, "A/b": { label: "no image" }, "A/c": 5 });
  assert.strictEqual(m.get(U.manifestKey("news agent", "N1")), "C:\\a.png"); assert.strictEqual(m.get("security/s1"), "C:\\b.png"); assert.strictEqual(m.size, 2);
  assert.strictEqual(U.manifestIndex({ items: { "A/b": { image: "x.png" } } }).size, 1, "a wrapper object is tolerated");
  for (const bad of [null, [], "x", 5]) assert.strictEqual(U.manifestIndex(bad).size, 0);
});

// ------------------------------------------------------------------ the art finder
function artWorld() {
  const shared = tmp(), graphics = tmp(), outside = tmp();
  const put = (f, bytes) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes || Buffer.from("PNGDATA")); fs.utimesSync(f, new Date(Date.now() - 60000), new Date(Date.now() - 60000)); return f; };
  const art = A.createArt({ sharedDir: shared, graphicsDir: graphics, allowedRoots: [shared, graphics] });
  return { shared, graphics, outside, put, art };
}
t("art: the PNG file in the agent-slug folder counts; a missing, empty or too-young (<5 s) file does not", () => {
  const w = artWorld();
  assert.strictEqual(w.art.has("2026-W42", "News Agent", "n1"), false);
  const f = w.put(path.join(w.shared, "2026-W42", "news-agent", "n1.png")); assert.strictEqual(w.art.find("2026-W42", "News Agent", "n1"), path.resolve(f));
  w.put(path.join(w.shared, "2026-W42", "news-agent", "empty.png"), Buffer.alloc(0)); assert.strictEqual(w.art.has("2026-W42", "News Agent", "empty"), false);
  const young = path.join(w.shared, "2026-W42", "news-agent", "young.png"); fs.writeFileSync(young, "x"); assert.strictEqual(w.art.has("2026-W42", "News Agent", "young"), false, "still being written");
  assert.strictEqual(A.SETTLE_MS, 5000);
});
t("art: shared manifest first, then the file, then the Graphics Agent manifest; a corrupt or missing manifest finds nothing and never throws", () => {
  const w = artWorld();
  const a = w.put(path.join(w.shared, "imgs", "a.png")), g = w.put(path.join(w.graphics, "2026-W42", "g.png"));
  fs.mkdirSync(path.join(w.shared, "2026-W42"), { recursive: true });
  fs.writeFileSync(path.join(w.shared, "2026-W42", "manifest.json"), JSON.stringify({ "Security/s1": { image: a, label: "x" } }));
  fs.writeFileSync(path.join(w.graphics, "2026-W42", "manifest.json"), "\uFEFF" + JSON.stringify({ "Legal/l1": { image: g }, "Security/s1": { image: g } }));
  assert.strictEqual(w.art.find("2026-W42", "Security", "s1"), path.resolve(a), "shared manifest wins over the Graphics Agent one");
  assert.strictEqual(w.art.find("2026-W42", "Legal", "l1"), path.resolve(g), "Graphics Agent manifest is the third source (BOM tolerated)");
  fs.writeFileSync(path.join(w.shared, "2026-W42", "manifest.json"), "{ corrupt");
  assert.strictEqual(w.art.find("2026-W42", "Security", "s1"), path.resolve(g), "corrupt shared manifest: falls through");
  assert.strictEqual(w.art.has("2026-W43", "Security", "s1"), false, "no manifest at all");
});
t("art: a manifest cannot point outside the allowed folders, at a non-image, or at a directory; odd ids/weeks are refused", () => {
  const w = artWorld();
  const out = w.put(path.join(w.outside, "secret.png")), txt = w.put(path.join(w.shared, "x.txt"));
  fs.mkdirSync(path.join(w.shared, "2026-W42", "dir.png"), { recursive: true });
  fs.writeFileSync(path.join(w.shared, "2026-W42", "manifest.json"), JSON.stringify({ "A/out": { image: out }, "A/txt": { image: txt }, "A/dir": { image: path.join(w.shared, "2026-W42", "dir.png") }, "A/rel": { image: "..\\..\\x.png" } }));
  for (const id of ["out", "txt", "dir", "rel"]) assert.strictEqual(w.art.has("2026-W42", "A", id), false, id);
  assert.strictEqual(w.art.has("2026-W42", "A", "..\\..\\x"), false); assert.strictEqual(w.art.has("../..", "A", "x"), false); assert.strictEqual(w.art.has("2026-W42", "", "x"), false); assert.strictEqual(w.art.has("2026-W42", "A", ".."), false);
});

// ------------------------------------------------------------------ IPC wiring
const FX = path.join(__dirname, "fixtures", "research");
function world() {
  const handlers = {}, wc = { mainFrame: {} }, win = { webContents: wc, isDestroyed: () => false };
  const d = tmp(), ud = tmp(), shared = tmp(), graphics = tmp();
  fs.cpSync(FX, d, { recursive: true });
  const clock = { t: T0 };
  MR.init({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, getMainWindow: () => win, workspaceRoot: path.join(d, "ws"), userData: ud, testMode: true, log: () => {}, now: () => clock.t,
    env: { AGENT_DESKTOP_RESEARCH_DIR: d, AGENT_DESKTOP_RESEARCH_ART_DIR: shared, AGENT_DESKTOP_RESEARCH_ART_GRAPHICS_DIR: graphics }, openExternal: () => {} });
  const good = { sender: wc, senderFrame: wc.mainFrame };
  const call = (c, a) => handlers[c](good, a);
  const addWeek = (week, agent, ids, withSource) => { fs.mkdirSync(path.join(d, week), { recursive: true }); fs.writeFileSync(path.join(d, week, agent + ".json"), JSON.stringify({ agent, week, summary: "s", findings: ids.map((id) => ({ id, title: "Title " + id, tier: "normal", soWhat: "so what " + id, sources: withSource ? [{ title: "t", url: withSource }] : [] })) })); };
  const art = (week, agent, id) => { const f = path.join(shared, week, U.slugOf(agent), id + ".png"); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "PNG"); fs.utimesSync(f, new Date(clock.t - 60000), new Date(clock.t - 60000)); };
  const titles = (r) => r.digests.flatMap((x) => x.findings.map((f) => f.title));
  return { handlers, good, call, d, ud, shared, graphics, clock, addWeek, art, titles, prefs: () => JSON.parse(fs.readFileSync(path.join(ud, "research_prefs.json"), "utf8")) };
}
t("ipc: first call grandfathers the existing W41 findings as read (badge 0, none flagged unread); prefs file is plain JSON without a BOM", async () => {
  const w = world();
  const b = await w.call("research-badge"); assert.deepStrictEqual([b.ok, b.count], [true, 0]);
  const r = await w.call("research-load", {}); assert.strictEqual(r.unreadCount, 0); assert.ok(!("waiting" in r));
  assert.ok(r.digests.some((x) => x.findings.length)); assert.ok(r.digests.every((x) => x.findings.every((f) => !f.unread)));
  const raw = fs.readFileSync(path.join(w.ud, "research_prefs.json")); assert.notStrictEqual(raw[0], 0xEF); assert.ok(w.prefs().gatingStart);
  assert.deepStrictEqual(fs.readdirSync(w.ud).filter((x) => /\.tmp$/.test(x)), [], "atomic write leaves no temp file");
});
t("ipc: a new week is shown at once WITHOUT any picture, flagged unread and counted in the badge; W41 is unchanged", async () => {
  const w = world(); const n41 = w.titles(await w.call("research-load", {})).length;
  w.addWeek("2026-W42", "Alpha Agent", ["x1", "x2"]); w.addWeek("2026-W42", "News Agent", ["y1"]);
  fs.writeFileSync(path.join(w.d, "2026-W42", "_top5.json"), JSON.stringify({ week: "2026-W42", picked_by: "COO", picks: [{ agent: "Alpha Agent", finding: "Title x1", why: "w" }] }));
  w.clock.t += H;
  assert.strictEqual((await w.call("research-badge")).count, 3);
  const r = await w.call("research-load", { week: "2026-W42" });
  assert.deepStrictEqual(w.titles(r).sort(), ["Title x1", "Title x2", "Title y1"]); assert.ok(r.digests.every((x) => x.findings.every((f) => f.unread === true)));
  assert.strictEqual(r.top5.picks[0].finding.unread, true, "the five show it too"); assert.strictEqual(r.unreadCount, 3);
  assert.strictEqual(w.titles(await w.call("research-load", { week: "2026-W41" })).length, n41); assert.strictEqual((await w.call("research-load", { week: "2026-W41" })).unreadCount, 3);
});
t("ipc: reading marks seen (existing findings only), the badge drops; 'mark all' zeroes it; load stops flagging them", async () => {
  const w = world(); await w.call("research-badge");
  w.addWeek("2026-W42", "Alpha Agent", ["x1", "x2", "x3"]); w.clock.t += H;
  assert.strictEqual((await w.call("research-badge")).count, 3);
  const s = await w.call("research-seen", { items: [{ week: "2026-W42", agent: "Alpha Agent", findingId: "x1" }, { week: "2026-W42", agent: "Alpha Agent", findingId: "ghost" }, { week: "bad", agent: "a", findingId: "z" }] });
  assert.deepStrictEqual([s.ok, s.count], [true, 2], "a finding that does not exist cannot be marked; junk ignored");
  assert.strictEqual((await w.call("research-seen", { items: "no" })).ok, false); assert.strictEqual((await w.call("research-seen", {})).ok, false);
  let r = await w.call("research-load", { week: "2026-W42" }); assert.deepStrictEqual(r.digests[0].findings.map((f) => !!f.unread), [false, true, true]);
  const all = await w.call("research-seen-all"); assert.deepStrictEqual([all.ok, all.count], [true, 0]);
  r = await w.call("research-load", { week: "2026-W42" }); assert.strictEqual(r.digests[0].findings.some((f) => f.unread), false);
  assert.strictEqual(w.prefs().seen.length > 3, true);
});
t("ipc: picture order - the article's own image first, then Graphics' art (local file URL from the fixed folder), then nothing", async () => {
  const w = world();
  w.addWeek("2026-W42", "Alpha Agent", ["a1"], "https://unmapped.example.net/story");   // a host the image fixtures do not know: no own image
  const q = { week: "2026-W42", agent: "Alpha Agent", findingId: "a1" };
  assert.strictEqual((await w.call("research-image", q)).ok, false, "no own image, no art: the letter card");
  w.art("2026-W42", "Alpha Agent", "a1");
  const img = await w.call("research-image", q);
  assert.strictEqual(img.ok, true); assert.strictEqual(img.art, true); assert.match(img.url, /^file:\/\//);
  assert.ok(decodeURIComponent(img.url).replace(/\\/g, "/").toLowerCase().indexOf(w.shared.replace(/\\/g, "/").toLowerCase()) >= 0);
  w.addWeek("2026-W42", "News Agent", ["ns"]); w.art("2026-W42", "News Agent", "ns");
  assert.strictEqual((await w.call("research-image", { week: "2026-W42", agent: "News Agent", findingId: "ns" })).art, true, "a finding with no source link still gets its art");
  assert.strictEqual((await w.call("research-image", { week: "2026-W42", agent: "News Agent", findingId: "nope" })).ok, false);
});
t("ipc: the article's own image wins over art when it resolves (fixture host)", async () => {
  const w = world(); w.clock.t += H;
  const fxDir = path.join(__dirname, "fixtures", "research-img"); const map = JSON.parse(fs.readFileSync(path.join(fxDir, "fixtures.json"), "utf8")); const host = Object.keys(map)[0];
  assert.ok(host, "the image fixtures define a host");
  w.addWeek("2026-W42", "Alpha Agent", ["own"], "https://" + host + "/story"); w.art("2026-W42", "Alpha Agent", "own");
  const img = await w.call("research-image", { week: "2026-W42", agent: "Alpha Agent", findingId: "own" });
  assert.strictEqual(img.ok, true); assert.notStrictEqual(img.art, true, "own image first"); assert.strictEqual(img.how, "fixture");
});
t("ipc: a corrupt or hostile prefs file fails open and other prefs survive the new keys", async () => {
  const w = world(); await w.call("research-badge");
  await w.call("research-prefs-set", { legendOpen: false });
  const p = w.prefs(); assert.strictEqual(p.legendOpen, false); assert.ok(p.gatingStart && Array.isArray(p.seen), "setPrefs keeps the badge state");
  fs.writeFileSync(path.join(w.ud, "research_prefs.json"), JSON.stringify({ legendOpen: true, seen: [1, {}, "x"] }));
  const r = await w.call("research-load", { week: "2026-W41" }); assert.strictEqual(r.ok, true); assert.ok(w.titles(r).length > 0);
  fs.writeFileSync(path.join(w.ud, "research_prefs.json"), "{ corrupt");
  assert.strictEqual((await w.call("research-badge")).ok, true);
});
t("renderer wiring (static): badge span in the nav, listener, Mark all as read, waiting note, art alt; nav keeps its single startup role", () => {
  const SRC = path.join(__dirname, "..", "src");
  const nav = fs.readFileSync(path.join(SRC, "renderer", "research-nav.js"), "utf8"), v = fs.readFileSync(path.join(SRC, "renderer", "research.js"), "utf8");
  assert.match(nav, /research-nav-badge blue hidden/); assert.match(nav, /addEventListener\("research-badge"/); assert.match(nav, /api\.research\.badge/);
  assert.match(v, /Mark all as read/); assert.ok(!/waiting for art/.test(v), "no gating note"); assert.match(v, /api\.seen\(/); assert.match(v, /api\.seenAll\(/); assert.match(v, /threshold: 0\.6/);
  assert.match(fs.readFileSync(path.join(SRC, "preload.js"), "utf8"), /"research-seen-all"/);
  const lp = fs.readFileSync(path.join(SRC, "renderer", "styles-leftpane.css"), "utf8");
  assert.strictEqual((lp.match(/research-nav-badge/g) || []).length, 4, "badge positioned like My Daily's in the card, tile and strip layouts + the adaptive-tile wrap rule (v1.119.6)");
});

(async () => {
  for (const q of queue) {
    n++;
    try { await q.fn(); console.log("ok  " + q.name); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n  ") : e)); }
  }
  console.log(fails ? fails + " of " + n + " FAILED" : "research-badge: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
