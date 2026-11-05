// Approvals pop-up: pure logic (parse, list, batch check), the signed hash-chained log, and the receipt signature.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const ap = require("../src/approvalsPopup"), sa = require("../src/sealedAnswers");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// parseNeeds
eq(ap.parseNeeds("approve Bash: ls -la /tmp"), { tool: "Bash", action: "ls -la /tmp" });
eq(ap.parseNeeds("approve SendMessage"), { tool: "SendMessage", action: "" });
eq(ap.parseNeeds("approve Write: D:\\x\\y.json"), { tool: "Write", action: "D:\\x\\y.json" });
eq(ap.parseNeeds("approve playbook v0.1; join groups").tool, "", "free text is not a tool");

// buildItems: sorted by wait, answerable flag from the screen check, name from the callback
const pending = new Map([["C:\\a\\B", { needs: "approve Bash: b", since: 2000 }], ["C:\\a\\A", { needs: "approve Read: a", since: 1000 }]]);
const onA = (p) => p.endsWith("A"), nm = (p) => path.basename(p);
const items = ap.buildItems(pending, onA, nm, 20000);
eq(items.map((i) => i.name), ["A", "B"]);
eq(items.map((i) => i.answerable), [true, false]);
eq(items[0].waitedMs, 19000);
eq(ap.buildItems(pending, onA, nm, 5000).map((i) => i.name), ["A"], "a not-on-screen request younger than 15 s is not listed (daemon lag right after an answer)");
ok(ap.listKey(items) !== ap.listKey([items[0]]));
eq(ap.listKey(items), ap.listKey(ap.buildItems(pending, onA, nm, 30000)), "wait time is not part of the key");

// checkBatch
ok(ap.checkBatch([]).ok === false);
ok(ap.checkBatch(null).ok === false);
ok(ap.checkBatch([{ agentPath: "x", since: 1, answer: "yes" }]).ok === false, "only approve/deny");
ok(ap.checkBatch([{ agentPath: "x", since: "1", answer: "approve" }]).ok === false, "since is a number");
ok(ap.checkBatch([{ agentPath: "x", since: 1, answer: "approve" }, { agentPath: "x", since: 1, answer: "deny" }]).ok === false, "same agent twice");
ok(ap.checkBatch(Array.from({ length: 51 }, (_, i) => ({ agentPath: "p" + i, since: 1, answer: "approve" }))).ok === false, "cap");
const good = ap.checkBatch([{ agentPath: "x", since: 1, answer: "approve", extra: "ignored", needs: "n" }]);
ok(good.ok); eq(good.decisions, [{ agentPath: "x", answer: "approve", since: 1 }]);

// signed, chained log
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apr-"));
const sealer = sa.createSealer({ dir: path.join(dir, "seal"), protect: (b) => Buffer.from(b), unprotect: (b) => Buffer.from(b) });
const file = path.join(dir, "approvals.jsonl");
let t = 1000;
const log = ap.createLog({ file, sign: (r) => sealer.signReceipt(r), now: () => ++t });
ok(log.add({ agent: "A", answer: "approve", via: "popup-all", since: 1, needs: "approve Bash: x", result: "sent" }));
ok(log.add({ agent: "B", answer: "deny", via: "popup-item", since: 2, needs: "y".repeat(1000), result: "refused", reason: "gone" }));
const pub = sealer.publicInfo();
let v = ap.verifyLog(file, pub, sa.verifyReceipt);
ok(v.ok && v.lines === 2, "fresh log verifies");
ok(JSON.parse(fs.readFileSync(file, "utf8").split("\n")[1]).needs.length === 300, "needs clipped");
// a restarted process continues the chain
const log2 = ap.createLog({ file, sign: (r) => sealer.signReceipt(r), now: () => ++t });
log2.add({ agent: "C", answer: "approve", via: "banner", since: 3, needs: "z", result: "sent" });
ok(ap.verifyLog(file, pub, sa.verifyReceipt).ok, "chain continues across restart");
// edit a line -> detected; delete a middle line -> detected; forged unsigned line flagged sealed:true -> detected
const orig = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, orig.replace('"answer":"deny"', '"answer":"approve"'));
ok(!ap.verifyLog(file, pub, sa.verifyReceipt).ok, "edited answer is caught");
const ls = orig.trim().split("\n");
fs.writeFileSync(file, [ls[0], ls[2]].join("\n") + "\n");
ok(!ap.verifyLog(file, pub, sa.verifyReceipt).ok, "deleted line is caught");
const forged = Object.assign({}, JSON.parse(ls[2]), { agent: "EVIL" });
fs.writeFileSync(file, [ls[0], ls[1], JSON.stringify(forged)].join("\n") + "\n");
ok(!ap.verifyLog(file, pub, sa.verifyReceipt).ok, "re-written line with the old signature is caught");
// a foreign key cannot make valid receipts
const other = sa.createSealer({ dir: path.join(dir, "seal2"), protect: (b) => Buffer.from(b), unprotect: (b) => Buffer.from(b) });
const rec = other.signReceipt({ v: 1, agent: "A", answer: "approve" });
ok(!sa.verifyReceipt(rec, pub), "foreign key rejected");
ok(sa.verifyReceipt(rec, other.publicInfo()));
// a receipt is not an answer seal (domain separation): its signature does not verify as sealed-answer-v1 message
const r2 = sealer.signReceipt({ v: 1, id: "20261105-120000-abcd", answer: "yes", qhash: "q", via: "button", ts: 1, nonce: "n" });
ok(sa.verifyReceipt(r2, pub));
ok(!crypto.verify(null, sa.message(r2), crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub.pub, "hex")]), format: "der", type: "spki" }), Buffer.from(r2.sig, "base64")), "receipt sig is useless as an answer seal");
// unsigned fallback still logs
const f2 = path.join(dir, "u.jsonl");
ok(ap.createLog({ file: f2, sign: () => null }).add({ agent: "A", answer: "approve", via: "banner", since: 1, needs: "n", result: "sent" }));
eq(JSON.parse(fs.readFileSync(f2, "utf8")).sealed, false);
const f3 = path.join(dir, "e.jsonl");
ok(ap.createLog({ file: f3, sign: () => { throw new Error("no key"); } }).add({ agent: "A", answer: "deny", via: "banner", since: 1, needs: "n", result: "sent" }));
eq(JSON.parse(fs.readFileSync(f3, "utf8")).sealed, false);

