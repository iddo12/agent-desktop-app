// My Daily - Shipments: tracking providers and key storage (main process only). Provider interface:
//   { id, label, needsKey, enabled(), track(items:[{number, carrier}]) -> Promise<{ results: {[number]: {events, state?, eta?}}, errors: {[number]: msg} }> }
// 'manual' never touches the network. '17track' is the real engine (register + gettrackinfo, <=40 per call). 'dhl' is a small
// real client (DHL Unified Tracking, needs its own key, polled at most every 6 h). 'ups' and 'fedex' are wired stubs that stay
// disabled (no key slot in the UI yet). A 'fake' provider exists for tests.
// Keys: kept ONLY here, encrypted with Electron safeStorage exactly like the Gmail token (gmail.js): never sent to the
// renderer, never logged, never put in a URL, never called from the browser side (17TRACK forbids that).
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const M = require("./shipments-model");

const HOSTS = new Set(["api.17track.net", "api-eu.dhl.com"]);
const POLL_MS = 12 * 3600000;   // twice a day (owner decision 2026-10-09; was 3 h); the Refresh now button forces an update
const DHL_MIN_MS = 6 * 3600000;
const BATCH = 40;
const MIN_GAP_MS = 400;           // 17TRACK allows 3 req/s; stay well under
const KEY_MAX = 200;

const clean = M.clean;

// small https JSON helper, host allow-listed, size and time capped. The key travels in a header, never in the URL.
function httpRequest(method, urlStr, { headers, body, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error("bad url")); }
    if (u.protocol !== "https:" || !HOSTS.has(u.hostname)) return reject(new Error("host not allowed"));
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: Object.assign({ "User-Agent": "AgentDesktop-MyDaily" }, headers || {}), timeout: timeoutMs || 20000 }, (res) => {
      let n = 0; const chunks = [];
      res.on("data", (c) => { n += c.length; if (n > 2 * 1024 * 1024) { req.destroy(new Error("response too large")); return; } chunks.push(c); });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- key store (safeStorage)
function createKeyStore({ dataDir, safeStorage }) {
  const file = path.join(dataDir, "shipments-keys.bin");
  const canEncrypt = () => { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; } };
  function read() {
    try {
      const raw = fs.readFileSync(file);
      const v = JSON.parse(canEncrypt() ? safeStorage.decryptString(raw) : "");
      return v && typeof v === "object" ? v : {};
    } catch (e) { return {}; }
  }
  function write(v) {
    if (!canEncrypt()) throw new Error("This PC cannot encrypt the key, so it will not be stored.");
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + ".tmp";
    try { fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(v))); fs.renameSync(tmp, file); }
    catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* nothing */ } throw e; }
  }
  return {
    canEncrypt,
    get: (id) => { const k = read()[id]; return typeof k === "string" && k ? k : ""; },
    has: (id) => !!read()[id],
    set(id, key) {
      const k = String(key == null ? "" : key).trim();
      if (!/^[\x21-\x7e]{8,200}$/.test(k)) throw new Error("That does not look like a tracking key (8-" + KEY_MAX + " visible characters, no spaces).");
      const v = read(); v[id] = k; write(v);
    },
    clear(id) { const v = read(); delete v[id]; write(v); },
  };
}

// ---------------------------------------------------------------- providers
const manualProvider = { id: "manual", label: "Manual (no network)", needsKey: false, enabled: () => true, async track() { return { results: {}, errors: {} }; } };

