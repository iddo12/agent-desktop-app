"use strict";
// main-contacts against a throwaway folder: guards, writes only the UI file + export, never contacts.json, refuses synced folders, agent export has no mail subjects.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "contacts-"));
const dir = path.join(root, "scratch", "contacts"); fs.mkdirSync(dir, { recursive: true });
const NOW = Date.parse("2026-10-25T12:00:00Z");
const P = (id, name, last, dir_, st) => ({ id, name, role: null, emails: [{ address: name.toLowerCase().replace(/\W/g, "") + "@x.example" }], last_contact: last, last_direction: dir_, status: st || "replied", extra: { automated: false }, mails: [{ date: last, subject: "SECRET-SUBJECT", direction: dir_ }] });
const contacts = { generated_at: "2026-10-24T01:00:00", window_days: 1460, unknown_company_people: 5, companies: [
  { id: 1, name: "Godox", domain: "godox.example", aliases: [], last_contact: "2026-10-22", last_direction: "in", people: [P(10, "Lena Wu", "2026-10-22", "in"), P(11, "Carl Meier", "2026-05-01", "out")] },
  { id: 2, name: "Nikon", domain: "nikon.example", aliases: [], last_contact: "2026-10-10", last_direction: "out", people: [P(20, "Ken Ito", "2026-10-10", "out")] },
] };
const BOM = "﻿";
fs.writeFileSync(path.join(dir, "contacts.json"), BOM + JSON.stringify(contacts));
fs.writeFileSync(path.join(dir, "category_suggestions.json"), JSON.stringify({ "godox.example": { categories: ["Lighting"], basis: "domain words" }, "nikon.example": { categories: ["<bad>"], basis: "x" } }));
const before = fs.readFileSync(path.join(dir, "contacts.json"));

const h = {}; const wc = { mainFrame: {}, sent: [], send(c) { this.sent.push(c); } };
const win = { webContents: wc, isDestroyed: () => false };
const ev = { sender: wc, senderFrame: wc.mainFrame };
let cfgDir = dir; const logs = [];
const api = require("../src/contacts/main-contacts").init({ ipcMain: { handle: (c, f) => { h[c] = f; } }, getMainWindow: () => win, log: (l) => logs.push(l), cfg: (k) => (k === "contactsDir" ? cfgDir : null), now: () => NOW, watch: () => ({ close() {}, on() {} }) });
const call = (c, a, e) => h[c](e || ev, a);

