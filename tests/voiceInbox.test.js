// node tests/voiceInbox.test.js - voice inbox (src/voiceInbox.js): request parsing, the active-agent file, the inbox watcher /
// claim / delivery / result protocol on a real temp folder, and the Python PHEME side (pheme_pin.py) against the real inbox.
// No Electron is started.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const V = require("../src/voiceInbox");

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "voiceinbox-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (o) => JSON.stringify(Object.assign({ agentPath: "C:\\agents\\Health", text: "hello there", createdAt: Date.now(), source: "pheme" }, o || {}));
async function waitFor(fn, ms) { const end = Date.now() + (ms || 3000); while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(20); } return fn(); }
const resultOf = (dir, id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "processed", id + ".json"), "utf8")); } catch (e) { return null; } };

// ---- parseRequest ----
t("parseRequest: a good request", () => {
  const r = V.parseRequest(req(), "abc-1.json", Date.now());
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.req.id, r.req.agentPath, r.req.text, r.req.source], ["abc-1", "C:\\agents\\Health", "hello there", "pheme"]);
});
t("parseRequest: BOM tolerated, Hebrew text kept", () => {
  const r = V.parseRequest("\uFEFF" + req({ text: "שלום עולם" }), "x1.json", Date.now());
  assert.strictEqual(r.ok, true); assert.strictEqual(r.req.text, "שלום עולם");
});
t("parseRequest: refusals", () => {
  const now = Date.now();
  const why = (raw, name) => V.parseRequest(raw, name || "id1.json", now).reason;
  assert.match(why("{nope"), /unreadable/);
  assert.match(why("[]"), /not-an-object/);
  assert.match(why(req({ agentPath: "" })), /no-agent-path/);
  assert.match(why(req({ agentPath: 5 })), /no-agent-path/);
  assert.match(why(req({ text: "   " })), /empty-text/);
  assert.match(why(req({ text: "x".repeat(V.MAX_TEXT + 1) })), /too-long/);
  assert.match(why(req({ createdAt: "soon" })), /no-created-at/);
  assert.match(why(req({ createdAt: now - V.EXPIRE_MS - 1000 })), /expired/);
  assert.match(why(req(), "..\\evil.json"), /bad-file-name/);
  assert.match(why(req(), "a b.json"), /bad-file-name/);
});
t("parseRequest: source is reduced to safe characters", () => {
  assert.strictEqual(V.sanitizeSource("ph eme/../x"), "pheme..x");
  assert.strictEqual(V.sanitizeSource(null), "unknown");
});

// ---- active-agent file ----
t("activeDoc / sameDoc: only real changes count", () => {
  const a = V.activeDoc({ path: "p", name: "N", view: "chat" }, { pid: 7, startedAt: 1, inboxArmed: true, inboxDir: "d", now: 100 });
  const b = V.activeDoc({ path: "p", name: "N", view: "chat" }, { pid: 7, startedAt: 1, inboxArmed: true, inboxDir: "d", now: 999 });
  assert.strictEqual(V.sameDoc(a, b), true);
  assert.strictEqual(V.sameDoc(a, V.activeDoc({ path: "q", name: "N", view: "chat" }, { pid: 7, startedAt: 1, inboxArmed: true, inboxDir: "d" })), false);
  assert.strictEqual(V.activeDoc({ path: "p", view: "weird" }).view, "other");
  assert.strictEqual(V.activeDoc({ path: "" }).path, null);
});
t("createActiveWriter: writes on change, never twice for the same state, marks closed", () => {
  const d = tmp(), f = path.join(d, "active-agent.json");
  let tt = 1000;
  const w = V.createActiveWriter({ file: f, pid: 42, startedAt: 5, inboxDir: path.join(d, "voice-inbox"), now: () => ++tt });
  assert.strictEqual(w.set({ path: "A", name: "Alpha", view: "chat" }), true);
  assert.strictEqual(w.set({ path: "A", name: "Alpha", view: "chat" }), false);
  const doc = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepStrictEqual([doc.path, doc.name, doc.view, doc.pid, doc.voiceInbox, doc.closed], ["A", "Alpha", "chat", 42, false, false]);
  assert.strictEqual(fs.readFileSync(f)[0], 0x7b, "no BOM");
  assert.strictEqual(w.setArmed(true), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(f, "utf8")).voiceInbox, true);
  assert.strictEqual(w.set({ path: "B", name: "Beta", view: "other" }), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(f, "utf8")).view, "other");
  w.close();
  assert.strictEqual(JSON.parse(fs.readFileSync(f, "utf8")).closed, true);
  assert.deepStrictEqual(fs.readdirSync(d).filter((n) => n.endsWith(".tmp")), []);
});

