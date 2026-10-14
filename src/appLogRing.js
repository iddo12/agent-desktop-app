"use strict";
// v1.123.0: a small in-memory ring of the main process's own console output (last ~400 lines), kept ONLY in memory so
// "Report a problem" has an app log to scrub and include. Nothing is written to disk and nothing is sent anywhere.
// The original console methods still run first, so behaviour is unchanged.
const util = require("util");
const MAX = 400, MAXCHARS = 2000;
const lines = [];
let installed = false;
function push(level, args) {
  try {
    const text = util.format.apply(null, args).replace(/\r\n?/g, "\n");
    for (const l of text.split("\n")) { lines.push(new Date().toISOString() + " [" + level + "] " + (l.length > MAXCHARS ? l.slice(0, MAXCHARS) : l)); }
    if (lines.length > MAX) lines.splice(0, lines.length - MAX);
  } catch (e) { /* the ring must never break logging */ }
}
function install(con) {
  const c = con || console;
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error"]) {
    const orig = c[level];
    if (typeof orig !== "function") continue;
    c[level] = function () { push(level, arguments); return orig.apply(this, arguments); };
  }
}
const get = () => lines.slice();
module.exports = { install, get, push };
