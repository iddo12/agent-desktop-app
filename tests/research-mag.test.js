// node tests/research-mag.test.js - MY RESEARCH magazine view (v1.91.0).
// Lead images (src/research/images.js): the SSRF rules (https only, http upgraded, public addresses only - checked before each hop and at
// connect time, every redirect re-checked, max 3 redirects, 8 s, 3 MB, allowed types + magic bytes, svg refused, 2 at a time, 60 a week,
// no cookies, negative cache 24 h, NO network in test mode), the on-disk cache and index, the research-image / research-thread IPCs, the
// prefs (Magazine | List, "This image is wrong"), the service attaching charts, and static guards on the renderer and the css.
// No real network: every transport is faked; the only real DNS use is resolving "localhost" (local) to prove it is refused.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const I = require("../src/research/images");
const MR = require("../src/research/main-research");
const SV = require("../src/research/service");

let n = 0, fails = 0; const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const SRC = path.join(__dirname, "..", "src");
const FX = path.join(__dirname, "fixtures", "research");
const IMGFX = path.join(__dirname, "fixtures", "research-img");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "research-mag-test-"));
const rejects = async (p, code) => { try { await p; } catch (e) { if (code) assert.strictEqual(e.code, code); return; } assert.fail("expected a rejection" + (code ? " " + code : "")); };
const PUB = async () => [{ address: "93.184.216.34", family: 4 }];
const jpeg = fs.readFileSync(path.join(IMGFX, "photo.jpg")), png = fs.readFileSync(path.join(IMGFX, "logo.png"));

// ---------------------------------------------------------------- addresses and URLs
t("private, loopback, link-local, CGNAT, multicast, reserved, ULA, NAT64 and mapped addresses are refused; public ones pass", () => {
  for (const ip of ["10.1.2.3", "127.0.0.1", "127.9.9.9", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.10", "100.64.0.1", "100.127.255.254", "0.0.0.0", "224.0.0.1", "240.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.5",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2001:db8::1", "2002:c0a8:101::1", "not-an-ip", ""])
    assert.strictEqual(I.isPrivateAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::6810:84e5", "::ffff:8.8.8.8"]) assert.strictEqual(I.isPrivateAddress(ip), false, ip);
});
t("normalizeUrl: https only (http upgraded), no credentials, default port, no IP literals or local names; relative URLs resolve", () => {
  assert.strictEqual(I.normalizeUrl("http://example.org/a#x"), "https://example.org/a");
  assert.strictEqual(I.normalizeUrl("https://example.org/img.jpg?x=1"), "https://example.org/img.jpg?x=1");
  assert.strictEqual(I.normalizeUrl("/img/a.png", "https://example.org/post/1"), "https://example.org/img/a.png");
  assert.strictEqual(I.normalizeUrl("//cdn.example.org/a.png", "https://example.org/"), "https://cdn.example.org/a.png");
  for (const u of ["ftp://example.org/a", "file:///C:/x", "javascript:alert(1)", "data:image/png;base64,AAAA", "https://user:pw@example.org/", "https://example.org:8443/", "https://127.0.0.1/", "https://[::1]/", "https://10.0.0.5/x",
    "https://localhost/", "https://printer.local/", "https://intranet/", "https://nas.lan/", "", null, 5, "https://" + "a".repeat(2100) + ".org"]) assert.strictEqual(I.normalizeUrl(u), null, String(u).slice(0, 40));
});
t("assertPublicHost: every resolved address must be public (one private address among public ones is enough to refuse)", async () => {
  await I.assertPublicHost("example.org", PUB);
  await rejects(I.assertPublicHost("evil.example", async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]), "EPRIVATE");
  await rejects(I.assertPublicHost("evil.example", async () => [{ address: "::1", family: 6 }]), "EPRIVATE");
  await rejects(I.assertPublicHost("empty.example", async () => []), "ENOADDR");
});
t("real DNS: 'localhost' resolves locally and is refused by the connect-time guard (no network used)", async () => {
  await rejects(I.assertPublicHost("localhost"), "EPRIVATE");
  await new Promise((res, rej) => I.guardedLookup("localhost", {}, (e) => (e && e.code === "EPRIVATE" ? res() : rej(new Error("not refused")))));
});

// ---------------------------------------------------------------- redirects
function fakeNet(routes, hosts) {
  const calls = [];
  return {
    calls,
    deps: {
      lookupAll: async (h) => { const ip = (hosts || {})[h] || "93.184.216.34"; return [{ address: ip, family: ip.indexOf(":") >= 0 ? 6 : 4 }]; },
      get: async (url, opts) => { calls.push(url); const r = routes[url]; if (!r) return { status: 404, headers: {}, body: Buffer.alloc(0) }; if (r.body && r.body.length > opts.maxBytes) { const e = new Error("ETOOBIG"); e.code = "ETOOBIG"; throw e; } return Object.assign({ headers: {}, body: Buffer.alloc(0) }, r); },
    },
  };
}
t("redirects: each hop is upgraded to https and re-checked; a redirect to a private host, to a non-https scheme or a 4th redirect is refused", async () => {
  let net = fakeNet({ "https://a.example/": { status: 301, headers: { location: "http://b.example/x" } }, "https://b.example/x": { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("ok") } });
  const r = await I.safeGet("http://a.example/", { maxBytes: 1000 }, net.deps);
  assert.strictEqual(r.url, "https://b.example/x"); assert.deepStrictEqual(net.calls, ["https://a.example/", "https://b.example/x"]);
  net = fakeNet({ "https://a.example/": { status: 302, headers: { location: "https://inside.example/" } } }, { "inside.example": "192.168.1.1" });
  await rejects(I.safeGet("https://a.example/", { maxBytes: 1000 }, net.deps), "EPRIVATE");
  assert.deepStrictEqual(net.calls, ["https://a.example/"], "the private host is never requested");
  net = fakeNet({ "https://a.example/": { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } } });
  await rejects(I.safeGet("https://a.example/", { maxBytes: 1000 }, net.deps), "EBADREDIRECT");
  net = fakeNet({ "https://a.example/": { status: 302, headers: { location: "file:///etc/passwd" } } });
  await rejects(I.safeGet("https://a.example/", { maxBytes: 1000 }, net.deps), "EBADREDIRECT");
  const chain = {}; for (let i = 0; i < 6; i++) chain["https://h" + i + ".example/"] = { status: 302, headers: { location: "https://h" + (i + 1) + ".example/" } };
  net = fakeNet(chain);
  await rejects(I.safeGet("https://h0.example/", { maxBytes: 1000 }, net.deps), "EREDIRECTS");
  assert.strictEqual(net.calls.length, 4, "1 request + 3 redirects, then stop");
  net = fakeNet({}, { "a.example": "127.0.0.1" });
  await rejects(I.safeGet("https://a.example/", { maxBytes: 1000 }, net.deps), "EPRIVATE");
  assert.strictEqual(net.calls.length, 0, "the first host is checked before any request");
});