// ---- the inbox (real folder, real fs.watch) ----
function mkInbox(deliver, extra) {
  const dir = tmp();
  const logs = [];
  const inbox = V.createInbox(Object.assign({ dir, deliver, log: (l) => logs.push(l) }, extra || {}));
  assert.strictEqual(inbox.start(), true);
  return { dir, inbox, logs };
}
const drop = (dir, id, body) => { fs.writeFileSync(path.join(dir, id + ".tmp"), body); fs.renameSync(path.join(dir, id + ".tmp"), path.join(dir, id + ".json")); };

t("inbox: a dropped file reaches deliver() with the ADDRESSED agent path, and the result file appears", async () => {
  const got = [];
  const { dir, inbox } = mkInbox(async (r) => { got.push(r); return { ok: true, agent: "Health", how: "sent" }; });
  drop(dir, "0001-a", req({ agentPath: "C:\\agents\\Health", text: "for health" }));
  const res = await waitFor(() => resultOf(dir, "0001-a"));
  inbox.close();
  assert.ok(res, "result written");
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].agentPath, "C:\\agents\\Health");
  assert.strictEqual(got[0].text, "for health");
  assert.deepStrictEqual(res.result, { ok: true, agent: "Health", how: "sent" });
  assert.strictEqual(res.chars, 10);
  assert.ok(!("text" in res), "the dictated text is not kept in the result file");
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".json")), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, "processing")), []);
});
t("inbox: two agents, two requests -> each delivered with its own agent path, in time order", async () => {
  const got = [];
  const { dir, inbox } = mkInbox(async (r) => { got.push(r.agentPath + "|" + r.text); await sleep(30); return { ok: true }; });
  const now = Date.now();
  drop(dir, "0002-b", req({ agentPath: "C:\\agents\\Video", text: "second", createdAt: now + 5 }));
  drop(dir, "0001-b", req({ agentPath: "C:\\agents\\Health", text: "first", createdAt: now }));
  await waitFor(() => resultOf(dir, "0002-b") && resultOf(dir, "0001-b"));
  inbox.close();
  assert.deepStrictEqual(got, ["C:\\agents\\Health|first", "C:\\agents\\Video|second"]);
});
t("inbox: a .tmp file is never read; a half-written name never delivered", async () => {
  const got = [];
  const { dir, inbox } = mkInbox(async (r) => { got.push(r); return { ok: true }; });
  fs.writeFileSync(path.join(dir, "0003-c.tmp"), req());
  await sleep(300);
  inbox.close();
  assert.strictEqual(got.length, 0);
});
t("inbox: refusals are answered (bad json, expired, oversize) and never delivered", async () => {
  const got = [];
  const { dir, inbox } = mkInbox(async (r) => { got.push(r); return { ok: true }; });
  drop(dir, "0004-d", "{broken");
  drop(dir, "0005-d", req({ createdAt: Date.now() - V.EXPIRE_MS - 5000 }));
  drop(dir, "0006-d", req({ text: "y".repeat(300 * 1024) }));
  await waitFor(() => resultOf(dir, "0004-d") && resultOf(dir, "0005-d") && resultOf(dir, "0006-d"));
  inbox.close();
  assert.strictEqual(got.length, 0);
  assert.match(resultOf(dir, "0004-d").result.reason, /unreadable/);
  assert.match(resultOf(dir, "0005-d").result.reason, /expired/);
  assert.match(resultOf(dir, "0006-d").result.reason, /too-large/);
  assert.strictEqual(resultOf(dir, "0004-d").result.ok, false);
});
t("inbox: a deliver() that throws or answers nothing is a clean failure, not a crash", async () => {
  const { dir, inbox } = mkInbox(async (r) => { if (r.text === "boom") throw new Error("kaput"); return undefined; });
  drop(dir, "0007-e", req({ text: "boom" }));
  drop(dir, "0008-e", req({ text: "silent", createdAt: Date.now() + 1 }));
  await waitFor(() => resultOf(dir, "0007-e") && resultOf(dir, "0008-e"));
  inbox.close();
  assert.match(resultOf(dir, "0007-e").result.reason, /kaput/);
  assert.strictEqual(resultOf(dir, "0008-e").result.reason, "no-result");
});
t("inbox: a deliver() that never answers times out as state-unknown, and later requests still go", async () => {
  const { dir, inbox } = mkInbox(async (r) => { if (r.text === "hang") return new Promise(() => {}); return { ok: true }; }, { timeoutMs: 150 });
  drop(dir, "0009-f", req({ text: "hang" }));
  drop(dir, "0010-f", req({ text: "fine", createdAt: Date.now() + 1 }));
  await waitFor(() => resultOf(dir, "0010-f"));
  inbox.close();
  assert.strictEqual(resultOf(dir, "0009-f").result.reason, "timeout-state-unknown");
  assert.strictEqual(resultOf(dir, "0010-f").result.ok, true);
});
t("inbox: requests dropped while the app was not running are picked up at start; in-flight leftovers are NOT resent", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "processing"));
  fs.writeFileSync(path.join(dir, "processing", "0011-g.json"), req({ text: "was in flight" }));
  fs.writeFileSync(path.join(dir, "0012-g.json"), req({ text: "waiting since before start" }));
  const got = [];
  const inbox = V.createInbox({ dir, deliver: async (r) => { got.push(r.text); return { ok: true }; }, log: () => {} });
  inbox.start();
  await waitFor(() => resultOf(dir, "0012-g"));
  inbox.close();
  assert.deepStrictEqual(got, ["waiting since before start"]);
  assert.strictEqual(resultOf(dir, "0011-g").result.reason, "interrupted-state-unknown");
});
t("inbox: the same file is never delivered twice (duplicate watcher events)", async () => {
  const got = [];
  const { dir, inbox } = mkInbox(async (r) => { got.push(r.text); return { ok: true }; });
  drop(dir, "0013-h", req());
  inbox.scan(); inbox.scan();
  await waitFor(() => resultOf(dir, "0013-h"));
  await sleep(200);
  inbox.close();
  assert.strictEqual(got.length, 1);
});
t("inbox: processed results are pruned to the newest KEEP_PROCESSED", async () => {
  const { dir, inbox } = mkInbox(async () => ({ ok: true }));
  const n = V.KEEP_PROCESSED + 8;
  for (let i = 0; i < n; i++) drop(dir, "p" + String(i).padStart(4, "0"), req({ createdAt: Date.now() + i }));
  await waitFor(() => resultOf(dir, "p" + String(n - 1).padStart(4, "0")), 8000);
  await sleep(100);
  inbox.close();
  assert.ok(fs.readdirSync(path.join(dir, "processed")).length <= V.KEEP_PROCESSED);
});

