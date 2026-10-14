#!/usr/bin/env node
// Agent Desktop bug report maker. Run from the agent-desktop folder:
//   node tools/bug-report.js --what "short description of what went wrong" [--steps "what you did"] [--shot C:\path\screenshot.png ...]
// It writes ONE folder  bug-report-<date>-<time>  next to the app, with report.md (everything below), your screenshots, and a .zip of it.
// Send the .zip to whoever maintains your copy of Agent Desktop. Nothing is uploaded anywhere by this script.
//
// PRIVACY: it collects only: app version, Windows version, Node/Claude Code versions, the two small status files Agent Desktop keeps
// (runtime.json, startup-timing.json) and the files you pass with --shot. It does NOT read your conversations, agent folders or credentials.
// Your Windows user name is replaced by <user> in the text. Open report.md and read it before you send it.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

function arg(name, multi) {
  const out = [];
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i] === "--" + name && i + 1 < a.length) out.push(a[++i]);
  return multi ? out : out[0] || "";
}
const user = os.userInfo().username;
const scrub = (s) => String(s == null ? "" : s).split(user).join("<user>");
function run(cmd) {
  try { return cp.execSync(cmd, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); }
  catch (e) { return "(not available)"; }
}
function readSmall(p) {
  try { const t = fs.readFileSync(p, "utf8"); return t.length > 6000 ? t.slice(0, 6000) + "\n...(cut)" : t; } catch (e) { return "(not found)"; }
}

const what = arg("what"), steps = arg("steps"), shots = arg("shot", true);
if (!what) {
  console.log('Usage: node tools/bug-report.js --what "what went wrong" [--steps "what you did before it"] [--shot screenshot.png]');
  process.exit(1);
}
const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const dir = path.join(root, "bug-report-" + stamp);
fs.mkdirSync(dir, { recursive: true });

const userData = path.join(process.env.APPDATA || "", "agent-desktop");
const md = [
  "# Agent Desktop bug report",
  "",
  "- Created: " + new Date().toString(),
  "- Agent Desktop version: " + pkg.version,
  "- Windows: " + os.release() + " (" + os.arch() + "), RAM " + Math.round(os.totalmem() / 1e9) + " GB",
  "- Node: " + process.version,
  "- Claude Code: " + scrub(run("claude --version")),
  "- Git commit of this copy: " + scrub(run('git -C "' + root + '" rev-parse --short HEAD')),
  "",
  "## What went wrong",
  scrub(what),
  "",
  "## What I did before it happened",
  scrub(steps) || "(not given)",
  "",
  "## Screenshots",
  shots.length ? shots.map((s) => "- " + path.basename(s)).join("\n") : "(none)",
  "",
  "## runtime.json",
  "```",
  scrub(readSmall(path.join(userData, "runtime.json"))),
  "```",
  "",
  "## startup-timing.json",
  "```",
  scrub(readSmall(path.join(userData, "startup-timing.json"))),
  "```",
  "",
].join("\n");
fs.writeFileSync(path.join(dir, "report.md"), md, "utf8");
for (const s of shots) { try { fs.copyFileSync(s, path.join(dir, path.basename(s))); } catch (e) { console.log("Could not copy " + s + ": " + e.message); } }
const zip = dir + ".zip";
run('powershell -NoProfile -Command "Compress-Archive -Force -Path \'' + dir + '\\*\' -DestinationPath \'' + zip + '\'"');
console.log("Bug report written:\n  " + dir + "\\report.md\n  " + zip + "\nRead report.md, then send the .zip to the person who maintains Agent Desktop for you.");
