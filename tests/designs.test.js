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
    const s = fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
    assert.ok(!/\b[A-Z]:\\\\/.test(s) && !/Dropbox|Iddo|Merav/i.test(s), f);
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
