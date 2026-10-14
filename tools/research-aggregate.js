#!/usr/bin/env node
// Writes the readable week summary (shared_reports\research\<week>\_week_summary.md) without the app.
//   node tools/research-aggregate.js 2026-W41 [--root <workspace folder>] [--print]
// Same code as the app's "Export week summary" button (src/research/summary.js). Read-only on the digests; writes only _week_summary.md.
"use strict";
const fs = require("fs");
const path = require("path");
const { createService } = require("../src/research/service");
const { buildSummary } = require("../src/research/summary");

const a = process.argv.slice(2);
const week = a.find((x) => /^\d{4}-W\d{2}$/.test(x));
const ri = a.indexOf("--root");
// v1.121.0: no built-in folder; --root, or AGENT_DESKTOP_WORKSPACE_ROOT, names the workspace.
const root = ri >= 0 && a[ri + 1] ? a[ri + 1] : process.env.AGENT_DESKTOP_WORKSPACE_ROOT;
if (!root) { process.stderr.write("give --root <workspace> or set AGENT_DESKTOP_WORKSPACE_ROOT\n"); process.exit(2); }
if (!week) { process.stderr.write("usage: node tools/research-aggregate.js <YYYY-Www> [--root <workspace>] [--print]\n"); process.exit(2); }
const dir = path.join(root, "shared_reports", "research");
const snap = createService({ researchDir: dir }).load({ week });
if (!snap.ok || snap.week !== week) { process.stderr.write("cannot read week " + week + " in " + dir + "\n"); process.exit(1); }
const md = buildSummary(snap);
if (a.includes("--print")) process.stdout.write(md);
else { const out = path.join(dir, week, "_week_summary.md"); fs.writeFileSync(out, md, "utf8"); process.stdout.write(out + "\n"); }