// 17TRACK API v2.4. Response shape (defensive): { code:0, data:{ accepted:[{number, carrier, track_info}], rejected:[{number, error:{code,message}}] } }
function create17Track({ getKey, request, sleep }) {
  const call = request || httpRequest;
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const post = async (endpoint, items) => {
    const key = getKey();
    if (!key) throw new Error("no key");
    const r = await call("POST", "https://api.17track.net/track/v2.4/" + endpoint, { headers: { "Content-Type": "application/json", "17token": key }, body: JSON.stringify(items) });
    if (r.status === 429) throw new Error("rate limited");
    if (r.status === 401 || r.status === 403) throw new Error("the tracking key was refused");
    if (!r.json || r.json.code !== 0) throw new Error("17TRACK answered " + r.status + (r.json && r.json.code != null ? " (code " + r.json.code + ")" : ""));
    return r.json.data || {};
  };
  const alreadyRegistered = (rej) => !!rej && (/registered/i.test(String(rej.error && rej.error.message)) || (rej.error && rej.error.code === -18019901));
  const systemError = (e) => /rate limit|too many requests|refused|no key/i.test(String(e && e.message));
  return {
    id: "17track", label: "17TRACK", needsKey: true, enabled: () => !!getKey(),
    // Extra output beside results/errors: info[number] = { status, sub } (17TRACK's own "NotFound" etc.), codes[number] = error code.
    async track(items) {
      const out = { results: {}, errors: {}, info: {}, codes: {} };
      const list = items.filter((i) => i && i.number);
      for (let i = 0; i < list.length; i += BATCH) {
        const batch = list.slice(i, i + BATCH);
        // 2026-10-27: the owner set a carrier for a number that is already registered -> move it to that carrier. changecarrier
        // (fields number + carrier_new, per the 17TRACK v2.4 docs) is tried first; when 17TRACK refuses it, answers with an
        // unexpected body, or the carrier is "auto-detect", the number is deleted and registered again. Anything that is not an
        // explicit "accepted" counts as a failure: the number then gets an error ("carrier change failed") and is NOT registered,
        // so the owner's choice stays pending (recarrier is kept) instead of being silently dropped.
        const failedMove = new Set();
        const re = batch.filter((b) => b.recarrier);
        if (re.length) {
          try {
            const withCode = re.filter((b) => M.CARRIER_BY_ID[b.carrier] && M.CARRIER_BY_ID[b.carrier].t17);
            let redo = re.filter((b) => !withCode.includes(b));
            if (withCode.length) {
              try {
                const r = await post("changecarrier", withCode.map((b) => ({ number: b.number, carrier_new: M.CARRIER_BY_ID[b.carrier].t17 })));
                const okSet = new Set(Array.isArray(r.accepted) ? r.accepted.map((x) => x && x.number) : []);
                redo = redo.concat(withCode.filter((b) => !okSet.has(b.number)));
              } catch (e) { if (systemError(e)) throw e; redo = redo.concat(withCode); }
              await wait(MIN_GAP_MS);
            }
            if (redo.length) {
              const d = await post("deletetrack", redo.map((b) => ({ number: b.number })));
              const gone = new Set(Array.isArray(d.accepted) ? d.accepted.map((x) => x && x.number) : []);
              const notReg = new Set((Array.isArray(d.rejected) ? d.rejected : []).filter((x) => /not (?:been )?registered|not exist|no such/i.test(String(x && x.error && x.error.message))).map((x) => x.number));
              for (const b of redo) if (!gone.has(b.number) && !notReg.has(b.number)) { failedMove.add(b.number); out.errors[b.number] = "carrier change failed: 17TRACK did not confirm deleting the old registration"; }
              await wait(MIN_GAP_MS);
            }
          } catch (e) {
            if (systemError(e)) { for (const b of batch) out.errors[b.number] = clean(e && e.message, 120); break; }
            for (const b of re) { failedMove.add(b.number); out.errors[b.number] = "carrier change failed: " + clean(e && e.message, 100); }
          }
        }
        const live = batch.filter((b) => !failedMove.has(b.number));
        if (!live.length) { if (i + BATCH < list.length) await wait(MIN_GAP_MS); continue; }
        const payload = live.map((b) => { const o = { number: b.number }; const c = M.CARRIER_BY_ID[b.carrier]; if (c && c.t17) o.carrier = c.t17; return o; });
        try {
          const reg = await post("register", payload);
          for (const rej of reg.rejected || []) if (!alreadyRegistered(rej)) { out.errors[rej.number] = clean(rej.error && rej.error.message, 120) || "rejected"; if (rej.error && rej.error.code != null) out.codes[rej.number] = rej.error.code; }
          await wait(MIN_GAP_MS);
          const info = await post("gettrackinfo", live.map((b) => ({ number: b.number })));
          for (const acc of info.accepted || []) {
            const parsed = parseTrackInfo(acc);
            if (parsed) out.results[acc.number] = parsed;
            const ls = acc && acc.track_info && acc.track_info.latest_status;
            if (ls) out.info[acc.number] = { status: clean(ls.status, 40), sub: clean(ls.sub_status, 60) };
          }
          for (const rej of info.rejected || []) if (!out.errors[rej.number]) { out.errors[rej.number] = clean(rej.error && rej.error.message, 120) || "rejected"; if (rej.error && rej.error.code != null) out.codes[rej.number] = rej.error.code; }
        } catch (e) {
          for (const b of live) out.errors[b.number] = clean(e && e.message, 120);
          if (systemError(e)) break;
        }
        if (i + BATCH < list.length) await wait(MIN_GAP_MS);
      }
      return out;
    },
  };
}
function parseTrackInfo(acc) {
  const ti = acc && acc.track_info;
  if (!ti || typeof ti !== "object") return null;
  const events = [];
  for (const p of (ti.tracking && ti.tracking.providers) || []) {
    for (const e of p.events || []) events.push({ at: Date.parse(e.time_iso || e.time_utc || ""), text: clean(e.description, 240), place: clean(e.location || [e.address && e.address.city, e.address && e.address.country].filter(Boolean).join(", "), 80) });
  }
  if (!events.length && ti.latest_event) events.push({ at: Date.parse(ti.latest_event.time_iso || ""), text: clean(ti.latest_event.description, 240), place: clean(ti.latest_event.location, 80) });
  const ls = ti.latest_status || {};
  const evs = events.filter((e) => e.text).map((e) => ({ at: Number.isFinite(e.at) ? e.at : null, text: e.text, place: e.place }));
  const state = M.stateFromTrack17(ls.status, ls.sub_status, evs.length ? evs.slice().sort((a, b) => (b.at || 0) - (a.at || 0))[0].text : "");
  const edd = ti.time_metrics && ti.time_metrics.estimated_delivery_date;
  const eta = edd && (edd.from || edd.to) ? Date.parse(edd.to || edd.from) : null;
  if (!evs.length && !state) return null;
  // the carrier 17TRACK itself detected: accepted[].carrier (code), else the first provider's key/name
  const prov = ((ti.tracking && ti.tracking.providers) || []).map((p) => p && p.provider).find((p) => p && (p.key || p.name)) || {};
  const carrier = M.carrierFromT17(acc.carrier) || M.carrierFromT17(prov.key);
  const carrierName = clean(prov.name, 40) || (carrier ? M.carrierName(carrier) : "");
  return { events: evs, state, eta: Number.isFinite(eta) ? eta : null, carrier, carrierName };
}

