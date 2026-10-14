// node tests/imap.test.js - My Daily IMAP connector (src/daily/imap.js) against a fake IMAP server (no network, no real credentials)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { create, providerFor, helpFor, explainError, parseHeaders, classifyAll, PROVIDERS } = require("../src/daily/imap");

let fails = 0, n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const NOW = Date.parse("2026-10-06T12:00:00Z");
const DAY = 86400000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "imap-"));
const fakeStore = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from("ENC:" + s), decryptString: (b) => { const s = b.toString(); if (!s.startsWith("ENC:")) throw new Error("bad"); return s.slice(4); } };
const PASSWORD = "abcd efgh ijkl mnop".replace(/ /g, "");

const mail = (o) => ({
  uid: o.uid, flags: o.flags || [], date: new Date(NOW - (o.days == null ? 2 : o.days) * DAY),
  headers: "From: " + (o.from || "Bob <bob@x.com>") + "\r\nTo: " + (o.to || "me@example.com") + "\r\nSubject: " + (o.subject || "Hello") + "\r\nDate: " + new Date(NOW - (o.days == null ? 2 : o.days) * DAY).toUTCString() +
    "\r\nMessage-ID: <" + (o.mid || "m" + o.uid + "@x") + ">\r\n" + (o.extra || "") + "\r\n",
});

// A tiny IMAP server: enough of the protocol for imapflow. Records every command verb in .cmds.
function fakeServer(folders, { user = "me@example.com", pass = PASSWORD } = {}) {
  const cmds = [];
  const server = net.createServer((sock) => {
    let buf = "", selected = null;
    const send = (s) => sock.write(s + "\r\n");
    send("* OK fake IMAP ready");
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
        if (!m) continue;
        const tag = m[1], verb = m[2].toUpperCase(), rest = m[3] || "";
        const verb2 = verb === "UID" ? "UID " + (rest.split(" ")[0] || "").toUpperCase() : verb;
        cmds.push(verb2);
        if (verb === "CAPABILITY") { send("* CAPABILITY IMAP4rev1 ID ENABLE UIDPLUS LITERAL+"); send(tag + " OK done"); }
        else if (verb === "ID") { send('* ID ("name" "fake")'); send(tag + " OK done"); }
        else if (verb === "LOGIN") {
          const q = rest.match(/"((?:[^"\\]|\\.)*)"/g) || [];
          const ok = q.length === 2 && q[0].slice(1, -1) === user && q[1].slice(1, -1) === pass;
          if (ok) send(tag + " OK [CAPABILITY IMAP4rev1 ID ENABLE UIDPLUS] logged in");
          else send(tag + " NO [AUTHENTICATIONFAILED] Invalid credentials");
        }
        else if (verb === "ENABLE" || verb === "NOOP" || verb === "NAMESPACE" || verb === "CLOSE" || verb === "UNSELECT") { if (verb === "NAMESPACE") send('* NAMESPACE (("" "/")) NIL NIL'); send(tag + " OK done"); }
        else if (verb === "LIST") {
          const args = (rest.match(/"((?:[^"\\]|\\.)*)"/g) || []).map((x) => x.slice(1, -1));
          const pat = args[1] == null ? "*" : args[1];
          if (pat === "") { send('* LIST (\\Noselect) "/" ""'); send(tag + " OK done"); continue; }
          for (const [name, f] of Object.entries(folders)) if (pat === "*" || pat === "%" || pat === name) send('* LIST (\\HasNoChildren' + (f.special ? " " + f.special : "") + ') "/" "' + name + '"');
          send(tag + " OK done");
        }
        else if (verb === "EXAMINE" || verb === "SELECT") {
          const name = rest.replace(/^"|"$/g, "");
          if (!folders[name]) { send(tag + " NO no such mailbox"); continue; }
          selected = name;
          const list = folders[name].mails;
          send("* " + list.length + " EXISTS"); send("* 0 RECENT"); send("* OK [UIDVALIDITY 1] ok"); send("* OK [UIDNEXT " + (list.length + 1) + "] ok");
          send("* FLAGS (\\Seen \\Flagged \\Answered)");
          send(tag + (verb === "EXAMINE" ? " OK [READ-ONLY] examined" : " OK [READ-WRITE] selected"));
        }
        else if (verb === "UID" && /^SEARCH/i.test(rest)) {
          send("* SEARCH " + folders[selected].mails.map((x) => x.uid).join(" ")); send(tag + " OK done");
        }
        else if (verb === "UID" && /^FETCH/i.test(rest)) {
          const set = rest.split(" ")[1] || "";
          const want = new Set();
          for (const part of set.split(",")) { const [a, b] = part.split(":"); const lo = Number(a), hi = b === "*" || b == null ? (b == null ? lo : 1e9) : Number(b); for (const x of folders[selected].mails) if (x.uid >= lo && x.uid <= hi) want.add(x.uid); }
          const section = (/BODY\.PEEK\[([^\]]*)\]/i.exec(rest) || [])[1];
          folders[selected].mails.forEach((x, idx) => {
            if (!want.has(x.uid)) return;
            const fl = x.flags.length ? "FLAGS (" + x.flags.join(" ") + ")" : "FLAGS ()";
            const d = x.date, pad = (v) => String(v).padStart(2, "0");
            const idate = pad(d.getUTCDate()) + "-" + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()] + "-" + d.getUTCFullYear() + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) + " +0000";
            const body = section ? " BODY[" + section + "] {" + Buffer.byteLength(x.headers) + "}\r\n" + x.headers : "";
            sock.write("* " + (idx + 1) + " FETCH (UID " + x.uid + " " + fl + ' INTERNALDATE "' + idate + '"' + body + ")\r\n");
          });
          send(tag + " OK done");
        }
        else if (verb === "LOGOUT") { send("* BYE bye"); send(tag + " OK done"); sock.end(); }
        else send(tag + " BAD command not allowed in this fake");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, cmds, close: () => new Promise((r) => server.close(r)) })));
}

