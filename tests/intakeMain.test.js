"use strict";
// main-intake against a temp folder with a fake ipcMain: appends only to the approvals file, delivers only after the approval line exists.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-"));
const lines = [
  { id: "capture/a", kind: "capture", sub: "command", status: "pending_approval", title: "Tell Marketing", path: "n.txt" },
  { id: "health/h", kind: "health", status: "new", sealed: true, title: "secret", path: "sealed.txt" },
  { id: "capture/steal", kind: "capture", sub: "command", status: "pending_approval", title: "steal", path: "sealed.txt" },
  { id: "capture/trav", kind: "capture", sub: "command", status: "pending_approval", title: "trav", path: "../intake_index.jsonl" },
  { id: "health/h", kind: "capture", title: "unseal try", path: "other.txt" },
];
fs.writeFileSync(path.join(dir, "intake_index.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
fs.mkdirSync(path.join(dir, "pending_commands")); fs.writeFileSync(path.join(dir, "pending_commands", "n.txt"), "Draft the recap"); fs.writeFileSync(path.join(dir, "pending_commands", "sealed.txt"), "SEALED TEXT");
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-agent-"));
const h = {};
const wc = { mainFrame: {} };
const win = { webContents: wc, isDestroyed: () => false };
const ev = { sender: wc, senderFrame: wc.mainFrame };
let delivered = [];
require("../src/intake/main-intake").init({
  localApprovalsPath: path.join(dir, "..", "intake-local-appr-" + process.pid + ".jsonl"),
  ipcMain: { handle: (c, f) => { h[c] = f; } }, getMainWindow: () => win, cfg: (k) => (k === "intakeDir" ? dir : k === "intakeDefaultAgent" ? "Personal Assistant" : null),
  agentPathFor: (n) => (n === "Marketing" ? agentDir : null),
  deliverToAgent: async (p, t) => { delivered.push([p, t, fs.existsSync(path.join(dir, "intake_approvals.jsonl"))]); return { delivered: true }; },
  listAgentNames: () => ["Marketing"], sentLogPath: path.join(dir, "..", "intake-sent-" + process.pid + ".jsonl"),
});
(async () => {
  const l = await h["intake-load"](ev);
  assert.ok(l.ok && l.counts.pending === 3 && l.counts.health === 1);
  assert.strictEqual(l.rows.find((r) => r.id === "health/h").title, "");
  assert.deepStrictEqual(await h["intake-load"]({ sender: {}, senderFrame: {} }), { ok: false, reason: "Not allowed." });
  const it = await h["intake-item"](ev, { id: "capture/a" });
  assert.strictEqual(it.text, "Draft the recap");
  assert.ok(it.hash && /^[0-9a-f]{64}$/.test(it.hash));
  assert.strictEqual((await h["intake-item"](ev, { id: "health/h" })).text, "");   // still sealed after the unseal attempt
  assert.strictEqual((await h["intake-item"](ev, { id: "capture/steal" })).text, "steal");   // sealed file not readable through another id
  assert.strictEqual((await h["intake-item"](ev, { id: "capture/trav" })).text, "trav");   // traversal refused
  assert.strictEqual((await h["intake-decide"](ev, { id: "health/h", action: "approve", agent: "Marketing", hash: it.hash })).ok, false);
  assert.strictEqual((await h["intake-decide"](ev, { id: "capture/a", action: "approve", agent: "Marketing" })).ok, false);   // no hash
  assert.strictEqual((await h["intake-decide"](ev, { id: "capture/a", action: "approve", agent: "Marketing", hash: "0".repeat(64) })).ok, false);   // wrong hash
  assert.strictEqual(delivered.length, 0);
  const pair = await Promise.all([h["intake-decide"](ev, { id: "capture/a", action: "approve", agent: "Marketing", hash: it.hash }), h["intake-decide"](ev, { id: "capture/a", action: "approve", agent: "Marketing", hash: it.hash })]);
  assert.strictEqual(pair.filter((x) => x.ok).length, 1);   // concurrent decide: one delivery
  const d = pair.find((x) => x.ok);
  assert.ok(d.ok && d.sent && delivered.length === 1 && delivered[0][2] === true && /Draft the recap/.test(delivered[0][1]));
  const rec = fs.readFileSync(path.join(dir, "intake_approvals.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepStrictEqual([rec.length, rec[0].to_other, rec[0].to, rec[0].hash], [1, true, "Marketing", it.hash]);
  assert.strictEqual((await h["intake-decide"](ev, { id: "capture/a", action: "approve", agent: "Marketing", hash: it.hash })).ok, false);   // no second delivery
  assert.strictEqual((await h["intake-load"](ev)).counts.pending, 2);
  // reserved Windows names and forged lines in the synced approvals file
  fs.writeFileSync(path.join(dir, "intake_approvals.jsonl"), JSON.stringify({ id: "capture/trav", action: "approve", hash: "x", at: "T" }) + "\n", { flag: "a" });
  assert.strictEqual((await h["intake-load"](ev)).rows.find((r) => r.id === "capture/trav").status, "pending_approval");   // forged synced line ignored
  // Messages to agents: read from <agent>\phone_inbox\index.jsonl (new, then handled), newest first, hostile lines ignored, no link followed
  fs.mkdirSync(path.join(agentDir, "phone_inbox"));
  fs.writeFileSync(path.join(agentDir, "phone_inbox", "index.jsonl"), [
    { id: "m1", at: "2026-10-31T19:58:26+02:00", status: "new", preview: "hello" },
    { id: "m2", at: "2026-10-31T20:56:47+02:00", status: "new", preview: "second note" },
    { id: "m1", status: "handled" },
    { id: "m3", at: "2026-10-30T10:00:00+02:00", status: "bogus", preview: "y".repeat(1000) },
    { status: "handled" }, "junk",
  ].map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  const mm = await h["intake-messages"](ev);
  assert.ok(mm.ok && mm.total === 3 && mm.waiting === 2);
  assert.deepStrictEqual(mm.rows.map((r) => r.id), ["m2", "m1", "m3"]);
  assert.deepStrictEqual([mm.rows[0].agent, mm.rows[1].status, mm.rows[0].preview], ["Marketing", "handled", "second  note"]);
  assert.strictEqual(mm.rows[2].preview.length, 300);
  assert.deepStrictEqual(await h["intake-messages"]({ sender: {}, senderFrame: {} }), { ok: false, reason: "Not allowed." });
  fs.rmSync(path.join(agentDir, "phone_inbox", "index.jsonl")); assert.strictEqual((await h["intake-messages"](ev)).total, 0);   // no inbox = empty, not an error
  console.log("intakeMain.test.js: all passed");
  fs.rmSync(dir, { recursive: true, force: true }); try { fs.unlinkSync(path.join(dir, "..", "intake-sent-" + process.pid + ".jsonl")); } catch (e) { /* none */ }
})().catch((e) => { console.error(e); process.exit(1); });
