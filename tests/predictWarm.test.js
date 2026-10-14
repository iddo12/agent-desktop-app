// Run: node tests/predictWarm.test.js
// v1.114.2: the warm helper for predicted replies. A fake child process stands in for `claude`, so no model and no CLI are needed.
const assert = require("assert");
const { EventEmitter } = require("events");
const { createWarmPool } = require("../src/predictWarm");

function fakeSpawnFactory(script) {
  const made = [];
  function spawn(exe, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.written = [];
    child.killed = false;
    child.stdin.write = (s) => { child.written.push(s); setImmediate(() => script(child, s)); };
    child.kill = () => { child.killed = true; setImmediate(() => child.emit("close", null)); };
    child.args = args; child.options = options;
    made.push(child);
    return child;
  }
  return { spawn, made };
}
const okScript = (answer) => (child, written) => {
  const msg = JSON.parse(written);
  assert.strictEqual(msg.type, "user");
  child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "system", subtype: "init" }) + "\n"));
  child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer }) + "\n"));
};

(async () => {
  // 1. flags: thinking off, single-use stream-json helper, no tools
  {
    const f = fakeSpawnFactory(okScript("yes"));
    const events = [];
    const pool = createWarmPool({ exe: "claude.exe", cwd: ".", spawn: f.spawn, idleMs: 60000, onEvent: (e) => events.push(e) });
    assert.ok(pool.prewarm("SYS", "m1"), "prewarm starts a helper");
    assert.strictEqual(f.made.length, 1);
    const c = f.made[0];
    assert.strictEqual(c.options.env.MAX_THINKING_TOKENS, "0", "thinking is switched off");
    assert.ok(c.args.includes("stream-json") && c.args.includes("--no-session-persistence") && c.args.includes(""), "stream-json, no session, no tools");
    assert.strictEqual(c.args[c.args.indexOf("--system-prompt") + 1], "SYS");
    assert.strictEqual(c.written.length, 0, "an idle warm helper has been sent nothing (spends no tokens)");
    assert.ok(pool.prewarm("SYS", "m1") && f.made.length === 1, "a second prewarm does not start another");

    // 2. ask() uses the warm helper, returns the result, kills it (single use), starts the next one
    const r = await pool.ask({ system: "SYS", prompt: "hello", model: "m1", timeoutMs: 1000 });
    assert.strictEqual(r, "yes");
    assert.strictEqual(c.written.length, 1, "exactly one message sent");
    assert.ok(c.killed, "used helper is closed (single use)");
    assert.strictEqual(f.made.length, 2, "the next helper was started in advance");
    assert.ok(events.includes("used-warm"), "the first answer came from the warm helper");

    // 3. keepWarm=false: no next helper
    const f2 = fakeSpawnFactory(okScript("no"));
    const pool2 = createWarmPool({ exe: "claude.exe", cwd: ".", spawn: f2.spawn, keepWarm: () => false });
    const r2 = await pool2.ask({ system: "S", prompt: "p", model: "m", timeoutMs: 1000 });
    assert.strictEqual(r2, "no");
    assert.strictEqual(f2.made.length, 1, "cold start when none was warm, and no pre-warm afterwards when keepWarm is false");
    pool2.shutdown();
    pool.shutdown();
  }

  // 4. error result, early exit, timeout, abort
  {
    const f = fakeSpawnFactory((child) => child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }) + "\n")));
    const pool = createWarmPool({ exe: "x", cwd: ".", spawn: f.spawn, keepWarm: () => false });
    await assert.rejects(pool.ask({ system: "S", prompt: "p", model: "m", timeoutMs: 1000 }), /model error/);

    const f2 = fakeSpawnFactory((child) => child.emit("close", 1));
    const pool2 = createWarmPool({ exe: "x", cwd: ".", spawn: f2.spawn, keepWarm: () => false });
    await assert.rejects(pool2.ask({ system: "S", prompt: "p", model: "m", timeoutMs: 1000 }), /exited/);

    const f3 = fakeSpawnFactory(() => {});
    const pool3 = createWarmPool({ exe: "x", cwd: ".", spawn: f3.spawn, keepWarm: () => false });
    await assert.rejects(pool3.ask({ system: "S", prompt: "p", model: "m", timeoutMs: 30 }), (e) => e.timedOut === true);
    assert.ok(f3.made[0].killed, "a timed-out helper is killed");

    const f4 = fakeSpawnFactory(() => {});
    const pool4 = createWarmPool({ exe: "x", cwd: ".", spawn: f4.spawn, keepWarm: () => false });
    const ac = new AbortController();
    const p4 = pool4.ask({ system: "S", prompt: "p", model: "m", timeoutMs: 5000, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(p4, (e) => e.aborted === true);
    assert.ok(f4.made[0].killed, "an aborted helper is killed");
  }

  // 5. idle close
  {
    const f = fakeSpawnFactory(okScript("x"));
    const events = [];
    const pool = createWarmPool({ exe: "x", cwd: ".", spawn: f.spawn, idleMs: 30, onEvent: (e) => events.push(e) });
    pool.prewarm("S", "m");
    await new Promise((r) => setTimeout(r, 90));
    assert.ok(f.made[0].killed && events.includes("idle-close"), "an unused helper closes itself after idleMs");
    assert.strictEqual(pool.state().warm, false);
  }

  // 6. no exe (CLI missing): rejects cleanly, never throws synchronously
  {
    const pool = createWarmPool({ exe: null, cwd: "." });
    assert.strictEqual(pool.prewarm("S", "m"), false);
    await assert.rejects(pool.ask({ system: "S", prompt: "p", model: "m", timeoutMs: 100 }), /no private Claude CLI/);
  }
  console.log("predictWarm.test.js passed");
})().catch((e) => { console.error(e); process.exit(1); });
