// v1.100.0 message outbox with acknowledgement - pure logic (renderer: window.OutboxLogic, main/tests: require).
// Every message the owner sends from the compose box gets an item here at Send time. It stays until the agent's transcript
// shows it (the ack), is retried with backoff when it provably did not arrive, and survives an app restart. Nothing in
// this file does I/O: the renderer glue (renderer/outbox.js) and main (guards-main.js) feed it facts.
// Rules that keep a retry from ever producing a duplicate are in decide(); see DESIGN.md section 3.
(function (root) {
  "use strict";
  const MAX_ATTEMPTS = 3;                 // sends in total the label counts to (manual Retry clicks may still go on)
  const MAX_AUTO_ATTEMPTS = 2;            // v1.101.0 re-review F2: the first send + at most ONE automatic re-send
  const BACKOFF_BASE_MS = 30 * 1000;      // 30 s, 60 s, 120 s ...
  const BACKOFF_MAX_MS = 5 * 60 * 1000;
  const IDLE_BEFORE_RETRY_MS = 20 * 1000; // agent idle and transcript quiet this long before a re-send
  const TTL_MS = 48 * 3600 * 1000;
  const KEEP_SEEN_MS = 10 * 60 * 1000;    // a seen item stays this long (UI), then it is dropped
  const MAX_ITEMS = 200;
  const MAX_TEXT = 20000;
  const MAX_FILE_BYTES = 1024 * 1024;
  const STRONG_MIN = 20;                  // shorter text cannot be told apart reliably: never re-sent automatically
  const MERGE_WINDOW_MS = 30 * 1000;
  const STATES = ["queued", "sent", "seen", "failed", "cancelled"];
  const LONG_REF_RE = /^This message was too long to paste directly, so it was saved to a file - please read it: "([^"]+)"$/;
  // v1.101.0 review fixes (REVIEW.md B1-B3, S1-S7):
  const MAX_AUTO_AGE_MS = 10 * 60 * 1000;  // B2: older than this (since Send) -> never sent again automatically, only Retry
  const UNKNOWN_MANUAL_MS = 5 * 60 * 1000; // S6: transcript cannot tell for this long -> "cannot confirm", no auto send
  const RETRY_LOCK_MS = 20 * 1000;         // N1: a Retry click this soon after a send is refused ("just sent")
  // the same character class as src/pasteText.js / renderer.js submitToAgent: what is really typed (S3)
  const PASTE_UNSAFE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
  const clean = (s) => String(s == null ? "" : s).replace(PASTE_UNSAFE_RE, "");
  // B3: the CLI runs "/..." as a command and "!..." as a shell line and stores neither as the typed text
  // (re-review R9: invisible direction / zero-width marks in front count as blank too - manual only, so harmless.
  // "#" is NOT a prefix: CLI 2.1.273 stores "#..." user text verbatim, it is no longer a memory command.)
  const isCommand = (s) => /^[\s​-‏‪-‮⁠﻿]*[\/!]/.test(clean(s));
  // Texts the APP or another agent types into a session (not the owner's instructions): handoff / reset prompts, keep-going
  // nudges, wake / agent-to-agent notes, IRIS pointers, [hid:...] system messages, CLI command / shell / caveat markup,
  // compact summaries, interrupt markers. Anything else that is a user entry after the send = the conversation moved on.
  const APP_PROMPT_RE = /^[\s​-‏﻿]*(\[Agent Desktop|\[hid:|\[Agent-to-agent|\[Wake request|\[IRIS\]|\[Request interrupted|<command-name>|<command-message>|<command-args>|<local-command-|<bash-|<system-reminder>|<task-notification>|Caveat: The messages below|This session is being continued from a previous conversation|Please carry on with the next step you announced)/i;
  const isAppPrompt = (s) => { const t = clean(s); return APP_PROMPT_RE.test(t) || t.indexOf("[[HANDOFF-RESUME]]") >= 0 || t.indexOf("[[KEEPGOING]]") >= 0; };

  const norm = (s) => clean(s).replace(/<\/?pasted_content[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  function newId(now, rnd) {
    const r = typeof rnd === "function" ? rnd() : Math.random();
    return "ob" + Number(now || Date.now()).toString(36) + Math.floor(r * 1e9).toString(36);
  }
  function longRef(text) { const m = LONG_REF_RE.exec(String(text || "").trim()); return m ? m[1] : null; }

  // What identifies a message in a transcript. strong = unique enough that "not found" really means "not there".
  function needleFor(text) {
    const n = norm(text);
    const ref = longRef(n);
    if (ref) {
      const base = ref.split(/[\\/]/).pop();
      return { exact: n, fp: base, strong: base.length >= 8, ref: true };
    }
    return { exact: n, fp: n.slice(-80).trim(), strong: n.length >= STRONG_MIN, ref: false };
  }

  function create(agentPath, text, now, rnd) {
    const t = now || Date.now();
    return { id: newId(t, rnd), agentPath: String(agentPath || ""), text: clean(text), createdAt: t,
      firstSentAt: 0, lastSentAt: 0, attempts: 0, state: "queued", written: false, nextRetryAt: 0, seenAt: 0, why: "",
      newer: false, manual: false };
  }
  // command markup the CLI writes for a slash command: <command-name>/x</command-name> ... <command-args>y</command-args>
  function commandText(s) {
    const n = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(s);
    if (!n) return null;
    const a = /<command-args>([\s\S]*?)<\/command-args>/.exec(s);
    const name = n[1].charAt(0) === "/" ? n[1] : "/" + n[1];
    return a && a[1].trim() ? name + " " + a[1].trim() : name;
  }

  // ---- transcript ack --------------------------------------------------------------------------------------------
  function entryText(o) {
    if (!o || typeof o !== "object") return null;
    if (o.type === "user") {
      const c = o.message && o.message.content;
      if (typeof c === "string") return { kind: "user", text: c.indexOf("<command-name>") >= 0 ? (commandText(c) || c) : c };
      if (Array.isArray(c)) {
        const parts = c.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text);
        if (parts.length) return { kind: "user", text: parts.join(" ") };
      }
      return null;
    }
    if (o.type === "attachment" && o.attachment && o.attachment.type === "queued_command") {
      const pr = o.attachment.prompt;
      return { kind: "user", text: typeof pr === "string" ? pr : JSON.stringify(pr || "") };
    }
    if (o.type === "queue-operation" && (o.operation === "enqueue" || o.operation === "remove")) {
      return { kind: o.operation === "enqueue" ? "queued" : "removed", text: String(o.content == null ? "" : o.content) };
    }
    return null;
  }
  function textMatches(nd, t, entryMs, sentMs) {
    const n = norm(t);
    if (!n) return false;
    if (n === nd.exact) return true;
    if (nd.ref) return n.includes(nd.fp);
    if (nd.strong) return nd.fp.length >= 20 && n.includes(nd.fp);
    // short text: exact only, or the tail of an entry written right after the send (CLI merged a leftover in the box)
    return n.endsWith(nd.exact) && n.length <= nd.exact.length + 40 && entryMs - sentMs <= MERGE_WINDOW_MS;
  }
  // files: [{ lines: [jsonl line strings], current: bool, truncated: bool }] newest first.
  // -> "user" | "queued" | "other" | "none" | null (cannot tell: a cut tail does not reach back to the send time)
  // "queued" only counts in the CURRENT transcript: a receipt in an older session file was lost with that process.
  // "other" (re-review): not there, but some OTHER user entry that is not an app prompt arrived after the send - the owner
  // typed something else (Raw Terminal, PHEME, another window) or the CLI stored ours in a form we do not recognise.
  // Either way it must never be sent again automatically.
  function scanTranscripts(files, text, sinceMs, lastSentMs) {
    const nd = needleFor(text);
    if (!nd.exact) return "user";
    let queued = false, blind = false, other = false;
    for (const f of files || []) {
      let enq = 0, firstMs = null;
      for (const line of f.lines || []) {
        if (firstMs == null && line) { const m = /"timestamp":"([^"]+)"/.exec(line); if (m) firstMs = Date.parse(m[1]); }
        if (!line || (line.indexOf('"user"') < 0 && line.indexOf("queue-operation") < 0 && line.indexOf("queued_command") < 0)) continue;
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        const ms = o && o.timestamp ? Date.parse(o.timestamp) : NaN;
        if (!(ms >= sinceMs - 2000)) continue;
        const e = entryText(o);
        if (!e) continue;
        if (!textMatches(nd, e.text, ms, lastSentMs || sinceMs)) {
          if (e.kind === "user" && ms > sinceMs && !o.isMeta && !o.isCompactSummary && !o.isSidechain && !o.toolUseResult &&
              norm(e.text) && !isAppPrompt(e.text) && !isCommand(e.text)) other = true; // command markup (e.g. /clear, /model) excluded
          continue;
        }
        if (e.kind === "user") return "user";
        if (e.kind === "queued") enq++;
        else if (e.kind === "removed" && enq > 0) enq--;
      }
      if (f.current && enq > 0) queued = true;
      if (f.truncated && (firstMs == null || firstMs > sinceMs - 2000)) blind = true;
    }
    return queued ? "queued" : other ? "other" : blind ? null : "none";
  }

  // v1.114.1: does a read of the END of a transcript reach back to the moment the message was sent? A busy agent that reads screenshots
  // makes its transcript huge (8 MB, the proof of delivery 3 MB from the end), so a fixed 2 MB tail missed it: the message was then
  // judged "Not delivered" although the agent had read it. The reader widens the window until this returns true (or a hard cap).
  function tailReachesBack(lines, truncated, sinceMs) {
    if (!truncated) return true;
    for (const line of lines || []) {
      if (!line) continue;
      const m = /"timestamp":"([^"]+)"/.exec(line);
      if (m) { const t = Date.parse(m[1]); return Number.isFinite(t) && t <= sinceMs - 2000; }
    }
    return false;
  }

  // ---- retry decision --------------------------------------------------------------------------------------------
  function backoffMs(attempts) { return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempts - 1))); }

  // Why a provably missing message must NOT be delivered automatically (it gets a Retry button instead), or null.
  //   command: "/..." or "!..." (B3)   newer: he sent another message to this agent after it (B1, order)
  //   old: older than MAX_AUTO_AGE_MS since Send, also after a restart (B2)   short: written short text (duplicate risk)
  function blockReason(item, ctx) {
    const c = ctx || {};
    if (isCommand(item.text)) return "command";
    if (item.newer) return "newer";
    // re-review nit: in-run age from a monotonic clock (ctx.ageMs) when the glue has one; disk items use createdAt
    const age = typeof c.ageMs === "number" ? Math.max(c.ageMs, (c.now || Date.now()) - (item.createdAt || 0)) : (c.now || Date.now()) - (item.createdAt || 0);
    if (age > MAX_AUTO_AGE_MS) return "old";
    if (item.written && !needleFor(item.text).strong) return "short";
    return null;
  }

  // ctx: { now, seen: "user"|"queued"|"none"|null(unknown), where: "queue"|"held"|"pending"|"pendingFailed"|"absent",
  //        started, connected, inFlow, queueEmpty, idleForMs, boxHolds, dispatching, paused, unknownForMs }
  // -> "seen" | "wait" | "requeue" (never written: put back in the queue) | "retry" | "give-up" | "manual"
  // "manual" is sticky (the glue sets item.manual): once a message is offered as Retry it is never sent automatically.
  function decide(item, ctx) {
    const c = ctx || {};
    if (!item || item.state === "seen" || item.state === "cancelled") return "wait";
    if (c.seen === "user") return "seen";
    if (c.where === "queue" || c.where === "held") return "wait";       // the app still holds it: the normal drain sends it
    if (c.where === "pending") return "wait";                           // in flight: the existing detectors are watching it
    if (c.dispatching) return "wait";                                   // S1: its Send is still running (no requeue race)
    if (item.manual) return "manual";
    if (c.seen === "queued") return "wait";                             // the CLI has it queued behind a turn
    if (c.seen === "other") return "manual";                            // re-review: the conversation moved on after it
    if (c.seen !== "none") return (c.unknownForMs || 0) >= UNKNOWN_MANUAL_MS ? "manual" : "wait"; // S6: never act on a guess
    if (blockReason(item, c)) return "manual";
    if (!c.started || !c.connected || c.inFlow) return "wait";          // a held / reconnecting / handing-off agent waits
    if (c.paused) return "wait";                                        // S2: nothing goes into an agent he paused
    if (!item.written) return c.where === "absent" ? "requeue" : "wait"; // never reached the pty: no duplicate possible
    if (item.attempts >= MAX_AUTO_ATTEMPTS) return "give-up";           // F2: at most one automatic re-send per message
    if (c.boxHolds) return "wait";                                      // stuck in the input box: the Enter ladder owns it
    if (!c.queueEmpty) return "wait";                                   // keep the order: earlier queued messages first
    if ((c.idleForMs || 0) < IDLE_BEFORE_RETRY_MS) return "wait";
    if ((item.nextRetryAt || 0) > (c.now || 0)) return "wait";
    return "retry";
  }

  // What the user sees for a message (bubble mark / queue chip). reason: "handoff"|"reconnect"|"starting"|"busy"
  function label(item, info) {
    const i = info || {};
    if (!item) return "";
    if (item.state === "seen") return "✓ delivered";
    if (i.waiting) { // v1.110.0 (B2): a calm bubble drawn while the outbox waits (no red, no Retry, no "automatically")
      if (!item.written) return i.paused ? "Not sent yet - waiting, the agent is paused" : "Not sent yet - waiting for the agent";
      return i.paused ? "Sent - waiting for confirmation (the agent is paused)" : "Sent - waiting for confirmation";
    }
    if (i.where === "queue" || i.where === "held") {
      if (i.reason === "handoff") return "waiting for the new session (handoff in progress)";
      if (i.reason === "reconnect") return "waiting for reconnect";
      if (i.reason === "starting") return "waiting - the session is starting";
      return "waiting - the agent is busy, sent when it is free";
    }
    if (i.justSent) return "just sent - waiting for the agent";
    if (item.state === "failed") {
      // NB renderer.js draws a label containing "automatically" as the calm (pending) bubble: only the real auto re-send says it
      const why = item.manual ? item.why : "";
      if (why === "command") return "Not confirmed - commands are not re-run by Agent Desktop. Check the conversation, then Retry if needed";
      if (why === "newer") return "Not delivered - you sent other messages after it. Retry if it is still needed";
      if (why === "old") {
        const min = Math.max(1, Math.round(((i.now || Date.now()) - (item.createdAt || 0)) / 60000));
        return "Not delivered - " + (item.disk ? "from before the restart" : "sent " + min + " min ago") + ". Retry if it is still needed";
      }
      if (why === "unknown") return "Cannot confirm delivery - check the conversation, then Retry if it is missing";
      if (why === "later") return "Not confirmed - other messages arrived in this conversation after it. Check the conversation, then Retry if it is still needed";
      if (!needleFor(item.text).strong) return "Not confirmed - check the conversation, then Retry if it is missing";
      if (item.attempts >= MAX_AUTO_ATTEMPTS) return "Not delivered after " + item.attempts + " tries";
      if (i.paused) return "Not confirmed - the agent is paused; nothing is sent again while it is paused";
      if (item.lastSeen !== "none") return "Not confirmed yet - checking the conversation";
      return "Not confirmed yet - Agent Desktop sends it again automatically, once";
    }
    if (item.attempts > 1) return "sent again (attempt " + item.attempts + ")";
    return "";
  }

  // Connection banner (dead pty): a plain "not connected" with Restart session once automatic re-attach has failed twice.
  function connectionNotice(snap, queued) {
    if (!snap || snap.state === "connected") return null;
    const n = queued || 0;
    const kept = n ? " " + n + " message" + (n > 1 ? "s are" : " is") + " kept and sent automatically when it is back." : " Messages you send are kept and sent when it is back.";
    if (snap.state === "restarting") return { text: "Reconnecting to this agent - restarting its session." + kept, restart: false };
    if (snap.state === "degraded" || (snap.attempts || 0) >= 2) {
      return { text: "Not connected to this agent - automatic reconnect has not worked." + kept + " Restart session usually fixes it (the conversation is kept).", restart: true };
    }
    return { text: "Reconnecting to this agent (attempt " + ((snap.attempts || 0) + 1) + ")." + kept, restart: false };
  }

  // ---- persistence ------------------------------------------------------------------------------------------------
  // stats (optional, filled in): { dropped: n, droppedUnsent: n, tooLong: n } so the glue can warn instead of losing silently.
  // N3: when over the cap, seen items go first, then written ones, and never-written (unsent) ones last, oldest first.
  function serialize(items, now, stats) {
    const t = now || Date.now();
    const st = stats || {};
    st.dropped = 0; st.droppedUnsent = 0; st.tooLong = 0;
    let list = (items || []).filter((x) => x && x.id && x.agentPath && typeof x.text === "string" && x.text &&
      STATES.indexOf(x.state) >= 0 && x.state !== "cancelled" && t - (x.createdAt || 0) < TTL_MS &&
      !(x.state === "seen" && t - (x.seenAt || 0) > KEEP_SEEN_MS));
    const longOnes = list.filter((x) => x.text.length > MAX_TEXT);
    st.tooLong = longOnes.length;
    list = list.filter((x) => x.text.length <= MAX_TEXT);
    const rank = (x) => (x.state === "seen" ? 0 : x.written ? 1 : 2);
    const evict = () => {
      let k = -1;
      list.forEach((x, i) => { if (k < 0 || rank(x) < rank(list[k]) || (rank(x) === rank(list[k]) && x.createdAt < list[k].createdAt)) k = i; });
      const [x] = list.splice(k, 1);
      st.dropped++; if (rank(x) === 2 || x.state === "failed") st.droppedUnsent++;
    };
    while (list.length > MAX_ITEMS) evict();
    list.sort((a, b) => a.createdAt - b.createdAt);
    const pick = (x) => ({ id: x.id, agentPath: x.agentPath, text: x.text, createdAt: x.createdAt, firstSentAt: x.firstSentAt || 0,
      lastSentAt: x.lastSentAt || 0, attempts: x.attempts || 0, state: x.state, written: !!x.written, nextRetryAt: x.nextRetryAt || 0, seenAt: x.seenAt || 0,
      newer: !!x.newer, manual: !!x.manual, why: x.why || "" });
    let out = JSON.stringify({ v: 1, items: list.map(pick) });
    while (out.length > MAX_FILE_BYTES && list.length) { evict(); list.sort((a, b) => a.createdAt - b.createdAt); out = JSON.stringify({ v: 1, items: list.map(pick) }); }
    return out;
  }
  // v1.111.2: Dismiss on a failed bubble. Pure: the list without the one item `id` (every other item untouched, never resent).
  function dismissItem(list, id) {
    const all = Array.isArray(list) ? list : [];
    const rest = all.filter((x) => !(x && x.id === id));
    return { rest, removed: rest.length !== all.length };
  }
  // Loaded items are flagged disk:true (they come from before this run of the app).
  function parse(json, now) {
    const t = now || Date.now();
    try {
      const o = JSON.parse(String(json || "").replace(/^﻿/, ""));
      return (o && Array.isArray(o.items) ? o.items : [])
        .filter((x) => x && typeof x.id === "string" && typeof x.agentPath === "string" && typeof x.text === "string" && x.text &&
          typeof x.createdAt === "number" && t - x.createdAt < TTL_MS && STATES.indexOf(x.state) >= 0 && x.state !== "cancelled")
        .slice(-MAX_ITEMS)
        .map((x) => Object.assign(create(x.agentPath, x.text, x.createdAt), {
          id: x.id, firstSentAt: +x.firstSentAt || 0, lastSentAt: +x.lastSentAt || 0, attempts: Math.min(+x.attempts || 0, MAX_ATTEMPTS),
          state: x.state, written: !!x.written, nextRetryAt: +x.nextRetryAt || 0, seenAt: +x.seenAt || 0, disk: true,
          newer: !!x.newer, manual: !!x.manual, why: typeof x.why === "string" ? x.why : "" }));
    } catch (e) { return []; }
  }

  const api = { MAX_ATTEMPTS, BACKOFF_BASE_MS, IDLE_BEFORE_RETRY_MS, TTL_MS, KEEP_SEEN_MS, MAX_ITEMS, MAX_TEXT, MAX_FILE_BYTES, STRONG_MIN,
    MAX_AUTO_AGE_MS, UNKNOWN_MANUAL_MS, RETRY_LOCK_MS, PASTE_UNSAFE_RE, MAX_AUTO_ATTEMPTS,
    clean, isCommand, isAppPrompt, commandText, norm, longRef, needleFor, create, entryText, scanTranscripts, tailReachesBack, backoffMs, blockReason, decide, label,
    connectionNotice, serialize, parse, dismissItem };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.OutboxLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