// ---------------------------------------------------------------- page parsing and image checks
t("page -> image: og:image, then twitter:image, then the largest <img> with size attributes; relative/http resolved to https; data: and js: ignored", () => {
  const base = "https://news.example/post/1";
  assert.deepStrictEqual(I.pickImageFromHtml('<head><meta property="og:image" content="/a/og.jpg"><meta name="twitter:image" content="https://news.example/tw.jpg"></head>', base), { url: "https://news.example/a/og.jpg", how: "meta" });
  assert.strictEqual(I.pickImageFromHtml("<meta content='http://cdn.example/t.png' name='twitter:image'>", base).url, "https://cdn.example/t.png");
  assert.strictEqual(I.pickImageFromHtml('<img src="data:image/png;base64,AA" width="900" height="900"><img src="/small.jpg" width="50" height="50"><img src="/big.jpg" width="1200" height="600"><img src="/mid.jpg" width="400" height="300">', base).url, "https://news.example/big.jpg");
  assert.strictEqual(I.pickImageFromHtml('<meta property="og:image" content="javascript:alert(1)">', base), null);
  assert.strictEqual(I.pickImageFromHtml("<p>no images</p>", base), null);
  assert.strictEqual(I.pickImageFromHtml('<meta property="og:image" content="https://10.0.0.1/x.jpg">', base), null, "an IP-literal image URL is refused");
});
t("image bytes: magic must match an allowed type; svg, html-as-png, mismatched type and over 3 MB are refused; sizes are read", () => {
  assert.deepStrictEqual(I.checkImage(jpeg, "image/jpeg"), { ok: true, type: "image/jpeg", w: 640, h: 360 });
  assert.deepStrictEqual(I.checkImage(png, "image/png; charset=binary"), { ok: true, type: "image/png", w: 300, h: 120 });
  assert.strictEqual(I.checkImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>      "), "image/svg+xml").reason, "svg");
  assert.strictEqual(I.checkImage(fs.readFileSync(path.join(IMGFX, "notreally.png")), "image/png").reason, "not-an-image");
  assert.strictEqual(I.checkImage(jpeg, "image/png").reason, "type-mismatch");
  assert.strictEqual(I.checkImage(jpeg, "text/html").reason, "type-not-allowed");
  assert.strictEqual(I.checkImage(Buffer.concat([jpeg, Buffer.alloc(I.constants.MAX_IMAGE_BYTES)]), "image/jpeg").reason, "too-big");
  assert.deepStrictEqual(I.dims(jpeg, "image/jpeg"), { w: 640, h: 360 });
  assert.deepStrictEqual(I.dims(png, "image/png"), { w: 300, h: 120 });
  const gif = Buffer.from("474946383961" + "0a00" + "0500" + "000000000000", "hex");
  assert.strictEqual(I.sniff(gif), "image/gif"); assert.deepStrictEqual(I.dims(gif, "image/gif"), { w: 10, h: 5 });
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8X"), Buffer.alloc(8), Buffer.from([199, 0, 0, 99, 0, 0])]);
  assert.strictEqual(I.sniff(webp), "image/webp"); assert.deepStrictEqual(I.dims(webp, "image/webp"), { w: 200, h: 100 });
  assert.strictEqual(I.looksLikeLogo("https://x.example/brand-logo.jpg", "image/jpeg", 1200, 630), true);
  assert.strictEqual(I.looksLikeLogo("https://x.example/hero.jpg", "image/jpeg", 1200, 630), false);
});
t("decompression bombs: more than 6000 px a side or 24 Mpx is refused, and so is an image whose size cannot be read", () => {
  const pngOf = (w, h) => { const b = Buffer.from(png); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  assert.strictEqual(I.checkImage(pngOf(50000, 50000), "image/png").reason, "too-many-pixels");
  assert.strictEqual(I.checkImage(pngOf(6001, 10), "image/png").reason, "too-many-pixels");
  assert.strictEqual(I.checkImage(pngOf(5000, 5000), "image/png").reason, "too-many-pixels", "25 Mpx");
  assert.strictEqual(I.checkImage(pngOf(6000, 4000), "image/png").ok, true, "24 Mpx exactly is fine");
  assert.strictEqual(I.checkImage(pngOf(0, 0), "image/png").reason, "size-unknown");
  const gifBomb = Buffer.from("474946383961" + "ffff" + "ffff" + "000000000000", "hex");
  assert.strictEqual(I.checkImage(gifBomb, "image/gif").reason, "too-many-pixels");
});
t("B1: the HTML scan is linear and head-only - hostile 768 KB pages (unclosed <meta / <img openers) take milliseconds", () => {
  for (const unit of ["<meta ", "<img ", "<meta property=og:image content=", "<", "<meta\t", "<IMG src=x width=999 height=999 "]) {
    const page = unit.repeat(Math.ceil(I.constants.MAX_HTML_BYTES / unit.length)).slice(0, I.constants.MAX_HTML_BYTES);
    const t0 = process.hrtime.bigint();
    I.pickImageFromHtml(page, "https://news.example/");
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 50, JSON.stringify(unit) + " took " + ms.toFixed(1) + " ms");
  }
  const closed = '<meta name="x" content="y">'.repeat(30000);
  const t1 = process.hrtime.bigint(); I.pickImageFromHtml(closed, "https://news.example/"); assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 50, "many closed tags");
  assert.strictEqual(I.pickImageFromHtml(" ".repeat(70 * 1024) + '<meta property="og:image" content="/late.jpg">', "https://n.example/"), null, "only the first 64 KB is read");
  assert.strictEqual(I.pickImageFromHtml('<head><title>x</title></head><body><meta property="og:image" content="/body.jpg">', "https://n.example/"), null, "a meta outside the head is not trusted");
  assert.strictEqual(I.pickImageFromHtml('<HEAD><META PROPERTY="og:image" CONTENT="/a.jpg"></HEAD>', "https://n.example/").url, "https://n.example/a.jpg");
  assert.strictEqual(I.pickImageFromHtml('<meta property="og:image" content="https://cdn.example/a&amp;b.jpg?x=1&#38;y=2">', "https://n.example/").url, "https://cdn.example/a&b.jpg?x=1&y=2");
});
t("source of the image: the FIRST primary source, else the first source with a URL; nothing usable -> null", () => {
  assert.strictEqual(I.sourceUrlOf({ sources: [{ url: "https://a.example/1", kind: "secondary" }, { url: "https://p.example/2", kind: "primary" }, { url: "https://p.example/3", kind: "primary" }] }), "https://p.example/2");
  assert.strictEqual(I.sourceUrlOf({ sources: [{ url: "", kind: "primary" }, { url: "http://a.example/1", kind: "secondary" }] }), "https://a.example/1");
  assert.strictEqual(I.sourceUrlOf({ sources: [{ url: "not a url", kind: "primary" }] }), null);
  assert.strictEqual(I.sourceUrlOf({}), null);
  assert.strictEqual(I.sourceUrlOf({ sources: [{ url: "https://a.example/reset?token=abc123", kind: "primary" }] }), null, "privacy: a one-time / signed link is never fetched");
  assert.strictEqual(I.sourceUrlOf({ sources: [{ url: "https://a.example/x?X-Amz-Signature=1", kind: "primary" }] }), null);
  assert.strictEqual(I.sourceUrlOf({ sources: [{ url: "https://a.example/x?q=" + "a".repeat(300), kind: "primary" }] }), null);
  assert.strictEqual(I.sourceUrlOf({ sources: [{ url: "https://a.example/news?id=5&page=2", kind: "primary" }] }), "https://a.example/news?id=5&page=2");
});

