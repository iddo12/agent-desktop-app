// node tests/bugReport.test.js - "Report a problem" (v1.123.0): the scrubber, what is written, the zip, the IPC handlers, the dialog's static rules.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), cp = require("child_process");
const br = require("../src/bugReport");
const brMain = require("../src/bugReportMain");
const ring = require("../src/appLogRing");
const SRC = path.join(__dirname, "..", "src");
const rd = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adbugreport-"));
let seq = 0;
const mk = (name) => { const d = path.join(tmp, name + (++seq)); fs.mkdirSync(d, { recursive: true }); return d; };
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ---- fake secrets, one or more of each kind. NEEDLES are the fragments that must never survive anywhere.
const USER = "Samuel", HOST = "ALEX-DESKTOP-9";
const S = {
  email: "sam.fake@example.org", hex: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c", b64: "dGhpcy1pcy1hLWZha2Utc2VjcmV0LWtleS0xMjM0NTY3OA==",
  b64url: "Zm9vQmFyQmF6X1F1eC1TZWNyZXRLZXktMDk4NzY1NDMyMQ", ghp: "ghp_FAKEFAKEFAKEFAKE1234", sk: "sk-FAKEfakeFAKE12345", xox: "xoxb-1234-FAKEFAKE", ip1: "192.168.1.77", ip2: "10.0.5.9", ip3: "172.20.3.4",
  bearer: "Bearer abc.def.ghi-fake-value", cookie: "sessionid=FAKECOOKIEVALUE123", pw: "hunter2fake", win: "C:\\Users\\" + USER + "\\Documents\\plan.txt", winJson: "C:\\\\Users\\\\" + USER + "\\\\AppData",
};
const NEEDLES = [USER, HOST, S.email, S.hex, S.b64.slice(0, 30), S.b64url, "ghp_FAKE", "sk-FAKE", "xoxb-1234", S.ip1, S.ip2, S.ip3, "abc.def.ghi-fake-value", "FAKECOOKIEVALUE123", S.pw, "hunter2fake"];
const plant = (label) => [
  label + " mail " + S.email + " host " + HOST, "user " + USER + " path " + S.win + " json " + S.winJson,
  "hex " + S.hex + " b64 " + S.b64 + " b64url " + S.b64url, "tokens " + S.ghp + " " + S.sk + " " + S.xox, "net " + S.ip1 + " " + S.ip2 + " " + S.ip3,
  "Authorization: " + S.bearer, "Cookie: " + S.cookie, "password=" + S.pw,
].join("\n");

function fixtureEnv(over) {
  const ud = mk("ud");
  fs.writeFileSync(path.join(ud, "runtime.json"), JSON.stringify({ version: "9.9.9", note: plant("runtime") }, null, 2));
  fs.writeFileSync(path.join(ud, "startup-timing.json"), plant("timing"));
  fs.writeFileSync(path.join(ud, "dep-doctor.json"), JSON.stringify({ state: "failed", error: plant("depdoc") }));
  fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify({
    schema: 1, values: { workspaceRoot: "D:\\Work\\" + USER + "\\space", ownerName: USER, setupLang: "he", apiToken: S.ghp, mailPassword: S.pw, note: plant("cfg") },
    features: { iris: { enabled: true, consentAt: "2026-10-14T10:00:00Z", pairingKey: S.hex } },
  }));
  fs.writeFileSync(path.join(ud, "orphan-reaper.log"), plant("diag") + "\n");
  // decoys that must never be read
  fs.writeFileSync(path.join(ud, "conversation.jsonl"), "SENTINEL-CONVERSATION\n");
  fs.writeFileSync(path.join(ud, "iris-keys.json"), "SENTINEL-IRIS-KEY\n");
  fs.mkdirSync(path.join(ud, "agents")); fs.writeFileSync(path.join(ud, "agents", "mail.txt"), "SENTINEL-MAIL\n");
  return Object.assign({
    userDataDir: ud, appVersion: "9.9.9", gitCommit: "abc1234", claudeVersion: "2.0.0 " + S.email, windows: "Windows_NT 10.0.19045 (x64)", ramGb: 32, nodeVersion: "v24.0.0", electronVersion: "40.0.0",
    user: USER, host: HOST, names: [],
    featureStates: [{ id: "argus", state: "needs-attention", reason: plant("feature") }, { id: "voice", state: "ready", reason: "" }],
    appLog: Array.from({ length: 450 }, (_, i) => "line " + i + (i === 449 ? "\n" + plant("log") : "")), terminalTail: Array.from({ length: 40 }, (_, i) => "term " + i).join("\n") + "\n" + plant("term"), terminalAgent: "Helper " + S.email,
  }, over || {});
}
const input = (o) => Object.assign({ what: plant("what"), steps: plant("steps"), include: {} }, o || {});
const listDir = (d) => fs.readdirSync(d).sort();
function writeAll(inp, env) { const b = br.build(inp, env); assert.ok(b.ok, JSON.stringify(b)); const dest = mk("dest"); const w = br.write(b, dest); assert.ok(w.ok, JSON.stringify(w)); return { b, w, dest }; }
function everythingWritten(w) {
  const out = []; for (const f of listDir(w.dir)) out.push([f, fs.readFileSync(path.join(w.dir, f))]);
  for (const e of br.readZip(fs.readFileSync(w.zip))) out.push(["zip:" + e.name, e.data]); return out;
}

