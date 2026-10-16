// Load governor (v1.127.0). Keeps the PC responsive when many agents start or work at once.
//
// 2026-10-15 01:36-02:20: Agent Desktop restarted, re-dispatched all 25 agents, 8 more were woken at once and helper builds ran; the PC
// froze for ~45 min (main thread blocked 48.7 s). The start limiter (startLimiter.js) and the CPU guard hold only react to CPU; this module
// adds what was missing: starts ONE AT A TIME and only when the PC is calm, a cap on agents working at once (lower while a heavy app such
// as Premiere is in front), and an automatic slow-down (no nudges, no starts) while the system lag is high.
//
// Pure logic, no Electron: the clock, timers, the system measure, the "how many agents work" count and the foreground probe are injected,
// so tests/loadGovernor.test.js runs it with fakes. Wiring is in main.js (cpuGuardGlue passes the gate to the start limiter).
//
// States (state()):  off | unknown | warmup | calm | busy | slow
//   off      the governor is switched off (Setup) - everything is admitted.
//   unknown  nothing could be measured (or the last sample is stale) - FAIL-OPEN: everything is admitted; the old per-sweep dispatch cap,
//            the circuit breaker and the start limiter still apply.
//   warmup   fewer than `calmSamples` samples since the app started - starts wait (bounded by maxWaitMs), nudges/wakes pass.
//   calm     last `calmSamples` samples: CPU < calmCpuPct, loop lag < calmLagMs, free RAM >= minFreeMemMB (and GPU memory free >= gpuMinFreePct when known).
//   busy     measurable but not calm: starts wait, nudges/wakes still pass (cap permitting).
//   slow     last `slowSamples` samples each had lag >= slowLagMs or CPU >= slowCpuPct. Starts, nudges, wakes WAIT. Leaves slow only after
//            `recoverSamples` samples with lag < recoverLagMs and CPU < recoverCpuPct, or by force after maxSlowMs (then re-entry is
//            suppressed for slowCooldownMs): a stuck slow state can never block the app for good.
// Admission (admit/check/waitForSlot), kinds: "start" | "wake" | "voice" | "nudge" | "handoff". `urgent` (one explicit user action) is never held.
//   - slow blocks every kind. Otherwise the working cap (maxWorking, or maxWorkingHeavy while a heavy app is the foreground window) blocks when
//     working agents + recent reservations >= cap. A "start" also needs calm, with `calmSamples` fresh samples since the previous start.
//   - a blocked start is released after maxWaitMs anyway (not while slow): the PC being never quite calm must not stop agents for hours.
//   - waitForSlot() is a FIFO queue for wake / voice / handoff callers: the head is admitted first, nobody overtakes, nothing is dropped;
//     after the caller's bound the item is released (the message is delivered, never refused).

"use strict";

const DEFAULTS = {
  enabled: true,
  maxWorking: 6,
  maxWorkingHeavy: 3,
  heavyApps: ["premiere"],            // matched as a part of the foreground process name, case-insensitive, without .exe
  sampleMs: 2000,
  calmCpuPct: 50,
  calmLagMs: 200,
  minFreeMemMB: 2000,
  gpuMinFreePct: 10,                  // only used when the measure supplies gpuFreePct
  calmSamples: 3,
  slowLagMs: 1500,
  slowCpuPct: 92,
  slowSamples: 3,
  recoverLagMs: 400,
  recoverCpuPct: 75,
  recoverSamples: 5,
  maxSlowMs: 10 * 60 * 1000,
  slowCooldownMs: 5 * 60 * 1000,
  maxWaitMs: 2 * 60 * 1000,           // a start that waits for calm / a slot this long goes ahead (not while slow)
  wakeMaxWaitMs: 60 * 1000,           // wake-agent requests
  voiceMaxWaitMs: 90 * 1000,          // dictation to an agent
  reserveMs: 20 * 1000,               // an admitted wake/nudge counts as working this long, until the transcript shows it
  foregroundPollMs: 20 * 1000,
  maxConcurrentStarts: 1,
  slowSingleLagMs: 5000,              // ONE sample this late is slow at once: a 48 s main-thread block yields a single coalesced timer tick
  deferMaxWaitMs: 5 * 60 * 1000,      // a keep-going nudge / handoff flow deferred this long goes ahead (not while slow)
  startFloorAfterMs: 2 * 60 * 1000,   // after this long since the governor began, a never-calm PC still gets ...
  startFloorGapMs: 20 * 1000,         // ... at least one start per this interval (25 agents cannot take 50 minutes)
  staleDeadMs: 5 * 60 * 1000,         // sampler silent this long = dead = unknown (fail-open); between staleMs and this it reads busy
  logEveryMs: 60 * 1000,              // same decision logged at most this often
};