// ---------------------------------------------------------------- the cache
function cache(extra) {
  const dir = path.join(tmp(), "research_images");
  let clock = Date.parse("2026-10-08T10:00:00Z");
  const c = I.createImageCache(Object.assign({ dir, now: () => clock }, extra || {}));
  return { c, dir, tick: (ms) => { clock += ms; } };
}
t("test mode: NO network at all - fixtures only; cached file + index (source, fetchedAt, type, w, h); served from disk afterwards", async () => {
  // the real modules are stubbed to throw: test mode must never reach https or dns
  const https = require("https"), dns = require("dns"), saved = [https.request, https.get, dns.lookup];
  https.request = https.get = () => { throw new Error("https used in test mode"); }; dns.lookup = () => { throw new Error("dns used in test mode"); };
  try { await testModeBody(); } finally { [https.request, https.get, dns.lookup] = saved; }
});
async function testModeBody() {
  const fixtures = JSON.parse(fs.readFileSync(path.join(IMGFX, "fixtures.json"), "utf8"));
  const { c, dir } = cache({ testMode: true, fixtures, fixturesDir: IMGFX, deps: { get: () => { throw new Error("network used in test mode"); }, lookupAll: () => { throw new Error("dns used in test mode"); } } });
  const r = await c.get({ week: "2026-W41", source: "https://example.org/p" });
  assert.strictEqual(r.ok, true); assert.ok(/^file:\/\//.test(r.url)); assert.strictEqual(r.domain, "example.org"); assert.strictEqual(r.w, 640);
  const sha = require("crypto").createHash("sha1").update("https://example.org/p").digest("hex");
  assert.ok(fs.existsSync(path.join(dir, sha + ".jpg")), "file named by sha1 of the source URL");
  c.flush();
  const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  assert.deepStrictEqual(Object.keys(idx[sha]).sort(), ["domain", "fetchedAt", "h", "how", "image", "logo", "source", "type", "w"].sort());
  assert.strictEqual(idx[sha].source, "https://example.org/p"); assert.strictEqual(idx[sha].type, "image/jpeg");
  fixtures["example.org"] = "missing.jpg";
  assert.strictEqual((await c.get({ week: "2026-W41", source: "https://example.org/p" })).ok, true, "fetched once: the second call is served from the cache");
  assert.strictEqual((await c.get({ week: "2026-W41", source: "https://logo.example.org/x" })).logo, true, "a small PNG is drawn as a logo (contain)");
  assert.strictEqual((await c.get({ week: "2026-W41", source: "https://fake.example.org/x" })).reason, "not-an-image");
  assert.strictEqual((await c.get({ week: "2026-W41", source: "https://svg.example.org/x" })).reason, "svg");
}
t("negative cache: a failure is remembered for 24 h (no retry), then tried again", async () => {
  const fixtures = {};
  const { c, tick } = cache({ testMode: true, fixtures, fixturesDir: IMGFX });
  assert.strictEqual((await c.get({ week: "w", source: "https://later.example/a" })).ok, false);
  fixtures["later.example"] = "photo.jpg";
  const again = await c.get({ week: "w", source: "https://later.example/a" });
  assert.strictEqual(again.ok, false); assert.strictEqual(again.cached, true);
  tick(23 * 3600 * 1000); assert.strictEqual((await c.get({ week: "w", source: "https://later.example/a" })).cached, true);
  tick(2 * 3600 * 1000); assert.strictEqual((await c.get({ week: "w", source: "https://later.example/a" })).ok, true, "after 24 h it is tried again");
});
t("network mode (faked): page -> og:image -> image; at most 2 at a time; at most 60 network fetches per week; same source shares one fetch", async () => {
  let active = 0, peak = 0, pageGets = 0;
  const deps = {
    lookupAll: PUB,
    get: async (url) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (/\/img\.jpg$/.test(url)) return { status: 200, headers: { "content-type": "image/jpeg" }, body: jpeg };
      pageGets++;
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from('<meta property="og:image" content="/img.jpg">') };
    },
  };
  const { c } = cache({ deps });
  const rs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => c.get({ week: "2026-W41", source: "https://s" + i + ".example/p" })));
  assert.ok(rs.every((r) => r.ok), JSON.stringify(rs.find((r) => !r.ok)));
  assert.ok(peak <= 2, "peak concurrency " + peak);
  const before = pageGets;
  await Promise.all([c.get({ week: "2026-W41", source: "https://same.example/p" }), c.get({ week: "2026-W41", source: "https://same.example/p" })]);
  assert.strictEqual(pageGets - before, 1, "two cards with the same source share one fetch");
  const { c: c2 } = cache({ deps: { lookupAll: PUB, get: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }) } });
  for (let i = 0; i < 60; i++) await c2.get({ week: "2026-W41", source: "https://cap" + i + ".example/" });
  assert.strictEqual((await c2.get({ week: "2026-W41", source: "https://cap60.example/" })).reason, "week-cap");
  assert.strictEqual((await c2.get({ week: "2026-W42", source: "https://cap60.example/" })).reason, "EHTTP404", "the cap is per week");
});
t("network mode (faked): an html page that claims to be an image, a private og:image host, an oversized image all end as a data card (failure)", async () => {
  const { c } = cache({ deps: { lookupAll: async (h) => [{ address: h === "inner.example" ? "10.0.0.8" : "93.184.216.34", family: 4 }], get: async (url) => {
    if (url === "https://p1.example/") return { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from('<meta property="og:image" content="https://inner.example/x.jpg">') };
    if (url === "https://p2.example/") return { status: 200, headers: { "content-type": "image/png" }, body: Buffer.from("<html>" + " ".repeat(40)) };
    if (url === "https://p3.example/") { const e = new Error("ETOOBIG"); e.code = "ETOOBIG"; throw e; }
    return { status: 404, headers: {}, body: Buffer.alloc(0) };
  } } });
  assert.strictEqual((await c.get({ week: "w", source: "https://p1.example/" })).reason, "EPRIVATE");
  assert.strictEqual((await c.get({ week: "w", source: "https://p2.example/" })).reason, "not-an-image");
  assert.strictEqual((await c.get({ week: "w", source: "https://p3.example/" })).reason, "ETOOBIG");
});
// ---------------------------------------------------------------- REAL transport against a local TLS server (no internet)
const TLS = require("./helpers/selfcert").makeCert({ days: 1 });   // made in memory per run: CA:FALSE, 1 day, never committed
const loopLookup = (host, opts, cb) => { if (typeof opts === "function") { cb = opts; opts = {}; } if (opts && opts.all) cb(null, [{ address: "127.0.0.1", family: 4 }]); else cb(null, "127.0.0.1", 4); };
function tlsServer(handler) {
  const https = require("https");
  const st = { conns: 0, headers: [], closed: [] };
  const srv = https.createServer(TLS, (req, res) => { st.headers.push(req.headers); res.on("close", () => st.closed.push(req.url)); handler(req, res); });
  srv.on("connection", () => st.conns++);
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(Object.assign(st, { srv, url: (p) => "https://localhost:" + srv.address().port + p, close: () => new Promise((c) => { if (srv.closeAllConnections) srv.closeAllConnections(); srv.close(() => c()); }) }))));
}
const realGet = (u, o) => I.httpsGet(u, Object.assign({ lookup: loopLookup, ca: TLS.cert, accept: "image/png" }, o));
const timed = async (p) => { const t0 = Date.now(); try { return { r: await p, ms: Date.now() - t0 }; } catch (e) { return { e, ms: Date.now() - t0 }; } };
t("real transport: the connect-time guard refuses localhost before any TCP connection (DNS rebinding closed)", async () => {
  const s = await tlsServer((req, res) => res.end("x"));
  try {
    const x = await timed(I.httpsGet(s.url("/a"), { maxBytes: 1000, ca: TLS.cert }));   // default lookup = guardedLookup
    assert.strictEqual(x.e && x.e.code, "EPRIVATE"); assert.strictEqual(s.conns, 0, "no TCP connection was made");
  } finally { await s.close(); }
});
t("real transport: size cap (chunked and Content-Length), total deadline (slowloris, no headers), redirect bodies destroyed, plain headers", async () => {
  const big = Buffer.alloc(64 * 1024, 1);
  const s = await tlsServer((req, res) => {
    const u = req.url;
    res.on("error", () => {});
    if (u === "/ok") { res.writeHead(200, { "content-type": "image/png" }); return res.end(png); }
    if (u === "/chunked") { res.writeHead(200, { "content-type": "image/png" }); let i = 0; const w = () => { while (i < 80 && !res.destroyed) { i++; if (!res.write(big)) return res.once("drain", w); } res.end(); }; return w(); }
    if (u === "/cl-big") { res.writeHead(200, { "content-type": "image/png", "content-length": String(50 * 1024 * 1024) }); return res.write("x"); }
    if (u === "/slow") { res.writeHead(200, { "content-type": "image/png" }); const iv = setInterval(() => { try { res.write("a"); } catch (e) { clearInterval(iv); } }, 50); res.on("close", () => clearInterval(iv)); return; }
    if (u === "/noheaders") return;
    if (u === "/redir") { res.writeHead(302, { location: "https://example.org/x", "set-cookie": "a=b" }); let i = 0; const w = () => { while (i < 400 && !res.destroyed) { i++; if (!res.write(big)) return res.once("drain", w); } res.end(); }; return w(); }
    res.writeHead(404); res.end();
  });
  try {
    const ok = await realGet(s.url("/ok"), { maxBytes: 3 << 20 });
    assert.strictEqual(ok.status, 200); assert.ok(ok.body.equals(png));
    let x = await timed(realGet(s.url("/chunked"), { maxBytes: 3 << 20 }));
    assert.strictEqual(x.e && x.e.code, "ETOOBIG"); assert.ok(x.ms < 3000, "cut at the cap: " + x.ms + " ms");
    x = await timed(realGet(s.url("/cl-big"), { maxBytes: 3 << 20 }));
    assert.strictEqual(x.e && x.e.code, "ETOOBIG"); assert.ok(x.ms < 2000);
    x = await timed(realGet(s.url("/slow"), { maxBytes: 3 << 20, timeoutMs: 400 }));
    assert.strictEqual(x.e && x.e.code, "ETIMEOUT"); assert.ok(x.ms >= 380 && x.ms < 1500, "a total deadline even while bytes keep trickling: " + x.ms + " ms");
    x = await timed(realGet(s.url("/noheaders"), { maxBytes: 3 << 20, timeoutMs: 400 }));
    assert.strictEqual(x.e && x.e.code, "ETIMEOUT"); assert.ok(x.ms < 1500);
    x = await timed(realGet(s.url("/redir"), { maxBytes: 3 << 20 }));
    assert.ok(x.r, x.e && x.e.message);
    assert.strictEqual(x.r.status, 302); assert.strictEqual(x.r.body.length, 0); assert.strictEqual(x.r.headers.location, "https://example.org/x");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(s.closed.indexOf("/redir") >= 0, "the 25 MB redirect body is not drained: the response is destroyed at once");
    const h = s.headers[0];
    assert.ok(!h.cookie && !h.authorization, "no cookie or credential header");
    assert.strictEqual(h["user-agent"], I.constants.UA); assert.strictEqual(h["accept-encoding"], "identity");
    assert.strictEqual(I.constants.TIMEOUT_MS, 8000); assert.strictEqual(I.constants.MAX_IMAGE_BYTES, 3 * 1024 * 1024);
  } finally { await s.close(); }
});
t("safeGet: the whole redirect chain shares one deadline (15 s in the app)", async () => {
  let clock = 0;
  const deps = { lookupAll: PUB, now: () => clock, chainMs: 1000, get: async (u, o) => { clock += 600; assert.ok(o.timeoutMs <= 1000); return { status: 302, headers: { location: "https://b.example/" + clock } }; } };
  await rejects(I.safeGet("https://a.example/", { maxBytes: 10 }, deps), "ETIMEOUT");
  assert.strictEqual(I.constants.CHAIN_MS, 15000);
});
t("IPv6 and host-name gaps from the review are closed (translated v4, discard, ORCHID, trailing dot)", () => {
  for (const ip of ["::ffff:0:127.0.0.1", "::ffff:0:10.0.0.1", "100::1", "2001:10::1", "2001:1f::1", "2001:20::1", "2001:2f::1"]) assert.strictEqual(I.isPrivateAddress(ip), true, ip);
  for (const u of ["https://localhost./", "https://printer.local./", "https://nas.lan./x"]) assert.strictEqual(I.normalizeUrl(u), null, u);
});

