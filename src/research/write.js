// MY RESEARCH - "Write to <agent>" (v1.89.0, main process, no electron import: everything is injected so tests can drive it).
// The user writes back to the agent that produced a finding (ask, correct, approve, push back). The text reaches the agent through the SAME
// verified delivery as My Daily > Tasks "Write an answer" (deliverToAgentVerified: message channel first, pty only as a fallback, never typed
// twice, checked in the transcript) and is classified with the same classifyDelivery (sent / queued / failed).
// What is new here, on top of the triage path:
//  - the agent must be RUNNING for a live delivery. When it is not, nothing is typed anywhere: the message is appended to that agent's
//    <slug>_pending_notes.md at the workspace root (the fleet's documented fallback for an agent that is not running) and the result says so.
//  - every attempt is logged, append-only, to <research>\_writes.jsonl (time, week, agent, finding id, delivery, first 200 chars) for the COO.
// SAFE: the renderer sends a week name, an agent NAME and a finding id, never a path. The agent name must resolve to an existing agent folder
// (resolveAgent, from the app's own agent list) and must not contain path characters; the finding must exist in that week's digest.
// Text length cap, one send per finding at a time, a small rate limit, and the same text to the same agent twice in 10 minutes is refused.
"use strict";
const fs = require("fs");
const path = require("path");

