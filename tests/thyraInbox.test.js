// THYRA one-inbox (v1.155.0): free-text reply, notes, maybe-already-answered, still waiting, cleared automatically + undo, owner activity.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const D = require("../src/dockAsks"), OA = require("../src/ownerActivity");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const H = 3600000, now = Date.parse("2026-11-07T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const ask = (id, agent, ageH, extra) => Object.assign({ id, agent, question: "Q " + id, context: "", quick: ["Yes", "No"], merav: false, created: iso(now - ageH * H) }, extra || {});

// ---- ownerActivity ----
ok(OA.keyOf("E:\\Claude work\\agents\\Security") === "security", "windows path -> folder name lower case");
ok(OA.keyOf("D:/x/Software Engineering Agent/") === "software engineering agent", "forward slashes and trailing slash");
ok(OA.keyOf("") === "" && OA.keyOf(null) === "", "empty");
const map = { "software engineering agent": iso(now - 2 * H), security: iso(now - 5 * H) };
ok(OA.lastOwnerMs(map, "Software Engineering Agent", now) === now - 2 * H, "exact");
ok(OA.lastOwnerMs({ security: iso(now + 99 * H) }, "Security", now) === 0, "a future time is ignored (forged / clock error)");
ok(OA.lastOwnerMs({ security: iso(now - H) }, "Security-Watchdog", now) === now - H, "machine sender maps to its agent");
ok(OA.lastOwnerMs(map, "Software Engineering", now) === now - 2 * H, "ask agent is a prefix of the folder + space");
ok(OA.lastOwnerMs(map, "Sec", now) === 0, "partial word is not a match");
ok(OA.lastOwnerMs({}, "x") === 0 && OA.lastOwnerMs(null, "x") === 0, "no data");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thyra-inbox-")), qd = path.join(tmp, "open_questions");
fs.mkdirSync(path.join(qd, "answered"), { recursive: true });
ok(OA.record(tmp, "C:\\a\\Specs Agent", now) === true && OA.read(tmp)["specs agent"] === iso(now), "record writes lower-case folder key + time only");
ok(Object.keys(OA.read(tmp)).length === 1 && !JSON.stringify(OA.read(tmp)).includes("C:"), "no path or text stored");
fs.writeFileSync(path.join(tmp, OA.FILE), "not json"); ok(Object.keys(OA.read(tmp)).length === 0, "corrupt file reads as empty");

// ---- window bounds (v1.155.1): capped to the screen it sits on, main-window state round trip ----
const WL = require("../src/approvalsWindow");
const WA = [{ x: 0, y: 0, width: 2560, height: 1400 }, { x: 0, y: 1440, width: 1536, height: 824 }];
ok(WL.clampBounds({ x: -4, y: 1430, width: 419, height: 2334 }, WA).height === 824, "a drifted 2334-high size is capped to the small screen");
ok(JSON.stringify(WL.clampBounds({ x: 100, y: 1500, width: 500, height: 600 }, WA)) === JSON.stringify({ x: 100, y: 1500, width: 500, height: 600 }), "a normal size and place on the small screen is kept exactly");
const mwf = path.join(os.tmpdir(), "mw-" + process.pid + ".json");
ok(WL.writeMain(mwf, { bounds: { x: 5, y: 6, width: 1000, height: 700 }, maximized: true }) && WL.readMain(mwf).maximized === true && WL.readMain(mwf).bounds.width === 1000, "main window state round trip");
fs.unlinkSync(mwf); ok(WL.readMain(mwf).bounds === null, "missing state = defaults");

// ---- buildRows flags ----
const act = (a) => (a === "Alpha" ? now - 1 * H : 0);
let rows = D.buildRows([ask("20261107-1-a", "Alpha", 3), ask("20261107-1-b", "Bravo", 3), ask("20261107-1-c", "Alpha", 0.5), ask("20261020-1-d", "Bravo", 18 * 24), ask("20261107-1-e", "Bravo", 1, { kind: "note" }), ask("20261107-1-f", "Alpha", 3, { still_waiting: iso(now - 0.5 * H) }), ask("20261020-1-g", "Bravo", 18 * 24, { deadline: iso(now + H) })], now, { activityMs: act });
const by = (id) => rows.find((r) => r.id.endsWith("-" + id));
ok(by("a").maybeAnswered === true, "owner wrote to the agent after the ask -> maybe answered");
ok(by("c").maybeAnswered === false, "an ask filed AFTER the owner's message is not flagged");
ok(by("b").maybeAnswered === false, "other agent not flagged");
ok(by("f").maybeAnswered === false, "still_waiting newer than the activity un-flags it");
ok(by("d").stale14 === true && by("g").stale14 === false, "stale14 only without a deadline");
ok(by("e").kind === "note" && by("a").kind === "ask", "kind");
ok(D.recentCount(rows) === 5, "count includes maybe-answered (hint only), excludes older");
ok(D.buildRows([ask("20261107-1-z", "Alpha", 3)], now).every((r) => r.maybeAnswered === false), "no activity option = nothing flagged");
ok(D.listKey(rows) !== D.listKey(D.buildRows([ask("20261107-1-a", "Alpha", 3)], now)), "key changes with the list");