const LIMITS = {
  maxWorking: [1, 50], maxWorkingHeavy: [1, 50], sampleMs: [500, 30000], calmCpuPct: [10, 100], calmLagMs: [20, 5000], minFreeMemMB: [0, 1000000],
  gpuMinFreePct: [0, 100], calmSamples: [1, 30], slowLagMs: [200, 120000], slowCpuPct: [50, 100], slowSamples: [1, 30], recoverLagMs: [20, 60000],
  recoverCpuPct: [10, 100], recoverSamples: [1, 60], maxSlowMs: [30000, 6 * 3600 * 1000], slowCooldownMs: [0, 6 * 3600 * 1000],
  maxWaitMs: [5000, 3600 * 1000], wakeMaxWaitMs: [1000, 600000], voiceMaxWaitMs: [1000, 600000], reserveMs: [1000, 300000],
  foregroundPollMs: [5000, 600000], maxConcurrentStarts: [1, 10], slowSingleLagMs: [1000, 600000], deferMaxWaitMs: [10000, 3600000], startFloorAfterMs: [0, 3600000], startFloorGapMs: [1000, 600000], staleDeadMs: [30000, 3600000], logEveryMs: [1000, 3600000],
};

function num(v, key) {
  const d = DEFAULTS[key];
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  const [lo, hi] = LIMITS[key];
  return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
}

// "premiere, After Effects.exe; resolve" or an array -> ["premiere","after effects","resolve"]. Unusable entries are dropped.
function parseList(v) {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\n]/) : [];
  const out = [];
  for (const x of arr) {
    const s = normProc(x);
    if (s && s.length <= 60 && /^[a-z0-9 ._()+-]+$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 30);
}
function normProc(name) { return String(name == null ? "" : name).trim().toLowerCase().replace(/\.exe$/, "").trim(); }

// raw: any object (app-config values, a test). Out-of-range or non-numeric values fall back to the default, never throw.
function sanitizeSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const S = { enabled: r.enabled === false || r.enabled === "false" || r.enabled === 0 ? false : true };
  for (const k of Object.keys(LIMITS)) S[k] = num(r[k], k);
  const list = r.heavyApps === undefined || r.heavyApps === null || r.heavyApps === "" ? null : parseList(r.heavyApps);
  S.heavyApps = list === null ? DEFAULTS.heavyApps.slice() : list;
  if (S.maxWorkingHeavy > S.maxWorking) S.maxWorkingHeavy = S.maxWorking;
  return S;
}

function isHeavy(foreground, heavyApps) {
  const f = normProc(foreground);
  if (!f) return false;
  return (heavyApps || []).some((h) => h && f.includes(h));
}
function capFor(S, foreground) { return isHeavy(foreground, S.heavyApps) ? S.maxWorkingHeavy : S.maxWorking; }