// ---------------------------------------------------------------- cache housekeeping
t("cache: only the map key is trusted (a poisoned index entry cannot point outside the cache); size cap and 12-week age sweep; persisted week counter", async () => {
  const { c, dir } = cache({ testMode: true, fixtures: { "example.org": "photo.jpg" }, fixturesDir: IMGFX });
  await c.get({ week: "2026-W41", source: "https://example.org/p" }); c.flush();
  const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  const k = Object.keys(idx)[0];
  idx["..\\..\\evil"] = Object.assign({}, idx[k], { sha: "..\\..\\x" });
  idx[k].sha = "..\\..\\x"; idx[k].type = "text/html";
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(idx));
  const c2 = I.createImageCache({ dir, testMode: true, fixtures: {}, fixturesDir: IMGFX, now: () => Date.parse("2026-10-08T11:00:00Z") });
  const r = await c2.get({ week: "2026-W41", source: "https://example.org/p" });
  assert.strictEqual(r.ok, false, "an entry with a bad type is dropped, never served"); c2.flush();
  assert.ok(!Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"))).some((x) => !/^[0-9a-f]{40}$/.test(x)), "bad keys swept");
  const counts = JSON.parse(fs.readFileSync(path.join(dir, "counters.json"), "utf8"));
  assert.strictEqual(counts["2026-W41"].length, 2, "the week counter (timestamps) survives a restart");
  const d3 = path.join(tmp(), "ri"); let clock = Date.parse("2026-01-01T00:00:00Z");
  const c3 = I.createImageCache({ dir: d3, testMode: true, fixtures: { "a.example": "photo.jpg", "b.example": "photo.jpg", "c.example": "photo.jpg" }, fixturesDir: IMGFX, now: () => clock });
  await c3.get({ week: "w1", source: "https://a.example/" }); clock += 3600e3;
  await c3.get({ week: "w1", source: "https://b.example/" }); clock += 3600e3;
  await c3.get({ week: "w1", source: "https://c.example/" }); c3.flush();
  const sz = fs.statSync(path.join(IMGFX, "photo.jpg")).size;
  const c4 = I.createImageCache({ dir: d3, testMode: true, fixtures: {}, fixturesDir: IMGFX, now: () => clock, maxCacheBytes: sz * 2 + 10 });
  assert.strictEqual((await c4.get({ week: "w1", source: "https://a.example/" })).ok, false, "the oldest is evicted over the size cap");
  assert.strictEqual((await c4.get({ week: "w1", source: "https://c.example/" })).ok, true, "newer ones stay");
  c4.flush();
  const c5 = I.createImageCache({ dir: d3, testMode: true, fixtures: {}, fixturesDir: IMGFX, now: () => clock + 13 * 7 * 24 * 3600e3 });
  assert.strictEqual((await c5.get({ week: "w1", source: "https://c.example/" })).ok, false, "older than 12 weeks: removed");
  assert.ok(!fs.readdirSync(d3).some((f) => /\.tmp$/.test(f)), "atomic writes leave no temp files");
});
t("cancel(): fetches still waiting for a slot give up when the tab closes; the running ones finish", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const deps = { lookupAll: PUB, get: async (url) => { await gate; return /img/.test(url) ? { status: 200, headers: { "content-type": "image/jpeg" }, body: jpeg } : { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from('<meta property="og:image" content="/img.jpg">') }; } };
  const { c } = cache({ deps });
  const ps = [1, 2, 3, 4].map((i) => c.get({ week: "w", source: "https://q" + i + ".example/" }));
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(c.stats().queued, 2);
  c.cancel(); release();
  const rs = await Promise.all(ps);
  assert.deepStrictEqual(rs.map((r) => r.ok || r.reason), [true, true, "ECANCELLED", "ECANCELLED"]);
  assert.strictEqual(c.stats().weeks.w, 2, "cancelled fetches do not count against the week");
});
t("S1: findFinding uses the memoised week (no re-parse per image); hostile figure text stays cheap", () => {
  const d = tmp(); fs.mkdirSync(path.join(d, "2026-W41"));
  const hostile = "1->".repeat(2000);
  const findings = []; for (let i = 0; i < 80; i++) findings.push({ id: "h" + i, title: "t" + i, whatChanged: hostile, soWhat: hostile, sources: [] });
  fs.writeFileSync(path.join(d, "2026-W41", "Evil Agent.json"), JSON.stringify({ agent: "Evil Agent", week: "2026-W41", findings }));
  const s = SV.createService({ researchDir: d });
  let t0 = Date.now(); s.load(); const first = Date.now() - t0;
  assert.ok(first < 80 * 10, "80 hostile findings parsed in " + first + " ms (< 10 ms each)");
  t0 = Date.now(); for (let i = 0; i < 20; i++) assert.ok(s.findFinding("2026-W41", "Evil Agent", "h" + i)); const later = Date.now() - t0;
  assert.ok(later < 250, "20 findFinding calls on the memoised week: " + later + " ms"); // 250 ms: a re-parse per call would cost 20x the first load (hundreds of ms); 50 ms flaked when the machine was busy
  const F = require("../src/research/figures");
  t0 = process.hrtime.bigint(); F.chartFor({ title: "x", whatChanged: hostile, soWhat: hostile }); assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 10);
  findings[0].title = "changed"; fs.writeFileSync(path.join(d, "2026-W41", "Evil Agent.json"), JSON.stringify({ agent: "Evil Agent", week: "2026-W41", findings, x: 1 }));
  assert.strictEqual(s.findFinding("2026-W41", "Evil Agent", "h0").title, "changed", "a changed file is parsed again");
});
t("bidi override characters are removed from every digest string (titles, agent names)", () => {
  const f = SV.normFinding({ id: "x", title: "abc‮def⁦g", soWhat: "s‭t", sources: [] }, 0);
  assert.strictEqual(f.title, "abcdefg"); assert.strictEqual(f.soWhat, "st");
});

