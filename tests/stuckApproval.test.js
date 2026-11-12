// Run: node tests/stuckApproval.test.js - the stuck-turn watchdog must leave an agent alone while it waits on a permission prompt.
"use strict";
const assert = require("assert"), fs = require("fs"), path = require("path");
const SE = require("../src/stuckEscalation");
const A = "D:/agents/Specs Agent", MIN = 60 * 1000, NOW = 1e12;
const pend = (since) => new Map([[A, { needs: "approve Agent", since }]]);
assert.deepStrictEqual(SE.approvalHolds(A, new Map(), NOW, true), { hold: false, released: false }, "no approval: watchdog acts as before");
assert.deepStrictEqual(SE.approvalHolds(A, undefined, NOW, true), { hold: false, released: false }, "missing map is safe");
assert.strictEqual(SE.approvalHolds(A, pend(NOW - 5 * MIN), NOW, true).hold, true, "fresh pending approval holds");
assert.strictEqual(SE.approvalHolds(A, pend(NOW - 5 * MIN), NOW, false).hold, true, "fresh pending holds even if the prompt is not detected yet");
assert.strictEqual(SE.approvalHolds("D:/other", pend(NOW - MIN), NOW, true).hold, false, "other agents are not held");
assert.strictEqual(SE.approvalHolds(A, pend(NOW - 61 * MIN), NOW, true).hold, true, "over the cap but the prompt is still on screen: keep holding (a restart would lose it)");
assert.deepStrictEqual(SE.approvalHolds(A, pend(NOW - 61 * MIN), NOW, false), { hold: false, released: true }, "over the cap and prompt gone: release, and say so");
// review finding 1: a stale blocked job file (approvalBlockedSince set, approvalPending empty) must NOT hold a frozen agent: only pending is passed
assert.strictEqual(SE.approvalHolds(A, new Map(), NOW, false).hold, false, "blockedSince-only (stale job file) does not hold");
// wiring: guard uses approvalPending only, sits before any recovery bookkeeping
const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
const fn = src.slice(src.indexOf("async function checkForStuckTurns()"));
const body = fn.slice(0, fn.indexOf("\n}\n"));
const g = body.indexOf("approvalHolds(agentPath, approvalPending,");
assert.ok(g > 0, "guard present in checkForStuckTurns and passes approvalPending");
assert.ok(!/approvalHolds\([^)]*approvalBlockedSince/.test(body), "guard must not use approvalBlockedSince");
assert.ok(g < body.indexOf("recoverStuckSession("), "guard comes before recovery");
assert.ok(g < body.indexOf("autoRecoveryTracking"), "guard comes before recovery counting");
console.log("stuckApproval.test.js: all passed");
