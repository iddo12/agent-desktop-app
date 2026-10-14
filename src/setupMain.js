"use strict";
// Main-process side of the Setup panel (v1.121.0): the five config-* IPC handlers.
// Every argument is validated here; the renderer never builds a path, it only sends feature ids, step keys and values the
// person picked, and main re-validates them through appConfig. Only the main window may call these.

const fs = require("fs");
const path = require("path");

function register(deps) {
  const { ipcMain, dialog, cfg, features, getMainWindow, isTestMode } = deps;
  const fsx = deps.fs || fs;

  function fromMainWindow(event) {
    try { const w = getMainWindow(); return !!(w && !w.isDestroyed() && event && event.sender === w.webContents); } catch (e) { return false; }
  }
  const bad = (error) => ({ ok: false, error });
  const isId = (v) => typeof v === "string" && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(v) && !!features.get(v);

  function describeFeature(f) {
    const st = cfg.feature(f.id);
    return {
      id: f.id, kind: f.kind || "feature", group: f.group || "daily", title: f.id === "fleet" ? (cfg.get("fleetLabel") || f.title) : f.title, tileId: f.tileId, parent: f.parent || null, wired: !!f.wired,
      suggestions: features.suggestions(cfg, f.id),
      state: st.state, missing: st.missing, reason: st.reason, help: f.help,
      steps: f.steps.map((s) => {
        let suggestion = null; try { suggestion = s.suggest ? s.suggest(cfg) : null; } catch (e) { suggestion = null; }
        const info = cfg.keyInfo(s.key) || {};
        return { key: s.key, kind: s.kind, label: s.label, help: s.help, optional: !!s.optional, create: !!s.create, choices: info.choices || null,
          value: cfg.get(s.key), source: cfg.source(s.key), suggestion: typeof suggestion === "string" ? suggestion : null, usable: cfg.usable(s.key) };
      }),
    };
  }

  // Everything the panel shows, computed in ONE batch: each key is resolved and checked on disk once (cfg.snapshot), not once per feature step.
  function getAll() { return typeof cfg.snapshot === "function" ? cfg.snapshot(getAll1) : getAll1(); }
  function getAll1() {
    const exists = cfg.hasConfigFile();
    const values = {};
    for (const k of cfg.allKeys()) values[k] = cfg.get(k);
    return {
      ok: true, configPath: cfg.configPath(), exists, schema: cfg.schema, values,
      welcome: !exists && !isTestMode() && !cfg.get("workspaceRoot"),
      workspace: describeFeature(features.get("workspace")),
      features: features.list().map(describeFeature),
    };
  }

  // Light read for the renderer's start-up (AppCfg): just the values, no feature states and no suggestions.
  ipcMain.handle("config-get-values", (event) => {
    if (!fromMainWindow(event)) return bad("not-allowed");
    try {
      const run = () => { const values = {}; for (const k of cfg.allKeys()) values[k] = cfg.get(k); return { ok: true, values }; };
      return typeof cfg.snapshot === "function" ? cfg.snapshot(run) : run();
    } catch (e) { return bad("internal"); }
  });
  ipcMain.handle("config-get-all", (event) => { if (!fromMainWindow(event)) return bad("not-allowed"); try { return getAll(); } catch (e) { return bad("internal"); } });

  // The folder picker only returns the chosen path; nothing is written until config-set-feature.
  ipcMain.handle("config-pick-folder", async (event, a) => {
    if (!fromMainWindow(event)) return bad("not-allowed");
    const key = a && a.key; const f = a && isId(a.featureId) ? features.get(a.featureId) : null;
    const s = f && typeof key === "string" ? f.steps.find((x) => x.key === key) : null;
    if (!s || (s.kind !== "folder" && s.kind !== "file")) return bad("invalid-arguments");
    try {
      const start = cfg.get(key) || (typeof s.suggest === "function" ? s.suggest(cfg) : null) || undefined;
      const res = await dialog.showOpenDialog(getMainWindow(), {
        title: s.label, defaultPath: typeof start === "string" ? start : undefined,
        properties: s.kind === "folder" ? ["openDirectory", "createDirectory"] : ["openFile"],
      });
      if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: true, canceled: true };
      return { ok: true, path: res.filePaths[0] };
    } catch (e) { return bad("dialog-failed"); }
  });

  // Creates ONLY the folders that this feature's steps name (create:true, folder kind), and only the ones the person chose
  // (a, values[key]) or accepted as the suggestion, never anything else.
  ipcMain.handle("config-create-folders", (event, a) => {
    if (!fromMainWindow(event)) return bad("not-allowed");
    if (!a || !isId(a.featureId)) return bad("invalid-arguments");
    const f = features.get(a.featureId);
    const vals = a.values && typeof a.values === "object" ? a.values : {};
    const created = [];
    try {
      // The workspace the folders must sit inside comes from the SAVED configuration only, never from what the renderer sent along.
      // (A brand-new workspace is created by the workspace step and saved by config-set-feature, which applies the same "inside the
      // workspace" rule to its sub-folders; until the workspace is saved, the other folders are left for that call.)
      const root = cfg.get("workspaceRoot");
      const ci = (x) => (process.platform === "win32" ? String(x).toLowerCase() : String(x));
      const inRoot = (p) => {
        if (!root) return false;
        const r2 = path.relative(ci(root), ci(p));
        return r2 === "" || (!!r2 && r2.split(/[\\/]+/)[0] !== ".." && !path.isAbsolute(r2));
      };
      for (const s of f.steps) {
        if (!s.create || s.kind !== "folder") continue;
        const raw = typeof vals[s.key] === "string" && vals[s.key] ? vals[s.key] : (cfg.get(s.key) || (s.suggest ? s.suggest(cfg) : null));
        if (typeof raw !== "string") continue;
        // the configuration layer's path rules (absolute, no "..", no device prefix), plus: never a network share (UNC) for a folder the app creates
        const want = typeof cfg.clean === "function" ? cfg.clean(s.key, raw) : null;
        if (typeof want !== "string" || /^[\\/]{2}/.test(String(raw).trim())) return bad("invalid-value");
        const info = cfg.keyInfo(s.key) || {};
        if (s.key !== "workspaceRoot" && !info.autoCreate) {
          if (!root) continue;
          if (!inRoot(want)) return bad("outside-workspace");
        }
        if (!fsx.existsSync(want)) { fsx.mkdirSync(want, { recursive: true }); created.push(want); }
      }
      return { ok: true, created };
    } catch (e) { return bad("cannot-create-folder"); }
  });

  ipcMain.handle("config-set-feature", (event, a) => {
    if (!fromMainWindow(event)) return bad("not-allowed");
    if (!a || !isId(a.featureId)) return bad("invalid-arguments");
    const f = features.get(a.featureId);
    const patch = {};
    if (a.enabled !== undefined) { if (typeof a.enabled !== "boolean") return bad("invalid-arguments"); patch.enabled = a.enabled; }
    if (a.values !== undefined) {
      if (!a.values || typeof a.values !== "object" || Array.isArray(a.values)) return bad("invalid-arguments");
      patch.values = {};
      for (const k of Object.keys(a.values)) {
        if (!f.steps.some((s) => s.key === k)) return bad("key-not-part-of-feature");   // a feature may only set its own keys
        patch.values[k] = a.values[k];
      }
    }
    const r = cfg.setFeature(f.id, patch, { create: !!a.create });
    if (!r.ok) return r;
    return { ok: true, feature: describeFeature(f) };
  });

  // Consent for features that listen on the network (IRIS). The ONLY writer of a consent record from the UI: main window only, after a
  // confirmation dialog in plain words. In a test instance AGENT_DESKTOP_TEST_CONSENT_ANSWER=yes|no stands in for the click.
  const CONSENT_TEXT = {
    claudeIntegration: {
      message: "Let Agent Desktop change your Claude Code settings?",
      detail: "Claude Code keeps a settings file in your Windows user folder. If you turn this on, Agent Desktop may make two changes in it:\n\n1. A status line that shows your usage limits and feeds the usage figures in this app.\n2. \"Remote control at startup\", which connects your Claude Code sessions to your Claude account so you can reach them from your phone (this may not be available on every plan).\n\nBoth affect every Claude Code session on this computer, including ones you start yourself in a terminal. If you already have a status line or already chose a remote-control setting, it is left alone. Nothing is changed until you press Turn on.\n\nTurning this off later stops Agent Desktop from changing that file. It does not undo what was already written; you can remove those two lines yourself.",
    },
    iris: {
      message: "Turn on IRIS?",
      detail: "IRIS links this Agent Desktop to another one by a one-time code. Messages between them are encrypted. Nothing connects on its own: you pair each link yourself.\n\nTo work, Agent Desktop will listen on your local network (Windows may ask whether to allow it).\n\nTurning IRIS off later takes full effect the next time the app starts.",
    },
  };
  ipcMain.handle("config-consent", async (event, a) => {
    if (!fromMainWindow(event)) return bad("not-allowed");
    if (!a || !isId(a.featureId) || features.get(a.featureId).kind !== "consent" || !CONSENT_TEXT[a.featureId]) return bad("invalid-arguments");
    let yes = false;
    try {
      const forced = isTestMode() && deps.env && deps.env.AGENT_DESKTOP_TEST_CONSENT_ANSWER;
      if (forced) yes = forced === "yes";
      else {
        const t = CONSENT_TEXT[a.featureId];
        const res = await dialog.showMessageBox(getMainWindow(), { type: "question", buttons: ["Turn on", "Cancel"], defaultId: 1, cancelId: 1, noLink: true, title: "Agent Desktop", message: t.message, detail: t.detail });
        yes = res.response === 0;
      }
    } catch (e) { return bad("dialog-failed"); }
    if (!yes) return { ok: true, declined: true, feature: describeFeature(features.get(a.featureId)) };
    const r = cfg.grantConsent(a.featureId, "setup-ui");
    if (!r.ok) return r;
    return { ok: true, feature: describeFeature(features.get(a.featureId)) };
  });

  ipcMain.handle("config-agent-instructions", (event, a) => {
    if (!fromMainWindow(event)) return bad("not-allowed");
    try {
      if (a && a.featureId !== undefined) { if (!isId(a.featureId)) return bad("invalid-arguments"); return { ok: true, text: features.agentInstructionsFor(cfg, a.featureId) }; }
      return { ok: true, text: features.agentInstructions(cfg) };
    } catch (e) { return bad("internal"); }
  });
  return { getAll, describeFeature };
}

module.exports = { register };