// DHL Unified Tracking (needs its own free key, 250 calls/day, 1 call per 5 s). Unverified against the live API.
function createDhl({ getKey, request, sleep }) {
  const call = request || httpRequest;
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  return {
    id: "dhl", label: "DHL", needsKey: true, minIntervalMs: DHL_MIN_MS, enabled: () => !!getKey(),
    async track(items) {
      const out = { results: {}, errors: {} };
      let first = true;
      for (const it of items.filter((i) => i && i.number).slice(0, 20)) {
        if (!first) await wait(5200);
        first = false;
        try {
          const r = await call("GET", "https://api-eu.dhl.com/track/shipments?trackingNumber=" + encodeURIComponent(it.number), { headers: { "DHL-API-Key": getKey() } });
          if (r.status === 404) { out.errors[it.number] = "not found yet"; continue; }
          if (r.status === 429) { out.errors[it.number] = "rate limited"; break; }
          if (r.status !== 200 || !r.json) { out.errors[it.number] = "DHL answered " + r.status; continue; }
          const sh = (r.json.shipments || [])[0];
          if (!sh) { out.errors[it.number] = "not found yet"; continue; }
          const evs = (sh.events || []).map((e) => ({ at: Date.parse(e.timestamp), text: clean([e.description, e.status].filter(Boolean)[0], 240), place: clean(e.location && e.location.address && e.location.address.addressLocality, 80) })).filter((e) => e.text);
          const st = sh.status && sh.status.statusCode;
          const state = st === "delivered" ? "delivered" : st === "failure" ? "exception_stuck" : st === "transit" ? M.stateFromText(evs[0] && evs[0].text) || "in_transit" : null;
          out.results[it.number] = { events: evs.map((e) => ({ at: Number.isFinite(e.at) ? e.at : null, text: e.text, place: e.place })), state, eta: sh.estimatedTimeOfDelivery ? Date.parse(sh.estimatedTimeOfDelivery) : null };
        } catch (e) { out.errors[it.number] = clean(e && e.message, 120); }
      }
      return out;
    },
  };
}
// UPS / FedEx: wired, disabled. They exist so the routing table is complete; no key slot is exposed yet (OAuth app needed).
const stubProvider = (id, label) => ({ id, label, needsKey: true, enabled: () => false, async track() { return { results: {}, errors: {} }; } });

