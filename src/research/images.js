// MY RESEARCH magazine view (v1.91.0, main process): lead images for findings. Fetched ONCE here, cached on disk, never hotlinked:
// the renderer only ever gets a file:// URL of a cached copy (or nothing, and then it draws a data card).
// Where the image comes from: the finding's FIRST primary source URL (else its first source URL) -> that page's og:image, else
// twitter:image, else the largest <img> (by its width/height attributes) near the top of the page. Never a generated image.
// SAFETY (SSRF), all mandatory, all tested in tests/research-mag.test.js (real transport against a local TLS server):
//  - https only (an http URL is upgraded to https), no user:password in the URL, default port only, no IP-literal or single-label host,
//    no local names (one trailing dot stripped first); a source URL with token-like query parameters is never fetched (privacy)
//  - the hostname is resolved and EVERY address must be public (private, loopback, link-local, CGNAT, multicast, reserved, ULA, NAT64,
//    6to4, Teredo, discard, ORCHID and v4-mapped/translated private are refused); checked before each request AND at connect time
//    (custom lookup, so DNS rebinding cannot swap the address); every redirect is re-checked the same way; at most 3 redirects
//  - 8 s deadline per request and 15 s for a whole redirect chain; a redirect or error body is destroyed, never drained; page HTML read
//    up to 768 KB and only the first 64 KB (the head) is scanned, with a LINEAR indexOf scanner (no regex over unclosed tags);
//    image at most 3 MB (stream cut at the cap), at most 6000 px a side and 24 Mpx (decompression bombs)
//  - only image/png, image/jpeg, image/webp, image/gif are accepted, and the file's magic bytes must match; SVG is always rejected
//  - at most 2 fetches at a time (queued ones are cancelled when the tab closes), at most 60 network fetches per week in any 24 h (persisted),
//    no cookies or credentials, a plain User-Agent
//  - failures are cached (negative entry) for 24 h; in test mode there is NO network at all (a fixture map is used instead)
// Cache: <userData>\research_images\<sha1(source URL)>.<ext> plus index.json { "<sha1>": { source, image, fetchedAt, type, w, h, domain,
// logo, failed?, reason? } } and counters.json { "<week>": n }. Capped at 300 MB and 12 weeks (oldest out first); writes are atomic.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns");
const net = require("net");
const { pathToFileURL } = require("url");

const TIMEOUT_MS = 8000, CHAIN_MS = 15000, MAX_IMAGE_BYTES = 3 * 1024 * 1024, MAX_HTML_BYTES = 768 * 1024, SCAN_BYTES = 64 * 1024, MAX_REDIRECTS = 3;
const MAX_SIDE = 6000, MAX_PIXELS = 24e6, MAX_TAG = 4096;
const CONCURRENCY = 2, WEEK_CAP = 60, CAP_WINDOW_MS = 24 * 3600 * 1000, NEG_TTL_MS = 24 * 3600 * 1000, SWEEP_EVERY = 20;
const CACHE_MAX_BYTES = 300 * 1024 * 1024, CACHE_MAX_AGE_MS = 12 * 7 * 24 * 3600 * 1000;
const UA = "AgentDesktop-Research/1.0 (lead image fetch)";
const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const SHA_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------- address checks
function v4ToInt(ip) { const p = ip.split(".").map(Number); return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]; }
const V4_BLOCK = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([a, b]) => [v4ToInt(a), b]);
function isPrivateV4(ip) {
  if (!net.isIPv4(ip)) return true;
  const n = v4ToInt(ip);
  return V4_BLOCK.some(([base, bits]) => ((n >>> (32 - bits)) === (base >>> (32 - bits))));
}
function expandV6(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (s.indexOf(".") >= 0) {                                         // embedded v4 tail
    const i = s.lastIndexOf(":"), v4 = s.slice(i + 1);
    if (!net.isIPv4(v4)) return null;
    const n = v4ToInt(v4);
    s = s.slice(0, i + 1) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const a = halves[0] ? halves[0].split(":") : [], b = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? new Array(8 - a.length - b.length).fill("0") : [];
  const all = a.concat(fill, b);
  if (all.length !== 8) return null;
  return all.map((h) => parseInt(h || "0", 16));
}
function isPrivateV6(ip) {
  const w = expandV6(ip);
  if (!w || w.some((x) => !(x >= 0 && x <= 0xffff))) return true;
  const v4tail = () => isPrivateV4([w[6] >> 8, w[6] & 255, w[7] >> 8, w[7] & 255].join("."));
  if (w.every((x) => x === 0)) return true;                                    // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true;          // ::1
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) return v4tail();   // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compat)
  if (w.slice(0, 4).every((x) => x === 0) && w[4] === 0xffff && w[5] === 0) return true;          // ::ffff:0:a.b.c.d (translated)
  if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true;  // 100::/64 discard
  if ((w[0] & 0xfe00) === 0xfc00) return true;                                 // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true;                                 // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return true;                                 // fec0::/10 site-local (old)
  if ((w[0] & 0xff00) === 0xff00) return true;                                 // multicast
  if (w[0] === 0x64 && w[1] === 0xff9b) return true;                           // NAT64 (could reach v4 private)
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true;                         // documentation
  if (w[0] === 0x2001 && (w[1] & 0xfff0) === 0x0010) return true;              // 2001:10::/28 ORCHID
  if (w[0] === 0x2001 && (w[1] & 0xfff0) === 0x0020) return true;              // 2001:20::/28 ORCHIDv2
  if (w[0] === 0x2002) return true;                                            // 6to4 (embeds v4)
  if (w[0] === 0x2001 && w[1] === 0) return true;                              // Teredo
  return false;
}
function isPrivateAddress(ip) { return net.isIPv4(ip) ? isPrivateV4(ip) : net.isIPv6(ip) ? isPrivateV6(ip) : true; }

