// node tests/sealedAnswers.test.js - src/sealedAnswers.js (sign/verify/sealIntoFile) and the Python verifier shared_tools/ask_iddo.py verify + sealed_verify.py
// (cross-language: Node signs, pure-Python Ed25519 verifies), with the forgery / replay cases.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert"), cp = require("child_process");
const S = require("../src/sealedAnswers");
let fails = 0; const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sa-"));
// stand-in for DPAPI: reversible, not plaintext
const protect = (b) => Buffer.from(Buffer.from(b).toString("base64").split("").reverse().join(""));
const unprotect = (b) => Buffer.from(Buffer.from(b).toString().split("").reverse().join(""), "base64");
const NOW = Date.now();
const mk = (o) => { const dir = tmp(), q = tmp(); return Object.assign({ dir, q, sealer: S.createSealer({ dir, protect, unprotect, now: () => NOW }) }, o); };
const ASK = { id: "20261101-101500-ab12", agent: "Software Engineering", question: "May I write to the production DB?", quick: ["Yes", "No"], created: new Date(NOW - 60000).toISOString() };
const writeAsk = (q, a) => fs.writeFileSync(path.join(q, a.id + ".json"), JSON.stringify(a));
const pubOf = (sealer) => sealer.publicInfo();
const PY = process.env.PYTHON || "python", TOOL = path.join(process.env.SHARED_TOOLS_DIR || path.resolve(__dirname, "..", "..", "shared_tools"), "ask_iddo.py");
const py = (args, env) => cp.spawnSync(PY, [TOOL].concat(args), { encoding: "utf8", env: Object.assign({}, process.env, env) });

