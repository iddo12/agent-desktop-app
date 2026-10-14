// MY FINANCE generic CSV reader (v1.90.0 skeleton, main process). NO bank-specific logic: it finds the header row, guesses which column
// is the date / description / amount (or debit + credit) / balance from Hebrew or English header words, and counts how many rows have a
// readable date and amount. Used by the Import tab as a PREVIEW only; nothing is written to the ledger. Bank-specific mappings come later,
// from the owner's real sample files. No I/O, no logging.
// HOSTILE INPUT (review B2): at most 64 columns, lines cut at 16 KB, header candidates over 4 KB skipped, 50 000 rows counted at most, and
// parseCsvAsync yields to the event loop every 2 000 lines, so a broken or huge export can never freeze the main process.
"use strict";

const ROLES = ["date", "description", "amount", "debit", "credit", "balance"];
const MAX_COLS = 64, MAX_LINE = 16 * 1024, MAX_HEADER_LINE = 4 * 1024, MAX_ROWS = 50000, CHUNK = 2000;
// Header words per role. Order matters inside a role (first match wins); a column gets at most one role.
const WORDS = {
  date: [/^תאריך עסקה/, /^תאריך$/, /^תאריך/, /date/i, /^יום ערך/],
  description: [/שם בית ה?עסק/, /^תיאור/, /^פרטים/, /^הפעולה/, /description/i, /merchant/i, /payee/i, /details/i, /narrative/i],
  amount: [/^סכום/, /amount/i, /^sum$/i],
  debit: [/^חובה/, /debit/i, /withdrawal/i, /^out$/i],
  credit: [/^זכות/, /credit/i, /deposit/i, /^in$/i],
  balance: [/^יתרה/, /balance/i],
};

function swap16(buf) { const b = Buffer.from(buf); for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; } return b; }
function decode(buf) {
  if (typeof buf === "string") return { text: buf.replace(/^﻿/, ""), encoding: "text" };
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { text: buf.slice(3).toString("utf8"), encoding: "utf-8" };
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { text: buf.slice(2).toString("utf16le"), encoding: "utf-16le" };
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return { text: swap16(buf.slice(2)).toString("utf16le"), encoding: "utf-16be" };
  // UTF-16 without a BOM: many zero bytes, all on odd (LE) or even (BE) positions
  const n = Math.min(buf.length, 4096) & ~1;
  if (n >= 4) {
    let odd = 0, even = 0; for (let i = 0; i < n; i += 2) { if (buf[i] === 0) even++; if (buf[i + 1] === 0) odd++; }
    if (odd > n / 8 && even === 0) return { text: buf.toString("utf16le"), encoding: "utf-16le" };
    if (even > n / 8 && odd === 0) return { text: swap16(buf).toString("utf16le"), encoding: "utf-16be" };
  }
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" }; } catch (e) { /* not UTF-8: Israeli bank files are often Windows-1255 */ }
  try { return { text: new TextDecoder("windows-1255").decode(buf), encoding: "windows-1255" }; } catch (e) { return { text: buf.toString("latin1"), encoding: "latin1" }; }
}