// ---------------------------------------------------------------- v1.95.1 follow-up (Security's second look)
t("test TLS: the certificate is made in memory per run - an ordinary server cert (CA:FALSE, localhost + 127.0.0.1, <= 30 days); none in the repo", () => {
  const x = new (require("crypto").X509Certificate)(TLS.cert);
  assert.strictEqual(x.ca, false);
  assert.ok(/DNS:localhost/.test(x.subjectAltName) && /127\.0\.0\.1/.test(x.subjectAltName), x.subjectAltName);
  assert.ok(Date.parse(x.validTo) - Date.now() <= 30 * 86400e3, "short-lived: " + x.validTo);
  assert.ok(!fs.existsSync(path.join(__dirname, "fixtures", "tls")), "no committed TLS key or certificate");
});
t("token-style links: whole decoded parameter names, path tokens and ;jsessionid are never fetched; ordinary parameters are fine", () => {
  const bad = ["https://a.example/r?token=x", "https://a.example/r?access_token=x", "https://a.example/r?X-Amz-Signature=1", "https://a.example/r?x-goog-signature=1",
    "https://a.example/r?%74oken=x", "https://a.example/r?jwt=x", "https://a.example/r?hmac=x", "https://a.example/r?nonce=1", "https://a.example/r?ticket=ST-1",
    "https://a.example/r?signature=x", "https://a.example/r?sig=x", "https://a.example/r?Expires=1700000000", "https://a.example/r?api_key=x", "https://a.example/r?key=x",
    "https://a.example/r?password=x", "https://a.example/app;jsessionid=ABC123?x=1", "https://a.example/r/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sflKxwRJSMeKKF2QT4fw",
    "https://a.example/files/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "https://a.example/d/Xk3pQ9vL2mR7tY4wB8nC1zA6sD5fG0hJ",
    "https://a.example/reset/abc123def456ghi", "https://a.example/r?q=" + "a".repeat(300)];
  for (const u of bad) assert.strictEqual(I.tokenLike(u), true, u);
  const good = ["https://a.example/r?keyword=lens", "https://a.example/r?sidebar=1", "https://a.example/r?author=jo", "https://a.example/r?code=en",
    "https://a.example/r?sid=5", "https://a.example/r?accessibility=on", "https://a.example/news?id=5&page=2", "https://a.example/2026/10/youtube-view-count-from-first-frame-2026-08-24",
    "https://a.example/r?monkey=1", "https://a.example/r?ticketing=info", "https://a.example/r?utm_source=x&utm_medium=y"];
  for (const u of good) assert.strictEqual(I.tokenLike(u), false, u);
});
t("week cap is SLIDING: 60 network fetches per week in any 24 h (persisted), then allowed again", async () => {
  const { c, tick, dir } = cache({ deps: { lookupAll: PUB, get: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }) } });
  for (let i = 0; i < 60; i++) { await c.get({ week: "2026-W41", source: "https://s" + i + ".example/" }); tick(60e3); }
  assert.strictEqual((await c.get({ week: "2026-W41", source: "https://next.example/" })).reason, "week-cap");
  c.flush();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "counters.json"), "utf8"))["2026-W41"].length, 60, "timestamps persisted");
  tick(23.5 * 3600e3);
  assert.strictEqual((await c.get({ week: "2026-W41", source: "https://next.example/" })).reason, "EHTTP404", "the oldest fetches left the 24 h window");
  assert.ok(c.stats().weeks["2026-W41"] < 60);
});
t("cache cleanup runs every 20 new images and at quit (close), not only at startup", async () => {
  const sz = fs.statSync(path.join(IMGFX, "photo.jpg")).size;
  const fixtures = {}; for (let i = 0; i < 25; i++) fixtures["p" + i + ".example"] = "photo.jpg";
  const dir = path.join(tmp(), "ri"); let clock = Date.parse("2026-10-01T00:00:00Z");
  const c = I.createImageCache({ dir, testMode: true, fixtures, fixturesDir: IMGFX, now: () => clock, maxCacheBytes: sz * 5 + 10 });
  for (let i = 0; i < 25; i++) { await c.get({ week: "w", source: "https://p" + i + ".example/" }); clock += 1000; }
  const files = () => fs.readdirSync(dir).filter((f) => /\.jpg$/.test(f)).length;
  assert.ok(files() <= 10, "swept during the run (at the 20th insert): " + files() + " files");
  c.close();
  assert.ok(files() <= 5, "close() sweeps down to the cap: " + files());
  const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  assert.strictEqual(Object.values(idx).filter((e) => !e.failed).length, files(), "index and files agree after close()");
});
t("the DNS check runs inside the redirect-chain budget (a resolver that never answers ends with ETIMEOUT)", async () => {
  const t0 = Date.now();
  await rejects(I.safeGet("https://hang.example/", { maxBytes: 10 }, { chainMs: 300, lookupAll: () => new Promise(() => {}), get: async () => { throw new Error("must not get here"); } }), "ETIMEOUT");
  assert.ok(Date.now() - t0 < 1500, (Date.now() - t0) + " ms");
});
t("GIF: every frame is checked (a frame larger than the screen, too many frames or too many pixels in all is refused)", () => {
  const head = (w, h) => { const b = Buffer.alloc(13); b.write("GIF89a", 0, "latin1"); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
  const frame = (w, h) => { const d = Buffer.alloc(10); d[0] = 0x2c; d.writeUInt16LE(w, 5); d.writeUInt16LE(h, 7); return Buffer.concat([d, Buffer.from([2, 1, 0, 0])]); };
  const gif = (w, h, frames) => Buffer.concat([head(w, h), ...frames, Buffer.from([0x3b])]);
  assert.strictEqual(I.checkImage(gif(10, 5, [frame(10, 5)]), "image/gif").ok, true);
  assert.strictEqual(I.checkImage(gif(10, 5, [frame(60000, 60000)]), "image/gif").reason, "too-many-pixels", "frame bigger than the screen");
  assert.strictEqual(I.checkImage(gif(4000, 4000, Array.from({ length: 8 }, () => frame(4000, 4000))), "image/gif").reason, "too-many-pixels", "8 x 16 Mpx frames");
  assert.strictEqual(I.checkImage(gif(10, 10, Array.from({ length: 1001 }, () => frame(1, 1))), "image/gif").reason, "too-many-pixels", "over 1000 frames");
  const ext = Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]);
  assert.strictEqual(I.checkImage(gif(10, 5, [ext, frame(10, 5), ext, frame(10, 5)]), "image/gif").ok, true, "extensions are skipped");
  assert.strictEqual(I.checkImage(Buffer.concat([head(10, 5), Buffer.from([0x99, 0, 0, 0])]), "image/gif").reason, "too-many-pixels", "malformed block");
});
t("stale digest: a same-size rewrite with the same mtime is still re-read (mtime + size + head/tail hash)", () => {
  const d = tmp(); fs.mkdirSync(path.join(d, "2026-W41"));
  const f = path.join(d, "2026-W41", "Same Agent.json");
  const body = (title) => JSON.stringify({ agent: "Same Agent", week: "2026-W41", findings: [{ id: "s1", title, soWhat: "x", sources: [] }] });
  fs.writeFileSync(f, body("AAAA title")); fs.utimesSync(f, 1700000000, 1700000000);
  const st = fs.statSync(f);
  const s = SV.createService({ researchDir: d });
  assert.strictEqual(s.findFinding("2026-W41", "Same Agent", "s1").title, "AAAA title");
  fs.writeFileSync(f, body("BBBB title")); fs.utimesSync(f, 1700000000, 1700000000);
  assert.strictEqual(fs.statSync(f).size, st.size); assert.strictEqual(fs.statSync(f).mtimeMs, st.mtimeMs);
  assert.strictEqual(s.findFinding("2026-W41", "Same Agent", "s1").title, "BBBB title");
});

