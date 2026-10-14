"use strict";
// Reading JSON files that other agents, scripts and people write.
// Windows PowerShell 5.1 (`Set-Content -Encoding UTF8`, `Out-File`) puts an invisible BOM (U+FEFF) at the start of the file; Node's
// readFileSync(.., "utf-8") keeps it and JSON.parse then throws. On 2026-10-07 that silently dropped all agent GROUPS in the sidebar
// (agent_groups.json re-saved by another agent). Every reader of a shared file must use this instead of a bare JSON.parse.
const fs = require("fs");

function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/** JSON.parse(readFileSync(file)) that tolerates a BOM. Throws like JSON.parse on real corruption (callers keep their own try/catch). */
function readJsonFile(file, encoding = "utf-8") {
  return JSON.parse(stripBom(fs.readFileSync(file, encoding)));
}

module.exports = { stripBom, readJsonFile };
