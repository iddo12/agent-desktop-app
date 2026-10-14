// Run: node tests/perfPass.test.js
// v1.93.0 performance pass: perfLog (AD_PERF gate, IPC wrapping), fsRetry (no retry of test-mode refusals).
// Later sections cover the other v1.93.0 fixes.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// ---- 1. perfLog is inert without AD_PERF=1 and wraps ipcMain with it
{
  const script = (on) => `
    process.env.AD_PERF = ${JSON.stringify(on ? "1" : "")};
    process.env.AD_PERF_FILE = ${JSON.stringify(path.join(os.tmpdir(), "adperf-test-" + process.pid + ".jsonl"))};
    const handlers = {};
    const ipcMain = { handle: (c, f) => { handlers[c] = f; }, on: (c, f) => { handlers["on:" + c] = f; } };
    const origHandle = ipcMain.handle;
    const app = { whenReady: () => new Promise(() => {}), on: () => {}, getPath: () => require("os").tmpdir(), getAppMetrics: () => [] };
    const perf = require(${JSON.stringify(path.join(__dirname, "..", "src", "perfLog.js"))});
    const r = perf.init({ app, ipcMain });
    ipcMain.handle("x", (e, a) => a * 2);
    ipcMain.handle("y", async () => 5);
    Promise.resolve(handlers.y({})).then((v) => {
      console.log(JSON.stringify({ r, same: ipcMain.handle === origHandle, x: handlers.x({}, 21), y: v }));
      process.exit(0);
    });`;
  for (const on of [false, true]) {
    const out = spawnSync(process.execPath, ["-e", script(on)], { encoding: "utf-8" });
    assert.strictEqual(out.status, 0, out.stderr);
    const res = JSON.parse(out.stdout.trim().split("\n").pop());
    assert.strictEqual(res.r, on, "init() returns whether it is on");
    assert.strictEqual(res.same, !on, "ipcMain.handle replaced only when AD_PERF=1");
    assert.strictEqual(res.x, 42, "sync handler result passes through");
    assert.strictEqual(res.y, 5, "async handler result passes through");
  }
  console.log("ok perfLog gate + IPC wrapper pass-through");
}

// ---- 2. fsRetry: a testGuard refusal is not retried (it used to busy-wait 4 x 400 ms per call)
{
  const { withFsRetry, isRetryable } = require("../src/fsRetry");
  const refusal = Object.assign(new Error("EACCES: test mode refuses"), { code: "EACCES", testGuard: true });
  let calls = 0;
  const t0 = Date.now();
  assert.throws(() => withFsRetry(() => { calls++; throw refusal; }), /test mode refuses/);
  assert.strictEqual(calls, 1, "refusal thrown after one attempt");
  assert.ok(Date.now() - t0 < 300, "no busy-wait");
  assert.strictEqual(isRetryable(Object.assign(new Error("x"), { code: "EBUSY" })), true, "real transient errors still retried");
  assert.strictEqual(isRetryable(Object.assign(new Error("x"), { code: "EACCES" })), true, "plain EACCES still retried");
  calls = 0;
  const r = withFsRetry(() => { if (++calls < 2) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return "ok"; }, { delayMs: 10 });
  assert.strictEqual(r, "ok");
  assert.strictEqual(calls, 2);
  console.log("ok fsRetry skips testGuard refusals, still retries transient errors");
}

