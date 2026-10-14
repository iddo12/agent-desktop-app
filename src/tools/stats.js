// TOOLS v1 GitHub public-repo stats. Runs ONLY when the user clicks Refresh (no timers). Unauthenticated GET, two calls per public
// repo (repo + releases), conditional (ETag) so an unchanged answer is a 304 and costs nothing against the limit, cached in
// tools_stats.json, guarded to 55 calls per rolling hour (GitHub allows 60), graceful when offline. Network is injected
// (fetchJson) so tests use recorded fixtures and never touch GitHub.
"use strict";

const { REPO } = require("./schema");
const API = "https://api.github.com";
const HOUR = 3600 * 1000;
const GUARD = 55;
const STALE_MS = 24 * HOUR;
const MAX_RELEASES = 10;

const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const day = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const ghUrl = (v) => (typeof v === "string" && /^https:\/\/github\.com\/[A-Za-z0-9_.\-/]+$/.test(v) ? v : null);

function parseRepo(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  return { stars: num(j.stargazers_count), forks: num(j.forks_count), watchers: num(j.subscribers_count != null ? j.subscribers_count : j.watchers_count), openIssues: num(j.open_issues_count), pushedAt: day(j.pushed_at), license: j.license && typeof j.license === "object" ? str(j.license.spdx_id, 40) : "" };
}

function parseReleases(arr) {
  if (!Array.isArray(arr)) return null;
  const rel = arr.filter((r) => r && typeof r === "object" && !Array.isArray(r) && !r.draft).slice(0, MAX_RELEASES).map((r) => {
    const assets = (Array.isArray(r.assets) ? r.assets : []).slice(0, 30).map((a) => ({ name: str(a && a.name, 120), downloads: num(a && a.download_count) }));
    return { tag: str(r.tag_name, 60), name: str(r.name, 120), date: day(r.published_at || r.created_at), url: ghUrl(r.html_url), prerelease: !!r.prerelease, assets, downloads: assets.reduce((s, a) => s + a.downloads, 0) };
  });
  return { releases: rel, downloadsTotal: rel.reduce((s, r) => s + r.downloads, 0) };
}

function emptyCache() { return { schema: 1, fetchedAt: null, rate: { remaining: null, limit: null, reset: null }, calls: [], repos: {} }; }
function loadCache(raw) {
  if (!raw || typeof raw !== "object" || raw.schema !== 1 || typeof raw.repos !== "object" || !raw.repos) return emptyCache();
  const c = emptyCache();
  c.fetchedAt = typeof raw.fetchedAt === "number" ? raw.fetchedAt : null;
  if (raw.rate && typeof raw.rate === "object") c.rate = { remaining: Number.isFinite(raw.rate.remaining) ? raw.rate.remaining : null, limit: Number.isFinite(raw.rate.limit) ? raw.rate.limit : null, reset: Number.isFinite(raw.rate.reset) ? raw.rate.reset : null };
  c.calls = Array.isArray(raw.calls) ? raw.calls.filter((t) => Number.isFinite(t)) : [];
  // re-validate every cached entry (a damaged or hand-edited file must not reach the view): rebuild through the whitelisting parsers
  for (const [repo, r] of Object.entries(raw.repos)) {
    if (!REPO.test(repo) || !r || typeof r !== "object") continue;
    const p = parseRepo({ stargazers_count: r.stars, forks_count: r.forks, subscribers_count: r.watchers, open_issues_count: r.openIssues, pushed_at: r.pushedAt, license: { spdx_id: r.license } });
    const e = Object.assign({}, p, { fetchedAt: Number.isFinite(r.fetchedAt) ? r.fetchedAt : null, notFound: !!r.notFound,
      etagRepo: typeof r.etagRepo === "string" && r.etagRepo.length < 200 ? r.etagRepo : null, etagReleases: typeof r.etagReleases === "string" && r.etagReleases.length < 200 ? r.etagReleases : null, releasesKnown: false, releases: [], downloadsTotal: 0 });
    if (r.releasesKnown === true && Array.isArray(r.releases)) {
      const rel = parseReleases(r.releases.map((x) => x && typeof x === "object" ? { tag_name: x.tag, name: x.name, published_at: x.date, html_url: x.url, prerelease: x.prerelease, assets: (Array.isArray(x.assets) ? x.assets : []).map((a) => ({ name: a && a.name, download_count: a && a.downloads })) } : null));
      if (rel) { e.releases = rel.releases; e.downloadsTotal = rel.downloadsTotal; e.releasesKnown = true; }
    }
    c.repos[repo] = e;
  }
  return c;
}

const callsInHour = (cache, now) => cache.calls.filter((t) => now - t < HOUR);
const callsLeft = (cache, now) => Math.max(0, GUARD - callsInHour(cache, now).length);

// Which tools get queried: public visibility AND a repo. Private tools are never queried, never shown with a repo link.
function eligible(tools) {
  const seen = new Set(), out = [];
  for (const t of tools) if (t && t.visibility === "public" && t.repo && !seen.has(t.repo)) { seen.add(t.repo); out.push(t.repo); }
  return out;
}

