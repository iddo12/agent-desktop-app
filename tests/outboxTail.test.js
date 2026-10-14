// node tests/outboxTail.test.js - v1.114.1 a transcript tail that does not reach back to the send time must be widened (blink / false "Not delivered").
"use strict";
const assert = require("assert");
const L = require("../src/outbox");
const SENT = Date.parse("2026-10-11T13:20:33.000Z");
const line = (iso) => JSON.stringify({ type: "user", timestamp: iso });
// not truncated: the whole file was read, nothing to widen
assert.strictEqual(L.tailReachesBack([line("2026-10-11T13:45:00.000Z")], false, SENT), true);
// truncated and the first line is NEWER than the send: the proof of delivery may lie further back -> widen
assert.strictEqual(L.tailReachesBack([line("2026-10-11T13:30:00.000Z")], true, SENT), false);
// truncated but the first line is already older than the send: the window covers it
assert.strictEqual(L.tailReachesBack([line("2026-10-11T13:10:00.000Z"), line("2026-10-11T13:30:00.000Z")], true, SENT), true);
// first lines without a timestamp are skipped, the first dated line decides
assert.strictEqual(L.tailReachesBack(["", "{}", line("2026-10-11T13:40:00.000Z")], true, SENT), false);
// an unparseable timestamp must not count as reaching back
assert.strictEqual(L.tailReachesBack(["{\"timestamp\":\"not-a-date\"}"], true, SENT), false);
// nothing parseable: cannot prove it reaches back
assert.strictEqual(L.tailReachesBack(["x", ""], true, SENT), false);
// end to end with the scanner: a delivered message is "user" when the window reaches it, unknown (null) when it does not
const text = "\"E:\\Tmp\\pasted-1791724804986-kerznd.png\"";
const q = JSON.stringify({ type: "user", timestamp: "2026-10-11T13:20:40.000Z", message: { role: "user", content: text } });
const later = JSON.stringify({ type: "assistant", timestamp: "2026-10-11T13:30:00.000Z" });
assert.strictEqual(L.scanTranscripts([{ lines: [q, later], current: true, truncated: true }], text, SENT, SENT), "user");
assert.strictEqual(L.scanTranscripts([{ lines: [later], current: true, truncated: true }], text, SENT, SENT), null);
console.log("outboxTail OK");
