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
  { id: "health/h", kind: "capture", title: "unseal try", path: "n.txt" },
];
fs.writeFileSync(path.join(dir, "intake_index.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
fs.mkdirSync(path.join(dir, "notes")); fs.writeFileSync(path.join(dir, "notes", "n.txt"), "Draft the recap"); fs.writeFileSync(path.join(dir, "notes", "sealed.txt"), "SEALED TEXT");
const h = {};
const wc = { mainFrame: {} };
const win = { webContents: wc, isDestroyed: () => false };
const ev = { sender: wc, senderFrame: wc.mainFrame };
let delivered = [];
require("../src/intake/main-intake").init({
  ipcMain: { handle: (c, f) => { h[c] = f; } }, getMainWindow: () => win, cfg: (k) => (k === "intakeDir" ? dir : k === "intakeDefaultAgent" ? "Personal Assistant" : null),
  agentPathFor: (n) => (n === "Marketing" ? "/x/Marketing" : null),
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
  console.log("intakeMain.test.js: all passed");
  fs.rmSync(dir, { recursive: true, force: true }); try { fs.unlinkSync(path.join(dir, "..", "intake-sent-" + process.pid + ".jsonl")); } catch (e) { /* none */ }
})().catch((e) => { console.error(e); process.exit(1); });
