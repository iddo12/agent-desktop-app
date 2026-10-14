// Fleet conversations pane (v1.119.0, configurable since v1.121.0): read-only view of the shared file mailbox between this person's
// fleet and another person's agents, plus the reply-file writer. Pure Node (no Electron) so tests/fleetPane.test.js runs it on a temp dir.
//   <mailbox>/<inbox folder>/   notes FROM the other side TO this fleet   (side id "partner", a stored data id, never shown)
//   <mailbox>/<outbox folder>/  notes FROM this fleet TO the other side   (side id "owner",  a stored data id, never shown)
// The two folder names, the two people's names and the role word come from the configuration layer (configure(), called by main from
// appConfig keys exchangeInboxName, exchangeOutboxName, ownerName, partnerName, leadRole); nothing here names a person or a folder.
// The side ids stay as they are: they sit inside item ids that are stored (dismissed questions) and used by tests.
// Light and off the main thread's critical path: everything is fs.promises with at most 8 operations in flight (cloud-synced online-only
// files can stall a read). Only the newest ~300 candidate names per folder are stat'ed (picked from the file-name date prefix); the first 3 KB of
// each is read once and cached by (mtime,size); a re-list costs two readdirs plus a stat of the newest few files unless the fingerprint
// (names + sizes/mtimes of the newest few) changed. Whole bodies are read only when a note is opened. The only write is writeReply.
"use strict";
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const SIDES = { partner: "to_me", owner: "from_me" }; // neutral folder names; replaced in place by configure()
const MAX_FILES = 300, HEAD_BYTES = 3072, BODY_MAX = 200 * 1024, REPLY_MAX = 20000, QUESTION_DAYS = 7, CONC = 8, FP_STATS = 12;

// Names and wording, set once from the configuration (main) and read everywhere in this file. Neutral until configured.
const NAMES = { owner: "", partner: "", role: "" };
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BASE_STOP = ["reply", "re", "received", "result", "results", "update", "request", "report", "note", "notes", "to", "from", "the", "a", "and", "for", "of", "done", "ack", "ok", "fleet", "hello", "answer", "reminder", "please", "check", "findings", "confirm", "draft", "feedback", "your", "with", "this", "that"];
let STOP = new Set(BASE_STOP), WAITING_RE = /\bwaiting (for|on) you|awaiting your/i;
const wordsOf = (x) => String(x || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// o: { inbox, outbox, owner, partner, role } (all optional). Unset names keep neutral wording.
// A mailbox sub-folder name is ONE path segment (defence in depth: the configuration layer checks it too, this is checked again where it is used).
const segmentOk = (v) => typeof v === "string" && !!v && v.length <= 200 && !/[\\/:*?"<>|\0-\x1f]/.test(v) && v.indexOf("..") < 0 && !/^[. ]+$/.test(v) && !/[. ]$/.test(v);
function configure(o) {
  o = o || {};
  const nm = (v) => (typeof v === "string" ? v.trim() : "");
  if (nm(o.inbox) && segmentOk(nm(o.inbox))) SIDES.partner = nm(o.inbox);
  if (nm(o.outbox) && segmentOk(nm(o.outbox))) SIDES.owner = nm(o.outbox);
  NAMES.owner = nm(o.owner); NAMES.partner = nm(o.partner); NAMES.role = nm(o.role);
  const extra = [];
  for (const n of [NAMES.owner, NAMES.partner]) for (const w of wordsOf(n)) extra.push(w, w + "s");
  for (const w of wordsOf(NAMES.role)) extra.push(w);
  STOP = new Set(BASE_STOP.concat(extra));
  const o2 = NAMES.owner ? "|" + esc(NAMES.owner) : "";
  WAITING_RE = new RegExp("\\bwaiting (for|on) (you" + o2 + ")|awaiting (your" + o2 + ")", "i");
}
function settings() { return { inbox: SIDES.partner, outbox: SIDES.owner, owner: NAMES.owner, partner: NAMES.partner, role: NAMES.role }; }
// Wording helpers.
const ownerFleet = () => (NAMES.owner ? NAMES.owner + "'s fleet" : "this fleet");
const partnerLabel = () => NAMES.partner || "the other side";
const partnerLead = () => (NAMES.partner ? NAMES.partner + "'s " + (NAMES.role || "agent") : "the other side");
const ownerFile = () => NAMES.owner.replace(/[^\p{L}\p{N}-]+/gu, "") || "me";

// The mailbox folder: the legacy AGENT_DESKTOP_FLEET_DIR override (sandbox/tests) wins, then the configured folder (cfg may be omitted).
// null = not set up.
function fleetDir(cfg) {
  const e = process.env.AGENT_DESKTOP_FLEET_DIR;
  if (e && e.trim()) return e.trim();
  try { return (cfg && cfg.get && cfg.get("exchangeDir")) || null; } catch (e2) { return null; }
}

// bounded parallel map
async function pmap(list, n, fn) {
  const out = new Array(list.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (next < list.length) { const i = next++; try { out[i] = await fn(list[i], i); } catch (e) { out[i] = undefined; } } }));
  return out;
}

