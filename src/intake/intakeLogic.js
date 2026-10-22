// Intake (PC side of the phone app): pure rules, no I/O. The watcher (Security\Tools\IntakeWatcher) appends EVENTS to intake_index.jsonl
// (fold by id, last line wins); this app appends ONLY to intake_approvals.jsonl. Rules from Iddo (2026-10-22): a command from the phone stays
// held until he approves it here; sealed items (medical/health/nutrition) are shown as counts, have no Send-to, and never leave this PC.
"use strict";

const STATUSES = ["new", "pending_approval", "approved", "sent", "rejected"];
const TABS = ["notes", "review", "receipts", "medical", "food", "health", "rejected"];
const KIND_TAB = { capture: "notes", note: "notes", idea: "notes", command: "notes", reminder: "notes", review: "review", product: "review", photo: "review", receipts: "receipts", receipt: "receipts", invoice: "receipts", medical: "medical", nutrition: "food", food: "food", health: "health" };
const SEALED_KINDS = ["medical", "health", "nutrition", "food"];
const HELD_SUBS = ["command", "reminder"];
const clip = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, n) : "");

// lines/events -> folded, validated item list. Malformed events are skipped; a later event for the same id replaces the earlier one.
function foldIndex(events) {
  const by = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const id = clip(typeof e.id === "string" ? e.id : "", 120);
    if (!id || !/^[A-Za-z0-9_\-./]+$/.test(id) || id.includes("..")) continue;
    const prev = by.get(id) || {};
    const kind = prev.sealed ? prev.kind : clip(String(e.kind || id.split("/")[0] || "capture"), 24).toLowerCase();
    const sub = prev.sealed ? prev.sub : clip(String(e.sub || ""), 24).toLowerCase();
    // sealed is sticky: a later event can never unseal an id; a sealed item's path stays recorded so no other id can read that file
    const sealed = prev.sealed === true || e.sealed === true || SEALED_KINDS.includes(kind) || SEALED_KINDS.includes(id.split("/")[0]);
    const sealedPath = prev.sealedPath || (sealed ? clip(String(e.path || prev.path || ""), 500) : "");
    by.set(id, {
      id, kind, sub, sealed, sealedPath,
      status: STATUSES.includes(e.status) ? e.status : (prev.status || "new"),
      created: clip(String(e.created || prev.created || ""), 40),
      title: sealed ? "" : clip(String(e.title || prev.title || ""), 300),
      path: sealed ? "" : clip(String(e.path || prev.path || ""), 500),
      suggestedAgent: sealed ? "" : clip(String(e.suggested_agent || prev.suggestedAgent || ""), 80),
      verified: e.verified === true,
      held: HELD_SUBS.includes(sub),
    });
  }
  return Array.from(by.values());
}

// fold the approvals lines: id -> last record
function foldApprovals(records) {
  const map = {};
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r.id !== "string" || (r.action !== "approve" && r.action !== "reject")) continue;
    map[r.id] = r;
  }
  return map;
}

// Our own record wins over what the index says: the watcher cannot mark something approved by itself.
function effectiveStatus(item, approvals) {
  const a = approvals && approvals[item.id];
  if (a && a.action === "reject") return "rejected";
  if (item.status === "rejected") return "rejected";
  // an approval is bound to the exact content it was given for: if the item changed since (hash differs or missing), it is pending again
  const bound = a && a.action === "approve" && (a.delivered === true || (typeof a.hash === "string" && a.hash && (!item.hash || a.hash === item.hash)));
  if (a && a.action === "approve" && !bound) return item.held || item.status === "pending_approval" ? "pending_approval" : "new";
  if (a && a.action === "approve") return item.status === "sent" ? "sent" : (a.delivered === true ? "sent" : "approved");
  if (item.held) return "pending_approval";   // held until WE record an approval, whatever the index claims
  return item.status === "pending_approval" ? "pending_approval" : item.status;
}

function tabOf(item, status) {
  if (status === "rejected") return "rejected";
  return KIND_TAB[item.kind] || "notes";
}

// counts never include sealed items in the shared totals or in the waiting count
function summarize(items, approvals) {
  const counts = { all: 0, pending: 0 };
  TABS.forEach((t) => { counts[t] = 0; });
  const rows = items.map((it) => { const status = effectiveStatus(it, approvals); return Object.assign({}, it, { status, tab: tabOf(it, status) }); });
  for (const r of rows) {
    counts[r.tab]++;
    if (!r.sealed) counts.all++;
    if (r.status === "pending_approval" && !r.sealed) counts.pending++;
  }
  return { rows, counts };
}

// Validate approve/reject. -> {ok, record?, deliver?, reason?}. `to` = chosen agent; default = the watcher's own route (no `to`).
function decide(req, item, approvals, opts, nowIso) {
  const act = req && req.action;
  if (!item) return { ok: false, reason: "That item is gone." };
  if (act !== "approve" && act !== "reject") return { ok: false, reason: "Unknown action." };
  const st = effectiveStatus(item, approvals);
  if (st === "sent") return { ok: false, reason: "Already sent." };
  if (act === "reject") return { ok: true, record: { id: item.id, action: "reject", at: nowIso } };
  if (item.sealed) return { ok: false, reason: "Sealed items stay on this PC and cannot be sent." };
  if (st === "rejected") return { ok: false, reason: "Rejected items cannot be approved." };
  if (st === "approved") return { ok: false, reason: "Already approved." };
  if (typeof req.hash !== "string" || !req.hash) return { ok: false, reason: "Open the item again before approving it." };
  if (req.hash !== item.hash) return { ok: false, reason: "This item changed since you opened it. Open it again to review." };
  if (opts && opts.requireVerified && !item.verified) return { ok: false, reason: "Not from your phone: it cannot be approved." };
  const rec = { id: item.id, action: "approve", at: nowIso, hash: item.hash };
  const to = typeof req.to === "string" ? req.to.trim() : "";
  if (!to && !(opts && opts.defaultAgent)) return { ok: false, reason: "Pick an agent to send to (or set intakeDefaultAgent in Setup)." };
  if (to && to !== (opts && opts.defaultAgent)) { rec.to = to; rec.to_other = true; return { ok: true, record: rec, deliver: { agent: to } }; }
  return { ok: true, record: rec };
}

// The text an agent receives when AD itself delivers (to_other). Plain, says it was approved on the PC.
const sha256 = (t) => require("crypto").createHash("sha256").update(String(t), "utf8").digest("hex");
function buildMessage(item, body) {
  return clip(body || item.title, 4000).trim() + "\n(From Iddo, approved on the PC in Agent Desktop Intake. Item " + item.id + ".)";
}

module.exports = { STATUSES, TABS, foldIndex, foldApprovals, effectiveStatus, summarize, decide, buildMessage, sha256 };
