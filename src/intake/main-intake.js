// INTAKE IPC registration (main process). Reads intake_index.jsonl (written by the phone watcher), APPENDS ONLY to intake_approvals.jsonl, and,
// for an item sent to a non-default agent, reads the held note and delivers it through the same verified path as the other panes.
// The folder comes from the configuration layer (intakeDir), never from the renderer. Sealed items carry no text and have no Send-to.
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("./intakeLogic");
const MAX_ARG_CHARS = 6000;
const MAX_DECIDE_CHARS = 600000;   // intake-message-decide: up to 200 ids and their notes
const MAX_DECIDE_IDS = 200, MAX_NOTE_CHARS = 2000, MAX_THUMB_BYTES = 150 * 1024, MAX_THUMBS = 8, MAX_TRANSCRIPT = 8000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_NOTE_BYTES = 64 * 1024;

function init({ localApprovalsPath, ipcMain: raw, getMainWindow, log, cfg, agentPathFor, deliverToAgent, listAgentNames, sentLogPath, now }) {
  const say = typeof log === "function" ? log : () => {};
  const clock = now || (() => new Date().toISOString());
  const handle = (channel, fn, maxChars) => raw.handle(channel, async (event, arg) => {
    try {
      const w = typeof getMainWindow === "function" ? getMainWindow() : null;
      const wc = w && !(typeof w.isDestroyed === "function" && w.isDestroyed()) ? w.webContents : null;
      if (!wc || !event || event.sender !== wc || !event.senderFrame || event.senderFrame !== wc.mainFrame) { say(channel + " refused: not the main window"); return { ok: false, reason: "Not allowed." }; }
      if (arg !== undefined && arg !== null) { if (typeof arg !== "object" || Array.isArray(arg)) return { ok: false, reason: "Bad request." }; if (JSON.stringify(arg).length > (maxChars || MAX_ARG_CHARS)) return { ok: false, reason: "That request is too large." }; }
    } catch (x) { return { ok: false, reason: "Not allowed." }; }
    try { return await fn(arg || {}); } catch (x) { say(channel + " failed: code=" + (x && x.code ? x.code : "unknown")); return { ok: false, reason: "That did not work." }; }
  });

  const dir = () => cfg("intakeDir");
  const indexFile = () => path.join(dir(), "intake_index.jsonl");
  const approvalsFile = () => path.join(dir(), "intake_approvals.jsonl");
  // The synced file is only the hand-off for the watcher: anyone who can write the sync folder could forge a line in it. AD itself trusts only this local copy.
  const localApprovals = localApprovalsPath || (sentLogPath ? path.join(path.dirname(sentLogPath), "intake_ad_approvals.jsonl") : null);
  const writeApproval = (rec) => { if (localApprovals) appendLine(localApprovals, rec); appendLine(approvalsFile(), rec); };
  const opts = () => ({ requireVerified: cfg("intakeRequireVerified") === "yes", defaultAgent: cfg("intakeDefaultAgent") || "" });

  // -> {ok, events} ; a missing file is an empty list. Lines that do not parse are skipped (untrusted-ish input).
  function readJsonl(file) {
    if (!dir()) return { ok: false, reason: "The Intake folder is not set. Open Setup and fill in intakeDir." };
    let text;
    let fd = null;
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return { ok: false, reason: "An Intake file is a link and was refused." };
      fd = fs.openSync(file, "r");   // one handle for the size check and the read: no stat/read race
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return { ok: false, reason: "An Intake file is too large." };
      const buf = Buffer.alloc(st.size); fs.readSync(fd, buf, 0, st.size, 0); text = buf.toString("utf8");
    } catch (e) { return e && e.code === "ENOENT" ? { ok: true, events: [], empty: true } : { ok: false, reason: "An Intake file could not be read." }; }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* closed */ } } }
    const events = [];
    for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) { if (!line.trim()) continue; try { events.push(JSON.parse(line)); } catch (e) { /* skip */ } }
    return { ok: true, events, empty: false };
  }
  const state = () => {
    const ix = readJsonl(indexFile()); if (!ix.ok) return ix;
    const ap = localApprovals ? readJsonl(localApprovals) : readJsonl(approvalsFile()); if (!ap.ok) return ap;
    const approvals = L.foldApprovals(ap.events);
    const sent = readSent();
    for (const id of sent) if (approvals[id]) approvals[id] = Object.assign({}, approvals[id], { delivered: true });
    const items = L.foldIndex(ix.events);
    const sealedPaths = new Set(); for (const i of items) for (const q of i.sealedPaths || []) sealedPaths.add(noteKey(q));
    for (const it of items) { it.hash = it.sealed ? "" : L.sha256(messageOf(it, sealedPaths)); }
    return { ok: true, items, approvals, empty: ix.empty, sealedPaths };
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
    return { ok: true, counts: sum.counts, rows, empty: !!s.empty, defaultAgent: opts().defaultAgent, requireVerified: opts().requireVerified, synced: isSynced() };
  });
  // one item opened: the held note text, read from inside the Intake folder only
  handle("intake-item", (a) => {
    const s = state(); if (!s.ok) return s;
    const it = s.items.find((x) => x.id === a.id);
    if (!it) return { ok: false, reason: "That item is gone." };
    const st = L.effectiveStatus(it, s.approvals);
    let text = "";
    if (!it.sealed && it.path) text = readNote(it.path, s.sealedPaths) || "";
    return { ok: true, item: { id: it.id, kind: it.kind, sub: it.sub, status: st, sealed: it.sealed }, text: text || it.title, message: L.buildMessage(it, text || it.title), retry: !!(s.approvals[it.id] && s.approvals[it.id].to_other && st === "approved"), hash: it.hash, defaultAgent: opts().defaultAgent };
  });
  // Notes are read ONLY as a plain file name directly inside <intakeDir>/pending_commands (never cwd-relative, never a sealed item's file, never a link).
  const NOTES_SUB = "pending_commands";   // where the phone watcher keeps held notes (the index `path` points there)
  const NOTE_NAME = /^[A-Za-z0-9_.-]+$/;
  const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;   // Windows device names
  const noteKey = (p) => path.basename(String(p || "")).toLowerCase();
  // The watcher puts a fixed "---" header (kind: command) on top of a held note. Only that exact shape is hidden: every line must be an allowlisted
  // key with a short plain value. Anything else in the header means the whole note is shown, so nothing the agent receives is ever hidden from Iddo.
  const META_KEYS = /^(kind|sub|media|source|type):[ \t]*[A-Za-z0-9_-]{1,24}[ \t]*$/;
  function stripMeta(x) {
    const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]{0,200}?)\r?\n---[ \t]*(\r?\n|$)/.exec(x);
    if (!m) return x;
    const hl = m[1].split(/\r?\n/);
    if (hl.length > 5 || !hl.every((l) => META_KEYS.test(l))) return x;
    return x.slice(m[0].length);
  }
  function readNote(p, sealedPaths) {
    try {
      const name = path.basename(String(p || ""));
      if (!NOTE_NAME.test(name) || name.startsWith(".") || /[. ]$/.test(name) || RESERVED.test(name) || (sealedPaths && sealedPaths.has(name.toLowerCase()))) return null;
      const notesDir = path.join(dir(), NOTES_SUB), full = path.join(notesDir, name);
      if (path.isAbsolute(String(p)) && path.dirname(path.resolve(String(p))).toLowerCase() !== path.resolve(notesDir).toLowerCase()) return null;
      if (fs.lstatSync(notesDir).isSymbolicLink() || fs.lstatSync(full).isSymbolicLink()) return null;
      const real = fs.realpathSync(full);
      if (sealedPaths && sealedPaths.has(path.basename(real).toLowerCase())) return null;
      if (path.dirname(real).toLowerCase() !== fs.realpathSync(notesDir).toLowerCase()) return null;
      const fd = fs.openSync(real, "r");
      try {
        const st = fs.fstatSync(fd); if (!st.isFile() || st.size > MAX_NOTE_BYTES) return null;
        // same file by identity (dev+ino), not just by name: Windows name tricks (short names, trailing dots) cannot reach a sealed file
        for (const sn of sealedPaths || []) { try { const ss = fs.statSync(path.join(notesDir, sn)); if (ss.ino && ss.ino === st.ino && ss.dev === st.dev) return null; } catch (e) { /* no such sealed file here */ } } const buf = Buffer.alloc(st.size); fs.readSync(fd, buf, 0, st.size, 0); return stripMeta(buf.toString("utf8")); }
      finally { fs.closeSync(fd); }
    } catch (e) { return null; }
  }
  function messageOf(it, sealedPaths) { const note = it.path ? readNote(it.path, sealedPaths) : null; return L.buildMessage(it, note || it.title); }
  handle("intake-agents", () => ({ ok: true, agents: typeof listAgentNames === "function" ? listAgentNames() : [], defaultAgent: opts().defaultAgent }));
  // action: approve | reject. `agent` other than the default -> AD delivers the held note itself (to_other).
  const inFlight = new Set();   // one decision per id at a time: no double delivery
  handle("intake-decide", async (a) => {
    if (typeof a.id !== "string" || inFlight.has(a.id)) return { ok: false, reason: "That item is already being handled." };
    inFlight.add(a.id);
    try { return await decideOne(a); } finally { inFlight.delete(a.id); }
  });
  async function decideOne(a) {
    const s = state(); if (!s.ok) return s;
    const it = s.items.find((x) => x.id === a.id);
    const d = L.decide({ action: a.action, to: a.agent, hash: a.hash }, it, s.approvals, opts(), clock());
    if (!d.ok) return d;
    if (!d.deliver) {
      if (d.record.action === "approve" && L.effectiveStatus(it, s.approvals) !== "pending_approval" && L.effectiveStatus(it, s.approvals) !== "new") return { ok: false, reason: "Already handled." };
      writeApproval(d.record); return { ok: true, sent: false };
    }
    const ap = typeof agentPathFor === "function" ? agentPathFor(d.deliver.agent) : null;
    if (!ap) return { ok: false, reason: "That agent was not found." };
    const msg = messageOf(it, s.sealedPaths);        // the exact text whose hash was approved
    const again = state();                           // re-check right before writing: the files may have changed under us
    if (!again.ok) return again;
    const it2 = again.items.find((x) => x.id === a.id);
    const st2 = it2 ? L.effectiveStatus(it2, again.approvals) : "";
    if (!it2 || it2.hash !== d.record.hash || (st2 === "approved" && !d.retry) || st2 === "sent") return { ok: false, reason: "This item changed. Open it again to review." };
    if (L.sha256(msg) !== d.record.hash || L.sha256(msg) !== a.hash) return { ok: false, reason: "This item changed. Open it again to review." };   // delivered bytes = approved bytes
    if (!d.retry) writeApproval(d.record);           // the approval is on record BEFORE anything is delivered
    let res = null;
    try { res = await deliverToAgent(ap, msg); } catch (e) { res = null; }
    if (res && res.delivered) { if (sentLogPath) { try { appendLine(sentLogPath, { id: it.id, to: d.deliver.agent, at: clock() }); } catch (e) { /* log is best effort */ } } return { ok: true, sent: true }; }
    return { ok: true, sent: false, reason: "Approved, but " + d.deliver.agent + " did not confirm receipt." };
  }
  // Messages the owner sent from the phone TO an agent (Message-to-Agent). They never pass through intake_index.jsonl: the PC watcher puts each one in
  // <agent folder>\phone_inbox\ and appends to that folder's index.jsonl ({id, at, status:"new", preview}, later {id, status:"handled"}). Read-only here.
  const MSG_MAX_ROWS = 100, MSG_PREVIEW = 300, MSG_STATUS = { new: 1, handled: 1 };
  function readAgentMessages(agent) {
    const ap = typeof agentPathFor === "function" ? agentPathFor(agent) : null;
    if (!ap) return [];
    const file = path.join(ap, "phone_inbox", "index.jsonl");
    let text;
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return [];
      const st = fs.statSync(file); if (!st.isFile() || st.size > MAX_FILE_BYTES) return [];
      text = fs.readFileSync(file, "utf8");
    } catch (e) { return []; }
    const byId = new Map();
    for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch (e) { continue; }
      if (!j || typeof j !== "object" || typeof j.id !== "string" || j.id.length > 80) continue;
      const cur = byId.get(j.id) || { id: j.id, agent, at: "", status: "new", preview: "" };
      if (typeof j.at === "string") cur.at = j.at.slice(0, 40);
      if (typeof j.preview === "string") cur.preview = j.preview.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, MSG_PREVIEW);
      if (typeof j.status === "string" && MSG_STATUS[j.status]) cur.status = j.status;
      byId.set(j.id, cur);
    }
    return [...byId.values()];
  }
  // HELD phone messages (Iddo 2026-10-31): the PC watcher keeps each new message in its own LOCAL folder and lists it in message_held_index.jsonl (status held / approved /
  // rejected). Nothing reaches an agent until a line {id, action, at, note?} is appended to message_approvals.jsonl here. That file must be local: if the Intake folder is
  // inside a synced folder anyone who can write it could approve (or read) messages, so AD refuses to decide and says why.
  // "Synced" = the folder or its real location has a sync-product name in its path, or any parent holds a sync marker file (.dropbox, Syncthing's .stfolder ...).
  const SYNCED_RX = /dropbox|onedrive|google ?drive|icloud|syncthing|box sync/i, SYNC_MARKERS = [".dropbox", ".dropbox.cache", ".stfolder", ".sync"];
  function isSynced() {
    const d = String(dir() || ""); if (!d) return false;
    let real = d; try { real = fs.realpathSync(d); } catch (e) { /* not created yet: judge the given path */ }
    for (const c of new Set([path.resolve(d), real])) {
      if (SYNCED_RX.test(c)) return true;
      for (let cur = c, prev = ""; cur !== prev; prev = cur, cur = path.dirname(cur)) for (const m of SYNC_MARKERS) { try { if (fs.existsSync(path.join(cur, m))) return true; } catch (e) { /* unreadable parent */ } }
    }
    return false;
  }
  const msgApprovalsFile = () => path.join(dir(), "message_approvals.jsonl");
  const ID_RX = /^[A-Za-z0-9_-]{1,80}$/;
  // control characters and every Unicode format character (zero-width, bidi, tag block): invisible text must not reach the person who approves
  const stripCtl = (t, keepNl) => String(t == null ? "" : t).replace(keepNl ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}]/gu : /[\u0000-\u001f\u007f\p{Cf}]/gu, keepNl ? "" : " ");
  const readSmall = (file, max) => { try { if (fs.lstatSync(file).isSymbolicLink()) return null; const st = fs.statSync(file); if (!st.isFile() || st.size > max) return null; return fs.readFileSync(file); } catch (e) { return null; } };
  const AGENT_ID_RX = /^[a-z0-9][a-z0-9-]{0,39}$/;
  const heldDir = (agent, id) => (AGENT_ID_RX.test(String(agent)) && ID_RX.test(String(id)) ? path.join(dir(), "message_held", agent, id) : null);
  const heldState = () => {   // -> {held: Map id -> row (still held), queued: Map id -> action}
    const held = new Map(), queued = new Map();
    if (!dir()) return { held, queued };
    const ix = readJsonl(path.join(dir(), "message_held_index.jsonl"));
    if (!ix.ok) return { held, queued };
    const byId = new Map();
    for (const j of ix.events) { if (j && typeof j === "object" && typeof j.id === "string" && ID_RX.test(j.id)) byId.set(j.id, Object.assign(byId.get(j.id) || {}, j)); }
    for (const [id, j] of byId) {
      if (j.status !== "held" || typeof j.agent !== "string") continue;
      const rawText = String(j.text == null ? "" : j.text), text = stripCtl(rawText, true).slice(0, 4000);
      const row = { id, agent: stripCtl(j.agent).slice(0, 60), at: typeof j.at === "string" ? j.at.slice(0, 40) : "", status: "held", preview: stripCtl(j.preview).slice(0, MSG_PREVIEW),
        text, hidden: !!j.hidden || text !== rawText.slice(0, 4000).replace(/\r/g, ""), voice: !!j.voice, photos: Math.min(99, Number(j.photos) || 0), thumbs: Math.min(MAX_THUMBS, Number(j.thumbs) || 0), video: !!j.video,
        videoName: j.video ? stripCtl(j.video_name).slice(0, 40) : "", videoBytes: j.video ? Math.max(0, Number(j.video_bytes) || 0) : 0, deliveryFailed: !!j.delivery_failed };
      if (row.voice) {   // transcript made by the watcher at hold time: transcript.txt, or transcript.failed, or still pending
        const hd = heldDir(j.agent, id);
        const tb = hd ? readSmall(path.join(hd, "transcript.txt"), MAX_TRANSCRIPT) : null;
        if (tb) { row.transcript = stripCtl(tb.toString("utf8"), true).slice(0, 4000); row.transcriptState = "ready"; }
        else row.transcriptState = hd && fs.existsSync(path.join(hd, "transcript.failed")) ? "failed" : hd && fs.existsSync(path.join(hd, "transcript.waiting")) ? "waiting" : "pending";
      }
      held.set(id, row);
    }
    const ap = readJsonl(msgApprovalsFile());
    if (ap.ok) for (const r of ap.events) if (r && typeof r.id === "string" && held.has(r.id) && (r.action === "approve" || r.action === "reject")) queued.set(r.id, r.action);   // the latest line counts, as in the watcher
    return { held, queued };
  };
  handle("intake-messages", () => {
    const names = typeof listAgentNames === "function" ? listAgentNames() : [];
    let rows = [];
    for (const n of names) rows = rows.concat(readAgentMessages(n));
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const hs = heldState();
    const heldRows = [...hs.held.values()].map((r) => Object.assign(r, hs.queued.has(r.id) ? { queued: hs.queued.get(r.id) } : {}))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));   // ALL held rows, no cut
    const delivered = rows.slice(0, MSG_MAX_ROWS);
    return { ok: true, rows: heldRows.concat(delivered).sort((a, b) => String(b.at).localeCompare(String(a.at))), total: rows.length + hs.held.size, waiting: rows.filter((r) => r.status === "new").length,
      held: heldRows.filter((r) => !r.queued).length, synced: isSynced() };
  });
  // {ids:[...], action: approve|reject, notes?: {id: text}} -> per-id results. Only ids that are held right now and not already decided; one line per id; notes only on approve.
  handle("intake-message-decide", (a) => {
    if (!dir()) return { ok: false, reason: "The Intake folder is not set. Open Setup and fill in intakeDir." };
    if (isSynced()) return { ok: false, reason: "The Intake folder is inside a synced folder (Dropbox, OneDrive or similar), so approving here would not be safe. Move it to a local, unsynced folder in Setup (intakeDir)." };
    if (a.action !== "approve" && a.action !== "reject") return { ok: false, reason: "Bad request." };
    if (!Array.isArray(a.ids) || !a.ids.length || a.ids.length > MAX_DECIDE_IDS) return { ok: false, reason: "Choose between 1 and " + MAX_DECIDE_IDS + " messages." };
    const notes = a.notes && typeof a.notes === "object" && !Array.isArray(a.notes) ? a.notes : {};
    const hs = heldState();
    const seen = new Set(), results = [];
    for (const id of a.ids) {
      if (typeof id !== "string" || !ID_RX.test(id)) { results.push({ id: String(id).slice(0, 20), ok: false, reason: "Bad id." }); continue; }
      if (seen.has(id)) continue;
      seen.add(id);
      if (!hs.held.has(id)) { results.push({ id, ok: false, reason: "Not waiting (already handled or gone)." }); continue; }
      const q = hs.queued.get(id), hr = hs.held.get(id);
      // a decision is waiting for the PC: only a Reject may follow an approval whose delivery failed
      if (q && !(q === "approve" && hr.deliveryFailed && a.action === "reject")) { results.push({ id, ok: false, reason: "Already decided; the PC is processing it." }); continue; }
      const rec = { id, action: a.action, at: clock() };
      const note = a.action === "approve" && typeof notes[id] === "string" ? stripCtl(notes[id], true).trim().slice(0, MAX_NOTE_CHARS) : "";
      if (note) rec.note = note;
      try { appendLine(msgApprovalsFile(), rec); results.push({ id, ok: true, note: !!note }); } catch (e) { results.push({ id, ok: false, reason: "Could not record the decision." }); }
    }
    return { ok: true, action: a.action, results, done: results.filter((r) => r.ok).length };
  }, MAX_DECIDE_CHARS);
  // small preview pictures of ONE held message, made by the watcher (thumbN.jpg); only for an id that is held now; data URLs, each <= 150 KB, JPEG signature checked
  handle("intake-message-thumbs", (a) => {
    if (typeof a.id !== "string" || !ID_RX.test(a.id)) return { ok: false, reason: "Bad request." };
    const row = heldState().held.get(a.id); if (!row) return { ok: false, reason: "Not waiting." };
    const hd = heldDir(row.agent, a.id); if (!hd) return { ok: false, reason: "Bad request." };
    const thumbs = [];
    for (let i = 1; i <= Math.min(row.thumbs || row.photos, MAX_THUMBS); i++) {
      const b = readSmall(path.join(hd, "thumb" + i + ".jpg"), MAX_THUMB_BYTES);
      if (b && b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) thumbs.push("data:image/jpeg;base64," + b.toString("base64"));
    }
    return { ok: true, thumbs };
  });
  handle("intake-audit", () => { const ap = localApprovals ? readJsonl(localApprovals) : readJsonl(approvalsFile()); return ap.ok ? { ok: true, records: ap.events.slice(-100).filter((r) => r && typeof r.id === "string").map((r) => ({ id: r.id, action: r.action, to: r.to || "", at: r.at })) } : ap; });
}

module.exports = { init };
