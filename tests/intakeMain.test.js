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
  // HELD phone messages: listed from message_held_index.jsonl, approved / rejected only through message_approvals.jsonl, never delivered by AD itself
  const heldFile = path.join(dir, "message_held_index.jsonl"), apprFile = path.join(dir, "message_approvals.jsonl");
  const hl = [
    { id: "20261031-100000_aaaaaa", agent: "coo", at: "2026-10-31T10:00:00+02:00", status: "held", preview: "short", text: "full text\nline2\u0007", voice: false, photos: 2, video: false },
    { id: "20261031-110000_bbbbbb", agent: "security", at: "2026-10-31T11:00:00+02:00", status: "held", preview: "voice", text: "", voice: true, photos: 0, video: false },
    { id: "20261031-120000_cccccc", agent: "coo", at: "2026-10-31T12:00:00+02:00", status: "held", preview: "c", text: "three", voice: false, photos: 0, video: true },
    { id: "20261031-130000_dddddd", agent: "coo", at: "2026-10-31T13:00:00+02:00", status: "held", preview: "d", text: "four" },
    { id: "20261031-130000_dddddd", status: "approved" },                      // already delivered by the watcher: no longer held
    { id: "../evil", agent: "coo", status: "held", text: "bad id" }, { status: "held" },
  ];
  fs.writeFileSync(heldFile, hl.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
  fs.mkdirSync(path.join(agentDir, "phone_inbox"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "phone_inbox", "index.jsonl"), JSON.stringify({ id: "m9", at: "2026-10-31T09:00:00+02:00", status: "new", preview: "delivered one" }) + "\n");
  let hm = await h["intake-messages"](ev);
  assert.ok(hm.ok && hm.held === 3 && hm.total === 4 && hm.synced === false);
  assert.deepStrictEqual(hm.rows.map((r) => r.id), ["20261031-120000_cccccc", "20261031-110000_bbbbbb", "20261031-100000_aaaaaa", "m9"]);   // held + delivered merged, newest first
  const h1 = hm.rows.find((r) => r.id === "20261031-100000_aaaaaa");
  assert.deepStrictEqual([h1.status, h1.agent, h1.text, h1.photos], ["held", "coo", "full text\nline2", 2]);   // full text, control char stripped
  assert.strictEqual(hm.rows.find((r) => r.id === "m9").status, "new");
  assert.strictEqual(fs.existsSync(apprFile), false);                             // listing never writes
  assert.strictEqual(delivered.length, 1);                                         // AD itself never delivers a phone message
  const A = "20261031-100000_aaaaaa", B = "20261031-110000_bbbbbb", C = "20261031-120000_cccccc";
  const readAppr = () => fs.readFileSync(apprFile, "utf8").trim().split("\n").map(JSON.parse);
  // id validation, unknown ids, bad shapes
  assert.strictEqual((await h["intake-message-decide"](ev, { ids: [A], action: "delete" })).ok, false);
  assert.strictEqual((await h["intake-message-decide"](ev, { ids: [], action: "approve" })).ok, false);
  assert.strictEqual((await h["intake-message-decide"](ev, { ids: "x", action: "approve" })).ok, false);
  assert.strictEqual((await h["intake-message-decide"](ev, { ids: Array.from({ length: 201 }, (_, i) => "20261031-" + i), action: "approve" })).ok, false);   // cap 200
  assert.deepStrictEqual(await h["intake-message-decide"]({ sender: {}, senderFrame: {} }, { ids: [A], action: "approve" }), { ok: false, reason: "Not allowed." });
  let bad = await h["intake-message-decide"](ev, { ids: ["../evil", "a b", 5, "unknown_1", "20261031-130000_dddddd"], action: "approve" });
  assert.ok(bad.ok && bad.done === 0 && bad.results.length === 5 && bad.results.every((r) => !r.ok));
  assert.strictEqual(fs.existsSync(apprFile), false);                             // nothing written for invalid / unknown / already delivered ids
  // approve one, with a note (control chars stripped, capped at 2000); no note for a reject
  let r1 = await h["intake-message-decide"](ev, { ids: [A], action: "approve", notes: { [A]: "more\u0000 detail\r\n" + "x".repeat(3000), [B]: "ignored: not in ids" } });
  assert.ok(r1.ok && r1.done === 1 && r1.results[0].note === true);
  let ap1 = readAppr();
  assert.strictEqual(ap1.length, 1);
  assert.deepStrictEqual([ap1[0].id, ap1[0].action, typeof ap1[0].at], [A, "approve", "string"]);
  assert.ok(ap1[0].note.startsWith("more detail") && ap1[0].note.length === 2000 && !/\u0000/.test(ap1[0].note));
  // replay: the same id again is refused (already decided), no second line
  let rp = await h["intake-message-decide"](ev, { ids: [A, A], action: "approve" });
  assert.ok(rp.ok && rp.done === 0 && rp.results.length === 1 && /Already decided/.test(rp.results[0].reason));
  assert.strictEqual(readAppr().length, 1);
  assert.strictEqual((await h["intake-messages"](ev)).held, 2);                   // A is queued, no longer offered
  assert.strictEqual((await h["intake-messages"](ev)).rows.find((r) => r.id === A).queued, "approve");
  // approve many (with one unknown mixed in), reject
  let r2 = await h["intake-message-decide"](ev, { ids: [B, C, "unknown_2"], action: "approve", notes: { [C]: "   " } });
  assert.ok(r2.ok && r2.done === 2 && r2.results.filter((r) => !r.ok).length === 1);
  assert.strictEqual(readAppr().length, 3);
  assert.strictEqual(readAppr()[2].note, undefined);                              // blank note = no note
  // reject carries no note; a held id after a reject cannot be approved
  fs.appendFileSync(heldFile, JSON.stringify({ id: "20261031-140000_eeeeee", agent: "coo", at: "2026-10-31T14:00:00+02:00", status: "held", text: "e" }) + "\n");
  const E = "20261031-140000_eeeeee";
  let r3 = await h["intake-message-decide"](ev, { ids: [E], action: "reject", notes: { [E]: "no" } });
  assert.ok(r3.ok && r3.done === 1 && readAppr()[3].note === undefined && readAppr()[3].action === "reject");
  assert.strictEqual((await h["intake-message-decide"](ev, { ids: [E], action: "approve" })).done, 0);
  // the watcher marks them approved/rejected: they leave the held list for good
  fs.appendFileSync(heldFile, [A, B, C, E].map((id) => JSON.stringify({ id, status: "approved" })).join("\n") + "\n");
  assert.strictEqual((await h["intake-messages"](ev)).held, 0);
  // 200 ids in one request is allowed (argument size cap raised for this channel only)
  const many = Array.from({ length: 200 }, (_, i) => "20261031-9" + String(i).padStart(5, "0") + "_ffffff");
  fs.appendFileSync(heldFile, many.map((id) => JSON.stringify({ id, agent: "coo", at: "2026-10-31T15:00:00+02:00", status: "held", text: "m" })).join("\n") + "\n");
  const notes200 = {}; for (const id of many) notes200[id] = "n".repeat(2000);
  const r4 = await h["intake-message-decide"](ev, { ids: many, action: "approve", notes: notes200 });
  assert.ok(r4.ok && r4.done === 200);
  assert.deepStrictEqual(await h["intake-load"]({ sender: {}, senderFrame: {} }), { ok: false, reason: "Not allowed." });
  assert.strictEqual((await h["intake-load"](ev, {})).ok, true);
  // other channels keep the small argument cap
  assert.strictEqual((await h["intake-decide"](ev, { id: "x", action: "approve", pad: "p".repeat(7000) })).reason, "That request is too large.");
  console.log("intakeMain.test.js: all passed");
  fs.rmSync(dir, { recursive: true, force: true }); try { fs.unlinkSync(path.join(dir, "..", "intake-sent-" + process.pid + ".jsonl")); } catch (e) { /* none */ }
})().catch((e) => { console.error(e); process.exit(1); });

