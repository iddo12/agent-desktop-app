// CONTACTS mail search (main process). Asks the Betterbird Super Search service (127.0.0.1, read-only GET, token header) for mails matching a
// company's domain/aliases plus keywords. The renderer never sees the token or a URL: it sends a company/person id and short keywords.
// Endpoints used: GET /search?q=&scope=everything&att=1 (att only when "with" is the only box ticked), GET /message?id= (Message-ID to open).
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const HOST = "127.0.0.1", PORT = 48766, MAX_TOKEN_BYTES = 256, MAX_ROWS = 50, MAX_KEYWORDS = 120, TIMEOUT_MS = 8000, TOTAL_MS = 10000, MAX_BODY = 4 * 1024 * 1024;

/** Token file written by `python -m supersearch setup` (user-only). Never logged, never sent to the renderer. */
function tokenPath(env) {
  const e = env || process.env;
  const base = e.LOCALAPPDATA || path.join(e.USERPROFILE || e.HOME || ".", ".local", "share");
  return path.join(base, "BetterbirdSuperSearch", "token");
}
function readToken(file) {
  try { const st = fs.statSync(file); if (!st.isFile() || st.size > MAX_TOKEN_BYTES) return null; const t = fs.readFileSync(file, "ascii").trim(); return /^[A-Za-z0-9_-]{32,}$/.test(t) ? t : null; } catch (e) { return null; }
}

/** Search terms that pin results to a company: its domain, or (no domain) one alias. Plain tokens only. */
function companyTerms(company) {
  const bad = /[^a-z0-9.@_-]/i;
  const d = company && company.domain && !bad.test(company.domain) ? String(company.domain).toLowerCase() : null;
  if (d) return [d];
  const a = (company && company.aliases || []).map((x) => String(x).trim()).find((x) => x.length >= 3 && x.length <= 60 && !/["\\]/.test(x));
  return a ? [a] : [];
}
function cleanKeywords(s) { return String(s == null ? "" : s).replace(/[\u0000-\u001f"\\{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_KEYWORDS); }

function getJson(port, pathAndQuery, token) {
  return new Promise((resolve) => {
    let done = false, req = null, deadline = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(deadline); try { if (req) req.destroy(); } catch (e) { /* gone */ } resolve(v); };
    deadline = setTimeout(() => finish({ code: 0, body: null }), TOTAL_MS);   // whole-request ceiling, whatever the socket does
    req = http.request({ host: HOST, port, path: pathAndQuery, method: "GET", headers: { "X-SS-Token": token, Host: HOST + ":" + port }, timeout: TIMEOUT_MS }, (res) => {
      let n = 0; const chunks = [];
      res.on("data", (c) => { n += c.length; if (n > MAX_BODY) return finish({ code: 0, body: null }); chunks.push(c); });
      res.on("end", () => { let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { /* not JSON */ } finish({ code: res.statusCode, body }); });
      res.on("aborted", () => finish({ code: 0, body: null }));
      res.on("error", () => finish({ code: 0, body: null }));
      res.on("close", () => finish({ code: 0, body: null }));
    });
    req.on("timeout", () => finish({ code: 0, body: null }));
    req.on("error", () => finish({ code: 0, body: null }));
    req.on("close", () => finish({ code: 0, body: null }));
    req.end();
  });
}

const cap = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, n);

/**
 * opts: { company:{domain,aliases}, keywords, withAtt, withoutAtt }. Both ticked or neither = no attachment filter.
 * Returns { ok, rows:[{id,date,subject,person,addr,att}], total, more } or { ok:false, reason }.
 */
async function searchMails(opts, env) {
  const port = (env && env.port) || PORT;
  const token = readToken((env && env.tokenFile) || tokenPath());
  if (!token) return { ok: false, reason: "Mail search is not set up: the Super Search token was not found on this PC." };
  const terms = companyTerms(opts.company);
  if (!terms.length) return { ok: false, reason: "This company has no domain or alias to limit the search to." };
  const kw = cleanKeywords(opts.keywords);
  const q = terms.concat(kw ? kw.split(" ") : []).join(" ");
  const only = !!opts.withAtt !== !!opts.withoutAtt;
  const qs = "/search?q=" + encodeURIComponent(q) + "&scope=everything" + (only && opts.withAtt ? "&att=1" : "");
  const r = await getJson(port, qs, token);
  if (r.code === 0) return { ok: false, reason: "The Super Search service is not running." };
  if (r.code === 403) return { ok: false, reason: "The Super Search service refused the token." };
  if (r.code !== 200 || !r.body || !Array.isArray(r.body.rows)) return { ok: false, reason: "The Super Search service gave no usable answer." };
  let rows = r.body.rows;
  rows = rows.filter((m) => m && typeof m === "object");
  if (only && opts.withoutAtt) rows = rows.filter((m) => !m.has_att);
  const out = rows.filter((m) => m && typeof m === "object").slice(0, MAX_ROWS).map((m) => ({ id: Number.isInteger(m.id) ? m.id : 0, date: m.ts ? new Date(m.ts * 1000).toISOString().slice(0, 10) : "", subject: cap(m.subject, 200), person: cap(m.sender, 120), addr: cap(m.sender_addr, 200), att: !!m.has_att }));
  return { ok: true, rows: out, total: rows.length, more: Math.max(0, rows.length - out.length) };
}

/** Ask Betterbird to show a message: look up its Message-ID, then launch `betterbird mid:<id>`. */
async function openMail(id, env, launch) {
  const port = (env && env.port) || PORT;
  const token = readToken((env && env.tokenFile) || tokenPath());
  if (!token || !Number.isInteger(id) || id < 1) return { ok: false, reason: "Cannot open that mail." };
  const r = await getJson(port, "/message?id=" + id, token);
  const mid = r.code === 200 && r.body && r.body.message_id;
  if (typeof mid !== "string" || !/^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~.@-]{1,300}$/.test(mid) || mid.startsWith("-")) return { ok: false, reason: "Betterbird could not find that mail." };
  const exe = (env && env.betterbird) || findBetterbird();
  if (!exe) return { ok: false, reason: "Betterbird was not found on this PC." };
  try { (launch || ((e, a) => { const c = spawn(e, a, { detached: true, stdio: "ignore" }); c.unref(); }))(exe, ["mid:" + mid]); return { ok: true }; } catch (e) { return { ok: false, reason: "Betterbird did not start." }; }
}
function findBetterbird() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")].filter(Boolean);
  for (const r of roots) { const f = path.join(r, "Betterbird", "betterbird.exe"); try { if (fs.statSync(f).isFile()) return f; } catch (e) { /* next */ } }
  return null;
}

module.exports = { searchMails, openMail, companyTerms, cleanKeywords, tokenPath, readToken, PORT };
