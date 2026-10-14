// Demo mode (v1.86.0): where everything lives. Pure (no electron, no side effects) so tests can call it.
//
// Everything demo mode reads or writes is under ONE base folder (default <Public>\agent-desktop-demo, falling back to the
// temp folder) plus the read-only fixture folder. The base is rebuilt from the fixtures at every launch.
"use strict";
const os = require("os");
const path = require("path");

function resolvePaths(env) {
  const e = env || process.env;
  const repo = path.resolve(__dirname, "..", "..");
  const fixtures = path.resolve(e.AGENT_DESKTOP_DEMO_DIR || path.join(repo, "demo", "fixtures"));
  // A neutral location: the Public profile folder carries no user name (the temp folder does), so paths shown on screen stay generic.
  const neutral = e.PUBLIC && e.PUBLIC.trim() ? path.join(e.PUBLIC, "agent-desktop-demo") : path.join(os.tmpdir(), "agent-desktop-demo");
  const base = path.resolve(e.AGENT_DESKTOP_DEMO_USERDATA || neutral);
  return {
    repo, fixtures, base,
    root: path.join(base, "root"),          // the agents root (AGENT_DESKTOP_ROOT)
    home: path.join(base, "home"),          // stands in for the user profile (~/.claude lives here)
    userData: path.join(base, "userData"),  // Electron userData
    health: path.join(base, "health"),      // My Health store root
    marker: path.join(base, ".agent-desktop-demo"),
  };
}

// The path shown to the viewer for the finished reports; open-local-pdf maps it onto the real file under the demo root.
const VIRTUAL_REPORTS = "C:\\Aurora Studio\\Reports";

module.exports = { resolvePaths, VIRTUAL_REPORTS };
