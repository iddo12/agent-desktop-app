// My Daily - e-mail over IMAP with an app password (READ-ONLY). The person enters only an e-mail address and an app password:
// no Google project, no developer, no OAuth. Same output shape as gmail.js / mailfeed.js (needAnswer / sentNoReply) so the
// sources merge and de-duplicate by Message-ID.
//
// What this module may do on the mail server, and nothing else: connect over TLS (certificate always verified), LOGIN,
// LIST (to find the Sent folder), EXAMINE (read-only select), SEARCH, FETCH of headers with BODY.PEEK (so nothing is marked
// read), LOGOUT. It never sends STORE, EXPUNGE, APPEND, COPY, MOVE, DELETE, CREATE or RENAME, and has no SMTP. The password
// is kept only on this PC, encrypted with the OS (Electron safeStorage = Windows DPAPI), never in a synced folder, never sent to the
// renderer, never logged. If the PC cannot encrypt, the account is refused instead of being stored in plain text.
const fs = require("fs");
const path = require("path");
const { normId } = require("./mailfeed");
const { classifyThread } = require("./gmail");

const DAY = 86400000;
const MAX_ACCOUNTS = 4;
const FRESH_MS = 5 * 60 * 1000;
const INBOX_DAYS = 14;
const SENT_DAYS = 45;
const MAX_INBOX = 300;      // newest messages looked at per run
const MAX_SENT = 150;
const CMD_TIMEOUT_MS = 30000;
const ACCOUNT_DEADLINE_MS = 20000;       // one account's whole connect + read, then the socket is closed
const LOAD_DEADLINE_MS = 20000;          // the most a pane load waits for the servers
const FAIL_BACKOFF_MS = 15 * 60 * 1000;  // after a failed refresh (wrong password, offline) do not try again for this long
const FORCE_MIN_MS = 60 * 1000;          // even "refresh now" never retries one account more often than this
const HEADER_FIELDS = ["From", "To", "Subject", "Date", "Message-ID", "References", "In-Reply-To", "List-Unsubscribe", "Precedence", "Auto-Submitted"];

const PROVIDERS = JSON.parse(fs.readFileSync(path.join(__dirname, "imap-providers.json"), "utf8"));
const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const validEmail = (s) => /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(String(s || "").trim());

// Pure: which provider (host, port, help page) for an address. Unknown domains -> { id: "other", host: "" } and the UI asks.
function providerFor(email) {
  const domain = String(email || "").split("@")[1];
  const d = String(domain || "").trim().toLowerCase();
  for (const p of PROVIDERS.providers) if (p.domains.includes(d)) return Object.assign({}, p, { domain: d });
  return { id: "other", name: d || "", host: "", port: 993, domain: d, domains: [], steps: { en: [], he: [] } };
}

// Pure: the help text the Add dialog shows (3 steps in English and Hebrew, the honesty note, the provider's page).
function helpFor(email) {
  const p = providerFor(email);
  const steps = p.id === "other" ? PROVIDERS.other.steps : p.steps;
  return { provider: p.id, name: p.name, host: p.host, port: p.port, helpUrl: p.helpUrl || "", steps, honesty: PROVIDERS.honesty };
}

// Pure: a mail server name we accept for an address on an unknown domain: a real host name, not this PC or the local network.
function hostAllowed(h) {
  h = String(h || "").trim().toLowerCase();
  if (!h || !/^[a-z0-9.-]+$/.test(h) || h.length > 120) return false;
  if (h === "localhost" || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(h) || !h.includes(".")) return false;
  if (/^[0-9.]+$/.test(h)) return false;   // no IP literals: real mail servers have names, and this keeps the app from probing the LAN
  return true;
}
const clampPort = (n) => { n = Number(n); return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 993; };