// ---- scrubber, one kind at a time
const ctx = { user: USER, host: HOST, names: [] };
t("scrub: user name, machine name (any case), e-mail", () => {
  assert.ok(!/samuel/i.test(br.scrub("hello Samuel and SAMUEL", ctx)));
  assert.ok(!/alex-desktop/i.test(br.scrub("on alex-desktop-9 now", ctx)));
  assert.strictEqual(br.scrub("mail a.b+c@x-y.example.com now", ctx), "mail <email> now");
});
t("scrub: hex and base64 strings of 24+ characters (and leaves short ids and normal words alone)", () => {
  for (const v of [S.hex, S.b64, S.b64url, "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"]) assert.ok(!br.scrub("k=" + v + " end", ctx).includes(v.slice(0, 20)), v);
  assert.strictEqual(br.scrub("commit abc1234 version 1.123.0 setup-strings", ctx), "commit abc1234 version 1.123.0 setup-strings");
});
t("scrub: Windows paths under the user profile (plain, JSON-escaped, forward slashes, any user)", () => {
  for (const p of [S.win, S.winJson, "C:/Users/" + USER + "/x", "D:\\Users\\SomeoneElse\\y"]) { const r = br.scrub("at " + p, ctx); assert.ok(!/samuel|someoneelse/i.test(r), r); assert.ok(r.includes("<userprofile>"), r); }
  assert.ok(br.scrub("C:\\Program Files\\App\\x", ctx).includes("Program Files"));
});
t("scrub: IPv4 addresses (private, public, Tailscale); loopback stays", () => {
  for (const ip of [S.ip1, S.ip2, S.ip3, "169.254.1.2"]) assert.ok(!br.scrub("ip " + ip, ctx).includes(ip), ip);
  assert.ok(!br.scrub("ip 8.8.8.8", ctx).includes("8.8.8.8")); assert.ok(br.scrub("ip 127.0.0.1", ctx).includes("127.0.0.1"));
});
t("scrub: tokens ghp_ sk- xox, Authorization/Bearer, cookie headers, key=value secrets", () => {
  for (const v of [S.ghp, S.sk, S.xox]) assert.ok(!br.scrub("t " + v, ctx).includes(v.slice(0, 8)), v);
  assert.ok(!br.scrub("Authorization: " + S.bearer, ctx).includes("ghi-fake"));
  assert.ok(!br.scrub("curl -H 'Authorization: Bearer abc.def.ghi-fake-value'", ctx).includes("ghi-fake"));
  assert.ok(!br.scrub("Cookie: " + S.cookie + "; other=1", ctx).includes("FAKECOOKIE"));
  assert.ok(!br.scrub("Set-Cookie: " + S.cookie, ctx).includes("FAKECOOKIE"));
  assert.ok(!br.scrub('{"password": "' + S.pw + '"}', ctx).includes(S.pw));
  assert.ok(!br.scrub("api_key=" + S.pw, ctx).includes(S.pw));
});
t("scrub: non-strings and empty input are safe", () => { assert.strictEqual(br.scrub(null, ctx), ""); assert.strictEqual(br.scrub(undefined), ""); assert.strictEqual(br.scrub(42, ctx), "42"); });

// ---- the fixture: fake secrets planted in EVERY source, asserted on the files that were written (and the zip)
t("fixture: no planted secret survives in any written file or in the zip", () => {
  const env = fixtureEnv(), { w } = writeAll(input({ include: { terminal: true } }), env);
  const all = everythingWritten(w);
  assert.ok(all.length >= 18, String(all.length));
  for (const [name, data] of all) { const txt = data.toString("utf8").toLowerCase(); for (const n of NEEDLES) assert.ok(!txt.includes(n.toLowerCase()), name + " still contains " + n); }
});
t("fixture: the useful facts are still there (version, commit, state with reason, the problem text)", () => {
  const { w } = writeAll(input({ what: "The panel is blank after start" }), fixtureEnv());
  const rep = fs.readFileSync(path.join(w.dir, "report.md"), "utf8");
  assert.ok(/Agent Desktop version: 9\.9\.9/.test(rep) && /abc1234/.test(rep) && /32 GB/.test(rep) && /The panel is blank after start/.test(rep));
  assert.ok(/argus: needs-attention - /.test(fs.readFileSync(path.join(w.dir, "feature-states.txt"), "utf8")));
});
t("app-config: paths lose the drive letter, secrets and consent times are only yes/no, free text is hidden", () => {
  const { w } = writeAll(input(), fixtureEnv());
  const c = JSON.parse(fs.readFileSync(path.join(w.dir, "app-config-reduced.json"), "utf8"));
  assert.strictEqual(c.values.workspaceRoot, "\\...\\space");
  assert.strictEqual(c.values.apiToken, "(set)"); assert.strictEqual(c.values.mailPassword, "(set)"); assert.strictEqual(c.values.ownerName, "(set)"); assert.strictEqual(c.values.setupLang, "he");
  assert.strictEqual(c.features.iris.consentAt, "yes"); assert.strictEqual(c.features.iris.pairingKey, "(set)"); assert.strictEqual(c.features.iris.enabled, true);
});
t("log: only the last 300 lines of the app log", () => {
  const { w } = writeAll(input(), fixtureEnv());
  const txt = fs.readFileSync(path.join(w.dir, "app-log.txt"), "utf8");
  assert.ok(!/^line 100$/m.test(txt)); assert.ok(!/^line 149$/m.test(txt)); assert.ok(/^line 448$/m.test(txt)); assert.ok(/^line 449$/m.test(txt)); assert.ok(txt.split(String.fromCharCode(10)).length <= 302);
});
t("terminal: off by default; when ticked only the last 20 lines", () => {
  const e = fixtureEnv();
  assert.ok(!listDir(writeAll(input(), e).w.dir).includes("terminal-tail.txt"));
  const { w } = writeAll(input({ include: { terminal: true } }), e);
  const txt = fs.readFileSync(path.join(w.dir, "terminal-tail.txt"), "utf8");
    const termLines = txt.split("\n").filter((l) => /^term \d+$/.test(l));
  assert.ok(termLines.length <= 20, String(termLines.length)); assert.ok(!termLines.includes("term 0"));
});

