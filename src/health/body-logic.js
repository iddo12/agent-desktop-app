// My Health Body tab: pure logic (v1.118.0). No DOM, no fs, no timers. Used by the renderer (window.healthBodyLogic), by the main process
// (validation of what the renderer sends and of what is read back from pain_log.jsonl) and by tests/bodyTab.test.js.
// All lists (zones, chips, safety questions, ranges) come from body-data.js; nothing about them is hard-coded here.
(function (root, factory) {
  const data = typeof module === "object" && module.exports ? require("./body-data") : root.healthBodyData;
  const api = factory(data);
  if (typeof module === "object" && module.exports) module.exports = api; else root.healthBodyLogic = api;
})(typeof window !== "undefined" ? window : this, function (D) {
  "use strict";
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const CHIPS = [["type", "types", "typesRetired"], ["trigger", "triggers", "triggersRetired"], ["spread", "spread", "spreadRetired"], ["worseWith", "worseWith", "worseWithRetired"], ["betterWith", "betterWith", "betterWithRetired"]];
  const SEV_WORD = {}; D.severity.forEach(([n, w]) => { SEV_WORD[n] = w; });

  // ---- left / right. Always the PERSON'S left / right. FRONT view: the person's right is on the screen's left. BACK view: on the screen's right.
  function sideOnScreen(view, side) {
    if (side !== "left" && side !== "right") return "centre";
    if (view === "front") return side === "right" ? "left" : "right";
    if (view === "back") return side;
    throw new Error("bad view");
  }
  function personSideFromScreen(view, screenSide) { return sideOnScreen(view, screenSide); }   // the mapping is its own inverse
  // The side a zone is on, judged from where its ellipse sits (cx < 100 = screen-left), for cross-checking the data file.
  function sideFromGeometry(view, cx) {
    if (cx < 96) return personSideFromScreen(view, "left");
    if (cx > 104) return personSideFromScreen(view, "right");
    return "centre";
  }

  // ---- zones
  let zoneMap = null;
  function zones() {
    if (zoneMap) return zoneMap;
    zoneMap = {};
    ["front", "back"].forEach((view) => D.views[view].zones.forEach((z, i) => { zoneMap[z[0]] = { id: z[0], name: z[1], side: z[2] || "centre", view, cx: z[3], cy: z[4], rx: z[5], ry: z[6], order: i }; }));
    return zoneMap;
  }
  const zoneList = () => ["front", "back"].reduce((a, v) => a.concat(D.views[v].zones.map((z) => zones()[z[0]])), []);
  const zoneLabel = (z) => (z.side === "centre" ? z.name : z.name + " (your " + z.side + ")");
  const sideWord = (side) => (side === "centre" ? "" : "your " + side.toUpperCase() + " side");
  function zoneBase(z) { return z.name; }
  const safetyRequired = (zoneId) => D.safetyZones.indexOf(zoneId) >= 0;

  // ---- dates (local calendar days as YYYY-MM-DD; arithmetic done in UTC so DST never shifts a day)
  function validDate(s) {
    const m = DATE_RE.exec(String(s || "")); if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 2000 && +m[1] <= 2100;
  }
  const utc = (s) => { const m = DATE_RE.exec(s); return Date.UTC(+m[1], +m[2] - 1, +m[3]); };
  const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
  function addDays(s, n) { const d = new Date(utc(s) + n * 86400000); return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0"); }
  function localDate(d) { d = d || new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  // Days to normal = days from the start date to the date it felt normal again (Sun 11 Oct -> Fri 16 Oct = 5). Never typed by the person.
  function daysToNormal(startDate, betterDate) { if (!validDate(startDate) || !validDate(betterDate)) return null; const n = daysBetween(startDate, betterDate); return n < 0 ? null : n; }
  // "Day 3" when started Sun 11 Oct and today is Tue 13 Oct (the start day is day 1).
  const dayNumber = (startDate, today) => daysBetween(startDate, today) + 1;

  // ---- safety
  // answers: {weakness_numbness, bladder_bowel, fever_unwell} each yes|no|not_sure|undefined. Returns {complete, flag, reasons:[{key, answer}]}.
  function evaluateSafety(answers) {
    const a = answers || {}, reasons = []; let complete = true;
    D.safety.questions.forEach((q) => {
      const v = a[q.key];
      if (v !== "yes" && v !== "no" && v !== "not_sure") { complete = false; return; }
      if (v === "yes" || (v === "not_sure" && q.alertOnNotSure)) reasons.push({ key: q.key, answer: v });
    });
    return { complete, flag: reasons.length > 0, reasons };
  }

  // ---- entry validation. `raw` comes from the renderer (or a line of the file). Returns {ok:true, entry} or {ok:false, reason}.
  // opts: {now: ISO string for "updated"/"answeredAt" (main supplies it), keepUpdated: true when re-reading the file}
  const str = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
  function chipKeys(list, allowed, retired) {
    if (list == null) return [];
    if (!Array.isArray(list)) return null;
    const ok = new Set(allowed.map((x) => x[0]).concat(retired || [])), out = [];
    for (const k of list.slice(0, 24)) if (typeof k === "string" && ok.has(k) && out.indexOf(k) < 0) out.push(k);
    return out;
  }
  function validateEntry(raw, opts) {
    const o = opts || {}, bad = (reason) => ({ ok: false, reason });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("Not an entry.");
    if (!ID_RE.test(String(raw.id || ""))) return bad("Bad id.");
    if (!ID_RE.test(String(raw.episode || raw.id))) return bad("Bad episode id.");
    const z = zones()[raw.zone]; if (!z) return bad("Unknown spot.");
    if (raw.side !== z.side) return bad("Side does not match the spot.");
    if (!validDate(raw.date)) return bad("Bad date.");
    if (!validDate(raw.startDate)) return bad("Bad start date.");
    if (daysBetween(raw.startDate, raw.date) < 0) return bad("The start date is after the entry date.");
    const sev = Number(raw.severity); if (!Number.isInteger(sev) || sev < 1 || sev > 5) return bad("Strength must be 1 to 5.");
    const e = { id: String(raw.id), episode: String(raw.episode || raw.id), zone: z.id, side: z.side, date: raw.date, startDate: raw.startDate, severityWord: SEV_WORD[sev], severity: sev };
    for (const [f, list, retired] of CHIPS) { const k = chipKeys(raw[f], D[list], D[retired]); if (k === null) return bad("Bad " + f + " list."); e[f] = k; }
    e.spreadOther = str(raw.spreadOther, D.limits.spreadOther);
    e.note = str(raw.note, D.limits.note);
    // safety: required for back / neck spots when the entry is written by the app (not when re-reading older lines)
    const need = safetyRequired(z.id);
    if (raw.safety && typeof raw.safety === "object") {
      const s = {}, a = {};
      for (const q of D.safety.questions) { const v = raw.safety[q.key]; if (v === "yes" || v === "no" || v === "not_sure") a[q.key] = v; }
      let ev = evaluateSafety(a);
      // A flagged answer must always be storable: when one answer already raises the alert, unanswered questions count as "not sure".
      if (ev.flag && !ev.complete && !o.keepUpdated) { D.safety.questions.forEach((q) => { if (!a[q.key]) a[q.key] = "not_sure"; }); ev = evaluateSafety(a); }
      // Marking an episode better re-sends the earlier answers; they are not asked again, so completeness is not required then.
      if (need && !ev.complete && !o.keepUpdated && !raw.betterDate) return bad("The safety questions must be answered for this spot.");
      const pr = o.prior && o.prior[raw.id] && o.prior[raw.id].safety;
      const same = pr && D.safety.questions.every((q) => pr[q.key] === a[q.key]);
      Object.assign(s, a); s.answeredAt = o.keepUpdated ? str(raw.safety.answeredAt, 40) : (same && pr.answeredAt ? pr.answeredAt : (o.now || new Date().toISOString()));
      e.safety = s; e.safety_flag = ev.flag;           // recomputed here, whatever the renderer said
    } else {
      if (need && !o.keepUpdated && !raw.betterDate) return bad("The safety questions must be answered for this spot.");
      e.safety = null; e.safety_flag = false;
    }
    if (raw.betterDate) {
      if (!validDate(raw.betterDate) || daysBetween(raw.startDate, raw.betterDate) < 0) return bad("Bad better date.");
      e.betterDate = raw.betterDate; e.daysToNormal = daysToNormal(raw.startDate, raw.betterDate);
      e.movingNormally = D.normal.some((n) => n[0] === raw.movingNormally) ? raw.movingNormally : "yes";
    } else { e.betterDate = null; e.daysToNormal = null; }
    e.updated = o.keepUpdated ? str(raw.updated, 40) : (o.now || new Date().toISOString());
    return { ok: true, entry: e };
  }

  // ---- the file. One JSON object per line; an update is a new line with the same id and a later "updated"; latest wins.
  // A half-written last line (crash while appending) is skipped, never an error.
  function parseLog(text) {
    const out = []; let skipped = 0;
    const lines = String(text || "").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch (e) { skipped++; continue; }
      const r = validateEntry(j, { keepUpdated: true });
      if (r.ok) out.push(r.entry); else skipped++;
    }
    return { entries: out, skipped };
  }
  function mergeLatest(entries) {
    const by = new Map();
    entries.forEach((e, i) => { const p = by.get(e.id); if (!p || String(e.updated) >= String(p.e.updated)) by.set(e.id, { e, i }); });   // equal stamps: the later line wins
    return Array.from(by.values()).map((x) => x.e).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  }
  const serialize = (entry) => JSON.stringify(entry) + "\n";

  // ---- episodes: entries sharing an `episode` id. A spot from its first entry to "better". Both-sides spots are two zones in one episode.
  function buildEpisodes(entries) {
    const by = new Map();
    entries.forEach((e) => { if (!by.has(e.episode)) by.set(e.episode, []); by.get(e.episode).push(e); });
    const eps = [];
    by.forEach((list, id) => {
      list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const last = list[list.length - 1], lastDate = last.date, onLast = list.filter((e) => e.date === lastDate);
      const zoneIds = []; list.forEach((e) => { if (zoneIds.indexOf(e.zone) < 0) zoneIds.push(e.zone); });
      const closed = list.filter((e) => e.betterDate).sort((a, b) => (a.betterDate < b.betterDate ? 1 : -1))[0];
      const days = []; list.forEach((e) => { if (days.indexOf(e.date) < 0) days.push(e.date); });
      eps.push({
        id, zones: zoneIds, entries: list, days, start: list.reduce((m, e) => (e.startDate < m ? e.startDate : m), list[0].startDate),
        lastDate, severity: Math.max.apply(null, onLast.map((e) => e.severity)),
        flagged: list.some((e) => e.safety_flag), better: closed ? closed.betterDate : null, daysToNormal: closed ? closed.daysToNormal : null, movingNormally: closed ? closed.movingNormally : null,
        active: !closed || closed.movingNormally === "not_yet",
        union: (f) => { const s = []; list.forEach((e) => (e[f] || []).forEach((k) => { if (s.indexOf(k) < 0) s.push(k); })); return s; },
      });
    });
    return eps.sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : a.id < b.id ? -1 : 1));
  }
  // Marking "not yet" does not close an episode; only yes / mostly do.
  function isClosedChoice(movingNormally) { return movingNormally === "yes" || movingNormally === "mostly"; }
  // The days-to-normal of the most recent earlier closed episode that touched one of the same zones (null when none).
  function previousDays(eps, ep) {
    const cand = eps.filter((x) => x.id !== ep.id && x.better && x.start < ep.start && x.zones.some((z) => ep.zones.indexOf(z) >= 0)).sort((a, b) => (a.start < b.start ? 1 : -1));
    return cand.length ? cand[0].daysToNormal : null;
  }

  // ---- history heat
  function heatLevel(value, table) { let lv = 0; for (const [min, level] of table) if (value >= min) lv = level; return lv; }
  // Per-zone {count, max} for entries whose date falls in the last `days` days (null = all), counting today as day 1.
  function historyByZone(entries, days, today) {
    const from = days == null ? null : addDays(today, -(days - 1)), res = {};
    entries.forEach((e) => { if (e.date > today) return; if (from && e.date < from) return; const r = res[e.zone] || (res[e.zone] = { count: 0, max: 0 }); r.count++; if (e.severity > r.max) r.max = e.severity; });
    return res;
  }
  function heatFor(rec, metric) { if (!rec) return 0; return metric === "strongest" ? heatLevel(rec.max, D.heatStrongest) : heatLevel(rec.count, D.heatEntries); }
  // Zones most to least by the metric (ties by name), for the list under the figures.
  function rankZones(byZone, metric) {
    return Object.keys(byZone).map((id) => ({ id, z: zones()[id], rec: byZone[id] })).filter((r) => r.z)
      .sort((a, b) => { const x = metric === "strongest" ? b.rec.max - a.rec.max || b.rec.count - a.rec.count : b.rec.count - a.rec.count || b.rec.max - a.rec.max; return x || (a.z.name < b.z.name ? -1 : 1); });
  }

  return { D, sideOnScreen, personSideFromScreen, sideFromGeometry, zones, zoneList, zoneLabel, sideWord, zoneBase, safetyRequired, validDate, daysBetween, addDays, localDate, daysToNormal, dayNumber,
    evaluateSafety, validateEntry, parseLog, mergeLatest, serialize, buildEpisodes, isClosedChoice, previousDays, heatLevel, historyByZone, heatFor, rankZones };
});