const MAX_TEXT = 4000;
const LOG_CHARS = 200;
const RATE_WINDOW_MS = 60 * 1000, RATE_MAX = 6;          // at most 6 sends a minute, whatever the agent
const DUP_WINDOW_MS = 10 * 60 * 1000;                     // the same text to the same agent again within 10 minutes is refused
const WEEK_RE = /^\d{4}-W\d{2}$/;
const BAD_NAME_RE = /[\\/:*?"<>|\u0000-\u001f]|\.\./;
const WEEK_ID = "_week";                                  // finding id used when writing about the agent's whole week (the tile panel)

const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();

// v1.121.0: the maintenance/optimization agent's notes file is called optimization_agent_pending_notes.md in the fleet; which folder that is comes
// from the configured role (roleOptimization, exact folder name or a prefix with a trailing *), never from a literal folder name.
const OPTIMIZATION_NOTES_SLUG = "optimization_agent";
const slugOf = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
function isOptimizationRole(fullSlug) {
  let role = null;
  try { role = require("../appConfig").get("roleOptimization"); } catch (e) { role = null; }
  if (typeof role !== "string" || !role.trim()) return false;
  const prefix = role.trim().endsWith("*");
  const r = slugOf(role.replace(/\*$/, ""));
  return !!r && (prefix ? fullSlug.startsWith(r) : fullSlug === r);
}
// "COO Agent" -> ["coo_agent", "coo"]; the first existing <slug>_pending_notes.md wins, else the full slug is created.
function pendingSlugs(agentFolder) {
  const full = String(agentFolder || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "agent";
  const short = full.replace(/_agent$/, "");
  // v1.104.0: folder names whose notes file has another name in the fleet ("System Optimization & Maintenance Agent" reads optimization_agent_pending_notes.md)
  const alias = isOptimizationRole(full) ? OPTIMIZATION_NOTES_SLUG : null;
  const base = short && short !== full ? [full, short] : [full];
  return alias ? [alias].concat(base) : base;
}
function pendingFileFor(root, agentFolder) {
  const slugs = pendingSlugs(agentFolder);
  for (const s of slugs) { const f = path.join(root, s + "_pending_notes.md"); try { if (fs.lstatSync(f).isFile()) return f; } catch (e) { /* not there */ } }
  return path.join(root, slugs[0] + "_pending_notes.md");
}

// The message the agent gets. The reference line is built HERE from the digest (not trusted from the renderer).
function messageFor(ref, text, owner) {
  const who = oneLine(owner).slice(0, 60) || "the user";
  const head = ref.findingId === WEEK_ID
    ? "From " + who + ", via the My Research tab: about your research digest for " + ref.week + "."
    : "From " + who + ", via the My Research tab: about your " + (String(ref.findingId).startsWith("rec:") ? "recommendation" : "research finding") + " (" + ref.week + ", id " + ref.findingId + "): \"" + oneLine(ref.title).slice(0, 300) + "\"";
  return head + "\nThis has real consequences for him: answer him in your own chat, and if it changes the finding, correct your next digest.\n\n" + String(text).trim();
}

function createWriter(o) {
  const ownerNow = () => (typeof o.owner === "function" ? o.owner() : o.owner) || "";
  const clock = typeof o.now === "function" ? o.now : () => Date.now();
  const say = typeof o.log === "function" ? o.log : () => {};
  const researchDir = o.researchDir, root = o.root;
  const inflight = new Set();
  const recent = [];                 // [{at, agent, text}] in memory: rate limit + duplicate check
  const logFile = path.join(researchDir, "_writes.jsonl");

  function logLine(entry) {
    try {
      fs.mkdirSync(researchDir, { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8");     // UTF-8 without BOM, one JSON object per line
      return true;
    } catch (e) { say("research-write log failed: code=" + (e && e.code ? e.code : "unknown")); return false; }
  }

  function appendPending(agentFolder, ref, text, hidden) {
    const f = pendingFileFor(root, agentFolder);
    const d = new Date(clock()), p2 = (x) => String(x).padStart(2, "0");
    const when = d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());   // local time, like the other pending notes
    const block = "\n## " + when + " - from " + (oneLine(ownerNow()).slice(0, 60) || "the user") + " via My Research (" + ref.week + (ref.findingId === WEEK_ID ? "" : ", finding " + ref.findingId) + ")\n" +
      (hidden ? "Delivered here because " + (oneLine(ownerNow()).slice(0, 60) || "the user") + " talks to " + agentFolder + " outside Agent Desktop (hidden there). Read it"   // v1.141.0
        : "Delivered here because " + agentFolder + " was not running. Read it") + " at your next start and answer " + (oneLine(ownerNow()).slice(0, 60) || "the user") + ".\n\n" + messageFor(ref, text, ownerNow()) + "\n";
    let st = null;
    try { st = fs.lstatSync(f); } catch (e) { /* new file */ }
    if (st && !st.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOTFILE" });
    fs.appendFileSync(f, (st ? "" : "# " + agentFolder + " - pending notes\n") + block, "utf8");
    return path.basename(f);
  }

  // a = { week, agent, findingId, text } -> { ok, delivery: "sent"|"queued"|"pending", file?, reason? }
  async function write(a) {
    const arg = a && typeof a === "object" ? a : {};
    const week = typeof arg.week === "string" ? arg.week : "", agent = clip(arg.agent, 120).trim(), fid = clip(arg.findingId, 120);
    const text = typeof arg.text === "string" ? arg.text : "";
    if (!WEEK_RE.test(week) || !agent || !fid) return { ok: false, reason: "Bad request." };
    if (BAD_NAME_RE.test(agent)) return { ok: false, reason: "That agent name is not allowed, so nothing was sent." };
    if (!text.trim()) return { ok: false, reason: "Write your message first." };
    if (text.length > MAX_TEXT) return { ok: false, reason: "That is " + text.length + " characters; the limit is " + MAX_TEXT + ". Shorten it (nothing was sent)." };
    const ref = typeof o.findRef === "function" ? await o.findRef(week, agent, fid) : null;
    if (!ref) return { ok: false, reason: "That finding is no longer in " + agent + "'s digest for " + week + ". Refresh the tab (nothing was sent)." };
    const agentPath = typeof o.resolveAgent === "function" ? o.resolveAgent(agent) : null;
    if (!agentPath || path.resolve(path.dirname(agentPath)).toLowerCase() !== path.resolve(root).toLowerCase()) return { ok: false, reason: "\"" + agent + "\" is not a known agent folder, so nothing was sent." };
    const agentFolder = path.basename(agentPath);
    const key = week + "|" + agentFolder.toLowerCase() + "|" + fid;
    if (inflight.has(key)) return { ok: false, reason: "This message is already being sent." };
    const t = clock();
    while (recent.length && t - recent[0].at > DUP_WINDOW_MS) recent.shift();
    if (recent.filter((x) => t - x.at < RATE_WINDOW_MS).length >= RATE_MAX) return { ok: false, reason: "Too many messages in the last minute. Wait a moment and send again (nothing was sent)." };
    const same = recent.find((x) => x.agent === agentFolder.toLowerCase() && x.text === text.trim());
    if (same) return { ok: false, reason: "The same message went to " + agentFolder + " at " + new Date(same.at).toTimeString().slice(0, 5) + ". It was not sent again." };
    inflight.add(key);
    try {
      ref.week = week; ref.findingId = fid;
      const base = { time: new Date(t).toISOString(), week, agent: agentFolder, finding: fid, text: oneLine(text).slice(0, LOG_CHARS) };
      let running = false;
      // v1.141.0: an agent in the hiddenAgents setting is talked to OUTSIDE Agent Desktop (the owner uses the Claude desktop app for it), so a
      // message from here is NEVER delivered into its Agent Desktop session: it always goes to its pending-notes file, like a stopped agent.
      let hidden = false;
      try { hidden = typeof o.isHidden === "function" && !!o.isHidden(agentFolder); } catch (e) { hidden = false; }
      try { running = !hidden && typeof o.isRunning === "function" && !!o.isRunning(agentPath); } catch (e) { running = false; }
      if (!running) {
        let file;
        try { file = appendPending(agentFolder, ref, text, hidden); }
        catch (e) { say("research-write pending note failed: code=" + (e && e.code ? e.code : "unknown")); logLine(Object.assign(base, { delivery: "failed", why: "not running, pending note not written" })); return { ok: false, delivery: "failed", reason: agentFolder + " is not running, and its pending-notes file could not be written. Nothing was sent." }; }
        recent.push({ at: t, agent: agentFolder.toLowerCase(), text: text.trim() });
        logLine(Object.assign(base, { delivery: "pending", file }, hidden ? { hidden: true } : {}));
        say("research-write: " + agentFolder + (hidden ? " hidden -> pending note" : " not running -> pending note"));
        return hidden ? { ok: true, delivery: "pending", hidden: true, agentName: agentFolder, file } : { ok: true, delivery: "pending", file };
      }
      let r;
      try { r = await o.deliver(agentPath, messageFor(ref, text, ownerNow())); } catch (e) { r = { delivered: false, error: e && e.message }; }
      const c = typeof o.classify === "function" ? o.classify(r) : (r && r.delivered ? { delivery: "sent" } : { delivery: "failed", reason: "The agent did not take the message." });
      say("research-write: " + agentFolder + " -> " + c.delivery + (r && r.via ? " via " + r.via : ""));
      if (c.delivery !== "failed" || (r && r.dry)) logLine(Object.assign(base, { delivery: c.delivery }));
      if (c.delivery === "failed" && !(r && r.dry)) {
        // v1.105.0: a running agent whose chat input holds unsent text (or is otherwise not accepting a paste) never loses the message:
        // it is saved to the agent's pending notes like for a stopped agent, and the page says why
        try {
          const file = appendPending(agentFolder, ref, text);
          recent.push({ at: t, agent: agentFolder.toLowerCase(), text: text.trim() });
          logLine(Object.assign(base, { delivery: "pending", busy: true, file }));
          say("research-write: " + agentFolder + " refused the paste -> pending note");
          return { ok: true, delivery: "pending", busy: true, file };
        } catch (e) { say("research-write busy pending note failed: code=" + (e && e.code ? e.code : "unknown") + " " + (e && e.message)); }
      }
      if (c.delivery === "failed" && !(r && r.dry)) logLine(Object.assign(base, { delivery: "failed" }));
      if (c.delivery === "failed") return { ok: false, delivery: "failed", reason: c.reason || "The agent did not take the message. Nothing was sent; try again." };
      recent.push({ at: t, agent: agentFolder.toLowerCase(), text: text.trim() });
      return { ok: true, delivery: c.delivery };
    } finally { inflight.delete(key); }
  }

  return { write, logFile, inflightCount: () => inflight.size };
}

module.exports = { createWriter, messageFor, pendingFileFor, pendingSlugs, MAX_TEXT, WEEK_ID, RATE_MAX, LOG_CHARS };