// Pure: map an error from the IMAP library to a plain sentence for the person (never contains the password).
function explainError(e, provider) {
  const text = clean((e && (e.responseText || e.response || e.message)) || "", 300);
  const code = e && e.code;
  if (code === "EDEPMISSING") return "The e-mail component is being installed - Agent Desktop does it by itself after an update. Try again in a few minutes (a restart may be needed).";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Cannot find the mail server. Check the address, and that this PC is online.";
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ECONNRESET" || /timeout|timed out/i.test(text)) return "The mail server did not answer. Check that this PC is online, or the server name and port.";
  if (/^(CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT)/.test(String(code || "")) || /certificate|self.signed/i.test(text)) return "The mail server's security certificate was not accepted, so nothing was sent to it.";
  if (/application.specific password|app.?password|web login required|two.?step|2-?step/i.test(text)) return "This provider needs an app password, not your normal password. Use the \"How do I get this password?\" steps.";
  if (/imap.*(disabled|not enabled|access)|not enabled for imap/i.test(text)) return "IMAP is switched off for this mailbox. Turn on IMAP in the mail settings, then try again.";
  if (e && (e.authenticationFailed || /auth|login|invalid credentials|password/i.test(text))) {
    const hint = provider && provider.id === "outlook" ? " Many Outlook.com and Microsoft 365 accounts do not allow app passwords over IMAP any more." : "";
    return "The server did not accept the address or password. Check them (for an app password, copy it again)." + hint;
  }
  return "Could not connect to the mail server" + (text ? " (" + text.slice(0, 120) + ")" : "") + ".";
}

// Raw header block -> map of lower-cased name -> value (unfolded, RFC 2047 words decoded).
function parseHeaders(buf) {
  let decode = (s) => s;
  try { const libmime = require("libmime"); decode = (s) => libmime.decodeWords(s); } catch (e) { /* undecoded subjects are still readable */ }
  const text = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
  const out = {};
  for (const block of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = block.indexOf(":");
    if (i < 1) continue;
    const k = block.slice(0, i).trim().toLowerCase();
    if (!(k in out)) out[k] = decode(block.slice(i + 1).trim());
  }
  return out;
}

// Pure: one fetched message -> the Gmail "thread message" shape that classifyThread understands.
function toGmailShape(m, inSent) {
  const h = m.headers || {};
  const headers = [];
  for (const f of HEADER_FIELDS) { const v = h[f.toLowerCase()]; if (v) headers.push({ name: f, value: v }); }
  const labels = [];
  if (inSent) labels.push("SENT"); else labels.push("INBOX");
  if (!m.seen && !inSent) labels.push("UNREAD");
  if (m.flagged) labels.push("IMPORTANT");
  const t = m.internalDate instanceof Date ? m.internalDate.getTime() : Date.parse(m.internalDate || h.date || "");
  return { id: String(m.id), internalDate: String(Number.isFinite(t) ? t : ""), labelIds: labels, payload: { headers }, _refs: [h["message-id"], h["in-reply-to"], h["references"]].join(" ") };
}

// Pure: group messages into conversations (shared Message-ID / References / In-Reply-To, else same subject without Re:/Fwd:),
// oldest first inside each group. Returns [{ messages }].
function groupThreads(msgs) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const subjOf = (m) => {
    const s = (m.payload.headers.find((h) => h.name === "Subject") || {}).value || "";
    return clean(s, 200).toLowerCase().replace(/^((re|fwd?|aw|sv|vs|ר?תגובה|הועבר)\s*:\s*)+/i, "").trim();
  };
  msgs.forEach((m, i) => {
    const key = "m" + i;
    parent.set(key, parent.get(key) || key);
    for (const id of String(m._refs || "").match(/<[^>\s]+>/g) || []) union(key, "id:" + normId(id));
    const s = subjOf(m);
    if (s.length >= 4) union(key, "s:" + s);
  });
  const groups = new Map();
  msgs.forEach((m, i) => { const r = find("m" + i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(m); });
  return [...groups.values()].map((g) => ({ messages: g.sort((a, b) => Number(a.internalDate) - Number(b.internalDate)) }));
}

