// TOOLS v1 card/status logic. Pure functions: catalogue entry + live facts -> what a card shows. No I/O, no DOM.
"use strict";
const { STATUS_LABELS, BASKETS, BASKET_LABELS, KINDS, KIND_LABELS } = require("./schema");

const TESTED_STALE_DAYS = 30;
const REASONS = {
  "no-launcher": "No launcher set yet", missing: "Launcher file not found", "outside-allowed-folders": "Launcher is outside the allowed folders",
  "resolves-outside-allowed-folders": "Launcher resolves outside the allowed folders", "extension-not-allowed": "Launcher type not allowed",
  "unc-or-device-path": "Network paths are not allowed", "relative-path": "Launcher path must be absolute", "path-traversal": "Launcher path not allowed",
  "bad-characters": "Launcher path has unsupported characters", "bad-argument": "Launcher arguments not allowed", "too-many-args": "Too many launcher arguments",
  "not-a-file": "Launcher is not a file", "bad-path": "Launcher path not allowed", "too-long": "Launcher path too long", "spawn-failed": "Could not start it",
};
const reasonText = (code) => REASONS[code] || "Cannot start";

// procs: [{name, cmd}] (lowercase compare). A tool with no process hint is never auto-detected as running.
function isRunning(tool, procs) {
  if (!tool) return false;
  if (tool.self) return true;
  const h = tool.process;
  if (!h || (!h.name && !h.cmd) || !Array.isArray(procs)) return false;
  const n = (h.name || "").toLowerCase(), c = (h.cmd || "").toLowerCase();
  return procs.some((p) => p && (!n || String(p.name || "").toLowerCase() === n) && (!c || String(p.cmd || "").toLowerCase().includes(c)));
}

const daysBetween = (a, b) => Math.floor((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

// Three dots: launcher exists, last run ok, tested. state: ok | bad | warn | unknown. Never colour-only: each has a word.
function healthDots(tool, launchCheck, today) {
  const h = tool.health || {};
  const launcher = tool.self ? { state: "ok", text: "Running now" }
    : !tool.launch ? { state: "bad", text: "No launcher set" }
      : launchCheck && launchCheck.ok ? { state: "ok", text: "Launcher found" } : { state: "bad", text: reasonText(launchCheck && launchCheck.reason) };
  const lastRun = h.lastRun === "ok" ? { state: "ok", text: "Last run ok" } : h.lastRun === "failed" ? { state: "bad", text: "Last run failed" } : { state: "unknown", text: "Last run not recorded" };
  let tested;
  if (h.tested && h.lastTested) {
    const age = today ? daysBetween(h.lastTested, today) : 0;
    tested = age > TESTED_STALE_DAYS ? { state: "warn", text: "Tested " + h.lastTested + " (" + age + " days ago)" } : { state: "ok", text: "Tested " + h.lastTested };
  } else if (h.tested) tested = { state: "ok", text: "Tested" };
  else tested = { state: "unknown", text: "Not tested yet" };
  return [Object.assign({ id: "launcher", label: "Launcher" }, launcher), Object.assign({ id: "lastRun", label: "Last run" }, lastRun), Object.assign({ id: "tested", label: "Tested" }, tested)];
}

// ctx: { launchCheck:{ok,reason}, procs, stats (stats.view().byTool[id]), today:"YYYY-MM-DD", libraryTitles? }
function toCard(tool, ctx) {
  const c = ctx || {};
  const running = isRunning(tool, c.procs);
  const pub = tool.visibility === "public";
  let start;
  if (running) start = { state: "running", label: "Running", reason: "" };
  else if (!tool.launch) start = { state: "disabled", label: "Start", reason: reasonText("no-launcher") };
  else if (!c.launchCheck || !c.launchCheck.ok) start = { state: "disabled", label: "Start", reason: reasonText(c.launchCheck && c.launchCheck.reason) };
  else start = { state: "ready", label: "Start", reason: "" };
  const st = c.stats || null;
  // PRIVACY: a private tool shows no repo or release link anywhere and carries no stats.
  const repoUrl = pub && tool.repo ? "https://github.com/" + tool.repo : null;
  return {
    id: tool.id, registryId: tool.registryId, basket: tool.basket, kind: tool.kind === "service" ? "service" : "app", name: tool.name, purpose: tool.purpose,
    status: tool.status, statusLabel: STATUS_LABELS[tool.status] || tool.status,
    version: tool.version || "", next: tool.next || "", owner: tool.owner || "", folder: tool.folder || "",
    description: tool.description || "", notes: tool.notes || "", upcoming: tool.upcoming || [], feedback: tool.feedback || [],
    visibility: tool.visibility, uncertain: tool.uncertain || [],
    start, dots: healthDots(tool, c.launchCheck, c.today),
    resolved: c.launchCheck && c.launchCheck.ok ? c.launchCheck.real : "", launchArgs: tool.launch ? tool.launch.args : [],
    trust: c.trust || "n/a", trustedOn: c.pinnedAt || "", runningUnknown: !!c.procsUnknown,
    repoUrl, hasRepo: !!repoUrl,
    release: pub ? tool.release : { url: null, date: null, notes: null },
    releaseNote: pub ? (st && st.fetched && st.hasRelease === true ? "" : st && st.fetched && st.hasRelease === null ? "release info not checked yet" : "no public release yet") : "private tool: not published",
    stats: pub && tool.repo ? (st || { fetched: false }) : null,
    screenshots: Array.isArray(c.screenshots) ? c.screenshots : [],
  };
}

function groupCards(cards, labels) {
  return BASKETS.map((b) => ({ basket: b, label: (labels && typeof labels[b] === "string" && labels[b]) || BASKET_LABELS[b], cards: cards.filter((c) => c.basket === b) }));
}

// v1.122.0: two tabs. Cards are split by kind first (a missing or unknown kind is "app"), then by the basket groups inside each tab.
function groupByKind(cards, labels) {
  return KINDS.map((k) => { const cs = cards.filter((c) => (c.kind === "service" ? "service" : "app") === k); return { kind: k, label: KIND_LABELS[k], count: cs.length, groups: groupCards(cs, labels) }; });
}

// "Coming up": registry projects at stage idea or researched, excluding anything already a tool. Newest first, capped.
function comingUp(entries, tools, cap) {
  const have = new Set();
  for (const t of tools) { if (t.registryId) have.add(t.registryId); have.add(t.id); }
  const items = (entries || []).filter((e) => e && e.type === "project" && (e.stage === "idea" || e.stage === "researched") && e.status !== "archived" && e.status !== "superseded" && !have.has(e.id))
    .map((e) => ({ id: e.id, title: String(e.title || "").slice(0, 120), stage: e.stage, updatedAt: e.updatedAt || e.createdAt || "" }))
    .sort((a, b) => (a.stage === b.stage ? String(b.updatedAt).localeCompare(String(a.updatedAt)) : a.stage === "researched" ? -1 : 1));
  const n = cap || 24;
  return { total: items.length, items: items.slice(0, n) };
}

module.exports = { isRunning, healthDots, toCard, groupCards, groupByKind, comingUp, reasonText, TESTED_STALE_DAYS };
