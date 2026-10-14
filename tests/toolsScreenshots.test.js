// node tests/toolsScreenshots.test.js - Tools screenshots (v1.85.0): entry validation, path safety, image header limits, stale tag,
// thumbnail cache (once, negative cache, per-call cap), service wiring.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const sh = require("../src/tools/shots");
const schema = require("../src/tools/schema");
const SV = require("../src/tools/service");

function png(w, h) {                      // signature + IHDR header (+ padding): enough for the header reader, not a decodable image
  const b = Buffer.alloc(64, 0); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b;
}
function jpg(w, h) {                      // SOI, an APP0 segment, SOF0
  const b = Buffer.alloc(64, 0); let p = 0;
  b[p++] = 0xff; b[p++] = 0xd8; b[p++] = 0xff; b[p++] = 0xe0; b.writeUInt16BE(16, p); p += 16;
  b[p++] = 0xff; b[p++] = 0xc0; b.writeUInt16BE(17, p); p += 2; b[p++] = 8; b.writeUInt16BE(h, p); p += 2; b.writeUInt16BE(w, p); return b;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adshots-"));
const cat = path.join(tmp, "cat"), ud = path.join(tmp, "ud");
const folder = path.join(cat, "screenshots", "t1");
fs.mkdirSync(folder, { recursive: true }); fs.mkdirSync(ud, { recursive: true });
fs.writeFileSync(path.join(folder, "01.png"), png(1280, 800));
fs.writeFileSync(path.join(folder, "02.JPG"), jpg(1280, 800));
fs.writeFileSync(path.join(folder, "notes.txt"), png(10, 10));
fs.writeFileSync(path.join(folder, "pic.webp"), png(10, 10));
fs.writeFileSync(path.join(folder, "big.png"), Buffer.concat([png(10, 10), Buffer.alloc(sh.MAX_BYTES)]));
fs.writeFileSync(path.join(folder, "bomb.png"), png(30000, 30000));
fs.writeFileSync(path.join(folder, "wide.png"), png(9000, 100));
fs.writeFileSync(path.join(folder, "mega.png"), png(7000, 7000));       // inside the side cap, over 40 gadgetrys
fs.writeFileSync(path.join(folder, "junk.png"), Buffer.alloc(100, 7));  // not an image
fs.writeFileSync(path.join(cat, "outside.png"), png(10, 10));
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error("FAIL " + name + ": " + (e && e.stack || e)); process.exitCode = 1; } };
const entry = (file, extra) => Object.assign({ file, caption: "A", taken: "2026-10-08" }, extra);

