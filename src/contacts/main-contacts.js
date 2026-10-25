// CONTACTS IPC (main process). Reads the Personal Assistant agent's contacts.json (never writes it) and keeps Iddo's own records in ONE file
// beside it (contacts_ui.json: categories, links, notes, snooze, rejected suggestions). After each change a read-only export for other agents
// (contacts_directory.json, used by contacts_lookup.py) is rewritten. No HTTP port, no network: the renderer sends ids and short strings, never paths.
// Refused when the folder is inside a cloud-synced folder (contact data stays in the scratch area).
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("./contactsLogic");
const MAX_BYTES = 40 * 1024 * 1024;
const UI_FILE = "contacts_ui.json", EXPORT_FILE = "contacts_directory.json";

function init({ ipcMain: raw, getMainWindow, log, cfg, now, watch, mailEnv, mailLaunch }) {
  const say = typeof log === "function" ? log : () => {};
  const clock = now || (() => Date.now());
  const wc = () => { try { const w = getMainWindow(); return w && !(typeof w.isDestroyed === "function" && w.isDestroyed()) ? w.webContents : null; } catch (e) { return null; } };
  const handle = (channel, fn) => raw.handle(channel, async (event, arg) => {
    try {
      const c = wc();
      if (!c || !event || event.sender !== c || !event.senderFrame || event.senderFrame !== c.mainFrame) { say(channel + " refused: not the main window"); return { ok: false, reason: "Not allowed." }; }
      if (arg !== undefined && arg !== null) { if (typeof arg !== "object" || Array.isArray(arg)) return { ok: false, reason: "Bad request." }; if (JSON.stringify(arg).length > 9000) return { ok: false, reason: "That request is too large." }; }
    } catch (x) { return { ok: false, reason: "Not allowed." }; }
    try { return await fn(arg || {}); } catch (x) { say(channel + " failed: code=" + (x && x.code ? x.code : "unknown")); return { ok: false, reason: "That did not work." }; }   // codes only: never names, mails or notes
  });

  const dirPath = () => { const d = cfg("contactsDir"); return d ? path.resolve(d) : null; };
  const synced = (d) => { let r = d; try { r = fs.realpathSync(d); } catch (e) { /* not there yet: judge the given path */ } const re = /(^|[\\/])(dropbox|onedrive|google drive|icloud)([\\/]|$)/i; if (re.test(d) || re.test(r)) return true; try { for (let x = path.resolve(r), i = 0; i < 12; i++) { if (fs.existsSync(path.join(x, ".dropbox")) || fs.existsSync(path.join(x, ".dropbox.cache"))) return true; const up = path.dirname(x); if (up === x) break; x = up; } } catch (e) { /* unreadable: name check stands */ } return false; };
  const readJson = (f, max) => { try { const st = fs.statSync(f); if (!st.isFile() || st.size > (max || MAX_BYTES)) return null; return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); } catch (e) { return null; } };
  function writeJsonAtomic(f, obj) {
    const tmp = f + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { encoding: "utf8" });
    fs.renameSync(tmp, f);
  }

  // ---- state: the PA export is re-read only when its mtime changes; Iddo's file is kept in memory and rewritten on each change
  let st = { mtime: 0, dir: null, ui: null, index: null, raw: null, err: "", suggestions: null };
  const uiEmpty = () => ({ schema: 1, companies: {}, person: {}, snooze: {}, rejected: {} });
  function load() {
    const d = dirPath();
    if (!d) return { err: "The contacts folder is not set. Open Setup and fill in the contacts folder." };
    if (synced(d)) return { err: "The contacts folder is inside a synced folder. Contact data must stay on this PC; pick a folder outside Dropbox/OneDrive." };
    const f = path.join(d, "contacts.json");
    let mt = 0; try { mt = fs.statSync(f).mtimeMs; } catch (e) { return { err: "contacts.json was not found in the contacts folder." }; }
    if (st.dir !== d) st = { mtime: 0, dir: d, ui: null, index: null, raw: null, err: "", suggestions: null };
    if (!st.ui) {
      const uf = path.join(d, UI_FILE); let exists = true; try { fs.statSync(uf); } catch (e) { exists = e && e.code !== "ENOENT"; }
      const u = exists ? readJson(uf, 8 * 1024 * 1024) : null;
      if (exists && !(u && typeof u === "object" && !Array.isArray(u))) return { err: "Your contacts file (" + UI_FILE + ") could not be read, so nothing was changed. Close other programs using it and reopen the tab." };
      st.ui = Object.assign(uiEmpty(), u || {}); st.index = null;
    }
    if (!st.raw || st.mtime !== mt) {
      const r = readJson(f); if (!r) return { err: "contacts.json could not be read." };
      st.raw = L.normalise(r); st.mtime = mt; st.index = null; st.suggestions = null;
    }
    const day = Math.floor(clock() / 86400000); if (st.day !== day) { st.day = day; st.index = null; }   // snooze/quiet depend on today
    if (!st.index) st.index = L.buildIndex(st.raw, { companies: st.ui.companies }, st.ui.snooze, clock());
    return { d };
  }
  const rebuild = () => { st.index = null; };
  function save() {
    const d = dirPath(); if (!d) return false;
    const uf = path.join(d, UI_FILE); try { fs.copyFileSync(uf, uf + ".bak"); } catch (e) { /* first save: nothing to back up */ }
    writeJsonAtomic(uf, st.ui); rebuild();
    try { writeExport(d); } catch (e) { say("contacts export failed: code=" + (e && e.code ? e.code : "unknown")); }
    return true;
  }
  /** The read-only file other agents use. No mail subjects, no emails of people, no snooze. Rewritten after each change and on first load. */
  function writeExport(d) {
    const ready = load(); if (ready.err) return;
    const t = clock();
    const companies = st.raw.companies.map((c) => L.lookupRecord(st.index, { companies: st.ui.companies }, st.ui.snooze, c, t));
    writeJsonAtomic(path.join(d, EXPORT_FILE), { schema: 1, generated: new Date(t).toISOString(), source_generated: st.raw.generatedAt, note: "Read-only export for agents. Written by Agent Desktop's Contacts tab; do not edit.", _notice: L.EXPORT_NOTICE, companies });
  }

  // First open, or a new PA export: refresh the agent export when it is missing or older than contacts.json
  function ensureExport(d) {
    try { const e = path.join(d, EXPORT_FILE); let m = 0; try { m = fs.statSync(e).mtimeMs; } catch (x) { /* missing */ } if (m < st.mtime) writeExport(d); } catch (x) { say("contacts export failed: code=" + (x && x.code ? x.code : "unknown")); }
  }

  let watcher = null, timer = null;
  function startWatch() {
    if (watcher) return; const d = dirPath(); if (!d) return;
    try {
      watcher = (watch || fs.watch)(d, { persistent: false }, (ev, name) => {
        if (name && !/^contacts\.json$/i.test(String(name))) return;   // only the PA export matters (our own files change on our own writes)
        clearTimeout(timer); timer = setTimeout(() => { const c = wc(); if (c) { try { c.send("contacts-changed"); } catch (e) { /* window gone */ } } }, 800);
      });
      if (watcher && watcher.on) watcher.on("error", () => { watcher = null; });
    } catch (e) { watcher = null; }
  }

  const days = (iso, t) => L.daysAgo(iso, t);
  handle("contacts-list", (a) => {
    const r = load(); if (r.err) return { ok: false, reason: r.err };
    ensureExport(r.d); startWatch();
    const t = clock(), q = typeof a.q === "string" ? a.q.slice(0, 80) : "";
    const page = L.listPage(st.index, { q, category: typeof a.category === "string" ? a.category.slice(0, 40) : "", filter: ["needs", "waiting", "quiet"].includes(a.filter) ? a.filter : "", sort: ["latest", "az", "category"].includes(a.sort) ? a.sort : "latest", offset: Number.isInteger(a.offset) ? a.offset : 0 });
    const gen = st.raw.generatedAt, age = gen ? Math.floor((t - Date.parse(gen)) / 86400000) : null;
    return { ok: true, page, people: page.offset === 0 && q ? L.searchPeople(st.index, q, 15) : [],
      chips: { total: st.index.total, uncategorised: st.index.uncategorised, counts: st.index.counts, needs: st.index.needs, waiting: st.index.waiting, quiet: st.index.quiet },
      meta: { generatedAt: gen, ageDays: age, stale: age != null && age > L.STALE_DAYS, unknownPeople: st.raw.unknownPeople, windowDays: st.raw.windowDays } };
  });
  handle("contacts-company", (a) => {
    const r = load(); if (r.err) return { ok: false, reason: r.err };
    if (!Number.isInteger(a.id)) return { ok: false, reason: "Bad request." };
    const v = L.companyView(st.index, { companies: st.ui.companies }, st.ui.snooze, a.id, clock()); return v ? { ok: true, company: v } : { ok: false, reason: "That company is not in the list any more." };
  });
  handle("contacts-person", (a) => {
    const r = load(); if (r.err) return { ok: false, reason: r.err };
    if (!Number.isInteger(a.id)) return { ok: false, reason: "Bad request." };
    const v = L.personView(st.index, { person: st.ui.person }, st.ui.snooze, a.id, clock()); return v ? { ok: true, person: v } : { ok: false, reason: "That person is not in the list any more." };
  });
  // Notes: kind company|handover|person. Plain text, bounded; the stored text is shown with textContent only.
  handle("contacts-set-note", (a) => {
    const r = load(); if (r.err) return { ok: false, reason: r.err };
    if (!Number.isInteger(a.id) || typeof a.text !== "string" || !["company", "handover", "person"].includes(a.kind)) return { ok: false, reason: "Bad request." };
    const text = L.cleanText(a.text, L.MAX_NOTE);
    if (a.kind === "person") { if (!L.personView(st.index, { person: st.ui.person }, st.ui.snooze, a.id, clock())) return { ok: false, reason: "That person is not in the list." }; if (!st.ui.person) st.ui.person = {}; if (text) st.ui.person[a.id] = text; else delete st.ui.person[a.id]; }
    else { if (!st.index.byId.has(a.id)) return { ok: false, reason: "That company is not in the list." }; const c = st.ui.companies[a.id] || (st.ui.companies[a.id] = {}); c[a.kind === "company" ? "note" : "handover"] = text; }
    save(); return { ok: true };
  });
  handle("contacts-set-categories", (a) => {
    const r = load(); if (r.err) return { ok: false, reason: r.err };
    const cats = L.validCategories(a.categories);
    if (!Number.isInteger(a.id) || !cats || !st.index.byId.has(a.id)) return { ok: false, reason: "Bad request." };
    (st.ui.companies[a.id] || (st.ui.companies[a.id] = {})).categories = cats; save(); return { ok: true };
  });
  handle("contacts-set-link", (a) => {
    const r = load(); if (r.err) return { ok: false, reason: r.err };
    if (!Number.isInteger(a.id) || !["web", "phone"].includes(a.kind) || !st.index.byId.has(a.id)) return { ok: false, reason: "Bad request." };
    const v = L.validLink(a.kind, a.value); if (v === null) return { ok: false, reason: a.kind === "web" ? "Only https:// addresses are accepted." : "That is not a phone number." };
    const c = st.ui.companies[a.id] || (st.ui.companies[a.id] = {}); c.links = Object.assign({}, c.links); if (v) c.links[a.kind] = v; else delete c.links[a.kind]; save(); return { ok: true };
  });
  // Snooze a person for N days, mark "no reply needed", or clear either. Removes them from "Needs my reply" until then.
  handle("contacts-snooze", (a) => {
    const r = load(); if (r.err) return { ok: false, reason: r.err };
    if (!Number.isInteger(a.id) || !["snooze", "noreply", "clear"].includes(a.mode)) return { ok: false, reason: "Bad request." };
    let known = false; for (const c of st.index.byId.values()) if (c.people.some((p) => p.id === a.id)) { known = true; break; }
    if (!known) return { ok: false, reason: "That person is not in the list." };
    if (a.mode === "clear") delete st.ui.snooze[a.id];
    else if (a.mode === "noreply") st.ui.snooze[a.id] = { noReply: true };
    else { const n = Number.isInteger(a.days) ? Math.max(1, Math.min(365, a.days)) : 7; st.ui.snooze[a.id] = { until: new Date(clock() + n * 86400000).toISOString().slice(0, 10) }; }
    save(); return { ok: true };
  });
  // Suggested categories come from the PA agent (category_suggestions.json, keyed by domain). Nothing is saved until Iddo confirms.
  handle("contacts-suggestions", () => {
    const r = load(); if (r.err) return { ok: false, reason: r.err };
    if (!st.suggestions) st.suggestions = readJson(path.join(r.d, "category_suggestions.json"), 8 * 1024 * 1024) || {};
    const out = [];
    for (const row of st.index.rows) {
      if (row.cats.length) continue;
      const c = st.index.byId.get(row.id), s = c && c.domain ? st.suggestions[c.domain] : null;
      if (!s || !Array.isArray(s.categories) || st.ui.rejected[row.id]) continue;
      const cats = L.validCategories(s.categories.map(L.prettyCategory).filter(Boolean)); if (!cats || !cats.length) continue;
      out.push({ id: row.id, name: row.name, categories: cats, why: L.cleanText(s.basis, 200) });
      if (out.length >= 200) break;
    }
    return { ok: true, suggestions: out, uncategorised: st.index.uncategorised };
  });
  handle("contacts-suggestion-resolve", (a) => {
    const r = load(); if (r.err) return { ok: false, reason: r.err };
    if (!Number.isInteger(a.id) || !st.index.byId.has(a.id) || !["confirm", "reject"].includes(a.action)) return { ok: false, reason: "Bad request." };
    if (a.action === "reject") { st.ui.rejected[a.id] = 1; save(); return { ok: true }; }
    const cats = L.validCategories(a.categories); if (!cats || !cats.length) return { ok: false, reason: "Pick at least one category." };
    (st.ui.companies[a.id] || (st.ui.companies[a.id] = {})).categories = cats; save(); return { ok: true };
  });
  // Mail search inside one company via the local Super Search service (read-only). The renderer sends a company id + keywords, never a URL or token.
  const MS = require("./mailsearch");
  // Token file: the setting "superSearchTokenFile" if set, else the service default (LOCALAPPDATA/BetterbirdSuperSearch/token).
  const mailEnvNow = () => { if (mailEnv) return mailEnv; let f = null; try { f = typeof cfg === "function" ? cfg("superSearchTokenFile") : null; } catch (e) { f = null; } return f ? { tokenFile: f } : undefined; };
  handle("contacts-mail-search", async (a) => {
    const r = load(); if (r.err) return { ok: false, reason: r.err };
    if (!Number.isInteger(a.id) || (a.keywords != null && typeof a.keywords !== "string")) return { ok: false, reason: "Bad request." };
    const v = L.companyView(st.index, { companies: st.ui.companies }, st.ui.snooze, a.id, clock());
    if (!v) return { ok: false, reason: "That company is not in the list any more." };
    return MS.searchMails({ company: { domain: v.domain, aliases: v.aliases }, keywords: a.keywords, withAtt: !!a.withAtt, withoutAtt: !!a.withoutAtt }, mailEnvNow());
  });
  // Newest mails with one person + reading one mail. Same rules: ids and short strings in, text out, no URL or token in the renderer.
  handle("contacts-person-mails", async (a) => {
    const r = load(); if (r.err) return { ok: false, reason: r.err };
    if (!Number.isInteger(a.id)) return { ok: false, reason: "Bad request." };
    const v = L.personView(st.index, { person: {} }, st.ui.snooze, a.id, clock());
    if (!v) return { ok: false, reason: "That person is not in the list any more." };
    return MS.personMails({ emails: v.emails, limit: 5 }, mailEnvNow());
  });
  // Company logo: main fetches/caches the company's own icon and returns a data: URL (or null). Setting contactsLogos = "no" turns it off.
  let logos = null;
  handle("contacts-logo", async (a) => {
    const r = load(); if (r.err) return { ok: true, url: null };
    if (!Number.isInteger(a.id) || String(cfg("contactsLogos") || "").trim().toLowerCase() === "no") return { ok: true, url: null };
    const c = st.index.byId.get(a.id); if (!c) return { ok: true, url: null };
    let host = c.domain; if (!host && c.website) { try { host = new URL(c.website).hostname; } catch (e) { host = null; } }
    if (!logos) logos = require("./logos").createLogos(path.join(r.d, "logos"));
    return { ok: true, url: await logos.get(host) };
  });
  handle("contacts-mail-read", async (a) => MS.readMail(a.id, mailEnvNow()));
  handle("contacts-mail-open", async (a) => MS.openMail(a.id, mailEnvNow(), mailLaunch));
  return { stop() { clearTimeout(timer); try { if (watcher && watcher.close) watcher.close(); } catch (e) { /* closed */ } watcher = null; }, _state: () => st };
}

module.exports = { init, UI_FILE, EXPORT_FILE };