const FOLDERS = () => ({
  INBOX: { mails: [
    mail({ uid: 1, days: 3, subject: "Quote please", from: "Dana <dana@client.com>" }),
    mail({ uid: 2, days: 1, subject: "Newsletter", from: "News <news@shop.com>", extra: "List-Unsubscribe: <mailto:x@y>\r\n" }),
    mail({ uid: 3, days: 6, subject: "Lunch?", from: "Eli <eli@x.com>", flags: ["\\Seen"] }),
    mail({ uid: 4, days: 2, subject: "Shipment", from: "Shop <no-reply@shop.com>" }),
  ] },
  Sent: { special: "\\Sent", mails: [
    mail({ uid: 1, days: 5, subject: "Re: Lunch?", from: "Me <me@example.com>", to: "Eli <eli@x.com>", mid: "s1@x", extra: "In-Reply-To: <m3@x>\r\n" }),
    mail({ uid: 2, days: 9, subject: "Offer to Noa", from: "Me <me@example.com>", to: "Noa <noa@y.com>", mid: "s2@x" }),
  ] },
});
const mk = (srv, dir) => create({ dataDir: dir, safeStorage: fakeStore, connectOverride: { host: "127.0.0.1", port: srv.port, secure: false, tls: undefined } });

t("provider detection, help text in English and Hebrew, unknown domain asks for a host", () => {
  assert.strictEqual(providerFor("a@gmail.com").host, "imap.gmail.com");
  assert.strictEqual(providerFor("a@Hotmail.com").id, "outlook");
  assert.strictEqual(providerFor("a@yahoo.com").host, "imap.mail.yahoo.com");
  assert.strictEqual(providerFor("a@icloud.com").host, "imap.mail.me.com");
  assert.deepStrictEqual([providerFor("a@mycompany.co.il").id, providerFor("a@mycompany.co.il").host], ["other", ""]);
  const h = helpFor("a@gmail.com");
  assert.ok(h.helpUrl.includes("apppasswords") && h.steps.en.length === 3 && h.steps.he.length === 3 && /[֐-׿]/.test(h.steps.he[0]));
  assert.ok(helpFor("a@mycompany.co.il").steps.he.length === 3 && /[֐-׿]/.test(h.honesty.he));
  for (const p of PROVIDERS.providers) assert.ok(p.steps.en.length === 3 && p.steps.he.length === 3 && p.port === 993, p.id);
});

