// mailsearch.js against a fake Super Search server: token header, company pinning, attachment filter, bounded output, safe open.
"use strict";
const assert = require("assert"), http = require("http"), fs = require("fs"), os = require("os"), path = require("path");
const M = require("../src/contacts/mailsearch");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsearch-"));
const tokenFile = path.join(dir, "token"); const TOKEN = "t".repeat(40); fs.writeFileSync(tokenFile, TOKEN + "\n");
const seen = [];
const rows = [
  { id: 1, subject: "Tripod adapter quote", sender: "Lena", sender_addr: "lena@smallrig.com", ts: 1760000000, has_att: 1 },
  { id: 2, subject: "Re: tripod adapter", sender: "Iddo", sender_addr: "iddo@x.com", ts: 1759000000, has_att: 0 },
  { id: 3, subject: "X".repeat(500), sender: "Z", sender_addr: "z@smallrig.com", ts: 1758000000, has_att: 0 },
];
const srv = http.createServer((req, res) => {
  seen.push({ url: req.url, token: req.headers["x-ss-token"] });
  if (req.headers["x-ss-token"] !== TOKEN) { res.statusCode = 403; return res.end("{}"); }
  const u = new URL(req.url, "http://x");
  res.setHeader("Content-Type", "application/json");
  if (u.pathname === "/search") return res.end(JSON.stringify({ rows: u.searchParams.get("att") === "1" ? rows.filter((r) => r.has_att) : rows }));
  if (u.pathname === "/message") return res.end(JSON.stringify({ message_id: u.searchParams.get("id") === "1" ? "abc@smallrig.com" : "bad id>" }));
  res.statusCode = 404; res.end("{}");
});
(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const env = { port: srv.address().port, tokenFile, betterbird: "bb.exe" };
  const co = { domain: "smallrig.com", aliases: ["SmallRig"] };

  let r = await M.searchMails({ company: co, keywords: 'tripod "adapter"\\', withAtt: true, withoutAtt: true }, env);
  assert.ok(r.ok); assert.strictEqual(r.rows.length, 3);
  assert.ok(/q=smallrig\.com\+?%20?tripod|q=smallrig\.com%20tripod%20adapter/.test(seen[0].url), seen[0].url);
  assert.ok(!/att=1/.test(seen[0].url) && !/%22|%5C/.test(seen[0].url), "no filter when both ticked; quotes and backslashes stripped");
  assert.strictEqual(r.rows[2].subject.length, 200, "subject capped");
  assert.strictEqual(r.rows[0].date, new Date(1760000000 * 1000).toISOString().slice(0, 10));

  r = await M.searchMails({ company: co, keywords: "", withAtt: true, withoutAtt: false }, env);
  assert.deepStrictEqual(r.rows.map((m) => m.id), [1]); assert.ok(/att=1/.test(seen[seen.length - 1].url));
  r = await M.searchMails({ company: co, keywords: "", withAtt: false, withoutAtt: true }, env);
  assert.deepStrictEqual(r.rows.map((m) => m.id), [2, 3]);

  r = await M.searchMails({ company: { domain: null, aliases: [] }, keywords: "x" }, env); assert.strictEqual(r.ok, false);
  r = await M.searchMails({ company: { domain: "evil.com&q=1", aliases: [] }, keywords: "x" }, env); assert.strictEqual(r.ok, false, "odd domain not used");
  r = await M.searchMails({ company: co }, { port: env.port, tokenFile: path.join(dir, "nope") }); assert.ok(!r.ok && /token/.test(r.reason));
  fs.writeFileSync(path.join(dir, "bad"), "short"); r = await M.searchMails({ company: co }, { port: env.port, tokenFile: path.join(dir, "bad") }); assert.ok(!r.ok);
  fs.writeFileSync(path.join(dir, "wrong"), "w".repeat(40)); r = await M.searchMails({ company: co }, { port: env.port, tokenFile: path.join(dir, "wrong") }); assert.ok(!r.ok && /refused/.test(r.reason));
  await new Promise((r2) => srv.close(r2));
  r = await M.searchMails({ company: co }, env); assert.ok(!r.ok && /not running/.test(r.reason));

  // open: only a clean Message-ID is passed, as one argument
  const srv2 = http.createServer((req, res) => { const u = new URL(req.url, "http://x"); res.end(JSON.stringify({ message_id: u.searchParams.get("id") === "1" ? "abc@smallrig.com" : "bad id>" })); });
  await new Promise((r2) => srv2.listen(0, "127.0.0.1", r2));
  const env2 = { port: srv2.address().port, tokenFile, betterbird: "bb.exe" }; let call = null;
  r = await M.openMail(1, env2, (e, a) => { call = [e, a]; }); assert.ok(r.ok); assert.deepStrictEqual(call, ["bb.exe", ["mid:abc@smallrig.com"]]);
  call = null; r = await M.openMail(2, env2, (e, a) => { call = [e, a]; }); assert.ok(!r.ok && !call);
  r = await M.openMail("1; calc", env2, () => { throw new Error("must not run"); }); assert.ok(!r.ok);
  for (const bad of ["-oops@x", "a b", 5, null, ["x"]]) {
    const s3 = http.createServer((q, s) => s.end(JSON.stringify({ message_id: bad }))); await new Promise((r2) => s3.listen(0, "127.0.0.1", r2));
    r = await M.openMail(1, { port: s3.address().port, tokenFile, betterbird: "bb.exe" }, () => { throw new Error("must not run"); }); assert.ok(!r.ok, "odd Message-ID refused: " + JSON.stringify(bad));
    await new Promise((r2) => s3.close(r2));
  }
  // oversized and stalled answers resolve (never hang)
  const big = http.createServer((q, s) => { s.setHeader("Content-Type", "application/json"); s.write("["); const t = setInterval(() => s.write("0,".repeat(1 << 20)), 1); s.on("close", () => clearInterval(t)); });
  await new Promise((r2) => big.listen(0, "127.0.0.1", r2));
  r = await M.searchMails({ company: co }, { port: big.address().port, tokenFile }); assert.ok(!r.ok, "oversized answer ends the search");
  big.closeAllConnections(); await new Promise((r2) => big.close(r2));
  const stall = http.createServer((q, s) => { s.writeHead(200); s.write("{"); });
  await new Promise((r2) => stall.listen(0, "127.0.0.1", r2));
  const t0 = Date.now(); r = await M.searchMails({ company: co }, { port: stall.address().port, tokenFile }); assert.ok(!r.ok && Date.now() - t0 < 12000, "stalled answer ends within the deadline");
  stall.closeAllConnections(); await new Promise((r2) => stall.close(r2));
  await new Promise((r2) => srv2.close(r2));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("contactsMail tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
