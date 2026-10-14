"use strict";
// Fleet pane IPC (v1.121.0): the five fleet-* handlers, moved out of main.js so the configuration is read in ONE place.
//   fleet-settings  -> { ok, state, reason, label, owner, partner, role, deliveryMatch }  (wording + state; never a path)
//   fleet-list / fleet-timeline / fleet-read / fleet-reply -> as before, or { ok:false, reason:"needs-setup" | "off" } when the feature is not set up.
// Sources of the mailbox folder: AGENT_DESKTOP_FLEET_DIR (sandbox/tests, as before) > appConfig exchangeDir. Names and wording come from
// appConfig (exchangeInboxName, exchangeOutboxName, ownerName, partnerName, fleetLabel, leadRole); they are applied to fleetMailbox only
// when they changed, so a listing costs nothing extra. Nothing is polled here.

function register(deps) {
  const { ipcMain, cfg, userDataDir, path } = deps;
  const mailbox = deps.fleetMailbox || require("./fleetMailbox");
  const timeline = deps.fleetTimeline || require("./fleetTimeline");
  let applied = "";

  function words() {
    return {
      inbox: cfg.get("exchangeInboxName"), outbox: cfg.get("exchangeOutboxName"),
      owner: cfg.get("ownerName"), partner: cfg.get("partnerName"), role: cfg.get("leadRole"), label: cfg.get("fleetLabel"),
    };
  }
  function apply() {
    const w = words(), sig = JSON.stringify(w);
    if (sig !== applied) { mailbox.configure(w); applied = sig; }
    return w;
  }
  // "ready" | "needs-setup" | "off"; a folder that is configured but not there right now still lists (calm "not found" note), as before.
  function state() {
    const env = process.env.AGENT_DESKTOP_FLEET_DIR;
    if (env && env.trim()) return { state: "ready", reason: "" };
    const f = cfg.feature("fleet");
    if (f.state === "off") return { state: "off", reason: f.reason };
    if (!cfg.get("exchangeDir")) return { state: "needs-setup", reason: f.reason || "Needs: Fleet mailbox folder" };
    return { state: f.state === "needs-attention" ? "needs-attention" : "ready", reason: f.reason };
  }
  const blocked = (s) => ({ ok: false, reason: s.state === "off" ? "off" : "needs-setup", error: s.reason || "needs-setup" });
  // The agent that receives IRIS messages: whole-word match of the role on name/folder, source of the regex is the configured role only.
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  ipcMain.handle("fleet-settings", () => {
    try {
      const w = apply(), s = state();
      return { ok: true, state: s.state, reason: s.reason, label: w.label || "", owner: w.owner || "", partner: w.partner || "", role: w.role || "",
        deliveryMatch: w.role ? "(^|\\s)" + esc(w.role) + "(\\s|$)" : "" };
    } catch (e) { return { ok: false, error: "internal" }; }
  });
  ipcMain.handle("fleet-list", async (event, o) => {
    try {
      apply(); const s = state(); if (s.state === "needs-setup" || s.state === "off") return blocked(s);
      return await mailbox.listMailbox(mailbox.fleetDir(cfg), { lastSeen: Number(o && o.lastSeen) || 0, force: !!(o && o.force) });
    } catch (e) { return { ok: false, error: "could not read the mailbox" }; }
  });
  ipcMain.handle("fleet-read", async (event, id) => { try { apply(); const s = state(); if (s.state === "needs-setup" || s.state === "off") return blocked(s); return await mailbox.readMessage(mailbox.fleetDir(cfg), id); } catch (e) { return { ok: false, error: "could not read" }; } });
  // v1.120.0: one merged timeline of the mailbox + the IRIS audit log; read-only, IRIS dir overridable with AGENT_DESKTOP_IRIS_DIR.
  ipcMain.handle("fleet-timeline", async (event, o) => {
    try {
      apply(); const s = state(); if (s.state === "needs-setup" || s.state === "off") return blocked(s);
      return await timeline.listTimeline(mailbox.fleetDir(cfg), { lastSeen: Number(o && o.lastSeen) || 0, force: !!(o && o.force), irisDir: timeline.irisDir(path.join(userDataDir, "iris")) });
    } catch (e) { return { ok: false, error: "could not read the mailbox" }; }
  });
  ipcMain.handle("fleet-reply", (event, o) => {
    try { apply(); const s = state(); if (s.state === "needs-setup" || s.state === "off") return blocked(s); return mailbox.writeReply(mailbox.fleetDir(cfg), { recipient: o && o.recipient, topic: o && o.topic, text: o && o.text }); }
    catch (e) { return { ok: false, error: "could not write" }; }
  });
  return { apply, state };
}

module.exports = { register };
