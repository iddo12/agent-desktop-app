// Hidden agents (v1.140.0). The owner can hide agents he talks to elsewhere from Agent Desktop's sidebar, pickers and fleet views, WITHOUT
// stopping, pausing or deleting them. Setting: appConfig key "hiddenAgents" = folder (or display) names separated by ";" or "," (default empty;
// no names in code). Only the renderer-facing lists carry the flag (list-agents, get-agent-overview); the main process's own listAgents() is
// untouched, so delivery, wake-up, keep-going, handoff and every other background flow still find a hidden agent by name or path.
"use strict";

const MAX_NAMES = 50;

function parse(value) {
  const out = new Set();
  if (typeof value !== "string") return out;
  for (const part of value.split(/[;,\n]/)) {
    const n = part.trim().toLowerCase();
    if (n && n.length <= 120 && out.size < MAX_NAMES) out.add(n);
  }
  return out;
}

function isHidden(agent, set) {
  if (!agent || !set || !set.size) return false;
  const f = String(agent.folderName || "").trim().toLowerCase(), d = String(agent.displayName || "").trim().toLowerCase();
  return (!!f && set.has(f)) || (!!d && set.has(d));
}

// returns a NEW array of shallow copies with hidden:true/false; never drops an agent
function mark(list, value) {
  const set = parse(value);
  return (Array.isArray(list) ? list : []).map((a) => (a && typeof a === "object" ? Object.assign({}, a, { hidden: isHidden(a, set) }) : a));
}

// v1.141.0 (SE review): the ONE place that reads the setting, used by both the list marking (main.js) and the research writer
// (research/main-research.js). appConfig.get already applies the order environment (AGENT_DESKTOP_HIDDEN_AGENTS) > app-config.json, so both
// paths honour the env override the same way. cfg is injectable for tests.
function configured(cfg) {
  try { const v = (cfg || require("./appConfig")).get("hiddenAgents"); return typeof v === "string" ? v : null; } catch (e) { return null; }
}
// for a writer that only knows an agent's FOLDER: find its display name in the agent list, so a display name in the setting also hides it
function makeIsHidden({ listAgents, cfg } = {}) {
  return (folder) => {
    const set = parse(configured(cfg));
    if (!set.size || typeof folder !== "string") return false;
    let displayName = "";
    try { const a = (typeof listAgents === "function" ? listAgents() : []).find((x) => x && typeof x.folderName === "string" && x.folderName.toLowerCase() === folder.toLowerCase()); displayName = a && typeof a.displayName === "string" ? a.displayName : ""; } catch (e) { displayName = ""; }
    return isHidden({ folderName: folder, displayName }, set);
  };
}

module.exports = { parse, isHidden, mark, configured, makeIsHidden };
