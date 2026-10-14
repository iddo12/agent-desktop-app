// Fleet TIMELINE (v1.120.0): ONE conversation view of everything between this person's agents and the other person's agents, merged from two sources:
//   "exchange"  the Exchange file mailbox (src/fleetMailbox.js; names + stat + first 3 KB only, bodies are opened lazily with fleet-read)
//   "iris"      the IRIS audit log <userData>\iris\log\YYYY-MM.jsonl (text of 'queued' / 'received' entries; 'delivered' / 'rejected' / 'expired'
//               entries carry no text and are JOINED to the queued entry by id to give the delivery state)
// Pure Node (no Electron) so tests/fleetTimeline.test.js runs it on temp fixtures; no network, no new dependencies.
// Read-only. The data shape leaves room for a future "write into the thread" (every item has source, thread key, peer/recipient), but
// nothing here writes.
// Light: the IRIS log is read only from the tail of the newest 1-3 files (at most 1 MB each) and only the last IRIS_MAX message entries are
// kept; the result is cached by (name,size,mtime) of those files and of peers.json, so an unchanged log costs a few stats.
// "answered" is a best-effort inference: an outgoing message counts as answered when a LATER incoming message exists in the same thread
// (exchange: the mailbox's file-name/topic thread heuristic; IRIS: the same peer). It does not prove the reply is about that message.
"use strict";
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const M = require("./fleetMailbox");

const IRIS_MAX = 200, TAIL_BYTES = 1024 * 1024, TEXT_MAX = 4000, MAX_LOG_FILES = 3;
// Our side's label comes from the configured owner name (fleetMailbox.configure); neutral until set.
const ourSide = () => { const o = M.settings().owner; return o ? o + "'s agents" : "My agents"; };

function irisDir(defaultDir) {
  const e = process.env.AGENT_DESKTOP_IRIS_DIR;
  return e && e.trim() ? e.trim() : defaultDir;
}

// last <=TAIL_BYTES of a file as lines (the first line is dropped when the read started mid-file)
async function tailLines(abs, size) {
  const fh = await fsp.open(abs, "r");
  try {
    const len = Math.min(TAIL_BYTES, size), buf = Buffer.alloc(len);
    const r = await fh.read(buf, 0, len, size - len);
    const lines = buf.toString("utf8", 0, r.bytesRead).split(/\r?\n/);
    if (size > len) lines.shift();
    return lines.filter(Boolean);
  } finally { await fh.close(); }
}

const MSG_START = new Set(["queued", "send-pending-approval", "send-approved"]);
const STATE_OF = { "send-pending-approval": "awaiting-approval", "send-approved": "queued", queued: "queued", delivered: "delivered", rejected: "rejected", expired: "expired", "send-rejected": "declined" };

