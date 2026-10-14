// My Daily - Decisions service (main process, no electron import: everything is injected so tests can drive it).
// Store: <daily data folder>/decisions.json { version, answers:{<itemId>:{...}}, overrides:{<itemId>:"gonogo"|"text"} } (atomic write + .bak
// through the injected writeJsonAtomic, like Shipments). Open items come from the fleet task store (flag: see contract.js).
// An answer is recorded ONLY after the message reached the agent (sent = confirmed in its transcript, queued = handed over, agent busy).
"use strict";
const M = require("./decisions-model");
const C = require("./contract");

const MAX_ARCHIVE = 2000;

function fixtureStores(now) {
  const iso = (d) => new Date(now - d * 86400000).toISOString();
  const mk = (id, title, detail, pri, age, tags) => ({ id, title, detail, status: "open", [C.NEEDS_KEY]: true, priority: pri, tags: tags || [], created: iso(age), updated: iso(age), group: null });
  return [
    { agent: "Security", items: [mk("deploy-v178", "Go/no-go: deploy Agent Desktop v1.78.0", "Built and tested in the sandbox. Waiting for the owner's go-ahead.", 1, 1), mk("pick-lawyer", "Which lawyer covers Israeli e-commerce law?", "Legal needs a name.", 2, 3)] },
    { agent: "Legal Agent", items: [mk("licence-model", "Owner decision: licence model per tool", "Closed + EULA or open source?", 2, 2), mk("done-one", "Already finished", "", 2, 5)] },
  ];
}

// delivery result of deliverToAgentVerified -> sent (confirmed in the transcript) / queued (handed over, not confirmed) / failed. Shared with the Tasks triage.
function classifyDelivery(r) {
  if (r && r.dry) return { delivery: "failed", reason: "Test mode: live agents are not permitted, nothing was sent." };
  if (r && r.delivered) return { delivery: "sent" };
  if (r && r.via && !r.aborted) return { delivery: "queued" };
  return { delivery: "failed", reason: "The agent did not take the message (it may not be running, or its input is busy). Nothing was recorded; try again." };
}