// ---- 3. windowed chat render (renderer.js): window logic (incl. review S1), Show earlier (S2), label (N2/N3)
{
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf-8").replace(/\r\n/g, "\n");
  const grab = (re) => { const m = re.exec(src); assert.ok(m, "found " + re); return m[0]; };
  const code = grab(/const CHAT_RENDER_WINDOW = \d+;[\s\S]*?\nfunction chatEarlierLabel[\s\S]*?\n}\n/);
  const { chatWindowStart, chatEarlierLabel, chatRenderWindow, W } = new Function(code + "; return { chatWindowStart, chatEarlierLabel, chatRenderWindow, W: CHAT_RENDER_WINDOW };")();
  assert.strictEqual(chatWindowStart("a", 100, true), 0, "short chat: everything drawn");
  assert.strictEqual(chatWindowStart("b", 32658, true), 32658 - W, "long chat: newest window only");
  assert.strictEqual(chatWindowStart("b", 32658 + 10, true), 32658 - W, "start stays put while new blocks arrive (reconcile keeps the prefix)");
  assert.strictEqual(chatWindowStart("b", 32658 + W + 1, true), 32658 + W + 1 - W, "slides once a full extra window arrived, reader at the bottom");
  // S1: a reader who is scrolled up is never slid away from, however much arrives; the slide happens once back at the bottom
  const s0 = chatRenderWindow.get("b").start;
  assert.strictEqual(chatWindowStart("b", 32658 + 5 * W, false), s0, "scrolled up: no slide (nothing above the reader is removed)");
  assert.strictEqual(chatWindowStart("b", 32658 + 9 * W, false), s0, "scrolled up: still no slide");
  assert.strictEqual(chatWindowStart("b", 32658 + 9 * W, true), 32658 + 9 * W - W, "back at the bottom: slides");
  chatRenderWindow.get("b").size += 2 * W; chatRenderWindow.get("b").start -= 2 * W; // what "Show earlier" does
  const s = chatRenderWindow.get("b").start;
  assert.strictEqual(chatWindowStart("b", 32658 + 9 * W + 5, true), s, "widened window is kept");
  assert.strictEqual(chatWindowStart("b", 32658 + 30 * W, false), s, "after Show earlier, reading old content: no slide");
  assert.strictEqual(chatWindowStart("b", 50, false), 0, "transcript got shorter (new session): window resets even when scrolled up");
  assert.ok(/const atBottomBefore = [\s\S]*?const windowStart = chatWindowStart\(activeAgentPath, blocks\.length, atBottomBefore\);/.test(src),
    "renderChatBlocks measures the scroll position BEFORE choosing the window");
  assert.ok(/windowStart > 0\) blocks = blocks\.slice\(windowStart\)/.test(src), "renderChatBlocks slices to the window");
  assert.ok(src.includes('"E\\x01" + windowStart + "\\x01" + earlierLabel'), "earlier-button is a reconcile item (label in the key)");
  assert.ok(/chatRenderWindow\.delete\(agent\.path\)/.test(src), "agent switch resets the window");
  // N2/N3: the label counts messages and tool/status lines, with thousands separators
  const blocks = [];
  for (let i = 0; i < 2000; i++) blocks.push({ role: i % 10 === 0 ? "user" : i % 10 === 1 ? "agent" : "status", lines: ["x"] });
  assert.strictEqual(chatEarlierLabel(blocks, 1600), "Show earlier (320 messages and 1,280 tool/status lines above)");
  assert.strictEqual(chatEarlierLabel(blocks, 1), "Show earlier (1 message above)");
  assert.strictEqual(chatEarlierLabel([{ role: "status" }, { role: "status" }], 2), "Show earlier (2 tool/status lines above)");
  // S2: Show earlier with text selected in the chat clears the selection and renders at once, anchored
  const fnSrc = grab(/function showEarlierChatBlocks\(\) \{[\s\S]*?\n}\n/);
  const calls = [];
  let cleared = 0;
  const sel = { isCollapsed: false, anchorNode: "inChat", removeAllRanges: () => { cleared++; sel.isCollapsed = true; } };
  const chatEl = { scrollHeight: 5000, scrollTop: 1200, contains: (n) => n === "inChat" };
  const renderStub = (...args) => calls.push(args);
  renderStub.lastArgs = [blocks, []];
  const win = new Map([["agentX", { size: W, start: 1600 }]]);
  const run = new Function("chatRenderWindow", "activeAgentPath", "renderChatBlocks", "chatMessagesViewEl", "window", "CHAT_RENDER_WINDOW",
    fnSrc + "; showEarlierChatBlocks();");
  run(win, "agentX", renderStub, chatEl, { getSelection: () => sel }, W);
  assert.strictEqual(cleared, 1, "selection inside the chat is cleared");
  assert.strictEqual(calls.length, 1, "rendered immediately");
  assert.deepStrictEqual(calls[0][2], { keepFromBottom: 3800, userAction: true }, "anchored from the bottom and marked as a user action");
  assert.deepStrictEqual(win.get("agentX"), { size: 3 * W, start: 800 }, "window widened by 800");
  assert.ok(src.includes("(sig === renderChatBlocks.lastSig || (selectionInChat && !opts.userAction))"), "the selection guard does not swallow the click");
  console.log("ok windowed chat render (S1 no slide under a scrolled-up reader, S2 Show earlier with a selection, N3 label)");
}

