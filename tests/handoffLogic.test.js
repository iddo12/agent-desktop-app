// Run: node tests/handoffLogic.test.js
const assert = require("assert");
const L = require("../src/handoffLogic");

// 1. the prompt is ONE short line, names the file and every section
const file = "D:\agents\A\handoff_latest.md";
const p = L.handoffPrompt(file);
assert.ok(!/\n/.test(p) && p.length < 220, "one short line, got " + p.length);
assert.ok(/memory, then write .* LAST/.test(p), "write the file LAST");
for (const w of ["LESSONS", "OPEN NOW", "STATE", "KEY FACTS", "Handoff saved", file]) assert.ok(p.includes(w), w);
assert.ok(L.handoffPrompt(file, { interrupted: true }).includes("in flight"));
assert.ok(!/\n/.test(L.nudgePrompt(file)) && L.nudgePrompt(file).length < 200);

// 2. file readiness: all four headings with content
const good = "# Handoff 2026-10-03\n## LESSONS\n- a thing worth knowing\n## OPEN NOW\n- x\n## STATE\nmid-task, next step y\n## KEY FACTS\nfacts here\n";
assert.strictEqual(L.fileReady(good), true);
assert.strictEqual(L.fileReady(good.replace("## STATE", "## STAT")), false);
assert.strictEqual(L.fileReady("# Handoff\n"), false);
assert.strictEqual(L.fileReady(""), false);

// 3. estimate from recent durations (median of last 5), default 90
assert.strictEqual(L.estimateSecs([]), 90);
assert.strictEqual(L.estimateSecs([40, 60, 200]), 60);
assert.strictEqual(L.estimateSecs([1, 99999, "x", 50]), 50);
assert.strictEqual(L.estimateSecs([10, 20, 30, 40, 50, 60, 70]), 50); // last five: 30..70 -> median 50

// 4. progress text: stages, countdown, held count
assert.ok(/~45 s left/.test(L.progressText("writing", 15, 60, 0)));
assert.ok(/taking longer than usual/.test(L.progressText("writing", 200, 60, 0)));
assert.ok(/Your 2 messages are kept/.test(L.progressText("delivering", 0, 60, 2)));
assert.ok(/Your 1 message is kept/.test(L.progressText("ready", 0, 60, 1)));
assert.ok(/starting a fresh session/.test(L.progressText("resetting", 0, 60, 0)));

// 5. user messages typed during a handoff survive an app restart, in order, and are not duplicated
const held = new Map([["D:\agents\A", { items: ["first", "second"], at: 123 }], ["D:\agents\B", { items: [], at: 1 }]]);
const json = L.serializeHeld(held);
assert.ok(!json.includes("agents\\B"), "empty lists are not stored");
const back = L.parseHeld(json);
assert.deepStrictEqual(back.get("D:\agents\A").items, ["first", "second"]);
assert.strictEqual(back.get("D:\agents\A").at, 0, "loaded items count as old so the restore tick delivers them");
assert.strictEqual(back.size, 1);
assert.strictEqual(L.parseHeld("not json").size, 0);
assert.strictEqual(L.parseHeld('{"x":{"items":[1,null,"ok"]}}').get("x").items.length, 1);

console.log("handoffLogic ok");

// 3. v1.68.2 B1: which flow states hold a user message, even for an idle agent
assert.strictEqual(L.flowHoldsMessages(undefined, false), false);
for (const ph of ["saving", "resetting", "resuming"]) assert.strictEqual(L.flowHoldsMessages({ phase: ph }, false), true, ph);
for (const ph of ["failed", "done"]) assert.strictEqual(L.flowHoldsMessages({ phase: ph }, false), false, ph);
assert.strictEqual(L.flowHoldsMessages(undefined, true), true, "fresh session waiting for its resume message");

// 4. v1.68.2 B2: no second handoff request until the first is confirmed in the transcript
assert.strictEqual(L.mayNudge({}), false, "first prompt never confirmed");
assert.strictEqual(L.mayNudge({ delivery: { delivered: false } }), false, "gave up: prompt may sit unsent in the box");
assert.strictEqual(L.mayNudge({ delivery: { delivered: true }, deliveryPending: 1 }), false);
assert.strictEqual(L.mayNudge({ delivery: { delivered: true } }), true);

