// node tests/fleetPane.test.js - Fleet conversations pane (v1.119.0): src/fleetMailbox.js against TEMP fixture mailboxes (never the real Dropbox folders).
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const M = require("../src/fleetMailbox");
M.configure({ inbox: "to_Owner_fleet", outbox: "from_Owner_fleet", owner: "Alex", partner: "Sarah", role: "COO" }); // the owner-computer migration values: fixtures stay as they were
let n = 0, fails = 0; const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const DAY = 86400000;
const mk = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleetpane-")); fs.mkdirSync(path.join(root, "to_Owner_fleet")); fs.mkdirSync(path.join(root, "from_Owner_fleet")); return { root, A: path.join(root, "to_Owner_fleet"), B: path.join(root, "from_Owner_fleet") }; };
const W = (dir, name, text, ageMs) => { const f = path.join(dir, name); fs.writeFileSync(f, text); const tm = new Date(Date.now() - (ageMs || 0)); fs.utimesSync(f, tm, tm); };
const day = (d) => { const x = new Date(Date.now() - d * DAY), p = (v) => String(v).padStart(2, "0"); return x.getFullYear() + "-" + p(x.getMonth() + 1) + "-" + p(x.getDate()); };
const L = (root, o) => { M._resetCache(); return M.listMailbox(root, Object.assign({ force: true }, o)); };
const qids = (r) => r.questions.map((q) => q.id).join("\n");
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// ---- main fixture
const F = mk();
W(F.A, day(1) + "_to-Security_IRIS-received.md", "To: Security. From: Sarah's COO.\n\nIRIS arrived. Can you confirm the pairing works?\n", 1 * DAY);
W(F.A, day(3) + "_PC-Care_FanControl-update-request.md", "# Fan control\n\nTo: Alex's COO. From: Sarah's PC Care.\n\nNo reply needed today.\n", 3 * DAY);
W(F.A, day(20) + "_old_question_topic.md", "Is this still open?\n", 20 * DAY);
W(F.A, day(2) + "_greenery_redirect_plan.md", "Plan for redirects. Waiting for you to approve.\n", 2 * DAY);
W(F.B, day(1) + "_greenery_reply_redirect-plan-approved.md", "To: Sarah's COO. From: Security.\n\nApproved.\n", 1 * DAY - 3600000);
W(F.A, "notes without date.md", "hello", 5 * DAY);
fs.mkdirSync(path.join(F.A, day(4) + "_attachments_folder"));
fs.writeFileSync(path.join(F.A, "image.png"), "x");
for (const f of [day(4) + "_attachments_folder", "image.png"]) { const tm = new Date(Date.now() - 4 * DAY); fs.utimesSync(path.join(F.A, f), tm, tm); }

