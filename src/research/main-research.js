// MY RESEARCH tab IPC registration (main process, v1.87.0). Cheap: handlers only; the service loads on the first call (first open of the view).
// Every research-* channel: only the main window's own frame may call it and an oversized argument is refused. The renderer never sends a
// path: it sends a week name ("2026-W41") and a finding's agent/title; the folder is fixed here. Sending a message to an agent is done in
// the renderer through the existing window.libraryBridge.send (the compose box's own path), so there is no research-ask channel.
// research-open opens one http(s) link from a digest's sources in the default browser (nothing else, no credentials in the URL).
// v1.89.0 research-write: "Write to <agent>" on a finding / an agent's week. Delivered through the SAME verified path as My Daily > Tasks
// (deliverToAgent + classifyDelivery, injected from main.js); an agent that is not running gets a pending note instead (research/write.js).
"use strict";
const path = require("path");
const fs = require("fs");
const MAX_ARG_CHARS = 2048;
const MAX_WRITE_ARG_CHARS = 12000;   // research-write only: the message itself may be up to 4000 characters (JSON escaping can double it)
const MAX_WRONG = 300;               // v1.91.0: "This image is wrong" marks kept in the prefs file
const THREAD_TAIL_BYTES = 256 * 1024; // v1.91.0 research-thread reads only the end of _writes.jsonl

function safeUrl(u) {
  if (typeof u !== "string" || u.length > 1000) return null;
  let p; try { p = new URL(u); } catch (e) { return null; }
  if ((p.protocol !== "https:" && p.protocol !== "http:") || p.username || p.password || !p.hostname) return null;
  return p.href;
}

