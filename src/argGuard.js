"use strict";
// Small validators for values that arrive over IPC and end up in a command line or a file path (security audit, AUDIT.md).
const path = require("path");

// A Claude session / background-agent id: letters, digits, '-' and '_' only, never a leading '-' (no option injection, no cmd.exe metacharacters).
const isSafeId = (s) => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(s);

// A prompt handed to `claude --bg <prompt>` through cmd.exe /c. node-pty only quotes an argument that contains whitespace,
// so a single-word prompt is passed bare and cmd.exe metacharacters would run a command. Quoted prompts are left alone.
function safePromptArg(s) {
  const t = String(s);
  return /\s/.test(t) ? t : t.replace(/[&|<>^%!()]/g, " ").trim();
}

const isDateKey = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// true when file is inside dir (separator-terminated, case-insensitive on Windows)
function isUnder(dir, file) {
  const ci = process.platform === "win32";
  let d = path.resolve(String(dir)), f = path.resolve(String(file));
  if (ci) { d = d.toLowerCase(); f = f.toLowerCase(); }
  return f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

module.exports = { isSafeId, safePromptArg, isDateKey, isUnder };
