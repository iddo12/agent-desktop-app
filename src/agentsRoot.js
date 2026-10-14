"use strict";
// Where the agent folders live (v1.121.0). ONE rule for agents.js, groups.js and main.js:
//   1. AGENT_DESKTOP_AGENTS_ROOT (appConfig environment form) or the old AGENT_DESKTOP_ROOT variable, whichever is set   (tests, sandboxes)
//   2. appConfig "agentsRoot" (userData/app-config.json, or derived from the workspace folder)
//   3. the folder this program sits in, when that folder already contains agent folders (installs made before the configuration layer)
//   4. nothing: null. Callers then show a calm "needs setup" state (no agents yet) instead of reading a made-up folder.
// Read lazily on every call (cheap: the config file is cached) so the sandbox's userData redirect has happened and a change made in
// Setup is seen without a restart by the code that calls getRoot() each time.

const fs = require("fs");
const path = require("path");

const MARKERS = ["agent_config.json", "master_state.md", "sessions", ".claude-session"]; // same four markers agents.js uses (agent_config.json etc.)
const SKIP = new Set(["agent-desktop", ".claude", "node_modules", "sessions"]);

let cfgMod = null;
const cfgx = () => cfgMod || (cfgMod = require("./appConfig"));
let siblingMemo; // undefined = not looked yet; string|null afterwards (a fresh decision needs a restart, and Setup's value always wins first)

function siblingRoot(repoDir) {
  if (siblingMemo !== undefined && !repoDir) return siblingMemo;
  let found = null;
  try {
    const parent = path.resolve(repoDir || path.join(__dirname, ".."), ".."); // the folder the program folder sits in (the old rule)
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const p = path.join(parent, e.name);
      if (MARKERS.some((m) => { try { return fs.existsSync(path.join(p, m)); } catch (x) { return false; } })) { found = parent; break; }
    }
  } catch (e) { found = null; }
  if (!repoDir) siblingMemo = found;
  return found;
}

// opts (tests): { env, cfg, repoDir }
function getRoot(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  let cfg = o.cfg || null;
  try { if (!cfg) cfg = cfgx(); } catch (e) { cfg = null; }
  try {
    if (cfg && cfg.source("agentsRoot") === "env") { const v = cfg.get("agentsRoot"); if (v) return v; }
  } catch (e) { /* fall through */ }
  if (env.AGENT_DESKTOP_ROOT) return env.AGENT_DESKTOP_ROOT; // the old variable, used exactly as before (not normalised)
  try { const v = cfg ? cfg.get("agentsRoot") : null; if (v) return v; } catch (e) { /* fall through */ }
  return siblingRoot(o.repoDir);
}

function needsSetupError() {
  const e = new Error("Agent Desktop does not know where your agents live yet. Open Setup and choose the agents folder first.");
  e.code = "needs-setup";
  return e;
}

module.exports = { getRoot, siblingRoot, needsSetupError };
