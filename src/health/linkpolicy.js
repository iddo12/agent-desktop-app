// My Health: the ONE place that decides whether an agent-written link may be opened (review finding F1).
// A link the agent writes is untrusted data: it can carry a health fact in its query string, point at your NAS or router, or spoof a
// trusted site with user@host. So: parse with `new URL`, https only, no user info, no port, no IP literal, no localhost or single-label
// host, no control or format characters, bounded length, the query string and fragment are ALWAYS dropped (they are the exfiltration
// channel), and the host must be on a short allow-list. The href that is shown and opened is rebuilt from the parsed parts.
// The allow-list below is the default; Security can replace it with `<store root>\link-allowlist.json` {"hosts":["example.org", ...]}
// (a host matches itself and its sub-domains). Pure: no fs, no Electron.
"use strict";

const DEFAULT_HOSTS = [
  "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "nih.gov", "ods.od.nih.gov", "nccih.nih.gov", "who.int", "cdc.gov", "cochranelibrary.com", "doi.org",
  "nature.com", "thelancet.com", "nejm.org", "jamanetwork.com", "bmj.com", "examine.com", "mayoclinic.org",
];
let hosts = DEFAULT_HOSTS.slice();

const MAX_PATH = 120, PATH_RE = /^[A-Za-z0-9\/._~-]*$/;
const HOST_RE = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
// Validate a list of hostnames from a config file; anything odd is dropped. Returns the list in use.
function configure(list) {
  if (list == null) { hosts = DEFAULT_HOSTS.slice(); return hosts; }
  const ok = (Array.isArray(list) ? list : []).filter((h) => typeof h === "string" && HOST_RE.test(h.toLowerCase()) && !/^\d+\.\d+\.\d+\.\d+$/.test(h)).map((h) => h.toLowerCase()).slice(0, 100);
  hosts = ok; return hosts;
}
const allowedHosts = () => hosts.slice();
const hostAllowed = (h) => hosts.some((a) => h === a || h.endsWith("." + a));

function parse(u) {
  const bad = (reason) => ({ ok: false, reason });
  if (typeof u !== "string" || u.length > 600) return bad("length");
  if (/[\u0000-\u001f\u007f-\u009f\s]/.test(u) || /\p{Cf}/u.test(u)) return bad("characters");
  let x; try { x = new URL(u); } catch (e) { return bad("unparseable"); }
  if (x.protocol !== "https:") return bad("scheme");
  if (x.username || x.password) return bad("userinfo");
  if (x.port !== "") return bad("port");
  const host = x.hostname.toLowerCase();
  if (host.startsWith("[") || /^\d+(\.\d+){0,3}$/.test(host) || /^0x/i.test(host)) return bad("ip-literal");
  if (!HOST_RE.test(host)) return bad("hostname");
  if (/(^|\.)(localhost|local|lan|internal|home|corp|intranet)$/.test(host)) return bad("local-host");
  // The PATH can carry text too (/123abc-my-ldl-is-142), so it is capped: only [A-Za-z0-9/._~-] (so no %-encoding, no unicode, no
  // punctuation), at most MAX_PATH characters, and no "." / ".." segment. Residual: short letters-and-hyphen text still fits.
  if (!PATH_RE.test(x.pathname)) return bad("path-characters");
  if (x.pathname.length > MAX_PATH) return bad("path-length");
  if (x.pathname.split("/").some((seg) => seg === "." || seg === "..")) return bad("path-dots");
  const href = "https://" + host + x.pathname;
  if (href.length > 300) return bad("length");
  return { ok: true, href, host, allowed: hostAllowed(host) };
}

module.exports = { MAX_PATH, DEFAULT_HOSTS, configure, allowedHosts, parse, hostAllowed };
