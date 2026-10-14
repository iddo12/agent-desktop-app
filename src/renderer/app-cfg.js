// app-cfg.js - the renderer's read-only view of the configuration layer (v1.121.0).
// Loaded once at startup through window.api.config.getAll() (main owns the file; the renderer never writes it) and cached.
// Nothing is polled. After the Setup panel saves something, call AppCfg.refresh() (one IPC call) so texts pick up the change.
// Tests / pages without the bridge: every accessor falls back to a neutral default, never throws.
(function () {
  "use strict";
  var vals = {};
  var loaded = false;
  var ready = null;
  var started = false;
  var firstResolve = null;

  // Light read: just the values (config-get-values). Older bridges only have getAll.
  function load() {
    var api = window.api && window.api.config;
    var read = api && (typeof api.getValues === "function" ? api.getValues : (typeof api.getAll === "function" ? api.getAll : null));
    if (!read) { loaded = true; return Promise.resolve(vals); }
    return Promise.resolve(read()).then(function (r) {
      if (r && r.ok && r.values && typeof r.values === "object") vals = r.values;
      loaded = true;
      return vals;
    }).catch(function () { loaded = true; return vals; });
  }
  // The first read waits until the window has painted once and the page is idle (the main process may have to look through PATH for
  // programs the first time), so it never delays the first paint. Anything that needs a value awaits AppCfg.ready.
  function begin() {
    if (started) return;
    started = true;
    load().then(function (v) { firstResolve(v); });
  }
  ready = new Promise(function (res) { firstResolve = res; });
  (function schedule() {
    var w = window, idle = function () { if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(begin, { timeout: 1500 }); else begin(); };
    if (typeof w.setTimeout !== "function") { begin(); return; }      // no timers (a test page): read at once
    w.setTimeout(idle, 400);                                          // hidden windows do not paint: this still starts
    if (typeof w.requestAnimationFrame === "function") w.requestAnimationFrame(function () { w.requestAnimationFrame(idle); });
  })();

  function text(key) { var v = vals[key]; return typeof v === "string" && v.trim() ? v.trim() : ""; }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function baseName(p) { var s = String(p || "").replace(/[\\/]+$/, ""); var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/")); return i >= 0 ? s.slice(i + 1) : s; }

  // exact (case-insensitive) name, or prefix when the pattern ends with *
  function roleMatch(pattern, folder) {
    var p = String(pattern || "").trim().toLowerCase(), f = String(folder || "").toLowerCase();
    if (!p || !f) return false;
    return p.charAt(p.length - 1) === "*" ? p.length > 1 && f.indexOf(p.slice(0, -1)) === 0 : f === p;
  }
  function pairList(s) { return String(s || "").split(";").map(function (x) { var i = x.indexOf("="); return i > 0 ? [x.slice(0, i).trim(), x.slice(i + 1).trim()] : null; }).filter(function (x) { return x && x[0] && x[1]; }); }

  window.AppCfg = {
    ready: ready,
    isLoaded: function () { return loaded; },
    refresh: function () {
      var p = load();
      if (!started) { started = true; p.then(function (v) { firstResolve(v); }); } // an early refresh also answers the first wait
      ready = p; window.AppCfg.ready = ready; return ready;
    },
    get: function (key) { var v = vals[key]; return v === undefined ? null : v; },
    // The person who owns this installation, as written into prompts and texts that agents or the person read. Neutral default.
    owner: function (o) { var n = text("ownerName") || "the user"; return o && o.cap ? cap(n) : n; },
    // The partner on the shared calendar / fleet link, or a neutral word. { upper: true } for badges.
    partner: function (o) { var n = text("partnerName") || "partner"; return o && o.upper ? n.toUpperCase() : n; },
    hasOwner: function () { return !!text("ownerName"); },
    hasPartner: function () { return !!text("partnerName"); },
    // The file name of a configured tool (for example tasks.py), or the fallback wording when none is configured.
    toolName: function (key, fallback) { var v = vals[key]; return typeof v === "string" && v ? baseName(v) : (fallback || ""); },
    // Roles (v1.121.0): the exact agent folder name configured for a role ("coo" | "security" | "optimization" | "seo"), or null. A trailing * = prefix match.
    role: function (name) { return text("role" + cap(String(name || ""))) || null; },
    // does this agent folder (or display name) belong to that role? false when the role is not configured.
    isRole: function (name, folder) { return roleMatch(text("role" + cap(String(name || ""))), folder); },
    // the real folder of a role among a list of folder names, or null (so a Discuss button is offered only for agents that exist here)
    roleFolder: function (name, folders) {
      var r = text("role" + cap(String(name || ""))); if (!r) return null;
      var l = folders || []; for (var i = 0; i < l.length; i++) if (roleMatch(r, l[i])) return l[i];
      return null;
    },
    // which role a scheduled job's name prefix points to (argusJobPrefixes "SEC_=security;OPT_=optimization"), or null
    jobRole: function (jobName) {
      var pairs = pairList(text("argusJobPrefixes")), n = String(jobName || "");
      for (var i = 0; i < pairs.length; i++) if (pairs[i][0] && n.toLowerCase().indexOf(pairs[i][0].toLowerCase()) === 0) return pairs[i][1].toLowerCase();
      return null;
    },
    // a configured short name for an agent folder (argusShortNames "Folder*=Short;Other=Name"), or null
    shortName: function (folder) {
      var pairs = pairList(text("argusShortNames"));
      for (var i = 0; i < pairs.length; i++) if (roleMatch(pairs[i][0], folder)) return pairs[i][1];
      return null;
    },
    // "pro" | "max5x" | "max20x" | null (null = the plan is not known yet)
    planTier: function () { var v = text("planTier"); return v === "pro" || v === "max5x" || v === "max20x" ? v : null; },
  };
})();