// ---- cleanReply / checkReply / replyFromDock ----
ok(D.cleanReply("  hi\n\tthere\u0000 ") === "hi there", "newlines/control chars collapse to one line");
ok(D.cleanReply("x".repeat(2000)).length === D.MAX_REPLY, "capped");
const cur = ask("20261107-1-r", "Alpha", 1), shown = D.shownOf(cur);
ok(D.checkReply({ id: cur.id, text: "hello", shown }, cur).ok === true, "free text accepted without matching a quick answer");
ok(D.checkReply({ id: cur.id, text: "  ", shown }, cur).error === "type something first", "empty refused");
ok(D.checkReply({ id: cur.id, text: "hello", shown }, null).error.includes("already answered"), "missing file refused");
ok(/changed/.test(D.checkReply({ id: cur.id, text: "hello", shown: Object.assign({}, shown, { question: "other" }) }, cur).error), "changed question refused");
ok(/command/.test(D.checkReply({ id: cur.id, text: "/clear it", shown }, cur).error) && !D.checkReply({ id: cur.id, text: "!x", shown }, cur).ok, "leading / ! refused");
ok(D.cleanReply("x".repeat(2000)).length === 600 && D.cleanReply("a‮b") === "a b", "600 cap, bidi stripped");
ok(D.checkReply({ id: "../x", text: "hello", shown }, cur).ok === false, "bad id refused");
(async () => {
  let got = null; const deps = { readOne: () => cur, deliver: async (d) => { got = d; return { ok: true }; } };
  let r = await D.replyFromDock(deps, { id: cur.id, text: "go ahead", keep: true, shown }); ok(r.ok && got.text === "go ahead" && got.keep === true && got.shown.agent === "Alpha", "delivered with keep");
  r = await D.replyFromDock(deps, { id: cur.id, text: "go ahead", shown }); ok(r.ok && got.keep === false, "keep defaults to false (closes)");
  got = null; r = await D.replyFromDock({ readOne: () => null, deliver: async (d) => { got = d; return { ok: true }; } }, { id: cur.id, text: "x", shown }); ok(!r.ok && got === null, "nothing delivered when the ask is gone");
  r = await D.replyFromDock({ readOne: () => cur, deliver: async () => { throw new Error("boom"); } }, { id: cur.id, text: "x", shown }); ok(!r.ok && /boom/.test(r.error), "delivery error reported");

  // ---- keepWaiting ----
  fs.writeFileSync(path.join(qd, cur.id + ".json"), JSON.stringify(cur));
  ok(D.keepWaiting(qd, cur.id, now).ok && JSON.parse(fs.readFileSync(path.join(qd, cur.id + ".json"), "utf8")).still_waiting === iso(now), "stamps still_waiting");
  ok(JSON.parse(fs.readFileSync(path.join(qd, cur.id + ".json"), "utf8")).question === cur.question, "question untouched (seal binding intact)");
  ok(D.keepWaiting(qd, "20261107-9-nope", now).ok === false && D.keepWaiting(qd, "../x", now).ok === false, "missing / bad id refused");

  // ---- listCleared / undoCleared ----
  const clr = ask("20261106-1-k", "Bravo", 30, { resolved_by: "auto-sweep", auto_reason: "owner_replied", auto_at: iso(now) });
  const own = ask("20261106-1-o", "Bravo", 30, { resolved_by: "agent-cli" });
  const sealed = ask("20261106-1-s", "Bravo", 30, { resolved_by: "auto-sweep", seal: { x: 1 } });
  for (const a of [clr, own, sealed]) { const p = path.join(qd, "answered", a.id + ".json"); fs.writeFileSync(p, JSON.stringify(a)); fs.utimesSync(p, new Date(Date.now() - 1000), new Date(Date.now() - 1000)); }
  const list = D.listCleared(qd, Date.now());
  ok(list.length === 1 && list[0].id === clr.id && list[0].reason === "owner_replied", "only auto-sweep, unsealed files are listed");
  ok(D.undoCleared(qd, own.id, now).ok === false, "an agent-resolved / owner answer is never restored");
  ok(D.undoCleared(qd, sealed.id, now).ok === false, "a sealed one is never restored");
  ok(D.undoCleared(qd, clr.id, now).ok === true && fs.existsSync(path.join(qd, clr.id + ".json")) && !fs.existsSync(path.join(qd, "answered", clr.id + ".json")), "undo moves it back");
  const back = JSON.parse(fs.readFileSync(path.join(qd, clr.id + ".json"), "utf8"));
  ok(!back.resolved_by && !back.auto_reason && back.still_waiting === iso(now), "auto fields removed, still_waiting set so it is not flagged again");
  ok(D.undoCleared(qd, clr.id, now).ok === false, "second undo refused");
  const old = path.join(qd, "answered", "20261001-1-x.json"); fs.writeFileSync(old, JSON.stringify(ask("20261001-1-x", "Bravo", 900, { resolved_by: "auto-sweep" }))); fs.utimesSync(old, new Date(Date.now() - 9 * 86400000), new Date(Date.now() - 9 * 86400000));
  ok(D.listCleared(qd, Date.now()).every((c) => c.id !== "20261001-1-x"), "older than 7 days not listed");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("thyraInbox: " + n + " checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