// entries (oldest first) -> message items
function irisItemsFromEntries(entries, names) {
  const byId = new Map(), out = [];
  for (const e of entries) {
    if (!e || typeof e !== "object" || typeof e.at !== "string") continue;
    const id = typeof e.id === "string" ? e.id : null;
    if (e.event === "received" && e.dir === "in" && id) {
      out.push({ id, dir: "in", peer: String(e.peer || ""), at: e.at, type: e.type, text: String(e.text == null ? "" : e.text), state: "received" });
    } else if (MSG_START.has(e.event) && e.dir !== "in" && id) {
      let it = byId.get(id);
      if (!it) { it = { id, dir: "out", peer: String(e.peer || ""), at: e.at, type: e.type, text: String(e.text == null ? "" : e.text), state: "queued" }; byId.set(id, it); out.push(it); }
      else if (!it.text && e.text) it.text = String(e.text);
      it.state = STATE_OF[e.event];
    } else if (STATE_OF[e.event] && id && byId.has(id) && e.dir !== "in" && String(e.peer || "") === byId.get(id).peer) { // inbound entries (peer-chosen ids) and other peers can never change our message state
      const it = byId.get(id); it.state = STATE_OF[e.event]; it.stateAt = e.at; if (e.reason) it.reason = String(e.reason).slice(0, 80);
    }
  }
  const OUR_SIDE = ourSide();
  return out.map((o) => {
    const peerName = names[o.peer] || (o.peer ? "IRIS peer " + o.peer.slice(0, 6) : "IRIS peer");
    const text = o.text.length > TEXT_MAX ? o.text.slice(0, TEXT_MAX) + "..." : o.text;
    const t = Date.parse(o.at);
    return { id: "iris:" + o.id, source: "iris", dir: o.dir, from: o.dir === "out" ? OUR_SIDE : peerName, to: o.dir === "out" ? peerName : OUR_SIDE,
      at: o.at, atMs: Number.isFinite(t) ? t : 0, subject: (o.type ? o.type + ": " : "") + firstLine(text), text, lazy: false,
      status: o.dir === "out" ? o.state : "received", reason: o.reason, threadKey: "iris-" + (o.peer || "unknown"), threadTitle: "IRIS: " + peerName };
  });
}
function firstLine(s) { return String(s || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "(empty)"; }

// per-file parse cache (size+mtime) and a cheap substring test so noise lines (frame-dropped ...) are never JSON.parsed
const RELEVANT = /"event":"(?:queued|received|delivered|rejected|expired|send-)/;
const fileCache = new Map();
function parseCached(abs, st, lines) {
  const key = st.size + ":" + st.mtimeMs, c = fileCache.get(abs);
  if (c && c.key === key) return c.parsed;
  const parsed = []; for (const l of lines) { if (!RELEVANT.test(l)) continue; try { parsed.push(JSON.parse(l)); } catch (e) { /* torn line */ } }
  if (fileCache.size > 8) fileCache.clear();
  fileCache.set(abs, { key, parsed }); return parsed;
}
let irisCache = null; // { dir, sig, items }
async function readIris(dir) {
  if (!dir) return { items: [], sig: "none" };
  const logDir = path.join(dir, "log");
  let names;
  try { names = (await fsp.readdir(logDir)).filter((f) => /\.jsonl$/i.test(f)).sort(); } catch (e) { names = []; }
  const files = names.slice(-MAX_LOG_FILES);
  const stats = await Promise.all(files.map((f) => fsp.stat(path.join(logDir, f)).catch(() => null)));
  let pst = null; try { pst = await fsp.stat(path.join(dir, "peers.json")); } catch (e) { /* none */ }
  const sig = files.map((f, i) => f + ":" + (stats[i] ? stats[i].size + "/" + stats[i].mtimeMs : "x")).join(",") + "|" + (pst ? pst.size + "/" + pst.mtimeMs : "nopeers");
  if (irisCache && irisCache.dir === dir && irisCache.sig === sig) return irisCache;
  const peerNames = Object.create(null);
  if (pst && pst.size < 1024 * 1024) {
    try { const p = JSON.parse(await fsp.readFile(path.join(dir, "peers.json"), "utf8")); for (const [id, v] of Object.entries(p || {})) if (id !== "__proto__" && v && typeof v.name === "string") peerNames[id] = v.name.slice(0, 60); } catch (e) { /* ignore */ }
  }
  // newest file first until enough message entries; entries are then put back oldest-first
  let entries = [], msgCount = 0;
  for (let i = files.length - 1; i >= 0 && msgCount < IRIS_MAX; i--) {
    if (!stats[i]) continue;
    let lines; try { lines = await tailLines(path.join(logDir, files[i]), stats[i].size); } catch (e) { continue; }
    const parsed = parseCached(path.join(logDir, files[i]), stats[i], lines);
    entries = parsed.concat(entries);
    msgCount = entries.filter((e) => e && (e.event === "received" || MSG_START.has(e.event))).length;
  }
  let items = irisItemsFromEntries(entries, peerNames);
  if (items.length > IRIS_MAX) items = items.slice(-IRIS_MAX);
  irisCache = { dir, sig, items };
  return irisCache;
}

// exchange listing items -> timeline items
function exchangeItems(list) {
  return list.items.map((i) => {
    const atMs = i.hasNameDate && Math.abs(i.date - i.mtimeMs) > 2 * 86400000 ? i.date : i.mtimeMs; // a copied-in old note keeps its name date
    const att = i.isDir || i.other;
    return { id: "exchange:" + i.id, source: "exchange", rawId: i.id, dir: i.side === "partner" ? "in" : "out", from: i.sender, to: i.recipient,
      at: new Date(atMs).toISOString(), atMs, subject: i.title, text: att ? "(attachment: " + i.name + ")" : i.preview, lazy: !att, attachment: att,
      status: i.side === "owner" ? "in-mailbox" : "received", question: !!i.question, threadKey: i.threadKey, threadTitle: i.title, mtimeMs: i.mtimeMs };
  });
}

// Build threads + the answered inference. Items inside a thread oldest-first; threads newest-first.
function mergeTimeline(exItems, irItems) {
  const items = exItems.concat(irItems), tmap = new Map(), threads = [];
  for (const it of items) {
    let t = tmap.get(it.threadKey);
    if (!t) { t = { key: it.threadKey, title: it.threadTitle, source: it.source, list: [] }; tmap.set(it.threadKey, t); threads.push(t); }
    t.list.push(it);
  }
  for (const t of threads) {
    t.list.sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : 1));
    // best title: the newest note's title (exchange) - the first note is only a guess at the topic
    for (const it of t.list) {
      if (it.dir !== "out" || it.attachment) continue;
      const reply = t.list.find((o) => o.dir === "in" && !o.attachment && o.atMs > it.atMs);
      it.answeredAt = reply ? reply.atMs : null; it.answeredBy = reply ? reply.from : null;
    }
    const lastOut = [...t.list].reverse().find((o) => o.dir === "out" && !o.attachment);
    t.waiting = !!(lastOut && lastOut.answeredAt == null && lastOut.status !== "declined");
    t.newestMs = t.list[t.list.length - 1].atMs;
    t.hasIn = t.list.some((o) => o.dir === "in");
    t.hasOut = t.list.some((o) => o.dir === "out");
  }
  threads.sort((a, b) => b.newestMs - a.newestMs);
  const flat = [], tOut = threads.map((t) => ({ key: t.key, title: t.title, source: t.source, newestMs: t.newestMs, waiting: t.waiting, items: t.list.map((x) => x.id), count: t.list.length }));
  for (const t of threads) for (const it of t.list) flat.push(it);
  return { items: flat, threads: tOut };
}