// downgrade: a log whose lines were re-written as sealed:false (chain recomputed) must not verify against a public key
const fd = path.join(dir, "d.jsonl"); const dl = ap.createLog({ file: fd, sign: (r) => sealer.signReceipt(r) }); dl.add({ agent: "A", answer: "approve", via: "banner", since: 1, needs: "n", result: "sent" });
ok(ap.verifyLog(fd, pub, sa.verifyReceipt).ok);
const fu = path.join(dir, "d2.jsonl"); ap.createLog({ file: fu, sign: () => null }).add({ agent: "A", answer: "approve", via: "banner", since: 1, needs: "n", result: "sent" });
const vu = ap.verifyLog(fu, pub, sa.verifyReceipt); ok(!vu.ok && vu.unsigned.length === 1, "unsigned lines are reported, never ok");

// ---- dock window helpers ----
const aw = require("../src/approvalsWindow");
const two = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1280, height: 720 }];
eq(aw.clampBounds({ x: 2000, y: 50, width: 300, height: 300 }, two), { x: 2000, y: 50, width: 300, height: 300 }, "second monitor position kept");
eq(aw.clampBounds({ x: 2000, y: 50, width: 300, height: 300 }, [two[0]]), { x: 1920 - 300 - 16, y: 16, width: 300, height: 300 }, "monitor unplugged -> top-right of the primary");
eq(aw.clampBounds(null, [two[0]]), { x: 1920 - 340 - 16, y: 16, width: 340, height: 420 }, "default size");
ok(aw.clampBounds({ x: 0, y: 0, width: 10, height: 10 }, two).width === 220 && aw.clampBounds({ x: 0, y: 0, width: 10, height: 10 }, two).height === 140, "minimum size");
ok(aw.clampBounds({ x: -290, y: 0, width: 300, height: 300 }, two).x === 1920 - 300 - 16, "mostly off-screen -> moved back");
const sf = path.join(os.tmpdir(), "aw-state-" + process.pid + ".json");
ok(aw.writeState(sf, { open: true, onTop: false, bounds: { x: 5, y: 6, width: 300, height: 200 } }));
eq(aw.readState(sf), { open: true, onTop: false, collapsed: false, bounds: { x: 5, y: 6, width: 300, height: 200 }, full: null });
fs.writeFileSync(sf, "{broken"); eq(aw.readState(sf), { open: false, onTop: true, collapsed: false, bounds: null, full: null }, "bad file -> defaults");
aw.writeState(sf, { open: true, collapsed: true, bounds: { x: 9, y: 9, width: 200, height: 34 }, full: { x: 9, y: 9, width: 340, height: 420 } });
eq(aw.readState(sf).collapsed, true); eq(aw.readState(sf).full.height, 420);
eq(aw.clampBounds({ x: 9, y: 9, width: 200, height: 34 }, two, aw.TAB).height, 34, "a collapsed tab keeps its small size");
ok(aw.clampBounds({ x: 9, y: 9, width: 200, height: 34 }, two).height === 140, "without the tab minimum it would grow");
fs.rmSync(sf, { force: true });

fs.rmSync(dir, { recursive: true, force: true });
console.log("approvalsPopup.test.js: " + n + " asserts passed");
