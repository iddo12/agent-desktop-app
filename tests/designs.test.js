// node tests/designs.test.js - My Designs (v1.125.0): loader (validation, containment, type inference), filter logic, wiring. Temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const D = require("../src/designsData");
const F = require("../src/designsFilter");
const { createAppConfig } = require("../src/appConfig");
const features = require("../src/features");
let n = 0, fails = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addesigns-"));
const lib = path.join(tmp, "lib"); fs.mkdirSync(path.join(lib, "previews"), { recursive: true });
const outside = path.join(tmp, "outside.png"); fs.writeFileSync(outside, "x");
fs.writeFileSync(path.join(lib, "previews", "1.png"), "x"); fs.writeFileSync(path.join(lib, "previews", "2.mp4"), "x"); fs.writeFileSync(path.join(lib, "previews", "5.webp"), "x");
fs.writeFileSync(path.join(lib, "previews", "bad.exe"), "x");
const styles = [
  { id: 1, name: "Tag - FIRST LOOK", group: "Stills", kind: "text", tags: ["tag", "red"], preview: "previews/1.png", source: "S:\\a", status: "draft", palette: ["#111111", "#dc4056", "red", "#12"], reference: "https://example.com/x" },
  { id: 2, name: "Lower third", group: "Motion", kind: "bar", type: "motion", tags: ["lower"], preview: "previews/2.mp4", status: "approved", duration_s: 4 },
  { id: 3, name: "Escapes", group: "Motion", preview: "../outside.png" },
  { id: 4, name: "Exe", group: "Motion", preview: "previews/bad.exe" },
  { id: 5, name: "Webp still", group: "Stills", kind: "icon", tags: ["badge"], preview: "previews/5.webp", reference: "a note, not a link" },
  { id: 1, name: "Duplicate id" }, { id: "x", name: "Bad id" }, null,
];
fs.writeFileSync(path.join(lib, "styles.json"), "\uFEFF" + JSON.stringify({ schema: "lensvid.style_library", version: 1, next_id: 6, styles }));

t("load: valid entries, sorted, duplicate/bad ids dropped, BOM tolerated", () => {
  const r = D.load(lib);
  assert.ok(r.ok); assert.deepStrictEqual(r.items.map((e) => e.id), [1, 2, 3, 4, 5]);
});
t("types: missing type inferred from the preview (video/gif = motion, image = still); explicit type wins", () => {
  const by = Object.fromEntries(D.load(lib).items.map((e) => [e.id, e]));
  assert.strictEqual(by[1].type, "still"); assert.strictEqual(by[2].type, "motion"); assert.strictEqual(by[5].type, "still");
});
t("preview must be a known media file really inside the library", () => {
  const by = Object.fromEntries(D.load(lib).items.map((e) => [e.id, e]));
  assert.strictEqual(by[1].previewKind, "image"); assert.strictEqual(by[2].previewKind, "video");
  assert.strictEqual(by[3].previewKind, "none", ".. escape refused"); assert.strictEqual(by[4].previewKind, "none", "unknown extension refused");
  assert.ok(path.isAbsolute(by[1].previewFile));
});
t("palette keeps only valid hex colours; reference url detection; status default draft", () => {
  const by = Object.fromEntries(D.load(lib).items.map((e) => [e.id, e]));
  assert.deepStrictEqual(by[1].palette, ["#111111", "#dc4056"]);
  assert.ok(by[1].referenceIsUrl); assert.ok(!by[5].referenceIsUrl); assert.strictEqual(by[3].status, "draft"); assert.strictEqual(by[2].status, "approved");
});
t("load: needs-setup / missing / unreadable are reasons, never throws", () => {
  assert.strictEqual(D.load(null).reason, "needs-setup");
  assert.strictEqual(D.load(path.join(tmp, "nope")).reason, "missing");
  const bad = path.join(tmp, "bad"); fs.mkdirSync(bad); fs.writeFileSync(path.join(bad, "styles.json"), "{not json");
  assert.strictEqual(D.load(bad).reason, "unreadable");
  fs.writeFileSync(path.join(bad, "styles.json"), JSON.stringify({ styles: "x" }));
  assert.strictEqual(D.load(bad).reason, "unreadable");
  const empty = path.join(tmp, "empty"); fs.mkdirSync(empty); fs.writeFileSync(path.join(empty, "styles.json"), JSON.stringify({ styles: [] }));
  assert.deepStrictEqual(D.load(empty).items, []);
});
t("publicItem exposes the checked preview path and no internal fields", () => {
  const p = D.publicItem(D.load(lib).items[0]);
  assert.ok(p.preview && p.previewKind === "image" && !("previewFile" in p));
});
t("findById looks the entry up for the open-source / open-link handlers", () => {
  assert.strictEqual(D.findById(lib, 2).name, "Lower third"); assert.strictEqual(D.findById(lib, 99), null); assert.strictEqual(D.findById(null, 1), null);
});

