// TOOLS v1.83.1 trust-on-first-use pin for launchers. The pin file lives in <userData> (written only by the main process, never in
// the shared catalogue folder that agents can edit). A pin = resolved path + args + SHA-256 of the launcher FILE. It covers the
// launcher file, NOT the code it launches (e.g. the app a .vbs starts); it narrows "an agent edited what Start runs" to the
// launcher itself and makes every change visible once, in a native dialog.
"use strict";
const fs = require("fs");
const { readJsonFile } = require("../jsonfile");
const path = require("path");
const crypto = require("crypto");

const BIG = 20 * 1024 * 1024;     // above this (an .exe) hash size + mtime + first 1 MB, and say so
const HEAD = 1024 * 1024;

function hashFile(file, fsx) {
  const f = fsx || fs;
  const st = f.statSync(file);
  const h = crypto.createHash("sha256");
  if (st.size <= BIG) { h.update(f.readFileSync(file)); return { sha256: h.digest("hex"), size: st.size, partial: false }; }
  const fd = f.openSync(file, "r");
  try { const b = Buffer.alloc(HEAD); const n = f.readSync(fd, b, 0, HEAD, 0); h.update(b.subarray(0, n)); } finally { f.closeSync(fd); }
  h.update(String(st.size) + ":" + String(Math.floor(st.mtimeMs)));
  return { sha256: h.digest("hex"), size: st.size, partial: true };
}

const sameArgs = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

// pin: stored entry or undefined. cur: { real, args, sha256 }. -> "trusted" | "new" | "changed"
function evaluate(pin, cur) {
  if (!pin || typeof pin !== "object" || typeof pin.sha256 !== "string") return "new";
  const same = String(pin.real).toLowerCase() === String(cur.real).toLowerCase() && sameArgs(pin.args, cur.args) && pin.sha256 === cur.sha256;
  return same ? "trusted" : "changed";
}

function load(file) {
  try {
    const j = readJsonFile(file);
    if (!j || typeof j !== "object" || j.schema !== 1 || !j.pins || typeof j.pins !== "object") return { schema: 1, pins: {} };
    const pins = {};
    for (const [id, p] of Object.entries(j.pins)) if (p && typeof p.real === "string" && typeof p.sha256 === "string" && /^[0-9a-f]{64}$/.test(p.sha256) && Array.isArray(p.args)) pins[id] = { real: p.real, args: p.args.filter((a) => typeof a === "string"), sha256: p.sha256, size: p.size | 0, partial: !!p.partial, approvedAt: typeof p.approvedAt === "string" ? p.approvedAt : "" };
    return { schema: 1, pins };
  } catch (e) { return { schema: 1, pins: {} }; }
}
function save(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  const fd = fs.openSync(tmp, "w"); try { fs.writeSync(fd, JSON.stringify(doc)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

module.exports = { hashFile, evaluate, load, save, BIG };
