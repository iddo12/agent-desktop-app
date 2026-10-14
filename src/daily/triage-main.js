// My Daily - Tasks triage service (main process, no electron import: everything is injected so tests can drive it). v1.79.0.
// Reads every open task of the fleet store, groups it (needs the owner / agents' own backlog / ideas), and performs the owner's actions:
// Yes/No/text answers (delivered to the OWNING agent through the same verified path as Decisions, then recorded in the task note and,
// after a confirmed delivery, the needs-owner flag set to no), ask-for-recommendation, snooze (local, <data dir>/triage.json), close with note.
"use strict";
const T = require("./triage-model");
const C = require("./contract");
const D = require("./decisions-model");
const { classifyDelivery } = require("./decisions-main");

const MAX_TEXT = 4000;
const MAX_BULK = 200;
const ASK_COOLDOWN = 10 * 60000;

function fixtureStores(now) {
  const iso = (d) => new Date(now - d * 86400000).toISOString();
  const mk = (id, title, detail, pri, age, tags, needs, upd) => ({ id, title, detail, status: "open", [C.NEEDS_KEY]: !!needs, priority: pri, tags: tags || [], created: iso(age), updated: iso(upd == null ? age : upd), group: null });
  const S = "ASK: Should we deploy Agent Desktop v1.79.0 tonight?\nRECOMMEND: Yes. It passed the sandbox and all tests; rollback is one command.\nWHY IT MATTERS: The Tasks tab is unusable until it ships.";
  return [
    { agent: "Security", items: [
      mk("deploy-v179", "Deploy Agent Desktop v1.79.0", S, 1, 9, ["decision:gonogo"], true, 8),
      mk("pick-hosting", "Which hosting plan for the new site?", "ASK: Which plan do you want, Basic or Pro?\nRECOMMEND: Pro, because the site needs staging.\nWHY IT MATTERS: Launch is blocked until this is chosen.\n\nExtra notes from the agent.", 2, 3, [], true, 1),
      mk("nvidia", "Run the NVIDIA clean-install script", "Needs an admin prompt on the workstation.", 2, 20, [], true, 15),
      mk("s-backlog-1", "Rotate the NAS canary files", "Agent's own job.", 2, 4, [], false),
      mk("s-idea-1", "Idea: a Stream Deck page for backups", "", 3, 6, ["idea"], false),
    ] },
    { agent: "Legal Agent", items: [
      mk("licence-model", "Licence model per tool", "Closed + EULA or open source? Decide when you can.", 2, 2, [], true),
      mk("ok-send", "OK to send the privacy policy update?", "ASK: OK to send the updated privacy policy to the site team?\nRECOMMEND: Yes, the changes are wording only.\nWHY IT MATTERS: GDPR notice is overdue.", 1, 12, [], true, 11),
      mk("l-backlog", "Draft EULA outline", "", 2, 5, [], false),
      mk("l-idea", "Idea: licence badge generator", "", 3, 8, ["idea"], false),
    ] },
  ];
}

