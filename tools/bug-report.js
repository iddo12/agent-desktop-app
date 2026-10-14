#!/usr/bin/env node
// Agent Desktop bug report maker (command-line twin of the in-app "Report a problem" dialog; same module, src/bugReport.js).
//   node tools/bug-report.js --what "short description of what went wrong" [--steps "what you did"] [--shot C:\path\screenshot.png]
//                            [--out C:\some\folder] [--userdata <Agent Desktop data folder>]
// It writes ONE folder  bug-report-<date>-<time>  and a .zip of it into --out (default: the folder this copy of Agent Desktop sits in).
// Send the .zip to whoever maintains your copy of Agent Desktop. Nothing is uploaded anywhere by this script.
//
// PRIVACY: same rules as the dialog (see src/bugReport.js): app and Windows versions, the app's own small status files, your settings with the
// details removed, the state of each feature, and a picture you choose with --shot. It does NOT read conversations, agent folders or credentials.
// Names, e-mail addresses, tokens, long keys, private network addresses and your user folder are replaced by placeholders. Read the files before you send.
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const br = require("../src/bugReport");

function arg(name) {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i] === "--" + name && i + 1 < a.length) return a[i + 1];
  return "";
}
function run(cmd) {
  try { return cp.execSync(cmd, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); }
  catch (e) { return ""; }
}

const what = arg("what"), steps = arg("steps"), shot = arg("shot");
if (!what) {
  console.log('Usage: node tools/bug-report.js --what "what went wrong" [--steps "what you did before it"] [--shot screenshot.png] [--out folder]');
  process.exit(1);
}
const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const userDataDir = arg("userdata") || path.join(process.env.APPDATA || "", "agent-desktop");

let featureStates = [];
try {
  const features = require("../src/features");
  const cfg = require("../src/appConfig").createAppConfig({ userDataDir });
  cfg.setRegistry(features);
  featureStates = features.list().map((f) => { const st = cfg.feature(f.id) || {}; return { id: f.id, title: f.title, state: st.state, reason: st.reason }; });
} catch (e) { /* the file just says "(none)" */ }

const bundle = br.build(
  { what, steps, include: { screenshot: !!shot, terminal: false } },
  {
    userDataDir, appVersion: pkg.version, gitCommit: run('git -C "' + root + '" rev-parse --short HEAD'), claudeVersion: run("claude --version"),
    featureStates, appLog: ["(the app's own log is only available from the in-app dialog)"], screenshotPath: shot || null,
  }
);
if (!bundle.ok) { console.log("Could not make the report: " + bundle.error); process.exit(1); }
const res = br.write(bundle, path.resolve(arg("out") || root));
if (!res.ok) { console.log("Could not write the report: " + res.error); process.exit(1); }
console.log("Bug report written:\n  " + res.dir + "\n  " + res.zip + "\nRead the files, then send the .zip to the person who maintains Agent Desktop for you.");