// ---- 4. archive.js: activity + usage folded in one pass must equal a full fold, through appends and partial lines
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "adpass-"));
  process.env.USERPROFILE = home; process.env.HOME = home;
  const archive = require("../src/archive");
  const file = path.join(home, "t.jsonl");
  const ts = (i) => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
  const lines = [];
  for (let i = 0; i < 300; i++) {
    if (i % 7 === 0) lines.push(JSON.stringify({ type: "user", origin: { kind: "human" }, timestamp: ts(i), sessionId: "s" + (i % 3), message: { content: "hi " + i } }));
    else if (i % 5 === 0) lines.push(JSON.stringify({ type: "user", timestamp: ts(i), message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
    else lines.push(JSON.stringify({ type: "assistant", timestamp: ts(i), sessionId: "s1", message: { model: "m", stop_reason: i % 3 ? "tool_use" : "end_turn", content: [{ type: "tool_use", name: "Bash" }], usage: { input_tokens: i, output_tokens: 2 * i, cache_read_input_tokens: 10 } } }));
    if (i % 11 === 0) lines.push("not json {");
    if (i % 13 === 0) lines.push(JSON.stringify({ type: "custom-title", customTitle: "x" }));
  }
  const reference = (text) => {
    const a = archive.__newActivityStateForTest(), u = { latest: null };
    for (const l of text.split("\n")) { archive.__foldActivityLineForTest(a, l); archive.__foldUsageLineForTest(u, l); }
    return { a, u: u.latest };
  };
  const check = (label) => {
    const text = fs.readFileSync(file, "utf-8");
    const ref = reference(text);
    assert.deepStrictEqual(archive.__readActivityFileForTest(file), ref.a, "activity " + label);
    assert.deepStrictEqual(archive.__readUsageFileForTest(file), ref.u, "usage " + label);
  };
  const all = lines.join("\n") + "\n";
  // cold, activity first; then appends in odd pieces (mid-line cuts), alternating which reader asks first
  let at = 1000;
  fs.writeFileSync(file, all.slice(0, at));
  check("cold");
  const steps = [37, 1, 900, 5, 2500, 13, 7000];
  let k = 0;
  while (at < all.length) {
    const next = Math.min(all.length, at + steps[k++ % steps.length]);
    fs.appendFileSync(file, all.slice(at, next));
    at = next;
    if (k % 2) { archive.__readUsageFileForTest(file); check("append usage-first " + k); }
    else check("append activity-first " + k);
  }
  // only one reader advances for a while (offsets diverge), then both are asked again
  fs.appendFileSync(file, lines.slice(0, 40).join("\n") + "\n");
  archive.__readActivityFileForTest(file);
  fs.appendFileSync(file, lines.slice(40, 90).join("\n") + "\n");
  check("diverged offsets");
  console.log("ok single-pass activity + usage fold equals the full fold");
}

// ---- 5. registry.js: fewer fs calls per entry, same answers (UNC / non-local links never reach fs, v1.92.0)
{
  const Module = require("module");
  const realLoad = Module._load;
  Module._load = function (req) { if (req === "electron") return { shell: {}, clipboard: {}, nativeImage: { createFromPath: () => ({ isEmpty: () => true }) } }; return realLoad.apply(this, arguments); };
  const registry = require("../src/registry");
  Module._load = realLoad;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "adreg93-"));
  const dir = path.join(ws, "shared_registry");
  fs.mkdirSync(dir);
  const pdf = path.join(ws, "a.pdf"); fs.writeFileSync(pdf, "12345");
  const png = path.join(ws, "i.png"); fs.writeFileSync(png, "png!");
  const other = path.join(ws, "t.png"); fs.writeFileSync(other, "t");
  const put = (e) => fs.writeFileSync(path.join(dir, e.id + ".json"), JSON.stringify(Object.assign({ updatedAt: "2026-10-01" }, e)));
  put({ id: "doc", type: "document", link: pdf });
  put({ id: "gone", type: "document", link: path.join(ws, "nope.pdf") });
  put({ id: "img", type: "image", link: png });
  put({ id: "img2", type: "image", link: png, thumbnail: other });
  put({ id: "img3", type: "image", link: png, thumbnail: path.join(ws, "missing.png") });
  put({ id: "web", type: "document", link: "https://example.com/x", pdf });
  put({ id: "unc", type: "image", link: String.raw`\\nohost-perfpass\share\x.png` });
  const byId = Object.fromEntries(registry.listRegistryRaw(ws).map((e) => [e.id, e]));
  assert.deepStrictEqual([byId.doc.missing, byId.doc.fileSize, byId.doc.viewable, byId.doc.path], [false, 5, true, pdf]);
  assert.deepStrictEqual([byId.gone.missing, byId.gone.fileSize, byId.gone.viewable], [true, null, false]);
  assert.strictEqual(byId.img.thumbnail, png, "thumbnail = link (stub image is empty -> original path)");
  assert.strictEqual(byId.img2.thumbnail, other, "separate thumbnail file");
  assert.strictEqual(byId.img3.thumbnail, null, "missing thumbnail file");
  assert.deepStrictEqual([byId.web.isUrl, byId.web.viewable, byId.web.path, byId.web.fileSize], [true, true, pdf, null]);
  assert.deepStrictEqual([byId.unc.missing, byId.unc.thumbnail, byId.unc.fileSize, byId.unc.viewable], [false, null, null, false], "UNC link: no fs, same as main");
  console.log("ok registry list (deduped fs calls)");
}