// One sample -> what it says. sample = { t, cpu (0-100|null), lagMs (>=0|null), freeMB|null, gpuFreePct|null }
function measurable(s) { return !!s && (typeof s.cpu === "number" || typeof s.lagMs === "number"); }
function slowHit(s, S) { return (typeof s.lagMs === "number" && s.lagMs >= S.slowLagMs) || (typeof s.cpu === "number" && s.cpu >= S.slowCpuPct); }
function recoverOk(s, S) { return (typeof s.lagMs !== "number" || s.lagMs < S.recoverLagMs) && (typeof s.cpu !== "number" || s.cpu < S.recoverCpuPct); }
// null = calm; otherwise the first reason it is not
function notCalmReason(s, S) {
  if (!measurable(s)) return "no measurement";
  if (typeof s.cpu === "number" && s.cpu >= S.calmCpuPct) return "CPU " + Math.round(s.cpu) + "%";
  if (typeof s.lagMs === "number" && s.lagMs >= S.calmLagMs) return "event-loop lag " + Math.round(s.lagMs) + " ms";
  if (typeof s.freeMB === "number" && s.freeMB < S.minFreeMemMB) return "free RAM " + Math.round(s.freeMB) + " MB";
  if (typeof s.gpuFreePct === "number" && s.gpuFreePct < S.gpuMinFreePct) return "free GPU memory " + Math.round(s.gpuFreePct) + "%";
  return null;
}

// CPU % between two calls (os.cpus() deltas) + free/total RAM. Returns { cpu|null, freeMB, totalMB }. Pure given osMod.
function createSystemMeasure(osMod) {
  const os = osMod || require("os");
  let prev = null;
  return function measure() {
    const out = { cpu: null, freeMB: null, totalMB: null };
    try {
      let idle = 0, total = 0;
      for (const c of os.cpus()) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; }
      if (prev && total > prev.total) out.cpu = Math.max(0, Math.min(100, 100 * (1 - (idle - prev.idle) / (total - prev.total))));
      prev = { idle, total };
    } catch (e) { prev = null; }
    try { out.freeMB = os.freemem() / 1048576; out.totalMB = os.totalmem() / 1048576; } catch (e) { /* null */ }
    return out;
  };
}