t("css v1.95.1: cards keep their own height (no stretched gaps), chips on one row where they fit, hero photo at most 420 px (cover, top)", () => {
  const css = fs.readFileSync(path.join(SRC, "renderer", "styles-research-mag.css"), "utf8");
  assert.ok(/\.rm-grid \{[^}]*align-items: start;/.test(css), "grid rows do not stretch");
  assert.ok(!/\.rm-art \.rm-reply \{ margin-top: auto; \}/.test(css));
  assert.ok(/\.rm-chips \{[^}]*flex-wrap: nowrap;[^}]*gap: 4px;/.test(css) && /\.rm-chips \.rm-by \{[^}]*flex: 0 1 auto;/.test(css) && /text-overflow: ellipsis/.test(css));
  assert.ok(/\.rm-hero\.rm-hero-img \.rm-media \{[^}]*max-height: 420px;/.test(css) && /object-fit: cover; object-position: center top;/.test(css));
  const js = fs.readFileSync(path.join(SRC, "renderer", "research.js"), "utf8");
  assert.ok(/b\.title = t;/.test(js), "a shrunk writer chip keeps its full text as a tooltip");
});
// ---------------------------------------------------------------- IPC
function world(opts) {
  const o = opts || {};
  const handlers = {}, calls = { resolve: 0 };
  const wc = { mainFrame: {} }, win = { webContents: wc, isDestroyed: () => false };
  const d = tmp(); fs.cpSync(FX, d, { recursive: true });
  const ud = tmp();
  MR.init({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, getMainWindow: () => win, workspaceRoot: path.join(d, "ws"), userData: ud, testMode: o.testMode !== false, log: () => {}, env: { AGENT_DESKTOP_RESEARCH_DIR: d, AGENT_DESKTOP_RESEARCH_IMG_FIXTURES: IMGFX },
    resolveAgent: (name) => { calls.resolve++; return name === "Alpha Agent" ? path.join(d, "ws", "Alpha Agent") : null; }, imageDeps: o.imageDeps });
  return { handlers, good: { sender: wc, senderFrame: wc.mainFrame }, d, ud, calls };
}
t("ipc: the allow-list now has research-image and research-thread; both refuse other frames and bad arguments", async () => {
  const w = world();
  assert.deepStrictEqual(Object.keys(w.handlers).sort(), ["recs-load", "recs-write", "research-badge", "research-export", "research-idea", "research-image", "research-image-cancel", "research-load", "research-mark", "research-open", "research-prefs-get", "research-prefs-set", "research-seen", "research-seen-all", "research-thread", "research-write", "skills-load"]);
  for (const ch of ["research-image", "research-thread"]) {
    assert.strictEqual((await w.handlers[ch]({ sender: {}, senderFrame: {} }, { week: "2026-W41", agent: "Alpha Agent", findingId: "a-high" })).ok, false, ch + " other sender");
    for (const bad of [null, {}, { week: "bad", agent: "Alpha Agent", findingId: "a-high" }, { week: "2026-W41", agent: "", findingId: "a-high" }, { week: "2026-W41", agent: "Alpha Agent", findingId: "" }, { week: "2026-W41", agent: "Alpha Agent", findingId: "x".repeat(3000) }])
      assert.strictEqual((await w.handlers[ch](w.good, bad)).ok, false, ch + " " + JSON.stringify(bad).slice(0, 40));
  }
});
t("ipc research-image: the source URL is read from the digest in main (renderer sends week/agent/id only); a file URL under userData comes back", async () => {
  const w = world();
  const r = await w.handlers["research-image"](w.good, { week: "2026-W41", agent: "Alpha Agent", findingId: "a-high" });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(/^file:\/\//.test(r.url) && decodeURIComponent(r.url).replace(/\//g, "\\").toLowerCase().indexOf(path.join(w.ud, "research_images").toLowerCase()) >= 0, r.url);
  assert.strictEqual((await w.handlers["research-image"](w.good, { week: "2026-W41", agent: "Alpha Agent", findingId: "nope" })).reason, "unknown-finding");
  assert.strictEqual((await w.handlers["research-image"](w.good, { week: "2026-W41", agent: "Alpha Agent", findingId: "a-high", url: "https://10.0.0.1/" })).ok, true, "an extra url field is simply ignored");
});
t("ipc prefs: Magazine is the default, List is remembered; 'This image is wrong' is stored per finding and then no image is served", async () => {
  const w = world();
  const p0 = (await w.handlers["research-prefs-get"](w.good)).prefs;
  assert.strictEqual(p0.view, "magazine"); assert.deepStrictEqual(p0.imageWrong, []);
  assert.strictEqual((await w.handlers["research-prefs-set"](w.good, { view: "grid" })).ok, false);
  assert.strictEqual((await w.handlers["research-prefs-set"](w.good, { view: "list" })).ok, true);
  assert.strictEqual((await w.handlers["research-prefs-get"](w.good)).prefs.view, "list");
  assert.strictEqual((await w.handlers["research-prefs-set"](w.good, { imageWrong: { week: "bad", agent: "a", findingId: "x" } })).ok, false);
  assert.strictEqual((await w.handlers["research-prefs-set"](w.good, { imageWrong: { week: "2026-W41", agent: "Alpha Agent", findingId: "a-high" } })).ok, true);
  const p1 = (await w.handlers["research-prefs-get"](w.good)).prefs;
  assert.deepStrictEqual(p1.imageWrong, ["2026-W41|alpha agent|a-high"]); assert.strictEqual(p1.view, "list", "other prefs kept");
  assert.strictEqual((await w.handlers["research-image"](w.good, { week: "2026-W41", agent: "Alpha Agent", findingId: "a-high" })).reason, "marked-wrong");
  const j = JSON.parse(fs.readFileSync(path.join(w.ud, "research_prefs.json"), "utf8"));
  assert.ok(Array.isArray(j.imageWrong) && j.view === "list");
});
t("ipc research-thread: read-only; the last 5 sends for this finding (this week, this agent) from _writes.jsonl", async () => {
  const w = world();
  const f = path.join(w.d, "_writes.jsonl");
  const lines = [];
  for (let i = 1; i <= 7; i++) lines.push({ time: "2026-10-08T09:0" + i + ":00.000Z", week: "2026-W41", agent: "Alpha Agent", finding: "a-high", text: "message " + i, delivery: "sent" });
  lines.push({ time: "x", week: "2026-W40", agent: "Alpha Agent", finding: "a-high", text: "old week", delivery: "sent" });
  lines.push({ time: "x", week: "2026-W41", agent: "Beta Agent", finding: "a-high", text: "other agent", delivery: "sent" });
  lines.push({ time: "x", week: "2026-W41", agent: "Alpha Agent", finding: "a-low", text: "other finding", delivery: "sent" });
  // hostile lines: objects where strings are expected (String() on {toString:1} throws) - each is skipped, the rest still works
  lines.push({ week: "2026-W41", finding: "a-high", agent: { toString: 1 }, text: "x" });
  lines.push({ week: { toString: 1 }, finding: "a-high", agent: "Alpha Agent" });
  lines.push({ week: "2026-W41", finding: "a-high", agent: "Alpha Agent", text: { toString: 1 }, time: ["x"], delivery: 5 });
  lines.push(["array line"]); lines.push(null); lines.push(7);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n{broken json\n");
  const before = fs.readFileSync(f, "utf8");
  const r = await w.handlers["research-thread"](w.good, { week: "2026-W41", agent: "Alpha Agent", findingId: "a-high" });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.items.map((x) => x.text), ["message 4", "message 5", "message 6", "message 7", ""], "a field of the wrong type becomes empty text, never an exception");
  for (let i = 0; i < 10; i++) await w.handlers["research-thread"](w.good, { week: "2026-W41", agent: "Alpha Agent", findingId: "a-high" });
  assert.strictEqual(w.calls.resolve, 1, "the agent lookup (a disk scan) is cached");
  assert.strictEqual(fs.readFileSync(f, "utf8"), before, "the log is not touched");
  assert.deepStrictEqual((await w.handlers["research-thread"](w.good, { week: "2026-W41", agent: "Alpha Agent", findingId: "zzz" })).items, []);
  fs.unlinkSync(f);
  assert.deepStrictEqual((await w.handlers["research-thread"](w.good, { week: "2026-W41", agent: "Alpha Agent", findingId: "a-high" })).items, [], "no log yet: empty");
});
t("service: findings carry a chart only when their text supports one; findFinding returns the digest's own finding", () => {
  const d = tmp(); fs.cpSync(FX, d, { recursive: true });
  const s = SV.createService({ researchDir: d });
  const snap = s.load();
  assert.ok(snap.digests.every((x) => x.findings.every((f) => f.chart === null)), "the plain fixtures have no comparable figures");
  const f = SV.normFinding({ id: "ypp", title: "YPP doubles", whatChanged: "From 1 Feb 2027 new applicants need 8,000 watch hours/365d (now 4,000).", soWhat: "Apply early.", sources: [] }, 0);
  assert.strictEqual(f.chart.figure, "4,000 → 8,000");
  assert.strictEqual(s.findFinding("2026-W41", "alpha agent", "a-high").title, "High item");
  assert.strictEqual(s.findFinding("2026-W41", "Alpha Agent", "nope"), null);
  assert.strictEqual(s.findFinding("bad", "Alpha Agent", "a-high"), null);
});

// ---------------------------------------------------------------- renderer and css (static)
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
t("renderer: hero + article cards + data card + chart + reply box; images only via research-image and only file: URLs; one lazy IntersectionObserver", () => {
  const js = fs.readFileSync(path.join(SRC, "renderer", "research.js"), "utf8"), s = strip(js);
  for (const fn of ["renderMagazine", "renderHero", "renderArticle", "renderMedia", "renderDataCard", "renderChart", "renderReply", "renderReadMore", "renderMagMore", "renderViewSwitch"]) assert.ok(new RegExp("function " + fn + "\\(").test(js), fn);
  assert.strictEqual((s.match(/new IntersectionObserver/g) || []).length, 2);   // v1.107.0: the lazy-image observer + the "read after a few seconds on screen" observer
  assert.ok(/\/\^file:\\\/\\\/\/i\.test\(r\.url\)/.test(s), "only a local file URL is accepted from main");
  assert.ok(/api\.image\(/.test(s) && !/fetch\(|XMLHttpRequest|new Image\(/.test(s), "the renderer never fetches anything itself");
  for (const w of ["Replies arrive in your chat with ", "This image is wrong", "Ask for a follow-up article", "Sent, waiting for reply", "✎ Reply to ", "Send to ", "Image: ", "Read the full finding"]) assert.ok(js.indexOf(w) >= 0, w);
  assert.ok(/S\.onWrite\(agent, f\.id/.test(s), "the reply box reuses the v1.89.0 write path");
  assert.ok(!/research-write"|ipcRenderer/.test(s), "no second delivery path");
  assert.ok(/S\.imgs = new Map\(\); S\.threads = new Map\(\)/.test(s), "images and threads are dropped when the view closes");
  assert.ok((s.match(/setTimeout/g) || []).length === 3, "toast timer + v1.107.0 read-flush and dwell timers");
  const pre = fs.readFileSync(path.join(SRC, "preload.js"), "utf8");
  assert.ok(/image: \(week, agent, findingId\) => ipcRenderer\.invoke\("research-image", \{ week, agent, findingId \}\)/.test(pre));
  assert.ok(/thread: \(week, agent, findingId\) => ipcRenderer\.invoke\("research-thread", \{ week, agent, findingId \}\)/.test(pre));
});
t("css: tokens --rm-* with a dark block; Georgia only for headlines/so-what/big figure; nothing under 12 px; weight <= 600 (700 only for big numbers); one column under 760 px", () => {
  const css = fs.readFileSync(path.join(SRC, "renderer", "styles-research-mag.css"), "utf8"), body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(/:root\s*\{[^}]*--rm-serif/.test(body) && /body\.dark, html\[data-theme="dark"\] body\s*\{[^}]*--rm-/.test(body));
  let d = 0; for (const c of body) { if (c === "{") d++; else if (c === "}") { d--; assert.ok(d >= 0); } } assert.strictEqual(d, 0, "braces balanced");
  for (const m of body.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 12, m[0]);
  for (const m of body.matchAll(/([^{}]+)\{[^}]*?(?:font-weight:\s*|font:\s*)(\d{3})\b[^}]*\}/g)) { const wgt = Number(m[2]); assert.ok(wgt <= 600 || (wgt === 700 && /rm-data-n|rm-data-ini/.test(m[1])), m[1].trim() + " " + wgt); }
  const serifRules = [...body.matchAll(/([^{}]+)\{[^}]*var\(--rm-serif\)[^}]*\}/g)].map((m) => m[1].trim());
  for (const sel of serifRules) assert.ok(/h2|h3|rm-so|rm-data-n/.test(sel), "serif only on headlines / so-what / big figure: " + sel);
  assert.ok(/@container \(max-width: 760px\)[\s\S]*\.rm-grid \{ grid-template-columns: 1fr; \}/.test(body) && /\.rm-hero, \.rm-hero:not\(\.rm-hero-img\) \{ grid-template-columns: 1fr;/.test(body));
  assert.ok(/\.rm-logo img \{[^}]*object-fit: contain/.test(body) && /\.rm-media img \{[^}]*object-fit: cover/.test(body));
  const nav = fs.readFileSync(path.join(SRC, "renderer", "research-nav.js"), "utf8");
  assert.ok(nav.indexOf("styles-research.css") < nav.indexOf("styles-research-mag.css"), "loaded with the view, after the base sheet");
  assert.ok(!fs.readFileSync(path.join(SRC, "renderer", "index.html"), "utf8").includes("styles-research-mag.css"), "not loaded at startup");
});
t("package: both new tests run in npm test", () => {
  const p = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const sc = p.scripts.test;
  for (const f of ["tests/research-mag.test.js", "tests/research-figures.test.js"]) assert.ok(sc.indexOf(f) >= 0, f);
  assert.ok(/^1\.\d+\.\d+$/.test(p.version), "version is semver");
});

(async () => {
  for (const q of queue) {
    n++;
    try { await q.fn(); } catch (e) { fails++; console.log("FAIL " + q.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); }
  }
  console.log(fails ? fails + " of " + n + " FAILED" : "research-mag: all " + n + " tests passed");
  process.exit(fails ? 1 : 0);
})();
