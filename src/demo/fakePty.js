// Demo mode (v1.86.0): the stand-in for the real `claude` terminal session. No process is ever spawned.
//
// A fake "pty" has the few members main.js uses on a node-pty process (pid, write, resize, kill, onData, onExit). What it prints in the
// Raw Terminal is generated from the agent's scripted thread; what the user types is answered from the thread's scripted replies, and
// both sides are appended to the agent's transcript file (the same JSONL the real CLI writes), so the chat view, the "working" state
// and the delivery checks all behave as they do for a real agent.
"use strict";
const fs = require("fs");
const path = require("path");
const { VIRTUAL_REPORTS } = require("./paths");

const ESC = "\x1b";
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;
const bold = (s) => `${ESC}[1m${s}${ESC}[0m`;
const col = (c, s) => `${ESC}[38;5;${c}m${s}${ESC}[0m`;

// markdown pipe table -> box-drawing table (how the CLI draws it)
function boxTable(rows) {
  const cells = rows.filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  if (!cells.length) return rows.join("\r\n");
  const w = cells[0].map((_, i) => Math.max(...cells.map((r) => (r[i] || "").length)));
  const line = (l, m, r) => l + w.map((x) => "\u2500".repeat(x + 2)).join(m) + r;
  const row = (r) => "\u2502" + w.map((x, i) => " " + (r[i] || "").padEnd(x) + " ").join("\u2502") + "\u2502";
  const out = [line("\u250c", "\u252c", "\u2510"), row(cells[0]), line("\u251c", "\u253c", "\u2524")];
  cells.slice(1).forEach((r, i) => { out.push(row(r)); });
  out.push(line("\u2514", "\u2534", "\u2518"));
  return out.join("\r\n");
}

function renderAgentText(text) {
  const lines = String(text).split(/\r?\n/);
  const out = []; let table = [];
  const flush = () => { if (table.length) { out.push(boxTable(table)); table = []; } };
  for (const l of lines) {
    if (/^\s*\|.*\|\s*$/.test(l)) { table.push(l); continue; }
    flush();
    out.push(l.replace(/\*\*(.+?)\*\*/g, (m, t) => bold(t)));
  }
  flush();
  return out.join("\r\n  ");
}

function header(agentName, role, cwdShown) {
  const w = 62;
  const pad = (s) => s + " ".repeat(Math.max(0, w - s.length));
  return [
    col(173, "\u256d" + "\u2500".repeat(w + 2) + "\u256e"),
    col(173, "\u2502 ") + col(173, "\u2733 ") + bold(pad("Claude Code")) + col(173, " \u2502"),
    col(173, "\u2502 ") + dim(pad("  " + agentName + " - " + role)) + col(173, " \u2502"),
    col(173, "\u2502 ") + dim(pad("  " + cwdShown)) + col(173, " \u2502"),
    col(173, "\u2570" + "\u2500".repeat(w + 2) + "\u256f"),
    "",
  ].join("\r\n");
}

function screenText(agent, thread, working) {
  const parts = [header(agent.name, agent.role, "C:\\Aurora Studio\\" + agent.folder)];
  // the terminal shows the end of the conversation (a real screen would have scrolled the rest away)
  for (const m of (thread.messages || []).slice(-3)) {
    const t = String(m.text).split("{{REPORTS}}").join(VIRTUAL_REPORTS);
    if (m.role === "user") parts.push(dim("> ") + t.replace(/\n/g, "\r\n  ") + "\r\n");
    else parts.push(col(255, "\u25cf ") + renderAgentText(t) + "\r\n");
  }
  if (working) parts.push(col(173, "\u273b ") + col(173, (thread.tool === "WebSearch" ? "Searching the web" : "Working") + "\u2026") + dim(" (esc to interrupt)") + "\r\n");
  parts.push(col(240, "\u256d" + "\u2500".repeat(64) + "\u256e") + "\r\n" + col(240, "\u2502 ") + dim("> ") + " ".repeat(61) + col(240, "\u2502") + "\r\n" + col(240, "\u2570" + "\u2500".repeat(64) + "\u256f") + "\r\n" + dim("  ? for shortcuts"));
  return parts.join("\r\n").replace(/\r\n\r\n\r\n/g, "\r\n\r\n");
}

