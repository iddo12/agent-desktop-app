// v1.137.0 wake-up watcher, the I/O glue around the pure decision module src/wakeWatcher.js. OFF unless app-config.json has
//   "wakeWatcher": { "enabled": true }      (optional: "dryRun": true = log what would be sent, type nothing)
// Reads the mail markers the ledger tool / the SendMessage hook drop in <mailDir>\<agent folder>\<id>.json, the facts about each
// attached agent (idle, dialog, draft in the input box ...) from injected getters, asks decide() who may be woken, and delivers
// ONE fixed line per wake through the injected deliver() (main.js deliverToAgentVerified: channel first, pty once, verified).
// Safety: the wake line holds counts and folder names only (never marker content); one wake per marker (handled ids are persisted);
// the first run only records the markers that already exist (no stampede); every I/O problem is caught and logged; this module never
// messages anybody else and never acts for the owner. Everything is injected, so tests/wakeWatcherMain.test.js runs it with fakes.
"use strict";
const nodeFs = require("fs");
const nodePath = require("path");
const WW = require("./wakeWatcher");

const MAX_MARKER_BYTES = 8 * 1024;
const MAX_MARKERS_PER_AGENT = 200;
const SWEEP_MS = 30 * 1000, DEBOUNCE_MS = 2000;

