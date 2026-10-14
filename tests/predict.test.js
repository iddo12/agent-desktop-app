// Run: node tests/predict.test.js
// v1.108.0 predicted replies: context builder, secret stripping, NONE handling, caps/cooldown, stale-result dropping,
// only-open-agent rule, prefs validation, log hygiene. No Electron, no CLI, no model: callModel is a stub.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("../src/predict");

// ---------------------------------------------------------------- secrets
{
  const dirty = [
    "key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 here",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAABCDEFGHIJKLMNOP and xoxb-1234567890-abcdefghij",
    "password: hunter2hunter2 and api_key=Zm9vYmFyYmF6cXV4",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    "https://user:s3cretpass@example.com/x",
    "hash 0123456789abcdef0123456789abcdef0123 end",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END RSA PRIVATE KEY-----",
    "A".repeat(10) + "b3JlbWlwc3VtZG9sb3JzaXRhbWV0Y29uc2VjdGV0dXJhZGlwaXNjaW5n",
  ].join("\n");
  const clean = P.stripSecrets(dirty);
  for (const bad of ["sk-ant", "ghp_abc", "AKIAABC", "xoxb-", "hunter2", "Zm9vYmFy", "abcdefghijklmnopqrstuvwxyz123456", "s3cretpass", "0123456789abcdef0123", "eyJhbGci", "MIIEvQ", "b3JlbWlwc3VtZG9s"]) {
    assert.ok(!clean.includes(bad), "secret removed: " + bad + "\n" + clean);
  }
  assert.ok(clean.includes("password: [removed]"), "keeps the key name, drops the value");
  const normal = "Should I run the tests now? The file is src/main.js and the version is 1.108.0.";
  assert.strictEqual(P.stripSecrets(normal), normal, "ordinary text untouched");
}

// ---------------------------------------------------------------- context builder
{
  const long = "x ".repeat(2000) + "Do you want me to deploy it?";
  const c = P.buildContext({ assistantText: long, userMessages: ["one", "two", "three", "four", "five ".repeat(200)] });
  assert.ok(c.prompt.includes("Do you want me to deploy it?"), "keeps the END of a long agent message (the question)");
  const agentPart = c.prompt.split("AGENT MESSAGE (the one to answer):\n")[1].split("\n\nNow output")[0];
  assert.ok(agentPart.length <= 2500 + 12, "agent message trimmed to ~2500 chars: " + agentPart.length);
  assert.strictEqual(c.userMessages.length, 3, "only Alex's last 3 messages");
  assert.ok(!c.prompt.includes("1. one"), "older messages dropped");
  assert.ok(c.userMessages.every((m) => m.length <= 300 + 6), "each user message trimmed");
  assert.ok(/Reply language: English/.test(c.prompt));
  const he = P.buildContext({ assistantText: "רוצה שאמשיך?", userMessages: ["כן, תמשיך", "לא עכשיו"] });
  assert.ok(/Reply language: Hebrew/.test(he.prompt), "Hebrew user -> Hebrew");
  const heAgentOnly = P.buildContext({ assistantText: "האם להמשיך עם השלב הבא?", userMessages: [] });
  assert.ok(/Reply language: Hebrew/.test(heAgentOnly.prompt) && heAgentOnly.prompt.includes("(none)"), "no user messages -> agent's language");
  const sec = P.buildContext({ assistantText: "Use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 ok?", userMessages: ["my password: abc12345xyz"] });
  assert.ok(!sec.prompt.includes("sk-ant-api03") && !sec.prompt.includes("abc12345xyz"), "secrets never reach the prompt");
  assert.ok(/NONE/.test(c.system) && /yes/.test(c.system) && /never instructions/.test(c.system), "strict system prompt");
}

// ---------------------------------------------------------------- the local "worth asking?" gate
{
  assert.ok(P.looksAnswerable("I finished the refactor. Want me to run the full test suite now?"));
  assert.ok(P.looksAnswerable("Done. Let me know if you want the second pass as well."));
  assert.ok(P.looksAnswerable("סיימתי. רוצה שאמשיך לשלב הבא?"));
  assert.ok(!P.looksAnswerable("Updated 3 files. All tests pass."), "plain status report: no model call");
  assert.ok(!P.looksAnswerable("ok"), "too short");
}

