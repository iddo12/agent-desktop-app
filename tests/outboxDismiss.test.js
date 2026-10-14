// node tests/outboxDismiss.test.js - v1.111.2 Dismiss on a failed bubble: pure removal logic + persistence round trip.
"use strict";
const assert = require("assert");
const L = require("../src/outbox");
const NOW = 1_800_000_000_000;
const mk = (n, state) => Object.assign(L.create("D:\A", "message number " + n + " long enough text", NOW - n * 1000, () => n / 10), { state: state || "failed", written: true });
const a = mk(1), b = mk(2), c = mk(3, "queued");
// removes exactly one item, keeps the others untouched and in order
let r = L.dismissItem([a, b, c], b.id);
assert.strictEqual(r.removed, true);
assert.deepStrictEqual(r.rest.map((x) => x.id), [a.id, c.id]);
assert.strictEqual(r.rest[0], a); assert.strictEqual(r.rest[1].attempts, c.attempts);
// unknown id / bad input: nothing removed, nothing thrown
assert.strictEqual(L.dismissItem([a], "nope").removed, false);
assert.deepStrictEqual(L.dismissItem(null, "x"), { rest: [], removed: false });
// the input array is not mutated
const src = [a, b]; L.dismissItem(src, a.id); assert.strictEqual(src.length, 2);
// survives a restart: serialize -> parse does not bring the dismissed one back
const json = L.serialize(L.dismissItem([a, b, c], b.id).rest, NOW);
const back = L.parse(json, NOW);
assert.deepStrictEqual(back.map((x) => x.id).sort(), [a.id, c.id].sort());
console.log("outboxDismiss.test.js OK");
