// Run: node tests/subagentActivity.test.js
// v1.150.1: a parent session waiting on background sub-agents writes nothing itself; the stuck-turn watchdog must count the sub-agents'
// transcripts (<session>/subagents/*.jsonl) as activity (Specs, 30 Oct 2026: sub-agent wrote until 23:47, parent silent since 23:33, healthy agent restarted).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "adsub-"));
const root = path.join(home, "root");
fs.mkdirSync(root);
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.AGENT_DESKTOP_ROOT = root;
const archive = require("../src/archive");
archive.setStatCacheTtl(0);

const cwd = path.join(root, "AgentS", ".claude-session");
const proj = path.join(home, ".claude", "projects", archive.encodeProjectPath(cwd));
fs.mkdirSync(proj, { recursive: true });
const sid = "33333333-cccc";
const parent = path.join(proj, sid + ".jsonl");
const line = JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-10-30T21:33:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "waiting" }] } });
fs.writeFileSync(parent, line + "\n");
const T0 = Date.now() / 1000;
fs.utimesSync(parent, T0 - 1200, T0 - 1200); // parent silent for 20 min

// no sub-agents at all: behaviour unchanged
assert.strictEqual(archive.getSubagentActivityMs(cwd), null, "no subagents dir -> null");
assert.strictEqual(archive.getLatestActivityMs(cwd), fs.statSync(parent).mtimeMs, "no subagents: same as transcript mtime");

// a sub-agent wrote 30 s ago: the agent is alive
const subDir = path.join(proj, sid, "subagents");
fs.mkdirSync(subDir, { recursive: true });
const sub = path.join(subDir, "agent-aaa.jsonl");
fs.writeFileSync(sub, line + "\n");
fs.writeFileSync(path.join(subDir, "agent-aaa.meta.json"), "{}"); // non-jsonl files are ignored
fs.utimesSync(sub, T0 - 30, T0 - 30);
fs.utimesSync(path.join(subDir, "agent-aaa.meta.json"), T0, T0);
assert.strictEqual(archive.getSubagentActivityMs(cwd), fs.statSync(sub).mtimeMs, "newest sub-agent .jsonl mtime (meta.json ignored)");
assert.strictEqual(archive.getLatestActivityMs(cwd), fs.statSync(sub).mtimeMs, "sub-agent newer than parent -> its mtime");
assert.ok(Date.now() - archive.getLatestActivityMs(cwd) < 60 * 1000, "agent reads as active within the last minute");

// a stale sub-agent must not hide a newer parent write
fs.utimesSync(sub, T0 - 5000, T0 - 5000);
fs.utimesSync(parent, T0 - 10, T0 - 10);
assert.strictEqual(archive.getLatestActivityMs(cwd), fs.statSync(parent).mtimeMs, "newer parent wins");

// sub-agents of an OLD session (not one of the two newest) are ignored
const olds = ["44444444-dddd", "55555555-eeee"];
for (const o of olds) {
  fs.writeFileSync(path.join(proj, o + ".jsonl"), line + "\n");
  fs.utimesSync(path.join(proj, o + ".jsonl"), T0 - 4000, T0 - 4000);
}
const oldSub = path.join(proj, "44444444-dddd", "subagents");
fs.mkdirSync(oldSub, { recursive: true });
fs.writeFileSync(path.join(oldSub, "agent-old.jsonl"), line + "\n");
fs.utimesSync(parent, T0 - 10, T0 - 10);
fs.utimesSync(path.join(proj, olds[1] + ".jsonl"), T0 - 3000, T0 - 3000);
const subMs = archive.getSubagentActivityMs(cwd);
assert.ok(subMs === fs.statSync(sub).mtimeMs, "only the two newest sessions' sub-agents count (old one ignored, got " + subMs + ")");

// robustness: unreadable folder
assert.strictEqual(archive.getSubagentActivityMs(path.join(root, "Nope", ".claude-session")), null, "missing project -> null");
console.log("subagentActivity.test.js: all passed");