t("date parsed from file name prefix, mtime fallback", async () => {
  assert.strictEqual(M.dateFromName("2026-10-12_x.md"), Date.UTC(2026, 9, 12, 12)); assert.strictEqual(M.dateFromName("notes.md"), null);
  const i = (await L(F.root)).items.find((x) => x.name === "notes without date.md"); assert.ok(Math.abs(i.date - i.mtimeMs) < 1);
});
t("To:/From: on one line, on separate lines, markdown bold", () => {
  let h = M.parseHead("To: Alex's COO. From: Sarah's PC Care.\n\nbody"); assert.strictEqual(h.to, "Alex's COO"); assert.strictEqual(h.from, "Sarah's PC Care");
  h = M.parseHead("**To:** Legal\n**From:** Sarah's COO\n"); assert.strictEqual(h.to, "Legal"); assert.strictEqual(h.from, "Sarah's COO");
});
t("parseHead ignores body text: 'Dr.' and a From: far below the header", () => {
  assert.strictEqual(M.parseHead("To: Alex. From: Dr. Cohen's clinic.\n").from, "Dr. Cohen's clinic");
  const h = M.parseHead("# Title\n\nSome text. Mail From: someone else. More.\n\n\n\n\n\n\n\nFrom: late@x\n"); assert.strictEqual(h.from, ""); assert.strictEqual(h.to, "");
});
t("file-name sender only when capitalised (a topic word is not a sender)", () => {
  assert.strictEqual(M.parseName("2026-10-12_to-Security_IRIS-received.md").recipient, "Security");
  assert.strictEqual(M.parseName("2026-10-04_PC-Care_FanControl-update-request.md").sender, "PC Care");
  assert.strictEqual(M.parseName("2026-10-12_greenery_redirect_plan.md").sender, "");
});
t("header wins over file name; unknown when nothing says", async () => {
  const r = await L(F.root), i = r.items.find((x) => /IRIS-received/.test(x.name)); assert.strictEqual(i.sender, "Sarah's COO"); assert.strictEqual(i.recipient, "Security"); assert.strictEqual(i.direction, "from Sarah");
  const u = r.items.find((x) => x.name === "notes without date.md"); assert.strictEqual(u.sender, "unknown"); assert.strictEqual(u.recipient, "unknown");
});
t("newest first; folders and non-md files are listed as items", async () => {
  const r = await L(F.root), ds = r.items.map((i) => Math.max(i.date, i.mtimeMs)); for (let k = 1; k < ds.length; k++) assert.ok(ds[k - 1] >= ds[k]);
  assert.ok(r.items.some((i) => i.isDir)); assert.ok(r.items.some((i) => i.other));
});
t("unread is computed from the fixture files, not hard-coded (an answered question note, redirect_plan, no longer counts)", async () => {
  const mer = fs.readdirSync(F.A).filter((f) => !/redirect_plan/.test(f)).map((f) => fs.lstatSync(path.join(F.A, f)).mtimeMs);
  for (const cut of [0, Date.now() - 2.5 * DAY, Date.now() - 4.5 * DAY, Date.now()]) {
    const r = await L(F.root, { lastSeen: cut }); assert.strictEqual(r.unread, mer.filter((m) => m > cut).length, "cut " + cut);
  }
  const r = await L(F.root, { lastSeen: 0 }); assert.strictEqual(r.maxPartnerMtime, Math.max.apply(null, mer));
});
t("open question basics: recent '?' note without later Alex note is open; answered / no-reply / old are not", async () => {
  const q = qids(await L(F.root)); assert.ok(/IRIS-received/.test(q)); assert.ok(!/redirect_plan/.test(q)); assert.ok(!/FanControl/.test(q)); assert.ok(!/old_question/.test(q));
});
t("no-reply-needed guard: a note WITH a '?' and 'no reply needed' is not a question; '... except' still is", () => {
  assert.strictEqual(M.looksLikeQuestion("Why did it fail? Anyway, no reply needed."), false);
  assert.strictEqual(M.looksLikeQuestion("FYI. No reply needed today except item 3?"), true);
  assert.ok(M.looksLikeQuestion("please confirm this")); assert.ok(M.looksLikeQuestion("we are waiting for you")); assert.ok(!M.looksLikeQuestion("All done."));
});
t("'?' inside a URL or a quoted '>' line is not a question", () => {
  assert.strictEqual(M.looksLikeQuestion("See https://x.com/a?b=1&c=2 for details."), false);
  assert.strictEqual(M.looksLikeQuestion("Done.\n> did you see this?\n> and this?\nThanks."), false);
  assert.strictEqual(M.looksLikeQuestion("Done.\n> quoted?\nAre you ok with that?"), true);
});
t("same-day question/answer decided by real mtimes, not UTC noon of the name date", async () => {
  const G = mk(); const d = day(0);
  W(G.A, d + "_to-Security_harmonia-beta_link-share.md", "Can we share the beta link?\n", 1 * 3600000);
  W(G.B, d + "_Security_harmonia-beta_link-share-earlier.md", "To: Sarah's COO. From: Security.\n\nEarlier note.\n", 3 * 3600000);
  let r = await L(G.root); assert.ok(/harmonia/.test(qids(r)), "an earlier same-day Alex note must not answer the later question");
  W(G.B, d + "_Security_harmonia-beta_link-share-answer.md", "To: Sarah's COO. From: Security.\n\nYes.\n", 0);
  r = await L(G.root); assert.ok(!/harmonia/.test(qids(r)), "a later Alex note answers it"); rm(G.root);
});
t("name dates win only when both are dated on different days", async () => {
  const G = mk();
  W(G.A, day(2) + "_to-X_alpha-beta_gamma.md", "Question?\n", 0);
  W(G.B, day(1) + "_X_alpha-beta_gamma-reply.md", "To: M. From: I.\n\nok\n", 5 * 3600000);
  assert.ok(!/alpha/.test(qids(await L(G.root))), "different days: the name date decides"); rm(G.root);
});
t("thread merging: one shared word does NOT merge, two shared words do; an unrelated Alex reply does not silence another topic", async () => {
  const G = mk();
  W(G.A, day(1) + "_to-Legal_greenery_domain-renewal.md", "Should we renew the domain?\n", 1 * DAY);
  W(G.A, day(1) + "_to-Web_greenery_footer-fix.md", "Is the footer ok?\n", 1 * DAY - 10);
  W(G.B, day(0) + "_Web_greenery_footer-fix-answer.md", "To: Sarah's Web. From: Web.\n\nYes the footer is fine.\n", 0);
  const r = await L(G.root);
  const k = (s) => r.items.find((i) => i.name.includes(s)).threadKey;
  assert.notStrictEqual(k("domain-renewal"), k("footer-fix.md"), "sharing only 'greenery' must not merge");
  assert.strictEqual(k("footer-fix.md"), k("footer-fix-answer"), "footer+fix are shared");
  assert.ok(/domain-renewal/.test(qids(r)), "the domain question stays open"); assert.ok(!/footer-fix\.md/.test(qids(r)));
  rm(G.root);
});
t("EVERY Sarah question of a thread is evaluated, not only the newest", async () => {
  const G = mk();
  W(G.A, day(3) + "_to-Sec_nas_backup-plan.md", "Which drives for the nas backup plan?\n", 3 * DAY);
  W(G.A, day(1) + "_to-Sec_nas_backup-plan-followup.md", "Any news on the nas backup plan?\n", 1 * DAY);
  const r = await L(G.root); assert.strictEqual(r.questions.length, 2); rm(G.root);
});
t("thread keys are stable (hash of the name), also for Hebrew file names, whatever else is in the folder", async () => {
  const G = mk(); W(G.A, day(2) + "_להתראות_גיבוי_שרת.md", "מה לעשות?\n", 2 * DAY); W(G.A, day(2) + "_להתראות_גיבוי_שרת-תשובה.md", "?", 2 * DAY);
  const k1 = (await L(G.root)).items.find((i) => i.name.includes("שרת.md")).threadKey;
  W(G.A, day(0) + "_unrelated_stuff_here.md", "x", 0);
  const r2 = await L(G.root), k2 = r2.items.find((i) => i.name.includes("שרת.md")).threadKey;
  assert.strictEqual(k1, k2); assert.ok(/^t[0-9a-z]+$/.test(k1));
  assert.strictEqual(r2.items.find((i) => i.name.includes("שרת.md")).threadKey, r2.items.find((i) => i.name.includes("תשובה")).threadKey, "Hebrew tokens group");
  rm(G.root);
});
t("missing mailbox folders give a calm not-found result", async () => { M._resetCache(); const r = await M.listMailbox(path.join(F.root, "nope"), {}); assert.strictEqual(r.ok, true); assert.strictEqual(r.found, false); assert.strictEqual(r.unread, 0); });
t("listing is capped to the newest 300 files", async () => {
  const G = mk();
  for (let k = 0; k < 340; k++) fs.writeFileSync(path.join(G.A, "2026-01-01_n" + String(k).padStart(3, "0") + ".md"), "x");
  const r = await L(G.root); assert.strictEqual(r.items.length, 300); assert.ok(r.capped); assert.strictEqual(r.total, 340); rm(G.root);
});
t("fingerprint cache: unchanged mailbox is reused, a new file triggers a rebuild", async () => {
  const G = mk(); W(G.A, day(1) + "_to-X_cache_test-note.md", "hi?\n", DAY);
  M._resetCache(); const r1 = await M.listMailbox(G.root, {}), r2 = await M.listMailbox(G.root, {});
  assert.strictEqual(r1.items, r2.items, "same cached item array"); assert.strictEqual(r1.fp, r2.fp);
  W(G.A, day(0) + "_to-X_cache_test-note2.md", "new?\n", 0); const r3 = await M.listMailbox(G.root, {}); assert.strictEqual(r3.items.length, 2); rm(G.root);
});
t("a failed head read is not cached", async () => {
  M._resetCache(); const p = path.join(os.tmpdir(), "fleetpane-late-" + process.pid + ".md");
  assert.strictEqual(await M._readHead(p, { mtimeMs: 5, size: 5 }), null);
  fs.writeFileSync(p, "hello"); const h = await M._readHead(p, { mtimeMs: 5, size: 5 }); assert.strictEqual(h, "hello"); fs.unlinkSync(p);
});
t("readMessage reads a file, refuses path tricks", async () => {
  const r = await M.readMessage(F.root, "partner/" + day(1) + "_to-Security_IRIS-received.md"); assert.ok(r.ok && /IRIS arrived/.test(r.text));
  for (const id of ["partner/../secret.md", "partner/..\\x.md", "other/x.md", "partner/a:b.md", "partner/"]) assert.strictEqual((await M.readMessage(F.root, id)).ok, false, id);
});
t("readMessage refuses reserved Windows device names", async () => {
  for (const id of ["partner/NUL", "partner/con.md", "owner/COM1", "owner/lpt1.txt", "partner/AUX.md", "partner/prn"]) assert.strictEqual((await M.readMessage(F.root, id)).ok, false, id);
});
t("readMessage refuses a symlink (isFile guard); symlinks are not listed", async () => {
  const G = mk(), secret = path.join(G.root, "secret.txt"); fs.writeFileSync(secret, "TOPSECRET");
  let linked = false; try { fs.symlinkSync(secret, path.join(G.A, "link.md")); linked = true; } catch (e) { /* no privilege for symlinks on this PC */ }
  if (linked) { const r = await M.readMessage(G.root, "partner/link.md"); assert.ok(!r.ok || !/TOPSECRET/.test(r.text || ""), "symlink target must not be read"); assert.ok(!(await L(G.root)).items.some((i) => i.name === "link.md"), "symlinks are not listed"); }
  const d = await M.readMessage(F.root, "partner/" + day(4) + "_attachments_folder"); assert.ok(d.ok && d.isDir);
  rm(G.root);
});
t("writeReply writes the described file and never overwrites", async () => {
  const G = mk(), now = Date.UTC(2026, 9, 13, 12);
  const r1 = M.writeReply(G.root, { recipient: "Sarah's COO", topic: "IRIS received", text: "Yes, it works.", now });
  assert.ok(r1.ok); assert.ok(/^2026-10-13_Alex_reply_iris-received\.md$/.test(r1.name), r1.name);
  const txt = fs.readFileSync(path.join(G.B, r1.name), "utf8"); assert.ok(txt.startsWith("To: Sarah's COO. From: Alex (via Agent Desktop).\n")); assert.ok(txt.includes("Yes, it works."));
  const r2 = M.writeReply(G.root, { recipient: "Sarah's COO", topic: "IRIS received", text: "Second.", now });
  assert.ok(r2.ok && r2.name !== r1.name && /-2\.md$/.test(r2.name)); assert.ok(fs.readFileSync(path.join(G.B, r1.name), "utf8").includes("Yes, it works."), "first file untouched");
  assert.ok((await L(G.root, { now })).items.some((i) => i.id === r1.id)); rm(G.root);
});
t("writeReply refuses empty text / missing folder, and touches nothing but from_Owner_fleet", async () => {
  const G = mk(); W(G.A, "2026-10-01_to-X_keep_me.md", "?", DAY);
  const snap = () => JSON.stringify([fs.readdirSync(G.root).sort(), fs.readdirSync(G.A).sort().map((f) => [f, fs.statSync(path.join(G.A, f)).size, fs.statSync(path.join(G.A, f)).mtimeMs])]);
  const before = snap(), bB = fs.readdirSync(G.B).length;
  assert.strictEqual(M.writeReply(G.root, { text: "  " }).ok, false); assert.strictEqual(M.writeReply(path.join(G.root, "nope"), { text: "x" }).ok, false); assert.ok(!fs.existsSync(path.join(G.root, "nope")));
  assert.strictEqual(snap(), before, "nothing changed yet"); assert.strictEqual(fs.readdirSync(G.B).length, bB);
  assert.ok(M.writeReply(G.root, { recipient: "X", topic: "t", text: "ok" }).ok);
  assert.strictEqual(snap(), before, "to_Owner_fleet and the Exchange root are untouched"); assert.strictEqual(fs.readdirSync(G.B).length, bB + 1); rm(G.root);
});
t("fleetDir honours AGENT_DESKTOP_FLEET_DIR", () => { const o = process.env.AGENT_DESKTOP_FLEET_DIR; process.env.AGENT_DESKTOP_FLEET_DIR = "X:\\fixture"; assert.strictEqual(M.fleetDir(), "X:\\fixture"); if (o === undefined) delete process.env.AGENT_DESKTOP_FLEET_DIR; else process.env.AGENT_DESKTOP_FLEET_DIR = o; });
t("renderer: no innerHTML; first run seeds lastSeen to now; markSeen only from a successful listing; Dismiss, Esc, polling and z-index handled", () => {
  const dir = path.join(__dirname, "..", "src", "renderer"), s = fs.readFileSync(path.join(dir, "fleet-pane.js"), "utf8"), css = fs.readFileSync(path.join(dir, "styles-fleet-pane.css"), "utf8");
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(s));
  assert.ok(/lastSeen = Date\.now\(\); setFlag\(FLAG, lastSeen\)/.test(s), "first run starts at now");
  assert.ok(/maxPartnerMtime/.test(s) && !/lastSeen = now/.test(s) && /if \(!r \|\| !r\.ok \|\| !r\.found\) return;/.test(s));
  assert.ok(/fleetPaneDismissed/.test(s) && /"Dismiss"/.test(s));
  assert.ok(/stopImmediatePropagation/.test(s) && /POLL_CLOSED = 300000/.test(s) && /POLL_OPEN = 60000/.test(s));
  const z = +/z-index:\s*(\d+)/.exec(css)[1], wq = fs.readFileSync(path.join(dir, "styles-waiting-queue.css"), "utf8"), wz = +/\.wq-ctl\s*\{[^}]*z-index:\s*(\d+)/.exec(wq)[1]; assert.ok(z > wz, "fleet pane above .wq-ctl");
});

(async () => {
  for (const [name, fn] of tests) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + (e && e.message)); } }
  rm(F.root); console.log(n - fails + "/" + n + " passed"); process.exit(fails ? 1 : 0);
})();