// Dev-only provider for tests: script = { [number]: { events, state, eta } | Error }.
function createFake(script) {
  return { id: "fake", label: "Fake (tests)", needsKey: false, enabled: () => true, calls: [], async track(items) {
    this.calls.push(items.map((i) => i.number));
    const out = { results: {}, errors: {} };
    for (const it of items) { const v = script && script[it.number]; if (v instanceof Error) out.errors[it.number] = v.message; else if (v) out.results[it.number] = v; }
    return out;
  } };
}

// ---------------------------------------------------------------- why is there nothing to show? (persisted per number)
// -> { reason, reasonText } for a number that came back without events. `err` is the provider's message for it, `info` its
// { status, sub } as 17TRACK reported it, `ageMs` how long the number has been registered, `code` 17TRACK's error code.
const DAY_MS = 86400000;
function classifyReason(err, info, ageMs, code) {
  const e = String(err || "");
  if (e) {
    if (/^carrier change failed/i.test(e)) return { reason: "error", reasonText: "Could not move the number to the carrier you chose yet (" + clean(e.replace(/^carrier change failed:\s*/i, ""), 80) + "). It will be tried again." };
    if (/refused|no key/i.test(e)) return { reason: "key_refused", reasonText: "17TRACK refused the key - check it under Tracking key." };
    if (/rate limit|too many requests/i.test(e)) return { reason: "rate", reasonText: "17TRACK was busy (rate limit) - it will be asked again." };
    if (/quota|insufficient|balance|exceed/i.test(e)) return { reason: "quota", reasonText: "The 17TRACK quota is used up, so this number cannot be tracked." };
    if (/no tracking information/i.test(e)) return { reason: "not_found", reasonText: "17TRACK has no tracking information for this number yet. The carrier may not have scanned it, or it is not a tracking number." };   // 2026-11-13: "information" used to match /format/ and flag these as invalid
    if (/invalid|illegal|\bformat\b|incorrect/i.test(e)) return { reason: "invalid", reasonText: "17TRACK says this is not a valid tracking number (" + clean(e, 80) + ")." };
    if (/carrier|detect|identif|rejected/i.test(e) || code != null) return { reason: "rejected", reasonText: "17TRACK did not accept this number: " + clean(e, 100) + "." };
    return { reason: "error", reasonText: "The tracking lookup failed: " + clean(e, 100) + "." };
  }
  const st = String((info && info.status) || ""), sub = String((info && info.sub) || "");
  if (st === "NotFound") {
    if (/Invalid/i.test(sub)) return { reason: "invalid", reasonText: "17TRACK says this is not a valid tracking number." };
    if (ageMs != null && ageMs < DAY_MS) return { reason: "waiting", reasonText: "Waiting for the first scan - the carrier has not reported anything yet (normal for the first day)." };
    return { reason: "not_found", reasonText: "17TRACK cannot find this number. The carrier may not have scanned it yet, or it is an order number rather than a tracking number." };
  }
  return { reason: "waiting", reasonText: "Waiting for the first scan - 17TRACK has it registered but the carrier has reported nothing yet." };
}