function createService({ root, people, file, readStore, writeJsonAtomic, loadStores, deliver, knownAgent, run, now, say, notices, testMode, fixtures, path }) {
  const clock = typeof now === "function" ? now : () => Date.now();
  const log = typeof say === "function" ? say : () => {};
  const inflight = new Set();
  const answeredMem = new Map();   // id -> taskUpdated: guards a failed record write from re-opening the item in this session

  function loadFile() {
    const raw = readStore(file, { answers: {}, overrides: {} }, notices, "Decisions");
    return {
      answers: raw.answers && typeof raw.answers === "object" && !Array.isArray(raw.answers) ? raw.answers : {},
      overrides: raw.overrides && typeof raw.overrides === "object" && !Array.isArray(raw.overrides) ? raw.overrides : {},
    };
  }
  function save(st) {
    const ids = Object.keys(st.answers);
    if (ids.length > MAX_ARCHIVE) {
      ids.sort((a, b) => (Number(st.answers[a] && st.answers[a].answeredAt) || 0) - (Number(st.answers[b] && st.answers[b].answeredAt) || 0));
      for (const id of ids.slice(0, ids.length - MAX_ARCHIVE)) delete st.answers[id];
    }
    writeJsonAtomic(file, { version: 1, answers: st.answers, overrides: st.overrides });
  }
  async function stores() {
    if (fixtures) return { stores: fixtureStores(clock()), skipped: 0 };
    const r = await loadStores();
    return { stores: (r && r.stores) || [], skipped: (r && r.skipped) || 0 };
  }
  function withMem(st) {
    const a = Object.assign({}, st.answers);
    for (const [id, upd] of answeredMem) if (!a[id]) a[id] = { taskUpdated: upd };
    return a;
  }
  async function view() {
    const st = loadFile();
    const s = await stores();
    const open = M.openItems(s.stores, withMem(st), st.overrides);
    const archive = M.archiveItems(st.answers);
    return { ok: true, now: clock(), open, archive, counts: { open: open.length, questions: open.filter((x) => x.group === "questions").length, other: open.filter((x) => x.group === "other").length, archived: archive.length }, skipped: s.skipped, max: M.MAX_ANSWER };
  }

  async function setKind(args) {
    const id = String((args && args.id) || "");
    const kind = args && args.kind;
    if (kind !== "gonogo" && kind !== "text") return { ok: false, reason: "Unknown kind." };
    if (!M.splitId(id)) return { ok: false, reason: "Unknown item." };
    const st = loadFile();
    st.overrides[id] = kind;
    const keys = Object.keys(st.overrides);
    if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete st.overrides[k];
    save(st);
    return { ok: true };
  }

  const classify = classifyDelivery;

  async function answer(args) {
    const a = args && typeof args === "object" ? args : {};
    const id = String(a.id || "");
    const parts = M.splitId(id);
    if (!parts) return { ok: false, reason: "Unknown item." };
    if (inflight.has(id)) return { ok: false, reason: "This answer is already being sent." };
    inflight.add(id);
    try {
      const st = loadFile();
      const s = await stores();
      const item = M.openItems(s.stores, withMem(st), st.overrides).find((x) => x.id === id);
      if (!item) return { ok: false, reason: "That item is no longer open (answered, closed, or no longer waiting for you). Reload the tab." };
      // v1.78.2: the card must send what it showed; a changed title/detail (or a client without a stamp) is refused
      if (!a.rev || a.rev !== item.rev) return { ok: false, changed: true, reason: "Item changed, reload (the question was edited by the agent after it was shown; nothing was sent)." };
      const kind = item.kind;
      const v = M.validateAnswer(kind, a.answer, a.text);
      if (!v.ok) return v;
      const rootNow = typeof root === "function" ? root() : root;
      if (!rootNow) return { ok: false, reason: "needs-setup" };
      const agentPath = path.join(rootNow, item.agent);
      if (typeof knownAgent === "function" && !knownAgent(agentPath)) return { ok: false, reason: `"${item.agent}" is not a known agent folder, so nothing was sent.` };
      const text = M.messageFor(item, a.answer, a.text, typeof people === "function" ? people() : null);
      let r;
      try { r = await deliver(agentPath, text); } catch (e) { r = { delivered: false, error: e && e.message }; }
      const c = classify(r);
      log(`decisions: ${id} ${a.answer} -> ${c.delivery}${r && r.via ? " via " + r.via : ""}${r && r.error ? " (" + r.error + ")" : ""}`);
      if (c.delivery === "failed") return { ok: false, delivery: "failed", reason: c.reason };
      // delivered: record it (the answer text is kept in the archive)
      const rec = {
        agent: item.agent, taskId: item.taskId, title: item.title, kind, answer: a.answer, text: a.answer === "text" ? String(a.text).trim() : "",
        answeredAt: clock(), delivery: c.delivery, taskUpdated: item.updatedRaw, taskNote: "ok",
      };
      answeredMem.set(id, item.updatedRaw);
      let warning = "";
      // 1) update the fleet task first (so the final record says whether that worked), 2) write the record
      try {
        if (fixtures) { /* test mode: the fixture store is read-only, nothing to update */ }
        else {
          // the FULL old detail (the displayed one is cut at 4000); if too long, its head is cut and its tail kept with the note
          const raw = ((s.stores.find((x) => x && x.agent === item.agent) || {}).items || []).find((it) => it && String(it.id) === item.taskId);
          const old = raw && raw.detail != null ? String(raw.detail) : item.detail;
          const note = `[${new Date(clock()).toISOString().slice(0, 16).replace("T", " ")}] ` + M.taskNoteText(a.answer, a.text, c.delivery, typeof people === "function" ? people() : null);
          const b = M.buildTaskDetail(old, note);
          log(`decisions: ${id} task detail: old ${b.oldLen} chars, kept ${b.keptOld}${b.cut ? " (head cut " + (b.oldLen - b.keptOld) + ")" : ""}, new ${b.detail.length}`);
          await run(["--agent", item.agent, "--update", item.taskId, C.NEEDS_FLAG, "no", "--detail", b.detail]);
        }
      } catch (e) {
        rec.taskNote = "failed";
        warning = "The agent was told, but the fleet task could not be updated (" + String((e && e.message) || e).slice(0, 120) + "). Your answer is kept here.";
        log("decisions: task update failed for " + id + ": " + (e && e.message));
      }
      st.answers[id] = rec;
      try { save(st); } catch (e) {
        warning = (warning ? warning + " " : "") + "The answer could not be saved to the Archive file (" + String((e && e.message) || e).slice(0, 100) + "), but it was delivered. Do not answer again.";
        log("decisions: archive write failed: " + (e && e.message));
      }
      return { ok: true, delivery: c.delivery, warning, item: { id, answeredAt: rec.answeredAt } };
    } finally { inflight.delete(id); }
  }

  return { view, answer, setKind, inflightCount: () => inflight.size, _loadFile: loadFile };
}

module.exports = { createService, fixtureStores, classifyDelivery };