// 5. v1.68.2 B1 wiring: sendOrHold must test the flow gate BEFORE the idle shortcut (source-order check)
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "renderer", "renderer.js"), "utf-8");
  const fn = src.slice(src.indexOf("async function sendOrHold("));
  const body = fn.slice(0, fn.indexOf("function renderQueue"));
  const gate = body.indexOf("guardsFlowActive");
  const idle = body.indexOf("if (!working()) { sent()");
  assert.ok(gate > 0 && idle > 0 && gate < idle, "flow gate must come before the idle send");
  assert.ok(/guardsParkQueue/.test(body), "a held message is parked so the reset does not drop it");
  const g = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "renderer", "guards.js"), "utf-8");
  assert.ok(/mayNudge\(flow\)/.test(g) && /window\.guardsFlowActive\s*=/.test(g));
}
console.log("handoffLogic ok");

// 6. v1.69.1 M2: bounded wait, then ONE nudge, only when nothing of the first request can still land
{
  const T = 1000000;
  const f = (o) => Object.assign({ delivery: { delivered: false }, deliverySettledAt: T }, o);
  const free = { inputHolds: false, queued: false };
  assert.strictEqual(L.mayNudge(f(), T + 10000, free), false, "inside the wait");
  assert.strictEqual(L.mayNudge(f(), T + 61000, free), true, "wait over, nothing pending");
  assert.strictEqual(L.mayNudge(f(), T + 61000, { inputHolds: true, queued: false }), false, "still in the input box");
  assert.strictEqual(L.mayNudge(f(), T + 61000, { inputHolds: false, queued: true }), false, "still in the app queue");
  assert.strictEqual(L.mayNudge(f(), T + 61000, {}), false, "unknown input state");
  assert.strictEqual(L.mayNudge(f({ unconfirmedNudged: true }), T + 61000, free), false, "only one");
  assert.strictEqual(L.mayNudge(f({ delivery: undefined }), T + 61000, free), true, "delivery errored");
  assert.strictEqual(L.mayNudge(f({ delivery: { aborted: true } }), T + 61000, free), false);
  assert.strictEqual(L.mayNudge(f({ deliveryPending: 1 }), T + 61000, free), false);
}
// 7. v1.69.1 H1: restored held messages go mid-turn to a working agent
assert.strictEqual(L.restoreRoute({ started: true, working: true, midTurnOk: true, dialogOpen: false }), "midturn");
assert.strictEqual(L.restoreRoute({ started: true, working: true, midTurnOk: true, dialogOpen: true }), "queue");
assert.strictEqual(L.restoreRoute({ started: true, working: true, midTurnOk: false, dialogOpen: false }), "queue");
assert.strictEqual(L.restoreRoute({ working: false, midTurnOk: true, dialogOpen: false }), "queue");
{
  const fs2 = require("fs"), p2 = require("path");
  const g = fs2.readFileSync(p2.join(__dirname, "..", "src", "renderer", "guards.js"), "utf-8");
  const r = fs2.readFileSync(p2.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf-8");
  const rs = g.slice(g.indexOf("async function restoreParkedQueuesInner"), g.indexOf("window.guardsParkQueue"));
  assert.ok(/restoreRoute/.test(rs) && /midTurn: true/.test(rs), "restore delivers mid-turn to a working agent");
  assert.ok(rs.indexOf("parkedQueues.get(ap)") > rs.indexOf("autoAttachSession"), "L2: parked list re-read after the awaits");
  const sh = r.slice(r.indexOf("async function sendOrHold("), r.indexOf("function renderQueue"));
  assert.ok(/terminals\.get\(agentPath\) \|\| session/.test(sh), "M3: hold on the current session");
  assert.ok(sh.indexOf("guardsFlowActive") < sh.indexOf("interceptSend"), "L1: flow gate before the link-down check");
  assert.ok(/syncKeepGoing\(\)/.test(g.slice(g.indexOf("async function startFlow"), g.indexOf("async function advanceFlow"))), "L3");
}
console.log("handoffLogic v1.69.1 ok");

// 8. v1.69.2 B-N1: the keep-going nudge typed into the pty must be submitted, once, and never over a draft
assert.strictEqual(L.draftInInputBox("x\n\u2502 > \n? for shortcuts"), false, "empty box");
assert.strictEqual(L.draftInInputBox("x\n\u2502 > fix the thing please \u2502\n"), true, "a draft");
assert.strictEqual(L.draftInInputBox("\u2502 > Try \"edit foo\" \u2502"), false, "placeholder");
assert.strictEqual(L.draftInInputBox("no input box on screen"), false);
// B-L1: idle agent, empty queue, live link -> send directly; anything else keeps the queue path
assert.strictEqual(L.restoreRoute({ started: true, working: false, midTurnOk: true, dialogOpen: false, queueLen: 0, linkHeld: false }), "direct");
assert.strictEqual(L.restoreRoute({ started: true, working: false, midTurnOk: true, dialogOpen: false, queueLen: 2, linkHeld: false }), "queue");
assert.strictEqual(L.restoreRoute({ started: true, working: false, midTurnOk: true, dialogOpen: false, queueLen: 0, linkHeld: true }), "queue");
{
  const fs2 = require("fs"), p2 = require("path");
  const m = fs2.readFileSync(p2.join(__dirname, "..", "src", "main.js"), "utf-8");
  // v1.78.0: the delivery body now lives in deliverToAgentVerified() (shared with My Daily > Decisions); keep-going's deps call it
  const d = m.slice(m.indexOf("function deliverToAgentVerified("));
  const body = d.slice(0, d.indexOf("// v1.69.0 \"Keep going\""));
  assert.ok(/deliver: \(agentPath, text\) => deliverToAgentVerified\(agentPath, text, "the nudge"/.test(m), "keep-going delivers through the shared function");
  assert.ok(/nudgeSubmit:/.test(body) && /press-enter/.test(body), "nudge delivery presses Enter when the text sits in the input box");
  assert.ok(/draftInInputBox/.test(body) && /promptLikelyOpen/.test(body), "never typed over a draft or into a prompt");
  assert.ok(body.indexOf("draftInInputBox") < body.indexOf("typeIntoPty(agentPath, t)"), "draft check before typing");
}
console.log("handoffLogic v1.69.2 ok");

// 9. v1.69.3
// M1: an unstarted session never takes the direct/mid-turn route, and the held list is only dropped after the writes
assert.strictEqual(L.restoreRoute({ started: false, working: false, midTurnOk: true, dialogOpen: false, queueLen: 0, linkHeld: false }), "queue");
assert.strictEqual(L.restoreRoute({ started: true, working: false, midTurnOk: true, dialogOpen: false, queueLen: 0, linkHeld: false }), "direct");
assert.strictEqual(L.restoreRoute({ started: true, working: true, midTurnOk: true, dialogOpen: false }), "midturn");
{
  const g = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "renderer", "guards.js"), "utf-8");
  const rs = g.slice(g.indexOf("async function restoreParkedQueuesInner"), g.indexOf("window.guardsParkQueue"));
  const sendAt = rs.indexOf("submitToAgent(ap, todo[0]");
  assert.ok(sendAt > 0 && /started: !!se\.started/.test(rs), "route gets started");
  assert.ok(rs.indexOf("parkedQueues.delete(ap)") > sendAt || rs.indexOf("parkedQueues.delete(ap)") > rs.indexOf("finally"), "no delete before the direct writes");
  assert.ok(/parkedQueues\.set\(ap, \{ items: todo/.test(rs), "unsent rest stays parked");
}
// M2: the whole nudge with its unique hid must be in the box
{
  const body = "[hid:aaa111] You announced a next step. Please do it now, then continue until the task is finished.";
  const box = "history...\n\u2502 > [hid:aaa111] You announced a next step. Please do it now,   \u2502\n\u2502   then continue until the task is finished.            \u2502\n? for shortcuts";
  assert.strictEqual(L.boxHoldsNudge(box, body), true, "wrapped in the box");
  assert.strictEqual(L.boxHoldsNudge(box.replace("aaa111", "bbb222"), body), false, "a stale echo with another hid");
  assert.strictEqual(L.boxHoldsNudge("...then continue until the task is finished.", body), false, "only the tail of the text");
  assert.strictEqual(L.boxHoldsNudge(box + "x".repeat(400), body), false, "output after it: not the live bottom");
  assert.strictEqual(L.boxHoldsNudge(box, "no marker in this text at all, long enough to count"), false);
}
// L1: a draft above a tall footer is still seen
{
  const lines = ["\u2502 > half typed message \u2502"];
  for (let i = 0; i < 12; i++) lines.push("footer line " + i);
  assert.strictEqual(L.draftInInputBox(lines.join("\n")), true);
}
console.log("handoffLogic v1.69.3 ok");

// 6. v1.111.2: only a real usage limit pauses the handoff clock; a wall-clock cap ends any flow
assert.strictEqual(L.haltPausesFlow(null), false);
assert.strictEqual(L.haltPausesFlow({ kind: "server_error", error: "server_error", rateLimitType: null }), false, "API 500 never pauses");
assert.strictEqual(L.haltPausesFlow({ kind: "auth", error: "authentication_failed" }), false);
assert.strictEqual(L.haltPausesFlow({ kind: "other" }), false);
assert.strictEqual(L.haltPausesFlow({ kind: "rate_limit", rateLimitType: "five_hour", resetsAt: 1 }), true);
assert.strictEqual(L.haltPausesFlow({ rateLimitType: "seven_day" }), true, "older shape without kind");
assert.strictEqual(L.haltPausesFlow({ error: "server_error" }), false);
const MIN = 60000, t0 = 1000000;
assert.strictEqual(L.flowTimeoutKind({ startedAt: t0 }, t0 + 11 * MIN), null);
assert.strictEqual(L.flowTimeoutKind({ startedAt: t0 }, t0 + 13 * MIN), "limit");
assert.strictEqual(L.flowTimeoutKind({ startedAt: t0, pausedMs: 30 * MIN }, t0 + 40 * MIN), null, "paused time does not count");
assert.strictEqual(L.flowTimeoutKind({ startedAt: t0, pausedMs: 30 * MIN }, t0 + 46 * MIN), "cap", "cap ignores pausedMs");
assert.strictEqual(L.flowTimeoutKind({ startedAt: t0, pausedMs: 7 * 3600000 }, t0 + 7 * 3600000), "cap", "the 7 hour stuck flow");
assert.strictEqual(L.flowTimeoutKind(null, t0), null);
console.log("handoffLogic: halt pause + cap ok");

// 7. v1.111.2: Restart Session only clears saving/failed/done flows
assert.strictEqual(L.mayClearOnRestart(undefined), true);
for (const ph of ["saving", "failed", "done"]) assert.strictEqual(L.mayClearOnRestart({ phase: ph }), true, ph);
for (const ph of ["resetting", "resuming"]) assert.strictEqual(L.mayClearOnRestart({ phase: ph }), false, ph);

// 8. v1.111.2: getHaltInfo classifies server_error vs rate_limit (what haltPausesFlow keys off)
{
  const fs = require("fs"), os = require("os"), path = require("path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "adhalt-"));
  process.env.USERPROFILE = home; process.env.HOME = home; process.env.AGENT_DESKTOP_ROOT = path.join(home, "root");
  fs.mkdirSync(process.env.AGENT_DESKTOP_ROOT);
  const archive = require("../src/archive");
  const cwd = path.join(home, "root", "AgentH", ".claude-session");
  const proj = path.join(home, ".claude", "projects", archive.encodeProjectPath(cwd));
  fs.mkdirSync(proj, { recursive: true });
  const rec = (extra) => JSON.stringify(Object.assign({ type: "assistant", uuid: "a", timestamp: "2026-10-01T00:00:05.000Z", isApiErrorMessage: true, message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "x" }] } }, extra)) + "\n";
  const f = path.join(proj, "11111111-aaaa.jsonl");
  archive.setStatCacheTtl(0);
  fs.writeFileSync(f, rec({ error: "server_error", apiErrorStatus: 500 }));
  const h1 = archive.getHaltInfo(cwd);
  assert.strictEqual(h1.kind, "server_error"); assert.strictEqual(L.haltPausesFlow(h1), false);
  fs.writeFileSync(f, rec({ error: "rate_limit", quotaLimits: { rateLimitType: "five_hour", resetsAt: 1790000000 } }));
  const h2 = archive.getHaltInfo(cwd);
  assert.strictEqual(h2.kind, "rate_limit"); assert.strictEqual(L.haltPausesFlow(h2), true);
  // v1.118.2: the login-refresh race (Sarah, 2026-10-13) is transient: retried like a 5xx, never pauses the flow
  const race = rec({ message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Could not refresh your login because another Claude Code process is refreshing (or exited mid-refresh). Try again in a minute" }] } });
  fs.writeFileSync(f, race);
  const h3 = archive.getHaltInfo(cwd);
  assert.strictEqual(h3.kind, "server_error"); assert.strictEqual(h3.refreshRace, true); assert.strictEqual(L.haltPausesFlow(h3), false);
  assert.strictEqual(archive.getHaltInfo(cwd) && (fs.writeFileSync(f, rec({ error: "authentication_failed" })), archive.getHaltInfo(cwd).kind), "auth", "real auth failure stays auth");
  console.log("handoffLogic: restart rule + halt classification ok");
}