// ---------------------------------------------------------------- manager
// Chooses a provider per shipment number and applies the results. Pure of electron: safeStorage is injected.
function createTracker({ dataDir, safeStorage, request, sleep, fakeProvider, log }) {
  const say = typeof log === "function" ? log : () => {};
  const keys = dataDir ? createKeyStore({ dataDir, safeStorage }) : { canEncrypt: () => false, get: () => "", has: () => false, set() { throw new Error("not available"); }, clear() {} };
  const p17 = create17Track({ getKey: () => keys.get("17track"), request, sleep });
  const pdhl = createDhl({ getKey: () => keys.get("dhl"), request, sleep });
  const providers = { manual: manualProvider, "17track": p17, dhl: pdhl, ups: stubProvider("ups", "UPS"), fedex: stubProvider("fedex", "FedEx") };
  if (fakeProvider) providers.fake = fakeProvider;
  let running = null;

  // which provider handles this number
  function route(num) {
    if (providers.fake) return providers.fake;
    if (num.carrier === "dhl" && pdhl.enabled()) return pdhl;
    if (p17.enabled()) return p17;
    return manualProvider;
  }
  const hasLiveProvider = () => !!providers.fake || p17.enabled() || pdhl.enabled();

  // Numbers due for a poll. Archived and delivered parcels are never polled; DHL ones at most every 6 h.
  function due(list, now, force) {
    const out = [];
    for (const s of list) {
      if (s.archived || s.state === "delivered") continue;
      for (const n of s.numbers) {
        if (n.carrier === "amazon" && M.isAmazonNumber(n.no)) continue;   // Amazon Logistics (TBA...) is only trackable inside Amazon; any other number goes to the tracker
        const p = route(n);
        if (p.id === "manual") continue;
        if (!force && p.id === "dhl" && s.polledAt && now - s.polledAt < DHL_MIN_MS) continue;
        out.push({ shipment: s, number: n.no, carrier: n.carrier, recarrier: !!n.recarrier, ref: n, provider: p });
      }
    }
    return out;
  }

  // Poll everything due and apply. Returns { polled, changed:[ids], errors, skipped }.
  async function refresh(list, now, opts) {
    if (running) return running;
    running = (async () => {
      const todo = due(list, now, opts && opts.force);
      const res = { polled: 0, changed: [], errors: {}, provider: hasLiveProvider() ? "live" : "none" };
      if (!todo.length) return res;
      const byProv = new Map();
      for (const t of todo) { if (!byProv.has(t.provider)) byProv.set(t.provider, []); byProv.get(t.provider).push(t); }
      for (const [prov, items] of byProv) {
        let r;
        try { r = await prov.track(items.map((i) => ({ number: i.number, carrier: i.carrier, recarrier: i.recarrier }))); }
        catch (e) { say("shipments " + prov.id + " failed: " + clean(e && e.message, 120)); r = { results: {}, errors: Object.fromEntries(items.map((i) => [i.number, clean(e && e.message, 120)])) }; }
        for (const it of items) {
          res.polled++;
          const hit = r.results[it.number];
          const err = r.errors[it.number];
          const ref = it.ref;
          if (ref) {
            // keep the owner-chosen carrier request until the provider has really received it (not on key/rate/quota trouble)
            if (ref.recarrier && !/refused|no key|rate limit|too many requests|quota|^carrier change failed/i.test(String(err || ""))) delete ref.recarrier;
            if (hit && hit.events && hit.events.length) { delete ref.reason; delete ref.reasonText; delete ref.reasonAt; }
            else {
              const c = classifyReason(err, r.info && r.info[it.number], now - (ref.at || it.shipment.added || now), r.codes && r.codes[it.number]);
              ref.reason = c.reason; ref.reasonText = c.reasonText; ref.reasonAt = now;
            }
          }
          if (hit) {
            // 17TRACK named the carrier: keep it on a number whose carrier we only guessed (never over the owner's choice)
            if (ref && !ref.carrierSet && (ref.carrier === "other" || !ref.carrier) && hit.carrier && hit.carrier !== "other") {
              ref.carrier = hit.carrier;
              if (it.shipment.numbers[it.shipment.numbers.length - 1] === ref) it.shipment.carrier = hit.carrier;
            } else if (ref && !ref.carrierSet && ref.carrier === "other" && hit.carrierName && !ref.carrierLabel) ref.carrierLabel = clean(hit.carrierName, 40);
            const before = JSON.stringify([it.shipment.state, it.shipment.lastEvent, it.shipment.eta]);
            M.applyEvents(it.shipment, hit.events, now, { state: hit.state, eta: hit.eta });
            if (JSON.stringify([it.shipment.state, it.shipment.lastEvent, it.shipment.eta]) !== before) { if (!res.changed.includes(it.shipment.id)) res.changed.push(it.shipment.id); }
          } else {
            it.shipment.polledAt = now; it.shipment.polledOk = !r.errors[it.number];
            if (r.errors[it.number]) res.errors[it.number] = r.errors[it.number];
          }
        }
      }
      return res;
    })().finally(() => { running = null; });
    return running;
  }

  return {
    keys, providers, route, due, refresh, hasLiveProvider, POLL_MS,
    status: () => ({ has17: keys.has("17track"), hasDhl: keys.has("dhl"), canEncrypt: keys.canEncrypt(), live: hasLiveProvider() }),
  };
}

module.exports = { classifyReason, createTracker, createKeyStore, create17Track, createDhl, createFake, manualProvider, parseTrackInfo, httpRequest, POLL_MS, DHL_MIN_MS, BATCH };