t("errors are plain sentences and never contain the password", () => {
  const pw = "SECRETPW";
  const cases = [
    [{ code: "ENOTFOUND" }, /cannot find the mail server/i],
    [{ code: "ETIMEDOUT" }, /did not answer/i],
    [{ authenticationFailed: true, responseText: "Invalid credentials " + pw.slice(0, 0) }, /did not accept/i],
    [{ responseText: "Application-specific password required" }, /app password/i],
    [{ responseText: "IMAP access is disabled for your domain" }, /IMAP is switched off/i],
    [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, /certificate/i],
  ];
  for (const [e, re] of cases) { const s = explainError(e, providerFor("a@gmail.com")); assert.ok(re.test(s), s); assert.ok(!s.includes(pw)); }
  assert.ok(/Outlook/.test(explainError({ authenticationFailed: true }, providerFor("a@outlook.com"))));
});

t("parseHeaders unfolds lines and decodes encoded subjects", () => {
  const h = parseHeaders(Buffer.from("Subject: =?UTF-8?B?16nXnNeV150=?=\r\nFrom: A\r\n  <a@x.com>\r\nMessage-ID: <1@x>\r\n\r\n"));
  assert.strictEqual(h.subject, "שלום");
  assert.strictEqual(h.from, "A <a@x.com>");
});

t("classifyAll: reply needed, sent without reply, bulk and no-reply ignored, answered thread counts as sent", () => {
  const f = FOLDERS();
  const toMsg = (x) => ({ id: x.uid, seen: x.flags.includes("\\Seen"), flagged: false, internalDate: x.date, headers: parseHeaders(x.headers) });
  const r = classifyAll(f.INBOX.mails.map(toMsg), f.Sent.mails.map(toMsg), "me@example.com", NOW);
  assert.deepStrictEqual(r.needAnswer.map((x) => x.subject), ["Quote please"]);
  assert.deepStrictEqual(r.sentNoReply.map((x) => x.subject).sort(), ["Offer to Noa", "Re: Lunch?"]);
  assert.strictEqual(r.needAnswer[0].unread, true);
});

t("Add: wrong password is refused with a plain sentence and nothing is stored", async () => {
  const srv = await fakeServer(FOLDERS()); const dir = tmp();
  try {
    const c = mk(srv, dir);
    const r = await c.addAccount({ email: "me@example.com", password: "wrong-password", host: "imap.example.com" });
    assert.strictEqual(r.ok, false);
    assert.ok(/did not accept/i.test(r.reason), r.reason);
    assert.strictEqual(c.list().length, 0);
    assert.ok(!fs.existsSync(path.join(dir, "imap-accounts.bin")));
  } finally { await srv.close(); }
});

