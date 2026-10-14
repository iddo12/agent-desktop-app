// My Daily - dismissing items from the Emails lists (v1.113.1). PURE helpers, loaded both in Node (main process, tests) and as a plain
// <script> in the renderer (window.dailyEmailDismiss). Dismissal is local state only: it never touches a mailbox (the IMAP and Gmail code is
// read-only by design). An item is keyed by list + account + the id of the LAST message of the conversation, so when the thread gets a new
// message (a reply, or you write again) the id changes and the item is treated normally again. No fs, no clock, no electron here.
(function (root) {
  "use strict";
  const LISTS = ["needAnswer", "sentNoReply"];
  const MAX_ENTRIES = 5000;
  const KEEP_DAYS = 400;               // an entry older than this is forgotten (its mail is long out of the feed window)
  const DAY = 86400000;
  const clip = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

  // list + account + last-message id -> key, or null when the item has no usable id/account (then it cannot be dismissed).
  function keyOf(list, item) {
    if (!LISTS.includes(list) || !item || typeof item !== "object") return null;
    const id = clip(item.id, 300), account = clip(item.account, 160);
    if (!id || !account) return null;
    return list + "|" + account + "|" + id;
  }

  const emptyStore = () => ({ v: 1, items: {} });

  // Anything -> a valid store (never throws). Drops malformed entries and caps the size (newest kept).
  function cleanStore(raw) {
    const out = emptyStore();
    const src = raw && typeof raw === "object" && raw.items && typeof raw.items === "object" && !Array.isArray(raw.items) ? raw.items : {};
    const rows = [];
    for (const k of Object.keys(src)) {
      const e = src[k];
      const parts = k.split("|");
      if (parts.length < 3 || !LISTS.includes(parts[0]) || !e || typeof e !== "object") continue;
      const at = Number(e.at);
      if (!Number.isFinite(at) || at <= 0) continue;
      rows.push([k, { at, subject: clip(e.subject, 200), who: clip(e.who, 160) }]);
    }
    rows.sort((a, b) => b[1].at - a[1].at);
    for (const [k, v] of rows.slice(0, MAX_ENTRIES)) out.items[k] = v;
    return out;
  }
  const serialize = (store) => JSON.stringify(cleanStore(store), null, 2);
  function parse(text) { try { return cleanStore(JSON.parse(String(text).replace(/^﻿/, ""))); } catch (e) { return emptyStore(); } }

  // entries: [{list, account, id, subject, who}] -> new store with them dismissed at `now`. Invalid entries are skipped; also forgets very old ones.
  function add(store, entries, now) {
    const out = cleanStore(store);
    for (const en of Array.isArray(entries) ? entries : []) {
      const k = en ? keyOf(en.list, en) : null;
      if (!k) continue;
      out.items[k] = { at: now, subject: clip(en.subject, 200), who: clip(en.who, 160) };
    }
    for (const k of Object.keys(out.items)) if (now - out.items[k].at > KEEP_DAYS * DAY) delete out.items[k];
    return cleanStore(out);
  }
  // keys: array of keys, or null = everything.
  function restore(store, keys) {
    const out = cleanStore(store);
    if (keys == null) return emptyStore();
    for (const k of Array.isArray(keys) ? keys : []) delete out.items[String(k)];
    return out;
  }

  const whoOf = (list, x) => (list === "sentNoReply" ? x.to : x.from) || "";
  // Describe an item for the store/IPC.
  function entryOf(list, x) { return { list, account: x.account, id: x.id, subject: x.subject, who: whoOf(list, x) }; }

  // emails ({top, needAnswer, sentNoReply, ...}) + store -> { emails: same shape without dismissed items, dismissed: [{key, list, account, id, subject, who, ageDays, at}] }.
  // `top` follows needAnswer (the same conversation). Only dismissed items that are in the feed now are returned in `dismissed` (what Restore can show).
  function apply(em, store) {
    const items = cleanStore(store).items;
    const e = em || {};
    const out = Object.assign({}, e);
    const dismissed = [];
    for (const list of LISTS) {
      out[list] = (e[list] || []).filter((x) => {
        const k = keyOf(list, x);
        const rec = k && items[k];
        if (!rec) return true;
        dismissed.push({ key: k, list, account: x.account, id: x.id, subject: x.subject || rec.subject, who: whoOf(list, x) || rec.who, ageDays: x.ageDays, at: rec.at });
        return false;
      });
    }
    if (Array.isArray(e.top)) out.top = e.top.filter((x) => { const k = keyOf("needAnswer", x); return !(k && items[k]); });
    dismissed.sort((a, b) => b.at - a.at);
    return { emails: out, dismissed };
  }

  // Bulk: items of one list older than `days` (strictly), optionally one account. Returns entries for add().
  function olderThan(list, items, days, account) {
    const d = Number(days);
    if (!LISTS.includes(list) || !Number.isFinite(d) || d < 1) return [];
    return (items || []).filter((x) => Number(x.ageDays) > d && (!account || account === "all" || x.account === account) && keyOf(list, x)).map((x) => entryOf(list, x));
  }

  const api = { LISTS, MAX_ENTRIES, KEEP_DAYS, keyOf, emptyStore, cleanStore, serialize, parse, add, restore, apply, olderThan, entryOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.dailyEmailDismiss = api;
})(typeof window !== "undefined" ? window : globalThis);