// opts: { lastSeen, force, irisDir }. Never throws on missing folders.
async function listTimeline(root, opts) {
  opts = opts || {};
  const lastSeen = Number(opts.lastSeen) || 0;
  const ex = await M.listMailbox(root, { lastSeen, force: !!opts.force, now: opts.now });
  let ir = { items: [], sig: "none" };
  try { ir = await readIris(opts.irisDir); } catch (e) { /* IRIS log unreadable: the file mailbox still shows */ }
  const merged = mergeTimeline(ex.found ? exchangeItems(ex) : [], ir.items);
  const irisIn = ir.items.filter((i) => i.dir === "in");
  const irisUnread = irisIn.filter((i) => i.atMs > lastSeen).length;
  const found = !!ex.found || ir.items.length > 0;
  return {
    ok: true, found, exchangeFound: !!ex.found, dir: root, total: ex.total || 0, capped: !!ex.capped,
    items: merged.items, threads: merged.threads, questions: ex.questions || [],
    unread: (ex.unread || 0) + irisUnread,
    maxPartnerMtime: Math.max(ex.maxPartnerMtime || 0, irisIn.reduce((m, i) => Math.max(m, i.atMs), 0)),
    irisCount: ir.items.length, fp: (ex.fp || "") + "#" + ir.sig,
  };
}

module.exports = { listTimeline, readIris, irisItemsFromEntries, mergeTimeline, irisDir, IRIS_MAX, TEXT_MAX, _reset: () => { irisCache = null; fileCache.clear(); } };
