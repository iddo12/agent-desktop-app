"use strict";
const assert = require("assert"); const fs = require("fs"); const os = require("os"); const path = require("path");
const am = require("../src/agentModel");
const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "am-")), "agent-model.json");
assert.strictEqual(am.setAgentModel(f, "Security", "OPUS"), "opus");
fs.writeFileSync(f, "\ufeff" + fs.readFileSync(f, "utf8").replace('"opus"', '"opus"')); // BOM tolerated
assert.strictEqual(am.setAgentModel(f, "COO", "fable"), "fable");
const c = JSON.parse(fs.readFileSync(f, "utf8"));
assert.deepStrictEqual(c.agents, { Security: "opus", COO: "fable" });
assert.throws(() => am.setAgentModel(f, "X", "gpt"));
assert.throws(() => am.setAgentModel(f, "a/b", "opus"));
assert.strictEqual(am.matchModelId("claude-sonnet-5-5"), "sonnet");
assert.strictEqual(am.matchModelId("zzz"), "");
console.log("agentModel: 7 checks passed");