const items = D.load(lib).items.map(D.publicItem);
t("filter: type, group, tag, status", () => {
  assert.deepStrictEqual(F.apply(items, { type: "motion" }).map((e) => e.id), [2]);
  assert.deepStrictEqual(F.apply(items, { type: "still" }).map((e) => e.id), [1, 3, 4, 5]);
  assert.deepStrictEqual(F.apply(items, { group: "Stills" }).map((e) => e.id), [1, 5]);
  assert.deepStrictEqual(F.apply(items, { tag: "badge" }).map((e) => e.id), [5]);
  assert.deepStrictEqual(F.apply(items, { status: "approved" }).map((e) => e.id), [2]);
  assert.strictEqual(F.apply(items, { type: "all", status: "all", group: "", tag: "" }).length, items.length);
});
t("filter: search words are ANDed, match name/tag/group, and #N or N finds the id", () => {
  assert.deepStrictEqual(F.apply(items, { q: "tag red" }).map((e) => e.id), [1]);
  assert.deepStrictEqual(F.apply(items, { q: "#5" }).map((e) => e.id), [5]);
  assert.deepStrictEqual(F.apply(items, { q: "LOWER" }).map((e) => e.id), [2]);
  assert.deepStrictEqual(F.apply(items, { q: "zzz" }), []);
  assert.deepStrictEqual(F.apply(items, null).length, items.length);
});
t("filter: a number matches the id exactly, not 158 / 580, and still matches text", () => {
  const L = [{ id: 58, name: "A" }, { id: 158, name: "B" }, { id: 580, name: "C" }, { id: 7, name: "Take 58 now" }];
  assert.deepStrictEqual(F.apply(L, { q: "#58" }).map((e) => e.id), [58]);
  assert.deepStrictEqual(F.apply(L, { q: "58" }).map((e) => e.id), [7, 58]);
  assert.deepStrictEqual(F.apply(L, { q: "158" }).map((e) => e.id), [158]);
});
t("sanitize: a removed group or tag resets to All after a reload, others stay", () => {
  const L = [{ id: 1, group: "G", tags: ["a"] }];
  assert.deepStrictEqual(F.sanitize(L, { type: "still", group: "Gone", tag: "a", q: "x" }), { type: "still", group: "", tag: "a", q: "x" });
  assert.strictEqual(F.sanitize(L, { group: "G", tag: "zz" }).tag, "");
  assert.strictEqual(F.sanitize([], { group: "G" }).group, "");
});
t("facets count distinct values A to Z; useText is the sentence agents get", () => {
  assert.deepStrictEqual(F.facets(items, "group"), [{ value: "Motion", count: 3 }, { value: "Stills", count: 2 }]);
  assert.deepStrictEqual(F.facets(items, "tags").map((x) => x.value), ["badge", "lower", "red", "tag"]);
  assert.strictEqual(F.useText(58), "use my design #58");
});
t("config: styleLibrary defaults under the workspace, feature designs needs-setup until the folder exists", () => {
  const ws = path.join(tmp, "ws"); fs.mkdirSync(ws);
  const ud = path.join(tmp, "ud"); fs.mkdirSync(ud);
  const c = createAppConfig({ userDataDir: ud, env: { AGENT_DESKTOP_WORKSPACE_ROOT: ws } }); c.setRegistry(features);
  assert.strictEqual(c.feature("designs").state, "needs-setup");
  fs.mkdirSync(path.join(ws, "shared_assets", "style_library"), { recursive: true });
  assert.strictEqual(c.feature("designs").state, "ready");
  assert.strictEqual(c.get("styleLibrary"), path.join(ws, "shared_assets", "style_library"));
});

