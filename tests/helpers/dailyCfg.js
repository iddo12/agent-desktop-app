"use strict";
// Test helper (v1.121.0): an appConfig for My Daily tests that points at a temp root, with an optional "daily" section. No D:/E: paths.
//   const cfg = cfgFor(root, { daily: { sharePartnerDefault: true }, values: { ownerName: "Ana" }, tools: true })
// root is used as the workspace and as the agents folder (the old tests keep their fixtures at <root>/shared_reports/tasks and <root>/daily).
const fs = require("fs"), os = require("os"), path = require("path");
const { createAppConfig } = require("../../src/appConfig");
const features = require("../../src/features");

function cfgFor(root, o) {
  const opt = o || {};
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "daily-cfg-"));
  const values = Object.assign({ workspaceRoot: root, agentsRoot: root }, opt.values || {});
  if (opt.tools) { // a python and a tasks tool that exist (empty files are enough: the tests inject the runner)
    const t = path.join(ud, "tools"); fs.mkdirSync(t, { recursive: true });
    fs.writeFileSync(path.join(t, "py.exe"), ""); fs.writeFileSync(path.join(t, "tasks.py"), "");
    values.pythonExe = path.join(t, "py.exe"); values.tasksTool = path.join(t, "tasks.py");
  }
  const doc = { schema: 1, values, features: {} };
  if (opt.daily) doc.daily = opt.daily;
  fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify(doc));
  const c = createAppConfig({ userDataDir: ud, env: {} });
  c.setRegistry(features);
  c.__userData = ud;
  return c;
}
module.exports = { cfgFor };
