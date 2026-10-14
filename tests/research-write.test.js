// node tests/research-write.test.js - MY RESEARCH "Write to <agent>" (v1.89.0): the research-write channel and research/write.js.
// Delivery uses the SAME classification as My Daily > Tasks (decisions-main classifyDelivery): sent / queued / failed; an agent that is not
// running gets a pending note at the workspace root instead; every attempt is logged to <research>\_writes.jsonl. Plus request checks
// (week, agent name, path tricks, finding must exist, length cap), duplicate + rate limit, one send per finding at a time, the IPC
// allow-list and arg cap, and static guards on the renderer and css. Writes only into temp folders.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const W = require("../src/research/write");
const SV = require("../src/research/service");
const MR = require("../src/research/main-research");
const { classifyDelivery } = require("../src/daily/decisions-main");

let n = 0, fails = 0; const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const SRC = path.join(__dirname, "..", "src");
const FX = path.join(__dirname, "fixtures", "research");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "research-write-test-"));

// a workspace: <root>/<agents>, <root>/shared_reports/research (fixtures copied)
function ws(opts) {
  const o = opts || {};
  const root = tmp(), rd = path.join(root, "shared_reports", "research");
  fs.mkdirSync(rd, { recursive: true }); fs.cpSync(FX, rd, { recursive: true });
  for (const a of ["Alpha Agent", "Beta Agent", "COO Agent"]) fs.mkdirSync(path.join(root, a));
  const calls = [], logs = [];
  let clock = o.start || Date.parse("2026-10-08T10:00:00Z");
  const svc = SV.createService({ researchDir: rd });
  const w = W.createWriter({
    owner: "Alex",
    researchDir: rd, root, log: (l) => logs.push(l), now: () => clock,
    findRef: (week, agent, fid) => svc.findRef(week, agent, fid),
    resolveAgent: o.resolveAgent || ((name) => { const p = path.join(root, name); return fs.existsSync(p) ? p : null; }),
    isRunning: o.isRunning || (() => true),
    deliver: o.deliver || (async (p, text) => { calls.push({ p, text }); return { delivered: true, via: "channel" }; }),
    classify: classifyDelivery,
  });
  return { root, rd, w, calls, logs, tick: (ms) => { clock += ms; }, readLog: () => { try { return fs.readFileSync(path.join(rd, "_writes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } } };
}
const good = (extra) => Object.assign({ week: "2026-W41", agent: "Alpha Agent", findingId: "a-high", text: "> Re: Alpha Agent, 2026-W41: “High matters a lot.”\n\nIs this confirmed by the vendor?" }, extra || {});

// ------------------------------------------------------------------ the message and the pending-note file name
t("message: built in main from the digest (week, finding id, exact title), then Alex's text; week variant for the agent panel", () => {
  const m = W.messageFor({ week: "2026-W41", findingId: "a-high", title: "High item" }, "  hello  ", "Alex");
  assert.ok(m.startsWith("From Alex, via the My Research tab: about your research finding (2026-W41, id a-high): \"High item\""));
  assert.ok(m.endsWith("\n\nhello"));
  assert.ok(W.messageFor({ week: "2026-W41", findingId: W.WEEK_ID, title: "" }, "x", "Alex").startsWith("From Alex, via the My Research tab: about your research digest for 2026-W41."));
});
t("pending notes: <slug>_pending_notes.md at the workspace root; an existing short name (coo_pending_notes.md) is reused", () => {
  assert.deepStrictEqual(W.pendingSlugs("COO Agent"), ["coo_agent", "coo"]);
  assert.deepStrictEqual(W.pendingSlugs("Security"), ["security"]);
  assert.deepStrictEqual(W.pendingSlugs("UI-UX Agent"), ["ui_ux_agent", "ui_ux"]);
  const root = tmp();
  assert.strictEqual(W.pendingFileFor(root, "COO Agent"), path.join(root, "coo_agent_pending_notes.md"));
  fs.writeFileSync(path.join(root, "coo_pending_notes.md"), "# x\n");
  assert.strictEqual(W.pendingFileFor(root, "COO Agent"), path.join(root, "coo_pending_notes.md"));
});
t("service.findRef: the finding by id from the week's digest, '_week' for the whole digest, null for anything unknown", () => {
  const d = tmp(); fs.cpSync(FX, d, { recursive: true });
  const s = SV.createService({ researchDir: d });
  assert.deepStrictEqual(s.findRef("2026-W41", "alpha agent", "a-high"), { agent: "Alpha Agent", title: "High item" });
  assert.deepStrictEqual(s.findRef("2026-W41", "Alpha Agent", "_week"), { agent: "Alpha Agent", title: "" });
  for (const a of [["2026-W41", "Alpha Agent", "nope"], ["2026-W40", "Alpha Agent", "a-high"], ["../x", "Alpha Agent", "a-high"], ["2026-W41", "Gamma Agent", "_week"], ["2026-W41", "Broken Agent", "_week"]]) assert.strictEqual(s.findRef(...a), null, a.join(" "));
});

// ------------------------------------------------------------------ request checks: nothing is delivered or logged
t("refused: bad week, empty or path-like agent names, empty text, over 4000 characters, a finding that is not in the digest, an unknown agent", async () => {
  const x = ws();
  const bad = [
    good({ week: "2026-41" }), good({ week: "../2026-W41" }), good({ agent: "" }), good({ findingId: "" }),
    good({ agent: "..\\Security" }), good({ agent: "Alpha/Agent" }), good({ agent: "C:Alpha" }), good({ agent: "Alpha\u0000" }), good({ agent: ".." }),
    good({ text: "   " }), good({ text: "x".repeat(4001) }), good({ findingId: "missing" }), good({ agent: "Gamma Agent", findingId: "_week" }), null, "str",
  ];
  for (const b of bad) { const r = await x.w.write(b); assert.strictEqual(r.ok, false, JSON.stringify(b && Object.assign({}, b, { text: (b.text || "").slice(0, 10) }))); assert.ok(r.reason); }
  assert.ok(/limit is 4000/.test((await x.w.write(good({ text: "y".repeat(4001) }))).reason));
  // an agent with a digest but no folder in the app's agent list
  const y = ws({ resolveAgent: () => null });
  assert.ok(/not a known agent folder/.test((await y.w.write(good())).reason));
  // resolveAgent pointing outside the workspace root is refused too
  const z = ws({ resolveAgent: () => path.join(os.tmpdir(), "Elsewhere") });
  assert.ok(/not a known agent folder/.test((await z.w.write(good())).reason));
  assert.strictEqual(x.calls.length + y.calls.length + z.calls.length, 0);
  assert.deepStrictEqual(x.readLog(), []);
});

// ------------------------------------------------------------------ delivery outcomes
t("running + confirmed in the transcript -> 'sent'; the agent gets the reference header and the text; one log line (no BOM, 200 chars)", async () => {
  const x = ws();
  const long = "> Re: ref\n\n" + "שלום עולם ".repeat(60);
  const r = await x.w.write(good({ text: long }));
  assert.deepStrictEqual(r, { ok: true, delivery: "sent" });
  assert.strictEqual(x.calls.length, 1); assert.strictEqual(x.calls[0].p, path.join(x.root, "Alpha Agent"));
  assert.ok(x.calls[0].text.includes("(2026-W41, id a-high): \"High item\"") && x.calls[0].text.endsWith(long.trim()));
  const buf = fs.readFileSync(path.join(x.rd, "_writes.jsonl")); assert.notStrictEqual(buf[0], 0xEF, "no BOM");
  const L = x.readLog(); assert.strictEqual(L.length, 1);
  assert.deepStrictEqual(Object.keys(L[0]).sort(), ["agent", "delivery", "finding", "text", "time", "week"]);
  assert.strictEqual(L[0].agent, "Alpha Agent"); assert.strictEqual(L[0].finding, "a-high"); assert.strictEqual(L[0].delivery, "sent"); assert.strictEqual(L[0].week, "2026-W41");
  assert.strictEqual(L[0].text.length, 200); assert.ok(L[0].text.includes("שלום"), "Hebrew kept as text");
});
t("running but busy (handed to the channel, not yet in the transcript) -> 'queued', same rule as My Daily > Tasks", async () => {
  const x = ws({ deliver: async () => ({ delivered: false, via: "channel", attempts: 3 }) });
  assert.deepStrictEqual(await x.w.write(good()), { ok: true, delivery: "queued" });
  assert.strictEqual(x.readLog()[0].delivery, "queued");
});
t("delivery refused (test mode dry run, or the agent did not take it) -> error in plain words, logged as failed, the same text may be retried", async () => {
  const x = ws({ deliver: async () => ({ delivered: false, dry: true }) });
  const r = await x.w.write(good()); assert.strictEqual(r.ok, false); assert.strictEqual(r.delivery, "failed"); assert.ok(/Test mode/.test(r.reason));
  // v1.105.0: a refused paste (input box holds text, or an error) is no longer lost: saved to the pending notes, reported as busy
  const y = ws({ deliver: async () => { throw new Error("boom"); } });
  const r2 = await y.w.write(good()); assert.strictEqual(r2.ok, true); assert.strictEqual(r2.delivery, "pending"); assert.strictEqual(r2.busy, true);
  assert.strictEqual(y.readLog()[0].delivery, "pending"); assert.strictEqual(y.readLog()[0].busy, true);
});
t("agent NOT running -> nothing typed anywhere; the message is appended to its pending notes at the root; result 'pending' with the file name", async () => {
  const x = ws({ isRunning: () => false });
  fs.writeFileSync(path.join(x.root, "coo_pending_notes.md"), "# COO notes\nold line\n");
  const r = await x.w.write(good({ agent: "Alpha Agent" }));
  assert.deepStrictEqual(r, { ok: true, delivery: "pending", file: "alpha_agent_pending_notes.md" });
  assert.strictEqual(x.calls.length, 0, "never delivered live");
  const md = fs.readFileSync(path.join(x.root, "alpha_agent_pending_notes.md"), "utf8");
  assert.ok(md.startsWith("# Alpha Agent - pending notes\n") && /## 2026-10-0\d \d\d:\d\d - from Alex via My Research \(2026-W41, finding a-high\)/.test(md) && md.includes("was not running") && md.includes("Is this confirmed by the vendor?"));
  // a second note is appended, an existing file is kept
  x.tick(60000); await x.w.write(good({ text: "second note" }));
  assert.strictEqual((fs.readFileSync(path.join(x.root, "alpha_agent_pending_notes.md"), "utf8").match(/^## /gm) || []).length, 2);
  const L = x.readLog(); assert.strictEqual(L[0].delivery, "pending"); assert.strictEqual(L[0].file, "alpha_agent_pending_notes.md");
  // isRunning throwing counts as not running
  const y = ws({ isRunning: () => { throw new Error("x"); } });
  assert.strictEqual((await y.w.write(good())).delivery, "pending");
});
t("a pending-notes path that is a folder is never written through: plain error, nothing sent", async () => {
  const x = ws({ isRunning: () => false });
  fs.mkdirSync(path.join(x.root, "alpha_agent_pending_notes.md"));
  const r = await x.w.write(good()); assert.strictEqual(r.ok, false); assert.ok(/not running/.test(r.reason) && /could not be written/.test(r.reason));
});

// ------------------------------------------------------------------ safety: duplicates, rate limit, one at a time
t("the same text to the same agent within 10 minutes is refused (says when); after 10 minutes it may go again", async () => {
  const x = ws();
  assert.strictEqual((await x.w.write(good())).ok, true);
  const r = await x.w.write(good({ findingId: "a-low" })); assert.strictEqual(r.ok, false); assert.ok(/same message went to Alpha Agent at/.test(r.reason));
  x.tick(11 * 60000);
  assert.strictEqual((await x.w.write(good())).ok, true);
  assert.strictEqual(x.calls.length, 2);
});
t("rate limit: at most 6 sends a minute", async () => {
  const x = ws();
  for (let i = 0; i < 6; i++) assert.strictEqual((await x.w.write(good({ text: "msg " + i }))).ok, true);
  const r = await x.w.write(good({ text: "msg 7" })); assert.strictEqual(r.ok, false); assert.ok(/Too many/.test(r.reason));
  x.tick(61000); assert.strictEqual((await x.w.write(good({ text: "msg 8" }))).ok, true);
});
t("one send per finding at a time: a second click while the first is still being checked is refused", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const x = ws({ deliver: async () => { await gate; return { delivered: true, via: "channel" }; } });
  const p1 = x.w.write(good());
  const r2 = await x.w.write(good({ text: "other text" }));
  assert.strictEqual(r2.ok, false); assert.ok(/already being sent/.test(r2.reason));
  assert.strictEqual(x.w.inflightCount(), 1);
  release(); assert.strictEqual((await p1).ok, true); assert.strictEqual(x.w.inflightCount(), 0);
});

// ------------------------------------------------------------------ IPC
function world(extra) {
  const handlers = {}, logs = [], delivered = [];
  const wc = { mainFrame: {} }, win = { webContents: wc, isDestroyed: () => false };
  const root = tmp(), d = path.join(root, "shared_reports", "research"); fs.mkdirSync(d, { recursive: true }); fs.cpSync(FX, d, { recursive: true });
  fs.mkdirSync(path.join(root, "Alpha Agent"));
  MR.init(Object.assign({
    ipcMain: { handle: (c, f) => { handlers[c] = f; } }, getMainWindow: () => win, workspaceRoot: root, userData: tmp(), testMode: false, log: (l) => logs.push(l),
    env: {}, openExternal: () => {},
    deliverToAgent: async (p, text) => { delivered.push({ p, text }); return { delivered: true, via: "channel" }; },
    classifyDelivery, resolveAgent: (name) => (name === "Alpha Agent" ? path.join(root, "Alpha Agent") : null), isAgentRunning: () => true,
  }, extra || {}));
  return { handlers, logs, delivered, good: { sender: wc, senderFrame: wc.mainFrame }, wc, d, root };
}
t("ipc: research-write is registered, only the main window's own frame may call it, a 4000-character Hebrew message fits, a huge one is refused", async () => {
  const w = world();
  assert.ok(w.handlers["research-write"]);
  assert.strictEqual((await w.handlers["research-write"]({ sender: {}, senderFrame: {} }, good())).ok, false);
  assert.strictEqual((await w.handlers["research-write"]({ sender: w.wc, senderFrame: {} }, good())).ok, false, "a sub-frame is refused");
  const heb = "> Re: x\n\n" + "א\"ב\n".repeat(996);
  assert.ok(heb.length <= 4000);
  const r = await w.handlers["research-write"](w.good, good({ text: heb }));
  assert.deepStrictEqual(r, { ok: true, delivery: "sent" });
  assert.strictEqual(w.delivered[0].p, path.join(w.root, "Alpha Agent"));
  assert.ok(fs.existsSync(path.join(w.d, "_writes.jsonl")), "the log lives in shared_reports\\research");
  assert.strictEqual((await w.handlers["research-write"](w.good, good({ text: "z".repeat(20000) }))).reason, "That request is too large.");
  assert.strictEqual((await w.handlers["research-mark"](w.good, { week: "2026-W41", agent: "a", finding: "x".repeat(3000), interesting: true })).ok, false, "other channels keep the 2 KB cap");
});
t("ipc: without a delivery function (should not happen) the result is a plain failure, never a crash", async () => {
  const w = world({ deliverToAgent: undefined });
  const r = await w.handlers["research-write"](w.good, good());
  assert.strictEqual(r.ok, false); assert.ok(/Test mode/.test(r.reason));
});

// ------------------------------------------------------------------ static guards (renderer, preload, main, css)
t("main.js passes the SAME verified delivery and classifyDelivery as My Daily, and a running check; preload sends no path", () => {
  const main = fs.readFileSync(path.join(SRC, "main.js"), "utf8"), blk = main.slice(main.indexOf("require(\"./research/main-research\")"), main.indexOf("research failed to load"));
  assert.ok(/deliverToAgentVerified\(agentPath, text, "a My Research message", \{ ttlSec: 600 \}\)/.test(blk));
  assert.ok(/require\("\.\/daily\/decisions-main"\)\.classifyDelivery/.test(blk) && /isAgentRunning/.test(blk) && /resolveAddress/.test(blk) && /kgKnownAgent/.test(blk));
  const pre = fs.readFileSync(path.join(SRC, "preload.js"), "utf8");
  assert.ok(/write: \(week, agent, findingId, text\) => ipcRenderer\.invoke\("research-write", \{ week, agent, findingId, text \}\)/.test(pre));
});
t("renderer: Write button on the finding body, the five and the agent panel; dir=auto box, Ctrl+Enter, Esc, aria-expanded, drafts per finding, result line", () => {
  const js = fs.readFileSync(path.join(SRC, "renderer", "research.js"), "utf8");
  for (const fn of ["renderWriteArea", "renderWriteBox", "paintResult"]) assert.ok(new RegExp("function " + fn + "\\(").test(js), fn);
  assert.ok(/renderWriteArea\(S, agent, f\.id/.test(js), "finding body");
  assert.ok(/rs-pick-w/.test(js) && /S\.onJump\(p\.agent, p\.finding, true\)/.test(js), "the five");
  assert.ok(/renderWriteArea\(S, d\.agent, WEEK_FID/.test(js), "agent panel");
  assert.ok(/auto\(ta\)/.test(js) && /e\.key === "Enter" && \(e\.ctrlKey \|\| e\.metaKey\)/.test(js) && /e\.key === "Escape"/.test(js) && /"rs-btn rs-wbtn" \+ \(on \? " rs-pri" : ""\)/.test(js));
  assert.ok(/const drafts = new Map\(\)/.test(js) && /drafts\.set\(k, ta\.value\)/.test(js));
  assert.ok(/"Delivered\."/.test(js) && /is not running\./.test(js) && /"Queued, not yet confirmed\."/.test(js) && /"Not sent\."/.test(js));
  assert.ok(/tagName === "TEXTAREA"/.test(js), "Esc in the box never closes the whole view");
  assert.strictEqual((js.match(/setTimeout/g) || []).length, 3, "the toast timer plus v1.107.0 read-flush and dwell timers");
});
t("css: the write block uses 400/600 only, 1 px hairlines, nothing under 12 px, focus-visible, a narrow-width rule", () => {
  const css = fs.readFileSync(path.join(SRC, "renderer", "styles-research.css"), "utf8"), blk = css.slice(css.indexOf("v1.89.0 \"Write to <agent>\""));
  assert.ok(blk.length > 200);
  assert.ok(!/font-weight:\s*(700|800|900|bold)/.test(blk), "no heavy weights");
  assert.ok(!/border(-(top|bottom|left|right))?(-width)?:\s*[2-9]px/.test(blk), "1 px hairlines only");
  assert.ok(!/font-size:\s*(\d|1[01])(\.\d+)?px/.test(blk), "nothing under 12 px");
  assert.ok(/\.rs-write-t:focus-visible/.test(blk) && /@media \(max-width: 600px\)/.test(blk));
  assert.ok(/\.rs-wr-ok \{[^}]*--rs-t-lo/.test(blk) && /\.rs-wr-bad \{[^}]*--rs-t-hi/.test(blk));
});
t("css: braces are balanced (v1.88.2 shipped a stray '}' that silently dropped the polish :root tokens such as --rs-hair)", () => {
  const s = fs.readFileSync(path.join(SRC, "renderer", "styles-research.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  let d = 0; for (const c of s) { if (c === "{") d++; else if (c === "}") { d--; assert.ok(d >= 0, "a '}' with no matching '{'"); } }
  assert.strictEqual(d, 0);
});

(async () => {
  for (const q of queue) {
    n++;
    try { await q.fn(); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); }
  }
  console.log(fails ? fails + " of " + n + " FAILED" : "research-write: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