function init({ ipcMain: raw, getMainWindow, workspaceRoot, userData, testMode, log, env, openExternal, deliverToAgent, classifyDelivery, resolveAgent, isAgentRunning, now, imageDeps, listAgents }) {
  const say = typeof log === "function" ? log : () => {};
  const e = env || process.env;
  let svc = null;
  // v1.121.0: locations come from the configuration (sharedReports, agentsRoot, outputRoots, ownerName); the sandbox keeps its own root + env overrides.
  const cfg = require("../appConfig");
  const reportsDir = () => require("../testGuard").workspaceDir("sharedReports", e) || (workspaceRoot ? path.join(workspaceRoot, "shared_reports") : null); // v1.121.0: test mode honours an explicitly set sharedReports (env, or a value inside the sandbox) like every other area
  const agentsBase = () => (testMode ? null : cfg.get("agentsRoot")) || workspaceRoot;
  // v1.121.0: not set up = no shared reports folder configured (the sandbox counts as set up when it was given a research folder or an explicit sharedReports)
  const needsSetup = () => {
    if (testMode && (e.AGENT_DESKTOP_RESEARCH_DIR || require("../testGuard").explicit("sharedReports", e))) return false;
    try { return !cfg.isReady("research"); } catch (x) { return false; }
  };
  const researchDir = () => (testMode && e.AGENT_DESKTOP_RESEARCH_DIR) || path.join(reportsDir(), "research");
  const service = () => (svc || (svc = require("./service").createService({ researchDir: researchDir(), log: say, gate: gateFor })));
  const handle = (channel, fn, maxChars) => raw.handle(channel, async (event, arg) => {
    try {
      const w = typeof getMainWindow === "function" ? getMainWindow() : null;
      const wc = w && !(typeof w.isDestroyed === "function" && w.isDestroyed()) ? w.webContents : null;
      if (!wc || !event || event.sender !== wc || (event.senderFrame && wc.mainFrame && event.senderFrame !== wc.mainFrame)) { say(channel + " refused: not the main window"); return { ok: false, reason: "Not allowed." }; }
      if (arg !== undefined && arg !== null) { let n; try { n = JSON.stringify(arg).length; } catch (x) { return { ok: false, reason: "Bad request." }; } if (n > (maxChars || MAX_ARG_CHARS)) return { ok: false, reason: "That request is too large." }; }
    } catch (x) { return { ok: false, reason: "Not allowed." }; }
    try { return await fn(arg); } catch (x) { say(channel + " failed: code=" + (x && x.code ? x.code : "unknown")); return { ok: false, reason: "That did not work." }; }
  });
  // the tab's own small prefs file (not localStorage): the finding that was opened last, so the view can mark where you were
  const prefsFile = () => path.join(userData, "research_prefs.json");
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  // v1.91.0: + view ("magazine" | "list") and imageWrong (a list of "week|agent|findingId" whose lead image the user marked wrong)
  const WEEK_RE = /^\d{4}-W\d{2}$/;
  const imgKey = (o) => (o && typeof o === "object" && WEEK_RE.test(o.week) && str(o.agent, 120).trim() && str(o.findingId, 120) ? o.week + "|" + str(o.agent, 120).trim().toLowerCase() + "|" + str(o.findingId, 120) : null);
  // atomic (temp file + rename), UTF-8 without BOM; returns false when it could not be written
  function writePrefs(obj) {
    const f = prefsFile(), tmp = f + "." + process.pid + "." + Date.now() + ".tmp";
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
      fs.renameSync(tmp, f);
      return true;
    } catch (x) { try { fs.unlinkSync(tmp); } catch (y) { /* ignore */ } return false; }
  }
  const readPrefs = () => { try { const j = JSON.parse(fs.readFileSync(prefsFile(), "utf8").replace(/^﻿/, "")); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch (x) { return {}; } };
  const wrongList = (j) => (Array.isArray(j.imageWrong) ? j.imageWrong.filter((x) => typeof x === "string" && x.length < 300).slice(-MAX_WRONG) : []);
  handle("research-prefs-get", () => {
    const j = readPrefs();
    const l = j.lastOpened;
    return { ok: true, prefs: { lastOpened: l && WEEK_RE.test(l.week) ? { week: l.week, agent: str(l.agent, 120), finding: str(l.finding, 300) } : null, legendOpen: j.legendOpen !== false, view: j.view === "list" ? "list" : "magazine", imageWrong: wrongList(j), agentFilter: str(j.agentFilter, 120) } };
  });
  handle("research-prefs-set", (a) => {
    const l = a && a.lastOpened;
    const v = l && WEEK_RE.test(l.week) && str(l.agent, 120) && str(l.finding, 300) ? { week: l.week, agent: str(l.agent, 120), finding: str(l.finding, 300) } : null;
    const lo = a && typeof a.legendOpen === "boolean" ? a.legendOpen : null;
    const view = a && (a.view === "list" || a.view === "magazine") ? a.view : null;
    const wrong = a && a.imageWrong ? imgKey(a.imageWrong) : null;
    const af = a && typeof a.agentFilter === "string" ? str(a.agentFilter, 120).trim() : null;   // v1.102.0 "Show: <agent>" filter ("" = all agents)
    if (!v && lo === null && !view && !wrong && af === null) return { ok: false, reason: "Bad request." };
    const cur = readPrefs();
    const wl = wrongList(cur);
    if (wrong && wl.indexOf(wrong) < 0) wl.push(wrong);
    const next = { lastOpened: v || cur.lastOpened || null, legendOpen: lo === null ? cur.legendOpen !== false : lo, view: view || (cur.view === "list" ? "list" : "magazine"), imageWrong: wl.slice(-MAX_WRONG), agentFilter: af === null ? str(cur.agentFilter, 120) : af };
    if (!writePrefs(Object.assign({}, cur, next))) return { ok: false, reason: "Not saved." };
    return { ok: true };
  });
  // ---- v1.107.0 unread badge. Pure rules in ./unread.js; the state (seen list, gatingStart) lives in research_prefs.json.
  // Every finding is shown; nothing waits for a picture. The art folders (fixed here, never from the renderer) are only used by research-image.
  const U = require("./unread");
  const sharedArtDir = () => (testMode && e.AGENT_DESKTOP_RESEARCH_ART_DIR) || path.join(reportsDir(), "research_art");
  const graphicsArtDir = () => (testMode && e.AGENT_DESKTOP_RESEARCH_ART_GRAPHICS_DIR) || path.join(agentsBase(), "Graphics Agent", "research_art");
  let artFinder = null;
  const art = () => (artFinder || (artFinder = require("./art").createArt({
    sharedDir: sharedArtDir(), graphicsDir: graphicsArtDir(), now,
    allowedRoots: testMode ? [sharedArtDir(), graphicsArtDir(), path.dirname(graphicsArtDir())]
      : [sharedArtDir(), graphicsArtDir(), path.join(agentsBase(), "Graphics Agent"), reportsDir()].concat((cfg.get("outputRoots") || []).map((r) => path.join(r, "Graphics Agent"))),
  })));
  const gateClock = () => (typeof now === "function" ? now() : Date.now());
  // one evaluation over every finding on disk; persists the grandfathering on the first call
  function evaluateAll() {
    const items = service().listAll();
    const res = U.evaluate({ items, state: readPrefs(), now: gateClock() });
    res.existing = new Set(items.map((x) => U.keyOf(x.week, x.agent, x.id)));
    if (res.changed) { const cur = readPrefs(); writePrefs(Object.assign({}, cur, res.state)); }
    return res;
  }
  function gateFor() {
    let res; try { res = evaluateAll(); } catch (x) { say("research unread failed: code=" + (x && x.code ? x.code : "unknown")); return null; }   // fail open: nothing flagged
    return { unread: res.unread, count: res.count, keyOf: U.keyOf };
  }
  const badgeInfo = () => { if (needsSetup()) return { ok: true, count: 0 }; const r = evaluateAll(); return { ok: true, count: r.count }; };
  handle("research-badge", () => badgeInfo());
  // research-seen {items:[{week, agent, findingId}]}: these findings were read. Only findings that exist right now are accepted.
  handle("research-seen", (a) => {
    const list = a && Array.isArray(a.items) ? a.items.slice(0, 60) : null;
    if (!list) return { ok: false, reason: "Bad request." };
    const keys = list.map((x) => imgKey(x)).filter(Boolean);
    const r = evaluateAll();
    const m = U.markSeen(readPrefs(), keys, r.existing);
    if (m.added) writePrefs(Object.assign({}, readPrefs(), { seen: m.state.seen }));
    return { ok: true, count: badgeInfo().count };
  }, 12000);
  handle("research-seen-all", () => {
    const r = evaluateAll();
    const m = U.markSeen(readPrefs(), [...r.unread], r.existing);
    if (m.added && !writePrefs(Object.assign({}, readPrefs(), { seen: m.state.seen }))) return { ok: false, reason: "Not saved." };
    return { ok: true, count: badgeInfo().count };
  });

  // v1.91.0 research-image {week, agent, findingId}: the finding's lead image from the on-disk cache (fetched once, in the background,
  // with the SSRF rules in research/images.js). The source URL is read from the digest here, never taken from the renderer.
  const imgFixturesDir = () => (testMode && e.AGENT_DESKTOP_RESEARCH_IMG_FIXTURES) || path.join(__dirname, "..", "..", "tests", "fixtures", "research-img");
  let images = null;
  const getImages = () => (images || (images = require("./images").createImageCache({
    dir: path.join(userData, "research_images"), testMode: !!testMode, log: say, now,
    fixturesDir: imgFixturesDir(),
    fixtures: testMode ? (() => { try { return JSON.parse(fs.readFileSync(path.join(imgFixturesDir(), "fixtures.json"), "utf8")); } catch (x) { return {}; } })() : {},
    deps: imageDeps,
  })));
  handle("research-image", async (a) => {
    const k = imgKey(a);
    if (!k) return { ok: false, reason: "Bad request." };
    if (wrongList(readPrefs()).indexOf(k) >= 0) return { ok: false, reason: "marked-wrong" };
    const f = service().findFinding(a.week, a.agent, a.findingId);
    if (!f) return { ok: false, reason: "unknown-finding" };
    // v1.107.0 order: the article's own picture first (cached, size-capped), then the picture Graphics made (a local file from the fixed
    // art folders), then nothing (the view draws the letter card)
    const source = require("./images").sourceUrlOf(f);
    let own = source ? await getImages().get({ week: a.week, source }) : { ok: false, reason: "no-source" };
    if (own && own.ok) return own;
    const mine = art().find(a.week, f.agent || a.agent, a.findingId);
    if (mine) return { ok: true, url: require("url").pathToFileURL(mine).href, domain: "AI-generated illustration", logo: false, w: 1200, h: 675, how: "art", art: true };
    return own;
  });
  // the agent name -> its folder name, cached for 60 s (resolveAgent scans the agent list on disk)
  const folderMemo = new Map();
  const clock = typeof now === "function" ? now : () => Date.now();
  function folderOf(agent) {
    const k = agent.toLowerCase(), hit = folderMemo.get(k);
    if (hit && clock() - hit.at < 60000) return hit.folder;
    let folder = "";
    try { const p = typeof resolveAgent === "function" ? resolveAgent(agent) : null; folder = typeof p === "string" ? path.basename(p).toLowerCase() : ""; } catch (x) { folder = ""; }
    if (folderMemo.size > 200) folderMemo.clear();
    folderMemo.set(k, { folder, at: clock() });
    return folder;
  }
  // v1.91.0 research-image-cancel: the tab closed, so image fetches still waiting for a slot give up
  handle("research-image-cancel", () => { if (images) images.cancel(); return { ok: true }; });
  // v1.91.0 research-thread {week, agent, findingId}: read-only, the last 5 things the user sent about this finding (from _writes.jsonl)
  handle("research-thread", (a) => {
    const k = imgKey(a);
    if (!k) return { ok: false, reason: "Bad request." };
    const fid = str(a.findingId, 120), agent = str(a.agent, 120).trim();
    const folder = folderOf(agent);
    const file = path.join(researchDir(), "_writes.jsonl");
    let text = "";
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) return { ok: true, items: [] };
      const fd = fs.openSync(file, "r");
      try { const n = Math.min(st.size, THREAD_TAIL_BYTES), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, st.size - n); text = buf.toString("utf8"); } finally { fs.closeSync(fd); }
    } catch (x) { return { ok: true, items: [] }; }
    const items = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch (x) { continue; }
      if (!j || typeof j !== "object" || Array.isArray(j) || j.week !== a.week || j.finding !== fid) continue;   // every field type-checked: a hostile line is skipped
      const ag = typeof j.agent === "string" ? j.agent.toLowerCase() : "";
      if (!ag || (ag !== agent.toLowerCase() && (!folder || ag !== folder))) continue;
      items.push({ time: str(j.time, 40), text: str(j.text, 300), delivery: str(j.delivery, 20) });
    }
    return { ok: true, items: items.slice(-5) };
  });
  handle("research-load", (a) => (needsSetup() ? { ok: false, reason: "needs-setup", needsSetup: true } : service().load(a)));
  handle("research-mark", (a) => service().mark(a));
  handle("research-idea", (a) => service().addIdea(a));
  handle("research-export", (a) => service().exportSummary(a && a.week));
  handle("research-open", (a) => {
    const u = safeUrl(a && a.url);
    if (!u) return { ok: false, reason: "That link is not allowed." };
    if (typeof openExternal !== "function") return { ok: false, reason: "Not available." };
    openExternal(u);
    return { ok: true };
  });
  let writer = null;
  const getWriter = () => (writer || (writer = require("./write").createWriter({
    researchDir: researchDir(), root: workspaceRoot, owner: () => cfg.get("ownerName"), log: say, now,
    findRef: (week, agent, fid) => (typeof fid === "string" && fid.startsWith("rec:") ? recsSvc().findRef(week, agent, fid) : service().findRef(week, agent, fid)),   // v1.133.0: one writer (one rate limit + duplicate check) for findings and recommendations
    resolveAgent, isRunning: isAgentRunning,
    // v1.141.0: hiddenAgents setting (src/hiddenAgents.js); a hidden agent never gets a live delivery from here, only its pending notes
    isHidden: (folder) => { try { return require("../hiddenAgents").isHidden({ folderName: folder }, require("../hiddenAgents").parse(e.AGENT_DESKTOP_HIDDEN_AGENTS || cfg.get("hiddenAgents"))); } catch (x) { return false; } },
    // no delivery function (should not happen in the app): report a dry result, which classifies as "failed" with a plain reason
    deliver: typeof deliverToAgent === "function" ? deliverToAgent : () => Promise.resolve({ delivered: false, dry: true }),
    classify: typeof classifyDelivery === "function" ? classifyDelivery : null,
  })));
  handle("research-write", (a) => getWriter().write(a), MAX_WRITE_ARG_CHARS);
  // v1.133.0 MY RECOMMENDATIONS (inside My Research): read-only async load of shared_reports recommendations + coo weekly; replies go through the one shared writer
  let recs = null;
  const recsSvc = () => (recs || (recs = require("../recommendations/service").createService({
    recDir: path.join(reportsDir(), "recommendations"), cooDir: path.join(reportsDir(), "coo"), log: say })));
  handle("recs-load", async (a) => {
    if (needsSetup()) return { ok: false, reason: "needs-setup", needsSetup: true };
    const r = await recsSvc().load({ all: !!(a && a.all) });
    const raw = await recsSvc().replied(path.join(researchDir(), "_writes.jsonl"));
    // the writer logs the agent FOLDER name; the digests are keyed by their file name: map folder -> file name so the Replied chip matches
    const byFolder = new Map();
    r.weeks.forEach((w) => w.agents.forEach((ag) => { const f = folderOf(ag.agent); if (f) byFolder.set(f, ag.agent.toLowerCase()); }));
    r.replied = {};
    Object.keys(raw).forEach((k) => { const p = k.split("|"); p[1] = byFolder.get(p[1]) || p[1]; r.replied[p.join("|")] = raw[k]; });
    return r;
  });
  handle("recs-write", (a) => {
    const x = a && typeof a === "object" ? a : {};
    return getWriter().write({ week: x.week, agent: x.agent, findingId: typeof x.itemId === "string" ? "rec:" + x.itemId.slice(0, 116) : "", text: x.text });
  }, MAX_WRITE_ARG_CHARS);
  // v1.139.0 SKILLS & PLUGINS (inside My Research): read-only async load of the weekly skills watch (rotation, findings, places, pinned copies).
  // Verdicts are only READ here (recommendations\<week>\<agent>.json, written by ARGUS's buttons); this tab writes nothing.
  let skills = null;
  const skillsSvc = () => (skills || (skills = require("../skills/service").createService({
    researchDir: researchDir(), recDir: path.join(reportsDir(), "recommendations"), now,
    skillsDir: (() => { const t = require("../testGuard").workspaceDir("sharedTools", e); return t ? path.join(t, "skills") : null; })(), log: say })));
  // v1.141.0: the agents Agent Desktop knows (folder + display name; hidden agents too, they are valid rotation agents). Names only, no paths.
  const knownAgents = () => { try { return (typeof listAgents === "function" ? listAgents() : []).filter((a) => a && typeof a.folderName === "string").map((a) => ({ folderName: a.folderName, displayName: typeof a.displayName === "string" ? a.displayName : a.folderName })); } catch (x) { return []; } };
  handle("skills-load", async (a) => {
    if (needsSetup()) return { ok: false, reason: "needs-setup", needsSetup: true };
    const r = await skillsSvc().load({ week: a && typeof a.week === "string" ? a.week.slice(0, 10) : "" });
    if (r && r.ok) r.knownAgents = knownAgents();
    return r;
  });
  // v1.141.0 skills-rotation-set {agents:[names], expected:[the list the tab showed]}: change WHO looks this week (src/skills/rotationWrite.js).
  handle("skills-rotation-set", async (a) => {
    if (needsSetup()) return { ok: false, reason: "needs-setup", needsSetup: true };
    const x = a && typeof a === "object" ? a : {};
    const r = await require("../skills/rotationWrite").setAgents({ file: path.join(researchDir(), "skills_plugins_rotation.json"), agents: x.agents, expected: x.expected, known: knownAgents(), now: typeof now === "function" ? now() : Date.now() });
    say("skills-rotation-set: " + (r.ok ? "saved " + r.agents.length + " agents" : "refused"));
    if (r.ok) { const S = require("../skills/service"); r.nextRunAt = S.nextRun(S.parseSchedule(r.schedule), typeof now === "function" ? now() : Date.now()); }
    return r;
  }, 8192);
  // flushImages: called from main.js on before-quit so a fetch just before quitting keeps its index entry
  return { service, writer: getWriter, images: getImages, flushImages: () => { if (images) images.close(); } };   // sweep + write at quit
}

module.exports = { init, safeUrl };
