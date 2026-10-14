// My Health Body tab: the main-process side of pain_log.jsonl (v1.118.0). The file lives in the health store folder (the same folder that holds
// the other My Health data, resolved by roots.js: the vault's `extracted` folder, or the sandbox test folder / AGENT_DESKTOP_HEALTH_ROOT in test
// mode). It never leaves the PC. The renderer never sees a path and never touches the file: it sends entries, this module validates them
// (body-logic.js), caps sizes and appends. Append-only: one JSON object per line; an update is a new line with the same id and a later
// "updated"; latest wins. A half-written last line (crash mid-append) is tolerated on read and healed (a newline is added) on the next append.
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("./body-logic");

const FILE = "pain_log.jsonl";
const MAX_SAVE = 8;          // entries per save call (a both-sides spot is 2; leave room)

function create({ root, fsx, now }) {
  const f = fsx || fs, file = path.join(root, FILE);
  const stamp = () => (typeof now === "function" ? now() : new Date().toISOString());
  const today = () => L.localDate(new Date());

  function readText() {
    let st; try { st = f.statSync(file); } catch (e) { return ""; }
    if (st.size > L.D.limits.maxFileBytes) throw Object.assign(new Error("too big"), { code: "TOOBIG" });
    return f.readFileSync(file, "utf8");
  }
  function load() {
    let text; try { text = readText(); } catch (e) { return e.code === "TOOBIG" ? { ok: false, reason: "The pain log file is too large to open." } : { ok: false, reason: "The pain log could not be read." }; }
    const p = L.parseLog(text), merged = L.mergeLatest(p.entries);
    return { ok: true, entries: merged.slice(-L.D.limits.maxEntries), skipped: p.skipped, today: today() };
  }
  // entries: array of raw entries from the renderer. All are validated first; nothing is written unless every one passes.
  function save(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > MAX_SAVE) return { ok: false, reason: "Nothing to save." };
    const at = stamp(), clean = [], prior = {};
    try { L.mergeLatest(L.parseLog(readText()).entries).forEach((e) => { prior[e.id] = e; }); } catch (e) { /* unreadable: no prior answers to keep */ }
    for (const raw of entries) {
      const r = L.validateEntry(raw, { now: at, prior });
      if (!r.ok) return { ok: false, reason: r.reason };
      if (r.entry.date > today() && r.entry.date !== L.addDays(today(), 1)) return { ok: false, reason: "That date is in the future." };
      clean.push(r.entry);
    }
    let size = 0, endsWithNewline = true;
    try { const st = f.statSync(file); size = st.size; if (size > 0) { const fd = f.openSync(file, "r"); try { const b = Buffer.alloc(1); f.readSync(fd, b, 0, 1, size - 1); endsWithNewline = b[0] === 10; } finally { f.closeSync(fd); } } } catch (e) { size = 0; }
    if (size > L.D.limits.maxFileBytes) return { ok: false, reason: "The pain log file is too large to add to." };
    f.mkdirSync(root, { recursive: true });
    const text = (endsWithNewline ? "" : "\n") + clean.map(L.serialize).join("");
    f.appendFileSync(file, text, "utf8");        // one append call: the lines of a both-sides spot land together
    return Object.assign(load(), { saved: clean.length, flagged: clean.some((e) => e.safety_flag) });
  }
  return { load, save, file };
}

module.exports = { create, FILE };
