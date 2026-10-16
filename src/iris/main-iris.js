// IRIS - main-process wiring (v1.55.0). Loaded from main.js inside try/catch
// like guards-main.js, so a fault here can only disable IRIS, never the app.
//
//   - one IrisService with its data in <userData>\iris (the sandbox has its own
//     userData, so it never sees the live keys; it also uses a different port
//     and pipe name so both instances can run side by side)
//   - iris-* IPC for the Links view (renderer/iris.js)
//   - a local named pipe so the COO (or any tool on this PC) can send through
//     tools/iris.js - guarded by a random token file only this user can read
//   - incoming messages are written to <userData>\iris\inbox\*.md and queued
//     for delivery to the COO agent; the renderer does the actual hand-over
//     because only it knows which agent chats are live.
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { IrisService, DEFAULT_PORT } = require("./service");

const DS = require("../renderer/iris-direct-strings");
const chatsLib = require("./chats");
const gwLib = require("./gateway");

// v1.126.0: hand a framed direct message to one agent through the voice inbox (src/voiceInbox.js, the same door dictation uses).
// The inbox starts / reaches that agent's session, types the text (queued mid-turn when it is busy), applies its own rate limit and
// never-wake list, and writes a result file we read. Returns { ok, reason? }. A result we cannot read in time is "timeout-state-unknown":
// the text may still arrive, so the caller never resends it by itself.
// Review fixes 2026-10-15: (a) never-wake / personal agents are refused here too, whatever the settings say; (b) the full frame is written to
// a private file under <userData>\iris\direct-frames (unique random name, removed after FRAME_KEEP_MS), NOT to %TEMP%, and the text the
// agent receives is a SHORT pointer (under the 500-character long-message limit, so it is typed as it is) that says plainly whose message
// it is and that it is not the owner and not voice dictation.
const FRAME_KEEP_MS = 24 * 3600 * 1000;
const POINTER_MAX = 480;
function cleanLabel(t, n) { return String(t || "").replace(/[^\p{L}\p{N} .'()_-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, n); }
function cleanupFrames(framesDir, now, keepMs) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(framesDir)) {
      const p = path.join(framesDir, f);
      try { if ((now || Date.now()) - fs.statSync(p).mtimeMs > (keepMs || FRAME_KEEP_MS)) { fs.unlinkSync(p); n++; } } catch (e) { /* gone */ }
    }
  } catch (e) { /* no folder yet */ }
  return n;
}
function pointerText({ who, owner, file }) {
  const w = cleanLabel(who, 40) || "A linked person", o = cleanLabel(owner, 40) || "your owner";
  return `[IRIS direct message] ${w} (linked through IRIS) sent you a message. It is NOT from ${o} and it is not voice dictation. Read this file first, it says who ${w} is, what ${w} may ask, and how to reply: "${file}" Don't answer pure thanks or acknowledgements.`.slice(0, POINTER_MAX + 200);
}
function createDirectDelivery({ userData, listAgents, isSensitive, say, now }) {
  const clock = now || Date.now;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const framesDir = path.join(userData, "iris", "direct-frames");
  return async function deliverDirect({ agent, framed, envId, who, owner }) {
    if (typeof isSensitive === "function" && isSensitive(agent)) return { ok: false, reason: "not-available-sensitive-agent" };
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(path.join(userData, "active-agent.json"), "utf8").replace(/^﻿/, "")); } catch (e) { /* not running */ }
    if (!doc || doc.closed || !doc.voiceInbox) return { ok: false, reason: "no-inbox" };
    const dir = doc.inboxDir && fs.existsSync(doc.inboxDir) ? doc.inboxDir : path.join(userData, "voice-inbox");
    const a = listAgents().find((x) => String(x.folderName).toLowerCase() === String(agent).toLowerCase());
    if (!a) return { ok: false, reason: "agent-not-in-list" };
    fs.mkdirSync(framesDir, { recursive: true });
    cleanupFrames(framesDir, clock());
    const file = path.join(framesDir, `${clock().toString(36)}_${crypto.randomBytes(8).toString("hex")}.md`);
    fs.writeFileSync(file, framed, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const id = `iris-${String(envId).slice(0, 40)}-${clock().toString(36)}`;
    const body = { id, agentPath: a.path, text: pointerText({ who, owner, file }), createdAt: clock(), source: "iris" };
    const tmp = path.join(dir, id + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify(body), "utf8");
    fs.renameSync(tmp, path.join(dir, id + ".json"));
    const resultFile = path.join(dir, "processed", id + ".json");
    const until = clock() + 100000;
    while (clock() < until) {
      await sleep(700);
      try {
        const r = JSON.parse(fs.readFileSync(resultFile, "utf8")).result;
        if (r && typeof r === "object") { say(`iris direct: ${r.ok ? "handed to" : "NOT handed to"} ${a.folderName}${r.ok ? "" : " (" + r.reason + ")"}`); return r; }
      } catch (e) { /* not there yet */ }
    }
    return { ok: false, reason: "timeout-state-unknown" };
  };
}

