// Data for the ARGUS Memory view (v1.72.0): how full each agent's memory is.
//
// Reads two files other agents already write; never writes either (their locations are the memoryStatsFile / memoryBaselineFile settings):
//   memory_stats.json
//       per project key: l1_bytes (MEMORY.md), l2_bytes (INDEX_FULL.md),
//       l3_bytes / l3_files (topic .md files), l1_cap (4096)
//   baseline_context.json (optional)
//       agents{name:{medianFirstTurnTokens}} and history[] of earlier medians
// Keys are "<memoryKeyPrefix><Name>--claude-session" (the prefix is Claude Code's encoding of the agents folder), except some agents'
// real data sits under a key with no suffix, and many keys are empty duplicates
// or sandbox runs. So agents are matched by name (letters and digits only,
// lower case) and the key with the most bytes wins.
//
// ctx = { statsFile, baselineFile (optional), keyPrefix } built by main from appConfig. Missing statsFile or keyPrefix = not set up.

const fs = require("fs");
const os = require("os");
const path = require("path");


function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, "")); } catch (e) { return null; }
}

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

function ready(ctx) { return !!(ctx && ctx.statsFile && ctx.keyPrefix); }
const needsSetup = () => ({ ok: false, reason: "needs-setup", needsSetup: true, error: "needs-setup", agents: {} });

function keyName(ctx, key) {
  return String(key).slice(ctx.keyPrefix.length).replace(/--claude-session$/, "");
}

function getMemoryData(ctx) {
  if (!ready(ctx)) return needsSetup();
  const stats = readJson(ctx.statsFile);
  if (!stats || !Array.isArray(stats.agents)) return { ok: false, error: "memory_stats.json not readable", agents: {} };
  const base = (ctx.baselineFile && readJson(ctx.baselineFile)) || {};
  const history = Array.isArray(base.history) ? base.history : [];
  const agents = {};
  for (const a of stats.agents) {
    if (!a || typeof a.agent !== "string" || !a.agent.startsWith(ctx.keyPrefix)) continue;
    const n = norm(keyName(ctx, a.agent));
    if (!n) continue;
    const total = (a.l1_bytes || 0) + (a.l2_bytes || 0) + (a.l3_bytes || 0);
    if (agents[n] && agents[n].total >= total) continue;
    agents[n] = { key: a.agent, l1: a.l1_bytes || 0, l2: a.l2_bytes || 0, l3: a.l3_bytes || 0,
      files: a.l3_files || 0, cap: a.l1_cap || 4096, total };
  }
  // Startup tokens: baseline names drop "&", so norm() lines them up too.
  const tok = {};
  for (const [name, v] of Object.entries(base.agents || {})) tok[norm(name)] = v && v.medianFirstTurnTokens;
  // history[i].agents or history[i] itself maps name -> tokens; take the latest
  // figure that differs from today's as the "before" number.
  const prevTok = {};
  for (let i = history.length - 2; i >= 0; i--) {
    const h = history[i] && (history[i].agents || history[i].medians || history[i]);
    if (!h || typeof h !== "object") continue;
    for (const [name, v] of Object.entries(h)) {
      const k = norm(name);
      const val = typeof v === "number" ? v : v && v.medianFirstTurnTokens;
      if (typeof val === "number" && prevTok[k] === undefined && val !== tok[k]) prevTok[k] = val;
    }
  }
  for (const n of Object.keys(agents)) {
    agents[n].tokens = typeof tok[n] === "number" ? tok[n] : null;
    agents[n].prevTokens = typeof prevTok[n] === "number" ? prevTok[n] : null;
  }
  return { ok: true, generated: stats.generated || null, baselineAt: base.at || null, agents };
}

// Opens the agent's memory folder. The key must be one memory_stats.json lists
// (so the renderer cannot ask for an arbitrary path).
function openMemoryFolder(ctx, key) {
  if (!ready(ctx)) return needsSetup();
  const stats = readJson(ctx.statsFile);
  const known = stats && Array.isArray(stats.agents) && stats.agents.some((a) => a && a.agent === key);
  if (!known || typeof key !== "string" || !key.startsWith(ctx.keyPrefix)) return { ok: false, error: "unknown memory key" };
  const dir = path.join(os.homedir(), ".claude", "projects", key, "memory");
  if (!fs.existsSync(dir)) return { ok: false, error: "no memory folder" };
  const { shell } = require("electron");
  return shell.openPath(dir).then((err) => ({ ok: !err, error: err || undefined }));
}

module.exports = { getMemoryData, openMemoryFolder, norm };