// ---- allow-list, preview == written, zip
t("allow-list: only the listed file names are written; decoys in the data folder are never read", () => {
  const env = fixtureEnv(), res = writeAll(input(), env), w = res.w;
  const names = listDir(w.dir);
  for (const n of names) assert.ok(br.ALLOWED_NAMES.test(n), n);
  assert.deepStrictEqual(names, ["app-config-reduced.json", "app-log.txt", "dep-doctor.json", "diag-orphan-reaper.log.txt", "feature-states.txt", "report.md", "runtime.json", "startup-timing.json"]);
  for (const [name, data] of everythingWritten(w)) assert.ok(!/SENTINEL/.test(data.toString("latin1")), name);
  for (const bad of ["conversation.jsonl", "iris-keys.json", "../x.txt", "report.md.exe", "diag-other.txt", "screenshot.exe"]) assert.ok(!br.ALLOWED_NAMES.test(bad), bad);
  assert.deepStrictEqual(listDir(res.dest), [path.basename(w.dir), path.basename(w.dir) + ".zip"].sort());
});
t("allow-list: write() refuses a bundle holding a file name that is not on the list", () => {
  const b = br.build(input(), fixtureEnv()); b.files.push({ name: "conversation.jsonl", item: "x", text: "x", data: Buffer.from("x") });
  const r = br.write(b, mk("dest")); assert.strictEqual(r.ok, false); assert.strictEqual(r.error, "not-allowed-file");
});
t("preview equals what is written, byte for byte", () => {
  const env = fixtureEnv(), b = br.build(input({ include: { terminal: true } }), env), pv = br.previewOf(b);
  const dest = mk("dest"), w = br.write(b, dest);
  assert.strictEqual(pv.length, listDir(w.dir).length);
  for (const p of pv) assert.strictEqual(fs.readFileSync(path.join(w.dir, p.name), "utf8"), p.text, p.name);
});
t("zip: opens, lists exactly the files of the folder (under one top folder), contents identical; PowerShell can expand it", () => {
  const { w } = writeAll(input({ include: { terminal: true } }), fixtureEnv());
  const ents = br.readZip(fs.readFileSync(w.zip)), base = path.basename(w.dir);
  assert.deepStrictEqual(ents.map((e) => e.name).sort(), listDir(w.dir).map((n) => base + "/" + n).sort());
  for (const e of ents) assert.ok(e.data.equals(fs.readFileSync(path.join(w.dir, e.name.split("/")[1]))));
  if (process.platform === "win32") {
    const out = mk("unz");
    const r = cp.spawnSync("powershell", ["-NoProfile", "-Command", "Expand-Archive -LiteralPath '" + w.zip + "' -DestinationPath '" + out + "' -Force"], { encoding: "utf8", windowsHide: true });
    assert.strictEqual(r.status, 0, r.stderr); assert.deepStrictEqual(listDir(path.join(out, base)), listDir(w.dir));
  }
});
t("screenshot: only a picture the caller names; wrong type, missing or too big is refused; copied as screenshot.<ext>", () => {
  const d = mk("shots"), png = path.join(d, "a.png"); fs.writeFileSync(png, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const { w } = writeAll(input({ include: { screenshot: true } }), fixtureEnv({ screenshotPath: png }));
  assert.ok(fs.readFileSync(path.join(w.dir, "screenshot.png")).equals(fs.readFileSync(png)));
  const exe = path.join(d, "a.exe"); fs.writeFileSync(exe, "x");
  assert.strictEqual(br.build(input({ include: { screenshot: true } }), fixtureEnv({ screenshotPath: exe })).error, "screenshot-type");
  assert.strictEqual(br.build(input({ include: { screenshot: true } }), fixtureEnv({ screenshotPath: path.join(d, "none.png") })).error, "screenshot-missing");
  assert.strictEqual(br.build(input({ include: { screenshot: true } }), fixtureEnv({ screenshotPath: d })).ok, false);
});

// ---- destination folder
t("destination: no '..', must exist and be a folder, no UNC, no device path", () => {
  const ok = mk("ok"); assert.ok(br.validateDestDir(ok).ok);
  const file = path.join(ok, "f.txt"); fs.writeFileSync(file, "x");
  for (const bad of [ok + path.sep + ".." + path.sep + "x", "relative\\dir", "\\\\server\\share\\x", "//server/share", "\\\\?\\C:\\x", "\\\\.\\C:\\x", path.join(ok, "missing"), file, "", null, 5, "C:\\CON", "C:\\x\\NUL.txt", ok + "\0x", "C:\\a:stream"]) {
    assert.strictEqual(br.validateDestDir(bad).ok, false, String(bad));
  }
  assert.strictEqual(br.write(br.build(input(), fixtureEnv()), "relative").ok, false);
});

// ---- static: no network, dialog rules
t("no network: bugReport.js, bugReportMain.js and appLogRing.js never load http/https/net/tls/dgram/dns/child_process/electron or call fetch/XHR/WebSocket", () => {
  for (const f of ["bugReport.js", "bugReportMain.js", "appLogRing.js"]) {
    const s = strip(rd(f));
    for (const m of s.match(/require\(\s*["'][^"']+["']\s*\)/g) || []) assert.ok(/^require\(\s*["'](?:fs|path|os|zlib|util|\.\/bugReport|\.\/appLogRing)["']\s*\)$/.test(m), f + ": " + m);
    assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b|\bimport\s*\(|\bhttps?\b\s*\.|net\.connect|child_process/.test(s), f);
  }
});
t("main.js hands the module only what it needs: bug-report channels exist, nothing sends the report anywhere", () => {
  const m = rd("bugReportMain.js");
  for (const c of ["bug-report-info", "bug-report-pick-folder", "bug-report-pick-screenshot", "bug-report-preview", "bug-report-create", "bug-report-open-folder"]) assert.ok(m.includes('"' + c + '"'), c);
  const p = rd("preload.js"); for (const c of ["bug-report-info", "bug-report-preview", "bug-report-create"]) assert.ok(p.includes(c), c);
});
t("dialog: no innerHTML/eval/timers, textContent only, no path built in the renderer, strings in EN + HE with RTL", () => {
  const js = strip(rd("renderer", "bug-report.js"));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setTimeout|setInterval/.test(js)); assert.ok(/textContent/.test(js));
  assert.ok(!/path\.join|[A-Za-z]:\\\\|\\\\\\\\/.test(js));
  const BS = require("../src/renderer/bug-report-strings");
  assert.strictEqual(BS.lang.he.dir, "rtl"); assert.strictEqual(BS.lang.en.dir, "ltr");
  const keys = (o, p) => Object.keys(o).flatMap((k) => (o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) ? keys(o[k], p + k + ".") : [p + k]));
  assert.deepStrictEqual(keys(BS.lang.he, "").sort(), keys(BS.lang.en, "").sort());
  for (const it of br.ITEMS) for (const l of ["en", "he"]) assert.ok(BS.lang[l].items[it.id] && BS.lang[l].items[it.id].length === 2, l + " " + it.id);
  for (const k of Object.keys(BS.lang.en.errors)) assert.ok(BS.lang.he.errors[k], k);
  assert.ok(/[\u0590-\u05FF]/.test(BS.lang.he.title));
});
t("Setup panel header has the button; index.html loads strings before the dialog script; preload exposes bugReport", () => {
  assert.ok(/window\.BugReport\.open\(code\)/.test(rd("renderer", "setup.js")));
  const h = rd("renderer", "index.html"); assert.ok(h.indexOf("bug-report-strings.js") > 0 && h.indexOf("bug-report-strings.js") < h.indexOf("bug-report.js") && /styles-bug-report\.css/.test(h));
  assert.ok(/bugReport: \{/.test(rd("preload.js")));
});
t("appLogRing: keeps at most 400 lines, still calls the real console", () => {
  const seen = []; const con = { log: (...a) => seen.push(a.join(" ")), info() {}, warn() {}, error() {} };
  ring.install(con); for (let i = 0; i < 500; i++) con.log("x" + i);
  assert.strictEqual(seen.length, 500); const g = ring.get(); assert.ok(g.length <= 400); assert.ok(g[g.length - 1].endsWith("x499"));
});

// ---- IPC
function rig(over) {
  const handlers = {}, ipcMain = { handle: (c, f) => { handlers[c] = f; } };
  const frame = { id: "main" }, win = { webContents: { id: 1, mainFrame: frame }, isDestroyed: () => false }, other = { sender: { id: 2 }, senderFrame: { id: "x" } }, main = { sender: win.webContents, senderFrame: frame }, subframe = { sender: win.webContents, senderFrame: { id: "sub" } };
  const env = fixtureEnv(), agents = [{ folderName: "helper", displayName: "Helper", path: "X:/agents/helper" }], tail = { v: "t1\nt2\n" + plant("ipcterm") }, picked = { folder: null, file: null }, opened = [];
  const dialog = { showOpenDialog: async (w, o) => { const p = /openDirectory/.test(JSON.stringify(o.properties)) ? picked.folder : picked.file; return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] }; } };
  const desktop = mk("desktop");
  brMain.register(Object.assign({
    ipcMain, dialog, shell: { showItemInFolder: (p) => opened.push(p) }, getMainWindow: () => win, userDataDir: env.userDataDir, appVersion: "9.9.9", desktopDir: () => desktop,
    listAgents: () => agents, terminalTail: (p) => (p === "X:/agents/helper" ? tail.v : ""),
    featureStates: () => env.featureStates, appLog: () => env.appLog, names: () => [USER, HOST], gitCommit: async () => "abc1234", claudeVersion: async () => "2.0.0",
  }, over || {}));
  return { handlers, main, other, subframe, picked, opened, desktop, win, agents, env, setTail: (x) => { tail.v = x; } };
}
t("IPC: every handler refuses any sender but the main window, and does nothing", async () => {
  const r = rig();
  for (const c of ["bug-report-info", "bug-report-pick-folder", "bug-report-pick-screenshot", "bug-report-preview", "bug-report-create", "bug-report-open-folder"]) {
    assert.deepStrictEqual(await r.handlers[c](r.other, { what: "x" }), { ok: false, error: "not-allowed" }, c);
    assert.deepStrictEqual(await r.handlers[c]({}, {}), { ok: false, error: "not-allowed" }, c);
    assert.deepStrictEqual(await r.handlers[c](undefined, {}), { ok: false, error: "not-allowed" }, c);
  }
  assert.deepStrictEqual(listDir(r.desktop), []); assert.deepStrictEqual(r.opened, []);
  const none = rig({ getMainWindow: () => null }); assert.deepStrictEqual(await none.handlers["bug-report-info"](none.main, {}), { ok: false, error: "not-allowed" });
});
t("IPC: info -> preview -> create writes exactly the previewed files; create without a fresh preview rebuilds", async () => {
  const r = rig();
  const info = await r.handlers["bug-report-info"](r.main, {}); assert.ok(info.ok); assert.strictEqual(info.defaultDir, r.desktop); assert.deepStrictEqual(info.agents, [{ id: "helper", name: "Helper" }]);
  assert.deepStrictEqual(info.items.filter((i) => !i.always).map((i) => i.id), ["terminal", "screenshot"]);
  const form = { what: "It broke " + S.email, steps: "", include: {} };
  const pv = await r.handlers["bug-report-preview"](r.main, form); assert.ok(pv.ok && pv.previewId > 0);
  const c = await r.handlers["bug-report-create"](r.main, Object.assign({ previewId: pv.previewId }, form)); assert.ok(c.ok, JSON.stringify(c));
  for (const p of pv.files) assert.strictEqual(fs.readFileSync(path.join(c.dir, p.name), "utf8"), p.text);
  assert.ok(!fs.readFileSync(path.join(c.dir, "report.md"), "utf8").includes(S.email));
  assert.ok(fs.existsSync(c.zip)); assert.deepStrictEqual((await r.handlers["bug-report-open-folder"](r.main, {})), { ok: true }); assert.deepStrictEqual(r.opened, [c.dir]);
  const c2 = await r.handlers["bug-report-create"](r.main, { include: {}, what: "second" }); assert.ok(c2.ok && c2.dir !== c.dir);
});
t("IPC: a destDir sent by the renderer is IGNORED: the report goes to main's own folder (default Desktop), never there", async () => {
  const r = rig(); const elsewhere = mk("elsewhere");
  for (const bad of [elsewhere, r.desktop + path.sep + ".." + path.sep + "esc", "\\\\server\\share", "\\\\?\\C:\\x", "relative", 7, undefined]) {
    const x = await r.handlers["bug-report-create"](r.main, { what: "x", include: {}, destDir: bad }); assert.ok(x.ok, String(bad));
    assert.strictEqual(path.dirname(x.dir), path.resolve(r.desktop), String(bad));
  }
  assert.deepStrictEqual(listDir(elsewhere), []);
  // only the folder main's own dialog returned changes the destination, and only for this dialog session (info resets it)
  const picked = mk("picked"); r.picked.folder = picked;
  assert.deepStrictEqual(await r.handlers["bug-report-pick-folder"](r.main, {}), { ok: true, path: path.resolve(picked) });
  const y = await r.handlers["bug-report-create"](r.main, { what: "y", include: {}, destDir: elsewhere }); assert.strictEqual(path.dirname(y.dir), path.resolve(picked)); assert.deepStrictEqual(listDir(elsewhere), []);
  await r.handlers["bug-report-info"](r.main, {});
  const z = await r.handlers["bug-report-create"](r.main, { what: "z", include: {} }); assert.strictEqual(path.dirname(z.dir), path.resolve(r.desktop));
  // a dialog answer that is not a usable folder is refused and changes nothing
  r.picked.folder = "\\\\server\\share"; assert.strictEqual((await r.handlers["bug-report-pick-folder"](r.main, {})).ok, false);
});
t("IPC: terminal needs a known agent id and a preview the person saw; the text written is that preview, never a fresh read", async () => {
  const r = rig();
  const base = { what: "x" };
  assert.strictEqual((await r.handlers["bug-report-create"](r.main, Object.assign({ include: { terminal: true }, agentId: "../../etc" }, base))).error, "agent-unknown");
  assert.strictEqual((await r.handlers["bug-report-create"](r.main, Object.assign({ include: { terminal: true }, agentId: "X:/agents/helper" }, base))).error, "agent-unknown");
  // F6: ticked but never previewed: refused, nothing written
  assert.strictEqual((await r.handlers["bug-report-create"](r.main, Object.assign({ include: { terminal: true }, agentId: "helper" }, base))).error, "preview-required");
  assert.deepStrictEqual(listDir(r.desktop), []);
  const pv = await r.handlers["bug-report-preview"](r.main, Object.assign({ include: { terminal: true }, agentId: "helper" }, base)); assert.ok(pv.ok);
  const shown = pv.files.find((f) => f.name === "terminal-tail.txt").text;
  r.setTail("NEWER CONVERSATION LINE " + plant("later"));            // the terminal moves on after the person looked
  const ok = await r.handlers["bug-report-create"](r.main, Object.assign({ include: { terminal: true }, agentId: "helper", previewId: 0, what: "edited text" }, {})); assert.ok(ok.ok, JSON.stringify(ok));
  const tt = fs.readFileSync(path.join(ok.dir, "terminal-tail.txt"), "utf8"); assert.strictEqual(tt, shown); assert.ok(!/NEWER/.test(tt)); assert.ok(/t1/.test(tt));
  for (const n of NEEDLES) assert.ok(!tt.toLowerCase().includes(n.toLowerCase()), n);
  // a preview for one agent does not license another
  r.agents.push({ folderName: "other", displayName: "Other", path: "X:/agents/other" });
  assert.strictEqual((await r.handlers["bug-report-create"](r.main, Object.assign({ include: { terminal: true }, agentId: "other" }, base))).error, "preview-required");
  // a "screenshot" with no dialog pick is simply not included, and a path field sent by the renderer is ignored
  const noShot = await r.handlers["bug-report-create"](r.main, Object.assign({ include: { screenshot: true }, screenshotPath: path.join(r.desktop, "x.png") }, base)); assert.ok(noShot.ok); assert.ok(!listDir(noShot.dir).some((n) => /^screenshot/.test(n)));
  const png = path.join(mk("pic"), "p.png"); fs.writeFileSync(png, "PNGDATA"); r.picked.file = png;
  const pick = await r.handlers["bug-report-pick-screenshot"](r.main, {}); assert.deepStrictEqual(pick, { ok: true, name: "p.png", size: 7 });
  const withShot = await r.handlers["bug-report-create"](r.main, Object.assign({ include: { screenshot: true } }, base)); assert.ok(withShot.ok); assert.ok(listDir(withShot.dir).includes("screenshot.png"));
  const exe = path.join(mk("pic"), "p.exe"); fs.writeFileSync(exe, "x"); r.picked.file = exe; assert.strictEqual((await r.handlers["bug-report-pick-screenshot"](r.main, {})).error, "screenshot-type");
  assert.ok((await r.handlers["bug-report-pick-screenshot"](r.main, { clear: true })).cleared);
});
t("IPC (F11): a sub-frame of the main window is refused too", async () => {
  const r = rig();
  for (const c of ["bug-report-info", "bug-report-pick-folder", "bug-report-pick-screenshot", "bug-report-preview", "bug-report-create", "bug-report-open-folder"]) {
    assert.deepStrictEqual(await r.handlers[c](r.subframe, { what: "x" }), { ok: false, error: "not-allowed" }, c);
    assert.deepStrictEqual(await r.handlers[c]({ sender: r.win.webContents }, { what: "x" }), { ok: false, error: "not-allowed" }, c + " (no frame)");
  }
  assert.deepStrictEqual(listDir(r.desktop), []);
});
t("IPC (F9): agent folder and display names become stable aliases in the log, the terminal and the typed text", async () => {
  const r = rig(); r.setTail('agent Helper wrote to "helper" and Zed_Agent and C:\\agents\\Zed today');
  r.agents.push({ folderName: "Zed_Agent", displayName: "Zed", path: "X:/agents/zed" });
  r.env.appLog.push("started agent helper in X:/agents/Zed_Agent folder");
  const pv = await r.handlers["bug-report-preview"](r.main, { what: "the agent Helper froze after Zed_Agent answered", include: { terminal: true }, agentId: "helper" }); assert.ok(pv.ok);
  const all = pv.files.map((f) => f.text || "").join("\n");
  assert.ok(!/helper/i.test(all.replace(/agent-\d/g, "")), "agent name survived: " + all); assert.ok(!/Zed/.test(all.replace(/agent-\d/g, ""))); assert.ok(/agent-1/.test(all) && /agent-2/.test(all));
  // plain words that merely equal an agent name stay readable
  const plain = br.scrub("Security update: Sales are up; the helper app", { aliases: [["Security", "agent-1"], ["Sales", "agent-2"], ["helper", "agent-3"]] });
  assert.strictEqual(plain, "Security update: Sales are up; the helper app");
  assert.strictEqual(br.scrub("started agent Sales in C:\\work\\Security\\x", { aliases: [["Security", "agent-1"], ["Sales", "agent-2"]] }), "started agent agent-2 in C:\\work\\agent-1\\x");
});

// ---- the security review (F1-F8, F10): one test per failing input, asserted on the written files as well as on scrub()
const REVIEW_USER = "jdoe", REVIEW_HOST = "WORKPC01";
const rctx = { user: REVIEW_USER, host: REVIEW_HOST, homedir: "C:\\Users\\Jane Q Public", names: ["דן"] };
function viaFiles(textLines, extraEnv) {   // plant the lines in the typed text, the log, the terminal and a status file; return everything written, lowercased
  const env = fixtureEnv(Object.assign({ user: REVIEW_USER, host: REVIEW_HOST, names: [], appLog: textLines, terminalTail: textLines.join("\n") }, extraEnv || {}));
  fs.writeFileSync(path.join(env.userDataDir, "runtime.json"), JSON.stringify({ lines: textLines }));
  const { w } = writeAll(input({ what: textLines.join("\n"), steps: textLines.join("\n"), include: { terminal: true } }), env);
  return everythingWritten(w).filter(([n]) => !/\.zip|^zip:/.test(n) || true).map(([n, d]) => [n, d.toString("utf8")]);
}
function mustNotSurvive(lines, needles, extraEnv) {
  for (const x of needles) assert.ok(!br.scrub(lines.join("\n"), rctx).includes(x), "scrub() kept " + x);
  for (const [name, txt] of viaFiles(lines, extraEnv)) for (const x of needles) assert.ok(!txt.includes(x), name + " kept " + x);
}
t("F1: credentials in URLs for any host, with or without a dot", () => {
  mustNotSurvive(["http://user:pw1xyz@localhost:8080/x", "postgres://dbuser:pw2xyz@db/x", "ftp://anon:abcdXY@NAS01/share", "https://admin:hunter2zz@example.com/p", "https://tokenonlyQ@github.com/a/b.git"], ["pw1xyz", "pw2xyz", "abcdXY", "hunter2zz", "tokenonlyQ", "dbuser"]);
});
t("F2: profile folder names with spaces or non-Latin letters (known or unknown to the app)", () => {
  const lines = ["C:\\Users\\Jane Q Public\\Desktop\\a.txt", "C:\\Users\\דני כהן\\Documents\\a.txt", "C:\\Users\\jane doe\\x", "D:\\Users\\Mary Ann Smith-Lee\\AppData", "C:\\\\Users\\\\Jane Q Public\\\\y", "C:/Users/Hans Müller/z"];
  mustNotSurvive(lines, ["Jane", "Public", "דני", "כהן", "doe", "Mary", "Smith", "Hans", "Müller"], { homedir: "C:\\Users\\Jane Q Public" });
  for (const x of ["Q Public", "כהן", "doe\\x", "Ann"]) assert.ok(!br.scrub(lines.join("\n"), {}).includes(x), "unknown-name case kept " + x);
  assert.ok(!br.scrub("see C:\\Users\\Jane Q Public now", { homedir: "C:\\Users\\Jane Q Public" }).includes("Public"));
});
t("F3: secret-ish key names, command-line flags, query-string secrets", () => {
  const lines = ["SECRET_KEY=sk1abcd", "authKey=ak2abcd", "DB_PWD=pw3abcd", "MY_SECRET_THING = st4abcd", "--password hunter5abc", "claude --api-key key6abc123def --token tok7zzzz", "https://x.com/a?sig=sg8abc123&X-Amz-Signature=am9abc123", "/cb?code=4/0cd10AbCdEf&state=stt11xyz", "sig=plain12sig", "export GH_TOKEN=gh13abcdef", '{"clientSecret": "cs14abcdef"}', "refresh_token=rt15abcdef"];
  mustNotSurvive(lines, ["sk1abcd", "ak2abcd", "pw3abcd", "st4abcd", "hunter5abc", "key6abc123def", "tok7zzzz", "sg8abc123", "am9abc123", "0cd10AbCdEf", "stt11xyz", "plain12sig", "gh13abcdef", "cs14abcdef", "rt15abcdef"]);
  // ordinary words that merely contain a keyword are not damaged
  const ok = br.scrub("status=ready author=Sam design=blue passed=3 state: ready", rctx); assert.ok(/status=ready/.test(ok) && /design=blue/.test(ok) && /state: ready/.test(ok), ok);
});
t("F4: Google, npm, Stripe, ya29, SendGrid, Discord, Slack webhook, private key blocks", () => {
  const lines = ["GOCSPX-abcdefghijklmnop", "npm_AbCdEfGhIjKlMnOpQrStUv", "sk_live_abcdEFGH1234", "pk_test_abcdEFGH1234", "rk_live_abcdEFGH1234", "ya29.a0AfH6SMBshort", "1//0gAbCdEfGhIjKlMnOpQrStUvWx", "SG.abcdefgh.ijklmnop12",
    ["MTAxNTkyMzQ1Njc4OTAxMjM0NQ", "GabcDE", "abcdefghijklmnopqrstuvwxyz1"].join("."), "https://hooks.slack.com/services/T0000/B0000/abcdEFGHijkl",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nxyz\n-----END RSA PRIVATE KEY-----"];
  mustNotSurvive(lines, ["abcdefghijklmnop", "AbCdEfGhIjKlMnOpQrStUv", "abcdEFGH1234", "a0AfH6SMBshort", "0gAbCdEfGhIjKl", "ijklmnop12", "GabcDE", "T0000/B0000", "MIIabc", "BEGIN RSA PRIVATE KEY"]);
});
t("F7: short names (2-3 characters, Hebrew too) are scrubbed as whole tokens only", () => {
  const c = { user: "jo", host: "PC", names: ["דן", "Al"] };
  const r = br.scrub("שלום דן כהן, user jo and Al met; PC down. Also donkey, alpha, Jordan, Project, דנה", c);
  for (const x of [" דן ", " jo ", " Al ", "PC down"]) assert.ok(!(" " + r + " ").includes(x), x + " in " + r);
  for (const x of ["donkey", "alpha", "Jordan", "Project", "דנה"]) assert.ok(r.includes(x), "over-redacted " + x + " in " + r);
  const lines = ["שלום דן כהן ביקר"]; for (const [n, txt] of viaFiles(lines, { names: ["דן"] })) assert.ok(!/(^|\s)דן(\s|$)/.test(txt), n);
});
t("F8: public IPv4/IPv6, MAC, Tailscale, UNC servers, WSL, URL-encoded paths, phone numbers and card-like numbers", () => {
  const lines = ["8.8.8.8", "203.0.113.7", "100.101.102.103", "2001:db8:85a3::8a2e:370:7334", "fe80::1ff:fe23:4567:890a%12", "aa:bb:cc:dd:ee:ff", "AA-BB-CC-DD-EE-FF", "\\\\NAS01\\home\\bob\\file", "\\\\wsl$\\Ubuntu\\home\\jane\\x", "C%3A%5CUsers%5Cjdoe%5Cx", "+972-50-123-4567", "050-123-4567", "4111 1111 1111 1111"];
  mustNotSurvive(lines, ["8.8.8.8", "203.0.113.7", "100.101.102.103", "db8:85a3", "1ff:fe23", "aa:bb:cc", "AA-BB-CC", "NAS01", "Ubuntu", "jane", "%5Cjdoe", "972-50", "123-4567", "4111 1111"]);
});
t("F8: versions, timestamps, loopback, C++ scopes and ordinary numbers are NOT damaged", () => {
  const keep = ["v1.123.0", "Agent Desktop version: 1.123.0", "Windows_NT 10.0.19045 (x64)", "Chrome 142.0.7444.162", "2026-10-14T12:30:45.123Z", "12:30:45", "127.0.0.1", "::1", "std::vector<int>", "Foo::bar", "3 files, 1200 ms, 2026-10-14", "build 20261014-1230", "node v24.19.0", "1.2.3"];
  for (const k of keep) assert.strictEqual(br.scrub(k, rctx), k, k);
  const { w } = writeAll(input({ what: "version 1.123.0 at 2026-10-14T12:30:45.123Z" }), fixtureEnv({ user: "x1", host: "y1" }));
  assert.ok(/version 1\.123\.0 at 2026-10-14T12:30:45\.123Z/.test(fs.readFileSync(path.join(w.dir, "report.md"), "utf8")));
});
t("F10: a hostile 100 000-character string scrubs in well under a second; leaves and files are capped", () => {
  const shapes = ["A".repeat(100000), "A-".repeat(50000), "a".repeat(100000) + "@", ("x.".repeat(50000)), "1".repeat(100000), "\\".repeat(100000), "C:\\Users\\" + "a ".repeat(50000), "-----BEGIN PRIVATE KEY-----" + "z".repeat(100000), "password=" + "q".repeat(100000), ":".repeat(100000), "f".repeat(50000) + ":" + "f".repeat(50000)];
  for (const sh of shapes) { const t0 = Date.now(); br.scrub(sh, rctx); const ms = Date.now() - t0; assert.ok(ms < 800, sh.slice(0, 12) + " took " + ms + " ms"); }
  const env = fixtureEnv(); fs.writeFileSync(path.join(env.userDataDir, "app-config.json"), JSON.stringify({ values: { workspaceRoot: "C:\\" + "a".repeat(100000) }, big: "b".repeat(300000) }));
  fs.writeFileSync(path.join(env.userDataDir, "startup-timing.json"), "x".repeat(5000000));
  const t0 = Date.now(), { w } = writeAll(input({ what: "w".repeat(100000) }), env); assert.ok(Date.now() - t0 < 3000, "build took " + (Date.now() - t0));
  for (const [name, data] of everythingWritten(w)) assert.ok(data.length < 120000, name + " is " + data.length + " bytes");
});
t("e-mail rule: still finds addresses (also glued to text and in the middle of long runs)", () => {
  assert.ok(!br.scrub("x=a.b@c.example y", rctx).includes("a.b@")); assert.ok(!br.scrub("mailto:first.last+tag@sub.domain.org,", rctx).includes("first.last"));
});
t("IPC: open-folder opens only the folder this window just created", async () => {
  const r = rig(); assert.strictEqual((await r.handlers["bug-report-open-folder"](r.main, { path: "C:\\Windows" })).ok, false); assert.deepStrictEqual(r.opened, []);
});
t("command line: tools/bug-report.js uses the same module and writes the folder and zip", () => {
  assert.ok(/require\("\.\.\/src\/bugReport"\)/.test(fs.readFileSync(path.join(__dirname, "..", "tools", "bug-report.js"), "utf8")));
  const env = fixtureEnv(), out = mk("cli");
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "bug-report.js"), "--what", "cli test " + S.email, "--userdata", env.userDataDir, "--out", out], { encoding: "utf8", windowsHide: true });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const names = listDir(out); assert.strictEqual(names.length, 2); const dir = path.join(out, names.find((n) => !n.endsWith(".zip")));
  for (const f of listDir(dir)) assert.ok(br.ALLOWED_NAMES.test(f), f);
  assert.ok(!fs.readFileSync(path.join(dir, "report.md"), "utf8").includes(S.email)); assert.ok(!fs.readFileSync(path.join(dir, "runtime.json"), "utf8").includes(S.hex));
});