function detectDelimiter(lines) {
  const sample = lines.slice(0, 20).map((l) => l.slice(0, MAX_HEADER_LINE));
  let best = ",", bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = sample.map((l) => splitLine(l, d).length).filter((n) => n > 1);
    const score = counts.length ? counts.length * 10 + Math.min(MAX_COLS, Math.max(...counts)) : 0;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

// One CSV line -> at most MAX_COLS cells (quotes, doubled quotes). The line is cut at MAX_LINE first. A quoted line break is not supported.
function splitLine(line, delim) {
  const s = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
  const out = []; let cur = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { out.push(cur.trim()); cur = ""; if (out.length >= MAX_COLS) return out; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

// "1,234.50" "-12" "(12.00)" "12.00-" "₪ 1,000" "1.234,50" "12,34" -> number, or null ("1,2,3" is not a number)
function parseAmount(v) {
  let s = String(v == null ? "" : v).trim();
  if (!s || s.length > 40) return null;
  s = s.replace(/[‎‏‪-‮]/g, "").replace(/₪|NIS|ILS|ש"ח|ש״ח|\$|€/gi, "").replace(/\s/g, "").replace(/−/g, "-");
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (/^-/.test(s)) { neg = true; s = s.slice(1); }
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");   // 1.234,50
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");                               // 12,34 = decimal comma
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");                 // 1,234.50
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

// dd/mm/yyyy, dd.mm.yy, dd-mm-yyyy, yyyy-mm-dd -> "yyyy-mm-dd" or null (Israeli files are day-first). Two-digit years: 20yy unless that is
// more than a year ahead, then 19yy. Years before 1990 or more than a year ahead are refused.
function parseDate(v, now) {
  const s = String(v == null ? "" : v).trim().replace(/[‎‏]/g, "");
  const maxY = (now instanceof Date ? now : new Date()).getFullYear() + 1;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; if (m[3].length === 2) y = 2000 + y > maxY ? 1900 + y : 2000 + y; }
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > maxY) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

// For the FUTURE accountant export (Excel/CSV): a text cell starting with = + - @ tab or CR is read as a formula by spreadsheet apps
// (CSV injection). Prefix it with an apostrophe. Numbers stay numbers.
function spreadsheetSafe(v) {
  if (typeof v !== "string") return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

function guessMapping(header) {
  const map = Object.create(null); const used = new Set();
  const h = header.slice(0, MAX_COLS);
  for (const role of ROLES) {
    for (const re of WORDS[role]) {
      const i = h.findIndex((x, k) => !used.has(k) && re.test(String(x || "").trim().slice(0, 200)));
      if (i >= 0) { map[role] = i; used.add(i); break; }
    }
  }
  return map;
}
const mappingScore = (m) => Object.keys(m).length + (m.date != null ? 1 : 0) + (m.amount != null || m.debit != null || m.credit != null ? 1 : 0);

// The parser as a generator: yields after every CHUNK lines so parseCsvAsync can hand the event loop back. parseCsv runs it straight through.
function* parseSteps(input, opts) {
  const o = opts || {};
  const maxPreview = o.preview || 5;
  const { text, encoding } = decode(input);
  const lines = text.split(/\r\n|\n|\r/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return { ok: false, encoding, note: "The file is empty." };
  yield;
  const delimiter = detectDelimiter(lines);
  // the header is the row (within the first 15) whose words best match; banks often put a title line or two above it
  let headerRow = -1, mapping = Object.create(null), best = 0;
  for (let i = 0; i < Math.min(15, lines.length); i++) {
    if (lines[i].length > MAX_HEADER_LINE) continue;
    const m = guessMapping(splitLine(lines[i], delimiter));
    const sc = mappingScore(m);
    if (sc > best && m.date != null) { best = sc; headerRow = i; mapping = m; }
  }
  if (headerRow < 0) return { ok: false, encoding, delimiter: delimiter === "\t" ? "tab" : delimiter, note: "No header row with a date column was found in the first 15 lines, so the columns could not be guessed." };
  const header = splitLine(lines[headerRow], delimiter);
  const roleOf = new Map(); for (const r of Object.keys(mapping)) roleOf.set(mapping[r], r);
  const columns = header.map((name, i) => ({ name: String(name).slice(0, 80), role: roleOf.get(i) || "" }));
  let rows = 0, usable = 0, firstDate = null, lastDate = null, cut = false, longLines = 0;
  const preview = [];
  for (let i = headerRow + 1; i < lines.length; i++) {
    if ((i - headerRow) % CHUNK === 0) yield;
    if (rows >= MAX_ROWS) { cut = true; break; }
    if (!lines[i].trim()) continue;
    if (lines[i].length > MAX_LINE) longLines++;
    const cells = splitLine(lines[i], delimiter);
    if (cells.every((c) => !c)) continue;
    rows++;
    const date = parseDate(cells[mapping.date], o.now);
    let amount = mapping.amount != null ? parseAmount(cells[mapping.amount]) : null;
    if (amount == null && (mapping.debit != null || mapping.credit != null)) {
      const dr = mapping.debit != null ? parseAmount(cells[mapping.debit]) : null, cr = mapping.credit != null ? parseAmount(cells[mapping.credit]) : null;
      if (dr != null || cr != null) amount = (cr || 0) - Math.abs(dr || 0);
    }
    const ok = !!date && amount != null;
    if (ok) { usable++; if (!firstDate || date < firstDate) firstDate = date; if (!lastDate || date > lastDate) lastDate = date; }
    if (preview.length < maxPreview) preview.push({ date: date || "", description: String(cells[mapping.description] || "").slice(0, 120), amount: amount == null ? null : amount, balance: mapping.balance != null ? parseAmount(cells[mapping.balance]) : null, ok });
  }
  const missing = [];
  if (mapping.amount == null && mapping.debit == null && mapping.credit == null) missing.push("amount");
  if (mapping.description == null) missing.push("description");
  const notes = [];
  if (cut) notes.push("Only the first " + MAX_ROWS + " rows were counted.");
  if (longLines) notes.push(longLines + " very long lines were cut.");
  return { ok: true, encoding, delimiter: delimiter === "\t" ? "tab" : delimiter, headerRow: headerRow + 1, columns, mapping: Object.assign({}, mapping), rows, usable, firstDate, lastDate, preview, missing, note: notes.join(" ") };
}

// text|Buffer -> { ok, encoding, delimiter, headerRow, columns:[{name, role}], mapping, rows, usable, firstDate, lastDate, preview:[...], missing, note }
function parseCsv(input, opts) {
  const it = parseSteps(input, opts);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}
async function parseCsvAsync(input, opts) {
  const it = parseSteps(input, opts);
  for (;;) { const r = it.next(); if (r.done) return r.value; await new Promise((res) => setImmediate(res)); }
}

module.exports = { parseCsv, parseCsvAsync, parseAmount, parseDate, splitLine, detectDelimiter, guessMapping, decode, spreadsheetSafe, ROLES, MAX_COLS, MAX_LINE };