// ---- 6. main.js: read-only callers use sessionCwdPath (no mkdir); session starts keep sessionCwdFor (mkdir)
{
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf-8").replace(/\r\n/g, "\n");
  const fnPath = /function sessionCwdPath\(agentPath\) \{\n  return path\.join\(agentPath, SESSION_CWD_DIRNAME\);\n\}/.test(src);
  assert.ok(fnPath, "sessionCwdPath is a pure path join");
  assert.ok(/function sessionCwdFor\(agentPath\) \{\n  const dir = sessionCwdPath\(agentPath\);\n  fs\.mkdirSync\(dir, \{ recursive: true \}\);/.test(src), "sessionCwdFor still creates the folder");
  for (const ch of ["get-context-usage", "get-session-activity", "get-agent-overview"]) {
    const line = src.split("\n").find((l) => l.includes(`ipcMain.handle("${ch}"`));
    assert.ok(line && line.includes("sessionCwdPath") && !line.includes("sessionCwdFor"), ch + " uses sessionCwdPath");
  }
  for (const spawnUse of ["findOrDispatchBackgroundAgent(shell, spawnEnv, sessionCwdFor(", "startTerminalSession(agentPath, sessionCwdFor(agentPath)", "markFoldersTrusted([sessionCwdFor("]) {
    assert.ok(src.includes(spawnUse), "still creates the folder before: " + spawnUse);
  }
  console.log("ok sessionCwdPath for read-only callers");
}

// ---- 7. archive.js usage scan: reading in chunks gives the same answer as reading the whole remainder at once
{
  const archive = require("../src/archive");
  const proj = path.join(os.homedir(), ".claude", "projects", "C--perf-usage");
  fs.mkdirSync(proj, { recursive: true });
  const f = path.join(proj, "u.jsonl");
  const now = Date.now();
  const human = (i) => JSON.stringify({ type: "user", origin: { kind: "human" }, timestamp: new Date(now - i * 600000).toISOString(), message: { content: "שלום " + "x".repeat(i % 5 ? 50 : 300000) } });
  const remind = (i) => JSON.stringify({ type: "attachment", timestamp: new Date(now - i * 600000).toISOString(), attachment: { type: "total_tokens_reminder", text: `<total_tokens>${1000000 - i},000 tokens left</total_tokens>` } });
  const other = (i) => JSON.stringify({ type: "assistant", timestamp: new Date(now - i * 600000).toISOString(), message: { content: "é".repeat(1000) } });
  let text = "";
  for (let i = 200; i > 0; i--) text += [human(i), remind(i), other(i)].join("\n") + "\n";
  const strip = (r) => { delete r.fiveHourConfirmed; delete r.sevenDayConfirmed; return r; };
  const scan = (chunk) => { archive.__resetUsageScanForTest(); archive.__setUsageScanChunkForTest(chunk); return strip(archive.getUsageWindows()); };
  fs.writeFileSync(f, text + human(0).slice(0, 40)); // unterminated last line
  const whole = scan(1 << 30), small = scan(65536);
  assert.deepStrictEqual(small, whole, "chunked == whole read (cold)");
  assert.ok(whole.messagesInLast7d > 0 && whole.planTokenBufferRemaining > 0, "the fixture is counted");
  // incremental: finish the cut line and append more, with the small chunk in force
  fs.appendFileSync(f, human(0).slice(40) + "\n" + remind(0) + "\n");
  const incr = strip(archive.getUsageWindows());
  const fresh = scan(1 << 30);
  assert.deepStrictEqual(incr, fresh, "chunked incremental == whole cold read");
  archive.__setUsageScanChunkForTest(8 * 1024 * 1024);
  console.log("ok usage scan reads in chunks with identical results");
}

// ---- 8. archive.js forEachLineSync (conversation list): same lines as readFileSync(...).split("\n")
{
  const archive = require("../src/archive");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adlines-"));
  const cases = {
    empty: "",
    nl: "\n",
    noTrail: "a\nb\nc",
    trail: "a\nb\n",
    crlf: "x\r\ny\r\n",
    multibyte: ("שלום עולם é 😀\n").repeat(50) + "סוף",
    longLine: "z".repeat(70000) + "\n" + "short\n" + "y".repeat(5000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const f = path.join(dir, name + ".jsonl");
    fs.writeFileSync(f, text);
    const want = fs.readFileSync(f, "utf-8").split("\n");
    for (const chunk of [7, 64, 4096, 8 * 1024 * 1024]) {
      const got = [];
      archive.__forEachLineSyncForTest(f, (l) => got.push(l), chunk);
      assert.deepStrictEqual(got, want, `${name} chunk ${chunk}`);
    }
  }
  assert.throws(() => archive.__forEachLineSyncForTest(path.join(dir, "missing.jsonl"), () => {}), /ENOENT/);
  console.log("ok forEachLineSync yields the same lines as a whole-file split");
}

// ---- 9. review N4: a JSON line that is "null" (or another non-object) is skipped like a broken line by every reader
{
  const archive = require("../src/archive");
  assert.throws(() => archive.__parseJsonLineForTest("null"));
  assert.throws(() => archive.__parseJsonLineForTest("123"));
  assert.deepStrictEqual(archive.__parseJsonLineForTest('{"a":1}'), { a: 1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adnull-"));
  const f = path.join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
  const ts = (i) => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
  const good = [
    JSON.stringify({ type: "user", origin: { kind: "human" }, timestamp: ts(1), sessionId: "s", message: { content: "hello" } }),
    JSON.stringify({ type: "assistant", timestamp: ts(2), sessionId: "s", message: { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 5, output_tokens: 7 } } }),
  ];
  fs.writeFileSync(f, ["null", good[0], "123", "null", good[1], "null"].join("\n") + "\n");
  const clean = path.join(dir, "aaaaaaaa-2222-3333-4444-555555555555.jsonl");
  fs.writeFileSync(clean, good.join("\n") + "\n");
  assert.deepStrictEqual(archive.__readActivityFileForTest(f), archive.__readActivityFileForTest(clean), "activity: null lines skipped");
  assert.deepStrictEqual(archive.__readUsageFileForTest(f), archive.__readUsageFileForTest(clean), "usage: null lines skipped");
  // conversation reader (History list): the file still lists, with the same counts as without the null lines
  const cwd = path.join(dir, "Agent", ".claude-session");
  const proj = path.join(os.homedir(), ".claude", "projects", archive.encodeProjectPath(cwd));
  fs.mkdirSync(proj, { recursive: true });
  fs.copyFileSync(f, path.join(proj, path.basename(f)));
  archive.setStatCacheTtl(0);
  const list = archive.listConversations(cwd);
  assert.strictEqual(list.length, 1, "conversation with null lines is listed");
  assert.strictEqual(list[0].humanMessageCount, 1);
  assert.strictEqual(list[0].preview, "hello");
  console.log("ok null JSON lines are skipped by activity, usage and the conversation list");
}

// ---- 10. review N1: IRIS delivery creates the agent's .claude-session folder (no "no-session-folder" refusal)
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adiris-"));
  const agentDir = path.join(root, "COO Agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "agent_config.json"), JSON.stringify({ display_name: "COO Agent" }));
  const userData = path.join(root, "userData");
  const inbox = path.join(root, "msg-1.txt");
  fs.writeFileSync(inbox, "IRIS test message");
  fs.mkdirSync(path.join(userData, "iris"), { recursive: true });
  fs.writeFileSync(path.join(userData, "iris", "pending-deliveries.json"), JSON.stringify([{ id: "m1", inboxFile: inbox }]));
  process.env.AGENT_DESKTOP_ROOT = root;
  delete require.cache[require.resolve("../src/agents")];
  // stub the network service: this test only exercises the delivery handler
  const svcPath = require.resolve("../src/iris/service");
  require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true, exports: { DEFAULT_PORT: 1, IrisService: class {
    constructor() { this.state = { enabled: false }; } _save() {} onChange() {} status() { return { pendingSends: [] }; } start() { return Promise.resolve(); }
  } } };
  const handlers = {};
  const irisMain = require("../src/iris/main-iris");
  irisMain.init({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, app: { getPath: () => userData, on: () => {} }, safeStorage: null, Notification: null, getMainWindow: () => null, log: () => {}, testMode: true });
  assert.ok(!fs.existsSync(path.join(agentDir, ".claude-session")), "agent never started: no session folder yet");
  (async () => {
    const r = await handlers["iris-prepare-delivery"]({}, { id: "m1", agentPath: agentDir });
    assert.strictEqual(r.ok, true, "delivered: " + JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(r.file, "utf8"), "IRIS test message");
    assert.ok(r.file.startsWith(path.join(agentDir, ".claude-session", "iris-inbox")));
    const bad = await handlers["iris-prepare-delivery"]({}, { id: "m1", agentPath: path.join(root, "not-an-agent") });
    assert.strictEqual(bad.reason, "not-an-agent", "unknown folders are still refused");
    console.log("ok IRIS delivery creates the session folder of a known agent");
    process.exit(0); // the IRIS local pipe server keeps the event loop alive
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {};