// ---- the re-review (R1-R5 and the over-redaction items)
const ms = (fn) => { const t0 = Date.now(); fn(); return Date.now() - t0; };
t("R1: no catastrophic back-tracking: repeated 'auth' shapes and every earlier hostile shape scrub in < 100 ms at 20 000 chars", () => {
  const shapes = { authEq: "auth".repeat(5000) + "=", authDash: "auth-".repeat(5000), flag: "--" + "auth".repeat(5000) + " ", authColon: "auth".repeat(5000) + ": x", keyDot: "a.auth".repeat(3000) + "=", longA: "A".repeat(20000), aDash: "A-".repeat(10000), email: "a".repeat(20000) + "@", dots: "x.".repeat(10000), ones: "1".repeat(20000), bs: "\\".repeat(20000), users: "C:\\Users\\" + "a ".repeat(10000), pem: "-----BEGIN PRIVATE KEY-----" + "z".repeat(20000), pw: "password=" + "q".repeat(20000), colons: ":".repeat(20000), ff: "f".repeat(10000) + ":" + "f".repeat(10000), tokens: "token ".repeat(3000), passw: "password".repeat(2500) + "=", sk: "sk-".repeat(6000), uu: "0123456789abcdef-".repeat(1200), eq: "a=".repeat(10000), amp: "?code=&".repeat(3000) };
  for (const k of Object.keys(shapes)) { const t = ms(() => br.scrub(shapes[k], rctx)); assert.ok(t < 100, k + " took " + t + " ms"); }
  for (const k of ["authEq", "authDash", "flag"]) { const t = ms(() => br.scrub(shapes[k].repeat(5), rctx)); assert.ok(t < 600, k + " x5 took " + t + " ms"); }
});
t("R1: the key rules still catch what they caught (auth, token, flag forms)", () => {
  for (const [i, o] of [["authKey=abcd1", "authKey=<redacted>"], ["DB_PWD=abc12", "DB_PWD=<redacted>"], ["claude --api-key abc123def --token zzz", "claude --api-key <redacted> --token <redacted>"], ['"clientSecret": "cs14abcdef"', '"clientSecret": <redacted>'], ["x-csrf-token: abc12", "x-csrf-token: <redacted>"]]) assert.strictEqual(br.scrub(i, {}), o);
  const long = "prefix_" + "x".repeat(40) + "_password=hunter2long"; assert.ok(!br.scrub(long, {}).includes("hunter2long"));
});
t("R2: an e-mail address disappears whole, also when its local part is the user, the owner or an agent name", () => {
  const lines = ["mail jdoe@example.com now", "to security@corp.example", "owner jane.q@private-company.test"];
  const c = { user: "jdoe", host: "WORKPC01", names: ["jane.q"], aliases: [["Security", "agent-1"]] };
  const out = br.scrub(lines.join("\n"), c); for (const x of ["example.com", "corp.example", "private-company", "jdoe", "jane"]) assert.ok(!out.includes(x), x + " in " + out);
  for (const [n, txt] of viaFiles(lines, { aliases: [["Security", "agent-1"]], names: ["jane.q"] })) for (const x of ["example.com", "corp.example", "private-company"]) assert.ok(!txt.includes(x), n + " kept " + x);
});
t("R3: authorization_code and similar OAuth values are redacted; author/authentication words are not damaged", () => {
  const out = br.scrub("authorization_code=abc123XY&authorization-token: q1w2e3 author=Sam authentication=failed", {});
  assert.ok(!/abc123XY|q1w2e3/.test(out), out); assert.ok(/author=Sam/.test(out) && /authentication=failed/.test(out), out);
  for (const [n, txt] of viaFiles(["authorization_code=abc123XY"])) assert.ok(!txt.includes("abc123XY"), n);
});
t("R4: file-server names in smb:// cifs:// nfs:// URLs are scrubbed", () => {
  const out = br.scrub("smb://nas01/home/bob nfs://filer-7/export cifs://user:pw@nas02/x", {}); for (const x of ["nas01", "filer-7", "nas02", "pw"]) assert.ok(!out.includes(x), x + " in " + out);
  for (const [n, txt] of viaFiles(["smb://nas01/home/bob"])) assert.ok(!txt.includes("nas01"), n);
});
t("R5: bug-report-info forgets the previous dialog's terminal text, picture and cached bundle", async () => {
  const r = rig(); const png = path.join(mk("pic"), "p.png"); fs.writeFileSync(png, "PNG"); r.picked.file = png;
  await r.handlers["bug-report-pick-screenshot"](r.main, {});
  const pv = await r.handlers["bug-report-preview"](r.main, { what: "a", include: { terminal: true, screenshot: true }, agentId: "helper" }); assert.ok(pv.ok);
  await r.handlers["bug-report-info"](r.main, {});   // a new dialog opens
  assert.strictEqual((await r.handlers["bug-report-create"](r.main, { what: "b", include: { terminal: true }, agentId: "helper" })).error, "preview-required");
  const c = await r.handlers["bug-report-create"](r.main, { what: "c", include: { screenshot: true }, previewId: pv.previewId }); assert.ok(c.ok); assert.ok(!listDir(c.dir).some((n) => /^screenshot/.test(n)), "old picture reused");
});
t("UUIDs: each distinct id becomes a stable <id-N> within one report (session ids stay correlatable)", () => {
  const a = "3f2b8c1e-9a4d-4e7b-8c21-5d6e7f8a9b0c", b = "11111111-2222-3333-4444-555555555555", c = { user: "x1", host: "y1" };
  const out = br.scrub("session " + a + " start\nsessionId=" + a + " again\nother " + b + " and " + a.toUpperCase(), c);
  assert.ok(!out.includes(a) && !out.includes(b)); assert.strictEqual((out.match(/<id-1>/g) || []).length, 3); assert.strictEqual((out.match(/<id-2>/g) || []).length, 1);
  const { w } = writeAll(input({ what: "id " + a }), fixtureEnv({ appLog: ["s " + a, "s " + b, "s " + a] }));
  const rep = fs.readFileSync(path.join(w.dir, "report.md"), "utf8"), log = fs.readFileSync(path.join(w.dir, "app-log.txt"), "utf8");
  assert.ok(!rep.includes(a) && !log.includes(a) && !log.includes(b)); assert.ok(/id <id-\d+>/.test(rep)); assert.strictEqual(log.trim(), "s <id-1>\ns <id-2>\ns <id-1>");
  assert.strictEqual(br.scrub("token=" + a, {}), "token=<redacted>");   // a UUID that is the value of a secret-named key is still a secret
});
t("code=, state=, pass=, 'tests pass' are ordinary text; the same names inside a URL query are redacted", () => {
  for (const k of ["code=ENOENT", "state=running", "pass=true", "tests pass: 12 passed", "exit code=1 state: idle", "design=blue passes=3"]) assert.strictEqual(br.scrub(k, {}), k, k);
  const out = br.scrub("https://x.com/cb?code=4/0AbCd&state=xyz987&pass=pw123 /a?sig=s1", {}); for (const x of ["4/0AbCd", "xyz987", "pw123", "s1"]) assert.ok(!out.includes(x), x + " in " + out);
});
t("version-like quads after v, /, @, 'version ', 'build ', Electron, Chrome, Node, Claude Code are not IPs; other quads still are", () => {
  for (const k of ["Electron 28.3.1.0", "Claude Code v2.1.5.3", "pkg@1.2.3.4", "Chrome/128.0.6.7", "build 6.5.4.3", "version 10.20.30.40", "node 20.1.2.3"]) assert.strictEqual(br.scrub(k, {}), k, k);
  for (const k of ["ip 10.20.30.40", "connect to 8.8.8.8:53", "from 203.0.113.7"]) assert.ok(/<ip>/.test(br.scrub(k, {})), k);
});