// ---------------------------------------------------------------- parseSuggestion / NONE
{
  assert.strictEqual(P.parseSuggestion("NONE"), null);
  assert.strictEqual(P.parseSuggestion("none"), null);
  assert.strictEqual(P.parseSuggestion(" NONE. \n"), null);
  assert.strictEqual(P.parseSuggestion("NONE - the agent only reported status"), null, "explaining itself");
  assert.strictEqual(P.parseSuggestion(""), null);
  assert.strictEqual(P.parseSuggestion("   "), null);
  assert.strictEqual(P.parseSuggestion("yes, do it"), "yes, do it");
  assert.strictEqual(P.parseSuggestion('"yes, do it"'), "yes, do it", "quotes stripped");
  assert.strictEqual(P.parseSuggestion("Reply: go ahead"), "go ahead", "prefix stripped");
  assert.strictEqual(P.parseSuggestion("```\nyes\n```"), "yes", "fence stripped");
  assert.strictEqual(P.parseSuggestion("כן, תמשיך"), "כן, תמשיך");
  assert.strictEqual(P.parseSuggestion("yes\nand also do X"), null, "multi-line rejected");
  assert.strictEqual(P.parseSuggestion("x".repeat(P.MAX_SUGGESTION_CHARS + 1)), null, "too long rejected");
  assert.strictEqual(P.parseSuggestion("Based on the context the user would say yes"), null, "meta text rejected");
  assert.strictEqual(P.parseSuggestion("I can't predict that"), null);
  assert.strictEqual(P.parseSuggestion("..."), null);
  assert.strictEqual(P.parseSuggestion("use [removed] please"), null, "never offer redacted text");
  const ctx = { userMessages: ["please run the whole test suite again"] };
  assert.strictEqual(P.parseSuggestion("please run the whole test suite again", ctx), null, "just repeats his previous message");
  assert.strictEqual(P.parseSuggestion("yes", { userMessages: ["yes"] }), "yes", "short repeats are fine");
}

// ---------------------------------------------------------------- prefs
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pred-"));
  const f = path.join(dir, "prefs.json");
  assert.deepStrictEqual(P.cleanPrefs(null), { enabled: true }, "default ON");
  assert.deepStrictEqual(P.cleanPrefs({ enabled: "no" }), { enabled: true }, "garbage -> default");
  assert.deepStrictEqual(P.cleanPrefs({ enabled: false, evil: 1 }), { enabled: false }, "unknown keys dropped");
  const pr = P.createPrefs(f);
  assert.strictEqual(pr.get().enabled, true);
  assert.strictEqual(pr.set({ enabled: "yes" }).ok, false, "non-boolean refused");
  assert.strictEqual(pr.set(null).ok, false);
  assert.strictEqual(pr.set({ enabled: false }).ok, true);
  assert.strictEqual(P.createPrefs(f).get().enabled, false, "persisted");
  assert.ok(!fs.readFileSync(f).slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "written without a BOM");
  fs.writeFileSync(f, "\uFEFF" + JSON.stringify({ enabled: true }));
  assert.strictEqual(P.createPrefs(f).get().enabled, true, "a BOM'd file is still read");
  fs.writeFileSync(f, "{not json");
  assert.strictEqual(P.createPrefs(f).get().enabled, true, "corrupt file -> default");
}