// refresh(cache, repos, {fetchJson, now}) -> { cache, summary:{fetched, notModified, failed, skipped, offline, limited} }
// fetchJson(url, headers) -> Promise<{ status, headers:{etag, 'x-ratelimit-remaining', ...}, body }>; rejects when offline.
async function refresh(cacheIn, repos, opts) {
  const o = opts || {};
  const now = o.now != null ? o.now : Date.now();
  const cache = loadCache(cacheIn);
  cache.calls = callsInHour(cache, now);
  const sum = { fetched: 0, notModified: 0, failed: 0, skipped: 0, offline: false, limited: false, notFound: 0 };
  const hdrs = (h, k) => (h && (h[k] != null ? h[k] : h[k.toLowerCase()])) || null;
  const note = (r) => {
    const h = r && r.headers; if (!h) return;
    const rem = Number(hdrs(h, "x-ratelimit-remaining")), lim = Number(hdrs(h, "x-ratelimit-limit")), rs = Number(hdrs(h, "x-ratelimit-reset"));
    if (Number.isFinite(rem)) cache.rate = { remaining: rem, limit: Number.isFinite(lim) ? lim : cache.rate.limit, reset: Number.isFinite(rs) ? rs * 1000 : cache.rate.reset };
  };
  const get = async (url, etag) => {
    if (callsLeft(cache, now) <= 0 || (cache.rate.remaining != null && cache.rate.remaining <= 1 && cache.rate.reset && cache.rate.reset > now)) { sum.limited = true; return null; }
    cache.calls.push(now);
    const r = await o.fetchJson(url, Object.assign({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, etag ? { "If-None-Match": etag } : {}));
    note(r);
    return r;
  };
  for (const repo of repos) {
    if (!REPO.test(repo)) { sum.failed++; continue; }
    const prev = cache.repos[repo] || {};
    const next = Object.assign({}, prev);
    // a 304 is only believed when we really hold the data it refers to; otherwise drop the ETag and ask again without it
    const getV = async (url, etag, hasData) => {
      let r = await get(url, hasData ? etag : null);
      if (r && r.status === 304 && !hasData) r = await get(url, null);
      return r;
    };
    try {
      const a = await getV(API + "/repos/" + repo, prev.etagRepo, !!prev.fetchedAt && !prev.notFound);
      if (!a) { sum.skipped++; continue; }
      if (a.status === 200) { const p = parseRepo(a.body); if (!p) throw new Error("shape"); Object.assign(next, p); next.etagRepo = hdrs(a.headers, "etag") || null; next.notFound = false; }
      else if (a.status === 304) { if (!prev.fetchedAt) { sum.failed++; continue; } sum.notModified++; }
      else if (a.status === 404) { next.notFound = true; sum.notFound++; cache.repos[repo] = Object.assign(next, { fetchedAt: now }); continue; }
      else if (a.status === 403 || a.status === 429) { sum.limited = true; cache.rate.remaining = 0; continue; }
      else { sum.failed++; continue; }
      const b = await getV(API + "/repos/" + repo + "/releases?per_page=" + MAX_RELEASES, prev.etagReleases, !!prev.releasesKnown);
      if (!b) { sum.skipped++; next.fetchedAt = now; cache.repos[repo] = next; continue; }       // releasesKnown stays as it was: "not checked"
      if (b.status === 200) { const p = parseReleases(b.body); if (!p) throw new Error("shape"); Object.assign(next, p); next.releasesKnown = true; next.etagReleases = hdrs(b.headers, "etag") || null; sum.fetched++; }
      else if (b.status === 304) { if (prev.releasesKnown) sum.notModified++; else sum.failed++; }
      else if (b.status === 403 || b.status === 429) { sum.limited = true; cache.rate.remaining = 0; }
      else sum.failed++;
      next.fetchedAt = now;
      cache.repos[repo] = next;
    } catch (e) { sum.offline = true; sum.failed++; }
  }
  if (sum.fetched || sum.notModified) cache.fetchedAt = now;
  return { cache, summary: sum };
}

// View of the cache for the renderer: only repos belonging to the given public tools. Honest about age.
function view(cache, tools, now) {
  const c = loadCache(cache);
  const t = now != null ? now : Date.now();
  const out = {};
  for (const tool of tools) {
    if (!tool || tool.visibility !== "public" || !tool.repo) continue;
    const r = c.repos[tool.repo];
    if (!r || !r.fetchedAt) { out[tool.id] = { fetched: false }; continue; }
    out[tool.id] = {
      fetched: true, notFound: !!r.notFound, asOf: r.fetchedAt, stale: t - r.fetchedAt > STALE_MS,
      stars: r.stars || 0, forks: r.forks || 0, watchers: r.watchers || 0, openIssues: r.openIssues || 0, pushedAt: r.pushedAt || null,
      releases: Array.isArray(r.releases) ? r.releases : [], downloadsTotal: r.downloadsTotal || 0,
      releasesKnown: !!r.releasesKnown, hasRelease: r.releasesKnown ? r.releases.length > 0 : null,   // null = release info not checked yet
    };
  }
  return { byTool: out, asOf: c.fetchedAt, callsLeft: callsLeft(c, t), guard: GUARD, rateRemaining: c.rate.remaining, rateLimit: c.rate.limit };
}

// Real network (main process only). Hostname is fixed; the path is built from validated repo names.
function realFetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "api.github.com") return reject(new Error("host"));
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers: Object.assign({ "User-Agent": "AgentDesktop-Tools" }, headers), timeout: 8000 }, (res) => {
      const chunks = []; let n = 0;
      res.on("data", (d) => { n += d.length; if (n > 2e6) { req.destroy(new Error("big")); return; } chunks.push(d); });
      res.on("end", () => { let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { /* 304 has no body */ } resolve({ status: res.statusCode, headers: res.headers, body }); });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

module.exports = { parseRepo, parseReleases, loadCache, emptyCache, eligible, refresh, view, callsLeft, realFetchJson, GUARD, STALE_MS };
