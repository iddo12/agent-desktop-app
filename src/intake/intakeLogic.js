// Intake (PC side of the phone app): pure rules, no I/O. The watcher (Security\Tools\IntakeWatcher) writes intake_index.json; this app
// writes ONLY the approvals file. Rules from Iddo (2026-10-22): a command from the phone stays pending until he approves it here; an item
// that is not verified cannot be approved; sealed kinds (medical/food/health) never leave this PC except to the Health agent.
"use strict";

const STATUSES = ["new", "pending_approval", "approved", "sent", "rejected"];
const SEALED = ["medical", "food", "health"];
const TABS = ["notes", "review", "receipts", "medical", "food", "health", "rejected"];
const KIND_TAB = { note: "notes", idea: "notes", command: "notes", order: "notes", review: "review", product: "review", photo: "review", receipt: "receipts", medical: "medical", food: "food", health: "health" };
const MAX_TEXT = 4000;

const clip = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, n) : "");

// -> clean item list. Unknown kinds fall into "notes"; an item without a usable id is dropped; verified must be literally true.
function normalizeIndex(raw) {
  const list = raw && Array.isArray(raw.items) ? raw.items : Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const id = clip(String(it.id == null ? "" : it.id), 80);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kind = clip(String(it.kind || "note"), 24).toLowerCase();
    const status = STATUSES.includes(it.status) ? it.status : "new";
    out.push({
      id, kind, status,
      created: clip(String(it.created || ""), 40),
      summary: clip(it.summary || it.title || "", 300),
      transcriptPath: clip(it.transcript_path || it.transcriptPath || "", 500),
      transcript: clip(it.transcript || "", MAX_TEXT),
      suggestedAgent: clip(it.suggested_agent || it.suggestedAgent || "", 80),
      verified: it.verified === true,
      sealed: SEALED.includes(kind),
      isCommand: kind === "command" || kind === "order",
    });
  }
  return out;
}

// Approval records win over what the index says: the watcher cannot mark something approved by itself.
function effectiveStatus(item, approvals) {
  const a = approvals && approvals[item.id];
  if (a && a.action === "reject") return "rejected";
  if (a && a.action === "send" && a.delivered === true) return "sent";
  if (a && (a.action === "approve" || a.action === "send")) return "approved";
  if (item.status === "pending_approval" || (item.isCommand && item.status === "new")) return "pending_approval";
  if (item.status === "approved" || item.status === "sent") return "pending_approval";   // the index claims an approval AD never recorded: show it as waiting
  return item.status;
}

function tabOf(item, status) {
  if (status === "rejected") return "rejected";
  return KIND_TAB[item.kind] || "notes";
}

function summarize(items, approvals) {
  const counts = { all: 0, pending: 0 };
  TABS.forEach((t) => { counts[t] = 0; });
  const rows = items.map((it) => {
    const status = effectiveStatus(it, approvals);
    const tab = tabOf(it, status);
    return Object.assign({}, it, { status, tab });
  });
  for (const r of rows) {
    counts[r.tab]++;
    if (!r.sealed) counts.all++;                       // sealed items never add to the shared totals
    if (r.status === "pending_approval" && !r.sealed && r.verified) counts.pending++;
  }
  return { rows, counts };
}

// Who may receive this item. Sealed: only the Health agent (healthAgent = its folder name from the configuration). Others: any agent name.
function canSendTo(item, agent, healthAgent) {
  if (!agent || typeof agent !== "string") return { ok: false, reason: "Pick an agent." };
  if (item.sealed) {
    if (!healthAgent || agent !== healthAgent) return { ok: false, reason: "Sealed items go only to the Health agent." };
  }
  return { ok: true };
}

// The message an agent receives. Plain text only, always says it was approved on the PC.
function buildMessage(item, text) {
  const body = clip(text != null ? text : (item.transcript || item.summary), MAX_TEXT).trim();
  return body + "\n(From Iddo, approved on the PC in Agent Desktop Intake. Item " + item.id + ".)";
}

// Validate an approve/reject/send request against the current state. -> {ok, record?, reason?}
function decide(req, item, approvals, healthAgent, now) {
  const act = req && req.action;
  if (!item) return { ok: false, reason: "That item is gone." };
  if (act !== "approve" && act !== "reject" && act !== "send") return { ok: false, reason: "Unknown action." };
  const st = effectiveStatus(item, approvals);
  if (act === "reject") {
    if (st === "sent") return { ok: false, reason: "Already sent." };
    return { ok: true, record: { id: item.id, action: "reject", at: now } };
  }
  if (!item.verified) return { ok: false, reason: "Not from your phone: it cannot be approved." };
  if (st === "rejected") return { ok: false, reason: "Rejected items cannot be sent." };
  if (st === "sent") return { ok: false, reason: "Already sent." };
  const agent = req.agent || item.suggestedAgent;
  const can = canSendTo(item, agent, healthAgent);
  if (!can.ok) return can;
  const message = buildMessage(item, req.text);
  return { ok: true, record: { id: item.id, action: act, agent, message, at: now } };
}

module.exports = { STATUSES, SEALED, TABS, normalizeIndex, effectiveStatus, summarize, canSendTo, buildMessage, decide };