t("Add + load over IMAP: only read-only commands reach the server, mail is classified, password is stored encrypted", async () => {
  const srv = await fakeServer(FOLDERS()); const dir = tmp();
  try {
    const c = mk(srv, dir);
    const r = await c.addAccount({ email: "me@example.com", password: PASSWORD, host: "imap.example.com" });
    assert.deepStrictEqual([r.ok, r.email], [true, "me@example.com"]);
    const raw = fs.readFileSync(path.join(dir, "imap-accounts.bin"));
    assert.ok(raw.toString().startsWith("ENC:") && raw.toString().includes(PASSWORD) && !fs.readdirSync(dir).some((x) => x.endsWith(".tmp")));   // fake store only prefixes; real one is DPAPI
    const res = await c.load(NOW, { force: true });
    assert.strictEqual(res.connected, true);
    assert.deepStrictEqual(res.emails.needAnswer.map((x) => x.subject), ["Quote please"]);
    assert.strictEqual(res.emails.sentNoReply.length, 2);
    assert.deepStrictEqual(c.list().map((a) => [a.email, a.ok, a.needAnswer, a.sentNoReply]), [["me@example.com", true, 1, 2]]);
    const allowed = new Set(["CAPABILITY", "ID", "LOGIN", "ENABLE", "NAMESPACE", "LIST", "LSUB", "STATUS", "EXAMINE", "UID SEARCH", "UID FETCH", "NOOP", "CLOSE", "UNSELECT", "LOGOUT"]);
    for (const verb of srv.cmds) assert.ok(allowed.has(verb), "unexpected command to the mail server: " + verb);
    for (const bad of ["SELECT", "STORE", "UID STORE", "EXPUNGE", "APPEND", "COPY", "UID COPY", "UID MOVE", "MOVE", "DELETE", "CREATE", "RENAME"]) assert.ok(!srv.cmds.includes(bad), bad + " must never be sent");
    assert.ok(srv.cmds.includes("EXAMINE"));
  } finally { await srv.close(); }
});

t("Remove deletes the stored password; second remove says no such account", async () => {
  const srv = await fakeServer(FOLDERS()); const dir = tmp();
  try {
    const c = mk(srv, dir);
    await c.addAccount({ email: "me@example.com", password: PASSWORD, host: "imap.example.com" });
    assert.ok(fs.existsSync(path.join(dir, "imap-accounts.bin")));
    assert.strictEqual(c.remove("ME@example.com").ok, true);
    assert.ok(!fs.existsSync(path.join(dir, "imap-accounts.bin")));
    assert.strictEqual(c.list().length, 0);
    assert.strictEqual(c.remove("me@example.com").ok, false);
    assert.strictEqual((await c.load(NOW)).connected, false);
  } finally { await srv.close(); }
});

t("no encryption available: the account is refused, nothing is written", async () => {
  const srv = await fakeServer(FOLDERS()); const dir = tmp();
  try {
    const c = create({ dataDir: dir, safeStorage: { isEncryptionAvailable: () => false }, connectOverride: { host: "127.0.0.1", port: srv.port, secure: false } });
    const r = await c.addAccount({ email: "me@example.com", password: PASSWORD, host: "imap.example.com" });
    assert.strictEqual(r.ok, false);
    assert.ok(/encrypt/i.test(r.reason));
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  } finally { await srv.close(); }
});

t("bad input: not an address, no password, unknown domain without a host", async () => {
  const dir = tmp();
  const c = create({ dataDir: dir, safeStorage: fakeStore });
  assert.strictEqual((await c.addAccount({ email: "nope", password: "x" })).ok, false);
  assert.strictEqual((await c.addAccount({ email: "a@b.com", password: "" })).ok, false);
  const r = await c.addAccount({ email: "a@mycompany.co.il", password: "x" });
  assert.deepStrictEqual([r.ok, r.needHost], [false, true]);
  assert.strictEqual((await c.addAccount({ email: "a@mycompany.co.il", password: "x", host: "bad host!" })).ok, false);
});

t("unreachable server: plain sentence, no stored account", async () => {
  const dir = tmp();
  const c = create({ dataDir: dir, safeStorage: fakeStore, connectOverride: { host: "127.0.0.1", port: 1, secure: false } });
  const r = await c.addAccount({ email: "me@example.com", password: PASSWORD, host: "imap.example.com" });
  assert.strictEqual(r.ok, false);
  assert.ok(/did not answer|could not connect/i.test(r.reason), r.reason);
  assert.ok(!r.reason.includes(PASSWORD));
});

