// node tests/noHardcodedPaths.test.js - hard-code guard (v1.121.0, standing order "nothing hard-coded to one computer").
// Scans the files listed in FILES for drive-letter paths, personal names, a site name and a LAN address range. A deliberate exception goes in
// tests/noHardcodedPaths.allow.json: { "<repo-relative file>": ["<exact text that is allowed>", ...] } (every entry needs a reason in "_why").
// Builders who convert a feature: ADD the files you converted to FILES.
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
const ROOT = path.join(__dirname, "..");

const FILES = [
  "src/appConfig.js", "src/features.js", "src/setupMain.js", "src/irisGate.js",
  "src/renderer/setup.js", "src/renderer/setup-strings.js", "src/renderer/styles-setup.css",
  "tools/gen-setup-md.js", "SETUP.md",
  "src/tools/launcher.js", "src/tools/service.js", "src/renderer/tools.js", // area Tools (SE)
  "src/research/main-research.js", "src/research/write.js", "src/openPath.js", "src/agentDocs.js", "tools/research-aggregate.js", // area Library/Research (SE)
  "src/fleetMailbox.js", "src/fleetTimeline.js", "src/fleetMain.js", "src/renderer/fleet-pane.js", "src/renderer/iris.js",
  // launch / start-up area (v1.121.0)
  "src/launchEnv.js", "src/agentsRoot.js", "src/agents.js", "src/groups.js", "src/app-update.js", "src/pcHealthMain.js", "src/overview.js",
  "src/renderer/pchealth.js", "tools/health-pane-sandbox.cjs",
  // My Daily (v1.121.0)
  "src/daily/calendar.js",
  "src/daily/contract.js",
  "src/daily/dailyConfig.js",
  "src/daily/decisions-main.js",
  "src/daily/decisions-model.js",
  "src/daily/emaildismiss.js",
  "src/daily/gmail.js",
  "src/daily/ics.js",
  "src/daily/imap.js",
  "src/daily/linkmeta.js",
  "src/daily/mailfeed.js",
  "src/daily/main-daily.js",
  "src/daily/model.js",
  "src/daily/schedule.js",
  "src/daily/shipments-email.js",
  "src/daily/shipments-main.js",
  "src/daily/shipments-model.js",
  "src/daily/shipments-track.js",
  "src/daily/triage-main.js",
  "src/daily/triage-model.js",
  "src/daily/voiceparse.js",
  "src/renderer/daily-contract.js",
  "src/renderer/daily-decisions.js",
  "src/renderer/daily-shipments.js",
  "src/renderer/daily-triage.js",
  "src/renderer/daily-voice.js",
  "src/renderer/daily.js",
  "src/finance/service.js", "src/finance/main-finance.js", "src/renderer/finance.js", // area Finance (SE)
  "src/health/roots.js", "src/health/pane-feed.js", "src/health/service.js", "src/health/main-health.js", // area Health (SE)
  // area: Voice (v1.121.0)
  "src/voice-main.js",
  // ARGUS / Memory / Keep working / usage area (v1.121.0)
  "src/argus-data.js", "src/memory-data.js", "src/testGuard.js", "src/featureCtx.js", "src/keepGoing.js", "src/keepGoingGlue.js",
  "src/renderer/argus.js", "src/renderer/app-cfg.js", "src/wakeAgentMain.js", "src/wakeAgent.js", "src/renderer/needs-setup.js", "src/renderer/memory.js", "src/renderer/keepgoing.js", "src/renderer/styles-needs-setup.css",
  // hardening round (v1.121.0)
  "src/claudeSettings.js",
  // names round (v1.121.0): user-facing text and prompts
  "src/predict.js", "src/predictMain.js", "src/dep-doctor.js", "src/research/summary.js", "src/research/service.js", "src/tools/schema.js", "src/tools/model.js",
  "src/main.js", // CODE ONLY (see CODE_ONLY): this 5000-line file keeps history comments that name people; its strings and logic must not
];
const CODE_ONLY = new Set(["src/main.js"]);
const stripComments = (text) => {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return s.split("\n").map((l) => { const m = /(^|[^:])\/\/(?!\/)/.exec(l); return m ? l.slice(0, m.index + m[1].length) : l; }).join("\n");
};
const PATTERNS = [
  ["a drive-letter path", /\b[A-Za-z]:[\\/]/g],
  ["a drive-letter path (escaped backslashes)", /\b[A-Za-z]:\\\\/g],
  ["the owner's first name", /Alex|Id{2}o/g],
  ["the partner's first name", /Sarah/g],
  ["a site name", /acmeco\.com/gi],
  ["a LAN address", /\b10\.0\.0\.\d/g],
  ["a Dropbox folder tree", /Dropbox/g],
  ["the owner's work drive folder", /Claude[ ]work|Claude[ ]stuff/g],
];
let allow = {};
try { allow = JSON.parse(fs.readFileSync(path.join(__dirname, "noHardcodedPaths.allow.json"), "utf8")); } catch (e) { allow = {}; }

let n = 0, fails = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };

for (const rel of FILES) {
  t("no hard-coded paths or names in " + rel, () => {
    const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const text = CODE_ONLY.has(rel) ? stripComments(raw) : raw;
    const ok = (allow[rel] || []).filter((x) => typeof x === "string");
    const hits = [];
    for (const [what, re] of PATTERNS) {
      for (const m of text.matchAll(re)) {
        const line = text.slice(text.lastIndexOf("\n", m.index) + 1, text.indexOf("\n", m.index) < 0 ? undefined : text.indexOf("\n", m.index)).trim();
        if (ok.some((a) => line.indexOf(a) >= 0)) continue;
        hits.push(what + ": " + line.slice(0, 140));
      }
    }
    assert.deepStrictEqual(hits, [], rel + " has " + hits.length + " hard-coded value(s)");
  });
}
t("the allow-list only names files that are scanned, each with a reason", () => {
  for (const k of Object.keys(allow)) { if (k === "_why") continue; assert.ok(FILES.indexOf(k) >= 0, k + " is allow-listed but not scanned"); }
  if (Object.keys(allow).some((k) => k !== "_why")) assert.ok(allow._why && Object.keys(allow._why).length, "allow-list entries need a _why");
});
t("the guard itself catches a planted value (self-test)", () => {
  const sample = 'const p = "' + "D" + ':\\\\Some\\\\Folder";';
  assert.ok(PATTERNS.some(([, re]) => { re.lastIndex = 0; return re.test(sample); }));
});
console.log(n - fails + "/" + n + " passed");
process.exit(fails ? 1 : 0);