(async () => {
  // guards: only the main window, objects only
  assert.strictEqual((await call("contacts-list", {}, { sender: {}, senderFrame: {} })).ok, false);
  assert.strictEqual((await call("contacts-list", "x")).ok, false);
  assert.strictEqual((await call("contacts-list", { q: "x".repeat(9500) })).ok, false);

  let r = await call("contacts-list", {});
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.page.total, 2); assert.strictEqual(r.chips.uncategorised, 2); assert.strictEqual(r.meta.unknownPeople, 5);
  assert.strictEqual(r.meta.stale, false); assert.strictEqual(r.page.rows[0].name, "Godox", "latest contact first");
  r = await call("contacts-list", { q: "lena" }); assert.deepStrictEqual(r.page.rows.map((x) => x.id), [1]); assert.strictEqual(r.people[0].name, "Lena Wu");
  r = await call("contacts-list", { filter: "needs" }); assert.deepStrictEqual(r.page.rows.map((x) => x.id), [1]);
  r = await call("contacts-company", { id: 1 }); assert.ok(r.ok); assert.deepStrictEqual(r.company.current.map((p) => p.name), ["Lena Wu", "Carl Meier"]);
  assert.strictEqual((await call("contacts-company", { id: "1" })).ok, false); assert.strictEqual((await call("contacts-company", { id: 99 })).ok, false);

  // writes go to contacts_ui.json only; contacts.json is untouched; the export appears and holds no subjects
  assert.ok((await call("contacts-set-note", { kind: "company", id: 1, text: "Loans go through Merav" })).ok);
  assert.ok((await call("contacts-set-note", { kind: "person", id: 10, text: "Short mails" })).ok);
  assert.ok((await call("contacts-set-categories", { id: 1, categories: ["Lighting", "Supplier"] })).ok);
  assert.strictEqual((await call("contacts-set-categories", { id: 1, categories: ["<x>"] })).ok, false);
  assert.strictEqual((await call("contacts-set-categories", { id: 77, categories: ["A"] })).ok, false);
  assert.ok((await call("contacts-set-link", { id: 1, kind: "web", value: "https://godox.example" })).ok);
  assert.strictEqual((await call("contacts-set-link", { id: 1, kind: "web", value: "javascript:alert(1)" })).ok, false);
  assert.strictEqual((await call("contacts-set-note", { kind: "../x", id: 1, text: "a" })).ok, false);
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, "contacts.json")), before, "contacts.json never written");
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["category_suggestions.json", "contacts.json", "contacts_directory.json", "contacts_ui.json"]);
  const exp = fs.readFileSync(path.join(dir, "contacts_directory.json"), "utf8");
  assert.ok(!exp.includes("SECRET-SUBJECT") && !exp.includes("@x.example"), "no subjects or addresses in the agent export");
  const ej = JSON.parse(exp); const g = ej.companies.find((c) => c.company === "Godox");
  assert.deepStrictEqual(g.categories, ["Lighting", "Supplier"]); assert.strictEqual(g.note, "Loans go through Merav"); assert.strictEqual(g.current_contacts[0].name, "Lena Wu");
  r = await call("contacts-company", { id: 1 }); assert.deepStrictEqual(r.company.categories, ["Lighting", "Supplier"]); assert.strictEqual(r.company.links.web, "https://godox.example");
  r = await call("contacts-person", { id: 10 }); assert.strictEqual(r.person.note, "Short mails"); assert.strictEqual(r.person.mails[0].subject, "SECRET-SUBJECT");

  // snooze / no-reply
  assert.ok((await call("contacts-snooze", { id: 10, mode: "snooze", days: 7 })).ok);
  r = await call("contacts-list", { filter: "needs" }); assert.strictEqual(r.page.total, 0, "snoozed person leaves Needs my reply");
  assert.ok((await call("contacts-snooze", { id: 10, mode: "clear" })).ok);
  assert.strictEqual((await call("contacts-list", { filter: "needs" })).page.total, 1);
  assert.strictEqual((await call("contacts-snooze", { id: 999, mode: "noreply" })).ok, false);
  assert.strictEqual((await call("contacts-snooze", { id: 10, mode: "boom" })).ok, false);

  // suggestions: invalid category lists are skipped; confirm saves; reject hides
  r = await call("contacts-suggestions", {}); assert.deepStrictEqual(r.suggestions.map((s) => s.id), [], "Godox already categorised, Nikon's suggestion invalid");
  fs.writeFileSync(path.join(dir, "category_suggestions.json"), JSON.stringify({ "nikon.example": { categories: ["Cameras"], basis: "domain" } }));
  const st = api._state(); st.suggestions = null;
  r = await call("contacts-suggestions", {}); assert.deepStrictEqual(r.suggestions.map((s) => s.name), ["Nikon"]);
  assert.strictEqual((await call("contacts-suggestion-resolve", { id: 2, action: "confirm", categories: [] })).ok, false);
  assert.ok((await call("contacts-suggestion-resolve", { id: 2, action: "confirm", categories: ["Cameras"] })).ok);
  assert.strictEqual((await call("contacts-list", { category: "Cameras" })).page.total, 1);

  // a fresh export of contacts.json is picked up (mtime) and its BOM tolerated; a stale one is flagged
  contacts.generated_at = "2026-10-01T01:00:00"; contacts.companies.push({ id: 3, name: "Sony", domain: null, aliases: [], last_contact: "2026-01-01", last_direction: "out", people: [] });
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts)); fs.utimesSync(path.join(dir, "contacts.json"), new Date(), new Date(Date.now() + 5000));
  r = await call("contacts-list", {}); assert.strictEqual(r.page.total, 3); assert.strictEqual(r.meta.stale, true);
  assert.strictEqual(r.page.rows.find((x) => x.name === "Sony").tag, "quiet");

  // synced / missing folder refused
  cfgDir = path.join(root, "Dropbox", "contacts"); fs.mkdirSync(cfgDir, { recursive: true });
  r = await call("contacts-list", {}); assert.strictEqual(r.ok, false); assert.ok(/synced/.test(r.reason));
  cfgDir = null; r = await call("contacts-list", {}); assert.strictEqual(r.ok, false);
  cfgDir = path.join(root, "nope"); r = await call("contacts-list", {}); assert.strictEqual(r.ok, false);
  assert.ok(!logs.some((l) => /SECRET|Lena|Godox/.test(l)), "logs carry no names or subjects");
  api.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("contactsMain tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