t("header reader", () => {
  assert.deepStrictEqual(sh.readDims(path.join(folder, "01.png")), { w: 1280, h: 800 });
  assert.deepStrictEqual(sh.readDims(path.join(folder, "02.JPG")), { w: 1280, h: 800 });
  assert.strictEqual(sh.readDims(path.join(folder, "junk.png")), null);
  assert.strictEqual(sh.readDims(path.join(folder, "nope.png")), null);
});
t("file name rules", () => {
  const ok = (f) => sh.checkFile(cat, "t1", f);
  assert.strictEqual(ok("01.png").ok, true);
  assert.strictEqual(ok("02.JPG").ok, true);
  for (const bad of ["../outside.png", "..\\outside.png", "sub/01.png", "C:\\x.png", "\\\\srv\\share\\a.png", "/etc/a.png", "", null, 5, ".png", "a..b.png"]) assert.strictEqual(ok(bad).ok, false, String(bad));
  assert.strictEqual(ok("notes.txt").code, "bad-extension");
  assert.strictEqual(ok("pic.webp").code, "bad-extension");          // webp is no longer allowed
  assert.strictEqual(ok("big.png").code, "too-big");
  assert.strictEqual(ok("nope.png").code, "missing");
  assert.strictEqual(sh.checkFile(cat, "t1", "..").ok, false);
});
t("windows device names refused", () => {
  for (const f of ["con.png", "CON.png", "nul.jpg", "prn.png", "aux.png", "com1.png", "COM9.jpeg", "lpt3.png", "con", "nul.tar.png", "com0.png"]) assert.strictEqual(sh.checkFile(cat, "t1", f).code, "bad-file-name", f);
  assert.notStrictEqual(sh.checkFile(cat, "t1", "console.png").code, "bad-file-name");     // only the exact device names
});
t("dimension bomb refused before any decode", () => {
  assert.strictEqual(sh.checkFile(cat, "t1", "bomb.png").code, "too-large");
  assert.strictEqual(sh.checkFile(cat, "t1", "wide.png").code, "too-large");
  assert.strictEqual(sh.checkFile(cat, "t1", "mega.png").code, "too-large");
  assert.strictEqual(sh.checkFile(cat, "t1", "junk.png").code, "bad-image");
  // and ensureThumb itself refuses even if called directly: nativeImage must never be asked to decode it
  let decoded = 0;
  const ni = { createFromPath: () => { decoded++; return { isEmpty: () => true }; } };
  const bomb = { abs: path.join(folder, "bomb.png"), size: 64, mtimeMs: 1 };
  assert.strictEqual(sh.ensureThumb(bomb, path.join(ud, "b"), ni), ""); assert.strictEqual(decoded, 0);
});
t("resolve keeps valid, reports invalid by code", () => {
  const r = sh.resolveShots(cat, "t1", [entry("01.png"), entry("../outside.png"), entry("02.JPG", { caption: "" }), entry("02.JPG", { taken: "2026-13" }), entry("02.JPG", { caption: "D", taken: "2026-09-01" })]);
  assert.deepStrictEqual(r.shots.map((s) => s.caption), ["A", "D"]);
  assert.deepStrictEqual(r.rejected.map((x) => x.code), ["bad-file-name", "bad-caption", "bad-date"]);
});
t("real calendar dates only", () => {
  for (const d of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-1-1", "", null, 20261008]) assert.strictEqual(sh.isRealDate(d), false, String(d));
  for (const d of ["2026-10-08", "2028-02-29"]) assert.strictEqual(sh.isRealDate(d), true, d);
  assert.strictEqual(sh.resolveShots(cat, "t1", [entry("01.png", { taken: "2026-02-30" })]).rejected[0].code, "bad-date");
});
t("duplicate file entries dropped", () => {
  const r = sh.resolveShots(cat, "t1", [entry("01.png"), entry("01.png", { caption: "again" }), entry("01.PNG", { caption: "case" })]);
  assert.strictEqual(r.shots.length, 1); assert.deepStrictEqual(r.rejected.map((x) => x.code), ["duplicate", "duplicate"]);
});
t("max six shots", () => {
  const raw = []; for (let i = 0; i < 4; i++) { fs.writeFileSync(path.join(folder, "s" + i + ".png"), png(100, 100)); }
  const names = ["01.png", "02.JPG", "s0.png", "s1.png", "s2.png", "s3.png", "01x.png", "02x.png"];
  fs.writeFileSync(path.join(folder, "01x.png"), png(100, 100)); fs.writeFileSync(path.join(folder, "02x.png"), png(100, 100));
  names.forEach((f, i) => raw.push(entry(f, { caption: "c" + i })));
  const r = sh.resolveShots(cat, "t1", raw);
  assert.strictEqual(r.shots.length, 6); assert.strictEqual(r.rejected.length, 2); assert.strictEqual(r.rejected[0].code, "too-many");
});
t("symlink file refused", () => {
  const link = path.join(folder, "link.png");
  try { fs.symlinkSync(path.join(cat, "outside.png"), link); } catch (e) { return; }      // no privilege to symlink: skip
  assert.strictEqual(sh.checkFile(cat, "t1", "link.png").ok, false);
});
t("junction or link as the tool folder or screenshots folder is refused", () => {
  const real = path.join(tmp, "elsewhere"); fs.mkdirSync(real); fs.writeFileSync(path.join(real, "01.png"), png(100, 100));
  const cat2 = path.join(tmp, "cat2"); fs.mkdirSync(path.join(cat2, "screenshots"), { recursive: true });
  try { fs.symlinkSync(real, path.join(cat2, "screenshots", "tj"), "junction"); } catch (e) { return; }
  assert.strictEqual(sh.checkFile(cat2, "tj", "01.png").ok, false);                     // the tool folder is a junction
  const cat3 = path.join(tmp, "cat3"); fs.mkdirSync(cat3); fs.mkdirSync(path.join(real, "t1"), { recursive: true }); fs.writeFileSync(path.join(real, "t1", "01.png"), png(100, 100));
  fs.symlinkSync(real, path.join(cat3, "screenshots"), "junction");
  assert.strictEqual(sh.checkFile(cat3, "t1", "01.png").ok, false);                     // the screenshots folder is a junction
});
t("stale tag", () => {
  const tool = { version: "0.4", release: { date: "2026-10-01" } };
  assert.strictEqual(sh.staleLabel("2026-09-20", tool), "older than v0.4");
  assert.strictEqual(sh.staleLabel("2026-10-01", tool), "");
  assert.strictEqual(sh.staleLabel("2026-10-08", tool), "");
  assert.strictEqual(sh.staleLabel("2026-09-20", { version: "v1.2", release: { date: "2026-10-01" } }), "older than v1.2");
  assert.strictEqual(sh.staleLabel("2026-09-20", { version: "", release: { date: "2026-10-01" } }), "older than the latest release");
  assert.strictEqual(sh.staleLabel("2026-09-20", { version: "1", release: { date: null } }), "");
});
const okImg = (calls) => { const img = { isEmpty: () => false, getSize: () => ({ width: 1280, height: 900 }), crop() { return img; }, resize() { return img; }, toJPEG: () => Buffer.from("jpegdata") }; return { createFromPath: () => { if (calls) calls.n++; return img; } }; };
const shotOf = (f) => sh.resolveShots(cat, "t1", [entry(f)]).shots[0];
t("thumbnail is made once and cached (16:10 crop, 1120x700, q82)", () => {
  let crop = null, resized = null, q = 0;
  const img = { isEmpty: () => false, getSize: () => ({ width: 1280, height: 900 }), crop(r) { crop = r; return img; }, resize(r) { resized = r; return img; }, toJPEG: (x) => { q = x; return Buffer.from("jpegdata"); } };
  const calls = { n: 0 }; const ni = { createFromPath: () => { calls.n++; return img; } };
  const dir = path.join(ud, "tools_thumbs"), shot = shotOf("01.png");
  const p1 = sh.ensureThumb(shot, dir, ni);
  assert.ok(p1.startsWith(dir) && p1.endsWith(".jpg") && fs.existsSync(p1));
  assert.deepStrictEqual(crop, { x: 0, y: 0, width: 1280, height: 800 }); assert.deepStrictEqual([resized.width, resized.height], [1120, 700]); assert.strictEqual(q, 82);
  assert.strictEqual(sh.ensureThumb(shot, dir, ni), p1); assert.strictEqual(calls.n, 1);
  assert.strictEqual(sh.ensureThumb(shot, path.join(ud, "other"), null), "");
});
t("negative cache: a failing decode is attempted once", () => {
  const calls = { n: 0 }, ni = { createFromPath: () => { calls.n++; return { isEmpty: () => true }; } };
  const shot = shotOf("02.JPG"), dir = path.join(ud, "neg");
  for (let i = 0; i < 5; i++) assert.strictEqual(sh.ensureThumb(shot, dir, ni), "");
  assert.strictEqual(calls.n, 1);
  // a throwing decoder is remembered too
  const shot2 = shotOf("s0.png"); const c2 = { n: 0 }; const ni2 = { createFromPath: () => { c2.n++; throw new Error("boom"); } };
  for (let i = 0; i < 3; i++) assert.strictEqual(sh.ensureThumb(shot2, dir, ni2), ""); assert.strictEqual(c2.n, 1);
  // a changed file (new size/mtime) gets a fresh try
  assert.strictEqual(sh.ensureThumb(Object.assign({}, shot2, { mtimeMs: shot2.mtimeMs + 5000 }), dir, ni2), ""); assert.strictEqual(c2.n, 2);
});
t("per-call cap: only N new thumbs, the rest are pending", () => {
  const calls = { n: 0 }, ni = okImg(calls), dir = path.join(ud, "cap");
  const shots = ["s1.png", "s2.png", "s3.png", "01x.png", "02x.png", "01.png"].map(shotOf);
  const d = sh.describe(shots, {}, dir, ni, { left: 4 });
  assert.strictEqual(calls.n, 4); assert.strictEqual(d.filter((x) => x.thumb).length, 4);
  assert.deepStrictEqual(d.slice(4).map((x) => [x.thumb, x.pending]), [["", true], ["", true]]);
  const d2 = sh.describe(shots, {}, dir, ni, { left: 4 });                       // next refresh: the rest fill in, cached ones cost nothing
  assert.strictEqual(calls.n, 6); assert.ok(d2.every((x) => x.thumb && !x.pending));
});
t("describe gives URLs, never paths", () => {
  const d = sh.describe([shotOf("02x.png")].map((s) => Object.assign({}, s, { taken: "2026-09-01" })), { version: "2", release: { date: "2026-10-01" } }, path.join(ud, "d"), okImg(), { left: 4 });
  assert.ok(d[0].thumb.startsWith("file:///") && d[0].full.startsWith("file:///"));
  assert.strictEqual(d[0].stale, "older than v2"); assert.ok(!("abs" in d[0]));
});
t("schema keeps tool valid, drops malformed entries", () => {
  const base = { id: "t1", basket: "other", name: "T", purpose: "p", status: "built" };
  const r = schema.validateTool(Object.assign({}, base, { screenshots: [entry("01.png"), { file: "x.png", taken: "2026-10-08" }, { file: "y.png", caption: "B", taken: "bad" }, 5, entry("z.png", { taken: "2026-02-30" })] }));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.entry.screenshots.length, 1); assert.deepStrictEqual(r.entry.shotsBad, [1, 2, 3, 4]);
  assert.strictEqual(schema.validateTool(Object.assign({}, base, { screenshots: "x" })).ok, false);
  assert.deepStrictEqual(schema.validateTool(base).entry.screenshots, []);
});
(async () => {
  const doc = { schema: 1, tools: [
    { id: "t1", basket: "other", name: "Tool one", purpose: "p", status: "built", version: "3", release: { url: null, date: "2026-10-01", notes: null }, screenshots: [entry("01.png", { caption: "Main", taken: "2026-09-01" }), entry("../outside.png")] },
    { id: "t2", basket: "other", name: "Two", purpose: "p", status: "partial" },
    { id: "t3", basket: "other", name: "Three", purpose: "p", status: "built", screenshots: "not-an-array" }] };
  fs.writeFileSync(path.join(cat, "tools.json"), JSON.stringify(doc));
  const svc = SV.createService({ workspaceRoot: tmp, userData: ud, testMode: true, env: { AGENT_DESKTOP_TOOLS_DIR: cat }, log: () => {}, nativeImage: okImg() });
  const r = await svc.load();
  const cards = [].concat(...r.groups.map((g) => g.cards));
  const c1 = cards.find((c) => c.id === "t1"), c2 = cards.find((c) => c.id === "t2");
  assert.strictEqual(c1.screenshots.length, 1); assert.strictEqual(c1.screenshots[0].stale, "older than v3");
  assert.ok(c1.screenshots[0].thumb.includes("tools_thumbs")); assert.deepStrictEqual(c2.screenshots, []);
  assert.deepStrictEqual(r.catalogue.shots, [{ id: "t1", count: 1, codes: ["bad-file-name"] }]);
  assert.strictEqual(r.thumbsPending, false);
  // non-array screenshots: that tool is skipped and reported by field name, the others still load
  assert.ok(!cards.find((c) => c.id === "t3")); assert.deepStrictEqual(r.catalogue.rejected, [{ id: "t3", fields: ["screenshots"] }]);
  n++;
  // service-level cap: 6 shots, 4 thumbs now, snapshot says pending, second load completes
  doc.tools = [{ id: "t1", basket: "other", name: "Tool one", purpose: "p", status: "built", screenshots: ["c0.png", "c1.png", "c2.png", "c3.png", "c4.png", "c5.png"].map((f) => entry(f)) }];
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(folder, "c" + i + ".png"), png(100 + i, 100));
  fs.writeFileSync(path.join(cat, "tools.json"), JSON.stringify(doc));
  const ud2 = path.join(tmp, "ud2"); fs.mkdirSync(ud2);
  const svc2 = SV.createService({ workspaceRoot: tmp, userData: ud2, testMode: true, env: { AGENT_DESKTOP_TOOLS_DIR: cat }, log: () => {}, nativeImage: okImg() });
  const a = await svc2.load(); const sa = a.groups.map((g) => g.cards).flat()[0].screenshots;
  assert.strictEqual(sa.filter((x) => x.thumb).length, 4); assert.strictEqual(a.thumbsPending, true);
  const b = await svc2.load(); assert.strictEqual(b.thumbsPending, false); assert.ok(b.groups.map((g) => g.cards).flat()[0].screenshots.every((x) => x.thumb));
  n++;
  console.log("toolsScreenshots: " + n + " tests passed" + (process.exitCode ? " WITH FAILURES" : ""));
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error("FAIL service: " + (e && e.stack || e)); process.exitCode = 1; });
