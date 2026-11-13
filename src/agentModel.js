"use strict";
// Per-agent model choice (v1.157.0). pinnedModelFor() in main.js reads <userData>\agent-model.json
// {"default":"sonnet","agents":{"<folder name>":"opus"}}; the header's model dropdown writes the same file.
const fs = require("fs");
const path = require("path");
const { readJsonFile } = require("./jsonfile");

const MODELS = [
  { id: "sonnet", label: "Sonnet 5.5" },
  { id: "opus", label: "Opus 5.5" },
  { id: "fable", label: "Fable 5.1" },
  { id: "haiku", label: "Haiku 5.5" },
];
const IDS = new Set(MODELS.map((m) => m.id));

function readCfg(file) {
  try { const c = readJsonFile(file); return c && typeof c === "object" ? c : {}; } catch (_) { return {}; }
}

/** Set one agent's model (agentName = its folder name); returns the saved id. Throws on an unknown model. */
function setAgentModel(file, agentName, modelId) {
  const id = String(modelId || "").toLowerCase();
  if (!IDS.has(id)) throw new Error("unknown model: " + modelId);
  if (!agentName || /[\/]/.test(agentName)) throw new Error("bad agent name");
  const cfg = readCfg(file);
  if (!cfg.agents || typeof cfg.agents !== "object") cfg.agents = {};
  cfg.agents[agentName] = id;
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
  return id;
}

/** Which dropdown entry matches a full model id such as "claude-sonnet-5-5"; "" if none. */
function matchModelId(full) {
  const s = String(full || "").toLowerCase();
  for (const m of MODELS) if (s.includes(m.id)) return m.id;
  return "";
}

module.exports = { MODELS, setAgentModel, matchModelId, readCfg };
