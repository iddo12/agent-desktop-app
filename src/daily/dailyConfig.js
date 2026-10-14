"use strict";
// My Daily: where its data and helpers live on THIS computer, and who the people are (v1.121.0).
// Everything comes from the configuration layer (appConfig) plus an optional "daily" section in app-config.json for the few settings that
// only My Daily has (the section is preserved by appConfig on every write, so it needs no change to the core):
//
//   "daily": { "dataDir": "<abs>", "taskDir": "<abs>", "mailFeedFile": "<abs>", "mailRulesFile": "<abs>", "gmailExportFile": "<abs>",
//              "ownDomains": ["example.org"], "sharePartnerDefault": true, "ownerPronouns": "he" | "she" | "they", "partnerPronouns": "he" | "she" | "they" }
//
// Nothing here is read at startup: the first call reads app-config.json once; the answer is cached until the configuration changes.
// Nothing points at a particular person's folder: with nothing configured every helper returns null and My Daily shows a calm
// "needs setup" note for the part that needs it (the task list), while the rest (calendar, shopping, dates, mail accounts) keeps working.

const nodeFs = require("fs");
const nodePath = require("path");

const DAILY_DIR = "daily";   // folder name under userData (or, for existing data, under the agents folder)

function create(opts) {
  const o = opts || {};
  const cfg = o.cfg || null;
  const fs = o.fs || nodeFs;
  const P = o.path || nodePath;
  const env = o.env || process.env;
  const userDataDir = o.userDataDir ? String(o.userDataDir) : null;
  let cache = null;       // { section, dataDir }
  let unsub = null;

  const call = (name, ...a) => { try { return cfg && typeof cfg[name] === "function" ? cfg[name](...a) : null; } catch (e) { return null; } };
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
  const absOrNull = (v) => {
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (!s || s.length > 400 || /[\0\r\n]/.test(s) || !P.isAbsolute(s) || s.split(/[\\/]+/).some((x) => x === "..")) return null;
    return P.normalize(s);
  };

  function section() {
    if (cache && cache.section) return cache.section;
    let sec = {};
    try {
      const f = call("configPath");
      if (f) {
        let txt = fs.readFileSync(f, "utf8");
        if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
        const j = JSON.parse(txt);
        if (j && j.daily && typeof j.daily === "object" && !Array.isArray(j.daily)) sec = j.daily;
      }
    } catch (e) { sec = {}; }
    cache = Object.assign(cache || {}, { section: sec });
    return sec;
  }
  function invalidate() { cache = null; }
  if (cfg && typeof cfg.onChange === "function") { try { unsub = cfg.onChange(invalidate); } catch (e) { unsub = null; } }

  // ---- people (display only; the stored ids stay as in contract.js) ----
  function people() {
    const own = call("get", "ownerName");
    const partner = call("get", "partnerName");
    return { ownerName: typeof own === "string" && own ? own : null, partnerName: typeof partner === "string" && partner ? partner : null };
  }
  const PRON = { he: { subj: "he", obj: "him", reads: "reads" }, she: { subj: "she", obj: "her", reads: "reads" }, they: { subj: "they", obj: "them", reads: "read" } };
  // Wording used in messages sent to agents. Neutral ("The user", they/them) until the person sets a name (and, optionally, pronouns).
  function who() {
    const n = people().ownerName;
    const p = PRON[String(section().ownerPronouns || "they").toLowerCase()] || PRON.they;
    return Object.assign({ name: n || "The user", poss: n ? n + "'s" : "The user's", by: n || "the user" }, p);
  }
  const PARTNER_WORDS = { he: { cap: "He", poss: "his" }, she: { cap: "She", poss: "hers" }, they: { cap: "They", poss: "theirs" } };
  const partnerWords = () => PARTNER_WORDS[String(section().partnerPronouns || "they").toLowerCase()] || PARTNER_WORDS.they;
  // Is a partner configured? Sharing features (button, checkbox, legend) only exist then.
  const hasPartner = () => !!people().partnerName;
  const sharePartnerDefault = () => hasPartner() && section().sharePartnerDefault === true;

  // ---- folders ----
  // Order: daily.dataDir > <userData>/daily when it already exists > an existing <agents folder>/daily (where older versions kept it, so nothing is lost
  // or copied) > <userData>/daily (new installs).
  function dataDir() {
    if (cache && cache.dataDir !== undefined) return cache.dataDir;
    let d = absOrNull(section().dataDir);
    if (!d) {
      const ud = userDataDir ? P.join(userDataDir, DAILY_DIR) : null;
      const ar = call("get", "agentsRoot");
      const legacy = typeof ar === "string" && ar ? P.join(ar, DAILY_DIR) : null;
      if (ud && isDir(ud)) d = ud;
      else if (legacy && isDir(legacy)) d = legacy;
      else d = ud || legacy || null;
    }
    cache = Object.assign(cache || {}, { dataDir: d });
    return d;
  }
  function taskDir() {
    const t = absOrNull(section().taskDir);
    if (t) return t;
    return call("path", "sharedReports", "tasks");
  }
  const mailFeedFile = () => (env.DAILY_MAIL_FEED ? absOrNull(env.DAILY_MAIL_FEED) : null) || absOrNull(section().mailFeedFile);
  const mailRulesFile = () => (env.DAILY_MAIL_RULES ? absOrNull(env.DAILY_MAIL_RULES) : null) || absOrNull(section().mailRulesFile);
  const gmailExportFile = () => (env.DAILY_GMAIL_EXPORT ? absOrNull(env.DAILY_GMAIL_EXPORT) : null) || absOrNull(section().gmailExportFile);
  function ownDomains() {
    const l = section().ownDomains;
    return Array.isArray(l) ? l.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean).slice(0, 100) : null;
  }

  // ---- the task list (tasks.py) ----
  // read = the shared task store folder exists; edit = python and tasks.py are both found. Neither is needed for the rest of My Daily.
  function tasks() {
    const td = taskDir();
    const py = call("get", "pythonExe");
    const tool = call("get", "tasksTool");
    const read = !!(td && isDir(td));
    const edit = !!(py && tool && isFile(py) && isFile(tool));
    let reason = "";
    if (!read && !edit) reason = "The task list is off. Choose the tasks tool and Python in Setup to turn it on.";
    else if (!read) reason = "The shared task folder was not found. Check it in Setup.";
    else if (!edit) reason = "Tasks can be read, but editing needs Python and the tasks tool. Choose them in Setup.";
    return { read, edit, reason, taskDir: td, python: py, tool };
  }
  const run = () => { const t = tasks(); return t.edit ? { python: t.python, tool: t.tool } : null; };

  const dispose = () => { try { if (unsub) unsub(); } catch (e) { /* gone */ } };
  return { people, who, partnerWords, hasPartner, sharePartnerDefault, dataDir, taskDir, mailFeedFile, mailRulesFile, gmailExportFile, ownDomains, tasks, run, section, invalidate, dispose };
}

module.exports = { create, DAILY_DIR };