function stripExt(n) { return n.replace(/\.(md|txt)$/i, ""); }
function dateFromName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], 12);
  return Number.isFinite(t) ? t : null;
}
function clean(s, max) { return String(s || "").replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim().slice(0, max || 80); }
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

// Best-effort names from the file name alone: { title, tokens, sender, recipient }. A file-name sender is only believed when it starts
// with a capital letter ("PC-Care_...", "Security_..."); a lower-case first word ("greenery_redirect_plan") is a topic, not a sender.
function parseName(name) {
  const base = stripExt(name).replace(/^\d{4}-\d{2}-\d{2}[_\- ]*/, "");
  const parts = base.split("_").filter(Boolean);
  let recipient = "", sender = "", senderPart = false;
  if (parts.length && /^to-/i.test(parts[0])) recipient = parts.shift().replace(/^to-/i, "").replace(/-/g, " ");
  else if (parts.length > 1 && /^\p{Lu}/u.test(parts[0])) { sender = parts[0].replace(/-/g, " "); senderPart = true; }
  const title = parts.join(" ").replace(/-/g, " ").trim() || base.replace(/[-_]/g, " ").trim() || stripExt(name);
  const topicParts = base.split("_").filter(Boolean).filter((p, i) => !/^to-/i.test(p) && !(i === 0 && senderPart));
  const tokens = topicParts.join(" ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t && !STOP.has(t));
  return { title, tokens, sender, recipient };
}

const ABBR = /(?:^|\s)(?:dr|mr|mrs|ms|prof|vs|etc|st|inc|ltd)$/i;
// cut a header value at the first sentence end (". " not after Dr/Mr/...)
function cutSentence(v) {
  const re = /\.\s+/g; let m;
  while ((m = re.exec(v))) { if (!ABBR.test(v.slice(0, m.index))) return v.slice(0, m.index); }
  return v;
}
// Header lines only: To:/From: at the START of one of the first 8 lines ("To: X. From: Y." on one line is fine). Body text never matches.
function parseHead(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).slice(0, 8);
  let to = "", from = "";
  for (const line of lines) {
    const m = /^[\s>*_#]*(To|From)\**:\**\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), rest = m[2];
    if (key === "to") {
      const f = /\.\s+\**From\**:\**\s*(.*)$/i.exec(rest);
      if (!to) to = clean(f ? rest.slice(0, f.index) : cutSentence(rest), 60).replace(/[.;,]+$/, "");
      if (f && !from) from = clean(cutSentence(f[1]), 60).replace(/[.;,]+$/, "");
    } else if (!from) from = clean(cutSentence(rest), 60).replace(/[.;,]+$/, "");
  }
  return { to, from };
}

// Open-question words (conservative). "No reply needed" always wins, except "no reply needed ... except". '?' inside URLs and in quoted
// ("> ...") lines does not count.
function looksLikeQuestion(text) {
  const s = String(text || "");
  if (/no (reply|answer|action) (is )?needed/i.test(s) && !/no (reply|answer|action) (is )?needed[^.\n]*\bexcept\b/i.test(s)) return false;
  const body = s.split(/\r?\n/).filter((l) => !/^\s*>/.test(l)).join("\n").replace(/\b(?:https?|ftp):\/\/\S+/gi, " ").replace(/\bwww\.\S+/gi, " ");
  return /\?/.test(body) || /please confirm/i.test(body) || WAITING_RE.test(body);
}

const headCache = new Map(); // abs path -> { key, head }
// Returns the head text, or null when the read FAILED (a failure is never cached, so the next listing retries).
async function readHead(abs, st) {
  const key = st.mtimeMs + ":" + st.size, c = headCache.get(abs);
  if (c && c.key === key) return c.head;
  let head;
  try {
    const fh = await fsp.open(abs, "r");
    try { const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size)); const r = await fh.read(buf, 0, buf.length, 0); head = buf.toString("utf8", 0, r.bytesRead); } finally { await fh.close(); }
  } catch (e) { return null; }
  if (headCache.size > 1500) headCache.clear();
  headCache.set(abs, { key, head });
  return head;
}

