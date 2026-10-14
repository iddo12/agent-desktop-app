"use strict";
// Builds the small "where do things live on this computer" objects that ARGUS, Memory, Keep working and the usage code receive from main
// (v1.121.0). The data modules (argus-data, memory-data, keepGoing) stay pure: they take one of these objects and never read config themselves.
// Every function returns the object with null fields when the feature is not set up, so the data module answers { ok:false, reason:"needs-setup" }
// and the screen shows its calm "Set up" state. Nothing is cached: the config module caches its file, and a change made in Setup takes effect at once.
//
//   const ctx = require("./featureCtx").create({ cfg: appConfig, guard: testGuard });
//   ctx.argus()   -> { reports, builder, python }
//   ctx.memory()  -> { statsFile, baselineFile, keyPrefix }
//   ctx.people()  -> { owner }                 (the configured name, or null)
//   ctx.keepGoing() -> { ownerName, tasksTool, ready }   (texts nudges and relentless mode send to agents)
const fs = require("fs");

const isDir = (p) => { try { return !!p && fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const isFile = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; } };

function create(deps) {
  const cfg = deps.cfg;
  const guard = deps.guard;
  const env = deps.env || process.env;
  const off = (id) => { try { return cfg.feature(id).state === "off"; } catch (e) { return false; } };
  const testMode = () => !!(guard && guard.isTestMode(env));

  function argus() {
    const none = { reports: null, builder: null, python: null };
    if (off("argus")) return none;
    const reports = testMode() ? guard.workspaceDir("sharedReports", env) : cfg.get("sharedReports");
    if (!isDir(reports)) return none;
    // the status builder: the configured one; in test mode (sandbox) the one under the sandbox's shared tools unless named explicitly
    let builder = null;
    if (testMode() && !guard.explicit("argusBuilder", env)) {
      const tools = guard.workspaceDir("sharedTools", env);
      builder = tools ? require("path").join(tools, "bridge", "build_status.py") : null;
    } else builder = cfg.get("argusBuilder");
    return { reports, builder: isFile(builder) ? builder : null, python: cfg.get("pythonExe") || null };
  }

  function memory() {
    const none = { statsFile: null, baselineFile: null, keyPrefix: null };
    if (off("memory")) return none;
    const statsFile = cfg.get("memoryStatsFile");
    if (!isFile(statsFile)) return none;
    const base = cfg.get("memoryBaselineFile");
    return { statsFile, baselineFile: isFile(base) ? base : null, keyPrefix: cfg.get("memoryKeyPrefix") };
  }

  const people = () => ({ owner: cfg.get("ownerName") || null });

  // Relentless mode ("keep working regardless") sends agents to the task tool; without it the mode cannot be offered.
  function keepGoing() {
    const tasksTool = cfg.get("tasksTool");
    return { ownerName: cfg.get("ownerName") || null, tasksTool: isFile(tasksTool) ? tasksTool : null, ready: cfg.isReady("keepGoing") };
  }

  return { argus, memory, people, keepGoing };
}

module.exports = { create };