// a source/image URL -> a normalised https URL string, or null. http is upgraded; anything odd is refused.
function normalizeUrl(u, base) {
  if (typeof u !== "string" || !u.trim() || u.length > 2000) return null;
  let p;
  try { p = base ? new URL(u.trim(), base) : new URL(u.trim()); } catch (e) { return null; }
  if (p.protocol === "http:") p.protocol = "https:";
  if (p.protocol !== "https:") return null;
  if (p.username || p.password) return null;
  if (p.port && p.port !== "443") return null;
  const h = p.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || net.isIP(h) || h.indexOf(".") < 0 || /\.(local|localhost|internal|lan|home|arpa|test|invalid)$/i.test(h) || /^localhost$/i.test(h)) return null;
  p.hash = "";
  return p.href;
}
// privacy: never GET a source that looks like a one-time / signed / secret link. Parameter names are DECODED and matched as
// whole names, or by their parts split on - _ . ("x-amz-signature", "access_token"): so ?keyword= ?sidebar= ?author= ?code=
// ?sid= ?accessibility= are fine, ?token= ?jwt= ?X-Amz-Signature= ?api_key= are not. Also: ;jsessionid in the path, a JWT
// or a long random-looking path segment, and a segment after /reset/ /verify/ /magic/ (...).
const TOKEN_NAMES = new Set(["key", "apikey", "api_key", "api-key", "auth", "auth_token", "authtoken", "password", "passwd", "pwd", "pw", "otp",
  "sessionid", "session_id", "phpsessid", "jsessionid", "expires", "expiry", "magic", "magic_link", "client_secret"]);
const TOKEN_PARTS = new Set(["token", "jwt", "hmac", "nonce", "ticket", "signature", "sig", "secret", "credential", "credentials", "password", "otp", "apikey", "sessionid"]);
const TOKEN_PATH_BEFORE = new Set(["reset", "verify", "verification", "confirm", "magic", "magic-link", "login", "signin", "unsubscribe", "invite", "activate", "token", "auth", "password", "share"]);
function tokenLike(u) {
  let p;
  try { p = new URL(u); } catch (e) { return true; }
  if (p.search.length > 200) return true;
  const dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  for (const raw of p.searchParams.keys()) {
    const n = dec(raw).trim().toLowerCase();
    if (TOKEN_NAMES.has(n)) return true;
    if (n.split(/[-_.]+/).some((x) => TOKEN_PARTS.has(x))) return true;
  }
  const path = dec(p.pathname);
  if (/;\s*(?:jsessionid|phpsessid|sessionid|sid|token)\s*=/i.test(path)) return true;
  const segs = path.split("/").filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (/^eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*$/.test(s)) return true;                                     // a JWT
    if (/^[0-9a-f]{32,}$/i.test(s)) return true;                                                        // long hex
    if (/^[A-Za-z0-9_-]{32,}$/.test(s) && (s.match(/\d/g) || []).length >= 4 && /[A-Z]/.test(s) && /[a-z]/.test(s) && (s.match(/-/g) || []).length < 3) return true;   // random-looking
    if (i > 0 && TOKEN_PATH_BEFORE.has(segs[i - 1].toLowerCase()) && /^[\w-]{12,}$/.test(s) && /\d/.test(s)) return true;
  }
  return false;
}