function create(deps) {
  const d = deps || {};
  const fs = d.fs || nodeFs, path = d.path || nodePath;
  const now = d.now || Date.now;
  const log = (line) => { try { (d.log || (() => {}))("wakewatcher: " + line); } catch (e) { /* logging never breaks the watcher */ } };
  const mem = WW.newMem(); mem.seen = {};
  let loaded = false, running = false, timer = null, watcher = null, debounce = null, dirty = false;
  const lastSkip = {};   // agent -> reason, so a long wait is logged once

  const settings = () => { let s = null; try { s = d.settings ? d.settings() : null; } catch (e) { s = null; } return s && typeof s === "object" ? s : {}; };
  const enabled = () => settings().enabled === true;
  const wwConfig = () => {
    const s = settings(), c = {};
    for (const k of ["quietMs", "humanQuietMs", "maxPerAgentHour", "maxFleetHour", "minFleetGapMs", "minAgentGapMs", "maxHop"]) if (typeof s[k] === "number" && s[k] >= 0) c[k] = s[k];
    // hard ceilings: the config can tighten the limits, never loosen them past the documented design values
    if (c.maxPerAgentHour > 6) c.maxPerAgentHour = 6;
    if (c.maxFleetHour > 30) c.maxFleetHour = 30;
    if (c.maxHop > 4) c.maxHop = 4;
    if (c.minFleetGapMs < 20000) c.minFleetGapMs = 20000;
    c.heartbeat = { enabled: false };   // no ledger-side "work that needs nobody" feed yet: heartbeats stay off
    c.neverWake = Array.isArray(s.neverWake) ? s.neverWake.filter((x) => typeof x === "string") : [];
    return c;
  };

  // ---- persistence (handled markers survive an app restart) -----------------------------------------------------------
  function loadMem() {
    if (loaded) return; loaded = true;
    try {
      const f = d.stateFile && d.stateFile();
      if (!f || !fs.existsSync(f)) return;
      const j = JSON.parse(fs.readFileSync(f, "utf-8"));
      if (j && typeof j === "object") {
        for (const k of ["handled", "readyHandled", "stopNotified", "pairs", "seen"]) if (j[k] && typeof j[k] === "object") Object.assign(mem[k], j[k]);
        if (Array.isArray(j.fleetWakes)) mem.fleetWakes = j.fleetWakes.filter((x) => typeof x === "number");
        if (j.agents && typeof j.agents === "object") for (const n of Object.keys(j.agents)) { const am = WW.agentMem(mem, n), a = j.agents[n] || {}; am.wakes = (a.wakes || []).filter((w) => w && typeof w.at === "number"); am.hbTimes = a.hbTimes || []; am.consumedUntil = a.consumedUntil || 0; am.notesSeen = a.notesSeen || 0; am.failUntil = a.failUntil || 0; }
      }
    } catch (e) { log("state file unreadable, starting with an empty memory: " + e.message); }
  }
  function saveMem() {
    if (!dirty) return; dirty = false;
    try {
      const f = d.stateFile && d.stateFile(); if (!f) return;
      const o = { seen: mem.seen, handled: mem.handled, readyHandled: mem.readyHandled, stopNotified: mem.stopNotified, pairs: mem.pairs, fleetWakes: mem.fleetWakes, agents: {} };
      for (const n of Object.keys(mem.agents)) { const a = mem.agents[n]; o.agents[n] = { wakes: a.wakes, hbTimes: a.hbTimes, consumedUntil: a.consumedUntil, notesSeen: a.notesSeen, failUntil: a.failUntil }; }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f + ".tmp", JSON.stringify(o), "utf-8"); fs.renameSync(f + ".tmp", f);
    } catch (e) { log("could not save state: " + e.message); }
  }

  // ---- reading the world ----------------------------------------------------------------------------------------------
  function readMarkers(dir, nowMs, maxAge) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)); } catch (e) { return out; }
    names.sort(); if (names.length > MAX_MARKERS_PER_AGENT) names = names.slice(-MAX_MARKERS_PER_AGENT);
    for (const f of names) {
      try {
        const full = path.join(dir, f), st = fs.statSync(full);
        if (st.size > MAX_MARKER_BYTES || nowMs - st.mtimeMs > maxAge * 2) continue;
        const j = JSON.parse(fs.readFileSync(full, "utf-8").replace(/^﻿/, ""));
        if (!j || typeof j !== "object" || typeof j.id !== "string" || !j.id || j.id.length > 80) continue;
        const ts = Date.parse(j.ts); if (!ts) continue;
        out.push({ id: j.id, ts, from: String(j.from || "").slice(0, 80), to: String(j.to || "").slice(0, 80), project: j.project ? String(j.project).slice(0, 40) : null, kind: String(j.kind || "msg").slice(0, 20), hop: Math.max(0, Math.min(99, Number(j.hop) || 0)) });
      } catch (e) { /* one bad marker file is skipped */ }
    }
    return out;
  }
  // Ledger activity: the newest events.jsonl write fleet-wide (ping-pong detection) and the newest event per agent (hop-stop lifting is
  // scoped to the two agents of a chain). Event "agent" names are matched to folder names loosely ("Foo Agent" == "Foo").
  const normAgent = (s) => String(s || "").toLowerCase().replace(/\s+agent$/, "").trim();
  function ledgerProgress() {
    let best = 0; const byAgent = {};
    try {
      const root = d.projectsDir && d.projectsDir(); if (!root) return { best: 0, byAgent };
      for (const p of fs.readdirSync(root)) {
        const f = path.join(root, p, "events.jsonl");
        try {
          best = Math.max(best, fs.statSync(f).mtimeMs);
          const st = fs.statSync(f), len = Math.min(128 * 1024, st.size), buf = Buffer.alloc(len), fd = fs.openSync(f, "r");
          try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
          for (const line of buf.toString("utf-8").split("\n")) {
            try { const e = JSON.parse(line), t = Date.parse(e.ts), k = normAgent(e.agent); if (!/^(progress|done|claim)$/.test(String(e.kind))) continue; /* 2026-10-25: free-text notes cannot lift a hop stop */ if (k && t > (byAgent[k] || 0)) byAgent[k] = t; } catch (x) { /* partial / bad line */ }
          }
        } catch (e) { /* no events file */ }
      }
    } catch (e) { /* no projects folder */ }
    return { best, byAgent };
  }
  // The attached agents and the facts about each. mailName = the sub-folder of the mail dir (the agent's folder name).
  function gather(nowMs, cfgW) {
    const mailDir = d.mailDir && d.mailDir();
    const agents = {}, byName = {}, recent = [];
    if (!mailDir) return { agents, byName, recent };
    for (const a of (d.agents ? d.agents() : [])) {
      const name = a.name; if (!name) continue;
      const markers = readMarkers(path.join(mailDir, name), nowMs, WW.DEFAULTS.markerMaxAgeMs);
      for (const m of markers) recent.push({ from: m.from, to: name, ts: m.ts });
      let f = {}; try { f = d.facts(a) || {}; } catch (e) { f = { working: true }; }   // unreadable facts = treat as busy
      const never = !!(d.neverWake && d.neverWake(a, cfgW.neverWake));
      const idleForMs = typeof f.idleForMs === "number" ? f.idleForMs : null;
      agents[name] = { idle: !f.working && !f.unknown, working: !!f.working || !!f.unknown, idleForMs, dialogOpen: !!f.dialogOpen, inputBoxNonEmpty: !!f.inputBoxNonEmpty, handoffActive: !!f.handoffActive, lastHumanTypedAt: f.lastHumanTypedAt || 0, paused: !!f.paused, neverWake: never, markers, notesMtimeMs: 0, readyTasks: [], openWorkNeedsNobody: false, nothingLeft: false, progressAt: 0, ledgerProgressAt: 0 };
      byName[name] = a;
    }
    return { agents, byName, recent };
  }
  // First sight of an agent (first run ever, or an agent attached for the first time): what is already in its mail folder counts as seen,
  // so switching the watcher on never wakes the fleet at once.
  function baselineNew(agents) {
    for (const name of Object.keys(agents)) {
      if (mem.seen[name]) continue;
      mem.seen[name] = now(); dirty = true;
      for (const m of agents[name].markers) mem.handled[m.id] = now();
      log("first sight of " + name + ": " + agents[name].markers.length + " existing markers recorded as already seen");
      agents[name].markers = [];
    }
  }

  function emit(ev) {
    log("EVENT " + ev.type + ": " + (ev.text || ""));
    try { if (d.notify) d.notify(ev); } catch (e) { /* the owner-facing sink is optional */ }
  }

  // ---- one pass -------------------------------------------------------------------------------------------------------
  async function tick() {
    if (running) return { skipped: "busy" };
    if (!enabled()) return { skipped: "off" };
    running = true;
    try {
      loadMem();
      const t = now(), cfgW = wwConfig(), dry = settings().dryRun === true;
      if (d.testBlocked && d.testBlocked()) return { skipped: "test-mode" };
      const g = gather(t, cfgW);
      baselineNew(g.agents);
      let throttle = "unknown"; try { throttle = String((d.throttle && d.throttle()) || "unknown").toLowerCase(); } catch (e) { /* unknown holds */ }
      const lp = ledgerProgress();
      const state = { throttle: throttle === "go" || throttle === "slow" || throttle === "hold" ? throttle : "unknown", cpuHold: !!(d.cpuHold && d.cpuHold()), ledgerProgressAt: lp.best, ledgerByAgent: lp.byAgent, recentMarkers: g.recent, agents: g.agents, mem };
      const res = WW.decide(state, t, cfgW);
      WW.applyDecision(mem, res, t); dirty = true;
      for (const e of res.events) emit(e);
      for (const s of res.skipped) if (lastSkip[s.agent] !== s.reason) { lastSkip[s.agent] = s.reason; log("hold " + s.agent + ": " + s.reason); }
      for (const w of res.wakes) { delete lastSkip[w.agent]; await wakeOne(w, g.byName[w.agent], dry); }
      saveMem();
      return { wakes: res.wakes.length, skipped: res.skipped.length };
    } catch (e) {
      log("pass failed (nothing sent): " + (e && e.message));
      return { error: e && e.message };
    } finally { running = false; }
  }
  // <mailDir>\_wakes\<id>.json: lets the SendMessage hook give a message sent during a woken turn hop + 1 (loop protection). Best effort.
  function recordWake(w) {
    try {
      const md = d.mailDir && d.mailDir(); if (!md) return;
      const wd = path.join(md, "_wakes"); fs.mkdirSync(wd, { recursive: true });
      fs.writeFileSync(path.join(wd, w.id + ".json"), JSON.stringify({ id: w.id, agent: w.agent, hop: w.hop, kind: w.kind, at: new Date(w.at).toISOString() }), "utf-8");
      for (const f of fs.readdirSync(wd)) { try { const fp = path.join(wd, f); if (now() - fs.statSync(fp).mtimeMs > 2 * 24 * 3600 * 1000) fs.unlinkSync(fp); } catch (e) { /* skip */ } }
    } catch (e) { /* the hop record is best effort */ }
  }
  async function wakeOne(w, agent, dry) {
    let result;
    if (dry) { log("DRY RUN would wake " + w.agent + ": " + w.line); result = { dry: true }; }
    else {
      recordWake(w);
      log("waking " + w.agent + " (" + w.id + ", " + w.kind + ", hop " + w.hop + ")");
      try { result = await d.deliver(agent, w.line); } catch (e) { result = { delivered: false, via: "error", error: e && e.message }; }
    }
    const r = WW.applyDelivery(mem, w, result, now()); dirty = true;
    log(w.id + " -> " + r.cls);
    for (const e of r.events) emit(e);
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------------------
  function kick() { if (debounce) return; debounce = setTimeout(() => { debounce = null; tick(); }, DEBOUNCE_MS); if (debounce.unref) debounce.unref(); }
  function start() {
    if (timer) return false;
    timer = setInterval(() => { tick(); }, SWEEP_MS); if (timer.unref) timer.unref();
    try {
      const md = d.mailDir && d.mailDir();
      if (md && fs.existsSync(md)) { watcher = fs.watch(md, { recursive: true }, () => { if (enabled()) kick(); }); watcher.on("error", () => {}); }
    } catch (e) { log("fs.watch unavailable, the 30 s sweep still runs: " + e.message); }
    log(enabled() ? "started (" + (settings().dryRun === true ? "dry run" : "live") + ")" : "started but OFF (set wakeWatcher.enabled in app-config.json)");
    return true;
  }
  function stop() {
    if (timer) clearInterval(timer); timer = null;
    if (debounce) clearTimeout(debounce); debounce = null;
    try { if (watcher) watcher.close(); } catch (e) { /* closing twice is harmless */ } watcher = null;
    saveMem();
  }
  return { start, stop, tick, mem, _isRunning: () => running };
}

module.exports = { create, MAX_MARKER_BYTES };