const { createSensitive } = require("./sensitive");
const { isMainWindowCall } = require("./sender");

function init({ ipcMain, app, safeStorage, Notification, getMainWindow, log, testMode, dialog, getLang, ownerName }) {
  const say = typeof log === "function" ? log : () => {};
  const lang = () => { try { return (getLang && getLang()) || "en"; } catch (e) { return "en"; } };
  const dir = path.join(app.getPath("userData"), "iris");
  fs.mkdirSync(dir, { recursive: true });
  const isTest = !!testMode;
  // Random per start and published in the token file (security review
  // 2026-09-25): a fixed, guessable pipe name could be taken first by another
  // process, which tools/iris.js would then hand the token and message to.
  const pipeName = `\\\\.\\pipe\\agent-desktop-iris${isTest ? "-test" : ""}-${crypto.randomBytes(8).toString("hex")}`;
  const toolPath = path.join(__dirname, "..", "..", "tools", "iris.js");

  const canProtect = !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());
  const protect = (s) => (canProtect ? { dpapi: safeStorage.encryptString(s).toString("base64") } : { plain: s });
  const unprotect = (o) => (o.dpapi ? safeStorage.decryptString(Buffer.from(o.dpapi, "base64")) : o.plain);

  // Pending deliveries to the COO survive a restart.
  const pendingFile = path.join(dir, "pending-deliveries.json");
  let pending = [];
  try { pending = JSON.parse(fs.readFileSync(pendingFile, "utf8")); } catch (e) {}
  const savePending = () => { try { fs.writeFileSync(pendingFile, JSON.stringify(pending, null, 2)); } catch (e) {} };

  const push = (channel, payload) => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };

  const agentsNow = () => { try { return require("../agents").listAgents({ noAvatar: true }); } catch (e) { return []; } };
  const personOf = (peer) => (peer && peer.direct && peer.direct.person) || (peer && peer.name) || "";
  const sens = createSensitive({ userData: app.getPath("userData"), roster: agentsNow });
  const isSensitive = (n) => sens.isSensitive(n);
  const reachable = () => agentsNow().filter((x) => gwLib.isAgentName(x.folderName) && !isSensitive(x.folderName));
  const directDelivery = createDirectDelivery({ userData: app.getPath("userData"), listAgents: agentsNow, isSensitive, say });
  const framesDir = path.join(app.getPath("userData"), "iris", "direct-frames");
  cleanupFrames(framesDir);
  const frameTimer = setInterval(() => cleanupFrames(framesDir), 3600 * 1000);
  if (frameTimer.unref) frameTimer.unref();
  const svc = new IrisService({
    dir,
    // Not the hostname: the name travels in the clear during pairing.
    name: isTest ? "Sandbox Agent Desktop" : "Agent Desktop",
    port: undefined,
    // The sandbox stays on loopback: no firewall prompt, nothing reachable from the LAN.
    bindHost: process.env.IRIS_BIND_HOST || (isTest ? "127.0.0.1" : "0.0.0.0"),
    protect,
    unprotect,
    log: (l) => say(l),
    // v1.126.0 direct agent messaging
    // never-wake and personal-data agents are not in these lists at all (review 2026-10-15, HIGH 1)
    resolveAgent: (name) => { const a = reachable().find((x) => String(x.folderName).toLowerCase() === String(name).toLowerCase() || String(x.displayName || "").toLowerCase() === String(name).toLowerCase()); return a ? a.folderName : null; },
    listAgents: () => reachable().map((x) => x.folderName),
    isSensitive,
    ownerName: () => { try { return ownerName ? ownerName() : ""; } catch (e) { return ""; } },
    toolCommand: `node "${toolPath}"${isTest ? " --test" : ""}`,
    deliverDirect: (req) => directDelivery(req),
    notifyChat: (peer, msg) => {
      try {
        if (Notification && Notification.isSupported()) new Notification({ title: DS.fill(DS.pick(lang()).navTitle + " - %p", { p: personOf(peer) }), body: String(msg.text).slice(0, 140) }).show();
      } catch (e) {}
    },
    deliver: (peer, env, framed, inboxFile) => {
      pending.push({ id: env.id, peer: peer.name, peerId: peer.id, type: env.type, inboxFile, at: new Date().toISOString() });
      savePending();
      push("iris-incoming", { count: pending.length });
      try {
        if (Notification && Notification.isSupported()) {
          new Notification({ title: `IRIS: message from ${peer.name}`, body: env.text.slice(0, 140) }).show();
        }
      } catch (e) {}
    },
  });
  if (!fs.existsSync(path.join(dir, "state.json"))) {
    svc.state.port = DEFAULT_PORT + (isTest ? 1 : 0);
    svc._save();
  }
  if (!canProtect) say("iris: safeStorage unavailable - keys stored unencrypted in userData");

  svc.onChange((what) => {
    push("iris-changed", {});
    if (what === "pending-sends") {
      try {
        const n = svc.status().pendingSends.length;
        if (n && Notification && Notification.isSupported()) {
          new Notification({ title: "IRIS: a reply needs your approval", body: `${n} reply${n === 1 ? "" : "ies"} waiting in the Links tab before ${n === 1 ? "it" : "they"} can send.` }).show();
        }
      } catch (e) {}
    }
  });
  if (svc.state.enabled) svc.start().catch((e) => {
    say(`iris start failed: ${e.message}`);
    // 2026-10-06: a second instance that cannot take the port must not leave ITS pipe name behind (tools/iris.js then talked to a dead pipe)
    if (/EADDRINUSE/.test(String(e && e.message)) && prevPipeName) { try { fs.writeFileSync(path.join(dir, "pipe-name"), prevPipeName, "utf8"); } catch (e2) {} }
  });

  const guard = (name, fn) => ipcMain.handle(name, async (event, arg) => {
    if (!isMainWindowCall(event, getMainWindow())) { say(`${name} refused: not the main window`); return { ok: false, reason: "not-allowed" }; }
    try { return await fn(arg || {}); } catch (e) { say(`${name} failed: ${e.message}`); return { ok: false, reason: e.message }; }
  });
  const h = (name, fn) => ipcMain.handle(name, async (event, arg) => {
    try { return await fn(arg || {}); } catch (e) { say(`${name} failed: ${e.message}`); return { ok: false, reason: e.message }; }
  });
  h("iris-status", () => Object.assign(svc.status(), { pendingDeliveries: pending.length, test: isTest, toolCommand: `node "${toolPath}"${isTest ? " --test" : ""}` }));
  // Every call that changes something is accepted from the app's own main window, main frame, only (review 2026-10-15, finding 7):
  // pairing, peer settings, unpair, sending and approving held messages included. Reads stay open to the app's pages.
  guard("iris-set-enabled", ({ on }) => svc.setEnabled(on));
  guard("iris-set-name", ({ name }) => svc.setMyName(name));
  guard("iris-create-invite", () => svc.createInvite());
  guard("iris-cancel-invite", () => svc.cancelInvite());
  guard("iris-join", ({ invite }) => svc.join(invite));
  guard("iris-set-peer", ({ peerId, patch }) => svc.setPeer(peerId, patch || {}));
  guard("iris-unpair", ({ peerId }) => svc.unpair(peerId));
  guard("iris-send", ({ peerId, text, type, replyTo }) => svc.send({ peerId, text, type, replyTo, fromAgent: "user (Links tab)" }));
  guard("iris-approve-send", ({ id }) => svc.approveSend(id));
  guard("iris-reject-send", ({ id }) => svc.rejectSend(id));
  h("iris-log", ({ limit }) => svc.readLog(limit || 200));

  // ---- v1.126.0 Chats page + direct agent access. These calls come from the app window only; an agent has no way to reach them
  // (the local pipe below has no command for settings). Changes that give a peer MORE reach need the native dialog below.
  guard("iris-chats", () => {
    const st = svc.status();
    const DIRECT_EVENTS = new Set(["direct-received", "chat-received", "handed-to-agent", "direct-not-delivered", "direct-queued", "rejected", "send-blocked", "direct-settings-changed", "direct-change-refused", "direct-seal-mismatch", "direct-waiting", "send-pending-approval", "send-approved", "send-rejected", "unpaired"]);
    const activity = svc.readLog(120).filter((e) => DIRECT_EVENTS.has(e.event)).slice(0, 40).map((e) => ({ at: e.at, event: e.event, peer: e.peer || null, agent: e.to || e.agent || null, reason: e.reason || null }));
    return {
      ok: true, lang: lang(), owner: ownerName ? ownerName() : "", test: isTest,
      peers: st.peers.map((p) => ({
        id: p.id, name: p.name, person: (p.direct && p.direct.person) || p.name, paused: p.paused, lastSeen: p.lastSeen,
        direct: p.direct, remoteAgents: p.remoteAgents, unread: p.unreadChats,
        threads: chatsLib.threadsOf(svc.chats.forPeer(p.id)),
      })),
      unlinked: chatsLib.threadsOf(svc.chats.messages.filter((m) => !st.peers.some((p) => p.id === m.peerId))).length,
      myAgents: (typeof svc.opts.listAgents === "function" ? svc.opts.listAgents() : []),
      pendingSends: st.pendingSends, activity,
    };
  });
  guard("iris-chat-send", ({ peerId, toAgent, text, thread }) => {
    if (!String(text || "").trim()) return { ok: false, reason: "empty-text" };
    return svc.sendDirect({ peerId, toAgent, text: String(text), thread: thread || null, byHuman: true });
  });
  guard("iris-chat-retry", ({ id }) => svc.retryMessage(String(id || "")));
  guard("iris-chat-viewed", ({ peerId }) => { svc.chats.markViewed(String(peerId || "")); return { ok: true }; });
  guard("iris-direct-set", async ({ peerId, patch }) => {
    const p = svc._peer(peerId);
    if (!p) return { ok: false, reason: "unknown-peer" };
    const before = gwLib.normalizeDirect(p.direct);
    const next = gwLib.normalizeDirect(Object.assign({}, before, patch || {}));
    const agents = svc.opts.listAgents();
    const needs = gwLib.isWidening(before, next, agents) || (before.enabled && (before.person !== next.person || before.relation !== next.relation));
    if (!needs) return svc.setDirect(peerId, patch || {}, {});
    const S = DS.pick(lang()).dialog;
    const who = next.person || p.name;
    const list = (a) => a.join(", ");
    const reach = next.mode === "only" ? DS.fill(S.only, { l: list(next.allow) || "-" }) : next.deny.length ? DS.fill(S.except, { l: list(next.deny) }) : S.reachAll;
    const detail = [DS.fill(S.body2, { p: who }), DS.fill(S.reach, { p: who, l: reach }), DS.fill(S.capLine, { n: next.dailyCap }), S.stop].join("\n\n");
    const w = getMainWindow();
    if (!dialog || !w || w.isDestroyed()) return { ok: false, reason: "no-dialog" };
    const r = await dialog.showMessageBox(w, { type: "question", title: S.title, message: DS.fill(S.body, { p: who }), detail, buttons: [S.ok, S.cancel], defaultId: 1, cancelId: 1, noLink: true });
    if (r.response !== 0) { svc._audit({ event: "direct-change-refused", peer: peerId, reason: "cancelled-at-dialog" }); return { ok: false, reason: "cancelled" }; }
    return svc.setDirect(peerId, patch || {}, { humanConfirmed: true });
  });
  h("iris-pending", () => pending.map((p) => {
    let text = "";
    try { text = fs.readFileSync(p.inboxFile, "utf8"); } catch (e) {}
    return Object.assign({}, p, { text });
  }));
  // Copy the framed message into the receiving agent's own session folder, which
  // its CLI can always read. userData can be invisible to it: when Agent Desktop
  // is started from inside an MSIX-packaged app (e.g. Claude Desktop), %APPDATA%
  // writes are redirected into that package's private folder - found in the
  // sandbox test, where the COO's Read tool said the inbox file didn't exist.
  h("iris-prepare-delivery", ({ id, agentPath }) => {
    const item = pending.find((p) => p.id === id);
    if (!item) return { ok: false, reason: "unknown-id" };
    // Only a real agent folder from the app's own agent list (security review
    // 2026-09-25: the path comes from the renderer, so never trust it as given).
    let known = [];
    try { known = require("../agents").listAgents().map((a) => path.resolve(a.path).toLowerCase()); } catch (e) {}
    if (!agentPath || !known.includes(path.resolve(String(agentPath)).toLowerCase())) return { ok: false, reason: "not-an-agent" };
    // v1.97.0 (review N1): the folder is created here (mkdirSync below is recursive). It used to be created as a side
    // effect of the 10 s overview; since v1.93.0 only a session start/attach/trust creates it, so a known agent that has
    // never been started must not be refused with "no-session-folder". agentPath is checked against the agent list above.
    const sessionDir = path.join(String(agentPath), ".claude-session");
    const outDir = path.join(sessionDir, "iris-inbox");
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, path.basename(item.inboxFile));
    fs.writeFileSync(out, fs.readFileSync(item.inboxFile, "utf8"), "utf8");
    return { ok: true, file: out };
  });
  h("iris-delivered", ({ id, to }) => {
    const item = pending.find((p) => p.id === id);
    pending = pending.filter((p) => p.id !== id);
    savePending();
    if (item) svc._audit({ event: "handed-to-agent", id, peer: item.peerId, agent: to || null });
    push("iris-incoming", { count: pending.length });
    return { ok: true };
  });

  // ---------------- local pipe for tools/iris.js ----------------
  const tokenFile = path.join(dir, "local-token");
  let token;
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch (e) {}
  if (!token || token.length < 32) {
    token = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(tokenFile, token, { encoding: "utf8", mode: 0o600 });
  }
  let prevPipeName = null;
  try { prevPipeName = fs.readFileSync(path.join(dir, "pipe-name"), "utf8"); } catch (e) {}
  fs.writeFileSync(path.join(dir, "pipe-name"), pipeName, "utf8");
  const pipe = net.createServer((sock) => {
    let buf = "";
    let handled = false; // one command per connection
    sock.setTimeout(15000, () => sock.destroy());
    sock.on("error", () => {});
    sock.on("data", async (d) => {
      if (handled) return;
      buf += d.toString("utf8");
      if (buf.length > 64 * 1024) return sock.destroy();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      let req;
      try { req = JSON.parse(buf.slice(0, nl)); } catch (e) { return sock.destroy(); }
      const tok = Buffer.from(String(req.token || ""));
      const want = Buffer.from(token);
      if (tok.length !== want.length || !crypto.timingSafeEqual(tok, want)) return sock.end(JSON.stringify({ ok: false, reason: "bad-token" }) + "\n");
      let res;
      try {
        if (req.cmd === "reply") {
          // v1.126.0: an agent answers a direct message (thread id from the frame). The service checks it is the addressed agent.
          // The speaking agent is the one the thread was addressed to; a speaker named by the caller is ignored (review fix 8). The thread token carries the peer.
          res = svc.replyToThread({ token: String(req.thread || ""), text: String(req.text || "") });
          if (res.ok) await svc.flushOutbox();
          const item = res.ok && svc.outbox.find((o) => o.env.id === res.id);
          if (item) res.status = item.status;
        } else if (req.cmd === "send" && (req.toAgent || req.toPerson)) {
          res = svc.sendDirect({ peerId: req.to, toAgent: req.toPerson ? "@person" : String(req.toAgent), text: String(req.text || ""), fromAgent: String(req.fromAgent || ""), thread: req.thread || null, byHuman: false });
          if (res.ok && !res.pending) await svc.flushOutbox();
          const item = res.ok && svc.outbox.find((o) => o.env.id === res.id);
          if (item) res.status = item.status;
        } else if (req.cmd === "agents") {
          res = { ok: true, peers: svc.status().peers.map((p) => ({ id: p.id, name: p.name, agents: p.remoteAgents })) };
        } else if (req.cmd === "send") {
          // viaAgent is hard-coded true here, never read from req - the pipe is
          // the agent/CLI path, so every send through it must hold for human
          // approval regardless of whether the agent bothered to set replyTo
          // (security review 2026-10-02, follow-up on finding 1).
          res = svc.send({ peerId: req.to, text: req.text, type: req.type || "info", replyTo: req.replyTo || null, fromAgent: req.fromAgent || "local tool", viaAgent: true });
          if (res.ok) await svc.flushOutbox();
          const item = svc.outbox.find((o) => o.env.id === res.id);
          if (item) res.status = item.status;
        } else if (req.cmd === "peers") {
          res = { ok: true, enabled: svc.state.enabled, peers: svc.status().peers.map((p) => ({ id: p.id, name: p.name, paused: p.paused, lastSeen: p.lastSeen })) };
        } else if (req.cmd === "status") {
          res = Object.assign({ ok: true }, svc.status());
        } else {
          res = { ok: false, reason: "unknown-cmd" };
        }
      } catch (e) {
        res = { ok: false, reason: e.message };
      }
      sock.end(JSON.stringify(res) + "\n");
    });
  });
  pipe.on("error", (e) => say(`iris pipe error: ${e.message}`));
  pipe.listen(pipeName, () => say(`iris local pipe ${pipeName}`));

  app.on("before-quit", () => { try { pipe.close(); } catch (e) {} svc.stop().catch(() => {}); });
  return svc;
}

module.exports = { init, createDirectDelivery, cleanupFrames, pointerText, POINTER_MAX, FRAME_KEEP_MS };