// ---- Windows Controlled Folder Access: the Desktop (or any folder) can refuse writes
function blockingFs(blockedRoot) {
  const real = fs, block = (p) => { const e = path.resolve(String(p)); if (e === path.resolve(blockedRoot) || e.startsWith(path.resolve(blockedRoot) + path.sep)) { const x = new Error("EPERM: operation not permitted"); x.code = "EPERM"; throw x; } };
  return Object.assign(Object.create(real), { mkdirSync: (p, o) => { if (!(o && o.recursive)) block(p); return real.mkdirSync(p, o); }, writeFileSync: (p, ...a) => { block(p); return real.writeFileSync(p, ...a); } });
}
t("Controlled Folder Access: a blocked default folder falls back ONCE to <userData>/bug-reports; the folder holds exactly the allow-listed files and the zip", async () => {
  const desktop = mk("blockeddesktop"); const r = rig({ desktopDir: () => desktop, fs: blockingFs(desktop) });
  const x = await r.handlers["bug-report-create"](r.main, { what: "blocked " + S.email, include: {} });
  assert.ok(x.ok, JSON.stringify(x)); assert.strictEqual(x.fellBack, true); assert.strictEqual(x.reason, "desktop-blocked");
  const own = path.join(r.env.userDataDir, "bug-reports"); assert.strictEqual(path.dirname(x.dir), own);
  assert.deepStrictEqual(listDir(desktop), []);                                   // nothing half-written on the Desktop
  assert.deepStrictEqual(listDir(own), [path.basename(x.dir), path.basename(x.dir) + ".zip"].sort());
  for (const n of listDir(x.dir)) assert.ok(br.ALLOWED_NAMES.test(n), n);
  const ents = br.readZip(fs.readFileSync(x.zip)); assert.deepStrictEqual(ents.map((e) => e.name.split("/")[1]).sort(), listDir(x.dir));
  assert.ok(!fs.readFileSync(path.join(x.dir, "report.md"), "utf8").includes(S.email));
  assert.deepStrictEqual(await r.handlers["bug-report-open-folder"](r.main, {}), { ok: true }); assert.deepStrictEqual(r.opened, [x.dir]);   // Open folder shows the folder actually used
});
t("Controlled Folder Access: a normal write reports no fallback", async () => {
  const r = rig(); const x = await r.handlers["bug-report-create"](r.main, { what: "fine", include: {} });
  assert.ok(x.ok); assert.strictEqual(x.fellBack, undefined); assert.strictEqual(path.dirname(x.dir), path.resolve(r.desktop));
});
t("Controlled Folder Access: a folder the person picked is NOT silently replaced; the answer is cannot-write with the Windows hint", async () => {
  const picked = mk("blockedpick"), r = rig({ fs: blockingFs(picked) });
  r.picked.folder = picked; assert.ok((await r.handlers["bug-report-pick-folder"](r.main, {})).ok);
  const x = await r.handlers["bug-report-create"](r.main, { what: "x", include: {} });
  assert.deepStrictEqual(x, { ok: false, error: "cannot-write", hint: "blocked-by-windows" });
  assert.deepStrictEqual(listDir(picked), []); assert.ok(!fs.existsSync(path.join(r.env.userDataDir, "bug-reports")));
});
t("Controlled Folder Access: if the app's own folder fails too, the original error comes back (no loop, nothing left behind)", async () => {
  const desktop = mk("blockeddesktop2"), r = rig({ desktopDir: () => desktop }), ud = r.env.userDataDir;
  const both = rig({ desktopDir: () => desktop, fs: Object.assign(Object.create(fs), { mkdirSync: (p, o) => { if (String(p).startsWith(path.resolve(desktop)) || String(p).includes("bug-reports")) { const e = new Error("EPERM"); e.code = "EPERM"; throw e; } return fs.mkdirSync(p, o); } }) });
  const x = await both.handlers["bug-report-create"](both.main, { what: "x", include: {} }); assert.strictEqual(x.ok, false); assert.strictEqual(x.error, "cannot-write"); assert.deepStrictEqual(listDir(desktop), []);
});
t("Controlled Folder Access: dialog and strings (EN + HE) carry the Windows hint and the fallback line; Open folder uses the used folder", () => {
  const BS = require("../src/renderer/bug-report-strings");
  for (const l of ["en", "he"]) { assert.ok(BS.lang[l].errors["blocked-by-windows"]); assert.ok(BS.lang[l].fellBack); }
  assert.ok(/Controlled Folder Access/.test(BS.lang.en.errors["blocked-by-windows"]) && /Change\.\.\./.test(BS.lang.en.errors["blocked-by-windows"]) && /Windows Security/.test(BS.lang.en.errors["blocked-by-windows"]));
  assert.strictEqual(BS.lang.en.fellBack, "Saved in the app's own folder because Windows blocked the Desktop.");
  const js = rd("renderer", "bug-report.js"); assert.ok(/r\.fellBack/.test(js) && /r\.hint/.test(js) && /r\.dir/.test(js));
});

(async () => {
  let fails = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n     ") : e)); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp cleanup is best effort */ }
  console.log(fails ? fails + " of " + tests.length + " FAILED" : "all " + tests.length + " bug report tests passed");
  process.exit(fails ? 1 : 0);
})();
