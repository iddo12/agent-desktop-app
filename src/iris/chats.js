// IRIS conversations (v1.126.0, design v3): the plain-language record behind the "Chats" page. One store per install, in
// <userData>\iris\chats.json. Plain Node, no Electron imports, so tests can use it directly.
//
// A message here is what a PERSON would call a message: who said it, to whom, when, and what happened to it. Nothing raw
// (no envelopes, keys or JSON) is ever kept in this file. Message text is kept as sent (it is the conversation); the page draws it
// with textContent only.
//
//   dir        "in" | "out"
//   localAgent the agent on THIS PC that is part of the exchange (null = the person at this PC)
//   remoteAgent the agent on the OTHER PC that is part of it (null = the person there)
//   status     out: queued | needs-approval | sent | failed          in: received | with-agent | for-you | not-delivered
// Display chips are derived (displayStatus), never stored, so they cannot go stale.
const fs = require("fs");
const path = require("path");

const KEEP_PER_PEER = 500;
const KEEP_MS = 30 * 24 * 3600 * 1000;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

class ChatStore {
  constructor({ dir, now }) {
    this.file = path.join(dir, "chats.json");
    this.now = now || (() => Date.now());
    let j = null;
    try { j = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) { /* first run or unreadable: start empty */ }
    this.messages = j && Array.isArray(j.messages) ? j.messages.filter((m) => m && typeof m.id === "string" && typeof m.peerId === "string") : [];
    this.viewedAt = j && j.viewedAt && typeof j.viewedAt === "object" ? j.viewedAt : {};
  }

  _save() { try { atomicWrite(this.file, JSON.stringify({ messages: this.messages, viewedAt: this.viewedAt })); } catch (e) { /* the chat page can be wrong, the transport must not */ } }

  // msg: { id, peerId, thread, dir, localAgent, remoteAgent, text, at(iso), status, reason?, replyTo?, expires?, byHuman? }
  add(msg) {
    if (this.messages.some((m) => m.id === msg.id && m.peerId === msg.peerId)) return false;
    this.messages.push(Object.assign({ localAgent: null, remoteAgent: null, reason: null }, msg));
    this.prune();
    this._save();
    return true;
  }

  get(id) { return this.messages.find((m) => m.id === id) || null; }

  setStatus(id, status, reason) {
    const m = this.get(id);
    if (!m) return false;
    if (m.status === status && (reason == null || m.reason === reason)) return false;
    m.status = status;
    m.reason = reason == null ? null : String(reason).slice(0, 120);
    this._save();
    return true;
  }

  update(id, patch) {
    const m = this.get(id);
    if (!m) return false;
    if (Object.keys(patch).every((k) => m[k] === patch[k])) return false;
    Object.assign(m, patch);
    this._save();
    return true;
  }

  prune() {
    const cutoff = this.now() - KEEP_MS;
    this.messages = this.messages.filter((m) => Date.parse(m.at) > cutoff);
    const per = {};
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const p = this.messages[i].peerId;
      per[p] = (per[p] || 0) + 1;
      if (per[p] > KEEP_PER_PEER) this.messages.splice(i, 1);
    }
  }

  forgetPeer(peerId) {
    this.messages = this.messages.filter((m) => m.peerId !== peerId);
    delete this.viewedAt[peerId];
    this._save();
  }

  markViewed(peerId) { this.viewedAt[peerId] = this.now(); this._save(); }

  unreadCount(peerId) {
    const since = this.viewedAt[peerId] || 0;
    return this.messages.filter((m) => m.peerId === peerId && m.dir === "in" && Date.parse(m.at) > since).length;
  }

  forPeer(peerId) { return this.messages.filter((m) => m.peerId === peerId); }
}

// The chip a person sees on one message, given every message of its thread (oldest first).
//   out: queued -> "queued" (the other PC has not been reached yet) | needs-approval | failed -> "not-delivered"
//        sent   -> "answered" when something came back later in the thread, else "waiting-answer"
//   in : received -> "handing-over" | with-agent -> "answered" if this PC replied later in the thread, else "with-agent"
//        for-you -> "answered" if this PC replied later, else "for-you" | not-delivered -> "not-delivered"
function displayStatus(msg, threadMsgs) {
  const later = (dir) => threadMsgs.some((x) => x.dir === dir && Date.parse(x.at) > Date.parse(msg.at) && x.id !== msg.id);
  if (msg.dir === "out") {
    if (msg.status === "needs-approval") return "needs-approval";
    if (msg.status === "failed") return "not-delivered";
    if (msg.status === "queued") return "queued";
    return later("in") ? "answered" : "waiting-answer";
  }
  if (msg.status === "not-delivered") return "not-delivered";
  if (msg.status === "received") return "handing-over";
  return later("out") ? "answered" : (msg.status === "for-you" ? "for-you" : "with-agent");
}

// Group messages of one peer into conversations (one per thread), newest activity first. Pure.
function threadsOf(messages) {
  const by = new Map();
  for (const m of messages) {
    const k = m.thread || m.id;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(m);
  }
  const out = [];
  for (const [thread, list] of by) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.dir === "in" ? -1 : 1));
    const last = list[list.length - 1];
    const agents = new Set(), theirs = new Set();
    for (const m of list) { if (m.localAgent) agents.add(m.localAgent); if (m.remoteAgent) theirs.add(m.remoteAgent); }
    out.push({
      thread,
      localAgents: [...agents], remoteAgents: [...theirs],
      messages: list.map((m) => Object.assign({ chip: displayStatus(m, list) }, m)),
      last: { at: last.at, text: last.text, dir: last.dir },
      lastChip: displayStatus(last, list),
      needsRetry: list.some((m) => displayStatus(m, list) === "not-delivered" && !m.retried),
    });
  }
  out.sort((a, b) => Date.parse(b.last.at) - Date.parse(a.last.at));
  return out;
}

module.exports = { ChatStore, displayStatus, threadsOf, KEEP_PER_PEER, KEEP_MS };