// ---- review fixes (v1.113.1) ----
t("writeJsonAtomic: EPERM/EBUSY on rename is retried and then succeeds; a hard failure throws after 3 retries", () => {
  const d = tmp(), f = path.join(d, "a.json");
  let n = 0;
  V.writeJsonAtomic(f, { x: 1 }, (a, b) => { if (++n < 3) { const e = new Error("busy"); e.code = "EBUSY"; throw e; } fs.renameSync(a, b); });
  assert.strictEqual(n, 3); assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { x: 1 });
  let m = 0;
  assert.throws(() => V.writeJsonAtomic(f, { x: 2 }, () => { m++; const e = new Error("perm"); e.code = "EPERM"; throw e; }));
  assert.strictEqual(m, 4); assert.ok(!fs.existsSync(f + "." + process.pid + ".tmp"), "tmp cleaned up");
});
t("createActiveWriter: after a failed write the next flush retries even though nothing changed", () => {
  const d = tmp(), f = path.join(d, "active-agent.json");
  let fail = true;
  const w = V.createActiveWriter({ file: f, pid: 1, startedAt: 1, inboxDir: d, rename: (a, b) => { if (fail) { const e = new Error("x"); e.code = "ENOENT"; throw e; } fs.renameSync(a, b); } });
  assert.strictEqual(w.set({ path: "P", name: "N", view: "chat" }), false);
  assert.ok(!fs.existsSync(f));
  fail = false;
  assert.strictEqual(w.set({ path: "P", name: "N", view: "chat" }), true, "same selection, but the file was never written");
  assert.strictEqual(JSON.parse(fs.readFileSync(f, "utf8")).path, "P");
  assert.strictEqual(w.set({ path: "P", name: "N", view: "chat" }), false, "now unchanged: no rewrite");
});
t("inbox: rate cap of 5 requests a minute, the sixth is refused with a reason", async () => {
  const got = [];
  const { dir, inbox } = mkInbox(async (r) => { got.push(r.id); return { ok: true }; });
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, "r" + i + ".json"), req({ createdAt: Date.now() + i }));
  inbox.scan(); await inbox.idle(); await sleep(50); inbox.close();
  assert.strictEqual(got.length, 5);
  const res = resultOf(dir, "r5");
  assert.strictEqual(res.result.ok, false); assert.ok(/rate-limited/.test(res.result.reason));
});
t("inbox: a never-wake agent is flagged on the request so the renderer will not start it", async () => {
  const seen = [];
  const { dir, inbox } = mkInbox(async (r) => { seen.push(r.neverWake || ""); return { ok: true }; }, { neverWake: (r) => (/Health/.test(r.agentPath) ? "health" : null) });
  fs.writeFileSync(path.join(dir, "a1.json"), req({ agentPath: "C:\agents\Health", createdAt: Date.now() }));
  fs.writeFileSync(path.join(dir, "a2.json"), req({ agentPath: "C:\agents\Video", createdAt: Date.now() + 1 }));
  inbox.scan(); await inbox.idle(); inbox.close();
  assert.deepStrictEqual(seen, ["health", ""]);
});

