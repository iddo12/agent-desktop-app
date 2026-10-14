// My Health stage 1: the local typed store. Plain JSONL files in ONE folder (the "root"), no native modules, no server.
//   measurements.jsonl  labs.jsonl  meds.jsonl  notes.jsonl  imports.jsonl  meta.json
// Every write is read-modify-write to a temp file in the same folder, fsync, then rename over the old file, so a crash
// leaves either the old file or the new one, never half of one. A corrupt line is skipped and counted, never fatal.
// Files stay small: importers aggregate per day (one number per metric per day), not per heartbeat.
// PRIVACY: this module never logs. Return values carry counts and ids; errors carry {field, code} only.
"use strict";
const fs = require("fs");
const path = require("path");
const S = require("./schema");
const AT = require("./atomic");

const FILES = { measurement: "measurements.jsonl", lab: "labs.jsonl", med: "meds.jsonl", note: "notes.jsonl", import: "imports.jsonl" };

function createStore(opts) {
  const root = opts && opts.root;
  if (!root || typeof root !== "string") throw new Error("health store needs a root folder");
  const fsx = (opts && opts.fs) || fs;
  const file = (k) => path.join(root, FILES[k]);

  function ensure() {
    fsx.mkdirSync(root, { recursive: true });
    const m = path.join(root, "meta.json");
    if (!fsx.existsSync(m)) writeText(m, JSON.stringify({ schema: S.SCHEMA_VERSION, created: S.localIso(new Date()) }) + "\n");
  }
  function writeText(target, text) { AT.write(fsx, target, text); }
  function read(kind) {
    let raw;
    try { raw = fsx.readFileSync(file(kind), "utf8"); } catch (e) { if (e.code === "ENOENT") return { records: [], corrupt: 0 }; throw e; }
    const records = []; let corrupt = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && typeof r === "object" && typeof r.id === "string") records.push(r); else corrupt++; } catch (e) { corrupt++; }
    }
    return { records, corrupt };
  }
  function writeAll(kind, records) { ensure(); writeText(file(kind), records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "")); }

  // Validate every input, then upsert by id in ONE write. Returns {added, updated, rejected, errors:[{index, errors}]}.
  function upsertMany(kind, inputs) {
    const norm = S.NORMALIZERS[kind];
    const { records } = read(kind);
    const byId = new Map(records.map((r, i) => [r.id, i]));
    let added = 0, updated = 0, rejected = 0, kept = 0; const errors = []; const ids = [];
    (Array.isArray(inputs) ? inputs : []).forEach((inp, index) => {
      const r = norm(inp);
      if (!r.ok) { rejected++; if (errors.length < 20) errors.push({ index, errors: r.errors }); return; }
      ids.push(r.record.id);
      if (byId.has(r.record.id)) { const old = records[byId.get(r.record.id)]; if (old.n != null && r.record.n != null && r.record.n < old.n) { kept++; return; } records[byId.get(r.record.id)] = r.record; updated++; }
      else { byId.set(r.record.id, records.length); records.push(r.record); added++; }
    });
    if (added || updated) writeAll(kind, records);
    return { added, updated, rejected, kept, errors, ids };
  }
  const addOne = (kind, input) => {
    const r = upsertMany(kind, [input]);
    return r.rejected ? { ok: false, errors: r.errors[0].errors } : { ok: true, id: r.ids[0], added: r.added, updated: r.updated };
  };

  const sortAsc = (a) => a.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));

  return {
    root,
    ensure,
    addMeasurements: (list) => upsertMany("measurement", list),
    addLabs: (list) => upsertMany("lab", list),
    addMeasurement: (i) => addOne("measurement", i),
    addLab: (i) => addOne("lab", i),
    addMed: (i) => addOne("med", i),
    addNote: (i) => addOne("note", i),
    listMeasurements: (q) => {
      let a = read("measurement").records;
      if (q && q.metric) a = a.filter((r) => r.metric === q.metric);
      if (q && q.since) a = a.filter((r) => r.ts >= q.since);
      return sortAsc(a);
    },
    listLabs: () => sortAsc(read("lab").records),
    listMeds: () => read("med").records.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)),
    listNotes: () => sortAsc(read("note").records),
    listImports: () => sortAsc(read("import").records),
    stopMed(id, stopDate) {
      const { records } = read("med");
      const i = records.findIndex((r) => r.id === id);
      if (i < 0) return { ok: false, errors: [{ field: "id", code: "unknown" }] };
      const r = S.normalizeMed(Object.assign({}, records[i], { stop: stopDate == null ? new Date() : stopDate }));
      if (!r.ok) return { ok: false, errors: r.errors };
      records[i] = r.record; writeAll("med", records);
      return { ok: true, id };
    },
    remove(kind, id) {
      if (!FILES[kind]) return { ok: false };
      const { records } = read(kind);
      const next = records.filter((r) => r.id !== id);
      if (next.length === records.length) return { ok: false };
      writeAll(kind, next);
      return { ok: true };
    },
    // The import ledger holds an id, a format name and counts. No file name, no path, no values.
    logImport(entry) {
      const { records } = read("import");
      records.push({ id: S.randomId("i"), ts: S.localIso(new Date()), format: String(entry.format || "").slice(0, 24), fileId: entry.fileId || null, counts: entry.counts || {} });
      writeAll("import", records.slice(-200));
    },
    counts() {
      const c = {}; let corrupt = 0;
      for (const k of Object.keys(FILES)) { const r = read(k); c[k] = r.records.length; corrupt += r.corrupt; }
      c.corrupt = corrupt; return c;
    },
  };
}

module.exports = { createStore, FILES };
