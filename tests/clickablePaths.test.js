// Run: node tests/clickablePaths.test.js
// v1.109.0: clickable file paths in agent chat. Part 1: the parser (src/pathLinks.js). Part 2: the main-side validator
// (src/openPath.js): allow-list, roots, traversal, UNC, alternate data streams, junction escape, executables, missing file.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const PL = require("../src/pathLinks");
const { createOpener } = require("../src/openPath");

// ---------- parser ----------
const g = (s, o) => PL.find(s, o).map((c) => c.guess);
const t = (s, o) => PL.find(s, o).map((c) => s.slice(c.start, c.end));

assert.deepStrictEqual(g("see C:\\Example\\Scratch\\UI-UX\\lbracket\\option_a.html and more"), ["C:\\Example\\Scratch\\UI-UX\\lbracket\\option_a.html"], "spaces in path, prose");
assert.deepStrictEqual(g("`C:\\Example\\Scratch\\UI-UX\\lbracket\\option_a.html`", { code: true }), ["C:\\Example\\Scratch\\UI-UX\\lbracket\\option_a.html"], "backticked");
assert.deepStrictEqual(g("C:\\Example\\Workspace\\Security\\docs\\x.pdf."), ["C:\\Example\\Workspace\\Security\\docs\\x.pdf"], "trailing period");
assert.deepStrictEqual(g("(D:\\a\\b.pdf), and D:\\a\\c.docx; done"), ["D:\\a\\b.pdf", "D:\\a\\c.docx"], "parens, comma, semicolon, two paths");
assert.deepStrictEqual(g("C:/Example/Workspace/x.xlsx"), ["C:/Example/Workspace/x.xlsx"], "forward slashes");
assert.deepStrictEqual(g("open file:///C:/Example/Workspace/x.pdf now"), ["file:///C:/Example/Workspace/x.pdf"], "file URL");
assert.strictEqual(PL.normalize("file:///C:/Example/Workspace/x.pdf"), "C:\\Example\\Workspace\\x.pdf");
assert.strictEqual(PL.normalize("D:/a/b"), "D:\\a\\b");
assert.deepStrictEqual(g("D:\\a\\b.html:42"), ["D:\\a\\b.html"], ":line is not part of the path");
assert.deepStrictEqual(t("D:\\a\\b.html:42:7 here"), ["D:\\a\\b.html:42:7"], ":line:col is part of the clickable text");
assert.deepStrictEqual(g("\u05D1\u05E7\u05D5\u05D1\u05E5 D:\\a b\\\u05E9\u05DD.pdf \u05D4\u05D5\u05D0 \u05D8\u05D5\u05D1"), ["D:\\a b\\\u05E9\u05DD.pdf"], "Hebrew around and in the path");
assert.deepStrictEqual(g("\u05D1-D:\\a\\b.pdf\u05D5\u05D2\u05DD"), ["D:\\a\\b.pdf"], "RTL text glued to both ends");
assert.deepStrictEqual(g("\u200fD:\\a\\b.pdf\u200f"), ["D:\\a\\b.pdf"], "bidi marks are not part of the path");
assert.deepStrictEqual(g('"D:\\a b\\c d\\x.png"'), ["D:\\a b\\c d\\x.png"], "double quotes");
assert.deepStrictEqual(g("'D:\\a b\\x.png' next"), ["D:\\a b\\x.png"], "single quotes");
assert.deepStrictEqual(g("Report (1).pdf is at D:\\x\\Report (1).pdf)"), ["D:\\x\\Report (1).pdf"], "paren in name, closing paren after");
assert.deepStrictEqual(g("D:\\x.docs\\inner\\file.pdf"), ["D:\\x.docs\\inner\\file.pdf"], "extension-looking folder name is skipped");
// folders
assert.deepStrictEqual(g("folder C:\\Example\\Scratch\\UI-UX\\lbracket and more", { code: false }), ["C:\\Example\\Scratch\\UI-UX\\lbracket"], "prose folder stops at first word after the last separator");
assert.deepStrictEqual(g("C:\\Example\\Scratch\\My Reports", { code: true }), ["C:\\Example\\Scratch\\My Reports"], "code folder keeps spaces");
assert.deepStrictEqual(g("in C:\\Example\\Scratch\\UI-UX."), ["C:\\Example\\Scratch\\UI-UX"], "folder trailing period");
// false positives
for (const s of ["C: is full", "a/b/c.pdf", "drive C:\\", "x.pdf", "\\\\server\\share\\a.pdf", "http://host/C:/a.pdf", "ratio 3:2 and 10:30", "the C:\\ root", "ab C:", "foo.exe"]) {
  assert.deepStrictEqual(PL.find(s), [], "no candidate in: " + s);
}
assert.deepStrictEqual(g("xC:\\a\\b.pdf"), [], "letter glued before the drive is not a drive");
// only the known extensions count as file guesses
assert.strictEqual(PL.find("D:\\a\\run.bat")[0].hasExt, false, "bat is not an extension we link");
assert.ok(!PL.isAllowedExt("exe") && !PL.isAllowedExt("ps1") && !PL.isAllowedExt("lnk") && !PL.isAllowedExt("xlsm") && !PL.isAllowedExt("js"));
for (const e of ["html", "pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "json", "png", "jpg", "mp4", "mp3", "htm"]) assert.ok(PL.isAllowedExt(e), e);
// prefixes: longest first
const px = PL.prefixes("D:\\a b\\folder and more", false).map((p) => p.text);
assert.deepStrictEqual(px, ["D:\\a b\\folder and more", "D:\\a b\\folder and", "D:\\a b\\folder"], "shrinking prefixes (only trailing words)");
assert.strictEqual(PL.prefixes("D:\\a b\\x.pdf", true).length, 1);
// markdown link
const ml = PL.MD_LINK_RE.exec("see [the plan](C:\\Example\\Workspace\\p.docx) ok");
assert.ok(ml && ml[1] === "the plan" && ml[2] === "C:\\Example\\Workspace\\p.docx");
assert.ok(!PL.MD_LINK_RE.exec("[x](D:\\a\\run.bat)"), "bat link target is not a link");

// ---------- main-side validator ----------
const base = fs.mkdtempSync(path.join(os.tmpdir(), "clickpaths-"));
const root = path.join(base, "root");
const outside = path.join(base, "outside");
fs.mkdirSync(path.join(root, "sub dir"), { recursive: true });
fs.mkdirSync(outside);
const wr = (p, c) => fs.writeFileSync(p, c || "x");
wr(path.join(root, "sub dir", "a b.html"));
wr(path.join(root, "r.pdf"));
wr(path.join(root, "pic.PNG"));
wr(path.join(root, "run.bat"));
wr(path.join(root, "tool.exe"));
wr(path.join(root, "s.ps1"));
wr(path.join(root, "m.xlsm"));
wr(path.join(root, "noext"));
wr(path.join(outside, "secret.pdf"));
let junction = false;
try { fs.symlinkSync(outside, path.join(root, "escape"), "junction"); junction = true; } catch (e) { /* no junction support */ }

const logs = [];
const calls = [];
const mk = (extra) => createOpener(Object.assign({ roots: [root], log: (l) => logs.push(l), shell: { openPath: async (p) => { calls.push(p); return ""; } } }, extra));
const op = mk();

(async () => {
  let r = op.check(path.join(root, "sub dir", "a b.html"));
  assert.ok(r.ok && r.kind === "file", "html with spaces ok");
  assert.ok(op.check(root + "/r.pdf").ok, "forward slashes ok");
  assert.ok(op.check(path.join(root, "pic.PNG")).ok, "upper-case extension ok");
  r = op.check(path.join(root, "sub dir"));
  assert.ok(r.ok && r.kind === "folder", "folder ok");
  assert.ok(op.check(root).ok, "the root itself is a folder we may open");
  assert.ok(op.check("file:///" + path.join(root, "r.pdf").replace(/\\/g, "/").replace(/ /g, "%20")).ok, "file:/// url ok");

  for (const bad of ["run.bat", "tool.exe", "s.ps1", "m.xlsm", "noext"]) assert.ok(!op.check(path.join(root, bad)).ok, bad + " refused");
  assert.ok(!op.check(path.join(root, "nothere.pdf")).ok, "missing refused");
  assert.ok(!op.check(path.join(outside, "secret.pdf")).ok, "outside root refused");
  assert.ok(!op.check(root + "\\sub dir\\..\\..\\outside\\secret.pdf").ok, "traversal refused");
  assert.ok(!op.check(root + "\\..\\outside\\secret.pdf").ok, "traversal refused 2");
  assert.ok(!op.check("\\\\localhost\\c$\\x.pdf").ok, "UNC refused");
  assert.ok(!op.check("//server/share/x.pdf").ok, "UNC (slashes) refused");
  assert.ok(!op.check("\\\\?\\" + path.join(root, "r.pdf")).ok, "device path refused");
  assert.ok(!op.check(path.join(root, "r.pdf") + ":evil.exe").ok, "alternate data stream refused");
  assert.ok(!op.check(path.join(root, "r.pdf") + "::$DATA").ok, "::$DATA refused");
  assert.ok(!op.check(path.join(root, "CON.pdf")).ok && !op.check(root + "\\nul").ok, "device names refused");
  assert.ok(!op.check("relative\\r.pdf").ok && !op.check("").ok && !op.check(null).ok && !op.check("x".repeat(2000)).ok, "junk refused");
  if (junction) {
    assert.ok(!op.check(path.join(root, "escape", "secret.pdf")).ok, "junction escape refused");
    assert.ok(!op.check(path.join(root, "escape")).ok, "junction folder escape refused");
  } else console.log("note: junction not available, escape test skipped");

  // resolve: longest existing prefix
  const rs = op.resolve([{ text: path.join(root, "sub dir") + " and more words", hasExt: false }, { text: path.join(root, "r.pdf"), hasExt: true }, { text: path.join(root, "gone.pdf"), hasExt: true }, path.join(root, "run.bat")]);
  assert.ok(rs[0] && rs[0].kind === "folder" && rs[0].end === path.join(root, "sub dir").length, "prefix resolve finds the folder");
  assert.ok(rs[1] && rs[1].kind === "file");
  assert.strictEqual(rs[2], null);
  assert.strictEqual(rs[3], null, "bat never resolves");
  assert.deepStrictEqual(op.resolve("nope"), [], "non-array is empty");

  // open: calls shell.openPath only for good paths, logs, rate-limits
  assert.deepStrictEqual(await op.open(path.join(root, "r.pdf")), { ok: true, kind: "file" });
  assert.deepStrictEqual(calls, [fs.realpathSync.native(path.join(root, "r.pdf"))]);
  assert.ok(logs.some((l) => l.startsWith("OPENED file ")));
  const before = calls.length;
  assert.strictEqual((await op.open(path.join(root, "run.bat"))).ok, false);
  assert.strictEqual((await op.open(path.join(outside, "secret.pdf"))).ok, false);
  assert.strictEqual(calls.length, before, "refused paths never reach shell.openPath");
  assert.ok(logs.some((l) => l.startsWith("REFUSED")));
  let clock = 0;
  const lim = mk({ now: () => clock, maxOpens: 3, windowMs: 1000 });
  for (let i = 0; i < 3; i++) assert.ok((await lim.open(path.join(root, "r.pdf"))).ok);
  assert.ok(!(await lim.open(path.join(root, "r.pdf"))).ok, "4th open inside the window is rate limited");
  clock = 2000;
  assert.ok((await lim.open(path.join(root, "r.pdf"))).ok, "allowed again after the window");
  const failing = mk({ shell: { openPath: async () => "no app" } });
  assert.strictEqual((await failing.open(path.join(root, "r.pdf"))).ok, false);

  fs.rmSync(base, { recursive: true, force: true });
  console.log("clickablePaths: OK");
})().catch((e) => { console.error(e); try { fs.rmSync(base, { recursive: true, force: true }); } catch (x) { /* ignore */ } process.exit(1); });