(async () => {   // a synced Intake folder: the held list still reads, but deciding is refused and nothing is written
  const sdir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "intake-sync-")), "Dropbox", "intake");
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, "message_held_index.jsonl"), JSON.stringify({ id: "20261031-100000_aaaaaa", agent: "coo", at: "t", status: "held", text: "x" }) + "\n");
  const hh = {}, wc2 = { mainFrame: {} }, ev2 = { sender: wc2, senderFrame: wc2.mainFrame };
  require("../src/intake/main-intake").init({ ipcMain: { handle: (c, f) => { hh[c] = f; } }, getMainWindow: () => ({ webContents: wc2, isDestroyed: () => false }), cfg: (k) => (k === "intakeDir" ? sdir : null), listAgentNames: () => [], agentPathFor: () => null });
  const m = await hh["intake-messages"](ev2);
  assert.ok(m.ok && m.synced === true && m.held === 1);
  const d = await hh["intake-message-decide"](ev2, { ids: ["20261031-100000_aaaaaa"], action: "approve" });
  assert.ok(!d.ok && /synced/.test(d.reason));
  assert.strictEqual(fs.existsSync(path.join(sdir, "message_approvals.jsonl")), false);
  console.log("intakeMain.test.js: synced-folder refusal passed");
})().catch((e) => { console.error(e); process.exit(1); });

