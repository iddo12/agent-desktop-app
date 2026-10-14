// Demo mode (v1.86.0): IPC handlers that are replaced while demo mode is on. Each one either answers from the fixtures or answers "nothing
// to do", so no handler can reach the real CLI, the network, the machine's services or a location outside the demo base folder.
// Signature: (event, arg, realListener, state) -> result. Handlers not listed here run unchanged against the demo world.
"use strict";
const fs = require("fs");
const path = require("path");
const { VIRTUAL_REPORTS } = require("./paths");
const { createFakePty, screenText } = require("./fakePty");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findReport(state, virtualPath) {
  const base = path.basename(String(virtualPath).replace(/\\/g, "/"));
  try {
    for (const d of fs.readdirSync(state.P.root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = path.join(state.P.root, d.name, "reports", base);
      if (fs.existsSync(f)) return f;
    }
  } catch (e) { /* none */ }
  return null;
}

function startTerminal(state, { agentPath, cols, rows }) {
  const ctx = state.ctx;
  if (!ctx) return { alreadyRunning: false };
  if (ctx.ptySessions.has(agentPath)) return { alreadyRunning: true };
  const folder = path.basename(agentPath);
  const agent = (state.studio.agents || []).find((a) => a.folder === folder) || { folder, name: folder, role: "" };
  const thread = require("./runtime").threadFor(folder);
  const sessionCwd = ctx.sessionCwdFor(agentPath);
  const projDir = path.join(state.P.home, ".claude", "projects", String(sessionCwd).replace(/[^A-Za-z0-9-]/g, "-"));
  const working = thread.tail === "working";
  const fake = createFakePty({ agent, thread, projDir, working });
  const screen = screenText(agent, thread, working);
  ctx.ptySessions.set(agentPath, { proc: fake.proc, sessionCwd, archiveTimer: null, shell: "demo", spawnEnv: {}, agentId: "demo-" + folder, cols, rows, attachedAt: Date.now(), dataBytes: screen.length });
  ctx.dialogTails.set(agentPath, "✳ Claude Code  " + agent.name + "  ? for shortcuts");
  fake.proc.onData((d) => { const s = ctx.ptySessions.get(agentPath); if (s) s.dataBytes = (s.dataBytes || 0) + d.length; ctx.send("terminal-data", { agentPath, data: d }); });
  try { ctx.connHealth.onConnected(agentPath); } catch (e) { /* cosmetic */ }
  setTimeout(() => { ctx.send("terminal-data", { agentPath, data: "\x1b[2J\x1b[H" + screen }); }, 250);
  return { alreadyRunning: false };
}

const handlers = {
  // --- the real CLI -------------------------------------------------------------------------------------
  "start-terminal": (ev, arg, real, state) => startTerminal(state, arg),
  "switch-conversation": async (ev, arg, real, state) => {
    // Restart Session / Chats: a short, believable pause; the fake session is dropped and the renderer re-attaches a fresh one.
    const ctx = state.ctx;
    const live = ctx && ctx.ptySessions.get(arg.agentPath);
    if (live) { ctx.ptySessions.delete(arg.agentPath); try { live.proc.kill(); } catch (e) { /* fake */ } }
    await sleep(2400);
    return { ok: true, agentId: "demo" };
  },
  "check-claude-code-update": () => ({ current: "2.1.0", latest: "2.1.0", updateAvailable: false }),
  "update-claude-code": () => ({ ok: false, error: "Not available in this workspace." }),
  "update-claude-cli": () => ({ ok: false, error: "Not available in this workspace." }),
  "check-claude-executable-health": () => ({ healthy: true, resolvedPath: "", viaSymlink: false }),
  "check-interfering-services": () => [],
  "disable-interfering-service": () => ({ ok: false, error: "Not available in this workspace." }),
  "get-untrusted-agents": () => [],
  "trust-agent-folders": () => ({ ok: true }),
  "guard-trigger-login": () => ({ ok: false }),
  // --- voice goes over the network ------------------------------------------------------------------------------
  "voice-engine": () => ({ local: false }),
  "voice-warm": () => ({ ok: false }),
  "voice-save": () => ({ ok: false }),
  "voice-transcribe": () => ({ ok: false, error: "Voice input is off in this workspace." }),
  // --- the sidebar's state badges: the real overview, plus the fixture's "needs you" decision -----------------------
  "get-agent-overview": async (ev, arg, real, state) => {
    const r = await real(ev, arg);
    try {
      for (const a of r.agents || []) {
        const info = (state.studio.agents || []).find((x) => x.folder === a.folderName);
        if (info && info.state === "needs") {
          a.telegram = [{ id: "000000-0000", body: info.needsText || info.status, agent: a.folderName, status: "pending", createdAt: new Date().toISOString() }];
        }
      }
    } catch (e) { /* cosmetic */ }
    return r;
  },
  // --- clickable report paths: the path shown on screen is virtual, the file is in the demo folder ---------------------
  "open-local-pdf": async (ev, arg, real, state) => {
    const p = arg && arg.filePath;
    if (typeof p === "string" && p.toLowerCase().startsWith(VIRTUAL_REPORTS.toLowerCase())) {
      const f = findReport(state, p);
      if (f) return real(ev, Object.assign({}, arg, { filePath: f }));
    }
    return real(ev, arg);
  },
  // --- never reachable in a demo -----------------------------------------------------------------------------------
  "approve-telegram-tasks": () => ({ ok: false, output: "Not available in this workspace." }),
  "notify-send-failed": () => false,
  "pick-avatar": () => null,
};

module.exports = { handlers, findReport, startTerminal };