// Pure: both folders' messages -> the same lists gmail.js produces.
function classifyAll(inbox, sent, me, now) {
  const all = inbox.map((m) => toGmailShape(m, false)).concat(sent.map((m) => toGmailShape(m, true)));
  const items = { needAnswer: [], sentNoReply: [] };
  for (const th of groupThreads(all)) {
    const c = classifyThread(th, me, now);
    if (c.kind && items[c.kind]) items[c.kind].push(Object.assign({ account: me, owner: "Personal Assistant" }, c));
  }
  return items;
}

function create({ dataDir, safeStorage, log, imapClass, connectOverride }) {
  const say = typeof log === "function" ? log : () => {};
  const file = path.join(dataDir, "imap-accounts.bin");
  const cache = new Map();   // email -> { at, items, error }
  let busy = false;
  const inflight = new Map();   // email -> the one running refresh (shared, so two callers never log in twice)

  const canEncrypt = () => { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; } };
  // { list, unreadable }: a missing file is just "no accounts"; a file that exists but cannot be decrypted or parsed is "unreadable",
  // and then nothing may overwrite it (a later Add would silently destroy the other accounts).
  function readState() {
    let raw;
    try { raw = fs.readFileSync(file); } catch (e) { return e && e.code === "ENOENT" ? { list: [], unreadable: false } : { list: [], unreadable: true }; }
    try {
      const v = JSON.parse(canEncrypt() ? safeStorage.decryptString(raw) : "");
      return { list: (Array.isArray(v.accounts) ? v.accounts : []).filter((a) => a && validEmail(a.email) && typeof a.password === "string" && typeof a.host === "string").slice(0, MAX_ACCOUNTS), unreadable: false };
    } catch (e) { return { list: [], unreadable: true }; }
  }
  const readAccounts = () => readState().list;
  const UNREADABLE = "The stored e-mail accounts cannot be read on this PC (the file is damaged or was made by another Windows user). Nothing was changed. Ask for help before adding or removing accounts.";
  // Run fn(client) with a hard overall deadline; the socket is always closed afterwards.
  async function withClient(a, fn) {
    const client = open(a);
    client.on("error", (e) => say("imap socket error: " + clean(e && e.code, 40)));
    let timer;
    const deadline = new Promise((_, rej) => { timer = setTimeout(() => { try { client.close(); } catch (e) { /* gone */ } const err = new Error("timed out"); err.code = "ETIMEDOUT"; rej(err); }, ACCOUNT_DEADLINE_MS); });
    try { return await Promise.race([fn(client), deadline]); }
    finally { clearTimeout(timer); try { client.close(); } catch (e) { /* already closed */ } }
  }
  function writeAccounts(list) {
    if (!canEncrypt()) throw new Error("This PC cannot encrypt the password, so it will not be stored.");
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + ".tmp";
    try { fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify({ accounts: list }))); fs.renameSync(tmp, file); }
    catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* nothing */ } throw e; }
  }

  // v1.119.1: imapflow is an optionalDependency, loaded only when an account is actually used. If it is not installed yet
  // (the in-app updater / start-up check installs it by itself) this throws a clear, catchable error instead of crashing.
  const ImapFlow = () => {
    if (imapClass) return imapClass;
    try { return require("imapflow").ImapFlow; }
    catch (e) { const err = new Error("The e-mail component is not installed yet"); err.code = "EDEPMISSING"; throw err; }
  };
  function open(a) {
    const Client = ImapFlow();
    const opts = Object.assign({
      host: a.host, port: a.port || 993, secure: true, auth: { user: a.email, pass: a.password },
      logger: false, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      connectionTimeout: CMD_TIMEOUT_MS, greetingTimeout: CMD_TIMEOUT_MS, socketTimeout: 120000, disableAutoIdle: true,
    }, connectOverride || {});
    return new Client(opts);
  }
  async function readFolder(client, folder, days, max, now) {
    const lock = await client.getMailboxLock(folder, { readOnly: true });   // EXAMINE, never SELECT
    try {
      const uids = await client.search({ since: new Date(now - days * DAY) }, { uid: true });
      const take = (uids || []).slice(-max);
      const out = [];
      if (!take.length) return out;
      for await (const m of client.fetch(take, { uid: true, flags: true, internalDate: true, headers: HEADER_FIELDS.map((x) => x.toLowerCase()) }, { uid: true })) {
        out.push({ id: folder + ":" + m.uid, seen: m.flags && m.flags.has("\\Seen"), flagged: m.flags && m.flags.has("\\Flagged"), internalDate: m.internalDate, headers: parseHeaders(m.headers) });
      }
      return out;
    } finally { lock.release(); }
  }
  function fetchAccount(a, now) {
    return withClient(a, async (client) => {
      await client.connect();
      try {
        let sentPath = null;
        for (const box of await client.list()) { if (box.specialUse === "\\Sent") { sentPath = box.path; break; } }
        if (!sentPath) for (const box of await client.list()) { if (/^(sent|sent items|sent mail|\[gmail\]\/sent mail|נשלח|פריטים שנשלחו)$/i.test(box.path)) { sentPath = box.path; break; } }
        const inbox = await readFolder(client, "INBOX", INBOX_DAYS, MAX_INBOX, now);
        const sent = sentPath ? await readFolder(client, sentPath, SENT_DAYS, MAX_SENT, now) : [];
        return classifyAll(inbox, sent, a.email, now);
      } finally { try { await client.logout(); } catch (e) { /* the deadline wrapper closes the socket */ } }
    });
  }

  // Connect + EXAMINE INBOX + log out, WITHOUT saving anything: the "Test connection" button and the first step of Add.
  async function testConnection({ email, password, host, port }) {
    email = clean(email, 120).toLowerCase();
    if (!validEmail(email)) return { ok: false, reason: "That does not look like an e-mail address." };
    if (!password) return { ok: false, reason: "Enter the app password." };
    const p = providerFor(email);
    // A known provider always uses its own listed server and port: the renderer cannot redirect the password elsewhere.
    const known = p.id !== "other";
    const a = { email, password: String(password), host: known ? p.host : clean(host, 120).toLowerCase(), port: known ? (p.port || 993) : clampPort(port || p.port) };
    if (!a.host || !hostAllowed(a.host)) return { ok: false, reason: "Enter the mail server name (for example imap.example.com). It must be a real server name, not this PC or the local network.", needHost: true };
    try {
      await withClient(a, async (client) => {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX", { readOnly: true });
        lock.release();
        try { await client.logout(); } catch (e) { /* closed by the wrapper */ }
      });
      return { ok: true, account: a, provider: p.id };
    } catch (e) { return { ok: false, reason: explainError(e, p) }; }
  }

  async function addAccount(args) {
    if (busy) return { ok: false, reason: "Another sign-in is in progress." };
    if (!canEncrypt()) return { ok: false, reason: "This PC cannot encrypt the password, so the account was not added." };
    if (readState().unreadable) return { ok: false, reason: UNREADABLE };
    if (readAccounts().filter((x) => x.email !== clean(args && args.email, 120).toLowerCase()).length >= MAX_ACCOUNTS) return { ok: false, reason: "At most " + MAX_ACCOUNTS + " e-mail accounts." };
    busy = true;
    try {
      const t = await testConnection(args || {});
      if (!t.ok) return t;
      const st = readState();
      if (st.unreadable) return { ok: false, reason: UNREADABLE };
      const list = st.list.filter((x) => x.email !== t.account.email);
      list.push(Object.assign({}, t.account, { added: Date.now() }));
      writeAccounts(list);
      cache.delete(t.account.email);
      return { ok: true, email: t.account.email };
    } catch (e) { return { ok: false, reason: clean(e && e.message, 200) }; }
    finally { busy = false; }
  }

  return {
    providerFor, helpFor, testConnection, addAccount,
    configured: () => true,
    unreadable: () => readState().unreadable,
    list: () => readAccounts().map((a) => { const c = cache.get(a.email) || {}; return { email: a.email, host: a.host, ok: !!c.at && !c.error, error: c.error || "", needAnswer: c.items ? c.items.needAnswer.length : 0, sentNoReply: c.items ? c.items.sentNoReply.length : 0 }; }),
    remove(email) {
      const e = String(email || "").toLowerCase();
      const st = readState();
      if (st.unreadable) return { ok: false, reason: UNREADABLE };
      const list = st.list;
      const keep = list.filter((a) => a.email !== e);
      if (keep.length === list.length) return { ok: false, reason: "No such account." };
      if (keep.length) writeAccounts(keep); else { try { fs.unlinkSync(file); } catch (e2) { /* already gone */ } }
      cache.delete(e);
      return { ok: true };
    },
    // -> { connected, accounts:[email], emails:{needAnswer,sentNoReply}, updatedAt }
    async load(now, opts) {
      const st = readState();
      const accts = st.list;
      if (st.unreadable) return { connected: false, accounts: [], emails: { needAnswer: [], sentNoReply: [] }, error: UNREADABLE };
      if (!accts.length) return { connected: false, accounts: [], emails: { needAnswer: [], sentNoReply: [] } };
      const force = !!(opts && opts.force);
      const t = Date.now();
      const due = accts.filter((a) => {
        const c = cache.get(a.email);
        if (!c) return true;
        if (c.failAt) return t - c.failAt >= (force ? FORCE_MIN_MS : FAIL_BACKOFF_MS);   // failures back off, even on "refresh now"
        return force || !c.at || t - c.at >= FRESH_MS;
      });
      const refresh = (a) => {
        if (inflight.has(a.email)) return inflight.get(a.email);
        const pr = (async () => {
          try { cache.set(a.email, { at: Date.now(), items: await fetchAccount(a, now), error: "", failAt: 0 }); }
          catch (e) { const prev = cache.get(a.email) || {}; const why = explainError(e, providerFor(a.email)); cache.set(a.email, { at: prev.at || 0, items: prev.items, error: why, failAt: Date.now() }); say("imap refresh failed for " + a.email + ": " + why); }
          finally { inflight.delete(a.email); }
        })();
        inflight.set(a.email, pr);
        return pr;
      };
      // Accounts refresh one after another (gentle on the servers). The caller waits at most LOAD_DEADLINE_MS, and not at all
      // when every account already has data to show (stale data is returned at once, the refresh finishes in the background).
      const run = (async () => { for (const a of due) await refresh(a); })();
      const needWait = force || due.some((a) => !(cache.get(a.email) && cache.get(a.email).items));
      if (needWait) { let timer; await Promise.race([run, new Promise((r) => { timer = setTimeout(r, LOAD_DEADLINE_MS); })]); clearTimeout(timer); }
      const emails = { needAnswer: [], sentNoReply: [] };
      let any = false, updatedAt = 0;
      for (const a of accts) {
        const c = cache.get(a.email);
        if (c && c.items) { any = true; updatedAt = Math.max(updatedAt, c.at); emails.needAnswer.push(...c.items.needAnswer); emails.sentNoReply.push(...c.items.sentNoReply); }
      }
      emails.needAnswer.sort((x, y) => x.ageDays - y.ageDays);
      emails.sentNoReply.sort((x, y) => y.ageDays - x.ageDays);
      return { connected: any, accounts: accts.map((a) => a.email), emails, updatedAt };
    },
  };
}

module.exports = { create, hostAllowed, providerFor, helpFor, explainError, parseHeaders, groupThreads, classifyAll, toGmailShape, PROVIDERS, HEADER_FIELDS };