// ---- transcript append ------------------------------------------------------------------------------------
function currentTranscript(projDir) {
  let best = null, bestM = -1;
  try {
    for (const f of fs.readdirSync(projDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const m = fs.statSync(path.join(projDir, f)).mtimeMs;
      if (m > bestM) { bestM = m; best = f; }
    }
  } catch (e) { /* no transcript */ }
  return best ? { file: path.join(projDir, best), sessionId: best.replace(/\.jsonl$/, "") } : null;
}
function appendEntry(tr, obj) {
  fs.appendFileSync(tr.file, JSON.stringify(Object.assign({ sessionId: tr.sessionId, uuid: require("crypto").randomUUID(), timestamp: new Date().toISOString() }, obj)) + "\n");
}

const CANNED = [
  "Got it - I've noted that and I'll pick it up on my next pass. (This is a demo workspace, so nothing real is being run.)",
  "Understood. I'll add that to my list and report back here when it's done.",
];

function pickReply(thread, text, n) {
  for (const rule of thread.replyRules || []) {
    try { if (new RegExp(rule.match, "i").test(text)) return rule.text; } catch (e) { /* bad rule */ }
  }
  const list = (thread.replies && thread.replies.length ? thread.replies : CANNED);
  return list[n % list.length];
}

function createFakePty(opts) {
  const { agent, thread, projDir, emit, vars } = opts;
  const dataCbs = [], exitCbs = [];
  let buf = "", inPaste = false, replies = 0, dead = false;
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); if (!dead) fn(); }, ms); timers.add(t); if (t.unref) t.unref(); };
  const out = (s) => { for (const cb of dataCbs.slice()) { try { cb(s); } catch (e) { /* listener failure is not ours */ } } };

  function submit(text) {
    const t = text.trim();
    if (!t || /^\/(clear|exit)\b/.test(t)) return;
    out("\r\n" + dim("> ") + t.replace(/\n/g, "\r\n  ") + "\r\n\r\n");
    const tr = currentTranscript(projDir);
    if (tr) appendEntry(tr, { type: "user", origin: { kind: "human" }, message: { role: "user", content: t } });
    out(col(173, "\u273b ") + col(173, "Thinking\u2026") + dim(" (esc to interrupt)") + "\r\n");
    later(1800, () => {
      const reply = String(pickReply(thread, t, replies++)).split("{{REPORTS}}").join(VIRTUAL_REPORTS);
      const tr2 = currentTranscript(projDir);
      if (tr2) appendEntry(tr2, { type: "assistant", message: { id: "msg_demo" + replies, role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: reply }], stop_reason: thread.tail === "working" ? null : "end_turn", usage: { input_tokens: 40, cache_read_input_tokens: 36000 + replies * 400, cache_creation_input_tokens: 800, output_tokens: 180 } } });
      out(col(255, "\u25cf ") + renderAgentText(reply) + "\r\n\r\n");
      if (thread.tail === "working" && tr2) {
        // a "working" agent goes on working after answering
        later(900, () => appendEntry(tr2, { type: "assistant", message: { id: "msg_demo_tool" + replies, role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "toolu_demo_r" + replies, name: thread.tool || "WebSearch", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 40, cache_read_input_tokens: 36500, cache_creation_input_tokens: 300, output_tokens: 60 } } }));
      }
    });
  }

  // A working agent keeps a faint pulse on its terminal (a harmless attribute reset), so the chat does not warn "no recent output".
  let pulse = null;
  if (opts.working) { pulse = setInterval(() => { if (!dead) out(ESC + "[0m"); }, 2000); if (pulse.unref) pulse.unref(); }

  const proc = {
    pid: process.pid,
    onData(cb) { dataCbs.push(cb); return { dispose() { const i = dataCbs.indexOf(cb); if (i >= 0) dataCbs.splice(i, 1); } }; },
    onExit(cb) { exitCbs.push(cb); return { dispose() { const i = exitCbs.indexOf(cb); if (i >= 0) exitCbs.splice(i, 1); } }; },
    resize() {},
    kill() { if (dead) return; dead = true; if (pulse) clearInterval(pulse); for (const t of timers) clearTimeout(t); timers.clear(); },
    write(data) {
      let s = String(data);
      while (s.length) {
        if (inPaste) {
          const end = s.indexOf(ESC + "[201~");
          if (end < 0) { buf += s; s = ""; } else { buf += s.slice(0, end); s = s.slice(end + 6); inPaste = false; }
        } else if (s.startsWith(ESC + "[200~")) { inPaste = true; s = s.slice(6); }
        else if (s[0] === "\r" || s[0] === "\n") { const t = buf; buf = ""; s = s.slice(1); if (t.trim()) submit(t); }
        else if (s[0] === "\x03") { buf = ""; s = s.slice(1); }
        else if (s[0] === ESC) { s = s.replace(/^\x1b(\[[0-9;?<>]*[A-Za-z~]|O[A-Za-z]|.)?/, ""); }
        else { buf += s[0]; s = s.slice(1); }
      }
    },
  };
  return { proc, screen: (working) => screenText(agent, thread, working), emit, vars };
}

module.exports = { createFakePty, screenText, boxTable, renderAgentText, CANNED, currentTranscript };