const dateKey = (n) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(n); return m ? m[1] : ""; };
const byDateDesc = (a, b) => (dateKey(a) < dateKey(b) ? 1 : dateKey(a) > dateKey(b) ? -1 : a < b ? 1 : -1);
// readdir + lstat of the candidates (the newest MAX_FILES by name date, plus undated names), never a stat of every file
async function scanSide(root, side) {
  const dir = path.join(root, SIDES[side]);
  let names;
  try { names = await fsp.readdir(dir); } catch (e) { return null; }
  names = names.filter((n) => !n.startsWith("."));
  const cand = names.filter(dateKey).sort(byDateDesc).slice(0, MAX_FILES).concat(names.filter((n) => !dateKey(n)).slice(0, MAX_FILES));
  const stats = await pmap(cand, CONC, (n) => fsp.lstat(path.join(dir, n)));
  const files = [];
  cand.forEach((n, i) => {
    const st = stats[i]; if (!st || st.isSymbolicLink()) return;
    const isDir = st.isDirectory();
    files.push({ side, name: n, abs: path.join(dir, n), isDir, other: !isDir && !/\.(md|txt)$/i.test(n), mtimeMs: st.mtimeMs, size: st.size });
  });
  return { files, count: names.length };
}

// Thread assignment: two notes belong together when they share 2+ topic tokens (3+ letters/digits, not filler) or have the same
// normalised topic slug; groups are the union of such pairs. Key = hash of the group's first (newest) note's slug/name, so it does not
// depend on list positions or on what else is in the folder.
function assignThreads(files) {
  const pn = files.map((f) => parseName(f.name));
  const toks = pn.map((p) => new Set(p.tokens.filter((t) => t.length >= 3)));
  const slugs = pn.map((p) => p.tokens.join(" "));
  const parent = files.map((_, i) => i), find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
    let shared = 0; for (const t of toks[i]) if (toks[j].has(t)) shared++;
    if (shared >= 2 || (slugs[i] && slugs[i] === slugs[j])) parent[find(j)] = find(i);
  }
  const keyOf = new Map();
  return files.map((f, i) => { const r = find(i); if (!keyOf.has(r)) keyOf.set(r, "t" + hash(slugs[r] || stripExt(files[r].name).toLowerCase())); return keyOf.get(r); });
}

let cache = null; // { root, fp, base }
async function fingerprint(root) {
  const parts = [];
  for (const side of ["partner", "owner"]) {
    const dir = path.join(root, SIDES[side]); let names;
    try { names = await fsp.readdir(dir); } catch (e) { parts.push(side + ":missing"); continue; }
    names = names.filter((n) => !n.startsWith(".")).sort();
    const newest = names.slice().sort(byDateDesc).slice(0, FP_STATS);
    const st = await pmap(newest, CONC, (n) => fsp.lstat(path.join(dir, n)));
    parts.push(side + ":" + names.length + ":" + hash(names.join("|")) + ":" + newest.map((n, i) => n + "@" + (st[i] ? st[i].size + "/" + st[i].mtimeMs : "x")).join(","));
  }
  return parts.join("#");
}