function createService({ root, people, file, readStore, writeJsonAtomic, loadStores, deliver, knownAgent, run, now, say, notices, fixtures, path }) {
  const clock = typeof now === "function" ? now : () => Date.now();
  const log = typeof say === "function" ? say : () => {};
  const who = () => (typeof people === "function" ? people() : null);   // display names for messages to agents (never ids)
  const inflight = new Set();
  const fx = { closed: new Set(), needsNo: new Set(), details: new Map() };   // fixture mode: edits live in memory only

  function loadState() {
    const raw = readStore(file, { snoozes: {}, queued: {}, asked: {} }, notices, "Tasks triage");
    const o = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    return { snoozes: o(raw.snoozes), queued: o(raw.queued), asked: o(raw.asked) };
  }
  function saveState(st) {
    const t = clock();
    const cap = (m, n) => { const k = Object.keys(m); if (k.length <= n) return m; const o = {}; for (const key of k.slice(k.length - n)) o[key] = m[key]; return o; };
    writeJsonAtomic(file, { version: 1, snoozes: T.pruneSnoozes(st.snoozes, t), queued: cap(st.queued, 500), asked: cap(st.asked, 1000) });
  }
  async function stores() {
    if (fixtures) {
      const base = fixtureStores(clock());
      for (const s of base) {
        s.items = s.items.filter((it) => !fx.closed.has(D.itemId(s.agent, it.id))).map((it) => {
          const id = D.itemId(s.agent, it.id);
          return Object.assign({}, it, fx.needsNo.has(id) ? { [C.NEEDS_KEY]: false } : {}, fx.details.has(id) ? { detail: fx.details.get(id), updated: new Date(clock()).toISOString() } : {});
        });
      }
      return { stores: base, skipped: 0 };
    }
    const r = await loadStores();
    return { stores: (r && r.stores) || [], skipped: (r && r.skipped) || 0 };
  }
  async function snapshot() {
    const st = loadState();
    const s = await stores();
    const view = T.buildView(s.stores, st, clock());
    return { st, s, view, all: view.needs.concat(view.backlog, view.ideas, view.snoozed) };
  }
  const rawTask = (s, item) => ((s.stores.find((x) => x && x.agent === item.agent) || {}).items || []).find((it) => it && String(it.id) === item.taskId);

  async function view() {
    const { view: v, s } = await snapshot();
    return Object.assign({ ok: true, max: MAX_TEXT, skipped: s.skipped }, v);
  }

  function agentPathFor(item) {
    const rootNow = typeof root === "function" ? root() : root;
    if (!rootNow) return { error: "The agents folder is not set up yet (see Setup), so nothing was sent." };
    const p = path.join(rootNow, item.agent);
    if (typeof knownAgent === "function" && !knownAgent(p)) return { error: `"${item.agent}" is not a known agent folder, so nothing was sent.` };
    return { path: p };
  }
  async function send(item, text) {
    const ap = agentPathFor(item);
    if (ap.error) return { delivery: "failed", reason: ap.error };
    let r;
    try { r = await deliver(ap.path, text); } catch (e) { r = { delivered: false, error: e && e.message }; }
    const c = classifyDelivery(r);
    log(`triage: ${item.id} -> ${c.delivery}${r && r.via ? " via " + r.via : ""}${r && r.error ? " (" + r.error + ")" : ""}`);
    return c;
  }
  async function updateTask(s, item, note, clearNeeds) {
    if (fixtures) {
      const old = (rawTask(s, item) || {}).detail || "";
      fx.details.set(item.id, T.appendNote(old, note).detail);
      if (clearNeeds) fx.needsNo.add(item.id);
      return;
    }
    const raw = rawTask(s, item);
    const b = T.appendNote(raw && raw.detail != null ? String(raw.detail) : "", note);
    log(`triage: ${item.id} task detail: old ${b.oldLen} chars, new ${b.detail.length}${b.cut ? " (middle cut)" : ""}`);
    const args = ["--agent", item.agent, "--update", item.taskId, "--detail", b.detail];
    if (clearNeeds) args.push(C.NEEDS_FLAG, "no");
    await run(args);
  }
  const stamp = () => new Date(clock()).toISOString().slice(0, 16).replace("T", " ");

  // answer: { id, answer: "yes"|"no"|"text", text, rev, clear } -> { ok, delivery, warning }
  async function answer(args) {
    const a = args && typeof args === "object" ? args : {};
    const id = String(a.id || "");
    if (!D.splitId(id)) return { ok: false, reason: "Unknown item." };
    if (inflight.has(id)) return { ok: false, reason: "This is already being sent." };
    inflight.add(id);
    try {
      const { st, s, all } = await snapshot();
      const item = all.find((x) => x.id === id);
      if (!item) return { ok: false, reason: "That task is no longer open. Reload the tab." };
      if (!a.rev || a.rev !== item.rev) return { ok: false, changed: true, reason: "Task changed, reload (the agent edited it after it was shown; nothing was sent)." };
      if (a.answer === "yes" || a.answer === "no") { if (!(item.group === "needs" && item.gonogo)) return { ok: false, reason: "This task is not a yes/no question. Write a note instead." }; }
      else if (a.answer === "text") { const v = T.validateText(a.text, MAX_TEXT); if (!v.ok) return v; }
      else return { ok: false, reason: "Unknown answer." };
      const c = await send(item, T.answerMessage(item, a.answer, a.text, who()));
      if (c.delivery === "failed") return { ok: false, delivery: "failed", reason: c.reason };
      const sent = c.delivery === "sent";
      // the needs-owner flag goes to "no" only after a CONFIRMED delivery: always for yes/no, for text unless the user unticked "clear"
      const clear = sent && item.group === "needs" && (a.answer !== "text" || a.clear !== false);
      let warning = "";
      try { await updateTask(s, item, `[${stamp()}] ` + T.noteFor(a.answer, a.text, c.delivery, who()), clear); }
      catch (e) { warning = "The agent was told, but the fleet task could not be updated (" + String((e && e.message) || e).slice(0, 120) + ")."; log("triage: task update failed for " + id + ": " + (e && e.message)); }
      if (!sent) { st.queued[id] = { at: clock() }; try { saveState(st); } catch (e) { log("triage: state write failed: " + e.message); } }
      return { ok: true, delivery: c.delivery, cleared: clear && !warning, warning };
    } finally { inflight.delete(id); }
  }

  // ask the owning agent for a recommendation (same delivery path); nothing in the task is changed here
  async function askRecommendation(args) {
    const id = String((args && args.id) || "");
    if (!D.splitId(id)) return { ok: false, reason: "Unknown item." };
    if (inflight.has(id)) return { ok: false, reason: "This is already being sent." };
    inflight.add(id);
    try {
      const { st, all } = await snapshot();
      const item = all.find((x) => x.id === id);
      if (!item) return { ok: false, reason: "That task is no longer open. Reload the tab." };
      if (item.structured && item.recommend) return { ok: false, reason: "This task already has a recommendation." };
      if (st.asked[id] && clock() - Number(st.asked[id]) < ASK_COOLDOWN) return { ok: false, reason: "Already asked a few minutes ago." };
      const c = await send(item, T.recommendRequest(item, who()));
      if (c.delivery === "failed") return { ok: false, delivery: "failed", reason: c.reason };
      st.asked[id] = clock();
      let warning = "";
      try { saveState(st); } catch (e) { warning = "Sent, but not saved here (" + String(e.message).slice(0, 80) + ")."; }
      return { ok: true, delivery: c.delivery, warning, askedAt: st.asked[id] };
    } finally { inflight.delete(id); }
  }

  function cleanIds(ids) {
    const out = [];
    for (const i of Array.isArray(ids) ? ids : []) { const x = String(i || ""); if (D.splitId(x) && !out.includes(x)) out.push(x); }
    return out.slice(0, MAX_BULK);
  }
  async function snooze(args) {
    const ids = cleanIds(args && args.ids);
    if (!ids.length) return { ok: false, reason: "Nothing selected." };
    const until = T.snoozeUntil(clock(), args && args.kind);
    if (!until) return { ok: false, reason: "Unknown snooze length." };
    const st = loadState();
    for (const id of ids) st.snoozes[id] = until;
    saveState(st);
    return { ok: true, count: ids.length, until };
  }
  async function unsnooze(args) {
    const ids = cleanIds(args && args.ids);
    const st = loadState();
    for (const id of ids) delete st.snoozes[id];
    saveState(st);
    return { ok: true, count: ids.length };
  }
  // close: ids (1..200) + note. Each closed through tasks.py --close with the note; per-id results.
  async function close(args) {
    const ids = cleanIds(args && args.ids);
    if (!ids.length) return { ok: false, reason: "Nothing selected." };
    const note = ("Closed by " + ((who() || {}).by || "the user") + " via My Daily" + (args && args.note ? ": " + String(args.note).replace(/\s+/g, " ").trim() : "")).slice(0, 900);
    const revs = args && args.revs && typeof args.revs === "object" ? args.revs : {};
    const { all } = await snapshot();
    const results = [];
    for (const id of ids) {
      const item = all.find((x) => x.id === id);
      if (!item) { results.push({ id, ok: false, reason: "no longer open" }); continue; }
      if (!revs[id] || revs[id] !== item.rev) { results.push({ id, ok: false, skipped: true, reason: "changed since shown" }); continue; }   // v1.79.1: same stamp rule as answer()
      if (inflight.has(id)) { results.push({ id, ok: false, reason: "busy" }); continue; }
      inflight.add(id);
      try {
        if (fixtures) fx.closed.add(id); else await run(["--agent", item.agent, "--close", item.taskId, "--note", note]);
        results.push({ id, ok: true });
      } catch (e) { results.push({ id, ok: false, reason: String((e && e.message) || e).slice(0, 120) }); log("triage: close failed for " + id + ": " + (e && e.message)); }
      finally { inflight.delete(id); }
    }
    const st = loadState();
    let touched = false;
    for (const r of results) if (r.ok && (st.snoozes[r.id] || st.queued[r.id])) { delete st.snoozes[r.id]; delete st.queued[r.id]; touched = true; }
    if (touched) { try { saveState(st); } catch (e) { /* closed tasks vanish anyway */ } }
    return { ok: results.every((r) => r.ok), results, closed: results.filter((r) => r.ok).length, skipped: results.filter((r) => r.skipped).length, failed: results.filter((r) => !r.ok && !r.skipped).length };
  }

  return { view, answer, askRecommendation, snooze, unsnooze, close, inflightCount: () => inflight.size };
}

module.exports = { createService, fixtureStores, MAX_TEXT };
