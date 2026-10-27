// My Daily - Shipments service (main process, no electron import: everything is injected so tests can drive it).
// Store: <root>/daily/shipments.json { version, items:[shipment], scannedAt, polledAt }. Mail is scanned when the tab opens or on
// refresh (never on a timer of its own); ONE low-frequency poll timer (12 h) exists only when a tracking key is stored.
"use strict";
const fs = require("fs");
const M = require("./shipments-model");
const E = require("./shipments-email");
const T = require("./shipments-track");

const SCAN_MIN_MS = 10 * 60000;
const MAX_MAILS = 400;

function createService({ file, settingsFile, readStore, writeJsonAtomic, tracker, getMails, now, say, notices, testMode }) {
  const clock = typeof now === "function" ? now : () => Date.now();
  const log = typeof say === "function" ? say : () => {};
  let timer = null;
  let scanning = null;

  const MIGRATION = 2;   // 2026-10-27: order numbers that an older scanner stored as tracking numbers (see M.migrateWrongNumbers)
  function loadStore() {
    const raw = readStore(file, { items: [] }, notices, "Shipments");
    let items = (Array.isArray(raw.items) ? raw.items : []).filter((x) => x && typeof x === "object").map((x) => M.makeShipment(x, clock()));
    if (testMode && !items.length && !raw.demoDone && process.env.AGENT_DESKTOP_SHIPMENTS_DEMO === "1") items = M.demoShipments(clock());
    const st = { items, scannedAt: Number(raw.scannedAt) || 0, polledAt: Number(raw.polledAt) || 0, lastError: String(raw.lastError || "").slice(0, 160), migrated: Number(raw.migrated) || 0 };
    if (st.migrated < MIGRATION && Array.isArray(raw.items)) migrate(st);
    return st;
  }
  // One-shot and idempotent: runs once per store file (flag `migrated` in the file), backs the file up BEFORE writing anything.
  function migrate(st) {
    try {
      const r = M.migrateWrongNumbers(st.items, clock());
      if (r.changed) {
        const d = new Date(clock()), z = (n) => String(n).padStart(2, "0");
        const bak = file + ".bak_" + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + "_" + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()) + "_before_numberfix";
        fs.copyFileSync(file, bak);                 // throws -> nothing is written, the migration is retried next load
        log("shipments: moved " + r.moved.length + " order number(s) out of the tracking numbers, fixed " + r.fixed.length + "; backup " + bak);
      }
      st.migrated = MIGRATION;
      if (r.changed) save(st);   // an unchanged store is not rewritten here (the flag is saved with the next normal save)
    } catch (e) { log("shipments migration failed (will retry): " + M.clean(e && e.message, 120)); }
  }
  function save(st) {
    M.sweep(st.items, clock());
    writeJsonAtomic(file, { version: 1, items: st.items, scannedAt: st.scannedAt, polledAt: st.polledAt, lastError: st.lastError || "", migrated: st.migrated || 0 });
  }
  const settings = () => M.cleanSettings(settingsFile ? readStore(settingsFile, {}, null, "Settings").shipments : null);

  // Read mail through the existing read-only mail code, extract parcels, merge. Returns the number of new/changed parcels.
  async function scan(st, force) {
    if (!force && st.scannedAt && clock() - st.scannedAt < SCAN_MIN_MS) return 0;
    if (scanning) return scanning;
    scanning = (async () => {
      let changed = 0;
      try {
        const mails = typeof getMails === "function" ? await getMails(clock()) : [];
        for (const mail of (mails || []).slice(0, MAX_MAILS)) {
          for (const cand of E.extractShipments(mail, clock())) {
            const r = M.mergeCandidate(st.items, cand, clock());
            if (r.created || r.changed) changed++;
          }
        }
        st.scannedAt = clock();
        st.lastError = "";
      } catch (e) { st.lastError = M.clean(e && e.message, 120); log("shipments mail scan failed: " + st.lastError); }
      return changed;
    })().finally(() => { scanning = null; });
    return scanning;
  }

  // the newest per-number tracking result that explains why there is nothing to show -> { reason, text, at } or null
  function lastReason(s) {
    const n = s.numbers.slice().reverse().find((x) => x.reason);
    return n ? { reason: n.reason, text: n.reasonText || "", at: n.reasonAt || null, no: n.no } : null;
  }
  // Look at ONE parcel right away (after a number or carrier was entered). Never throws; the key stays inside the tracker.
  async function pollOne(s) {
    if (!tracker.hasLiveProvider() || !s || !s.numbers.length) return;
    try { await tracker.refresh([s], clock(), { force: true }); } catch (e) { log("shipments poll one failed: " + M.clean(e && e.message, 120)); }
  }
  // Review fix C: 16/17 plain digits are only a WARNING (Evri uses 16 digits). Hard refusal only when it equals a known order id,
  // is an Amazon 3-7-7 id, or goes onto an AliExpress/Amazon parcel; otherwise the owner can confirm with force:true ("Use it anyway").
  function orderCheck(st, numbers, parcel, args) {
    const bad = numbers.find((n) => M.looksLikeOrderNumber(n.no));
    if (!bad) return null;
    const known = st.items.some((x) => x.orderId && M.normNumber(x.orderId) === bad.no);
    const dashed = /\b\d{3}-\d{7}-\d{7}\b/.test(String(args.text || ""));
    const market = !!parcel && /aliexpress|amazon|alibaba/i.test(parcel.merchant || "");
    if (known || dashed || market) return { ok: false, reason: ORDER_MSG };
    if (!args.force) return { ok: false, needsConfirm: true, reason: "This is 16-17 plain digits, which is how AliExpress and Amazon order numbers look. If it really is a tracking number (some carriers use 16 digits), press \"Use it anyway\"." };
    return null;
  }
  const ORDER_MSG = "That looks like an order number, not a tracking number. Tracking numbers come in the shipping mail from the carrier (AliExpress order ids are 16 digits).";
  const pickCarrier = (id) => (id && id !== "auto" && M.CARRIER_BY_ID[id]) ? id : "";

  function view(st) {
    const t = clock();
    const sd = settings().stuckDays;
    const tr = tracker.status();
    const items = st.items.map((s) => Object.assign({}, s, {
      effective: M.effectiveState(s, t, sd), stuck: M.isStuck(s, t, sd), action: M.actionText(s, t, sd),
      carrierName: M.carrierName(s.carrier),
      numbers: s.numbers.map((n) => ({ no: n.no, carrier: n.carrier, carrierName: M.carrierName(n.carrier), url: M.trackUrl(n.carrier, n.no), reason: n.reason || "", reasonText: n.reasonText || "", reasonAt: n.reasonAt || null })),
      needsNumber: M.needsNumber(s),
      orderAt: (s.history && s.history[0] && s.history[0].at) || s.added || null,
      reason: lastReason(s),
      cantTrack: !M.needsNumber(s) && !s.archived && !(s.events && s.events.length) && !s.lastEvent && ["not_found", "invalid", "rejected"].includes((lastReason(s) || {}).reason),
      url: s.numbers.length ? M.trackUrl(s.numbers[s.numbers.length - 1].carrier, s.numbers[s.numbers.length - 1].no) : "",
      note2: s.carrier === "amazon" ? "Tracked inside Amazon" : "",
      events: (s.events || []).slice(0, 40),
    }));
    return {
      ok: true, now: t, items, stuckDays: sd, carriers: M.CARRIERS.filter((c) => c.id !== "other").map((c) => ({ id: c.id, name: c.name })),
      counts: { needs: items.filter((x) => !x.archived && ["action_pay", "action_pickup", "exception_stuck"].includes(x.effective)).length, active: items.filter((x) => !x.archived).length, archived: items.filter((x) => x.archived).length },
      provider: { live: tr.live, has17: tr.has17, hasDhl: tr.hasDhl, canEncrypt: tr.canEncrypt, polledAt: st.polledAt || null, nextPollAt: timer && st.polledAt ? st.polledAt + T.POLL_MS : null, scannedAt: st.scannedAt || null, lastError: st.lastError || "" },
      states: M.STATE_LABEL,
    };
  }

  // Poll providers (stale > 12 h, or forced) and persist. Never throws.
  async function poll(st, force) {
    if (!tracker.hasLiveProvider()) return null;
    const t = clock();
    if (!force && st.polledAt && t - st.polledAt < T.POLL_MS - 60000) return null;
    try {
      const r = await tracker.refresh(st.items, t, { force });
      st.polledAt = t;
      scheduleRetry(st);
      return r;
    } catch (e) { st.lastError = M.clean(e && e.message, 120); return null; }
  }

  // 2026-10-09: 17TRACK registers a new number first and fetches the carrier's data a few minutes later, so a first lookup can
  // come back empty. Look again after 10 minutes (at most 3 times) instead of waiting for the next 12-hour poll.
  let retryTimer = null, retries = 0;
  function scheduleRetry(st) {
    if (retryTimer) return;
    const waiting = st.items.some((x) => x && !x.archived && x.state !== "delivered" && Array.isArray(x.events) && x.events.length === 0 && x.polledAt);
    if (!waiting) { retries = 0; return; }
    if (retries >= 3) return;
    retries++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      backgroundPoll(true);
    }, 10 * 60000);
    if (retryTimer.unref) retryTimer.unref();
  }

  // Review fix A: scan, poll, refresh and every op run one at a time through this queue. An op that waits seconds for 17TRACK can no
  // longer overwrite what a scan or the 12 h poll saved meanwhile (each entry point loads the store fresh when its turn comes).
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const backgroundPoll = (force) => serial(async () => { const s2 = loadStore(); const r = await poll(s2, force); if (r) { try { save(s2); } catch (e) { /* next time */ } } }).catch(() => {});

  const load = (args) => serial(() => loadInner(args));
  async function loadInner(args) {
    const st = loadStore();
    const a = args || {};
    const found = await scan(st, !!a.force);
    if (found || a.force) save(st); else if (!st.scannedAt) save(st);
    // a stale poll in the background (does not delay the answer)
    if (tracker.hasLiveProvider() && (!st.polledAt || clock() - st.polledAt >= T.POLL_MS)) {
      backgroundPoll(false);
    }
    return view(st);
  }

  const refreshNow = () => serial(refreshInner);
  async function refreshInner() {
    retries = 0;
    const st = loadStore();
    await scan(st, true);
    const r = await poll(st, true);
    save(st);
    const v = view(st);
    v.refresh = r ? { polled: r.polled, changed: r.changed.length, errors: Object.keys(r.errors).length, firstError: Object.values(r.errors)[0] || "" } : { polled: 0, changed: 0, errors: 0, firstError: "" };
    return v;
  }

  const op = (a) => serial(() => opInner(a));
  async function opInner(a) {
    const args = a && typeof a === "object" ? a : {};
    const st = loadStore();
    const t = clock();
    const find = () => st.items.find((x) => x.id === args.id);
    switch (args.op) {
      case "add": {
        const p = E.parseAddInput(args.text);
        if (!p.ok) return { ok: false, reason: p.reason };
        { const oc = orderCheck(st, p.numbers, null, args); if (oc) return oc; }
        const pc = pickCarrier(args.carrier);
        const numbers = p.numbers.map((n) => ({ no: n.no, carrier: pc || n.carrier, carrierSet: !!pc, at: t }));
        const label = M.clean(args.label, 120) || p.title;
        const r = M.mergeCandidate(st.items, { numbers, carrier: pc || p.carrier, title: label, state: "shipped", at: t, source: "manual" }, t);
        r.shipment.source = r.created ? "manual" : r.shipment.source;
        if (!r.created && label && !r.shipment.title) r.shipment.title = label;
        if (args.review) r.shipment.review = true;
        if (pc) for (const n of r.shipment.numbers) if (numbers.some((x) => x.no === n.no)) { n.carrier = pc; n.carrierSet = true; n.recarrier = !r.created; r.shipment.carrier = pc; }
        await pollOne(r.shipment);
        save(st);
        const lr = lastReason(r.shipment);
        return { ok: true, id: r.shipment.id, created: r.created, note: lr ? lr.text : "" };
      }
      case "split": {
        const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." };
        if (!s.orderId) return { ok: false, reason: "This parcel has no order id to split." };
        const sib = M.makeShipment({ orderId: s.orderId, merchant: s.merchant, title: s.title, carrier: s.carrier, state: s.state === "ordered" ? "ordered" : "shipped", eta: s.eta, source: "manual", split: true, at: t }, t);
        s.split = true; s.updated = t;
        st.items.push(sib);
        save(st);
        return { ok: true, id: sib.id };
      }
      case "review": { const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." }; s.review = !!args.on; s.updated = t; break; }
      case "archive": { const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." }; M.archiveShipment(s, t, "manual"); break; }
      case "unarchive": { const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." }; M.unarchiveShipment(s, t); break; }
      case "picked-up": { const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." }; M.markPickedUp(s, t); break; }
      case "delete": {
        const i = st.items.findIndex((x) => x.id === args.id);
        if (i < 0) return { ok: false, reason: "That shipment is gone." };
        st.items.splice(i, 1); break;
      }
      case "set-carrier": {
        const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." };
        const auto = args.carrier === "auto" || args.carrier === "other" || !args.carrier;
        if (!auto && !M.CARRIER_BY_ID[args.carrier]) return { ok: false, reason: "Unknown carrier." };
        const c = auto ? "other" : args.carrier;
        s.carrier = c;
        // the carrier is now the owner's choice: remember it, forget the old verdict, and ask 17TRACK to move the number to it
        for (const n of s.numbers) { n.carrier = c; n.carrierSet = !auto; n.recarrier = true; delete n.reason; delete n.reasonText; delete n.reasonAt; }
        s.updated = t; s.polledAt = null;
        await pollOne(s);
        break;
      }
      case "note": { const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." }; s.note = M.clean(args.note, 200); s.updated = t; break; }
      case "add-number": {
        const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." };
        const p = E.parseAddInput(args.text);
        if (!p.ok) return { ok: false, reason: p.reason };
        { const oc = orderCheck(st, p.numbers, s, args); if (oc) return oc; }
        const other = st.items.find((x) => x !== s && x.numbers.some((y) => p.numbers.some((n) => n.no === y.no)));
        if (other) return { ok: false, reason: "That number is already on another parcel (" + (other.title || other.merchant || other.id) + ")." };
        const pc = pickCarrier(args.carrier);
        // 2026-10-27: the old code merged into a throw-away copy of the list, so a number for a parcel with no match was lost
        for (const x of p.numbers) {
          if (s.numbers.some((y) => y.no === x.no)) continue;
          s.numbers.push({ no: x.no, carrier: pc || x.carrier, carrierSet: !!pc, at: t });
        }
        s.numbers = s.numbers.slice(-6);
        s.carrier = s.numbers[s.numbers.length - 1].carrier;
        if (s.state === "ordered") M.setState(s, "shipped", t, "number added", t);
        s.updated = t; s.polledAt = null;
        await pollOne(s);
        break;
      }
      default: return { ok: false, reason: "Unknown action." };
    }
    save(st);
    return { ok: true };
  }

  function setKey(args) {
    const a = args && typeof args === "object" ? args : {};
    const id = a.provider === "dhl" ? "dhl" : "17track";
    try {
      if (a.clear) tracker.keys.clear(id); else tracker.keys.set(id, a.key);
    } catch (e) { return { ok: false, reason: M.clean(e && e.message, 160) }; }
    syncTimer();
    // The key is never echoed back, only whether one is stored.
    return { ok: true, has: tracker.keys.has(id) };
  }

  // One low-frequency poll timer, only while a live provider exists. unref'd so it never keeps the app alive.
  function syncTimer() {
    if (tracker.hasLiveProvider()) {
      if (!timer) { timer = setInterval(() => { runTimed().catch(() => {}); }, T.POLL_MS); if (timer.unref) timer.unref(); }
    } else if (timer) { clearInterval(timer); timer = null; }
  }
  const runTimed = () => serial(runTimedInner);
  async function runTimedInner() {
    const st = loadStore();
    await scan(st, true);
    await poll(st, true);
    save(st);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } }

  return { load, refreshNow, op, setKey, syncTimer, stop, runTimed, _loadStore: loadStore, hasTimer: () => !!timer };
}

module.exports = { createService };
