// Which agents a linked person can NEVER reach by direct message, whatever the Direct-access mode (v1.126.0 review fix, HIGH 1).
// Same policy as the wake-agent guard (src/wakeAgent.js): the never-wake list (default names, word stems in English and Hebrew, the
// partner's first name, plus the extras in <userData>\wake\wake_config.json "neverWake") and any agent whose agent_config.json says
// personal_data. An agent we cannot find is treated as sensitive (fail closed). Plain Node; the roster comes in as a function.
const fs = require("fs");
const path = require("path");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (e) { return null; }
}

// opts: { userData, roster() -> [{ folderName, displayName, path }], wake (the wakeAgent module, injectable for tests) }
function createSensitive(opts) {
  const W = opts.wake || require("../wakeAgent");
  let extra = [], extraAt = 0;
  const extras = () => {
    const t = Date.now();
    if (t - extraAt > 60000) {
      const j = opts.userData ? readJson(path.join(opts.userData, "wake", "wake_config.json")) : null;
      extra = j && Array.isArray(j.neverWake) ? j.neverWake.filter((x) => typeof x === "string") : [];
      extraAt = t;
    }
    return extra;
  };
  // the agent record by folder name (or display name), case-insensitive
  const find = (name) => {
    const n = String(name || "").trim().toLowerCase();
    return (opts.roster() || []).find((a) => String(a.folderName).toLowerCase() === n || String(a.displayName || "").toLowerCase() === n) || null;
  };
  function isSensitive(name) {
    const a = find(name);
    if (!a) return true;
    try {
      if (W.isNeverWake(extras(), { displayName: a.displayName || a.folderName, folderName: a.folderName })) return true;
      if (W.isNeverWake(extras(), { displayName: a.folderName, folderName: a.folderName })) return true;
      const cfg = a.path ? readJson(path.join(a.path, "agent_config.json")) : null;
      if (W.flaggedPersonal(cfg)) return true;
    } catch (e) { return true; }
    return false;
  }
  return { isSensitive, find };
}

module.exports = { createSensitive };