t("a sealed answer verifies (JS)", () => {
  const m = mk(), s = m.sealer.seal(ASK, "Yes", "button");
  assert.deepStrictEqual(S.verify(s, ASK, pubOf(m.sealer), { now: NOW + 1000 }).ok, true);
});
t("question text / agent / quick answers edited after the answer: refused", () => {
  const m = mk(), s = m.sealer.seal(ASK, "Yes", "button"), p = pubOf(m.sealer);
  assert.match(S.verify(s, Object.assign({}, ASK, { question: "May I delete the DB?" }), p, { now: NOW }).reason, /changed/);
  assert.match(S.verify(s, Object.assign({}, ASK, { agent: "Other" }), p, { now: NOW }).reason, /changed/);
  assert.match(S.verify(s, Object.assign({}, ASK, { quick: ["Yes", "No", "Maybe"] }), p, { now: NOW }).reason, /changed/);
});
t("a seal reused for another id is refused", () => {
  const m = mk(), s = m.sealer.seal(ASK, "Yes", "button"), p = pubOf(m.sealer);
  const other = Object.assign({}, ASK, { id: "20261101-101501-ffff" });
  assert.match(S.verify(s, other, p, { now: NOW }).reason, /another question id/);
  const forged = Object.assign({}, s, { id: other.id }); assert.match(S.verify(forged, other, p, { now: NOW }).reason, /signature/);
});
t("changed answer / via / ts / nonce break the signature; a foreign key is refused", () => {
  const m = mk(), s = m.sealer.seal(ASK, "No", "button"), p = pubOf(m.sealer);
  for (const k of [["answer", "Yes"], ["via", "typed"], ["ts", s.ts + 5], ["nonce", "e".repeat(32)]]) assert.match(S.verify(Object.assign({}, s, { [k[0]]: k[1] }), Object.assign({}, ASK), p, { now: NOW + 1000 }).reason, /signature/, k[0]);
  const evil = mk(), e = evil.sealer.seal(ASK, "Yes", "button");
  assert.match(S.verify(e, ASK, pubOf(m.sealer), { now: NOW }).reason, /published/);
  const pe = pubOf(evil.sealer); assert.strictEqual(S.verify(e, ASK, pe, { now: NOW }).ok, true);   // the verifier is only as good as the pub.json it trusts (documented limit)
});
t("record answer must equal the sealed answer", () => {
  const m = mk(), s = m.sealer.seal(ASK, "No", "button");
  assert.match(S.verify(s, Object.assign({}, ASK, { answer: "Yes" }), pubOf(m.sealer), { now: NOW }).reason, /differs/);
});
t("time: future, before the question, too old", () => {
  const m = mk(), s = m.sealer.seal(ASK, "Yes", "button"), p = pubOf(m.sealer);
  assert.match(S.verify(s, ASK, p, { now: NOW - 10 * 60000 }).reason, /future/);
  assert.match(S.verify(s, Object.assign({}, ASK, { created: new Date(NOW + 3600000).toISOString() }), p, { now: NOW }).reason, /older than the question/);
  assert.match(S.verify(s, ASK, p, { now: NOW + 7200000, maxAgeMs: 3600000 }).reason, /allowed age/);
  assert.strictEqual(S.verify(s, ASK, p, { now: NOW + 7200000 }).ok, true);
});
t("clock rollback: signing time never goes below the last seal", () => {
  let clock = NOW; const dir = tmp(); const sl = S.createSealer({ dir, protect, unprotect, now: () => clock });
  const a = sl.seal(ASK, "Yes", "button"); clock = NOW - 86400000;
  const b = sl.seal(Object.assign({}, ASK, { id: "20261101-101502-aaaa" }), "Yes", "button");
  assert.ok(b.ts > a.ts);
  const sl2 = S.createSealer({ dir, protect, unprotect, now: () => NOW - 86400000 });   // after a restart too (ledger on disk)
  assert.ok(sl2.seal(Object.assign({}, ASK, { id: "20261101-101503-bbbb" }), "Yes", "button").ts > b.ts);
});
t("key is wrapped (not plaintext), reused after restart, and a key that cannot be unwrapped is never silently replaced", () => {
  const m = mk(); const k1 = m.sealer.publicInfo();
  const raw = fs.readFileSync(path.join(m.dir, "seal.key.enc")); assert.ok(!raw.toString("latin1").includes("PRIVATE"));
  assert.strictEqual(S.createSealer({ dir: m.dir, protect, unprotect }).publicInfo().kid, k1.kid);
  const broken = S.createSealer({ dir: m.dir, protect, unprotect: () => { throw new Error("other user"); } });
  assert.throws(() => broken.publicInfo(), /cannot be unwrapped/);
  fs.writeFileSync(path.join(m.dir, "pub.json"), "{}");                            // tampered pub.json is healed on load
  S.createSealer({ dir: m.dir, protect, unprotect }).publicInfo(); assert.strictEqual(JSON.parse(fs.readFileSync(path.join(m.dir, "pub.json"), "utf8")).kid, k1.kid);
});
t("sealIntoFile: closed, already sealed, non-quick button text are refused; typed text is sealed", () => {
  const m = mk(); writeAsk(m.q, ASK);
  assert.strictEqual(S.sealIntoFile(m.sealer, m.q, "20261101-000000-0000", "Yes", "button").ok, false);                    // not open
  assert.match(S.sealIntoFile(m.sealer, m.q, ASK.id, "Delete everything", "button").error, /quick/);
  assert.strictEqual(S.sealIntoFile(m.sealer, m.q, "../x", "Yes", "button").ok, false);
  const r = S.sealIntoFile(m.sealer, m.q, ASK.id, "Yes", "button"); assert.strictEqual(r.ok, true);
  assert.match(S.sealIntoFile(m.sealer, m.q, ASK.id, "No", "button").error, /already sealed/);
  const rec = JSON.parse(fs.readFileSync(path.join(m.q, ASK.id + ".json"), "utf8"));
  assert.strictEqual(rec.answer, "Yes"); assert.strictEqual(S.verify(rec.seal, rec, pubOf(m.sealer), { now: NOW + 1000 }).ok, true);
  const t2 = Object.assign({}, ASK, { id: "20261101-101504-cccc" }); writeAsk(m.q, t2);
  assert.strictEqual(S.sealIntoFile(m.sealer, m.q, t2.id, "Yes, but only on staging", "typed").ok, true);
});

