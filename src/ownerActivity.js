// OWNER ACTIVITY (v1.155.0, Security, 2026-11-07). One tiny file, owner_activity.json in the workspace state folder: { "<agent folder, lower case>": "<ISO time of the owner's last
// message to that agent>" }. Written by main when the renderer says the OWNER sent a message (compose box or waiting bar; NOT a THYRA dock answer, which already
// closes its own ask). Used to tell that an open ask was probably answered in the chat: THYRA moves it to "Maybe already answered" and the sweep
// (the workspace ask sweeper) archives it after 24 h. It never records message text. Pure functions + two small file helpers.
"use strict";
const fs = require("fs"), path = require("path");
const FILE = "owner_activity.json", MAX_KEYS = 400;

function keyOf(agentPathOrName) {
  const s = String(agentPathOrName || "").replace(/[\\/]+$/, ""), base = s.split(/[\\/]/).pop() || "";
  return base.trim().toLowerCase().slice(0, 120);
}
function read(dir) {
  try { const d = JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf-8").replace(/^﻿/, "")); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; } catch (e) { return {}; }
}
function record(dir, agentPathOrName, now) {
  const k = keyOf(agentPathOrName); if (!k) return false;
  const m = read(dir); m[k] = new Date(now || Date.now()).toISOString();
  const keys = Object.keys(m); if (keys.length > MAX_KEYS) keys.sort((a, b) => String(m[a]).localeCompare(String(m[b]))).slice(0, keys.length - MAX_KEYS).forEach((x) => delete m[x]);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, FILE + "." + process.pid + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify(m, null, 1)); fs.renameSync(tmp, path.join(dir, FILE)); return true;
  } catch (e) { return false; }
}
// the ask's agent name ("Software Engineering Agent", "Security") against the activity keys (folder names): equal, or one starts with the other plus a space
function lastOwnerMs(map, askAgent, nowMs) {
  const a = keyOf(askAgent); if (!a || !map) return 0; let best = 0;
  for (const k of Object.keys(map)) {
    if (k === a || k.indexOf(a + " ") === 0 || a.indexOf(k + " ") === 0 || a.indexOf(k + "-") === 0) { const t = Date.parse(map[k]); if (isFinite(t) && t > best && t < (nowMs || Date.now()) + 120000) best = t; }
  }
  return best;
}
module.exports = { FILE, keyOf, read, record, lastOwnerMs };
