// CONTACTS company logos (main process). Fetches a company's own icon (its home page's apple-touch-icon / icon link, else /favicon.ico) over https,
// caches it on disk next to the contacts file, and hands the renderer a data: URL. The renderer never makes a network request and never sees a URL.
// Safety: https only, a hostname (never an IP literal), every connection (redirects included) refused if the name resolves to a private / loopback /
// link-local address, size caps, a short timeout, images checked by their first bytes, at most 3 fetches at a time. A miss is remembered for 14 days.
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const dns = require("dns");
const net = require("net");

const MAX_IMG = 200 * 1024, MAX_HTML = 256 * 1024, TIMEOUT_MS = 6000, NEG_MS = 14 * 24 * 3600 * 1000, PARALLEL = 3, MAX_REDIRECTS = 3;

function privateAddr(a) {
  if (net.isIPv4(a)) { const [x, y] = a.split(".").map(Number); return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || x >= 224; }
  const s = String(a).toLowerCase();
  if (s === "::1" || s === "::" || s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true;
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); return m ? privateAddr(m[1]) : false;
}
/** dns.lookup that refuses to hand back a private address: the socket can only ever connect to a public one. */
function safeLookup(host, opts, cb) {
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs || !addrs.length || addrs.some((x) => privateAddr(x.address))) return cb(new Error("blocked address"));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

const HOST_OK = /^(?=.{4,120}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
function cleanHost(d) { const h = String(d == null ? "" : d).trim().toLowerCase().replace(/^www\./, ""); return HOST_OK.test(h) && !net.isIP(h) ? h : null; }

/** GET an https URL (follows up to 3 redirects, each checked again). Resolves { code, headers, body:Buffer, url } or null. */
/** Same site = same last two labels (three under co.uk / com.au style endings). Redirects and icon links may not leave the company's own site. */
function siteOf(h) { const p = String(h).toLowerCase().split("."); const n = p.length >= 3 && p[p.length - 2].length <= 3 && p[p.length - 1].length === 2 ? 3 : 2; return p.slice(-n).join("."); }
function fetchUrl(url, max, lookup, site) {
  return new Promise((resolve) => {
    const step = (u, left) => {
      let p; try { p = new URL(u); } catch (e) { return resolve(null); }
      if (site && siteOf(p.hostname) !== site) return resolve(null);
      if (p.protocol !== "https:" || p.username || p.password || (p.port && p.port !== "443") || net.isIP(p.hostname) || !HOST_OK.test(p.hostname)) return resolve(null);
      let done = false, req = null;
      const finish = (v, again) => { if (done) return; done = true; clearTimeout(t); try { if (req) req.destroy(); } catch (e) { /* gone */ } again ? step(again, left - 1) : resolve(v); };
      const t = setTimeout(() => finish(null), TIMEOUT_MS + 2000);
      req = https.get({ host: p.hostname, path: p.pathname + p.search, lookup: lookup || safeLookup, timeout: TIMEOUT_MS, headers: { Accept: "image/*,text/html;q=0.8" } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume(); if (left <= 0) return finish(null);
          let next; try { next = new URL(res.headers.location, p).toString(); } catch (e) { return finish(null); }
          return finish(null, next);
        }
        let n = 0; const chunks = [];
        res.on("data", (c) => { n += c.length; if (n > max) return finish(null); chunks.push(c); });
        res.on("end", () => finish({ code: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: p.toString() }));
        res.on("error", () => finish(null)); res.on("aborted", () => finish(null));
      });
      req.on("timeout", () => finish(null)); req.on("error", () => finish(null));
    };
    step(url, MAX_REDIRECTS);
  });
}

/** The image kind from its first bytes (not from what the server claims). SVG is refused: it can carry script. */
function sniff(b) {
  if (!b || b.length < 8) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.slice(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  if (b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Icon links in a home page: apple-touch-icon first (bigger), then icon / shortcut icon. Returns absolute https URLs, best first. */
function iconLinks(html, base) {
  const found = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0], rel = (tag.match(/\brel\s*=\s*["']([^"']*)["']/i) || [])[1], href = (tag.match(/\bhref\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (!rel || !href || href.length > 400 || /\.svg(\?|$)/i.test(href) || /^data:/i.test(href)) continue;
    const r = rel.toLowerCase(); const score = /apple-touch-icon/.test(r) ? 2 : /\bicon\b/.test(r) ? 1 : 0; if (!score) continue;
    let abs; try { abs = new URL(href, base).toString(); } catch (e) { continue; }
    found.push([score, abs]);
  }
  found.sort((a, b) => b[0] - a[0]); return found.map((f) => f[1]).slice(0, 3);
}

async function fetchIcon(host, lookup) {
  const cands = [];
  const page = await fetchUrl("https://" + host + "/", MAX_HTML, lookup, siteOf(host));
  if (page && page.code === 200) { try { for (const u of iconLinks(page.body.toString("utf8"), page.url)) cands.push(u); } catch (e) { /* no links */ } }
  cands.push("https://" + host + "/favicon.ico");
  for (const u of cands) {
    const r = await fetchUrl(u, MAX_IMG, lookup, siteOf(host));
    if (r && r.code === 200 && sniff(r.body)) return r.body;
  }
  return null;
}

/** dir: where the cache lives (created on first write). opts.lookup / opts.fetchIcon: test hooks. */
function createLogos(dir, opts) {
  const o = opts || {}, fetcher = o.fetchIcon || ((h) => fetchIcon(h, o.lookup));
  const queue = []; let running = 0; const pending = new Map();
  const fileFor = (host, ext) => path.join(dir, host + ext);
  function fromCache(host) {
    try { const b = fs.readFileSync(fileFor(host, ".img")); const k = sniff(b); if (k) return { have: true, url: "data:" + k + ";base64," + b.toString("base64") }; } catch (e) { /* not cached */ }
    try { if (Date.now() - fs.statSync(fileFor(host, ".none")).mtimeMs < NEG_MS) return { have: true, url: null }; } catch (e) { /* no miss marker */ }
    return { have: false };
  }
  function pump() {
    while (running < PARALLEL && queue.length) {
      const job = queue.shift(); running++;
      Promise.resolve().then(() => fetcher(job.host)).catch(() => null).then((img) => {
        try { fs.mkdirSync(dir, { recursive: true }); if (img && sniff(img) && img.length <= MAX_IMG) fs.writeFileSync(fileFor(job.host, ".img"), img); else fs.writeFileSync(fileFor(job.host, ".none"), ""); } catch (e) { /* cache not writable: still answer */ }
        const r = fromCache(job.host); job.resolve(r.have ? r.url : (img && sniff(img) ? "data:" + sniff(img) + ";base64," + img.toString("base64") : null));
      }).then(() => { running--; pending.delete(job.host); pump(); });
    }
  }
  /** Resolves a data: URL, or null (no logo). Never rejects. */
  function get(domain) {
    const host = cleanHost(domain); if (!host) return Promise.resolve(null);
    const c = fromCache(host); if (c.have) return Promise.resolve(c.url);
    if (pending.has(host)) return pending.get(host);
    const p = new Promise((resolve) => { queue.push({ host, resolve }); }); pending.set(host, p); pump(); return p;
  }
  return { get };
}

module.exports = { siteOf, createLogos, cleanHost, privateAddr, sniff, iconLinks, safeLookup };