// ---- partner (synced) designs: <lib>/<partner>/styles.json, ids "M-N" -> internal 100000+N
const plib = path.join(tmp, "plib"); fs.mkdirSync(path.join(plib, "previews"), { recursive: true }); fs.mkdirSync(path.join(plib, "partner", "previews"), { recursive: true });
fs.writeFileSync(path.join(plib, "previews", "1.png"), "x"); fs.writeFileSync(path.join(plib, "partner", "previews", "M-3.png"), "x");
fs.writeFileSync(path.join(plib, "styles.json"), JSON.stringify({ styles: [{ id: 1, name: "Mine", preview: "previews/1.png" }] }));
const mstyles = [
  { id: "M-3", origin: "partner", name: "Pastel title", group: "Titles", type: "still", palette: ["#fff"], reference: "https://e.com/p", notes: "n", status: "approved", preview: "partner/previews/M-3.png" },
  { id: "M-7", name: "Escapee", preview: "../outside.png" }, { id: "M-x", name: "Bad" }, { id: 5, name: "Int id" }, { id: "M-0", name: "zero" }, { id: "M-123456", name: "too long" }, { id: "M-3", name: "dup" }, null,
];
fs.writeFileSync(path.join(plib, "partner", "styles.json"), JSON.stringify({ schema: "lensvid.style_library.partner", styles: mstyles }));
t("partner: list merges after the own list, ids M-N -> 100000+N, bad ids/dup ignored, preview escape refused", () => {
  const r = D.load(plib); assert.ok(r.ok);
  assert.deepStrictEqual(r.items.map((e) => e.id), [1, 100003, 100007]);
  const by = Object.fromEntries(r.items.map((e) => [e.id, e]));
  assert.strictEqual(by[1].label, "#1"); assert.strictEqual(by[1].origin, "");
  assert.strictEqual(by[100003].label, "M-3"); assert.strictEqual(by[100003].origin, "partner"); assert.strictEqual(by[100003].previewKind, "image"); assert.ok(path.isAbsolute(by[100003].previewFile));
  assert.strictEqual(by[100007].previewKind, "none", ".. escape refused"); assert.strictEqual(by[100003].status, "approved");
  assert.strictEqual(D.publicItem(by[100003]).label, "M-3"); assert.strictEqual(D.publicItem(by[100003]).origin, "partner");
  assert.strictEqual(D.findById(plib, 100003).name, "Pastel title");
});
t("partner: missing, bad or oversize partner file leaves the main list intact", () => {
  const mf = path.join(plib, "partner", "styles.json"), keep = fs.readFileSync(mf);
  fs.writeFileSync(mf, "{not json"); assert.deepStrictEqual(D.load(plib).items.map((e) => e.id), [1]);
  fs.writeFileSync(mf, JSON.stringify({ styles: "x" })); assert.deepStrictEqual(D.load(plib).items.map((e) => e.id), [1]);
  fs.rmSync(mf); assert.deepStrictEqual(D.load(plib).items.map((e) => e.id), [1]);
  assert.deepStrictEqual(D.load(lib).items.map((e) => e.id), [1, 2, 3, 4, 5], "no partner folder at all");
  fs.writeFileSync(mf, keep);
});
t("partner: useText, search by M-3 / m3 / partner, own #N unaffected", () => {
  const L = D.load(plib).items.map(D.publicItem);
  assert.strictEqual(F.useText(L[1], "Pat"), "use Pat's design M-3"); assert.strictEqual(F.useText(L[1]), "use partner's design M-3");
  assert.strictEqual(F.useText(L[0]), "use my design #1"); assert.strictEqual(F.useText(1), "use my design #1");
  assert.deepStrictEqual(F.apply(L, { q: "partner" }).map((e) => e.id), [100003, 100007], "origin word finds all partner designs");
  for (const q of ["M-3", "m3", "m-3 pastel"]) assert.deepStrictEqual(F.apply(L, { q }).map((e) => e.id), [100003], q);
  assert.deepStrictEqual(F.apply(L, { q: "#1" }).map((e) => e.id), [1]); assert.deepStrictEqual(F.apply(L, { q: "m4" }), []);
  assert.deepStrictEqual(F.apply(L, { q: "#3" }), [], "#3 is own design 3 only");
});
const M = require("../src/designsMain");
t("sync: output becomes the status line (counts, partner name, problems, unknown output)", () => {
  const out = "push: 3 file(s) updated in X\npull: 5 design(s) from Y (2 new)\n";
  assert.strictEqual(M.parseSync(out, "Pat").summary, "Synced: 3 pushed, 2 new from Pat");
  assert.strictEqual(M.parseSync(out).summary, "Synced: 3 pushed, 2 new from the other side");
  assert.strictEqual(M.parseSync("push: 0 file(s) updated in X\npull: 0 design(s) from Y (0 new); problems: a.json bad").summary, "Synced: 0 pushed, 0 new from the other side (problems: a.json bad)");
  assert.strictEqual(M.parseSync("hello").summary, "Sync finished."); assert.strictEqual(M.parseSync(null).lines.length, 0);
  assert.strictEqual(M.parseSync(Array.from({ length: 20 }, (_, i) => "l" + i).join("\n")).lines.length, 6);
});
t("sync: script and python come from the configuration; missing either = not available (button hidden)", () => {
  const cfg = (o) => ({ get: (k) => (o[k] === undefined ? null : o[k]) });
  const plan = M.syncPlan(cfg({ sharedTools: path.join(tmp, "st"), pythonExe: "py.exe" }), () => true);
  assert.deepStrictEqual(plan, { python: "py.exe", script: path.join(tmp, "st", "style_library", "sync_designs_with_partner.py") });
  assert.strictEqual(M.syncPlan(cfg({ sharedTools: path.join(tmp, "st"), pythonExe: "py.exe" })), null, "script not on disk");
  assert.strictEqual(M.syncPlan(cfg({ sharedTools: path.join(tmp, "st") }), () => true), null, "no python");
  assert.strictEqual(M.syncPlan(cfg({ pythonExe: "py.exe" }), () => true), null, "no shared tools folder");
  assert.strictEqual(M.syncPlan({ get() { throw new Error("x"); } }, () => true), null);
});
const pending = [];
const ta = (name, fn) => { n++; pending.push(fn().then(() => console.log("ok   " + name), (e) => { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); })); };
ta("sync: handler refuses when unavailable, runs execFile without a shell, ignores a second click while running", async () => {
  const handlers = {};
  const ipcMain = { handle: (c, f) => { handlers[c] = f; } };
  const win = { webContents: { mainFrame: {} }, isDestroyed: () => false };
  const ev = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const st = path.join(tmp, "st2"); fs.mkdirSync(path.join(st, "style_library"), { recursive: true });
  const script = path.join(st, "style_library", "sync_designs_with_partner.py"); fs.writeFileSync(script, "#");
  const calls = []; let done;
  const mk = (cfgVals, ef) => { for (const k in handlers) delete handlers[k]; M.init({ ipcMain, getMainWindow: () => win, cfg: { get: (k) => cfgVals[k] || null, isReady: () => true }, execFile: ef }); };
  mk({ sharedTools: path.join(tmp, "none"), pythonExe: process.execPath, styleLibrary: lib }, () => assert.fail("must not run"));
  assert.deepStrictEqual(await handlers["designs-sync"](ev), { ok: false, reason: "not-available" });
  mk({ sharedTools: st, pythonExe: process.execPath, styleLibrary: lib, partnerName: "Pat" }, (exe, args, o, cb) => { calls.push({ exe, args, o }); done = cb; });
  const first = handlers["designs-sync"](ev);
  assert.deepStrictEqual(await handlers["designs-sync"](ev), { ok: false, reason: "busy" });
  done(null, "push: 1 file(s) updated in X\npull: 1 design(s) from Y (1 new)\n");
  const r = await first;
  assert.ok(r.ok && r.summary === "Synced: 1 pushed, 1 new from Pat" && r.lines.length === 2);
  assert.strictEqual(calls.length, 1); assert.deepStrictEqual(calls[0].args, [script, "sync"]);
  assert.ok(calls[0].o.shell === false && calls[0].o.windowsHide === true && calls[0].o.timeout === 120000 && calls[0].o.maxBuffer > 0);
  const second = handlers["designs-sync"](ev); done(Object.assign(new Error("x"), { killed: true }), "");
  assert.deepStrictEqual(await second, { ok: false, reason: "Sync timed out." });
  const third = handlers["designs-sync"](ev); done(Object.assign(new Error("x"), { code: 1 }), "");
  assert.deepStrictEqual(await third, { ok: false, reason: "Sync failed." }, "busy flag released after failure");
  assert.deepStrictEqual(await handlers["designs-sync"]({ sender: {} }), { ok: false, reason: "Not allowed." }, "other senders refused");
});
t("wiring: nav lazy-loads, no polling, view manager + preload + html know My Designs", () => {
  const R = (...p) => fs.readFileSync(path.join(__dirname, "..", "src", ...p), "utf8");
  const html = R("renderer", "index.html"), nav = R("renderer", "designs-nav.js"), view = R("renderer", "designs.js");
  assert.ok(html.includes("designs-nav.js") && html.includes("styles-designs-nav.css") && !/"designs\.js"/.test(html) && !html.includes("styles-designs.css"));
  assert.ok(R("renderer", "viewmanager.js").includes("designs-open") && R("preload.js").includes("designs-load") && R("main.js").includes("designsMain"));
  assert.ok(!/setInterval|setTimeout\(.*poll/i.test(view) && !/setInterval/.test(nav));
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(view), "textContent only");
});
t("no hard-coded drive letters or personal names in the new files", () => {
  for (const f of ["designsData.js", "designsFilter.js", "designsMain.js", "renderer/designs.js", "renderer/designs-nav.js", "renderer/styles-designs.css"]) {
    const s = fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8").replace(/PARTNER_KEY = "partner"/, "");   // the shared tool's file name and the one folder-name constant are the only allowed mentions
    assert.ok(!/\b[A-Z]:\\\\/.test(s) && !/Dropbox|Iddo|Merav/i.test(s), f);
  }
});

