// HOW TO IMPROVE (main process, no electron import: everything is injected so tests can drive it).
// Reads  <sharedReports>\improve\cards.json  (written by the friction miner; never edited here) and the sibling decisions file
// <sharedReports>\improve\decisions.json  { decisions: { <cardId>: { status: approved|rejected|applied|worked|didnt_work, answeredAt, answer, times:{<status>:iso} } } }  (the ONLY thing this tab writes).
// The renderer sends a card id and a decision, never a path. Every string is clipped and type-checked; a missing, malformed or oversized file
// gives a plain state, never an exception. Applying an approved change is a separate step done by the Security agent, not by this code.
"use strict";
const fsp = require("fs").promises;
const path = require("path");

const MAX_FILE_BYTES = 1024 * 1024, MAX_CARDS = 200, MAX_EVIDENCE = 8, ID_PREFIX = "imp:";
const STATUSES = ["new", "approved", "rejected", "applied", "worked", "didnt_work"];
const DECISIONS = ["approved", "rejected", "applied", "worked", "didnt_work"];
const RANK = { new: 0, approved: 1, rejected: 1, applied: 2, worked: 3, didnt_work: 3 };   // lifecycle order: a later state wins when cards.json and decisions.json disagree
const FROM = { approved: ["new"], rejected: ["new", "approved"], applied: ["approved"], worked: ["applied"], didnt_work: ["applied"] };   // allowed previous states
const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

// async on purpose: Dropbox files can take ~2 s to open
async function readJson(file) {
  let st;
  try { st = await fsp.lstat(file); } catch (e) { return { missing: true }; }
  if (!st.isFile()) return { bad: "not-a-file" };
  if (st.size > MAX_FILE_BYTES) return { bad: "too-big" };
  try { return { json: JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, "")) }; } catch (e) { return { bad: "unreadable" }; }
}

function cleanCard(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const id = clip(c.id, 100).trim(), finding = clip(c.finding, 1200).trim();
  if (!id || !finding || !/^[A-Za-z0-9._-]{1,100}$/.test(id)) return null;   // security review 2026-10-30: strict id, it reaches the message writer
  const status = STATUSES.includes(c.status) ? c.status : "new";
  return {
    id, agent: clip(c.agent, 120), signal: clip(c.signal, 60), kind: clip(c.kind, 30), finding,
    proposedFix: clip(c.proposedFix, 1500), owner: clip(c.owner, 120).trim(),
    evidence: Array.isArray(c.evidence) ? c.evidence.slice(0, MAX_EVIDENCE).map((e) => clip(e, 300)).filter(Boolean) : [],
    command: clip(c.command, 2000), mechanism: clip(c.mechanism, 300), contextSaving: clip(c.contextSaving, 300), undo: clip(c.undo, 500),
    score: Number.isFinite(c.score) ? Math.max(0, Math.min(1e6, c.score)) : 0, status,
    answer: clip(c.answer, 2000), answeredAt: clip(c.answeredAt, 40), stage: Number.isFinite(c.stage) ? Math.max(0, Math.min(20, Math.round(c.stage))) : 0,
  };
}

function cleanDecisions(j) {
  const out = {};
  const d = j && typeof j === "object" && j.decisions && typeof j.decisions === "object" && !Array.isArray(j.decisions) ? j.decisions : {};
  for (const id of Object.keys(d).slice(0, 2000)) {
    const x = d[id];
    if (!x || typeof x !== "object" || !DECISIONS.includes(x.status) || id.length > 100) continue;
    const times = {};
    if (x.times && typeof x.times === "object" && !Array.isArray(x.times)) for (const k of DECISIONS) if (typeof x.times[k] === "string") times[k] = clip(x.times[k], 40);
    out[id] = { status: x.status, answeredAt: clip(x.answeredAt, 40), answer: clip(x.answer, 2000), times };
  }
  return out;
}

// ISO week name (2026-W44) of a date, for the shared message writer
function isoWeek(ms) {
  const d = new Date(ms), t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dow);
  const y = t.getUTCFullYear(), w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return y + "-W" + String(w).padStart(2, "0");
}