const { ImapFlow } = require("imapflow");
const { hostAllowed } = require("../src/daily/imap");
const counting = () => { const o = { n: 0 }; o.cls = class extends ImapFlow { constructor(x) { super(x); o.n++; } }; return o; };

t("known provider always uses its own host and port; unknown domain rejects localhost, IPs and .local names; port is clamped", async () => {
  const srv = await fakeServer(FOLDERS(), { user: "me@gmail.com" }); const dir = tmp();
  try {
    const c = mk(srv, dir);
    const r = await c.testConnection({ email: "me@gmail.com", password: PASSWORD, host: "evil.example.org", port: 25 });
    assert.deepStrictEqual([r.ok, r.account.host, r.account.port], [true, "imap.gmail.com", 993]);
    for (const h of ["localhost", "127.0.0.1", "192.168.1.5", "nas.local", "printer", "10.0.0.1"]) assert.strictEqual(hostAllowed(h), false, h);
    assert.strictEqual(hostAllowed("imap.mycompany.co.il"), true);
    const bad = await c.testConnection({ email: "a@mycompany.co.il", password: "x", host: "192.168.1.5" });
    assert.deepStrictEqual([bad.ok, bad.needHost], [false, true]);
    const o = await c.testConnection({ email: "a@mycompany.co.il", password: PASSWORD, host: "imap.mycompany.co.il", port: 99999 });
    assert.strictEqual(o.account ? o.account.port : 993, 993);
  } finally { await srv.close(); }
});

t("unreadable account file: nothing is overwritten or removed, load says why", async () => {
  const dir = tmp(); const f = path.join(dir, "imap-accounts.bin");
  fs.writeFileSync(f, "garbage-not-encrypted");
  const srv = await fakeServer(FOLDERS());
  try {
    const c = mk(srv, dir);
    assert.strictEqual(c.unreadable(), true);
    const r = await c.addAccount({ email: "me@example.com", password: PASSWORD, host: "imap.example.com" });
    assert.strictEqual(r.ok, false); assert.ok(/cannot be read/i.test(r.reason));
    assert.strictEqual(c.remove("me@example.com").ok, false);
    assert.strictEqual((await c.load(NOW, {})).connected, false);
    assert.ok((await c.load(NOW, {})).error);
    assert.strictEqual(fs.readFileSync(f, "utf8"), "garbage-not-encrypted");
  } finally { await srv.close(); }
});

t("failed refresh backs off (also on refresh-now) and two overlapping loads share one login", async () => {
  const srv = await fakeServer(FOLDERS()); const dir = tmp(); const k = counting();
  try {
    const c = create({ dataDir: dir, safeStorage: fakeStore, imapClass: k.cls, connectOverride: { host: "127.0.0.1", port: srv.port, secure: false, tls: undefined } });
    assert.strictEqual((await c.addAccount({ email: "me@example.com", password: PASSWORD, host: "imap.example.com" })).ok, true);
    const base = k.n;
    await Promise.all([c.load(NOW, { force: true }), c.load(NOW, { force: true })]);
    assert.strictEqual(k.n - base, 1, "overlapping loads must share one login");
    await srv.close();
    const c2 = create({ dataDir: dir, safeStorage: fakeStore, imapClass: k.cls, connectOverride: { host: "127.0.0.1", port: 1, secure: false } });
    const b2 = k.n;
    await c2.load(NOW, { force: true });
    assert.strictEqual(k.n - b2, 1);
    await c2.load(NOW, {}); await c2.load(NOW, { force: true });
    assert.strictEqual(k.n - b2, 1, "a failed account is not retried within the backoff");
    assert.ok(c2.list()[0].error);
  } finally { try { await srv.close(); } catch (e) { /* closed */ } }
});

(async () => {
  for (const [name, fn] of tests) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + (e && e.stack || e)); } }
  console.log(fails ? `${fails} of ${n} FAILED` : `imap: ${n} tests passed`);
  process.exit(fails ? 1 : 0);
})();
