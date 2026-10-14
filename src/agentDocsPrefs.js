// Agent documents panel preferences (v1.92.0): per agent, is the panel open, and list or grid.
// One small JSON file in Agent Desktop's userData (never localStorage, never the shared workspace).
// Loaded once, kept in memory, written (tmp + rename, no BOM) only when something changes.
const fs = require("fs");
const path = require("path");

// An agent key is the agent's folder name. Main checks it is a real agent before calling set();
// this is the second, shape-only check so the file can never hold odd keys.
const KEY_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,120}$/;
const VIEWS = ["list", "grid"];
const TYPES = ["docs", "image", "all", "pdf", "word", "sheet", "video", "other"];
const MAX_AGENTS = 500;

function validKey(k) {
  return typeof k === "string" && KEY_RE.test(k) && k.trim() === k && k !== "__proto__" && k !== "constructor" && k !== "prototype";
}

function create(filePath) {
  let state = null;

  function load() {
    if (state) return state;
    let v = null;
    try {
      v = JSON.parse(fs.readFileSync(filePath, "utf-8").replace(/^﻿/, ""));
    } catch (e) {
      v = null;
    }
    state = { agents: {} };
    if (v && v.agents && typeof v.agents === "object") {
      for (const [k, p] of Object.entries(v.agents)) {
        if (!validKey(k) || !p || typeof p !== "object") continue;
        state.agents[k] = clean(p);
      }
    }
    return state;
  }

  function clean(p) {
    const out = {};
    if (typeof p.open === "boolean") out.open = p.open;
    if (VIEWS.includes(p.view)) out.view = p.view;
    if (TYPES.includes(p.type)) out.type = p.type;
    return out;
  }

  function save() {
    const tmp = filePath + ".tmp";
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  }

  function get() {
    const s = load();
    return { agents: JSON.parse(JSON.stringify(s.agents)) };
  }

  // patch: { agent, open?, view?, type? }
  function set(patch) {
    const s = load();
    if (!patch || !validKey(patch.agent)) return { ok: false, error: "Bad agent." };
    const add = clean(patch);
    if (!Object.keys(add).length) return { ok: false, error: "Nothing to save." };
    const cur = Object.prototype.hasOwnProperty.call(s.agents, patch.agent) ? s.agents[patch.agent] : {};
    const next = { ...cur, ...add };
    if (JSON.stringify(next) === JSON.stringify(cur)) return { ok: true, unchanged: true };
    if (!Object.prototype.hasOwnProperty.call(s.agents, patch.agent) && Object.keys(s.agents).length >= MAX_AGENTS) {
      return { ok: false, error: "Too many agents." };
    }
    s.agents[patch.agent] = next;
    try { save(); } catch (e) { return { ok: false, error: "Could not save: " + e.message }; }
    return { ok: true };
  }

  return { get, set };
}

module.exports = { create, validKey, VIEWS, TYPES };