// ---- Python verifier (ask_iddo.py verify / show / list --answered), end to end on temp folders ----
const pyCase = (name, fn) => t("py: " + name, () => {
  if (!fs.existsSync(TOOL)) { console.log("     (skipped: " + TOOL + " not found; set SHARED_TOOLS_DIR)"); return; }
  const m = mk(); fs.mkdirSync(path.join(m.q, "answered"), { recursive: true });
  const env = { OPEN_QUESTIONS_DIR: m.q, AGENT_DESKTOP_SEALED_DIR: m.dir }; m.sealer.publicInfo();
  fn(m, env);
});
const answeredPath = (m, id) => path.join(m.q, "answered", id + ".json");
const sealAndClose = (m, ask, text, via) => { writeAsk(m.q, ask); const r = S.sealIntoFile(m.sealer, m.q, ask.id, text || "Yes", via || "button"); assert.strictEqual(r.ok, true); fs.renameSync(path.join(m.q, ask.id + ".json"), answeredPath(m, ask.id)); };
pyCase("valid seal: exit 0 and prints just the answer", (m, env) => {
  sealAndClose(m, ASK); const r = py(["verify", ASK.id], env); assert.strictEqual(r.status, 0, r.stderr); assert.strictEqual(r.stdout.trim(), "Yes");
  const j = JSON.parse(py(["verify", ASK.id, "--json"], env).stdout); assert.strictEqual(j.answer, "Yes"); assert.strictEqual(j.via, "button");
  assert.match(py(["show", ASK.id], env).stdout, /^seal: sealed by Iddo \(UI\)/);
  const l = JSON.parse(py(["list", "--answered"], env).stdout); assert.strictEqual(l.filter((x) => x.id === ASK.id)[0].seal_status, "sealed by Iddo (UI)");
});
pyCase("agent `resolve` never produces a seal: verify fails, show says unsealed", (m, env) => {
  writeAsk(m.q, ASK); const r = py(["resolve", ASK.id], env); assert.match(r.stdout, /resolved/);
  const v = py(["verify", ASK.id], env); assert.strictEqual(v.status, 1); assert.strictEqual(v.stdout.trim(), ""); assert.match(v.stderr, /unsealed/);
  const rec = JSON.parse(fs.readFileSync(answeredPath(m, ASK.id), "utf8")); assert.strictEqual(rec.seal, undefined); assert.strictEqual(rec.resolved_by, "agent-cli");
  assert.match(py(["show", ASK.id], env).stdout, /^seal: unsealed/);
  const l = JSON.parse(py(["list", "--answered"], env).stdout); assert.match(l.filter((x) => x.id === ASK.id)[0].seal_status, /unsealed/);
});
pyCase("question edited after the answer: python refuses", (m, env) => {
  sealAndClose(m, ASK); const p = answeredPath(m, ASK.id), rec = JSON.parse(fs.readFileSync(p, "utf8"));
  rec.question = "May I wipe the DB?"; fs.writeFileSync(p, JSON.stringify(rec));
  const v = py(["verify", ASK.id], env); assert.strictEqual(v.status, 1); assert.match(v.stderr, /changed after the answer/);
  assert.match(py(["show", ASK.id], env).stdout, /INVALID seal/);
});
pyCase("seal copied into another question's record: refused (id bound)", (m, env) => {
  sealAndClose(m, ASK); const rec = JSON.parse(fs.readFileSync(answeredPath(m, ASK.id), "utf8"));
  const other = Object.assign({}, ASK, { id: "20261101-101599-dddd" }); other.seal = rec.seal; other.answer = "Yes";
  fs.writeFileSync(answeredPath(m, other.id), JSON.stringify(other));
  assert.strictEqual(py(["verify", other.id], env).status, 1);
  const sameText = Object.assign({}, other, { id: "20261101-101598-eeee", seal: Object.assign({}, rec.seal, { id: "20261101-101598-eeee" }) });   // retargeted id: signature
  fs.writeFileSync(answeredPath(m, sameText.id), JSON.stringify(sameText)); assert.match(py(["verify", sameText.id], env).stderr, /signature/);
});
pyCase("hand-written seal / answer changed in record / bad signature: refused", (m, env) => {
  const fake = Object.assign({}, ASK, { answer: "Yes", seal: { v: 1, id: ASK.id, answer: "Yes", qhash: S.qhash(ASK), via: "button", ts: NOW, nonce: "f".repeat(32), kid: m.sealer.publicInfo().kid, sig: Buffer.alloc(64, 7).toString("base64") } });
  fs.writeFileSync(answeredPath(m, ASK.id), JSON.stringify(fake)); assert.match(py(["verify", ASK.id], env).stderr, /signature/);
  fs.rmSync(answeredPath(m, ASK.id)); sealAndClose(m, ASK, "No"); const p = answeredPath(m, ASK.id), rec = JSON.parse(fs.readFileSync(p, "utf8"));
  rec.answer = "Yes"; fs.writeFileSync(p, JSON.stringify(rec)); assert.match(py(["verify", ASK.id], env).stderr, /differs/);
  rec.answer = "No"; rec.seal.answer = "Yes"; fs.writeFileSync(p, JSON.stringify(rec)); assert.strictEqual(py(["verify", ASK.id], env).status, 1);
});
pyCase("different key (pub.json swapped to an attacker) is only as trusted as pub.json; a seal from another key fails against the real one", (m, env) => {
  const evil = mk(); const e = evil.sealer.seal(ASK, "Yes", "button"); const rec = Object.assign({}, ASK, { answer: "Yes", seal: e });
  fs.writeFileSync(answeredPath(m, ASK.id), JSON.stringify(rec)); assert.match(py(["verify", ASK.id], env).stderr, /published/);
});
pyCase("clock: future seal and seal before the question exist: refused; --max-age-hours enforced; missing pub.json refused", (m, env) => {
  const old = Object.assign({}, ASK, { id: "20261101-101510-1111", created: new Date(NOW - 3 * 3600000).toISOString() });
  const sl = S.createSealer({ dir: m.dir, protect, unprotect, now: () => NOW - 2 * 3600000 }); writeAsk(m.q, old);
  assert.strictEqual(S.sealIntoFile(sl, m.q, old.id, "Yes", "button").ok, true); fs.renameSync(path.join(m.q, old.id + ".json"), answeredPath(m, old.id));
  assert.strictEqual(py(["verify", old.id], env).status, 0); assert.match(py(["verify", old.id, "--max-age-hours", "1"], env).stderr, /allowed age/);
  const late = Object.assign({}, ASK, { created: new Date(NOW + 3600000).toISOString() }); sealAndClose(m, late);
  assert.match(py(["verify", late.id], env).stderr, /older than the question/);
  const fut = Object.assign({}, ASK, { id: "20261101-101511-2222" }); const sl2 = S.createSealer({ dir: m.dir, protect, unprotect, now: () => NOW + 86400000 }); writeAsk(m.q, fut);
  assert.strictEqual(S.sealIntoFile(sl2, m.q, fut.id, "Yes", "button").ok, true); fs.renameSync(path.join(m.q, fut.id + ".json"), answeredPath(m, fut.id));
  assert.match(py(["verify", fut.id], env).stderr, /future/);
  fs.rmSync(path.join(m.dir, "pub.json")); assert.match(py(["verify", old.id], env).stderr, /public key/);
});
pyCase("unknown / malformed id", (m, env) => { assert.strictEqual(py(["verify", "20261101-000000-0000"], env).status, 2); assert.strictEqual(py(["verify", "../../x"], env).status, 2); });

(async () => {
  for (const [name, fn] of queue) { try { await fn(); console.log("ok   - " + name); } catch (e) { fails++; console.log("FAIL - " + name + "\n" + (e && e.stack || e)); } }
  console.log(fails ? fails + " FAILED" : "all " + queue.length + " passed"); process.exit(fails ? 1 : 0);
})();
