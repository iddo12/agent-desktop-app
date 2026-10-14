// Demo mode (v1.86.0): builds the disposable demo world from the fixture folder. Reads ONLY the fixture folder; writes ONLY under the
// demo base folder (paths.js). Run at every launch, so the world always starts identical and "minutes ago" is relative to now.
//
// Layout produced (all under <base>):
//   root\<Agent>\            agent_config.json, master_state.md, CLAUDE.md, avatar.png, sessions\, .claude-session\, reports\*.pdf
//   root\agent_groups.json   the coloured sidebar groups
//   root\shared_reports\tasks\<Agent>.json   the task store My Daily reads
//   root\shared_registry\*.json              the Library entries
//   root\daily\              shopping.json, shipments.json, dates.json, appointments.json
//   home\.claude\            projects\<encoded cwd>\<uuid>.jsonl (scripted transcripts), daemon\pty-pids\, rate-limit cache
//   health\                  the My Health store (measurements, labs, meds, profile, agent files)
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { VIRTUAL_REPORTS } = require("./paths");

const MIN = 60000, DAY = 86400000;
const encodeProjectPath = (cwd) => String(cwd).replace(/[^A-Za-z0-9-]/g, "-"); // same rule as archive.js

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const readText = (p) => fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
const exists = (p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } };
// JSON is written WITHOUT a BOM on purpose (a BOM silently breaks some readers).
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n", "utf8"); };
const writeText = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t, "utf8"); };
const uuid = (seed) => { const h = crypto.createHash("sha1").update(seed).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

function wipe(P) {
  problemLog = path.join(P.base, "demo-problems.log");
  // Only ever deletes the four generated folders inside a base that carries our marker.
  fs.mkdirSync(P.base, { recursive: true });
  const names = fs.readdirSync(P.base);
  if (names.length && !exists(P.marker)) throw new Error("Demo base folder exists but is not an agent-desktop-demo folder: " + P.base);
  fs.writeFileSync(P.marker, "agent-desktop demo mode working folder; rebuilt at every launch\n");
  const keepUser = process.env.AGENT_DESKTOP_DEMO_KEEP === "1";
  // A file can be held open by a viewer (an opened report PDF): never throw for that, retry briefly, then carry on over the old copy.
  for (const d of [P.root, P.home, P.health].concat(keepUser ? [] : [P.userData])) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 }); } catch (e) { logProblem("could not clear " + d + ": " + (e && e.code)); }
  }
  for (const d of [P.root, P.home, P.health, P.userData]) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { logProblem("mkdir " + d + ": " + (e && e.code)); } }
}

let problemLog = null;
function logProblem(msg) { try { if (problemLog) fs.appendFileSync(problemLog, new Date().toISOString() + " " + msg + "\n"); } catch (e) { /* nothing more to do */ } }

function sub(text, vars) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

function usage(thread, n) {
  const ctx = thread.contextTokens || 38000;
  return { input_tokens: 40, cache_read_input_tokens: ctx - 2000 + n * 90, cache_creation_input_tokens: 1900, output_tokens: 320 };
}

