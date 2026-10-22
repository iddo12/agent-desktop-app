// INTAKE IPC registration (main process). Reads intake_index.jsonl (written by the phone watcher), APPENDS ONLY to intake_approvals.jsonl, and,
// for an item sent to a non-default agent, reads the held note and delivers it through the same verified path as the other panes.
// The folder comes from the configuration layer (intakeDir), never from the renderer. Sealed items carry no text and have no Send-to.
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("./intakeLogic");
const MAX_ARG_CHARS = 6000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_NOTE_BYTES = 64 * 1024;

function init({ ipcMain: raw, getMainWindow, log, cfg, agentPathFor, deliverToAgent, listAgentNames, sentLogPath, now }) {
  const say = typeof log === "function" ? log : () => {};
  const clock = now || (() => new Date().toISOString());
  const handle = (channel, fn) => raw.handle(channel, async (event, arg) => {
    try {
      const w = typeof getMainWindow === "function" ? getMainWindow() : null;
      const wc = w && !(typeof w.isDestroyed === "function" && w.isDestroyed()) ? w.webContents : null;
      if (!wc || !event || event.sender !== wc || !event.senderFrame || event.senderFrame !== wc.mainFrame) { say(channel + " refused: not the main window"); return { ok: false, reason: "Not allowed." }; }
      if (arg !== undefined && arg !== null) { if (typeof arg !== "object" || Array.isArray(arg)) return { ok: false, reason: "Bad request." }; if (JSON.stringify(arg).length > MAX_ARG_CHARS) return { ok: false, reason: "That request is too large." }; }
    } catch (x) { return { ok: false, reason: "Not allowed." }; }
    try { return await fn(arg || {}); } catch (x) { say(channel + " failed: code=" + (x && x.code ? x.code : "unknown")); return { ok: false, reason: "That did not work." }; }
  });

  const dir = () => cfg("intakeDir");
  const indexFile = () => path.join(dir(), "intake_index.jsonl");
  const approvalsFile = () => path.join(dir(), "intake_approvals.jsonl");
  const opts = () => ({ requireVerified: cfg("intakeRequireVerified") === "yes", defaultAgent: cfg("intakeDefaultAgent") || "Personal Assistant" });

  // -> {ok, events} ; a missing file is an empty list. Lines that do not parse are skipped (untrusted-ish input).
  function readJsonl(file) {
    if (!dir()) return { ok: false, reason: "The Intake folder is not set. Open Setup and fill in intakeDir." };
    let text;
    try { if (fs.statSync(file).size > MAX_FILE_BYTES) return { ok: false, reason: "An Intake file is too large." }; text = fs.readFileSync(file, "utf8"); }
    catch (e) { return e && e.code === "ENOENT" ? { ok: true, events: [], empty: true } : { ok: false, reason: "An Intake file could not be read." }; }
    const events = [];
    for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) { if (!line.trim()) continue; try { events.push(JSON.parse(line)); } catch (e) { /* skip */ } }
    return { ok: true, events, empty: false };
  }
  const state = () => {
    const ix = readJsonl(indexFile()); if (!ix.ok) return ix;
    const ap = readJsonl(approvalsFile()); if (!ap.ok) return ap;
    const approvals = L.foldApprovals(ap.events);
    const sent = readSent();
    for (const id of sent) if (approvals[id]) approvals[id] = Object.assign({}, approvals[id], { delivered: true });
    return { ok: true, items: L.foldIndex(ix.events), approvals, empty: ix.empty };
  };
  function readSent() {
    const out = new Set();
    if (!sentLogPath) return out;
    try { for (const line of fs.readFileSync(sentLogPath, "utf8").split(/\r?\n/)) { try { const j = JSON.parse(line); if (j && typeof j.id === "string") out.add(j.id); } catch (e) { /* skip */ } } } catch (e) { /* none yet */ }
    return out;
  }
  const appendLine = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8"); };

  // The list. Sealed rows carry no text at all.
  handle("intake-load", () => {
    const s = state(); if (!s.ok) return s;
    const sum = L.summarize(s.items, s.approvals);
    const rows = sum.rows.map((r) => ({ id: r.id, kind: r.kind, sub: r.sub, status: r.status, tab: r.tab, created: r.created, verified: r.verified, sealed: r.sealed, held: r.held, suggestedAgent: r.suggestedAgent, title: r.title }));
    return { ok: true, counts: sum.counts, rows, empty: !!s.empty, defaultAgent: opts().defaultAgent };
  });
  // one item opened: the held note text, read from inside the Intake folder only
  handle("intake-item", (a) => {
    const s = state(); if (!s.ok) return s;
    const it = s.items.find((x) => x.id === a.id);
    if (!it) return { ok: false, reason: "That item is gone." };
    const st = L.effectiveStatus(it, s.approvals);
    let text = "";
    if (!it.sealed && it.path) text = readNote(it.path) || "";
    return { ok: true, item: Object.assign({}, it, { status: st }), text: text || it.title, message: L.buildMessage(it, text || it.title), defaultAgent: opts().defaultAgent };
  });
  function readNote(p) {
    try {
      const real = fs.realpathSync(p), root = fs.realpathSync(dir());
      if (path.relative(root, real).startsWith("..") || path.isAbsolute(path.relative(root, real))) return null;   // only inside the Intake folder
      if (fs.statSync(real).size > MAX_NOTE_BYTES) return null;
      return fs.readFileSync(real, "utf8");
    } catch (e) { return null; }
  }
  handle("intake-agents", () => ({ ok: true, agents: typeof listAgentNames === "function" ? listAgentNames() : [], defaultAgent: opts().defaultAgent }));
  // action: approve | reject. `agent` other than the default -> AD delivers the held note itself (to_other).
  handle("intake-decide", async (a) => {
    const s = state(); if (!s.ok) return s;
    const it = s.items.find((x) => x.id === a.id);
    const d = L.decide({ action: a.action, to: a.agent }, it, s.approvals, opts(), clock());
    if (!d.ok) return d;
    if (!d.deliver) { appendLine(approvalsFile(), d.record); return { ok: true, sent: false }; }
    const ap = typeof agentPathFor === "function" ? agentPathFor(d.deliver.agent) : null;
    if (!ap) return { ok: false, reason: "That agent was not found." };
    const note = it.path ? readNote(it.path) : null;
    const body = (typeof a.text === "string" && a.text.trim()) ? a.text : (note || it.title);
    appendLine(approvalsFile(), d.record);           // the approval is on record BEFORE anything is delivered
    let res = null;
    try { res = await deliverToAgent(ap, L.buildMessage(it, body)); } catch (e) { res = null; }
    if (res && res.delivered) { if (sentLogPath) { try { appendLine(sentLogPath, { id: it.id, to: d.deliver.agent, at: clock() }); } catch (e) { /* log is best effort */ } } return { ok: true, sent: true }; }
    return { ok: true, sent: false, reason: "Approved, but " + d.deliver.agent + " did not confirm receipt." };
  });
  handle("intake-audit", () => { const ap = readJsonl(approvalsFile()); return ap.ok ? { ok: true, records: ap.events.slice(-100).filter((r) => r && typeof r.id === "string").map((r) => ({ id: r.id, action: r.action, to: r.to || "", at: r.at })) } : ap; });
}

module.exports = { init };