// ---- Transitions + Effects tabs (v1.155.8): explicit type kept, kind passed through, filter by tab
const lib2 = path.join(tmp, "lib2"); fs.mkdirSync(path.join(lib2, "previews"), { recursive: true });
for (const f of ["70.mp4", "71.mp4", "72.mp4", "90.mp4", "91.mp4"]) fs.writeFileSync(path.join(lib2, "previews", f), "x");
fs.writeFileSync(path.join(lib2, "styles.json"), JSON.stringify({ styles: [
  { id: 70, name: "Whip", type: "transition", kind: "two-clip", preview: "previews/70.mp4" },
  { id: 71, name: "Fade in", type: "transition", kind: "one-clip", preview: "previews/71.mp4" },
  { id: 72, name: "Plain", preview: "previews/72.mp4" },
  { id: 90, name: "Glitch", type: "effect", preview: "previews/90.mp4" },
  { id: 91, name: "Glow", type: "effect", preview: "previews/91.mp4" },
] }));
t("transition/effect: explicit type is kept (not turned into motion), kind passes through, untyped video stays motion", () => {
  const by = Object.fromEntries(D.load(lib2).items.map((e) => [e.id, e]));
  assert.strictEqual(by[70].type, "transition"); assert.strictEqual(by[70].kind, "two-clip"); assert.strictEqual(by[71].kind, "one-clip");
  assert.strictEqual(by[90].type, "effect"); assert.strictEqual(by[72].type, "motion");
});
t("transition/effect: the Transitions and Effects tabs filter by type", () => {
  const L = D.load(lib2).items.map(D.publicItem);
  assert.deepStrictEqual(F.apply(L, { type: "transition" }).map((e) => e.id), [70, 71]);
  assert.deepStrictEqual(F.apply(L, { type: "effect" }).map((e) => e.id), [90, 91]);
  assert.deepStrictEqual(F.apply(L, { type: "motion" }).map((e) => e.id), [72]);
});
t("transition/effect: renderer has both tabs and the clip badge", () => {
  const view = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "designs.js"), "utf8");
  assert.ok(view.includes('["transition", "Transitions"]') && view.includes('["effect", "Effects"]') && view.includes("TWO CLIPS") && view.includes("ONE CLIP"));
});

Promise.all(pending).then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
});
