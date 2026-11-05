// SANDBOX ONLY (v1.153.0). Lets a test instance have "fake waiting agents": fixture agents get a fake pty (its write() appends to a file instead of
// reaching a process) and a fake permission-dialog screen, so the whole Approvals pop-up path (job-file scan -> pending -> list -> click -> keystroke
// into the agent) can be driven without spending a real agent. main.js loads this ONLY when the test mode is on AND AGENT_DESKTOP_FAKE_APPROVALS names a
// folder; the live app never has either. Control file <folder>\fake.json = { agents: [{ path, screen }] }; writes land in <folder>\writes\<basename>.log.
"use strict";
const fs = require("fs"), path = require("path");

function install(deps) {
  const dir = process.env.AGENT_DESKTOP_FAKE_APPROVALS;
  if (!deps.testMode.TEST_MODE || !dir) return false;
  const ctl = path.join(dir, "fake.json"), writes = path.join(dir, "writes");
  fs.mkdirSync(writes, { recursive: true });
  const seen = new Map();   // path -> screen last fed
  const tick = () => {
    let j; try { j = JSON.parse(fs.readFileSync(ctl, "utf8")); } catch (e) { return; }
    const live = new Set();
    for (const a of (j.agents || [])) {
      if (!a || typeof a.path !== "string") continue;
      live.add(a.path);
      if (!deps.ptySessions.get(a.path) || !deps.ptySessions.get(a.path).fake) {
        const log = path.join(writes, path.basename(a.path) + ".log");
        deps.ptySessions.set(a.path, { fake: true, proc: { pid: 0, write: (d) => fs.appendFileSync(log, JSON.stringify(String(d)) + "\n"), resize() {}, kill() {} }, pendingInput: [] });
      }
      if (seen.get(a.path) !== a.screen) {
        seen.set(a.path, a.screen);
        deps.dialogTails.set(a.path, ""); deps.dialogLongTails.set(a.path, "");
        deps.trackDialog(a.path, String(a.screen || ""));
      }
    }
    for (const p of Array.from(seen.keys())) if (!live.has(p)) { seen.delete(p); const s = deps.ptySessions.get(p); if (s && s.fake) deps.ptySessions.delete(p); deps.dialogTails.set(p, ""); deps.dialogLongTails.set(p, ""); }
  };
  setInterval(tick, 500).unref();
  tick();
  return true;
}
module.exports = { install };
