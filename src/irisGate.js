"use strict";
// IRIS consent gate (v1.121.0). IRIS listens on the local network, so it is OFF in every installation until the person at the machine
// consents in the app's own UI. This module holds the three small pieces main.js needs; it does not touch IRIS internals (src/iris/*).
//
//   grandfather(...)   one-time rule at startup: an install that ALREADY has a paired peer (a pairing is an explicit act: the person typed a
//                      one-time code) and has no "iris" section yet gets a consent record with source "existing-pairing", so an existing link keeps
//                      working after the update with no wizard step. Fails closed: missing/empty/corrupt peers file, or any existing iris section => nothing.
//   registerStubs()    while IRIS is not allowed, its IPC channels answer "off" instead of "no handler", so the IRIS panel shows a calm line.
//   removeStubs()      called before the real handlers are registered.
const fs = require("fs");
const path = require("path");

const CHANNELS = ["iris-approve-send", "iris-cancel-invite", "iris-create-invite", "iris-delivered", "iris-join", "iris-log", "iris-pending",
  "iris-prepare-delivery", "iris-reject-send", "iris-chats", "iris-chat-send", "iris-chat-retry", "iris-chat-viewed", "iris-direct-set", "iris-send", "iris-set-enabled", "iris-set-name", "iris-set-peer", "iris-status", "iris-unpair"];
const OFF = { ok: false, reason: "IRIS is off. Turn it on in Setup (it needs your consent)." };

function hasPairedPeer(userDataDir, fsx) {
  try {
    const raw = (fsx || fs).readFileSync(path.join(userDataDir, "iris", "peers.json"), "utf8").replace(/^\uFEFF/, "");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || Array.isArray(j)) return false;
    return Object.keys(j).some((id) => j[id] && typeof j[id] === "object" && j[id].id === id);
  } catch (e) { return false; }
}

function grandfather(o) {
  const cfg = o.cfg;
  try {
    if (cfg.hasSection("iris")) return { granted: false, reason: "iris section exists" };
    if (!o.userDataDir || !hasPairedPeer(o.userDataDir, o.fs)) return { granted: false, reason: "no paired peer" };
    const r = cfg.grantConsent("iris", "existing-pairing");
    return { granted: !!r.ok, reason: r.ok ? "existing-pairing" : r.error };
  } catch (e) { return { granted: false, reason: "error" }; }
}

function registerStubs(ipcMain) { for (const c of CHANNELS) { try { ipcMain.handle(c, () => OFF); } catch (e) { /* already registered by the real service */ } } }
function removeStubs(ipcMain) { for (const c of CHANNELS) { try { ipcMain.removeHandler(c); } catch (e) { /* none */ } } }

module.exports = { grandfather, hasPairedPeer, registerStubs, removeStubs, CHANNELS, OFF };