function create(deps) {
  const d = deps || {};
  const now = d.now || Date.now;
  const setT = d.setTimeout || setTimeout;
  const clearT = d.clearTimeout || clearTimeout;
  const setI = d.setInterval || setInterval;
  const clearI = d.clearInterval || clearInterval;
  const log = d.log || (() => {});
  const onChange = d.onChange || (() => {});
  const measure = d.measure || (() => ({}));
  const countWorking = d.countWorking || (() => null);
  const probeForeground = d.probeForeground || null;

  const samples = [];
  let state = "warmup", stateReason = "starting", stateSince = now();
  let slowSince = 0, suppressedUntil = 0;
  let lastStartAt = -Infinity, lastSampleAt = 0;
  let measureFailLogged = false;
  const reserved = []; // timestamps of admitted non-start work not yet visible as "working"
  const waitSince = new Map(); // key -> { since, last } first blocked at / last asked at (an entry nobody asked about for 3 min is abandoned)
  const bornAt = now();
  const queue = []; // { kind, label, since, maxWaitMs, resolve }
  let drainTimer = null, timer = null, lastTick = 0;
  let fg = { name: null, at: 0, heavyRunning: false }, fgBusy = false, nextFgAt = 0;
  let cached = { at: -Infinity, S: null };
  let workingCache = { at: -Infinity, v: null };
  let lastEmitted = "";
  const lastLogged = new Map();
  let startedFlag = false;

  function settings() {
    const t = now();
    if (cached.S && t - cached.at < 5000) return cached.S;
    let raw = null;
    try { raw = typeof d.getSettings === "function" ? d.getSettings() : d.settings; } catch (e) { raw = null; }
    cached = { at: t, S: sanitizeSettings(raw) };
    return cached.S;
  }

  function say(key, line, everyMs) {
    const t = now();
    const gap = everyMs == null ? settings().logEveryMs : everyMs;
    if (t - (lastLogged.get(key) || -Infinity) < gap) return;
    lastLogged.set(key, t);
    if (lastLogged.size > 200) lastLogged.clear();
    try { log("governor: " + line); } catch (e) { /* logging never breaks a decision */ }
  }

  function changed() {
    let j = "";
    try { const s = snapshot(); j = JSON.stringify([s.state, s.reason, s.cap, s.working, s.waiting, s.startWaiting, s.foreground]); } catch (e) { return; }
    if (j === lastEmitted) return;
    lastEmitted = j;
    try { onChange(snapshot()); } catch (e) { /* UI hook */ }
  }

  function setState(next, reason) {
    if (next === state && reason === stateReason) return;
    const was = state;
    state = next; stateReason = reason; if (next !== was) stateSince = now();
    if (next !== was) say("state", "state " + was + " -> " + next + (reason ? " (" + reason + ")" : ""), 3000);
    changed();
  }

  // The stored state, or "unknown" when the sampler has stopped reporting (stale) while it is supposed to run.
  function currentState() {
    const S = settings();
    if (!S.enabled) return "off";
    if (startedFlag && lastSampleAt) {
      const gap = now() - lastSampleAt;
      if (gap > S.staleDeadMs) return "unknown";                       // the sampler is dead: fail-open
      // after a long main-thread block overdue timers run BEFORE the next sample: read as busy (starts wait, no stampede), never as "admit everything"
      if (gap > Math.max(15000, S.sampleMs * 6)) return "busy";
    }
    return state;
  }

  // ---- sampling ---------------------------------------------------------------------------------------------------------------------
  function ingest(sample) {
    const S = settings();
    const s = Object.assign({ cpu: null, lagMs: null, freeMB: null, gpuFreePct: null }, sample || {});
    if (typeof s.t !== "number") s.t = now();
    samples.push(s); while (samples.length > 40) samples.shift();
    lastSampleAt = now();
    if (!S.enabled) { setState("off", ""); return; }
    if (!measurable(s) && !samples.some(measurable)) { setState("unknown", "nothing measurable"); return; }
    const t = now();
    if (state === "slow") {
      if (t - slowSince >= S.maxSlowMs) {
        suppressedUntil = t + S.slowCooldownMs;
        say("slow-force", "slow state held " + Math.round((t - slowSince) / 60000) + " min - forcing release (re-entry suppressed " + Math.round(S.slowCooldownMs / 60000) + " min)", 1000);
        setState("busy", "forced release after " + Math.round(S.maxSlowMs / 60000) + " min");
        return;
      }
      const tail = samples.slice(-S.recoverSamples);
      if (tail.length >= S.recoverSamples && tail.every((x) => recoverOk(x, S))) {
        slowSince = 0;
        const calm = calmNow(S);
        setState(calm ? "calm" : "busy", calm ? "recovered" : "recovered, not yet calm: " + (notCalmReason(samples[samples.length - 1], S) || ""));
      }
      return;
    }
    const st = samples.slice(-S.slowSamples);
    const hugeLag = typeof s.lagMs === "number" && s.lagMs >= S.slowSingleLagMs;
    if (t >= suppressedUntil && (hugeLag || (st.length >= S.slowSamples && st.every((x) => slowHit(x, S))))) {
      slowSince = t;
      const last = samples[samples.length - 1];
      setState("slow", (hugeLag ? "main thread stalled " + Math.round(last.lagMs / 1000) + " s" : typeof last.lagMs === "number" && last.lagMs >= S.slowLagMs ? "event-loop lag " + Math.round(last.lagMs) + " ms" : "CPU " + Math.round(last.cpu) + "%") + " for " + S.slowSamples + " samples");
      return;
    }
    if (samples.length < S.calmSamples) { setState("warmup", "collecting samples"); return; }
    if (calmNow(S)) setState("calm", "");
    else setState("busy", notCalmReason(samples.slice(-S.calmSamples).find((x) => notCalmReason(x, S)) || s, S) || "busy");
  }

  function calmNow(S, sinceT) {
    const tail = samples.filter((x) => sinceT == null || x.t > sinceT).slice(-S.calmSamples);
    return tail.length >= S.calmSamples && tail.every((x) => notCalmReason(x, S) === null);
  }

  function tick() {
    try { tickImpl(); } catch (e) { say("tick-fail", "sampling error (" + (e && e.message) + ") - ignored", 600000); } // an exception must never escape an Electron interval
  }
  function tickImpl() {
    const S = settings();
    const t = now();
    const lag = lastTick ? Math.max(0, t - lastTick - S.sampleMs) : 0;
    lastTick = t;
    let m = null;
    try { m = measure() || {}; } catch (e) { m = null; if (!measureFailLogged) { measureFailLogged = true; say("measure-fail", "system measure failed (" + (e && e.message) + ") - using loop lag only", 600000); } }
    ingest({ t, cpu: m && typeof m.cpu === "number" ? m.cpu : null, lagMs: lag, freeMB: m && typeof m.freeMB === "number" ? m.freeMB : null, gpuFreePct: m && typeof m.gpuFreePct === "number" ? m.gpuFreePct : null });
    maybeProbeForeground(S);
  }

  function maybeProbeForeground(S) {
    if (!probeForeground || fgBusy || !S.heavyApps.length || now() < nextFgAt) return;
    fgBusy = true;
    let p;
    try { p = Promise.resolve(probeForeground(S.heavyApps.slice())); } catch (e) { p = Promise.reject(e); }
    p.then((r) => {
      const name = r && typeof r.foreground === "string" ? r.foreground : null;
      const wasHeavy = isHeavy(fg.name, S.heavyApps);
      fg = { name, at: now(), heavyRunning: !!(r && r.heavyRunning) };
      nextFgAt = now() + (fg.heavyRunning ? S.foregroundPollMs : S.foregroundPollMs * 3); // slower looks while no heavy app runs at all
      if (isHeavy(name, S.heavyApps) !== wasHeavy) say("fg", "foreground app is " + (isHeavy(name, S.heavyApps) ? "a heavy app (" + name + ") - working cap " + S.maxWorkingHeavy : "no longer a heavy app - working cap " + S.maxWorking), 1000);
      changed();
    }).catch(() => { fg = { name: null, at: 0, heavyRunning: false }; nextFgAt = now() + S.foregroundPollMs * 3; }).then(() => { fgBusy = false; });
  }
  // the foreground reading is trusted for 3 polls only; after that the normal cap applies (fail-open)
  function foregroundNow() { const S = settings(); return fg.name && now() - fg.at <= S.foregroundPollMs * 9 ? fg.name : null; }

  // ---- working count ----------------------------------------------------------------------------------------------------------------
  function workingNow() {
    const t = now();
    if (t - workingCache.at >= 4000) {
      let v = null;
      try { const x = countWorking(); v = typeof x === "number" && Number.isFinite(x) ? x : null; } catch (e) { v = null; }
      workingCache = { at: t, v };
    }
    return workingCache.v;
  }
  function reservedNow() {
    const S = settings(), t = now();
    while (reserved.length && t - reserved[0] > S.reserveMs) reserved.shift();
    return reserved.length;
  }

  // ---- admission --------------------------------------------------------------------------------------------------------------------
  // -> { ok, reason, wait } ; no side effects
  function check(kind, o) {
    const S = settings();
    if (!S.enabled || (o && o.urgent)) return { ok: true, reason: "", wait: "" };
    const st = currentState();
    if (st === "unknown" || st === "off") return { ok: true, reason: "unmeasured", wait: "" };
    if (st === "slow") return { ok: false, reason: "PC under heavy load (" + stateReason + ")", wait: "slow" };
    const w = workingNow();
    const cap = capFor(S, foregroundNow());
    if (w !== null && w + reservedNow() >= cap) return { ok: false, reason: "working cap " + cap + " reached (" + w + " working" + (reservedNow() ? " + " + reservedNow() + " starting" : "") + ")", wait: "cap" };
    if (kind === "start") {
      if (st === "warmup") return { ok: false, reason: "collecting load samples", wait: "calm" };
      if (!calmNow(S, lastStartAt)) {
        const last = samples[samples.length - 1];
        return { ok: false, reason: "waiting for the PC to be calm" + (last && notCalmReason(last, S) ? " (" + notCalmReason(last, S) + ")" : ""), wait: "calm" };
      }
    }
    return { ok: true, reason: "", wait: "" };
  }

  // check + commit. o = { label, urgent }. Waits are bounded (never while slow): start maxWaitMs, nudge / handoff deferMaxWaitMs;
  // wake / voice are bounded by their waitForSlot caller. A never-calm PC still gets one start per startFloorGapMs after startFloorAfterMs.
  function admit(kind, o) {
    const S = settings();
    const label = (o && o.label) || kind;
    const key = kind + ":" + label;
    const r = check(kind, o);
    const t = now();
    let w = waitSince.get(key);
    if (w && t - w.last > 180000) w = undefined; // nobody asked about this label for 3 min: an old timestamp must not release it instantly
    if (r.ok) {
      commit(kind, S);
      waitSince.delete(key);
      if (w) say("admit:" + key, "admitted " + kind + " " + label + " after " + Math.round((t - w.since) / 1000) + " s wait", 1000);
      else if (kind === "start" && !(o && o.urgent)) say("admit:" + key, "admitted start " + label + (r.reason ? " (" + r.reason + ")" : ""), 5000);
      changed();
      return { ok: true, reason: r.reason, released: false };
    }
    if (!w) { w = { since: t, last: t }; }
    w.last = t; waitSince.set(key, w);
    if (waitSince.size > 200) { for (const [k, v] of waitSince) if (t - v.last > 180000) waitSince.delete(k); }
    const bound = kind === "start" ? S.maxWaitMs : kind === "nudge" || kind === "handoff" ? S.deferMaxWaitMs : 0;
    const floor = kind === "start" && t - bornAt >= S.startFloorAfterMs && t - lastStartAt >= S.startFloorGapMs;
    if (r.wait !== "slow" && ((bound && t - w.since >= bound) || floor)) {
      waitSince.delete(key);
      commit(kind, S);
      say("release:" + key, "released " + kind + " " + label + " after " + Math.round((t - w.since) / 1000) + " s (" + r.reason + ") - " + (floor && !(bound && t - w.since >= bound) ? "never-calm floor: one start per " + Math.round(S.startFloorGapMs / 1000) + " s" : "waited the maximum"), 1000);
      changed();
      return { ok: true, reason: "released after maximum wait", released: true };
    }
    say("wait:" + key, "holding " + kind + " " + label + ": " + r.reason);
    changed();
    return { ok: false, reason: r.reason, released: false };
  }
  function commit(kind, S) {
    if (kind === "start") lastStartAt = now();
    else reserved.push(now());
  }
  // the caller admitted but then did not do the work (attach failed, nudge not sent): give the reserved slot back
  function unreserve() { reserved.pop(); changed(); }

  // FIFO wait for non-start work (wake, dictation, handoff). Resolves { ok:true, waitedMs, released } - never rejects, never refuses.
  function waitForSlot(kind, o) {
    const S = settings();
    const opt = o || {};
    const bound = opt.maxWaitMs != null ? opt.maxWaitMs : kind === "wake" ? S.wakeMaxWaitMs : kind === "voice" ? S.voiceMaxWaitMs : S.maxWaitMs;
    return new Promise((resolve) => {
      const item = { kind, label: opt.label || kind, since: now(), maxWaitMs: bound, resolve, urgent: !!opt.urgent };
      queue.push(item);
      changed();
      drain();
    });
  }
  function drain() {
    if (drainTimer) { clearT(drainTimer); drainTimer = null; }
    const S = settings();
    while (queue.length) {
      const head = queue[0];
      const t = now();
      const r = admit(head.kind, { label: head.label, urgent: head.urgent });
      // ONE admission per pass (a backlog never stampedes after a stall); the next pass is 1 s later. Items whose own bound ran out go ahead together.
      if (r.ok) { queue.shift(); head.resolve({ ok: true, waitedMs: t - head.since, released: false }); break; }
      if (t - head.since >= head.maxWaitMs) {
        queue.shift(); commit(head.kind, S);
        say("release:" + head.kind + ":" + head.label, "released " + head.kind + " " + head.label + " after " + Math.round((t - head.since) / 1000) + " s (" + r.reason + ") - waited the maximum", 1000);
        head.resolve({ ok: true, waitedMs: t - head.since, released: true });
        continue;
      }
      break; // the head is still waiting; nobody overtakes it
    }
    changed();
    if (queue.length) {
      drainTimer = setT(() => { drainTimer = null; drain(); }, 1000);
      if (drainTimer && typeof drainTimer.unref === "function") drainTimer.unref();
    }
  }

  // ---- read side --------------------------------------------------------------------------------------------------------------------
  // For keep-going's throttle: "LOADSLOW" while slow, else null (the cap is checked per nudge through admit("nudge")).
  function nudgeBlock() { const S = settings(); if (!S.enabled) return null; return currentState() === "slow" ? "LOADSLOW" : null; }
  function maxConcurrentStarts() { const S = settings(); const st = currentState(); return S.enabled && st !== "unknown" && st !== "off" ? S.maxConcurrentStarts : null; }
  function snapshot() {
    const S = settings();
    const last = samples[samples.length - 1] || null;
    const fgName = foregroundNow();
    return {
      enabled: S.enabled, state: currentState(), reason: stateReason, since: stateSince,
      cap: capFor(S, fgName), heavy: isHeavy(fgName, S.heavyApps), foreground: fgName,
      working: workingCache.v, reserved: reserved.length,
      waiting: queue.map((q) => q.label), startWaiting: Array.from(waitSince.keys()).filter((k) => k.startsWith("start:")).map((k) => k.slice(6)),
      sample: last ? { cpu: last.cpu, lagMs: last.lagMs, freeMB: last.freeMB } : null,
    };
  }
  // limiterSnap = startLimiter.snapshot(); -> banner state like cpuGuardGlue.computeBannerState()
  function banner(limiterSnap) {
    const s = snapshot();
    if (!s.enabled) return { show: false, kind: "none", text: "", queued: 0, boxed: [] };
    const lw = limiterSnap && Array.isArray(limiterSnap.waiting) ? limiterSnap.waiting : [];
    const names = Array.from(new Set(lw.concat(s.waiting))).filter(Boolean);
    const n = names.length;
    const list = n ? " (" + names.slice(0, 4).join(", ") + (n > 4 ? ", ..." : "") + ")" : "";
    if (s.state === "slow") {
      return { show: true, kind: "governor-slow", queued: n, boxed: [], guardOn: true,
        text: "Load governor: the PC is under heavy load. Nudges and new agent starts are paused and resume by themselves when it recovers." + (n ? " " + n + " waiting for a slot" + list + "." : "") + " Running agents keep working." };
    }
    if (n) {
      return { show: true, kind: "governor-wait", queued: n, boxed: [], guardOn: true,
        text: "Load governor: " + n + " agent" + (n === 1 ? "" : "s") + " waiting for a slot" + list + ". " + (lastWaitReason(s) ) };
    }
    return { show: false, kind: "none", text: "", queued: 0, boxed: [], guardOn: true };
  }
  function lastWaitReason(s) {
    const cap = s.cap;
    if (s.working !== null && s.working + s.reserved >= cap) return "At most " + cap + " agents work at once" + (s.heavy ? " while " + s.foreground + " is in front" : "") + ".";
    return "Agents start one at a time, when the PC is calm.";
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------------------------
  function start() {
    if (timer) return;
    startedFlag = true; lastTick = now(); lastSampleAt = now();
    timer = setI(tick, settings().sampleMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    say("start", "load governor started (cap " + settings().maxWorking + ", heavy cap " + settings().maxWorkingHeavy + ", sample every " + settings().sampleMs + " ms)", 1000);
  }
  function stop() {
    startedFlag = false;
    if (timer) clearI(timer); timer = null;
    try { if (typeof d.close === "function") d.close(); } catch (e) { /* helper already gone */ }
    if (drainTimer) clearT(drainTimer); drainTimer = null;
    // nothing is ever stranded: whoever waits is let through
    while (queue.length) { const h = queue.shift(); h.resolve({ ok: true, waitedMs: now() - h.since, released: true }); }
  }
  function refreshSettings() { cached = { at: -Infinity, S: null }; }

  return { start, stop, tick, ingest, check, admit, waitForSlot, nudgeBlock, maxConcurrentStarts, unreserve, snapshot, banner, state: currentState, refreshSettings, _drain: drain, _samples: samples };
}

module.exports = { create, createSystemMeasure, sanitizeSettings, parseList, normProc, isHeavy, capFor, notCalmReason, slowHit, recoverOk, DEFAULTS, LIMITS };
