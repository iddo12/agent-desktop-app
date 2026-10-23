// v1.141.0: the owner edits WHO looks for skills/plugins this week, from the Skills & Plugins tab. File: <research>\skills_plugins_rotation.json
// (read by shared_tools\agent_jobs\Run-SkillsWatch.ps1, which passes each name to Run-AgentJob.ps1 -Agent, so names are agent FOLDER names).
// Rules: only "agents" changes (plus setAt = today); every other field is kept as it is. The new list may contain only agents Agent Desktop
// knows (folder names, hidden agents included; a display name is mapped to its folder) or names already in the file; never empty; duplicates
// dropped. The renderer sends the list it saw ("expected"); if the file changed since, nothing is written. Once per day the file is copied to
// <file>.bak_<YYYY-MM-DD> before the first change. Async (Dropbox can be slow; nothing blocks the main thread). Atomic: temp file + rename,
// UTF-8 without BOM. No electron import: everything is injected so the tests can drive it.
"use strict";
const fsp = require("fs").promises;

const MAX_AGENTS = 40, MAX_NAME = 120, MAX_FILE_BYTES = 256 * 1024;
const BAD_NAME_RE = /[\\/:*?"<>|\u0000-\u001f]|\.\./;
const norm = (s) => String(s || "").trim().toLowerCase();
const day = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => norm(x) === norm(b[i]));

async function readRotation(file) {
  let st;
  try { st = await fsp.lstat(file); } catch (e) { return { error: "The rotation file is not there yet, so there is nothing to change." }; }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return { error: "The rotation file could not be read." };
  try {
    const raw = (await fsp.readFile(file, "utf8")).replace(/^﻿/, "");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || Array.isArray(j)) return { error: "The rotation file could not be read." };
    return { json: j, raw };
  } catch (e) { return { error: "The rotation file could not be read." }; }
}

// setAgents({ file, agents, expected, known, now }) -> { ok:true, agents, previous, setAt } | { ok:false, reason, stale? }
//   known: [{ folderName, displayName }] from Agent Desktop's own agent list (hidden agents included)
async function setAgents(o) {
  const file = o && o.file;
  if (!file) return { ok: false, reason: "The research folder is not set up." };
  if (!Array.isArray(o.agents)) return { ok: false, reason: "Bad request." };
  const r = await readRotation(file);
  if (r.error) return { ok: false, reason: r.error };
  const current = Array.isArray(r.json.agents) ? r.json.agents.filter((x) => typeof x === "string") : [];
  if (Array.isArray(o.expected) && !sameList(o.expected, current)) return { ok: false, stale: true, reason: "The list was changed somewhere else since you opened this tab. Press Refresh and try again." };
  const byKey = new Map();
  (Array.isArray(o.known) ? o.known : []).forEach((a) => {
    if (!a || typeof a.folderName !== "string" || !a.folderName.trim()) return;
    byKey.set(norm(a.folderName), a.folderName.trim());
    if (typeof a.displayName === "string" && a.displayName.trim() && !byKey.has(norm(a.displayName))) byKey.set(norm(a.displayName), a.folderName.trim());
  });
  current.forEach((n) => { if (!byKey.has(norm(n))) byKey.set(norm(n), n); });
  const out = [], seen = new Set();
  for (const raw of o.agents.slice(0, MAX_AGENTS + 1)) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_NAME || BAD_NAME_RE.test(raw)) return { ok: false, reason: "That is not an agent name." };
    const name = byKey.get(norm(raw));
    if (!name) return { ok: false, reason: "\"" + raw.trim().slice(0, 60) + "\" is not one of your agents." };
    if (seen.has(norm(name))) continue;
    seen.add(norm(name)); out.push(name);
  }
  if (!out.length) return { ok: false, reason: "At least one agent has to look each week. Add another agent before removing the last one." };
  if (out.length > MAX_AGENTS) return { ok: false, reason: "That is too many agents for one week." };
  const now = typeof o.now === "number" ? o.now : Date.now(), today = day(now);
  // one backup per day, before the first change of that day ("wx": never overwrite that day's backup)
  try { await fsp.writeFile(file + ".bak_" + today, r.raw, { encoding: "utf8", flag: "wx" }); }
  catch (e) { if (!e || e.code !== "EEXIST") return { ok: false, reason: "Could not make a backup of the rotation file, so nothing was changed." }; }
  const next = Object.assign({}, r.json, { agents: out, setAt: today });
  const tmp = file + "." + process.pid + "." + now + ".tmp";
  try {
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fsp.rename(tmp, file);
  } catch (e) { try { await fsp.unlink(tmp); } catch (x) { /* nothing to clean */ } return { ok: false, reason: "The rotation file could not be saved." }; }
  return { ok: true, agents: out, previous: current, setAt: today, schedule: typeof r.json.schedule === "string" ? r.json.schedule.slice(0, 400) : "" };
}

module.exports = { setAgents, readRotation, day };
