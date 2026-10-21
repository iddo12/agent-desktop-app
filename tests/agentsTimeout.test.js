// node tests/agentsTimeout.test.js - a read that TIMED OUT (src/syncGuard.js) must never turn into a default that overwrites agent_config.json:
// updateAgent / setAgentPaused refuse, isAgentPaused fails closed (null), listing still shows the folder with display defaults. Temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adagentsto-"));
process.env.AGENT_DESKTOP_ROOT = tmp;
const agents = require("../src/agents");
let n = 0, fails = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(() => console.log("ok   " + name), (e) => { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); }); };

const dir = path.join(tmp, "Acme Agent"); fs.mkdirSync(dir);
const cfg = path.join(dir, "agent_config.json");
const REAL = JSON.stringify({ display_name: "Acme", role: "Does things", avatar: null, paused: true });
fs.writeFileSync(cfg, REAL);

const realRead = fs.readFileSync;
const timingOut = (fn) => {
  fs.readFileSync = function (p) { if (String(p).endsWith("agent_config.json")) { const e = new Error("syncGuard: timed out"); e.code = "ETIMEDOUT"; throw e; } return realRead.apply(fs, arguments); };
  try { return fn(); } finally { fs.readFileSync = realRead; }
};

(async () => {
  await t("updateAgent refuses to write when the config read timed out", () => {
    assert.throws(() => timingOut(() => agents.updateAgent(dir, { name: "New", role: "x" })), (e) => e.code === "ETIMEDOUT");
    assert.strictEqual(fs.readFileSync(cfg, "utf8"), REAL);
  });
  await t("setAgentPaused refuses to write when the config read timed out", () => {
    assert.throws(() => timingOut(() => agents.setAgentPaused(dir, false)), (e) => e.code === "ETIMEDOUT");
    assert.strictEqual(fs.readFileSync(cfg, "utf8"), REAL);
  });
  await t("isAgentPaused fails closed (null) on a timed-out read", () => {
    assert.strictEqual(timingOut(() => agents.isAgentPaused(dir)), null);
  });
  await t("normal reads still work and write back the real content", () => {
    assert.strictEqual(agents.isAgentPaused(dir), true);
    agents.updateAgent(dir, { name: "Renamed", role: "r" });
    const c = JSON.parse(fs.readFileSync(cfg, "utf8"));
    assert.strictEqual(c.display_name, "Renamed"); assert.strictEqual(c.paused, true);
  });
  console.log(`${n - fails}/${n} passed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ }
  process.exit(fails ? 1 : 0);
})();