// resolve and require every address to be public. lookupAll(host) -> Promise<[{address, family}]>
const realLookupAll = (host) => new Promise((res, rej) => dns.lookup(host, { all: true, verbatim: true }, (e, a) => (e ? rej(e) : res(a))));
async function assertPublicHost(host, lookupAll) {
  const addrs = await (lookupAll || realLookupAll)(host);
  if (!Array.isArray(addrs) || !addrs.length) throw codeErr("ENOADDR");
  for (const a of addrs) if (!a || isPrivateAddress(a.address)) throw codeErr("EPRIVATE");
  return addrs;
}
function codeErr(code) { const e = new Error(code); e.code = code; return e; }

// connect-time guard for https.request: resolves, refuses private addresses, hands the first public one to the socket
function guardedLookup(host, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  realLookupAll(host).then((addrs) => {
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return cb(codeErr("EPRIVATE"));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  }, (e) => cb(e));
}

// ---------------------------------------------------------------- one HTTPS GET (real transport): no cookies, plain UA, deadline, byte cap
// o.lookup / o.ca / o.timeoutMs exist for the tests (a local TLS server); the app always uses guardedLookup and the system CAs.
function httpsGet(url, o) {
  const https = require("https");
  const maxBytes = o.maxBytes, ms = Math.max(1, Math.min(TIMEOUT_MS, o.timeoutMs || TIMEOUT_MS));
  return new Promise((resolve, reject) => {
    let done = false, res0 = null;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const opts = { method: "GET", lookup: o.lookup || guardedLookup, headers: { "User-Agent": UA, Accept: o.accept || "*/*", "Accept-Encoding": "identity" }, agent: false };
    if (o.ca) opts.ca = o.ca;
    const req = https.request(url, opts, (res) => {
      res0 = res;
      const status = res.statusCode || 0;
      if (status !== 200) { finish(resolve, { status, headers: res.headers, body: Buffer.alloc(0) }); return res.destroy(); }   // redirects/errors: never drained
      const len = Number(res.headers["content-length"] || 0);
      if (len && len > maxBytes) { finish(reject, codeErr("ETOOBIG")); return res.destroy(); }
      const chunks = []; let n = 0;
      res.on("data", (c) => { n += c.length; if (n > maxBytes) { finish(reject, codeErr("ETOOBIG")); res.destroy(); } else chunks.push(c); });
      res.on("end", () => finish(resolve, { status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", (e) => finish(reject, e));
      res.on("aborted", () => finish(reject, codeErr("EABORTED")));
    });
    const timer = setTimeout(() => { finish(reject, codeErr("ETIMEOUT")); if (res0) res0.destroy(); req.destroy(codeErr("ETIMEOUT")); }, ms);   // a total deadline, not per read
    req.on("error", (e) => finish(reject, e));
    req.end();
  });
}

// GET with manual redirects; every hop is normalised (https) and its host checked BEFORE the request; 15 s for the whole chain
async function safeGet(url, opts, deps) {
  const d = deps || {};
  const get = d.get || httpsGet;
  const clock = d.now || Date.now;
  const end = clock() + (d.chainMs || CHAIN_MS);
  let cur = normalizeUrl(url);
  if (!cur) throw codeErr("EBADURL");
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // the DNS check counts against the same chain budget (a resolver that never answers cannot stall the queue)
    const dl = end - clock();
    if (dl <= 0) throw codeErr("ETIMEOUT");
    let tm = null;
    try {
      await Promise.race([assertPublicHost(new URL(cur).hostname, d.lookupAll), new Promise((_, rej) => { tm = setTimeout(() => rej(codeErr("ETIMEOUT")), dl); })]);
    } finally { clearTimeout(tm); }
    const left = end - clock();
    if (left <= 0) throw codeErr("ETIMEOUT");
    const r = await get(cur, Object.assign({}, opts, { timeoutMs: Math.min(TIMEOUT_MS, left) }));
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers && (r.headers.location || r.headers.Location);
      const next = normalizeUrl(typeof loc === "string" ? loc : "", cur);
      if (!next) throw codeErr("EBADREDIRECT");
      cur = next; continue;
    }
    if (r.status !== 200) throw codeErr("EHTTP" + r.status);
    return { url: cur, headers: r.headers || {}, body: r.body };
  }
  throw codeErr("EREDIRECTS");
}

// ---------------------------------------------------------------- page -> image URL (LINEAR scan of the first 64 KB / the head)
const ENT = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|quot|apos|lt|gt);/gi, (m, e) => {
    if (e[0] === "#") { const c = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; }
    return ENT[e.toLowerCase()] || m;
  });
}
// one attribute from a bounded tag string (<= 4 KB): the regex runs on a short string only
function attr(tag, name) { const m = tag.match(new RegExp("[\\s\"'/]" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i")); return m ? decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]) : null; }
// every <name ...> tag in h, found with indexOf only; stops when a tag has no closing '>' (an unclosed opener ends the scan)
function tagsOf(h, name) {
  const out = [], n = name.length;
  let i = 0;
  while (out.length < 400) {
    i = h.indexOf("<", i);
    if (i < 0) break;
    if (h.substr(i + 1, n).toLowerCase() === name && /[\s/>]/.test(h.charAt(i + 1 + n))) {
      const j = h.indexOf(">", i + 1 + n);
      if (j < 0) break;
      if (j - i <= MAX_TAG) out.push(h.slice(i, j + 1));
      i = j + 1;
    } else i++;
  }
  return out;
}
function pickImageFromHtml(html, pageUrl) {
  const h = String(html || "").slice(0, SCAN_BYTES);
  let he = h.indexOf("</head"); if (he < 0) he = h.indexOf("</HEAD");
  const head = he >= 0 ? h.slice(0, he) : h;
  const metas = tagsOf(head, "meta");
  const metaVal = (keys) => {
    for (const k of keys) for (const t of metas) { const p = (attr(t, "property") || attr(t, "name") || "").toLowerCase(); if (p === k) { const c = attr(t, "content"); if (c) return c; } }
    return null;
  };
  let cand = metaVal(["og:image:secure_url", "og:image", "og:image:url"]) || metaVal(["twitter:image", "twitter:image:src"]);
  let how = cand ? "meta" : null;
  if (!cand) {
    let best = null, bestA = 0;
    for (const t of tagsOf(h, "img")) {
      const src = attr(t, "src"); if (!src || /^data:/i.test(src)) continue;
      const w = parseInt(attr(t, "width") || "0", 10), ht = parseInt(attr(t, "height") || "0", 10);
      const a = (w || 0) * (ht || 0);
      if (a > bestA && w >= 200 && ht >= 100) { best = src; bestA = a; }
    }
    cand = best; how = best ? "img" : null;
  }
  if (!cand) return null;
  const u = normalizeUrl(cand, pageUrl);
  return u ? { url: u, how } : null;
}

// ---------------------------------------------------------------- image bytes: type by magic, size
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
function dims(buf, type) {
  try {
    if (type === "image/png") return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (type === "image/gif") return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (type === "image/webp") {
      const k = buf.slice(12, 16).toString("latin1");
      if (k === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (k === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (k === "VP8L") { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const mk = buf[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        if (mk === 0xd8 || mk === 0x01 || mk === 0xff || (mk >= 0xd0 && mk <= 0xd7)) { i += mk === 0xff ? 1 : 2; continue; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (e) { /* unknown */ }
  return { w: 0, h: 0 };
}
// is it a logo (draw with contain on a light background) rather than a photo (cover)?
function looksLikeLogo(imageUrl, type, w, h) {
  if (/logo|brand|icon|favicon|wordmark/i.test(imageUrl || "")) return true;
  if (type === "image/png" && w && h && w <= 600 && h <= 600) return true;
  return false;
}
// validate fetched bytes: declared type allowed, magic matches, svg refused, byte cap, pixel cap (unknown size refused)
// a GIF's frames can be larger than its screen, and an animation multiplies the decode cost: every frame must fit the
// side/pixel caps, at most 1000 frames and 4x MAX_PIXELS in all. A linear walk of the block structure; malformed -> refused.
const GIF_MAX_FRAMES = 1000;
function gifFramesOk(buf) {
  try {
    let i = 13;
    const packed = buf[10];
    if (packed & 0x80) i += 3 * (1 << ((packed & 7) + 1));                  // global colour table
    const skipSub = () => { while (i < buf.length) { const n = buf[i++]; if (n === 0) return; i += n; } throw new Error("eof"); };
    let frames = 0, total = 0;
    while (i < buf.length) {
      const b = buf[i++];
      if (b === 0x3b) break;                                                  // trailer
      if (b === 0x21) { i++; skipSub(); continue; }                           // extension: label + sub-blocks
      if (b !== 0x2c) return false;
      const w = buf.readUInt16LE(i + 4), h = buf.readUInt16LE(i + 6), p = buf[i + 8];
      i += 9;
      if (p & 0x80) i += 3 * (1 << ((p & 7) + 1));                            // local colour table
      i++;                                                                     // LZW minimum code size
      skipSub();
      frames++; total += w * h;
      if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS || frames > GIF_MAX_FRAMES || total > 4 * MAX_PIXELS) return false;
    }
    return true;
  } catch (e) { return false; }
}
function checkImage(buf, declared) {
  const ct = String(declared || "").split(";")[0].trim().toLowerCase();
  if (/svg/.test(ct)) return { ok: false, reason: "svg" };
  if (!buf || !buf.length) return { ok: false, reason: "empty" };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: "too-big" };
  const real = sniff(buf);
  if (!real) return { ok: false, reason: "not-an-image" };
  if (ct && TYPES[ct] && TYPES[ct] !== TYPES[real]) return { ok: false, reason: "type-mismatch" };
  if (ct && !TYPES[ct] && ct !== "application/octet-stream" && ct !== "binary/octet-stream") return { ok: false, reason: "type-not-allowed" };
  const d = dims(buf, real);
  if (!(d.w > 0 && d.h > 0)) return { ok: false, reason: "size-unknown" };
  if (d.w > MAX_SIDE || d.h > MAX_SIDE || d.w * d.h > MAX_PIXELS) return { ok: false, reason: "too-many-pixels" };
  if (real === "image/gif" && !gifFramesOk(buf)) return { ok: false, reason: "too-many-pixels" };
  return { ok: true, type: real, w: d.w, h: d.h };
}

// the source URL a finding's image is taken from: first primary source, else the first source with a usable URL; token-like links: none
function sourceUrlOf(f) {
  const list = (f && Array.isArray(f.sources) ? f.sources : []).filter((s) => s && typeof s.url === "string" && /^https?:\/\//i.test(s.url.trim()));
  const p = list.find((s) => String(s.kind || "").trim().toLowerCase() === "primary");
  const s = p || list[0];
  const u = s ? normalizeUrl(s.url) : null;
  return u && !tokenLike(u) ? u : null;
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };

function writeAtomic(file, data) {
  const tmp = file + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, data);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ } throw e; }
}

// ---------------------------------------------------------------- the cache
function createImageCache(o) {
  const dir = o.dir;
  const testMode = !!o.testMode;
  const say = typeof o.log === "function" ? o.log : () => {};
  const clock = typeof o.now === "function" ? o.now : () => Date.now();
  const deps = o.deps || {};                                   // tests: { get, lookupAll }
  const indexFile = path.join(dir, "index.json"), countFile = path.join(dir, "counters.json");
  const maxBytes = o.maxCacheBytes || CACHE_MAX_BYTES;
  let index = null, counts = null;
  const inflight = new Map();                                  // sha -> Promise
  let active = 0; let waiters = [];
  let generation = 0;                                          // bumped by cancel(): queued fetches of an older generation give up

  const readJson = (f) => { try { const j = JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch (e) { return {}; } };
  const sha = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
  const fileOf = (h, type) => path.join(dir, h + "." + TYPES[type]);
  function loadIndex() {
    if (index) return index;
    index = readJson(indexFile);
    sweep();
    return index;
  }
  // drop entries that are not ours / whose file is gone / older than 12 weeks; then the oldest out until under the size cap.
  // Runs at load, every SWEEP_EVERY new images, and at quit (close). Edits the index IN PLACE (fetches hold a reference).
  function sweep() {
    if (!index) return;
    const now = clock(), drop = (k) => { delete index[k]; };
    let total = 0; const live = [];
    for (const [k, e] of Object.entries(index)) {
      if (!SHA_RE.test(k) || !e || typeof e !== "object") { drop(k); continue; }
      const at = Date.parse(e.fetchedAt || 0) || 0;
      if (e.failed) { if (!(now - at < NEG_TTL_MS)) drop(k); continue; }
      if (!TYPES[e.type]) { drop(k); continue; }
      const f = fileOf(k, e.type);
      let st = null; try { st = fs.lstatSync(f); } catch (x) { /* gone */ }
      if (!st || !st.isFile()) { drop(k); continue; }
      if (now - at > CACHE_MAX_AGE_MS) { try { fs.unlinkSync(f); } catch (x) { /* ignore */ } drop(k); continue; }
      total += st.size; live.push({ k, at, size: st.size, f });
    }
    live.sort((a, b) => a.at - b.at);
    while (total > maxBytes && live.length) { const x = live.shift(); try { fs.unlinkSync(x.f); } catch (e) { /* ignore */ } drop(x.k); total -= x.size; }
    sinceSweep = 0;
  }
  let sinceSweep = 0;
  let saveTimer = null;
  function saveIndex() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 300);
    if (saveTimer.unref) saveTimer.unref();
  }
  function flush() {
    clearTimeout(saveTimer);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (index) writeAtomic(indexFile, JSON.stringify(index));
      if (counts) writeAtomic(countFile, JSON.stringify(counts));
    } catch (e) { say("research-image index write failed: code=" + (e && e.code)); }
  }
  // network fetches per week, SLIDING: at most WEEK_CAP in any 24 h for one week (persisted as timestamps, so a restart
  // does not reset it, and a week is not blocked for good once 60 were spent)
  function weekCount() {
    if (!counts) {
      counts = readJson(countFile);
      for (const k of Object.keys(counts)) if (!/^[\w-]{1,12}$/.test(k) || !Array.isArray(counts[k])) delete counts[k];
      for (const k of Object.keys(counts)) counts[k] = counts[k].filter((t) => typeof t === "number" && Number.isFinite(t)).slice(-WEEK_CAP);
    }
    return counts;
  }
  function recent(week) {
    const c = weekCount(), now = clock();
    const list = (c[week] || []).filter((t) => now - t < CAP_WINDOW_MS && t <= now);
    if (list.length) c[week] = list; else delete c[week];
    return list.length;
  }

  async function slot(fn, gen) {
    if (active >= CONCURRENCY) await new Promise((r) => waiters.push(r));
    if (gen !== generation) throw codeErr("ECANCELLED");                        // woken by cancel(): no slot was taken, none is passed on
    active++;
    try { return await fn(); } finally { active--; const n = waiters.shift(); if (n) n(); }
  }

  // the map KEY is trusted, never the entry's own sha/type fields beyond the fixed type table
  function present(h, e) {
    if (!SHA_RE.test(h) || !e || !TYPES[e.type]) return null;
    const f = fileOf(h, e.type);
    try { if (!fs.lstatSync(f).isFile()) return null; } catch (x) { return null; }
    return { ok: true, url: pathToFileURL(f).href, domain: String(e.domain || ""), logo: !!e.logo, w: Number(e.w) || 0, h: Number(e.h) || 0, how: String(e.how || "") };
  }

  // test mode: NO network. fixtures = { "<host>": "<file in fixturesDir>" }; an unmapped host fails like a page without an image.
  async function fetchFixture(source) {
    const map = o.fixtures || {};
    const h = hostOf(source);
    const name = Object.prototype.hasOwnProperty.call(map, h) ? map[h] : map["www." + h];
    if (typeof name !== "string" || !o.fixturesDir) throw codeErr("ENOFIXTURE");
    const f = path.join(o.fixturesDir, path.basename(name));
    const body = fs.readFileSync(f);
    if (body.length > MAX_IMAGE_BYTES) throw codeErr("ETOOBIG");
    const ext = path.extname(f).slice(1).toLowerCase();
    const ct = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" }[ext] || "";
    return { body, type: ct, imageUrl: "https://" + h + "/" + path.basename(name), how: "fixture" };
  }
  async function fetchNetwork(source) {
    const page = await safeGet(source, { maxBytes: MAX_HTML_BYTES, accept: "text/html,application/xhtml+xml" }, deps);
    const ct = String(page.headers["content-type"] || "").toLowerCase();
    let pick;
    if (/^image\//.test(ct)) pick = { url: page.url, how: "direct", direct: page };             // the source itself is an image
    else pick = pickImageFromHtml(page.body.toString("utf8"), page.url);
    if (!pick) throw codeErr("ENOIMAGE");
    const img = pick.direct || await safeGet(pick.url, { maxBytes: MAX_IMAGE_BYTES, accept: "image/png,image/jpeg,image/webp,image/gif" }, deps);
    return { body: img.body, type: img.headers["content-type"] || "", imageUrl: img.url, how: pick.how };
  }

  // a = { week, source } -> result for the renderer
  async function get(a) {
    const source = normalizeUrl(a && a.source);
    if (!source || tokenLike(source)) return { ok: false, reason: "no-source" };
    const h = sha(source);
    const idx = loadIndex();
    const e = Object.prototype.hasOwnProperty.call(idx, h) ? idx[h] : null;
    if (e && !e.failed) { const p = present(h, e); if (p) return p; }
    if (e && e.failed && clock() - Date.parse(e.fetchedAt || 0) < NEG_TTL_MS) return { ok: false, reason: String(e.reason || "failed"), cached: true };
    if (inflight.has(h)) return inflight.get(h);
    const week = a && typeof a.week === "string" && /^[\w-]{1,12}$/.test(a.week) ? a.week : "_";
    const c = weekCount();
    if (recent(week) >= WEEK_CAP) return { ok: false, reason: "week-cap" };
    const stamp = clock(); (c[week] = c[week] || []).push(stamp); saveIndex();
    const p = slot(async () => {
      let r;
      try { r = testMode ? await fetchFixture(source) : await fetchNetwork(source); }
      catch (x) { return fail(h, source, (x && x.code) || "error"); }
      const ck = checkImage(r.body, r.type);
      if (!ck.ok) return fail(h, source, ck.reason);
      try { fs.mkdirSync(dir, { recursive: true }); writeAtomic(fileOf(h, ck.type), r.body); } catch (x) { return fail(h, source, "write-failed"); }
      idx[h] = { source, image: String(r.imageUrl || "").slice(0, 500), fetchedAt: new Date(clock()).toISOString(), type: ck.type, w: ck.w, h: ck.h, domain: hostOf(source), logo: looksLikeLogo(r.imageUrl, ck.type, ck.w, ck.h), how: r.how };
      if (++sinceSweep >= SWEEP_EVERY) sweep();                               // periodic cleanup (size + age caps); the newest stays
      saveIndex();
      return present(h, idx[h]) || { ok: false, reason: "missing" };
    }, generation).catch((x) => { if (x && x.code === "ECANCELLED" && c[week]) { const i = c[week].lastIndexOf(stamp); if (i >= 0) c[week].splice(i, 1); } return { ok: false, reason: (x && x.code) || "error" }; }).finally(() => inflight.delete(h));
    inflight.set(h, p);
    return p;
  }
  function fail(h, source, reason) {
    const idx = loadIndex();
    idx[h] = { source, fetchedAt: new Date(clock()).toISOString(), failed: true, reason: String(reason).slice(0, 40), domain: hostOf(source) };
    saveIndex();
    say("research-image: " + hostOf(source) + " -> " + reason);
    return { ok: false, reason };
  }
  // the tab closed: fetches still waiting for a slot give up (the two running ones finish under their own deadlines)
  function cancel() { generation++; const w = waiters; waiters = []; w.forEach((r) => r()); }
  // app quit: tidy the cache and write everything now
  function close() { try { loadIndex(); sweep(); } catch (e) { /* best effort */ } flush(); }
  const weeks = () => { const o = {}; for (const k of Object.keys(weekCount())) o[k] = recent(k); return o; };
  return { get, flush, close, cancel, indexFile, stats: () => ({ active, queued: waiters.length, weeks: weeks() }) };
}

module.exports = {
  createImageCache, normalizeUrl, isPrivateAddress, assertPublicHost, safeGet, httpsGet, pickImageFromHtml, sniff, dims, checkImage, sourceUrlOf, looksLikeLogo, guardedLookup, tokenLike,
  constants: { TIMEOUT_MS, CHAIN_MS, MAX_IMAGE_BYTES, MAX_HTML_BYTES, SCAN_BYTES, MAX_REDIRECTS, CONCURRENCY, WEEK_CAP, CAP_WINDOW_MS, SWEEP_EVERY, NEG_TTL_MS, MAX_SIDE, MAX_PIXELS, CACHE_MAX_BYTES, CACHE_MAX_AGE_MS, UA },
};
