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

module.exports = { parse, isHidden, mark };
