// Warm helper for predicted replies (v1.114.2).
//
// WHY: a prediction used to start a brand new `claude -p` for every call (about 8-12 s before it even sent the question) and the model "thought"
// for 300-380 hidden tokens to produce one word. Measured 2026-10-12 on this PC: cold + thinking = 16 s and ~380 output tokens; helper started in
// advance + thinking off = 3.7 s and 4 output tokens.
//
// HOW: one single-use helper (`claude -p --input-format stream-json`) is started in the background BEFORE it is needed and sits idle (no tokens are
// spent while it waits: no API call happens until the first message). ask() writes the one user message, reads the `result` line, then kills the
// helper (single use, so the conversation never grows) and starts the next one. An idle helper is closed after idleMs. Thinking is switched off
// (MAX_THINKING_TOKENS=0) because a one-word guess does not need it.
//
// Everything that touches the OS is injected (spawn, timers) so tests run with a fake child and no model.
const { spawn: realSpawn } = require("child_process");

function createWarmPool(opts) {
  const o = opts || {};
  const exe = o.exe;
  const cwd = o.cwd;
  const spawn = o.spawn || realSpawn;
  const idleMs = typeof o.idleMs === "number" ? o.idleMs : 8 * 60 * 1000;
  const env = o.env || process.env;
  const keepWarm = typeof o.keepWarm === "function" ? o.keepWarm : () => true;
  const onEvent = typeof o.onEvent === "function" ? o.onEvent : () => {};
  let warm = null; // { key, child, dead, timer }

  function argsFor(system, model) {
    return [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--model", model, "--no-session-persistence",
      "--tools", "", "--setting-sources", "project", "--disable-slash-commands", "--strict-mcp-config", "--system-prompt", system,
    ];
  }

  function kill(h) {
    if (!h) return;
    h.dead = true;
    clearTimeout(h.timer);
    try { h.child.kill(); } catch (e) { /* already gone */ }
    if (warm === h) warm = null;
  }

  function start(system, model) {
    const key = model + "\n" + system;
    const child = spawn(exe, argsFor(system, model), {
      cwd, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      env: { ...env, DISABLE_AUTOUPDATER: "1", MAX_THINKING_TOKENS: "0" },
    });
    const h = { key, child, dead: false, timer: null };
    child.on("error", () => { h.dead = true; if (warm === h) warm = null; });
    child.on("close", () => { h.dead = true; if (warm === h) warm = null; });
    if (child.stdin && child.stdin.on) child.stdin.on("error", () => {});
    h.timer = setTimeout(() => { onEvent("idle-close"); kill(h); }, idleMs);
    if (h.timer && h.timer.unref) h.timer.unref();
    return h;
  }

  // Start a helper in the background if there is none for this system prompt + model. Safe to call often.
  function prewarm(system, model) {
    if (!exe) return false;
    const key = model + "\n" + system;
    if (warm && !warm.dead && warm.key === key) return true;
    if (warm) kill(warm);
    try { warm = start(system, model); onEvent("prewarm"); return true; } catch (e) { warm = null; return false; }
  }

  function ask({ system, prompt, model, timeoutMs, signal }) {
    return new Promise((resolve, reject) => {
      if (!exe) return reject(new Error("no private Claude CLI"));
      const key = model + "\n" + system;
      let h = null;
      if (warm && !warm.dead && warm.key === key) { h = warm; warm = null; onEvent("used-warm"); }
      else {
        try { h = start(system, model); } catch (e) { return reject(e); }
        if (warm === h) warm = null;
        onEvent("used-cold");
      }
      clearTimeout(h.timer); // in use now: the idle timer must not kill it
      let done = false;
      let buf = "";
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (signal && signal.removeEventListener) signal.removeEventListener("abort", onAbort);
        kill(h); // single use: never reuse a helper (its conversation would keep growing)
        if (err) reject(err); else resolve(val);
        let again = false;
        try { again = keepWarm(); } catch (e) { again = false; }
        if (again) prewarm(system, model);
      };
      const onAbort = () => { const e = new Error("aborted"); e.aborted = true; finish(e); };
      const timer = setTimeout(() => { const e = new Error("timed out"); e.timedOut = true; finish(e); }, timeoutMs);
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener("abort", onAbort); }
      h.child.stdout.on("data", (d) => {
        buf += d.toString("utf-8");
        if (buf.length > 200000) buf = buf.slice(-100000);
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m = null;
          try { m = JSON.parse(line); } catch (e) { continue; }
          if (m && m.type === "result") {
            if (m.is_error || (m.subtype && m.subtype !== "success")) return finish(new Error("model error"));
            return finish(null, String(m.result == null ? "" : m.result));
          }
        }
      });
      h.child.on("close", () => finish(new Error("helper exited before answering")));
      h.child.on("error", (e) => finish(e));
      try {
        h.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
      } catch (e) { finish(e); }
    });
  }

  function shutdown() { if (warm) kill(warm); }
  function state() { return { warm: !!(warm && !warm.dead) }; }

  return { ask, prewarm, shutdown, state };
}

module.exports = { createWarmPool };