// ---------------------------------------------------------------- the service
const Q = "I fixed it. Do you want me to run the tests now?";
const A = "C:\\agents\\Alpha";
function rig(over = {}) {
  const st = { t: 1000000, enabled: true, visible: true, open: A, answer: "yes, run them", calls: [], logs: [], gate: null };
  const svc = P.createService(Object.assign({
    now: () => st.t,
    isEnabled: () => st.enabled,
    isWindowVisible: () => st.visible,
    getOpenAgent: () => st.open,
    appendLog: (l) => st.logs.push(l),
    recentCalls: () => [],
    callModel: async (a) => {
      st.calls.push(a);
      if (st.gate) await st.gate; // lets a test change the world mid-call
      if (st.answer instanceof Error) throw st.answer;
      return st.answer;
    },
  }, over));
  const req = (o = {}) => svc.request(Object.assign({ agentPath: A, turnKey: "t1", assistantText: Q, userMessages: ["go"], boxEmpty: true }, o));
  return { st, svc, req };
}
const tick = () => new Promise((r) => setImmediate(r));
function gate(st) {
  let release;
  st.gate = new Promise((r) => { release = r; });
  return release;
}

(async () => {
  // happy path
  {
    const { st, req } = rig();
    const r = await req();
    assert.strictEqual(r.suggestion, "yes, run them");
    assert.strictEqual(st.calls.length, 1);
    assert.strictEqual(st.calls[0].model, "claude-haiku-4-5-20251001");
    assert.strictEqual(st.calls[0].timeoutMs, 45000, "45 s timeout (v1.110.0: CLI start-up alone is 7-8 s, real prompts 15-20 s)");
    assert.strictEqual(P.TIMEOUT_MS, 45000);
    assert.ok(/NONE/.test(st.calls[0].system));
  }
  // NONE from the model -> no suggestion
  {
    const { st, req } = rig();
    st.answer = "NONE";
    const r = await req();
    assert.strictEqual(r.suggestion, null);
    assert.ok(/result=none/.test(st.logs[st.logs.length - 1]));
  }
  // only the open agent
  {
    const { st, req } = rig();
    const r = await req({ agentPath: "C:\\agents\\Beta" });
    assert.strictEqual(r.suggestion, null);
    assert.strictEqual(r.reason, "not-open-agent");
    assert.strictEqual(st.calls.length, 0, "no model call for a background agent");
    st.open = null;
    assert.strictEqual((await req()).reason, "not-open-agent", "nothing open -> nothing");
  }
  // window hidden / setting off / box has text / malformed
  {
    const { st, req } = rig();
    st.visible = false;
    assert.strictEqual((await req()).reason, "window-hidden");
    st.visible = true;
    st.enabled = false;
    assert.strictEqual((await req()).reason, "off");
    st.enabled = true;
    assert.strictEqual((await req({ boxEmpty: false })).reason, "box-has-text");
    assert.strictEqual(st.calls.length, 0);
    assert.strictEqual((await req({ turnKey: "" })).reason, "bad-request");
    assert.strictEqual((await req({ agentPath: "" })).reason, "bad-request");
  }
  // not answerable -> free, no call
  {
    const { st, req } = rig();
    const r = await req({ assistantText: "Updated 3 files. All tests pass." });
    assert.strictEqual(r.reason, "not-answerable");
    assert.strictEqual(st.calls.length, 0);
  }
  // same turn only once
  {
    const { st, req } = rig();
    await req();
    st.t += 100000;
    assert.strictEqual((await req()).reason, "already-asked");
    assert.strictEqual(st.calls.length, 1);
  }
  // cooldowns
  {
    const { st, req } = rig();
    await req({ turnKey: "a" });
    st.t += 5000;
    assert.strictEqual((await req({ turnKey: "b" })).reason, "cooldown", "global cooldown 12 s");
    st.t += 8000; // 13 s after the first call
    assert.strictEqual((await req({ turnKey: "c" })).reason, "cooldown-agent", "per-agent cooldown 45 s");
    st.t += 40000;
    assert.strictEqual((await req({ turnKey: "d" })).suggestion, "yes, run them", "after the cooldowns it works again");
  }
  // hourly + daily caps (counted from the log, so they survive a restart)
  {
    const { st, req } = rig({ recentCalls: () => Array.from({ length: 30 }, (_, i) => 1000000 - 1000 * i) });
    assert.strictEqual((await req()).reason, "cap-hour");
    assert.strictEqual(st.calls.length, 0);
    st.t += 3600 * 1000 + 1; // those calls are now over an hour old
    assert.strictEqual((await req({ turnKey: "z" })).reason, "ok");
    const day = rig({ recentCalls: () => Array.from({ length: 150 }, (_, i) => 1000000 - 120000 * i).filter((t) => t > 1000000 - 24 * 3600 * 1000) });
    assert.ok(day.st.t > 0);
    const r = await day.req();
    assert.ok(r.reason === "cap-day" || r.reason === "cap-hour", "daily cap: " + r.reason);
  }
  // pure daily cap: spread so the hour cap is not what stops it
  {
    const spread = Array.from({ length: 150 }, (_, i) => 1000000 - 500000 * (i + 1)).filter((t) => t > 1000000 - 24 * 3600 * 1000);
    const { st, req } = rig({ recentCalls: () => spread });
    if (spread.length >= 150) assert.strictEqual((await req()).reason, "cap-day");
    else {
      // 24 h / 500 s = 172 slots, so 150 fit
      assert.fail("daily cap fixture too short: " + spread.length);
    }
    assert.strictEqual(st.calls.length, 0);
  }
  // caps hold over a long run
  {
    const { st, req } = rig();
    let shown = 0;
    for (let i = 0; i < 200; i++) {
      st.t += 60000; // one call a minute for 200 minutes: the hourly cap (30) must hold
      if ((await req({ turnKey: "k" + i })).suggestion) shown++;
    }
    assert.ok(shown <= 30 * 4, "hourly cap holds over time: " + shown);
    assert.ok(shown >= 60, "but it keeps working: " + shown);
  }
  // in flight -> a second request is refused
  {
    const { st, req } = rig();
    const release = gate(st);
    const first = req({ turnKey: "x" });
    await tick();
    st.t += 20000;
    const second = await req({ turnKey: "y" });
    assert.strictEqual(second.reason, "busy");
    release();
    assert.strictEqual((await first).suggestion, "yes, run them");
  }
  // stale: agent switched during the call
  {
    const { st, req } = rig();
    const release = gate(st);
    const p = req();
    await tick();
    st.open = "C:\\agents\\Beta";
    release();
    const r = await p;
    assert.strictEqual(r.suggestion, null);
    assert.strictEqual(r.reason, "stale");
    assert.ok(/stale:agent-changed/.test(st.logs[st.logs.length - 1]));
  }
  // v1.110.0: a slow (40 s) answer inside the new 45 s limit is still used when nothing changed, and dropped when the agent changed
  {
    const { st, req } = rig();
    const release = gate(st);
    const p = req();
    await tick();
    st.t += 40000;
    release();
    const r = await p;
    assert.strictEqual(r.suggestion, "yes, run them", "a slow answer for the still-open agent is kept");
  }
  {
    const { st, req } = rig();
    const release = gate(st);
    const p = req();
    await tick();
    st.t += 40000;
    st.open = "C:\agents\Beta";
    release();
    const r = await p;
    assert.strictEqual(r.suggestion, null);
    assert.strictEqual(r.reason, "stale", "a slow answer is still dropped when the agent changed meanwhile");
  }
  // stale: user typed (cancel), window hidden, setting turned off
  for (const [label, act, why] of [
    ["cancel", (st, svc) => svc.cancel(A), "cancelled"],
    ["hidden", (st) => { st.visible = false; }, "window-hidden"],
    ["off", (st) => { st.enabled = false; }, "turned-off"],
  ]) {
    const { st, svc, req } = rig();
    const release = gate(st);
    const p = req();
    await tick();
    act(st, svc);
    release();
    const r = await p;
    assert.strictEqual(r.suggestion, null, label);
    assert.ok(new RegExp("stale:" + why).test(st.logs[st.logs.length - 1]), label + " " + st.logs[st.logs.length - 1]);
  }
  // cancel aborts the model call's signal
  {
    const { st, svc, req } = rig();
    const release = gate(st);
    const p = req();
    await tick();
    svc.cancel(A);
    assert.strictEqual(st.calls[0].signal.aborted, true, "typing aborts the running call");
    release();
    await p;
  }
  // errors and timeouts: no suggestion, logged, never thrown
  {
    const { st, req } = rig();
    const e = new Error("t");
    e.timedOut = true;
    st.answer = e;
    const r = await req({ turnKey: "t1" });
    assert.strictEqual(r.suggestion, null);
    assert.strictEqual(r.reason, "timeout");
    assert.ok(/result=timeout/.test(st.logs[st.logs.length - 1]));
    st.t += 60000;
    st.answer = new Error("boom");
    assert.strictEqual((await req({ turnKey: "t2" })).reason, "error");
  }
  // the log never holds message text, secrets or the suggestion itself
  {
    const { st, req } = rig();
    st.answer = "yes, run them";
    await req({ assistantText: "Secret plan about project Nightingale sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789. Want me to go ahead?", userMessages: ["private words here"] });
    const all = st.logs.join("\n");
    assert.ok(all.includes("call=1") && /tokIn=~\d+/.test(all) && /tokOut=~\d+/.test(all) && /ms=\d+/.test(all), "token estimate + timing logged: " + all);
    for (const bad of ["Nightingale", "private words", "sk-ant", "yes, run them", "go ahead"]) assert.ok(!all.includes(bad), "log has no " + bad);
    assert.ok(/agent=Alpha/.test(all) && !all.includes("C:\\agents"), "agent folder name only, not the full path");
  }
  // call log -> caps survive a restart; log file rotation
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "predlog-"));
    const f = path.join(dir, "suggestions.log");
    const t0 = Date.parse("2026-10-09T10:00:00.000Z");
    fs.writeFileSync(f, [
      new Date(t0 - 3600 * 1000).toISOString() + " agent=A call=1 model=m tokIn=~1 tokOut=~1 ms=1 result=none",
      new Date(t0 - 3 * 24 * 3600 * 1000).toISOString() + " agent=A call=1 model=m tokIn=~1 tokOut=~1 ms=1 result=none",
      new Date(t0 - 60000).toISOString() + " agent=A skip=cooldown",
      new Date(t0 - 30000).toISOString() + " agent=A call=1 model=m tokIn=~1 tokOut=~1 ms=1 result=shown",
    ].join("\n") + "\n");
    const times = P.callTimesFromLog(f, t0);
    assert.strictEqual(times.length, 2, "only calls from the last 24 h, skips not counted");
    for (let i = 0; i < 4000; i++) P.appendLogFile(f, new Date(t0).toISOString() + " agent=A call=1 model=m tokIn=~1 tokOut=~1 ms=1 result=none");
    assert.ok(fs.statSync(f).size < 260 * 1024, "log stays small: " + fs.statSync(f).size);
  }
  // source checks (these need a real Electron renderer / main to run): accept never sends, keys, settings, test mode
  {
    const rd = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
    const src = rd("src", "renderer", "predict.js");
    assert.ok(!/sendChatInput|submitToAgent|\.click\(\)/.test(src), "renderer never sends");
    assert.ok(/e\.key === "Tab"/.test(src) && /e\.key === "ArrowRight"/.test(src) && /e\.key === "Escape"/.test(src));
    assert.ok(/selectionStart === chatInputEl\.value\.length/.test(src), "Right-arrow only at the end");
    assert.ok(/document\.hidden/.test(src), "not while the window is hidden");
    assert.ok(/require\("\.\/predictMain"\)/.test(rd("src", "main.js")), "main wires it");
    const rend = rd("src", "renderer", "renderer.js");
    assert.ok(/predictReplies\.consider\(agentPath, session, blocks\)/.test(rend) && /predictReplies\.onSwitch/.test(rend));
    const pm = rd("src", "predictMain.js");
    assert.ok(pm.indexOf("if (testMode)") > 0 && pm.indexOf("if (testMode)") < pm.indexOf("spawn(exe"), "test mode never reaches the real model");
    assert.ok(/--no-session-persistence/.test(pm), "nothing saved by the CLI");
  }
  console.log("predict.test.js passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