function createService(o) {
  const dir = o.dir;                                           // <sharedReports>\improve
  const cardsFile = path.join(dir, "cards.json"), decFile = path.join(dir, "decisions.json");
  const now = typeof o.now === "function" ? o.now : Date.now;
  let chain = Promise.resolve();                               // serialises decision writes (read-modify-write)

  async function loadCards() {
    const r = await readJson(cardsFile);
    if (r.missing) return { state: "missing" };
    if (r.bad) return { state: r.bad };
    const j = r.json;
    if (!j || typeof j !== "object" || Array.isArray(j) || !Array.isArray(j.cards)) return { state: "unreadable" };
    return { state: "ok", json: j, cards: j.cards.slice(0, MAX_CARDS).map(cleanCard).filter(Boolean) };
  }

  async function load() {
    const c = await loadCards();
    if (c.state !== "ok") return { ok: true, state: c.state, cards: [], counts: { new: 0, approved: 0, rejected: 0, applied: 0, worked: 0, didnt_work: 0 } };
    const dr = await readJson(decFile);
    const dec = dr.json ? cleanDecisions(dr.json) : {};
    const cards = c.cards.map((card) => {
      const d = dec[card.id];
      card.times = {};
      if (d) { card.times = d.times; if (RANK[d.status] >= RANK[card.status]) Object.assign(card, { status: d.status, answeredAt: d.answeredAt || card.answeredAt, answer: d.answer || card.answer }); }
      return card;
    });
    cards.sort((a, b) => (a.status === "new" ? 0 : 1) - (b.status === "new" ? 0 : 1) || b.score - a.score);
    const counts = { new: 0, approved: 0, rejected: 0, applied: 0, worked: 0, didnt_work: 0 };
    cards.forEach((k) => { counts[k.status]++; });
    return { ok: true, state: "ok", generated: clip(c.json.generated, 40), windowDays: Number.isFinite(c.json.window_days) ? Math.max(0, Math.min(3650, Math.round(c.json.window_days))) : 0,
      humanMessages: Number.isFinite(c.json.humanMessages) ? Math.max(0, Math.round(c.json.humanMessages)) : 0, cards, counts, decisionsBad: !!dr.bad };
  }

  // Yes / No (and later: applied, worked, didnt_work): writes only { status, answeredAt, answer, times } for a card that exists in cards.json, into decisions.json (atomic temp + rename).
  function decide(id, status, answer) {
    const run = async () => {
      if (typeof id !== "string" || !id || id.length > 100 || !DECISIONS.includes(status)) return { ok: false, reason: "Bad request." };
      const c = await loadCards();
      if (c.state !== "ok" || !c.cards.some((k) => k.id === id)) return { ok: false, reason: "That card is no longer in the list. Refresh the tab (nothing was saved)." };
      const dr = await readJson(decFile);
      if (dr.bad) return { ok: false, reason: "The decisions file cannot be read, so nothing was saved." };
      const dec = dr.json ? cleanDecisions(dr.json) : {};
      const card = c.cards.find((k) => k.id === id), prev = dec[id], cur = prev ? (RANK[prev.status] >= RANK[card.status] ? prev.status : card.status) : card.status;
      if (cur === status) return { ok: true, status, answeredAt: prev ? prev.answeredAt : card.answeredAt, unchanged: true };
      if (!FROM[status].includes(cur)) return { ok: false, reason: "That card is already " + cur.replace("_", " ") + ", so it cannot be marked " + status.replace("_", " ") + ". Refresh the tab (nothing was saved)." };
      const at = new Date(now()).toISOString();
      const entry = { status, answeredAt: at, answer: clip(answer, 2000) || (prev ? prev.answer : ""), times: Object.assign({}, prev ? prev.times : {}, { [status]: at }) };
      dec[id] = entry;
      const tmp = decFile + ".tmp" + process.pid;
      try {
        await fsp.writeFile(tmp, JSON.stringify({ updated: entry.answeredAt, decisions: dec }, null, 1), "utf8");
        await fsp.rename(tmp, decFile);
      } catch (e) { try { await fsp.unlink(tmp); } catch (x) { /* none */ } return { ok: false, reason: "Could not save the decision." }; }
      return { ok: true, status, answeredAt: at };
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  // for the shared message writer: the card must exist and its owner must be the addressed agent. Returns { title, week } or null.
  async function findRef(agent, fid) {
    if (typeof agent !== "string" || typeof fid !== "string" || !fid.startsWith(ID_PREFIX)) return null;
    const c = await loadCards();
    if (c.state !== "ok") return null;
    const card = c.cards.find((k) => k.id === fid.slice(ID_PREFIX.length));
    if (!card || card.owner.toLowerCase() !== agent.trim().toLowerCase()) return null;
    return { title: "How to improve: " + card.finding.slice(0, 200) };
  }

  return { load, decide, findRef, weekName: () => isoWeek(now()) };
}

module.exports = { createService, cleanCard, cleanDecisions, isoWeek, ID_PREFIX };