// ---- the real PHEME side (pheme_pin.py) against the real inbox ----
const PHEME = "C:\\Example\\Workspace\\Security\\Tools\\Pheme";
t("pheme_pin.py writes a request this inbox accepts and reads its answer (cross-language, skipped when Pheme is not on this PC)", async () => {
  if (!fs.existsSync(path.join(PHEME, "pheme_pin.py"))) return;
  const { dir, inbox } = mkInbox(async (r) => ({ ok: true, agent: "Health", how: "sent", echo: r.agentPath }));
  const py = "import sys,json; sys.path.insert(0, sys.argv[1]); import pheme_pin as P; " +
    "st,info = P.deliver(sys.argv[2], 'C:\\\\agents\\\\Health', 'שלום from python', pickup_s=8, total_s=15); print(json.dumps([st, info], ensure_ascii=True))";
  const r = await new Promise((resolve) => {
    const c = require("child_process").spawn("python", ["-c", py, PHEME, dir], { env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }) });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("close", () => resolve(out));
  });
  inbox.close();
  const [st, info] = JSON.parse(r.trim());
  assert.strictEqual(st, "ok");
  assert.strictEqual(info.echo, "C:\\agents\\Health");
});

(async () => {
  let fails = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + ((e && e.stack) || e)); }
  }
  console.log(fails ? fails + " FAILED of " + tests.length : "all " + tests.length + " passed");
  process.exit(fails ? 1 : 0);
})();
