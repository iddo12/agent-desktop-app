// v1.137.0 wake-up watcher (Project Autopilot T1) - the PURE decision module. No fs, no electron, no clocks: the live facts,
// the watcher's own memory and "now" are passed in, so everything is deterministic and unit-tested (tests/wakeWatcher.test.js).
// Design: Security\docs\autonomous_projects_strategy_2026-10-23.md sections 5.5, 5.6 and 8. The I/O glue is src/wakeWatcherMain.js
// (OFF unless the app-config key wakeWatcher.enabled is true); delivery goes through main.js deliverToAgentVerified, i.e. the one
// serialized path (channel first, pty once, verified in the transcript) - this module never writes into a pty.
//
//   decide(state, now, config) -> { wakes: [wake], events: [event], skipped: [{agent, reason}] }   (does NOT mutate anything)
//   applyDecision(mem, result, now)          record the wakes as in flight + the events (call right after decide)
//   applyDelivery(mem, wake, result, now)    close the wake with the result of HandoffDelivery.deliver; returns events
//
// state = { throttle: "go"|"slow"|"hold"|"unknown", cpuHold: bool, ledgerProgressAt: ms|null, recentMarkers: [{from,to,ts}],
//           agents: { <folder name>: { idle, idleForMs?, working, dialogOpen, inputBoxNonEmpty, handoffActive, lastHumanTypedAt, paused,
//                    neverWake, markers: [{id,ts,from,project,kind,hop}], notesMtimeMs, readyTasks: [{project,id}],
//                    openWorkNeedsNobody, nothingLeft, progressAt, ledgerProgressAt } } }
// mem = newMem(): the watcher's own memory (in-flight locks, wake history, handled marker ids ...); owned by the glue.
// Wake text carries NO message content: counts, sender folder names and project slugs only (prompt-injection cap, design section 8).
(function () {
  "use strict";

  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const DEFAULTS = {
    enabled: false,           // master switch (app-config wakeWatcher.enabled); decide() itself does not look at it
    dryRun: false,            // glue: log what would be sent, type nothing
    quietMs: 20 * 1000,       // the agent must have been idle at least this long (when idleForMs is known)
    humanQuietMs: 60 * 1000,  // a person typed to this agent within this: leave it alone
    maxPerAgentHour: 6, maxFleetHour: 30, minFleetGapMs: 20 * 1000, minAgentGapMs: 60 * 1000,
    maxHop: 4,                // a chain whose newest message has hop >= this stops without a human message or ledger event
    pingPongCount: 6, pingPongWindowMs: 30 * MIN, pingPongPauseMs: 60 * MIN,   // more than 6 exchanges in 30 min without ledger progress
    retryDelayMs: 3 * MIN, retryMax: 1, failCooldownMs: 30 * MIN,              // only a "definitely not landed" delivery is retried
    markerMaxAgeMs: DAY,
    heartbeat: { enabled: true, everyMs: 2 * HOUR, maxPerDay: 4, maxNoProgress: 2 },
    neverWake: [],            // extra names for the glue's never-wake check (the pure module only sees agent.neverWake)
  };
  function cfgOf(c) {
    const o = Object.assign({}, DEFAULTS, c || {});
    o.heartbeat = Object.assign({}, DEFAULTS.heartbeat, (c && c.heartbeat) || {});
    return o;
  }

  function newMem() { return { fleetWakes: [], agents: {}, handled: {}, readyHandled: {}, stopNotified: {}, pairs: {} }; }
  const blankAm = () => ({ wakes: [], inFlight: null, retry: null, failUntil: 0, consumedUntil: 0, notesSeen: 0, hbTimes: [] });
  function agentMem(mem, name) { return mem.agents[name] || (mem.agents[name] = blankAm()); }

  // ---- text -----------------------------------------------------------------------------------------------------------
  const cleanName = (s) => String(s || "").replace(/ Agent$/i, "").replace(/[^\p{L}\p{N} &._-]/gu, "").trim().slice(0, 40);
  const cleanSlug = (s) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  function makeWakeId(rand) {
    const r = typeof rand === "function" ? rand : Math.random;
    let s = ""; for (let i = 0; i < 4; i++) s += Math.floor(r() * 36).toString(36);
    return "w-" + s;
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  // The wake line (without the marker): counts and names only.
  function wakeText(p) {
    if (p.kind === "heartbeat") return "Continue your next open task from tasks.py or the project ledger, or reply NOTHING-LEFT.";
    const parts = [];
    if (p.markerCount) parts.push(plural(p.markerCount, "new message", "new messages") + (p.senders.length ? " (from " + p.senders.join(", ") + ")" : ""));
    if (p.readyCount) parts.push(plural(p.readyCount, "ready task", "ready tasks") + (p.projects.length ? " in project " + p.projects.join(", ") : ""));
    if (p.notes) parts.push("updated pending notes");
    return parts.join(" and ") + ". Read them, act, end with DONE:/BLOCKED:.";
  }
  function markerOf(id, kind) { return "[[" + (kind === "heartbeat" ? "HEARTBEAT" : "WAKE") + " " + id + "]]"; }

  // ---- helpers --------------------------------------------------------------------------------------------------------
  const pairKey = (a, b) => [String(a), String(b)].sort().join("|");
  const tsMs = (m) => (typeof m.ts === "number" ? m.ts : Date.parse(m.ts)) || 0;
  const last = (arr) => (arr.length ? arr[arr.length - 1] : 0);
  const inWindow = (times, now, win) => times.filter((t) => now - t < win);

  // Unread markers for one agent, minus handled / in flight / consumed / too old / hop-stopped / paused-pair.
  function pendingFor(name, a, am, mem, state, now, c, events) {
    const out = { markers: [], ready: [], notes: false };
    const inflight = new Set((am.inFlight && am.inFlight.markerIds) || []);
    const humanAt = a.lastHumanTypedAt || 0;
    const ledgerAt = Math.max(a.ledgerProgressAt || 0, state.ledgerProgressAt || 0);
    for (const m of a.markers || []) {
      if (!m || !m.id || mem.handled[m.id] || inflight.has(m.id)) continue;
      const t = tsMs(m);
      if (t <= am.consumedUntil || now - t > c.markerMaxAgeMs) continue;
      if ((m.hop || 0) >= c.maxHop && !(humanAt > t) && !(ledgerAt > t)) {
        if (!mem.stopNotified[m.id] && !events.some((e) => e.type === "hop-stop" && e.markerId === m.id)) events.push({ type: "hop-stop", agent: name, markerId: m.id, from: m.from, hop: m.hop, text: "wake chain stopped at hop " + m.hop + " (no human message or ledger event since)" });
        continue;
      }
      const pr = mem.pairs[pairKey(name, m.from)];
      if (pr && pr.until > now && !(humanAt > pr.at) && !(ledgerAt > pr.at)) continue;
      out.markers.push(m);
    }
    for (const r of a.readyTasks || []) { const k = r.project + "/" + r.id; if (!mem.readyHandled[k]) out.ready.push(r); }
    out.notes = (a.notesMtimeMs || 0) > (am.notesSeen || 0) && now - a.notesMtimeMs < c.markerMaxAgeMs;
    return out;
  }

  // ---- the decision ---------------------------------------------------------------------------------------------------
  function decide(state, now, config) {
    const c = cfgOf(config), mem = (state && state.mem) || newMem();
    const wakes = [], events = [], skipped = [];
    const agents = (state && state.agents) || {};
    // ping-pong detection (pairs of agents, from every marker of the last window, handled or not)
    const byPair = {};
    for (const m of (state && state.recentMarkers) || []) {
      const t = tsMs(m); if (now - t > c.pingPongWindowMs || !m.from || !m.to) continue;
      (byPair[pairKey(m.from, m.to)] = byPair[pairKey(m.from, m.to)] || []).push(t);
    }
    for (const k of Object.keys(byPair)) {
      const ts = byPair[k]; if (ts.length <= c.pingPongCount) continue;
      const pr = mem.pairs[k]; if (pr && pr.until > now) continue;
      const winStart = now - c.pingPongWindowMs, [x, y] = k.split("|");
      const prog = Math.max(state.ledgerProgressAt || 0, (agents[x] && agents[x].ledgerProgressAt) || 0, (agents[y] && agents[y].ledgerProgressAt) || 0, (agents[x] && agents[x].lastHumanTypedAt) || 0, (agents[y] && agents[y].lastHumanTypedAt) || 0);
      if (prog > winStart) continue;
      events.push({ type: "ping-pong", agents: [x, y], pair: k, count: ts.length, text: "ping-pong: " + ts.length + " exchanges between " + x + " and " + y + " in " + Math.round(c.pingPongWindowMs / MIN) + " min with no ledger progress - both paused for " + Math.round(c.pingPongPauseMs / MIN) + " min", until: now + c.pingPongPauseMs });
    }
    const justPaused = new Set(events.filter((e) => e.type === "ping-pong").map((e) => e.pair));
    const fleetTimes = inWindow(mem.fleetWakes, now, HOUR);
    let lastFleet = last(mem.fleetWakes);
    // fairness: the agent that has waited longest goes first
    const names = Object.keys(agents).sort();
    const cand = [];
    for (const name of names) {
      const a = agents[name] || {}, am = mem.agents[name] || blankAm();   // decide never creates memory entries
      const p = pendingFor(name, a, am, mem, state, now, c, events);
      const oldest = p.markers.reduce((mn, m) => Math.min(mn, tsMs(m)), Infinity);
      cand.push({ name, a, am, p, oldest });
    }
    cand.sort((x, y) => x.oldest - y.oldest || (x.name < y.name ? -1 : 1));
    for (const { name, a, am, p } of cand) {
      for (const pk of justPaused) { const [x, y] = pk.split("|"); if (name === x || name === y) p.markers = p.markers.filter((m) => pairKey(name, m.from) !== pk); }
      const hasPending = p.markers.length || p.ready.length || p.notes;
      let kind = "wake";
      if (!hasPending) {
        kind = "heartbeat";
        const hb = c.heartbeat, ht = am.hbTimes || [];
        const since = Math.max(a.progressAt || 0, a.lastHumanTypedAt || 0, a.ledgerProgressAt || 0);
        if (!hb.enabled || !a.openWorkNeedsNobody || a.nothingLeft) continue;
        if (state.throttle !== "go") { skipped.push({ agent: name, reason: "heartbeat-needs-go" }); continue; }
        if (now - last(ht) < hb.everyMs) continue;
        if (inWindow(ht, now, DAY).length >= hb.maxPerDay) { skipped.push({ agent: name, reason: "heartbeat-day-cap" }); continue; }
        if (ht.filter((t) => t > since).length >= hb.maxNoProgress) { skipped.push({ agent: name, reason: "heartbeat-no-progress" }); continue; }
      }
      const skip = (reason) => skipped.push({ agent: name, reason });
      if (a.neverWake) { skip("never-wake"); continue; }
      if (a.paused) { skip("paused"); continue; }
      if (a.handoffActive) { skip("handoff-running"); continue; }
      if (state.cpuHold) { skip("cpu-hold"); continue; }
      if (state.throttle !== "go" && state.throttle !== "slow") { skip("throttle-" + (state.throttle || "unknown")); continue; }
      if (!a.idle || a.working) { skip("not-idle"); continue; }
      if (a.idleForMs != null && a.idleForMs < c.quietMs) { skip("not-quiet-yet"); continue; }
      if (a.dialogOpen) { skip("dialog-open"); continue; }
      if (a.inputBoxNonEmpty) { skip("draft-in-input-box"); continue; }
      if (a.lastHumanTypedAt && now - a.lastHumanTypedAt < c.humanQuietMs) { skip("human-typing"); continue; }
      if (am.inFlight) { skip("in-flight"); continue; }
      if (am.retry && now < am.retry.notBefore) { skip("retry-wait"); continue; }
      if (now < (am.failUntil || 0)) { skip("fail-cooldown"); continue; }
      const mine = inWindow((am.wakes || []).map((w) => w.at), now, HOUR);
      if (mine.length >= c.maxPerAgentHour) { skip("agent-hour-cap"); continue; }
      if (mine.length && now - last(mine) < c.minAgentGapMs) { skip("agent-gap"); continue; }
      if (fleetTimes.length >= c.maxFleetHour) { skip("fleet-hour-cap"); continue; }
      if (lastFleet && now - lastFleet < c.minFleetGapMs) { skip("fleet-gap"); continue; }
      const senders = [];
      for (const m of p.markers) { const n = cleanName(m.from); if (n && senders.indexOf(n) < 0) senders.push(n); }
      const projects = [];
      for (const r of p.ready) { const s = cleanSlug(r.project); if (s && projects.indexOf(s) < 0) projects.push(s); }
      const id = makeWakeId(config && config.rand);
      const w = {
        id, agent: name, kind, at: now, marker: markerOf(id, kind),
        hop: p.markers.reduce((mx, m) => Math.max(mx, m.hop || 0), 0),
        markerIds: p.markers.map((m) => m.id), readyKeys: p.ready.map((r) => r.project + "/" + r.id),
        notesMtimeMs: p.notes ? a.notesMtimeMs : 0, senders: senders.slice(0, 4), projects: projects.slice(0, 3),
      };
      w.text = wakeText({ kind, markerCount: p.markers.length, readyCount: p.ready.length, notes: p.notes, senders: w.senders, projects: w.projects });
      w.line = w.marker + " " + w.text;
      wakes.push(w);
      fleetTimes.push(now); lastFleet = now;   // the gap rule then holds the rest of this pass back
    }
    return { wakes, events, skipped };
  }

  // ---- memory updates -------------------------------------------------------------------------------------------------
  function prune(mem, now) {
    mem.fleetWakes = mem.fleetWakes.filter((t) => now - t < DAY);
    for (const n of Object.keys(mem.agents)) {
      const am = mem.agents[n];
      am.wakes = am.wakes.filter((w) => now - w.at < DAY); am.hbTimes = (am.hbTimes || []).filter((t) => now - t < DAY);
    }
    for (const k of ["handled", "stopNotified", "readyHandled"]) for (const id of Object.keys(mem[k])) if (now - mem[k][id] > 3 * DAY) delete mem[k][id];
    for (const k of Object.keys(mem.pairs)) if (mem.pairs[k].until < now - DAY) delete mem.pairs[k];
  }
  function applyDecision(mem, result, now) {
    for (const w of result.wakes) {
      const am = agentMem(mem, w.agent);
      am.inFlight = { id: w.id, since: now, markerIds: w.markerIds.slice(), kind: w.kind, hop: w.hop };
      am.wakes.push({ at: now, id: w.id, kind: w.kind });
      mem.fleetWakes.push(now);
      if (w.kind === "heartbeat") am.hbTimes.push(now);
    }
    for (const e of result.events) {
      if (e.type === "hop-stop") mem.stopNotified[e.markerId] = now;
      if (e.type === "ping-pong") mem.pairs[e.pair] = { at: now, until: e.until };
    }
    prune(mem, now);
  }

  // What the delivery really did. deliver() returns { delivered, via, attempts, aborted?, dry? }.
  //   landed       - the wake id is in the transcript
  //   not-landed   - nothing at all was sent (no channel ack, nothing typed): safe to retry once
  //   unknown      - something was sent but the transcript never showed it: NEVER retried (the garbled-message lesson)
  function classifyDelivery(r) {
    if (!r) return "unknown";
    if (r.dry) return "dry";
    if (r.delivered) return "landed";
    return r.via ? "unknown" : "not-landed";
  }
  function applyDelivery(mem, wake, result, now) {
    const events = [], am = agentMem(mem, wake.agent), cls = classifyDelivery(result);
    am.inFlight = null;
    if (cls === "not-landed") {
      // nothing was typed, so the attempt does not count against the rate limits
      am.wakes = am.wakes.filter((w) => w.id !== wake.id);
      const i = mem.fleetWakes.lastIndexOf(wake.at); if (i >= 0) mem.fleetWakes.splice(i, 1);
      if (wake.kind === "heartbeat") am.hbTimes = am.hbTimes.filter((t) => t !== wake.at);
      const n = (am.retry ? am.retry.count : 0) + 1;
      am.retry = { count: n, notBefore: now + DEFAULTS.retryDelayMs };
      if (n > DEFAULTS.retryMax) { am.retry = null; am.failUntil = now + DEFAULTS.failCooldownMs; events.push({ type: "delivery-failed", agent: wake.agent, wakeId: wake.id, text: "wake " + wake.id + " could not be delivered after a retry; cooling down" }); }
      return { cls, events };
    }
    // landed / unknown / dry: everything present now counts as told (the agent reads its whole inbox); never retried
    for (const id of wake.markerIds) mem.handled[id] = now;
    for (const k of wake.readyKeys) mem.readyHandled[k] = now;
    am.consumedUntil = Math.max(am.consumedUntil, now);
    if (wake.notesMtimeMs) am.notesSeen = Math.max(am.notesSeen, wake.notesMtimeMs);
    am.retry = null;
    if (cls === "unknown") events.push({ type: "delivery-unknown", agent: wake.agent, wakeId: wake.id, text: "wake " + wake.id + " delivery unconfirmed - not retried" });
    return { cls, events };
  }
  // A person typed to the agent / the ledger moved: the retry/cooldown state for that agent no longer applies (called by the glue).
  function clearPairPause(mem, key) { delete mem.pairs[key]; }

  const api = { DEFAULTS, cfgOf, newMem, agentMem, decide, applyDecision, applyDelivery, classifyDelivery, wakeText, makeWakeId, pairKey, clearPairPause, cleanName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
