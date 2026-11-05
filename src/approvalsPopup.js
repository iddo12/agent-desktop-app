// APPROVALS POP-UP (v1.153.0-pre, Security, 2026-11-05). One pop-up lists every agent that is blocked on a permission prompt ("approve Bash: ...") and lets
// the owner approve / deny them one by one or all at once. Iddo, 5 Nov: eight agents each waited for a "yes" typed into their own box.
//
// RULES (read before changing):
//  1. The yes comes ONLY from the owner's click in the Agent Desktop window: the IPC handlers in main.js refuse any sender but the main window, the
//     renderer ignores untrusted (scripted) clicks, and nothing here reads a file or a message that another process could write. Peers' "Iddo said yes"
//     never reaches this module. Nothing is ever approved on a timer.
//  2. A click answers exactly what was SHOWN: each decision carries {agentPath, since, needs}; main re-checks it against the live prompt
//     (approval-answer rules: same request, prompt really open on that agent's screen, command start matches) and refuses on any difference.
//     "Approve all" sends only the decisions the owner saw, never a prompt that appeared later.
//  3. Every decision (done or refused) is appended to approvals.jsonl, hash-chained and signed with the sealed-answers key (receipts), so a missing or
//     edited line shows. The log is local app data, not the workspace.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const MAX_DECISIONS = 50, MAX_NEEDS = 300, NOT_ON_SCREEN_MS = 15000;

// "approve Bash: ls -la" -> { tool: "Bash", action: "ls -la" }; "approve SendMessage" -> tool only; anything else -> tool "" and the whole text
function parseNeeds(needs) {
  const t = String(needs || "").replace(/^approve\s*/i, "").trim();
  const m = /^([A-Za-z][\w.-]{0,40})(?::\s*([\s\S]*))?$/.exec(t);
  if (m && (m[2] !== undefined || /^[A-Z]/.test(m[1]))) return { tool: m[1], action: String(m[2] || "").trim() };
  return { tool: "", action: t };
}

// pending: Map agentPath -> { needs, since }. Returns the rows the pop-up draws, longest-waiting first.
// onScreen(agentPath, needs) -> bool decides whether the owner's click can really answer it; rows that cannot are listed but not actionable.
function buildItems(pending, onScreen, nameOf, now) {
  const rows = [];
  for (const [agentPath, p] of pending) {
    const pn = parseNeeds(p.needs);
    rows.push({ agentPath, name: nameOf(agentPath), tool: pn.tool, action: pn.action.slice(0, 400), needs: String(p.needs).slice(0, 600), since: p.since, waitedMs: Math.max(0, now - p.since), answerable: !!onScreen(agentPath, p.needs) });
  }
  // a request whose prompt is not on the agent's screen is listed only after 15 s: right after an answer the daemon's job file still says "blocked" for a moment
  rows.splice(0, rows.length, ...rows.filter((r) => r.answerable || r.waitedMs >= NOT_ON_SCREEN_MS));
  rows.sort((a, b) => a.since - b.since || (a.agentPath < b.agentPath ? -1 : 1));
  return rows;
}
// the list is "the same" for repaint purposes when agents, requests and answerability are the same (waited time does not count)
function listKey(items) { return items.map((i) => [i.agentPath, i.since, i.answerable ? 1 : 0].join("|")).join("\n"); }

// Normalises what the renderer sent. Returns { ok, decisions } or { ok:false, error }.
function checkBatch(decisions) {
  if (!Array.isArray(decisions) || !decisions.length) return { ok: false, error: "nothing to answer" };
  if (decisions.length > MAX_DECISIONS) return { ok: false, error: "too many at once" };
  const seen = new Set(), out = [];
  for (const d of decisions) {
    if (!d || typeof d.agentPath !== "string" || !d.agentPath || (d.answer !== "approve" && d.answer !== "deny") || typeof d.since !== "number" || !isFinite(d.since)) return { ok: false, error: "malformed decision" };
    if (seen.has(d.agentPath)) return { ok: false, error: "the same agent twice" };
    seen.add(d.agentPath);
    out.push({ agentPath: d.agentPath, answer: d.answer, since: d.since });
  }
  return { ok: true, decisions: out };
}

// Append-only, hash-chained log. io = { file, sign(rec)->rec|null, now() }. A failed signature never blocks the answer; the line says sealed:false.
function createLog(io) {
  const now = io.now || Date.now;
  let prev = null;
  function lastHash() {
    if (prev !== null) return prev;
    prev = "genesis";
    try {
      const lines = fs.readFileSync(io.file, "utf8").trim().split("\n");
      const l = lines[lines.length - 1];
      if (l) prev = crypto.createHash("sha256").update(l, "utf8").digest("hex");
    } catch (e) { /* new log */ }
    return prev;
  }
  function add(rec) {
    const base = Object.assign({ v: 1, ts: now(), prev: lastHash() }, rec);
    base.needs = String(base.needs || "").slice(0, MAX_NEEDS);
    let line;
    try { line = io.sign ? io.sign(Object.assign({ sealed: true }, base)) : null; } catch (e) { line = null; base.sign_error = String(e && e.message || e).slice(0, 120); }
    if (!line) line = Object.assign({ sealed: false }, base);
    const text = JSON.stringify(line);
    try { fs.mkdirSync(path.dirname(io.file), { recursive: true }); fs.appendFileSync(io.file, text + "\n"); prev = crypto.createHash("sha256").update(text, "utf8").digest("hex"); } catch (e) { return false; }
    return true;
  }
  return { add };
}
// Checks the chain and every signature. pub = {kid, pub}. Returns { ok, lines, bad: [line numbers] }.
function verifyLog(file, pub, verifyReceipt) {
  let lines; try { lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean); } catch (e) { return { ok: true, lines: 0, bad: [] }; }
  const bad = []; let prev = "genesis";
  lines.forEach((l, i) => {
    let r; try { r = JSON.parse(l); } catch (e) { bad.push(i + 1); prev = crypto.createHash("sha256").update(l, "utf8").digest("hex"); return; }
    if (r.prev !== prev) bad.push(i + 1);
    else if (r.sealed && !verifyReceipt(r, pub)) bad.push(i + 1);
    prev = crypto.createHash("sha256").update(l, "utf8").digest("hex");
  });
  return { ok: bad.length === 0, lines: lines.length, bad };
}

module.exports = { parseNeeds, buildItems, listKey, checkBatch, createLog, verifyLog, MAX_DECISIONS };