// Real Claude-CLI-shaped transcript lines from a scripted thread.
function transcriptLines(thread, sessionId, now, vars) {
  const lines = [];
  const model = "claude-sonnet-5-5";
  const msgs = thread.messages || [];
  let n = 0;
  for (const m of msgs) {
    const ts = new Date(now - (m.minsAgo != null ? m.minsAgo : 5) * MIN).toISOString();
    n++;
    if (m.role === "user") {
      lines.push({ type: "user", origin: { kind: "human" }, sessionId, uuid: uuid(sessionId + n), timestamp: ts, message: { role: "user", content: sub(m.text, vars) } });
    } else {
      lines.push({ type: "assistant", sessionId, uuid: uuid(sessionId + n), timestamp: ts, message: { id: "msg_" + n, role: "assistant", model, content: [{ type: "text", text: sub(m.text, vars) }], stop_reason: "end_turn", usage: usage(thread, n) } });
    }
  }
  if (thread.tail === "working") {
    // A tool call still running: the agent reads as "working" (the pid file for this session points at the live app process).
    const ts = new Date(now - 40000).toISOString();
    lines.push({ type: "assistant", sessionId, uuid: uuid(sessionId + "tail"), timestamp: ts, message: { id: "msg_tail", role: "assistant", model, content: [{ type: "tool_use", id: "toolu_demo" + n, name: thread.tool || "WebSearch", input: {} }], stop_reason: "tool_use", usage: usage(thread, n + 1) } });
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function materialize(P, opts) {
  const now = (opts && opts.now) || Date.now();
  const livePid = (opts && opts.pid) || process.pid;
  const F = P.fixtures;
  if (!exists(path.join(F, "studio.json"))) throw new Error("Demo fixtures not found: " + F);
  wipe(P);
  const studio = readJson(path.join(F, "studio.json"));
  const vars = { REPORTS: VIRTUAL_REPORTS, BUSINESS: studio.business || "Aurora Studio", OWNER: studio.owner || "Maya" };
  const agentsDir = path.join(F, "agents");

  // ---- agents ----------------------------------------------------------------
  const agentPaths = {};
  for (const a of studio.agents) {
    const dir = path.join(P.root, a.folder);
    agentPaths[a.folder] = dir;
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    const sessionCwd = path.join(dir, ".claude-session");
    fs.mkdirSync(sessionCwd, { recursive: true });
    const src = path.join(agentsDir, a.folder);
    const av = path.join(src, "avatar.png");
    if (exists(av)) fs.copyFileSync(av, path.join(dir, "avatar.png"));
    writeJson(path.join(dir, "agent_config.json"), { display_name: a.name, role: a.role, avatar: exists(av) ? "avatar.png" : null, paused: false });
    const recent = (a.recent || []).map((t) => "- " + t).join("\n");
    writeText(path.join(dir, "master_state.md"),
      `# ${a.name} - state\n\n- **Status:** ${a.status}\n- **Health:** ${a.health || "Healthy"}\n- **Last Updated:** ${new Date(now).toISOString().slice(0, 10)}\n\n## Recent Tasks\n${recent}\n`);
    const ins = path.join(src, "instructions.md");
    writeText(path.join(dir, "CLAUDE.md"), exists(ins) ? sub(readText(ins), vars) : `# ${a.name}\n\n${a.role}\n`);
    // finished reports belong to the agent that wrote them
    for (const r of a.reports || []) {
      const pdf = path.join(F, "reports", r);
      if (!exists(pdf)) continue;
      fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
      try { fs.copyFileSync(pdf, path.join(dir, "reports", r)); } catch (e) { logProblem("copy report: " + (e && e.code)); }
    }

    // ---- the scripted transcript, in the place the CLI would have written it
    const tf = path.join(src, "thread.json");
    const thread = exists(tf) ? readJson(tf) : { messages: [] };
    const sessionId = uuid("session:" + a.folder);
    const projDir = path.join(P.home, ".claude", "projects", encodeProjectPath(sessionCwd));
    writeText(path.join(projDir, sessionId + ".jsonl"), transcriptLines(thread, sessionId, now, vars));
    // a pid file for every session: "working" agents keep working (the activity check cross-checks it), idle ones read "open, waiting"
    writeText(path.join(P.home, ".claude", "daemon", "pty-pids", sessionId.split("-")[0] + ".pid"), String(livePid));
  }

  // ---- sidebar groups ---------------------------------------------------------
  writeJson(path.join(P.root, "agent_groups.json"), {
    version: 1,
    groups: studio.groups.map((g, i) => ({ id: "g_demo" + i, name: g.name, color: g.color, parentId: null, order: i, members: g.members })),
  });

  // ---- task store (My Daily) ---------------------------------------------------
  const byAgent = {};
  for (const t of readJson(path.join(F, "daily", "tasks.json"))) (byAgent[t.agent] = byAgent[t.agent] || []).push(t);
  for (const [agent, items] of Object.entries(byAgent)) {
    writeJson(path.join(P.root, "shared_reports", "tasks", agent + ".json"), {
      schema: "agent-tasks/1", agent,
      items: items.map((t, i) => ({ id: t.id || `${agent.replace(/\W/g, "").slice(0, 3).toLowerCase()}${i + 1}`, title: t.title, detail: t.detail || "", status: t.status || "open", needsOwner: !!t.needsYou, priority: t.priority || 2, tags: t.tags || [], group: t.group || "", created: new Date(now - (t.daysAgo || 1) * DAY).toISOString() })),
    });
  }
  // ---- Library -----------------------------------------------------------------
  const regDir = path.join(P.root, "shared_registry");
  for (const e of readJson(path.join(F, "library", "entries.json"))) {
    const rec = Object.assign({}, e);
    if (rec.reportFile) {
      const owner = studio.agents.find((x) => (x.reports || []).includes(rec.reportFile));
      rec.link = path.join(P.root, owner ? owner.folder : "Research", "reports", rec.reportFile);
      delete rec.reportFile;
    }
    if (rec.imageFile) {
      const img = path.join(F, "images", rec.imageFile);
      const dest = path.join(P.root, "images", rec.imageFile);
      if (exists(img)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(img, dest); rec.link = dest; rec.thumbnail = dest; }
      delete rec.imageFile;
    }
    const upd = new Date(now - (rec.daysAgo != null ? rec.daysAgo : 1) * DAY).toISOString();
    delete rec.daysAgo;
    rec.createdAt = upd; rec.updatedAt = upd; rec.confirmedAt = upd; rec.status = rec.status || "active";
    writeJson(path.join(regDir, rec.id + ".json"), rec);
  }
  // ---- My Daily stores ----------------------------------------------------------
  const daily = path.join(P.root, "daily");
  const shop = readJson(path.join(F, "daily", "shopping.json"));
  writeJson(path.join(daily, "shopping.json"), { lists: shop.lists.map((l) => ({ id: l.id, name: l.name, items: l.items.map((text, i) => ({ id: l.id + "_i" + i, text, added: new Date(now - (i + 1) * 3600000).toISOString(), addedBy: shop.addedBy || "Maya" })) })) });
  const ship = readJson(path.join(F, "daily", "shipments.json"));
  writeJson(path.join(daily, "shipments.json"), {
    version: 1, scannedAt: now, polledAt: 0, lastError: "", demoDone: true,
    items: ship.items.map((s) => Object.assign({}, s, {
      stateAt: now - (s.stateDaysAgo || 1) * DAY, lastChangeAt: now - (s.stateDaysAgo || 1) * DAY, added: now - 4 * DAY,
      eta: new Date(now + (s.etaWeekday != null ? ((s.etaWeekday - new Date(now).getDay() + 7) % 7 || 7) : (s.etaInDays || 2)) * DAY).toISOString(),
      lastEvent: s.lastEvent ? Object.assign({}, s.lastEvent, { at: now - (s.stateDaysAgo || 1) * DAY }) : null,
    })),
  });
  const dts = readJson(path.join(F, "daily", "dates.json"));
  writeJson(path.join(daily, "dates.json"), { items: dts.items.map((d) => { if (d.inDays == null) return d; const t = new Date(now + d.inDays * DAY); return { id: d.id, title: d.title, kind: d.kind, month: t.getMonth() + 1, day: t.getDate() }; }) });
  writeJson(path.join(daily, "appointments.json"), { items: [] });

  // ---- usage header (statusline cache, exactly what the real one writes) --------
  const u = studio.usage || { sessionPct: 38, weekPct: 54 };
  const sec = (ms) => Math.round(ms / 1000);
  const rate = () => ({ updatedAt: new Date().toISOString(), fiveHourUsedPct: u.sessionPct, fiveHourResetsAt: sec(Date.now() + (u.sessionResetsInMin || 190) * MIN), sevenDayUsedPct: u.weekPct, sevenDayResetsAt: sec(Date.now() + (u.weekResetsInHours || 70) * 3600000) });
  const rateFile = path.join(P.home, ".claude", "agent-desktop-rate-limits.json");
  writeJson(rateFile, rate());

  // ---- My Health ------------------------------------------------------------------
  require("./healthData").build(P, F, now);

  return { studio, agentPaths, rateFile, rate, now };
}

module.exports = { materialize, encodeProjectPath, transcriptLines, uuid, sub, readJson, writeJson, writeText, exists };