async function build(root) {
  const [a, b] = await Promise.all([scanSide(root, "partner"), scanSide(root, "owner")]);
  if (a === null && b === null) return { found: false, items: [], threads: [], total: 0 };
  let all = ((a && a.files) || []).concat((b && b.files) || []);
  const date = (f) => dateFromName(f.name) || f.mtimeMs;
  all.sort((x, y) => Math.max(date(y), y.mtimeMs) - Math.max(date(x), x.mtimeMs) || (x.name < y.name ? 1 : -1));
  const total = ((a && a.count) || 0) + ((b && b.count) || 0);
  all = all.slice(0, MAX_FILES);
  const heads = await pmap(all, CONC, (f) => (f.isDir || f.other ? "" : readHead(f.abs, f)));
  const keys = assignThreads(all);
  const items = all.map((f, idx) => {
    const pn = parseName(f.name), text = !f.isDir && !f.other, head = heads[idx] == null ? "" : heads[idx];
    const hdr = text ? parseHead(head) : { to: "", from: "" };
    return {
      id: f.side + "/" + f.name, side: f.side, direction: f.side === "partner" ? "from " + partnerLabel() : "to " + partnerLabel(),
      name: f.name, title: pn.title,
      sender: hdr.from || pn.sender || (f.side === "owner" ? ownerFleet() : "unknown"),
      recipient: hdr.to || pn.recipient || "unknown",
      date: dateFromName(f.name) || f.mtimeMs, hasNameDate: dateFromName(f.name) != null, mtimeMs: f.mtimeMs, size: f.size,
      isDir: !!f.isDir, other: !!f.other, threadKey: keys[idx], headFailed: text && heads[idx] == null,
      question: f.side === "partner" && text && looksLikeQuestion(head),
      preview: clean(head.replace(/^#.*\n/, "").replace(/^\s*(To|From):.*\n/gim, ""), 140),
    };
  });
  const map = new Map(), threads = [];
  for (const it of items) {
    let t = map.get(it.threadKey);
    if (!t) { t = { key: it.threadKey, title: it.title, items: [], newest: Math.max(it.date, it.mtimeMs) }; map.set(it.threadKey, t); threads.push(t); }
    t.items.push(it.id);
  }
  return { found: true, items, threads, total };
}

// Is note `later` (this fleet's side) newer than note `n`? Name dates decide only when both are dated AND on different days; the same day
// (or an undated note) falls back to the real file times.
function isNewer(later, n) {
  if (later.hasNameDate && n.hasNameDate && later.date !== n.date) return later.date > n.date;
  return later.mtimeMs > n.mtimeMs;
}

// Whole mailbox listing. opts: { lastSeen (ms), now (ms), force }. Never throws on a missing folder.
async function listMailbox(root, opts) {
  opts = opts || {};
  const now = opts.now || Date.now(), lastSeen = Number(opts.lastSeen) || 0;
  const fp = await fingerprint(root);
  let base;
  if (!opts.force && cache && cache.root === root && cache.fp === fp && !cache.base.items.some((i) => i.headFailed)) base = cache.base;
  else { base = await build(root); cache = { root, fp, base }; }
  if (!base.found) return { ok: true, found: false, dir: root, items: [], threads: [], questions: [], unread: 0, maxPartnerMtime: 0, fp };
  const { items } = base;
  const byId = new Map(items.map((i) => [i.id, i]));
  const threads = base.threads.map((t) => Object.assign({}, t, { count: t.items.length, unread: t.items.filter((id) => { const i = byId.get(id); return i.side === "partner" && i.mtimeMs > lastSeen; }).length }));
  // open questions: EVERY incoming note of a thread that looks like a question, is under 7 days old and has no newer note from this fleet
  const questions = [];
  for (const t of threads) {
    const list = t.items.map((id) => byId.get(id)), owner = list.filter((i) => i.side === "owner" && !i.isDir && !i.other);
    for (const nm of list) {
      if (nm.side !== "partner" || !nm.question || now - nm.date > QUESTION_DAYS * 86400000) continue;
      if (owner.some((i) => isNewer(i, nm))) continue;
      questions.push({ id: nm.id, threadKey: t.key, title: nm.title, sender: nm.sender, date: nm.date, preview: nm.preview });
    }
  }
  questions.sort((x, y) => y.date - x.date);
  const mer = items.filter((i) => i.side === "partner");
  return { ok: true, found: true, dir: root, total: base.total, capped: base.total > items.length, items, threads, questions, unread: mer.filter((i) => i.mtimeMs > lastSeen).length, maxPartnerMtime: mer.reduce((m, i) => Math.max(m, i.mtimeMs), 0), fp };
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
// Open one message: id must be "<side>/<plain file name>"; only a regular file (not a symlink, device or folder) is ever read.
async function readMessage(root, id) {
  const m = /^(partner|owner)\/([^\\/:*?"<>|]+)$/.exec(String(id || ""));
  if (!m || m[2] === "." || m[2] === ".." || m[2].indexOf("\0") >= 0 || RESERVED.test(m[2])) return { ok: false, error: "bad id" };
  const abs = path.join(root, SIDES[m[1]], m[2]);
  try {
    const st = await fsp.lstat(abs);
    if (st.isDirectory()) return { ok: true, id, isDir: true, text: "(This is a folder of attachments; open it in Explorer: " + SIDES[m[1]] + "\\" + m[2] + ")" };
    if (!st.isFile()) return { ok: false, error: "not a regular file" };
    if (!/\.(md|txt)$/i.test(m[2])) return { ok: true, id, text: "(attachment, not shown: " + m[2] + ")" };
    const fh = await fsp.open(abs, "r");
    try { const buf = Buffer.alloc(Math.min(BODY_MAX, st.size)); const r = await fh.read(buf, 0, buf.length, 0); return { ok: true, id, text: buf.toString("utf8", 0, r.bytesRead).replace(/^\uFEFF/, ""), truncated: st.size > BODY_MAX }; } finally { await fh.close(); }
  } catch (e) { return { ok: false, error: "could not read" }; }
}

function slugOf(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "note"; }
function ymd(d) { const p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }

// Write a reply into the outbox folder. Never overwrites ("wx"; a taken name gets -2, -3 ...). Returns { ok, name, id } or { ok:false, error }.
function writeReply(root, o) {
  o = o || {};
  const body = String(o.text || "").replace(/\r\n/g, "\n").trim();
  if (!body) return { ok: false, error: "empty reply" };
  if (body.length > REPLY_MAX) return { ok: false, error: "reply too long" };
  if (!segmentOk(SIDES.owner)) return { ok: false, error: "mailbox folder not found" };
  const dir = path.join(root, SIDES.owner);
  try { if (!fs.statSync(dir).isDirectory()) throw new Error("x"); } catch (e) { return { ok: false, error: "mailbox folder not found" }; }
  const to = clean(o.recipient, 60).replace(/\./g, "") || partnerLead();
  const base = ymd(o.now ? new Date(o.now) : new Date()) + "_" + ownerFile() + "_reply_" + slugOf(o.topic);
  const content = "To: " + to + ". From: " + (NAMES.owner || "this fleet") + " (via Agent Desktop).\n\n" + body + "\n";
  for (let i = 1; i <= 50; i++) {
    const name = base + (i === 1 ? "" : "-" + i) + ".md";
    try { fs.writeFileSync(path.join(dir, name), content, { encoding: "utf8", flag: "wx" }); cache = null; return { ok: true, name, id: "owner/" + name }; }
    catch (e) { if (e.code !== "EEXIST") return { ok: false, error: "could not write" }; }
  }
  return { ok: false, error: "too many files with that name" };
}

module.exports = { configure, settings, fleetDir, listMailbox, readMessage, writeReply, parseName, parseHead, looksLikeQuestion, dateFromName, SIDES, MAX_FILES, _readHead: readHead, _assignThreads: assignThreads, _resetCache: () => { cache = null; headCache.clear(); } };
