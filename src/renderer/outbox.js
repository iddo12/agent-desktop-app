// v1.100.0 message outbox with acknowledgement - renderer glue (logic: src/outbox.js, design: DESIGN.md).
// Loaded after renderer.js, guards.js and connection-health.js; uses their globals (terminals, agents, sendOrHold,
// renderQueue, renderChatBlocks, setBusy, activeAgentPath). Every entry point is wrapped so a bug here can only switch the
// outbox off, never break sending. Nothing typed into the pty changes: a (re)send goes through the same sendChain +
// sendOrHold path as the Send button.
//
// Each compose-box message gets an item at Send time (renderer.js sendChatInput -> outbox.add / outbox.bind /
// outbox.dispatched). A 2 s tick (only while items exist) finds where the message is (app queue / held by a handoff /
// pending bubble / gone), asks main whether the transcript has it after the send time (IPC outbox-seen), and acts per
// OutboxLogic.decide(): seen -> done; never written and gone -> back in the queue; written, provably missing, agent idle
// -> re-send (max 3 sends, backoff), otherwise a visible failed bubble with Retry. Persisted to <userData>\outbox.json.
//
// v1.101.0 (independent review, REVIEW.md): only the NEWEST message to an agent is ever delivered automatically (B1);
// nothing older than 10 min (B2); never a "/" or "!" command (B3); not while its Send is still running (S1); never into a
// paused agent (S2); "delivered" only with transcript proof (S3); fewer, async, memoised transcript reads (S4); save
// failures are kept and retried (S5); honest labels when the transcript cannot tell (S6); never into an open dialog (S7).
// Re-review: PHEME / Library messages (noteSend) and any untagged non-app bubble supersede older items too (F1); at most ONE
// automatic re-send per message (F2); an unexplained later user entry in the transcript ("other") means Retry, never
// automatic; in-run ages, idle time and check timing use performance.now(); Retry on "Cannot confirm" asks first.
(function () {
  "use strict";
  if (!window.OutboxLogic || !window.api || !window.api.outboxSave || !window.api.outboxSeen) return;
  const L = window.OutboxLogic;
  const TICK_MS = 2000;
  const CHECK_EVERY_MS = 15000;   // one transcript check per unconfirmed message per 15 s (in-flight ones are never read)
  const CHECK_SLOW_MS = 60000;    // given up / waiting for Retry
  const CHECK_IDLE_MS = 5 * 60000; // ... and once that is older than 30 min (S4)
  const MAX_CHECKS_PER_TICK = 4;  // S4: batched, so 20 agents never fire 20 reads at once
  const SEEN_FRESH_MS = 20000;
  const items = new Map();        // id -> item (OutboxLogic.create shape)
  const seRef = new Map();        // id -> the session object the item's bubble lived on (not persisted)
  const tagged = new Set();       // ids whose pending bubble this run has seen
  const leftAt = new Map();       // id -> when its bubble left the chat without a failure (S3: confirm with one check)
  const seenRes = new Map();      // id -> { seen, at }
  const checking = new Set();     // ids with an outbox-seen IPC in flight
  const retrying = new Set();     // agentPaths with a (re)send in flight: one at a time per agent
  const dispatching = new Set();  // S1: ids whose Send (sendChatInput run) has not reached sendOrHold yet
  const idleSince = new Map();    // agentPath -> ms it became idle
  const STARTUP_GRACE_MS = 30000;
  let dirty = false, saveFailedAt = 0, saveWarned = false, loadedAt = 0; // set (monotonic) once the load finished

  // re-review nit: a monotonic clock for in-run ages and idle time (a wall-clock change must not stretch or shrink them)
  const perf = () => { try { if (typeof performance !== "undefined" && performance && typeof performance.now === "function") return performance.now(); } catch (e) {} return Date.now(); };
  const nm = (ap) => String(ap || "").split(/[\\/]/).pop();
  const same = (a, b) => L.clean(a) === L.clean(b); // compare what is really typed (C0/C1 stripped) on both sides
  function log(line) { try { window.api.logGuard("outbox: " + line); } catch (e) { /* diagnostics only */ } }
  function sess(ap) { try { return terminals.get(ap) || null; } catch (e) { return null; } }
  // v1.110.0 (B1): main tells the window whenever it pauses / resumes an agent (the budget guard, the Pause button), so this
  // never depends on the agent list the window happened to load last. mainPaused wins over that list.
  const mainPaused = new Map();   // agentPath -> boolean, from the "agent-paused-changed" event
  function paused(ap) {
    if (mainPaused.has(ap)) return !!mainPaused.get(ap);
    try { const a = (typeof agents !== "undefined" && Array.isArray(agents) ? agents : []).find((x) => x && x.path === ap); return !!(a && a.paused); } catch (e) { return false; }
  }
  // S5: a failed save keeps everything in memory, stays dirty and is retried (every 10 s); logged once per failure run
  function flush() {
    if (!dirty) return;
    if (saveFailedAt && Date.now() - saveFailedAt < 10000) return;
    dirty = false;
    const stats = {};
    let json;
    try { json = L.serialize(Array.from(items.values()), Date.now(), stats); } catch (e) { return; }
    if (stats.droppedUnsent || stats.tooLong) log("WARNING: " + (stats.droppedUnsent ? stats.droppedUnsent + " unconfirmed message(s) over the cap are not kept on disk " : "") +
      (stats.tooLong ? stats.tooLong + " message(s) too long to keep on disk" : "") + " (still tracked until the app closes)");
    let p;
    try { p = Promise.resolve(window.api.outboxSave(json)); } catch (e) { p = Promise.resolve({ ok: false, error: (e && e.message) || String(e) }); }
    p.catch((e) => ({ ok: false, error: (e && e.message) || String(e) })).then((r) => {
      if (r && r.ok) { if (saveWarned) log("saving works again"); saveFailedAt = 0; saveWarned = false; return; }
      dirty = true; saveFailedAt = Date.now();
      if (!saveWarned) { saveWarned = true; log("WARNING: could not save outbox.json (" + ((r && r.error) || "unknown") + ") - kept in memory, retrying"); console.warn("[outbox] save failed", r); }
    });
  }
  function touch() { dirty = true; }
  try {
    if (typeof window.api.onAgentPausedChanged === "function") window.api.onAgentPausedChanged((d) => {
      try {
        if (!d || !d.agentPath) return;
        mainPaused.set(d.agentPath, !!d.paused);
        // keep the window's own agent list truthful too (sidebar / Pause button), without waiting for the next poll
        try { const a = (typeof agents !== "undefined" && Array.isArray(agents) ? agents : []).find((x) => x && x.path === d.agentPath); if (a) { a.paused = !!d.paused; if (typeof renderAgentList === "function") renderAgentList(); } } catch (e) {}
        log((d.paused ? "main paused " : "main resumed ") + nm(d.agentPath));
      } catch (e) {}
    });
  } catch (e) {}
  // B1: the disk's answer, asked right before any AUTOMATIC send. Anything but a definite "not paused" (error, no answer, an
  // old preload without the call) means "do not send": fail closed.
  async function pausedInMain(ap) {
    try {
      if (typeof window.api.agentIsPaused !== "function") return true;
      const r = await window.api.agentIsPaused(ap);
      if (r === false) { if (mainPaused.get(ap)) mainPaused.set(ap, false); return false; }
      if (r === true) mainPaused.set(ap, true);
      return true;
    } catch (e) { return true; }
  }

  // ---- hooks called from renderer.js ---------------------------------------------------------------------------
  // B1: everything older to this agent may now only be delivered by hand (never after this newer message of his)
  function supersede(ap, beforeMs, why) {
    let n = 0;
    for (const o of items.values()) {
      if (o.agentPath === ap && o.state !== "seen" && !o.newer && (beforeMs == null || o.createdAt < beforeMs)) { o.newer = true; n++; }
    }
    if (n) { touch(); if (why) log(n + " older message(s) to " + nm(ap) + " will only be sent by Retry now (" + why + ")"); }
    return n;
  }
  // re-review F1: a message the owner sends to this agent some other way (PHEME dictation, the Library). NOT for the app's own
  // prompts (handoff, keep-going, wake-agent, IRIS): those never contradict what he wrote.
  function noteSend(ap, how) { try { if (ap) { supersede(ap, null, how || "a later message"); flush(); } } catch (e) {} }
  // ... and the same for any bubble the outbox does not own that is not an app prompt (a send path nobody wired up)
  function noteUnownedSends() {
    try {
      for (const [ap, se] of terminals.entries()) {
        if (!se || !Array.isArray(se.pendingSent) || !se.pendingSent.length) continue;
        for (const p of se.pendingSent) {
          if (!p || p.obId || p.outboxNoted || !p.text) continue;
          if (L.isAppPrompt(p.text)) { p.outboxNoted = true; continue; }
          if (owns(ap, p.text)) continue;                                 // one of ours: the tick claims it
          p.outboxNoted = true;
          supersede(ap, p.sentAt || p.addedAt || Date.now(), "a later message not sent from the compose box");
        }
      }
    } catch (e) {}
  }
  function add(ap, text) {
    try {
      if (!ap || !text) return null;
      const it = L.create(ap, text, Date.now());
      it.createdPerf = perf();
      supersede(ap, null, "");
      items.set(it.id, it);
      dispatching.add(it.id);
      const se = sess(ap);
      if (se) seRef.set(it.id, se);
      touch(); flush();
      return it.id;
    } catch (e) { return null; }
  }
  // the text that is really sent (the file reference of a long message) once it is known
  function bind(id, sentText) {
    try { const it = items.get(id); if (it && sentText && it.state !== "seen") { it.text = L.clean(sentText); touch(); flush(); } } catch (e) {}
  }
  // S1: the Send run reached sendOrHold (queued / held / typed) or failed: from now on the tick may judge it
  function dispatched(id) { try { dispatching.delete(id); } catch (e) {} }
  function cancel(id) {
    try { dispatching.delete(id); const it = items.get(id); if (it) { it.state = "cancelled"; items.delete(id); touch(); flush(); } } catch (e) {}
  }
  // the user removed a queued message (x on the queue chip): never bring it back
  function cancelQueued(ap, text) {
    try {
      for (const it of items.values()) {
        if (it.agentPath === ap && same(it.text, text) && !it.written && it.state === "queued") { cancel(it.id); return true; }
      }
    } catch (e) {}
    return false;
  }
  // v1.111.2: Dismiss on a failed bubble: forget this ONE message (never resend, never touch another). The outbox file is
  // rewritten by main through the normal save (flush), so it does not come back after a restart.
  function dismiss(pending) {
    try {
      const it = itemFor(pending);
      if (!it) return false;
      const r = L.dismissItem(Array.from(items.values()), it.id);
      if (r.removed) { dispatching.delete(it.id); it.state = "cancelled"; items.delete(it.id); touch(); dirty = true; saveFailedAt = 0; flush(); }
      return r.removed;
    } catch (e) { return false; }
  }
  function owns(ap, text) {
    for (const it of items.values()) if (it.agentPath === ap && same(it.text, text)) return true;
    return false;
  }

  // ---- where is the message right now? ---------------------------------------------------------------------------
  function parkedHas(ap, text) {
    try {
      for (const [p, pk] of (window.guardsParkedState ? window.guardsParkedState() : [])) {
        if (p === ap && pk && Array.isArray(pk.items) && pk.items.some((x) => same(x, text))) return true;
      }
    } catch (e) {}
    return false;
  }
  function boundTo(se, id) { return !!(se && Array.isArray(se.pendingSent) && se.pendingSent.some((x) => x && x.obId === id)); }
  function findPending(it, se) {
    if (!se || !Array.isArray(se.pendingSent)) return null;
    let p = se.pendingSent.find((x) => x && x.obId === it.id);
    if (!p) {
      // N2: an untagged bubble with the same text goes to the NEWEST unbound item with that text, never an older one
      const rivals = Array.from(items.values()).filter((o) => o.id !== it.id && o.agentPath === it.agentPath && o.state !== "seen" &&
        same(o.text, it.text) && o.createdAt > it.createdAt && !boundTo(se, o.id));
      if (rivals.length) return null;
      const claimed = new Set(Array.from(items.values()).filter((o) => o.id !== it.id).map((o) => o.id));
      p = se.pendingSent.find((x) => x && (!x.obId || !claimed.has(x.obId)) && same(x.text, it.text));
      if (p) p.obId = it.id;
    }
    return p || null;
  }
  function whereIs(it, se) {
    if (se && Array.isArray(se.sendQueue) && se.sendQueue.some((q) => same(q, it.text))) return "queue";
    if (parkedHas(it.agentPath, it.text)) return "held";
    const p = findPending(it, se);
    // B2: a calm "Sent - waiting for confirmation" bubble the outbox drew itself: the message is NOT in flight, judge it as absent
    if (p && p.outboxWaiting && !p.failed) { tagged.add(it.id); seRef.set(it.id, se); return "waiting"; }
    if (p) {
      // a bubble the outbox drew itself (showFailed) says nothing about the pty
      if (!p.outboxShown && (p.provisional === false || p.written)) {
        dispatching.delete(it.id); // submitToAgent has run for it: the Send is past the point S1 guards
        if (!it.written) { it.written = true; it.firstSentAt = it.firstSentAt || p.sentAt || Date.now(); touch(); }
        if (!it.attempts) { it.attempts = 1; touch(); }
        if (p.sentAt && p.sentAt > (it.lastSentAt || 0)) { it.lastSentAt = p.sentAt; touch(); }
      }
      tagged.add(it.id);
      leftAt.delete(it.id);
      seRef.set(it.id, se);
      return p.failed ? "pendingFailed" : "pending";
    }
    return "absent";
  }
  function reasonFor(ap, se) {
    try { if (window.guardsAgentInFlow && window.guardsAgentInFlow(ap)) return "handoff"; } catch (e) {}
    try { if (window.connHealth && window.connHealth.holding && window.connHealth.holding(ap)) return "reconnect"; } catch (e) {}
    if (!se || !se.started) return "starting";
    return "busy";
  }
  function connected(ap) {
    try { return !(window.connHealth && window.connHealth._states && window.connHealth._states.has(ap)); } catch (e) { return true; }
  }

  // ---- ack ------------------------------------------------------------------------------------------------------------
  function since(it) { return it.firstSentAt || it.createdAt; }
  function check(it) {
    if (checking.has(it.id)) return;
    checking.add(it.id);
    const asked = perf(); // check timing is monotonic: a wall-clock change never freezes or floods the checks
    Promise.resolve().then(() => window.api.outboxSeen(it.agentPath, it.text, since(it), it.lastSentAt || since(it)))
      .then((r) => { seenRes.set(it.id, { seen: r ? r.seen : null, at: perf(), asked }); })
      .catch(() => { seenRes.set(it.id, { seen: null, at: perf(), asked }); })
      .finally(() => { checking.delete(it.id); });
  }
  function markSeen(it, how) {
    it.state = "seen"; it.seenAt = Date.now(); touch(); failedShown.delete(it.id);
    dispatching.delete(it.id); leftAt.delete(it.id);
    const se = sess(it.agentPath);
    if (se && Array.isArray(se.pendingSent)) {
      const before = se.pendingSent.length;
      se.pendingSent = se.pendingSent.filter((p) => !(p && p.obId === it.id && (p.failed || p.outboxWaiting)));
      if (se.pendingSent.length !== before) repaint(it.agentPath);
    }
    if (how) log("delivered (" + how + ") to " + nm(it.agentPath) + " after " + Math.round((Date.now() - it.createdAt) / 1000) + " s, attempt " + (it.attempts || 1));
  }
  function repaint(ap) {
    try {
      if (ap !== activeAgentPath) return;
      const se = sess(ap);
      renderQueue(ap);
      if (se) renderChatBlocks(se.lastBlocks || [], se.pendingSent, {});
    } catch (e) { /* cosmetic */ }
  }
  // A visible failed bubble for a message whose bubble is gone (session replaced / app restarted).
  // v1.114.1: draw the failed bubble ONCE per message and session. The chat view removes a bubble whose text it finds in the transcript;
  // re-adding it on the next tick made the chat flip between two layouts every 4 s (the blink the owner saw on 2026-10-11).
  const failedShown = new Map(); // item id -> session object it was drawn in
  function showFailed(it, se) {
    if (!se || !Array.isArray(se.pendingSent) || se.pendingSent.some((p) => p && p.obId === it.id)) return;
    if (failedShown.get(it.id) === se) return;
    failedShown.set(it.id, se);
    const t = it.lastSentAt || it.createdAt;
    se.pendingSent.push({ text: it.text, addedAt: t, sentAt: t, failed: true, obId: it.id, provisional: false, outboxShown: true });
    repaint(it.agentPath);
  }

  // B2: after Restart Session / an app restart a written, unconfirmed message has no bubble while the outbox waits (paused,
  // reconnecting, idle timer, backoff). Show it at once with a calm label instead of letting it vanish.
  function showWaiting(it, se) {
    if (!se || !Array.isArray(se.pendingSent) || se.pendingSent.some((p) => p && p.obId === it.id)) return;
    const t = it.lastSentAt || it.createdAt;
    se.pendingSent.push({ text: it.text, addedAt: t, sentAt: t, failed: false, obId: it.id, provisional: false, written: !!it.written, outboxShown: true, outboxWaiting: true });
    log("showing a message to " + nm(it.agentPath) + " that is waiting for confirmation (its bubble was gone)");
    repaint(it.agentPath);
  }
  function dropWaiting(it, se) {
    if (!se || !Array.isArray(se.pendingSent)) return;
    const n = se.pendingSent.length;
    se.pendingSent = se.pendingSent.filter((p) => !(p && p.obId === it.id && p.outboxWaiting));
    if (se.pendingSent.length !== n) repaint(it.agentPath);
  }

  // ---- (re)send ------------------------------------------------------------------------------------------------------
  async function resend(it, manual) {
    const ap = it.agentPath;
    if (retrying.has(ap)) return false;
    // N1: a stale Retry button clicked right after a send would make a second copy before the transcript can show it
    if (manual && it.resentAt && perf() - it.resentAt < L.RETRY_LOCK_MS) {
      log("Retry for " + nm(ap) + " ignored: it was sent again " + Math.round((perf() - it.resentAt) / 1000) + " s ago - waiting for the agent");
      return false;
    }
    retrying.add(ap);
    try {
      let r = null;
      try { r = await window.api.outboxSeen(ap, it.text, since(it), it.lastSentAt || since(it)); } catch (e) { r = null; }
      const seen = r ? r.seen : null;
      if (seen === "user") { markSeen(it, manual ? "found before Retry" : "found before re-send"); return true; }
      if (seen === "queued") {
        log("not re-sent to " + nm(ap) + ": the CLI has it queued");
        const s0 = sess(ap), p0 = s0 && s0.pendingSent.find((p) => p && p.obId === it.id);
        if (p0) { p0.failed = false; p0.received = true; } // say what is true: it waits in the agent's own queue
        it.state = "sent"; touch();
        return true;
      }
      if (!manual && (seen !== "none" || L.blockReason(it, { now: Date.now(), ageMs: typeof it.createdPerf === "number" ? perf() - it.createdPerf : undefined }) || paused(ap))) return false; // automatic: only on a definite "not there"
      let holds = false;
      try { holds = !!(await window.api.agentInputHoldsText(ap, it.text)); } catch (e) { holds = false; }
      if (holds) { log("not re-sent to " + nm(ap) + ": the text sits in the CLI input box (the Enter ladder handles it)"); it.nextRetryAt = Date.now() + L.backoffMs(it.attempts || 1); touch(); return false; }
      if (!manual) {
        let q = null;
        try { q = await window.api.getTranscriptQuietMs(ap); } catch (e) { q = null; }
        if (q == null || q < L.IDLE_BEFORE_RETRY_MS) return false;
        // S7: never paste + Enter into a menu / approval screen with nobody watching
        if (typeof window.api.agentDialogOpen === "function") {
          let dlg = true;
          try { dlg = !!(await window.api.agentDialogOpen(ap)); } catch (e) { dlg = true; }
          if (dlg) { log("not re-sent to " + nm(ap) + ": a dialog / approval prompt is open in its CLI"); return false; }
        }
      }
      if (!manual && await pausedInMain(ap)) { log("not re-sent to " + nm(ap) + ": the agent is paused (or main could not say) - nothing is sent while it is paused"); return false; }
      // the awaits above took time: a newer message, a confirmation or a cancel may have happened meanwhile (order and duplicate guard)
      if (!manual && (!items.has(it.id) || it.state === "seen" || it.state === "cancelled" || it.manual || it.newer || L.blockReason(it, { now: Date.now() }))) return false;
      const se = sess(ap);
      if (!se || !se.started) return false;
      if (!manual && (se.busy || se.transcriptWorking || se.sendQueue.length || paused(ap))) return false;
      se.pendingSent = se.pendingSent.filter((p) => !(p && p.obId === it.id));
      failedShown.delete(it.id); // v1.114.1: a Retry that fails again must be allowed to draw its failed bubble again
      it.attempts = (it.attempts || 0) + 1;
      it.lastSentAt = Date.now();
      it.resentAt = perf();
      it.state = "sent";
      it.reported = false;
      it.nextRetryAt = Date.now() + L.backoffMs(it.attempts);
      touch(); flush();
      log((manual ? "Retry clicked: sending" : "re-sending") + " a message to " + nm(ap) + " (attempt " + it.attempts + " of " + L.MAX_ATTEMPTS + ", transcript: " + (seen || "unknown") + ")");
      const prev = se.sendChain || Promise.resolve();
      const mine = prev.then(() => sendOrHold(ap, se, it.text, null));
      se.sendChain = mine.catch(() => {});
      await mine;
      // N2: tag the bubble this send drew with the item's id, so an identical message never claims it
      try {
        const cur = sess(ap) || se;
        for (let i = cur.pendingSent.length - 1; i >= 0; i--) {
          const p = cur.pendingSent[i];
          if (p && !p.obId && same(p.text, it.text) && (p.sentAt || 0) >= it.lastSentAt - 1000) { p.obId = it.id; break; }
        }
      } catch (e) {}
      return true;
    } catch (e) {
      log("re-send failed for " + nm(ap) + ": " + ((e && e.message) || e));
      return false;
    } finally {
      retrying.delete(ap);
      repaint(ap);
    }
  }
  const requeuing = new Set();
  // B1: putting a never-written message back in the queue leads to an automatic send, so main is asked first (fail closed)
  async function requeueChecked(it, se) {
    if (requeuing.has(it.id)) return;
    requeuing.add(it.id);
    try {
      if (await pausedInMain(it.agentPath)) return;
      const cur = sess(it.agentPath);
      if (!cur || it.state === "seen" || it.state === "cancelled" || !items.has(it.id) || it.written) return;
      { const w = whereIs(it, cur); if (w !== "absent" && w !== "waiting") return; }   // something else took care of it while main was asked (a calm "waiting" bubble does not count)
      requeue(it, cur);
    } finally { requeuing.delete(it.id); }
  }
  function requeue(it, se) {
    if (!se || !Array.isArray(se.sendQueue)) return;
    try { dropWaiting(it, se); } catch (e) { /* no waiting bubble */ }
    se.sendQueue.push(it.text);
    it.state = "queued"; touch();
    log("put a message that never reached " + nm(it.agentPath) + " back in its queue (its session was replaced or the app restarted)");
    repaint(it.agentPath);
    try { if (se.started && !se.busy && !se.transcriptWorking) setBusy(it.agentPath, se, false); } catch (e) {}
  }

  // ---- the tick ------------------------------------------------------------------------------------------------------
  function tick() {
    const now = Date.now(), pnow = perf();
    try {
      for (const [ap, se] of terminals.entries()) {
        const working = !!(se && se.started && (se.busy || se.transcriptWorking));
        if (working || !se || !se.started) idleSince.delete(ap); else if (!idleSince.has(ap)) idleSince.set(ap, pnow);
      }
    } catch (e) {}
    noteUnownedSends();
    let checks = 0;
    for (const it of Array.from(items.values())) {
      if (it.state === "seen") { if (now - it.seenAt > L.KEEP_SEEN_MS) { items.delete(it.id); touch(); } continue; }
      if (now - it.createdAt > L.TTL_MS) { items.delete(it.id); dispatching.delete(it.id); touch(); continue; }
      const se = sess(it.agentPath);
      if (!se) continue;                                               // S4: no session object -> nothing to read or show yet
      let where = whereIs(it, se);
      const waitingBubble = where === "waiting";
      if (waitingBubble) where = "absent";
      if (where === "queue" || where === "held") { if (it.state !== "queued" && !it.written) { it.state = "queued"; touch(); } continue; }
      if (where === "pending") { if (it.state === "queued" && it.written) { it.state = "sent"; touch(); } continue; } // in flight: the chat view's detectors watch it
      if (where === "absent" && dispatching.has(it.id)) continue;      // S1: its Send is still running: never judged, never requeued
      // S3: the bubble left the SAME session object without a failure. The chat view's match has no time filter, so it is
      // confirmed with one fresh, time-filtered transcript check; only "user" counts, anything else takes the normal rules.
      if (where === "absent" && !waitingBubble && tagged.has(it.id) && seRef.get(it.id) === se && !it.disk && !leftAt.has(it.id)) {
        leftAt.set(it.id, pnow); seenRes.delete(it.id);
      }
      if (where === "pendingFailed" && it.state !== "failed") { it.state = "failed"; touch(); }
      if (it.disk && where === "absent" && pnow - loadedAt < STARTUP_GRACE_MS) continue; // let the held-queue / ledger restores land first
      if (!it.written && where !== "absent") continue;                 // provisional bubble: Send is still in progress
      let sr = seenRes.get(it.id);
      if (sr && leftAt.has(it.id) && !(sr.asked >= leftAt.get(it.id))) { seenRes.delete(it.id); sr = undefined; } // asked before it left: stale
      const slow = it.manual || (it.state === "failed" && it.attempts >= L.MAX_AUTO_ATTEMPTS);
      const every = slow ? (now - it.createdAt > 30 * 60000 ? CHECK_IDLE_MS : CHECK_SLOW_MS) : CHECK_EVERY_MS;
      if ((!sr || pnow - sr.at > every) && checks < MAX_CHECKS_PER_TICK) { checks++; check(it); }
      const fresh = sr && pnow - sr.at < SEEN_FRESH_MS;
      const seen = fresh ? sr.seen : null;
      if (fresh) {
        it.lastSeen = sr.seen;
        if (sr.seen == null) { if (!it.unknownSince) it.unknownSince = sr.at; } else it.unknownSince = 0;
      }
      if (leftAt.has(it.id) && !sr) continue;                          // S3: wait for that one check before judging it
      let inFlow = false;
      try { inFlow = !!(window.guardsAgentInFlow && window.guardsAgentInFlow(it.agentPath)); } catch (e) {}
      const c = {
        now, seen, where, started: !!se.started, connected: connected(it.agentPath), inFlow,
        queueEmpty: !!(se.sendQueue && se.sendQueue.length === 0), idleForMs: idleSince.has(it.agentPath) ? pnow - idleSince.get(it.agentPath) : 0,
        boxHolds: false, // checked (async) right before a re-send
        dispatching: false, paused: paused(it.agentPath), unknownForMs: it.unknownSince ? pnow - it.unknownSince : 0,
        ageMs: typeof it.createdPerf === "number" ? pnow - it.createdPerf : undefined,
      };
      const d = L.decide(it, c);
      if (d === "wait" && where === "absent" && !waitingBubble && !leftAt.has(it.id) && !dispatching.has(it.id) && it.state !== "seen" && (it.written || c.paused)) showWaiting(it, se);
      if (d === "seen") markSeen(it, leftAt.has(it.id) ? "bubble settled, transcript confirms" : "transcript");
      else if (d === "requeue") requeueChecked(it, se);
      else if (d === "retry") resend(it, false);
      else if (d === "manual" || d === "give-up") {
        if (d === "manual" && !it.manual) {
          it.manual = true;
          it.why = seen === "other" ? (L.blockReason(it, c) === "command" ? "command" : "later") : (L.blockReason(it, c) || (seen !== "none" ? "unknown" : "short"));
          touch();
        }
        if (it.state !== "failed") { it.state = "failed"; touch(); }
        if (waitingBubble) dropWaiting(it, se);
        if (where === "absent") showFailed(it, se);
        if (!it.reported) {
          it.reported = true;
          log((d === "manual" ? "not sent again automatically (" + it.why + ")" : "gave up after " + it.attempts + " attempts") + ": " + nm(it.agentPath) + " (Retry offered)");
          repaint(it.agentPath);
        }
      }
    }
    for (const id of Array.from(failedShown.keys())) if (!items.has(id)) failedShown.delete(id); // v1.114.1: never keep a session object alive for a gone item
    flush();
  }

  // ---- labels for renderer.js ---------------------------------------------------------------------------------------
  function itemFor(pending) { return pending && pending.obId ? items.get(pending.obId) : null; }
  function pendingLabel(pending) {
    try {
      const it = itemFor(pending);
      if (!it) return "";
      const justSent = it.state !== "seen" && it.resentAt && perf() - it.resentAt < L.RETRY_LOCK_MS && pending.failed;
      return L.label(it, { paused: paused(it.agentPath), justSent, now: Date.now(), waiting: !!(pending.outboxWaiting && !pending.failed) });
    } catch (e) { return ""; }
  }
  function keyPart(pending) { const it = itemFor(pending); return it ? it.state + it.attempts + "." + (it.nonce || 0) + (it.manual ? "m" + it.why : "") + (it.lastSeen === "none" ? "n" : "") + (pending.outboxWaiting ? "w" + (paused(it.agentPath) ? "p" : "") : "") : ""; }
  function queueLabel(ap, text) {
    try {
      const it = Array.from(items.values()).find((x) => x.agentPath === ap && same(x.text, text));
      return L.label(it || { state: "queued", attempts: 0, text }, { where: "queue", reason: reasonFor(ap, sess(ap)) });
    } catch (e) { return ""; }
  }
  // the Retry / Resend button: true when the outbox took it (seen-checked first, never a blind duplicate)
  function retryNow(pending) {
    const it = itemFor(pending);
    if (!it) return false;
    // re-review nit: "Cannot confirm delivery" means the transcript could not tell - an explicit yes before a possible copy
    if (it.manual && it.why === "unknown" && typeof window.confirm === "function") {
      let yes = false;
      try { yes = !!window.confirm("Agent Desktop cannot tell whether this message arrived - it may already be in the conversation.\n\nSend it again?"); } catch (e) { yes = false; }
      if (!yes) { it.nonce = (it.nonce || 0) + 1; repaint(it.agentPath); return true; }
    }
    resend(it, true).then((ok) => { if (!ok) { it.nonce = (it.nonce || 0) + 1; log("Retry not sent for " + nm(it.agentPath) + " (just sent, agent not attached or the check failed) - button re-enabled"); repaint(it.agentPath); } });
    return true;
  }

  window.outbox = { add, bind, dispatched, noteSend, cancel, dismiss, cancelQueued, owns, pendingLabel, keyPart, queueLabel, retryNow,
    _items: items, _tick: tick, _paused: paused, _state: () => Array.from(items.values()) };

  window.api.outboxLoad().then((r) => {
    // seen items are loaded too: they mark what came AFTER an older lost message (B1) across a restart
    for (const it of L.parse(r && r.json, Date.now())) {
      if (items.has(it.id)) continue;
      items.set(it.id, it);
    }
    const open = Array.from(items.values()).filter((x) => x.state !== "seen").length;
    if (open) log("loaded " + open + " unconfirmed message(s) from the last run");
  }).catch(() => {}).finally(() => {
    loadedAt = perf();
    setInterval(() => { if (!items.size) return; try { tick(); } catch (e) { console.error("outbox", e); } }, TICK_MS);
  });
})();
