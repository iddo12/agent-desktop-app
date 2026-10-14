// Tests for the v1.92.0 Agent documents side panel: prefs file, pure renderer logic, registry-backed listing,
// title stacking, IPC/preload shape, and the visual-rule / privacy guards on the panel's own files.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ad = require("../src/agentDocs");
const prefsMod = require("../src/agentDocsPrefs");
const L = require("../src/agentDocsLogic");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf-8");
let n = 0;
function t(name, fn) { return Promise.resolve().then(fn).then(() => { n++; }, (e) => { console.error("FAIL " + name); throw e; }); }

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpanel-"));
  try {
    // ---- prefs ----
    await t("prefs: per-agent open/view/type, persisted, no BOM", () => {
      const f = path.join(tmp, "ud", "agent-docs-prefs.json");
      const p = prefsMod.create(f);
      assert.deepStrictEqual(p.get(), { agents: {} });
      assert.ok(p.set({ agent: "Security", open: true }).ok);
      assert.ok(p.set({ agent: "Security", view: "grid", type: "image" }).ok);
      assert.ok(p.set({ agent: "Graphics", open: false }).ok);
      assert.strictEqual(p.set({ agent: "Security", open: true }).unchanged, true);
      const raw = fs.readFileSync(f);
      assert.notStrictEqual(raw[0], 0xef, "no UTF-8 BOM");
      const again = prefsMod.create(f).get();
      assert.deepStrictEqual(again.agents.Security, { open: true, view: "grid", type: "image" });
      assert.deepStrictEqual(again.agents.Graphics, { open: false });
      assert.ok(!fs.existsSync(f + ".tmp"));
    });
    await t("prefs: rejects bad keys and values, survives a broken or BOM file", () => {
      const f = path.join(tmp, "ud2", "p.json");
      const p = prefsMod.create(f);
      for (const k of ["", "a/b", "..\\x", "__proto__", "constructor", " pad", "x".repeat(121), 5, null]) assert.strictEqual(p.set({ agent: k, open: true }).ok, false, String(k));
      assert.strictEqual(p.set({ agent: "A", view: "tiles" }).ok, false); // nothing valid to save
      assert.strictEqual(p.set({ agent: "A", open: "yes" }).ok, false);
      assert.ok(p.set({ agent: "A", open: true, evil: "x" }).ok);
      assert.deepStrictEqual(p.get().agents.A, { open: true });
      // a real pollution attempt: through set() and through a crafted file
      p.set({ agent: "__proto__", open: true, view: "grid" });
      assert.strictEqual(Object.getPrototypeOf(p.get().agents), Object.prototype);
      assert.strictEqual(({}).open, undefined); assert.strictEqual(({}).view, undefined);
      fs.writeFileSync(f, '{"agents":{"__proto__":{"open":true},"constructor":{"open":true},"C":{"open":true}}}');
      const loaded = prefsMod.create(f).get().agents;
      assert.deepStrictEqual(Object.keys(loaded), ["C"]);
      assert.strictEqual(({}).open, undefined);
      fs.writeFileSync(f, "{not json");
      assert.deepStrictEqual(prefsMod.create(f).get(), { agents: {} });
      fs.writeFileSync(f, "\uFEFF" + JSON.stringify({ agents: { B: { open: true, view: "list" }, "a/b": { open: true } } }));
      assert.deepStrictEqual(prefsMod.create(f).get(), { agents: { B: { open: true, view: "list" } } });
    });

    // ---- pure renderer logic ----
    await t("badge: total + N new, words for screen readers", () => {
      assert.deepStrictEqual(L.badge({ total: 14, unread: 2 }), { total: "14", fresh: "2 new", label: "Documents: 14 registered files, 2 not opened yet" });
      assert.strictEqual(L.badge({ total: 0, unread: 0 }).fresh, "");
      assert.strictEqual(L.badge({ total: 1 }).label, "Documents: 1 registered file");
      assert.strictEqual(L.badge({ total: 3, unread: 9 }).fresh, "3 new"); // never more new than total
      assert.strictEqual(L.badge({ total: 20000, unread: 5000 }).total, "9999+");
      assert.strictEqual(L.badge(null).total, "0");
    });
    await t("layout: overlay below 1100 px or when the chat would drop under 360 px; viewer needs 560", () => {
      assert.strictEqual(L.layoutMode(1099, 900, false), "overlay");
      assert.strictEqual(L.layoutMode(1500, 1100, false), "side");
      assert.strictEqual(L.layoutMode(1500, 700, false), "overlay"); // 700 - 380 < 360
      assert.strictEqual(L.layoutMode(1500, 900, true), "overlay"); // 900 - 560 < 360
      assert.strictEqual(L.layoutMode(1800, 1100, true), "side");
      assert.strictEqual(L.OVERLAY_BELOW, 1100); assert.strictEqual(L.CHAT_MIN, 360); assert.strictEqual(L.VIEWER_W, 560);
    });
    await t("defaultView: image-heavy agents open on Images as a grid", () => {
      assert.deepStrictEqual(L.defaultView({ image: 190, docs: 22 }), { type: "image", view: "grid" });
      assert.deepStrictEqual(L.defaultView({ image: 0, docs: 14 }), { type: "docs", view: "list" });
      assert.deepStrictEqual(L.defaultView(null), { type: "docs", view: "list" });
    });
    await t("pills: Documents/Images/All/PDF/Word always; others only when present or active", () => {
      const keys = (c, a) => L.pills(c, a).map((p) => p.key);
      assert.deepStrictEqual(keys({}, "docs"), ["docs", "image", "all", "pdf", "word"]);
      assert.deepStrictEqual(keys({ sheet: 2 }, "docs"), ["docs", "image", "all", "pdf", "word", "sheet"]);
      assert.deepStrictEqual(keys({}, "video"), ["docs", "image", "all", "pdf", "word", "video"]);
      assert.strictEqual(L.pills({ pdf: 8 }, "pdf").find((p) => p.key === "pdf").active, true);
    });
    await t("empty states explain", () => {
      assert.strictEqual(L.emptyState({ allTotal: 0 }).kind, "none");
      assert.ok(/never listed/.test(L.emptyState({ allTotal: 0 }).text));
      const m = L.emptyState({ allTotal: 14, search: "snapshots 2019" });
      assert.strictEqual(m.kind, "nomatch"); assert.ok(m.title.includes("snapshots 2019")); assert.strictEqual(m.action, "Clear search");
      assert.strictEqual(L.emptyState({ allTotal: 3, typeLabel: "Sheets" }).action, "Show all");
    });
    await t("status chip always has its word", () => {
      assert.deepStrictEqual(L.statusChip("active"), { cls: "ok", text: "active" });
      assert.deepStrictEqual(L.statusChip("Draft"), { cls: "warn", text: "draft" });
      assert.strictEqual(L.statusChip("superseded").cls, "old");
      assert.strictEqual(L.statusChip(""), null);
    });
    await t("formatting, keyboard movement, comment text", () => {
      const now = new Date(2026, 9, 8, 12, 0).getTime();
      assert.strictEqual(L.fmtWhen(new Date(2026, 9, 8, 6, 52).getTime(), now), "today 06:52");
      assert.strictEqual(L.fmtWhen(new Date(2026, 9, 7, 18, 5).getTime(), now), "yesterday 18:05");
      assert.strictEqual(L.fmtWhen(new Date(2026, 9, 3, 9, 0).getTime(), now), "Oct 3");
      assert.strictEqual(L.fmtWhen(new Date(2025, 9, 3).getTime(), now), "Oct 3, 2025");
      assert.strictEqual(L.fmtSize(412 * 1024), "412 KB"); assert.strictEqual(L.fmtSize(1.2 * 1048576), "1.2 MB"); assert.strictEqual(L.fmtSize(12), "12 B");
      assert.strictEqual(L.moveSel(0, "ArrowUp", 5), 0); assert.strictEqual(L.moveSel(4, "ArrowDown", 5), 4);
      assert.strictEqual(L.moveSel(2, "End", 5), 4); assert.strictEqual(L.moveSel(3, "Home", 5), 0); assert.strictEqual(L.moveSel(0, "PageDown", 5), 4);
      assert.strictEqual(L.moveSel(0, "ArrowDown", 0), -1);
      assert.strictEqual(L.commentText("T", "C:\\a.pdf", "  "), "");
      assert.strictEqual(L.commentText("T", "C:\\a.pdf", " fix p.3 "), "Comment on your document \"T\" (C:\\a.pdf):\nfix p.3");
    });

    // ---- backend: agent key, registry listing, stacking ----
    await t("resolveAgent: by folder name only, never a path", () => {
      const agents = [{ folderName: "Security", path: "D:\\x\\Security" }, { folderName: "COO Agent", path: "D:\\x\\COO Agent" }];
      assert.strictEqual(ad.resolveAgent(agents, "COO Agent").folderName, "COO Agent");
      for (const k of ["D:\\x\\Security", "security", "", null, 7, "x".repeat(200)]) assert.strictEqual(ad.resolveAgent(agents, k), null, String(k));
    });

    const agentDir = path.join(tmp, "ws", "Security");
    fs.mkdirSync(path.join(agentDir, "docs"), { recursive: true });
    const w = (rel, s = "x") => { const p = path.join(agentDir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
    const pdfA = w("docs/a.pdf"), pdfB = w("docs/web_copy.pdf"), img = w("docs/pic.png"), thumb = w("thumbs/pic_small.jpg");
    const outside = path.join(tmp, "elsewhere.pdf"); fs.writeFileSync(outside, "x");
    // listRegistry()-shaped entries (path = local doc or a web entry's PDF copy; thumbnail = the Library's cached preview)
    const entries = [
      { id: "r-a", type: "document", title: "Findings", agent: "Security", link: pdfA, path: pdfA, status: "active", updatedAt: "2026-10-08T06:00:00Z" },
      { id: "r-web", type: "document", title: "Web article", agent: "Security Agent", link: "https://example.test/a", isUrl: true, path: pdfB, updatedAt: "2026-10-07T06:00:00Z" },
      { id: "r-url-only", type: "document", title: "Only a link", agent: "Security", link: "https://example.test/b", isUrl: true, path: "" },
      { id: "r-img", type: "image", title: "Picture", agent: "Security", link: img, path: img, thumbnail: thumb },
      { id: "r-missing", type: "document", title: "Gone", agent: "Security", link: path.join(agentDir, "nope.pdf"), path: path.join(agentDir, "nope.pdf"), missing: true },
      { id: "r-out", type: "document", title: "Outside", agent: "Security", link: outside, path: outside },
      { id: "r-other", type: "document", title: "Not mine", agent: "COO", link: pdfA, path: pdfA },
      { id: "r-proj", type: "project", title: "Project", agent: "Security", link: agentDir, path: agentDir },
    ];
    const roots = [path.join(tmp, "ws")];
    await t("registryItems: listRegistry entries, web copies by their PDF, Library thumbnail kept, confined", () => {
      const items = ad.registryItems(entries, ["Security"], roots);
      assert.deepStrictEqual(items.map((i) => i.id).sort(), ["r-a", "r-img", "r-web"]);
      assert.strictEqual(items.find((i) => i.id === "r-web").path, pdfB);
      assert.strictEqual(items.find((i) => i.id === "r-img").thumb, thumb);
    });
    await t("registryCount: cheap badge count matches the listing's confinement", () => {
      const c = ad.registryCount(entries, ["Security"], roots);
      assert.deepStrictEqual(c.ids.sort(), ["r-a", "r-img", "r-web"]);
      assert.strictEqual(ad.registryCount(entries, ["Security"], []).total, 0);
    });
    await t("create(): list rows carry kind/thumb/path; summary shares the Library read state", async () => {
      const readState = { "r-a": { at: "x" } };
      const svc = ad.create({ outputRoot: path.join(tmp, "none"), roots, loadRegistry: () => entries, libraryState: { get: () => ({ read: readState }) },
        shell: { openPath: async () => "", showItemInFolder() {} }, nativeImage: {}, thumbDir: path.join(tmp, "th") });
      const agent = { path: agentDir, folderName: "Security", displayName: "Security" };
      const before = await svc.summary(agent);
      assert.deepStrictEqual(before, { total: 3, unread: 2, full: false });
      const r = await svc.list(agent, { type: "all" });
      const a = r.items.find((i) => i.id === "r-a");
      assert.strictEqual(a.kind, "PDF"); assert.strictEqual(a.unread, false); assert.strictEqual(a.path, pdfA);
      assert.strictEqual(r.items.find((i) => i.id === "r-img").kind, "IMG");
      const th = await svc.thumbnail(agent, "r-img");
      assert.deepStrictEqual(th, { ok: true, path: thumb }); // reused, not regenerated
      assert.strictEqual((await svc.summary(agent)).full, true);
      assert.strictEqual((await svc.open(agent, "r-out", "open")).ok, false);
    });
    await t("stemTitle: only explicit version words fold; numbers and dates are separate documents", () => {
      assert.strictEqual(ad.stemTitle("Retention proposal v2"), ad.stemTitle("Retention proposal v1"));
      assert.strictEqual(ad.stemTitle("Plan (FINAL)"), "plan");
      assert.strictEqual(ad.stemTitle("Plan draft3"), "plan");
      assert.notStrictEqual(ad.stemTitle("Weekly audit report 41"), ad.stemTitle("Weekly audit report 42"));
      assert.notStrictEqual(ad.stemTitle("Ops 2026-10-05"), ad.stemTitle("Ops 2026-10-06"));
      assert.strictEqual(ad.stemTitle("v2"), "v2");
    });
    await t("query: registry docs stack by title (img_01/img_02 files with different titles stay apart); selfUnread kept", () => {
      const now = Date.parse("2026-10-08T12:00:00");
      const mk = (id, title, file, ms) => ad.finishItem({ id, path: "C:\\x\\" + file, title, size: 1, mtimeMs: ms, status: "", note: "", source: "registry" });
      const items = [mk("i1", "Channel banner", "img_01.png", now - 1), mk("i2", "Logo lockup", "img_02.png", now - 2),
        mk("d1", "Proposal v1", "p1.docx", now - 30), mk("d2", "Proposal v2", "p2.docx", now - 10)];
      const r = ad.query(items, { type: "all", stack: true }, { d2: { at: 1 } }, now);
      assert.strictEqual(r.total, 3);
      const p = r.items.find((x) => x.id === "d2");
      assert.strictEqual(p.versions, 2); assert.strictEqual(p.selfUnread, false); assert.strictEqual(p.unread, true); // older v1 unread
    });

    // ---- review fixes, behavioural ----
    await t("S1: a registered file is listed once - forward-slash/case-different registry path, and a DOC original with a PDF copy", async () => {
      const dir = path.join(tmp, "ws2", "Writer");
      const mkf = (rel) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "x"); return p; };
      const rep = mkf("docs/Report.pdf"), art = mkf("docs/Article.docx"), artPdf = mkf("docs/Article.pdf"), loose = mkf("docs/Loose.pdf");
      const fwd = rep.replace(/\\/g, "/").toUpperCase().replace(/^([A-Z]):/, (m, d) => d.toLowerCase() + ":"); // e:/.../DOCS/REPORT.PDF
      const reg = [
        { id: "w-rep", type: "document", title: "Report", agent: "Writer", link: fwd, path: fwd },
        // listRegistry shape for a Word original that has a PDF copy: link = .docx, path = the .pdf copy
        { id: "w-art", type: "document", title: "Article", agent: "Writer", link: art.replace(/\\/g, "/"), path: artPdf.replace(/\\/g, "/") },
      ];
      const svc = ad.create({ outputRoot: path.join(tmp, "none"), roots: [path.join(tmp, "ws2")], loadRegistry: () => reg, libraryState: { get: () => ({ read: {} }) },
        shell: { openPath: async () => "", showItemInFolder() {} }, nativeImage: {}, thumbDir: path.join(tmp, "th2") });
      const r = await svc.list({ path: dir, folderName: "Writer", displayName: "Writer" }, { type: "all" });
      const ids = r.items.map((i) => i.id);
      assert.strictEqual(r.counts.all, 3, "Report + Article + Loose, nothing twice: " + JSON.stringify(r.items.map((i) => i.name)));
      assert.ok(ids.includes("w-rep") && ids.includes("w-art"));
      assert.strictEqual(r.items.filter((i) => i.source === "folder").length, 1);
      assert.strictEqual(r.items.find((i) => i.source === "folder").name, path.basename(loose));
      assert.ok(ad.registeredKeys([{ path: "C:/A/b.PDF", link: "c:\\a\\B.docx" }]).has(ad.pathKey("C:\\a\\B.DOCX")));
    });
    await t("S2: UNC and device paths are refused before any fs call (fast), in listing, count, thumbnails and the Library", () => {
      const { isPlainLocalPath } = require("../src/localPath");
      for (const bad of ["\\\\192.0.2.1\\share\\a.pdf", "//192.0.2.1/share/a.pdf", "\\\\?\\C:\\x\\a.pdf", "\\\\.\\C:\\x\\a.pdf", "\\\\?\\UNC\\h\\s\\a.pdf",
        "relative\\a.pdf", "C:a.pdf", "C:\\x\\a.pdf:stream", "", null, 7]) assert.strictEqual(isPlainLocalPath(bad), false, String(bad));
      assert.strictEqual(isPlainLocalPath("C:\\x\\a.pdf"), true); assert.strictEqual(isPlainLocalPath("C:/Example/Scratch/a.pdf"), true);
      const t0 = Date.now();
      assert.strictEqual(ad.underRoots("\\\\192.0.2.1\\share\\a.pdf", ["\\\\192.0.2.1\\share"]), false);
      assert.strictEqual(ad.underRoots("//192.0.2.1/share/a.pdf", ["D:\\"]), false);
      const unc = [{ id: "u1", type: "document", title: "x", agent: "Security", link: "\\\\192.0.2.1\\s\\a.pdf", path: "\\\\192.0.2.1\\s\\a.pdf" },
        { id: "u2", type: "image", title: "y", agent: "Security", link: pdfA, path: pdfA, thumbnail: "\\\\192.0.2.1\\s\\t.jpg" }];
      assert.deepStrictEqual(ad.registryItems(unc, ["Security"], roots).map((i) => [i.id, i.thumb]), [["u2", null]]);
      assert.strictEqual(ad.registryCount(unc, ["Security"], roots).total, 1);
      assert.ok(Date.now() - t0 < 1000, "no network wait");
      const regSrc = read("src/registry.js");
      assert.ok(/const localFile = \(p\) => !!p && !isUrl\(p\) && isPlainLocalPath\(p\)/.test(regSrc), "Library uses the same guard");
    });
    await t("N3: a registry thumbnail outside the roots, or not an image, is not used", () => {
      const e = [{ id: "t1", type: "image", title: "x", agent: "Security", link: img, path: img, thumbnail: outside },
        { id: "t2", type: "image", title: "y", agent: "Security", link: img, path: img, thumbnail: pdfA }];
      assert.deepStrictEqual(ad.registryItems(e, ["Security"], roots).map((i) => i.thumb), [null, null]);
    });
    await t("S3: control characters cannot end the bracketed paste (title, path, comment); idempotent", () => {
      const ESC = "\u001b", CSI = "\u009b";
      const out = L.commentText("Report" + ESC + "[201~\r!echo pwned\r" + CSI + "x", "C:\\a" + ESC + "[201~.pdf", "fine" + ESC + "[201~\r\nnext\tline\u0007");
      assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out), JSON.stringify(out));
      assert.ok(!out.includes(ESC) && !out.includes("\r") && !out.includes(CSI));
      assert.ok(out.includes("Report[201~!echo pwnedx") && out.includes("fine[201~\nnext\tline"));
      assert.strictEqual(L.cleanBody(L.cleanBody("a\u001bb\r\nc")), "ab\nc");
      assert.strictEqual(L.cleanLine("x".repeat(500)).length, 300);
      const js = read("src/renderer/agent-docs.js");
      assert.ok(/const text = L\.commentText\(/.test(js) && /bridge\.send\(agentPath, text\)/.test(js), "only the cleaned text reaches the send path");
    });
    await t("S4: Mark read on a stacked row marks the whole stack and the dot really changes", () => {
      const mkStack = () => [{ id: "h", unread: true, selfUnread: true, older: [{ id: "o1", unread: true }, { id: "o2", unread: false }] }, { id: "z", unread: true }];
      const items = mkStack();
      const ids = L.idsForRead(items[0], true);
      assert.deepStrictEqual(ids, ["h", "o1"]);
      let changed = 0;
      for (const id of ids) changed += L.applyReadToItems(items, id, true);
      assert.strictEqual(changed, 2);
      assert.strictEqual(items[0].unread, false, "dot goes from blue to ring");
      assert.strictEqual(items[1].unread, true);
      // head already read, only an older version unread: still turns the dot off
      const s2 = mkStack(); s2[0].selfUnread = false;
      for (const id of L.idsForRead(s2[0], true)) L.applyReadToItems(s2, id, true);
      assert.strictEqual(s2[0].unread, false);
      // mark unread = head only
      assert.deepStrictEqual(L.idsForRead(items[0], false), ["h"]);
      L.applyReadToItems(items, "h", false);
      assert.strictEqual(items[0].unread, true); assert.strictEqual(items[0].older[0].unread, false);
      assert.strictEqual(L.applyReadToItems(items, "not-loaded", true), 0);
    });
    await t("N4: open-externally allow-list drops doc/xls/rtf/svg/zip, keeps pdf/images/docx/xlsx/csv/txt/md", async () => {
      for (const ok of ["a.pdf", "a.png", "a.jpg", "a.docx", "a.xlsx", "a.csv", "a.txt", "a.md", "a.mp4", "a.dwg"]) assert.ok(ad.canOpenExternally(ok), ok);
      for (const no of ["a.doc", "a.xls", "a.rtf", "a.svg", "a.zip", "a.exe", "a.hta", "a.docm", "a.lnk"]) assert.ok(!ad.canOpenExternally(no), no);
      const dir = path.join(tmp, "ws3", "A");
      fs.mkdirSync(dir, { recursive: true });
      for (const f of ["old.doc", "pic.svg", "new.docx"]) fs.writeFileSync(path.join(dir, f), "x");
      const opened = [];
      const svc = ad.create({ outputRoot: path.join(tmp, "none"), roots: [path.join(tmp, "ws3")], loadRegistry: () => [], libraryState: { get: () => ({ read: {} }) },
        shell: { openPath: async (p) => { opened.push(p); return ""; }, showItemInFolder() {} }, nativeImage: {}, thumbDir: path.join(tmp, "th3") });
      const agent = { path: dir, folderName: "A" };
      const r = await svc.list(agent, { type: "all" });
      const by = (n) => r.items.find((i) => i.name === n);
      assert.strictEqual(by("old.doc").openable, false); assert.strictEqual(by("pic.svg").openable, false); assert.strictEqual(by("new.docx").openable, true);
      assert.strictEqual((await svc.open(agent, by("old.doc").id, "open")).ok, false);
      assert.strictEqual((await svc.open(agent, by("pic.svg").id, "open")).ok, false);
      assert.strictEqual((await svc.open(agent, by("new.docx").id, "open")).ok, true);
      assert.deepStrictEqual(opened.map((p) => path.basename(p)), ["new.docx"]);
      assert.strictEqual((await svc.open(agent, by("old.doc").id, "reveal")).ok, true);
    });
    await t("N5: read-state ids like constructor/__proto__ never read as read and cannot be stored", () => {
      assert.strictEqual(ad.isRead({}, "constructor"), false);
      assert.strictEqual(ad.isRead({}, "toString"), false);
      assert.strictEqual(ad.isRead({ a: { at: 1 } }, "a"), true);
      const ls = require("../src/libraryState");
      const f = path.join(tmp, "ls", "library-state.json");
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const s = ls.create(f);
      for (const id of ["__proto__", "constructor", "prototype", "toString"]) assert.strictEqual(s.apply({ op: "read", id, value: true }).ok, false, id);
      assert.strictEqual(({}).at, undefined);
      fs.writeFileSync(f, '{"read":{"__proto__":{"at":"x"},"constructor":{"at":"x"},"ok-1":{"at":"x"}},"history":{}}');
      const st2 = ls.create(f).get();
      assert.deepStrictEqual(Object.keys(st2.read), ["ok-1"]);
      assert.strictEqual(Object.getPrototypeOf(st2.read), Object.prototype);
      const now = Date.now();
      const items = [ad.finishItem({ id: "constructor", path: "C:\\x\\c.pdf", title: "c", size: 1, mtimeMs: now, source: "registry" })];
      assert.strictEqual(ad.query(items, {}, {}, now).items[0].unread, true);
    });
    await t("N8: the badge counts the same population (registered documents) before and after the first open", async () => {
      const svc = ad.create({ outputRoot: path.join(tmp, "none"), roots, loadRegistry: () => entries, libraryState: { get: () => ({ read: {} }) },
        shell: { openPath: async () => "", showItemInFolder() {} }, nativeImage: {}, thumbDir: path.join(tmp, "th4") });
      const agent = { path: agentDir, folderName: "Security", displayName: "Security" };
      w("docs/unregistered_extra.pdf");
      const before = await svc.summary(agent);
      const r = await svc.list(agent, { type: "all" });
      const after = await svc.summary(agent);
      assert.ok(r.counts.all > before.total, "the list also shows unregistered folder files");
      assert.strictEqual(after.total, before.total); assert.strictEqual(after.unread, before.unread);
    });
    await t("N9: the count line counts rows and says when versions fold", () => {
      assert.strictEqual(L.countLine({ loaded: true, files: 59, total: 58, shown: 58 }), "59 files (1 older version folded)");
      assert.strictEqual(L.countLine({ loaded: true, files: 59, total: 58, shown: 40 }), "Showing 40 of 58 (1 older version folded)");
      assert.strictEqual(L.countLine({ loaded: true, files: 1, total: 1, shown: 1 }), "1 file");
      assert.strictEqual(L.countLine({ loaded: true, search: "x", files: 0, total: 0, shown: 0, allTotal: 60 }), "0 of 60 match");
      assert.strictEqual(L.countLine({ loaded: false }), "");
    });

    // ---- wiring and guards ----
    await t("preload/main: agent by name, ids only, validated actions, prefs channels", () => {
      const pre = read("src/preload.js"), main = read("src/main.js");
      assert.ok(/agentDocsList: \(agent, query\) => ipcRenderer\.invoke\("agent-docs-list", \{ agent, query \}\)/.test(pre));
      assert.ok(!/agent-docs-[a-z]+", \{ agentPath/.test(pre), "no agent path over IPC");
      assert.ok(/agentDocsPrefsGet/.test(pre) && /agentDocsPrefsSet/.test(pre));
      assert.ok(/const ADOC_HOW = \["view", "open", "reveal"\]/.test(main));
      assert.ok(/ipcMain\.handle\("agent-docs-prefs-set"[\s\S]{0,200}agentForDocs\(patch\.agent\)/.test(main), "prefs only for a real agent");
      assert.ok(/loadRegistry: \(\) => registry\.listRegistry\(registryBase\(\)\)/.test(main), "same cached list as the Library");
      assert.ok(/outputRoot: \(\) => \(demo\.ON \|\| testMode\.TEST_MODE \? AGENTS_ROOT/.test(main), "sandbox never lists real folders");
      assert.ok(/agent-docs-prefs\.json/.test(main));
    });
    await t("renderer guards: no localStorage/innerHTML/eval, dir=auto, read-state event both ways, lazy", () => {
      const js = read("src/renderer/agent-docs.js");
      const code = js.replace(/^\s*\/\/.*$/gm, "");
      for (const bad of ["localStorage", "innerHTML", "eval(", "outerHTML", "insertAdjacentHTML"]) assert.ok(!code.includes(bad), bad);
      assert.ok((js.match(/\.dir = "auto"/g) || []).length >= 4, "titles, search, comment and empty title are dir=auto");
      assert.ok(/dispatchEvent\(new CustomEvent\("ad-doc-read"/.test(js) && /addEventListener\("ad-doc-read"/.test(js));
      const lib = read("src/renderer/library.js");
      assert.ok(/dispatchEvent\(new CustomEvent\("ad-doc-read"/.test(lib) && /addEventListener\("ad-doc-read"/.test(lib), "Library side of the sync");
      assert.ok(/aria-expanded/.test(js) && /aria-controls/.test(js) && /role", "listbox"/.test(js) && /aria-activedescendant/.test(js));
      assert.ok(/IntersectionObserver/.test(js), "thumbnails and paging are lazy");
      assert.ok(!/agentDocsList\(agentPath/.test(js) && !/agentDocsOpen\(agentPath/.test(js), "renderer asks main by agent key");
      const html = read("src/renderer/index.html");
      assert.ok(html.indexOf("../agentDocsLogic.js") > 0 && html.indexOf("../agentDocsLogic.js") < html.indexOf("\"agent-docs.js\""));
    });
    await t("CSS guards: nothing under 12 px, weights 400/600/700 only, 1 px hairlines, overlay + viewer widths", () => {
      const css = read("src/renderer/styles-agent-docs.css").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(Number(m[1]) >= 12, "font-size " + m[1]);
      for (const m of css.matchAll(/font-weight:\s*(\d+)/g)) assert.ok(["400", "600", "700"].includes(m[1]), "weight " + m[1]);
      // hairlines are 1 px; the only thicker strokes are the selected row's 3 px accent bar and the read dot's ring (a shape, not a line)
      for (const m of css.matchAll(/border(?:-left|-top|-bottom|-right)?:\s*([\d.]+)px solid[^;]*/g)) {
        assert.ok(Number(m[1]) <= 1 || m[0] === "border-left: 3px solid transparent" || m[0] === "border: 1.5px solid var(--text-muted)", m[0]);
      }
      assert.ok(/--adp-w: 380px/.test(css) && /--adp-vw: 560px/.test(css));
      assert.ok(/#chat-view\.agent-docs-overlay \.agent-docs-panel/.test(css));
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("agentDocsPanel tests passed: " + n);
})().catch((e) => { console.error(e); process.exit(1); });
