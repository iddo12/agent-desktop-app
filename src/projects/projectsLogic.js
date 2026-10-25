// Projects tab: pure rules, no I/O (Project Autopilot, 2026-10-23). Turns the ledger (shared_tools\projects\project.py:
// project.json + events.jsonl) into the view models the Projects screens draw. `derive()` is a FAITHFUL PORT of derive() in project.py
// (a cross-check test runs `python project.py show` and compares). Everything else here (burn-up, projection, lateness, light, sorting) is view-only
// and is never written back. Spend is shown as a % of the weekly allowance, never dollars. Every number carries `what` (the list it counts) and `at`
// (when its data last changed) so the screen can link and date it.
"use strict";

const DAY = 86400000;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const clip = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "").slice(0, n) : "");
const SLUG_OK = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const QID_OK = /^Q\d{1,6}$/;

// ---- Python-compatible rounding (Python 3 round() is banker's rounding on exact halves; Math.round is not) ----
function pyRound(x, nd) {
  const f = Math.pow(10, nd || 0), y = x * f, r = Math.round(y);
  if (Math.abs(y % 1) === 0.5) return (2 * Math.round(y / 2)) / f;   // exact tie: to even
  return nd ? Number((r / f).toFixed(nd)) : r;
}

// ---- time helpers ----
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const nowMs = (now) => (now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now || "") || Date.now());
function ageText(iso, now) {
  const t = ms(iso); if (t == null) return "";
  const s = Math.max(0, Math.round((nowMs(now) - t) / 1000));
  if (s < 90) return s < 10 ? "just now" : s + " s ago";
  const m = Math.round(s / 60); if (m < 90) return m + " min ago";
  const h = Math.round(m / 60); if (h < 36) return h + " h ago";
  return Math.round(h / 24) + " d ago";
}
// "YYYY-MM-DD" (planned_date) -> end of that local day, ms. Null when not a date.
function planEnd(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || "")); if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59).getTime();
}
function dayText(t) { if (t == null) return ""; const d = new Date(t); return MONTH[d.getMonth()] + " " + d.getDate(); }
function dateTimeText(iso) { const t = ms(iso); if (t == null) return ""; const d = new Date(t); return WEEKDAY[d.getDay()] + " " + d.getDate() + " " + MONTH[d.getMonth()] + ", " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }

// ---------------------------------------------------------------- faithful port of project.py ----------------------------------------------------------------
function taskState(p, t) {
  if (["done", "verified", "claimed", "blocked"].includes(t.status)) return t.status;
  const byid = {}; for (const x of p.tasks) byid[x.id] = x;
  for (const d of t.after || []) { const s = (byid[d] || {}).status; if (s !== "done" && s !== "verified") return "waiting"; }
  return "ready";
}

// p = project.json object, evs = events (array of objects, oldest first). Returns the same dict as project.py derive().
function derive(p, evs) {
  const ts = p.tasks || [], questions = p.questions || [], mss = p.milestones || [], budget = p.budget || {}; evs = evs || [];
  const states = {}; for (const t of ts) states[t.id] = taskState(p, t);
  const done = Object.values(states).filter((s) => s === "done" || s === "verified").length;
  const out = [];
  for (const m of mss) {
    const items = m.done_checklist || [];
    const ticked = items.filter((i) => i.done).length;
    const mt = ts.filter((t) => t.milestone === m.id);
    const mdone = mt.filter((t) => states[t.id] === "done" || states[t.id] === "verified").length;
    const total = items.length + mt.length;
    out.push({ id: m.id, title: m.title, planned_date: m.planned_date === undefined ? null : m.planned_date, pct: total ? pyRound((100 * (ticked + mdone)) / total, 0) : 0 });
  }
  const openQ = questions.filter((q) => q.status === "open");
  const blockers = ts.filter((t) => t.status === "blocked").map((t) => ({ task: t.id, reason: t.block_reason || "", needs: t.block_needs || "agent", since: t.block_ts === undefined ? null : t.block_ts }));
  blockers.sort((a, b) => ((a.since || "") < (b.since || "") ? -1 : (a.since || "") > (b.since || "") ? 1 : 0));
  const spent = pyRound(evs.filter((e) => e.kind === "cost").reduce((s, e) => s + (e.pct_week || 0), 0), 3);
  const last = evs.length ? evs[evs.length - 1].ts : p.created;
  let red = null;
  if (blockers.some((b) => b.needs === "iddo")) red = blockers.find((b) => b.needs === "iddo").reason;
  else if (openQ.length && openQ.some((q) => q.irreversible)) red = openQ[0].text;
  else if (budget.pct_of_week && spent >= budget.pct_of_week) red = "budget used up";
  const light = red ? "red" : (blockers.length || openQ.length ? "amber" : "green");
  const pyOr = (v) => (v === undefined ? null : v);
  return { slug: p.slug, name: p.name, owner: p.owner, status: p.status, tasks_total: ts.length, tasks_done: done, milestones: out,
    ready: ts.filter((t) => states[t.id] === "ready").map((t) => t.id), blockers, open_questions: openQ, spent_pct_week: spent,
    budget_pct_week: pyOr(budget.pct_of_week), last_activity: last, light, red_reason: red };
}

// ---------------------------------------------------------------- view-only layer ----------------------------------------------------------------
// One "unit" = one thing that can be done: a task, or a done-checklist item. Same units the python derive() counts for milestone %.
function unitsOf(p, states) {
  const planFinish = Math.max(0, ...(p.milestones || []).map((m) => planEnd(m.planned_date) || 0)) || null;
  const u = [];
  for (const m of p.milestones || []) {
    (m.done_checklist || []).forEach((i, idx) => u.push({ kind: "check", ms: m.id, ref: m.id + "[" + idx + "]", text: clip(String(i.text || ""), 200), done: !!i.done, at: i.done ? ms(i.verified_at) : null, by: clip(String(i.verified_by || ""), 80), plan: planEnd(m.planned_date) || planFinish }));
  }
  for (const t of p.tasks || []) {
    const m = (p.milestones || []).find((x) => x.id === t.milestone);
    const d = states[t.id] === "done" || states[t.id] === "verified";
    u.push({ kind: "task", ms: t.milestone || null, ref: t.id, text: clip(String(t.title || ""), 200), done: d, state: states[t.id], at: d ? (ms(t.done_ts) || ms(t.verified_ts) || ms(t.created)) : null, by: clip(String(t.done_by || t.owner || ""), 80), plan: (m && planEnd(m.planned_date)) || planFinish });
  }
  return { units: u, planFinish };
}

// planned units done by time t: linear from (created, 0) through each milestone's planned end (cumulative units of milestones planned by then)
function planCurve(units, start, total) {
  const dates = [...new Set(units.map((x) => x.plan).filter((x) => x != null))].sort((a, b) => a - b);
  const pts = [{ t: start, v: 0 }];
  for (const d of dates) pts.push({ t: Math.max(d, start), v: units.filter((x) => x.plan != null && x.plan <= d).length });
  return pts;                                                  // units with no plan date are simply not planned
}
function planAt(pts, t) {
  if (pts.length < 2) return 0;
  if (t <= pts[0].t) return 0;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) { const a = pts[i - 1], b = pts[i], span = b.t - a.t; return span <= 0 ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / span; }
  }
  return pts[pts.length - 1].v;
}

// Burn-up, pace of the LAST 3 DAYS (decided 2026-09-04/10-23): done units in the window / window days. A project younger than 3 days uses its own age (at least half a day).
function burnup(p, units, planFinish, now) {
  const n = nowMs(now), start = ms(p.green_lit_at) || ms(p.created) || n, total = units.length;
  const doneU = units.filter((x) => x.done), doneN = doneU.length;
  const plan = planCurve(units, start, total);
  const actual = [{ t: start, v: 0 }]; let c = 0;
  for (const x of doneU.filter((x) => x.at != null).sort((a, b) => a.at - b.at)) { c++; actual.push({ t: Math.max(x.at, start), v: c }); }
  actual.push({ t: n, v: doneN });
  const win = Math.min(3, Math.max((n - start) / DAY, 0.5));
  const recent = doneU.filter((x) => x.at != null && x.at > n - win * DAY && x.at <= n).length;
  const pace = recent / win;                                   // units per day
  let finish = null, state = "no_pace";
  if (!total) state = "empty";
  else if (doneN >= total) { finish = Math.max(...doneU.map((x) => x.at || start)); state = "done"; }
  else if (pace > 0) { finish = n + ((total - doneN) / pace) * DAY; state = "projected"; }
  const proj = state === "projected" ? [{ t: n, v: doneN }, { t: finish, v: total }] : [];
  let lateDays = 0;
  if (planFinish != null && state !== "done" && state !== "empty") {
    const ref = state === "projected" ? finish : n;            // no pace yet: late only once the plan date has passed
    lateDays = Math.max(0, Math.ceil((ref - planFinish) / DAY));
  }
  const plannedNow = Math.round(planAt(plan, n));
  return { total, done: doneN, plannedNow, planPct: total ? Math.round((100 * planAt(plan, n)) / total) : 0, donePct: total ? pyRound((100 * doneN) / total, 0) : 0,
    plan, actual, projection: proj, start, now: n, end: Math.max(planFinish || 0, finish || 0, n) + DAY, pace: Math.round(pace * 100) / 100, paceWindowDays: Math.round(win * 10) / 10,
    state, finish, planFinish, lateDays, late: lateDays >= 1 };
}

const RANK = { red: 0, amber: 1, draft: 2, green: 3, done: 4, cancelled: 5 };

// Builds one project's whole view model. input = { project, events, truncated? }.
function viewOf(input, now) {
  const p = input.project, evs = input.events || [];
  const d = derive(p, evs), n = nowMs(now);
  const states = {}; for (const t of p.tasks || []) states[t.id] = taskState(p, t);
  const { units, planFinish } = unitsOf(p, states);
  const b = burnup(p, units, planFinish, n);
  const status = p.status, active = status === "active", draft = status === "draft";
  const oldestBlock = d.blockers.length ? d.blockers[0].since : null;
  let light = d.light, label, reason, labelKind;
  if (status === "done") { light = "green"; label = "DONE"; labelKind = "done"; reason = "Finished."; }
  else if (status === "cancelled") { light = "grey"; label = "CANCELLED"; labelKind = "cancelled"; reason = "Cancelled."; }
  else if (draft) { light = "amber"; label = "DRAFT · NOT STARTED"; labelKind = "draft"; reason = "Waiting for your Green light."; }
  else if (light === "red") { label = "BLOCKED"; labelKind = "red"; reason = "Blocked: " + clip(d.red_reason || "needs you", 240); }
  else if (b.late) { light = "amber"; label = "LATE · " + b.lateDays + (b.lateDays === 1 ? " DAY" : " DAYS"); labelKind = "late"; reason = b.state === "projected" ? "Finish moved from " + dayText(planFinish) + " to " + dayText(b.finish) + "." : "Plan date " + dayText(planFinish) + " has passed."; }
  else if (light === "amber") { label = "WAITING"; labelKind = "amber"; reason = d.open_questions.length ? "Waiting for an answer: " + clip(d.open_questions[0].text, 200) : "A task is blocked: " + clip(d.blockers[0] ? d.blockers[0].reason : "", 200); }
  else { label = "MOVING"; labelKind = "green"; reason = b.state === "projected" ? "On plan. Finish expected " + dayText(b.finish) + (planFinish != null ? " (plan: " + dayText(planFinish) + ")." : ".") : b.state === "no_pace" ? "No pace yet: nothing finished in the last " + b.paceWindowDays + " days." : "On plan."; }
  const lastEv = evs.length ? evs[evs.length - 1] : null;
  const budgetPct = d.budget_pct_week, spent = d.spent_pct_week;
  const tokenPct = budgetPct ? pyRound((100 * spent) / budgetPct, 0) : null;
  const costEvents = evs.filter((e) => e.kind === "cost").map((e) => ({ ts: e.ts, text: clip(String(e.text || ""), 160), pct_week: e.pct_week || 0 }));
  const stuckSince = light === "red" ? (oldestBlock || (d.open_questions[0] && d.open_questions[0].asked) || null) : null;
  const msView = d.milestones.map((m) => {
    const mu = units.filter((x) => x.ms === m.id);
    const dn = mu.filter((x) => x.done), total = mu.length;
    const doneAt = total && dn.length === total ? Math.max(...dn.map((x) => x.at || 0)) : null;
    const pl = planEnd(m.planned_date);
    const state = total && dn.length === total ? "done" : null;
    return { id: m.id, title: clip(m.title, 160), planned_date: m.planned_date, planned: pl != null ? dayText(pl) : "", pct: m.pct, done: dn.length, total, state, doneAt: doneAt ? dayText(doneAt) : "",
      overdue: !state && pl != null && pl < n, items: mu.map((x) => ({ kind: x.kind, ref: x.ref, text: x.text, done: x.done, by: x.by, at: x.at, state: x.state || null })) };
  });
  const firstOpen = msView.find((m) => !m.state); if (firstOpen) firstOpen.state = firstOpen.overdue ? "late" : "active";
  for (const m of msView) if (!m.state) m.state = "pending";
  const questions = d.open_questions.map((q) => ({ id: q.id, text: clip(q.text, 400), default: clip(String(q.default || ""), 200), deadline: q.deadline || null, deadlineText: dateTimeText(q.deadline), askedBy: clip(q.asked_by || "", 80), asked: q.asked || null, askedAge: ageText(q.asked, n),
    irreversible: !!q.irreversible, autoApplies: !q.irreversible && active }));
  const waiting = d.blockers.filter((x) => x.needs === "iddo").map((x) => ({ task: x.task, reason: clip(x.reason, 300), since: x.since }));
  const nMs = d.milestones.length;
  const curMs = firstOpen ? d.milestones.findIndex((m) => m.id === firstOpen.id) + 1 : nMs;
  const planLine = b.planPct ? " (plan: " + b.planPct + "%)" : "";
  const unitsDone = units.filter((x) => x.done), unitsOpen = units.filter((x) => !x.done);
  const what = (list) => list.map((x) => ({ text: (x.kind === "task" ? x.ref + " · " : "") + x.text, done: x.done, at: x.at }));
  const card = {
    slug: d.slug, name: clip(d.name, 120), owner: clip(d.owner, 80), ownerShort: clip(String(d.owner || "").replace(/\s+(Agent|& .*)$/i, "").trim(), 40), status, light, label, labelKind, reason,
    donePct: b.donePct, planPct: b.planPct, milestoneNote: "done · M" + curMs + " of " + nMs + planLine,
    tokenPct, budgetPctWeek: budgetPct, spentPctWeek: spent, stuckDays: stuckSince ? Math.max(1, Math.round((n - (ms(stuckSince) || n)) / DAY)) : null,
    questions: questions.length, lastActivity: d.last_activity, lastAge: ageText(d.last_activity, n), lastText: lastEv ? clip(String(lastEv.text || ""), 140) : "", lastBy: lastEv ? clip(String(lastEv.agent || ""), 60) : "",
    finishText: b.finish != null ? dayText(b.finish) : "", planFinishText: planFinish != null ? dayText(planFinish) : "", rank: RANK[draft ? "draft" : status === "done" ? "done" : status === "cancelled" ? "cancelled" : light] };
  const nums = {
    done: { value: b.donePct + "%", at: d.last_activity, what: what(unitsDone), empty: "Nothing done yet.", label: "done" },
    open: { value: String(unitsOpen.length), at: d.last_activity, what: what(unitsOpen), empty: "Nothing left.", label: "still to do" },
    tokens: { value: tokenPct == null ? "-" : tokenPct + "%", at: costEvents.length ? costEvents[costEvents.length - 1].ts : null, label: "of token budget",
      sub: budgetPct ? spent + "% of the week used, budget " + budgetPct + "% of the week" : "no budget set", what: costEvents.map((e) => ({ text: e.pct_week + "% of the week · " + e.text, at: ms(e.ts) })), empty: "No cost events logged yet." },
  };
  const recent = evs.slice(-12).reverse().map((e) => ({ ts: e.ts, age: ageText(e.ts, n), agent: clip(String(e.agent || ""), 60), kind: clip(String(e.kind || ""), 20), text: clip(String(e.text || ""), 200) }));
  const titleOf = {}; for (const t of p.tasks || []) titleOf[t.id] = clip(String(t.title || ""), 200);
  const readyTasks = d.ready.slice(0, 50).map((id) => ({ id, title: titleOf[id] || "" }));
  const blockedTasks = d.blockers.slice(0, 50).map((x) => ({ id: x.task, title: titleOf[x.task] || "", reason: clip(x.reason, 300), needs: clip(String(x.needs || ""), 40), since: x.since || null, sinceAge: ageText(x.since, n) }));
  const detail = Object.assign({}, card, { readyTasks, blockedTasks, milestones: msView, questions, waiting, burnup: b, numbers: nums, planFinish, finish: b.finish, finishState: b.state, lateDays: b.lateDays, recent,
    budget: { pct: budgetPct, signedBy: clip(String((p.budget || {}).signed_by || ""), 120), signedAt: (p.budget || {}).signed_at || null, signed: !!(p.budget || {}).signed_by },
    canGreenLight: draft && !!(p.budget || {}).signed_by, charterPath: clip(String(p.charter_path || ""), 400), planned: b.total, truncated: !!input.truncated });
  return { card, detail, derived: d };
}

// List view: red first, then amber (draft counts as amber), then green, finished last; inside a group the newest activity first.
function listView(inputs, now) {
  const views = inputs.map((i) => viewOf(i, now).card);
  views.sort((a, b) => a.rank - b.rank || ((ms(b.lastActivity) || 0) - (ms(a.lastActivity) || 0)) || (a.slug < b.slug ? -1 : 1));
  const open = views.filter((v) => v.status !== "done" && v.status !== "cancelled");
  const counts = { green: open.filter((v) => v.light === "green").length, amber: open.filter((v) => v.light === "amber").length, red: open.filter((v) => v.light === "red").length, total: open.length, finished: views.length - open.length };
  return { projects: views, counts, loadedAt: new Date(nowMs(now)).toISOString() };
}

// ---------------------------------------------------------------- disk (injected fs, read-only) ----------------------------------------------------------------
const MAX_JSON = 4 * 1024 * 1024, MAX_EVENTS = 8 * 1024 * 1024;
function readEvents(fs, file, opts) {
  let txt; let truncated = false;
  try { withRetry(() => { const st = fs.statSync(file); if (!st.isFile()) { txt = ""; return; }
    if (st.size > MAX_EVENTS) { truncated = true; const fd = fs.openSync(file, "r"); try { const buf = Buffer.alloc(MAX_EVENTS); fs.readSync(fd, buf, 0, MAX_EVENTS, st.size - MAX_EVENTS); txt = buf.toString("utf8"); const nl = txt.indexOf("\n"); txt = nl >= 0 ? txt.slice(nl + 1) : ""; } finally { fs.closeSync(fd); } }
    else txt = fs.readFileSync(file, "utf8"); }, opts); } catch (e) { return { events: [], truncated: false }; }
  const events = [];
  for (const ln of txt.split(/\r?\n/)) { if (!ln) continue; try { const o = JSON.parse(ln); if (o && typeof o === "object") events.push(o); } catch (e) { /* skip a damaged line, like project.py */ } }
  return { events, truncated };
}
// Dropbox can hold a file for a moment (sharing violation, half-synced JSON): a failed read or parse is retried a few times, a missing file is not.
const sleepMs = (n) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n); } catch (e) { /* no wait available */ } };
function withRetry(fn, o) {
  const tries = (o && o.retries != null ? o.retries : 3), wait = o && o.waitMs != null ? o.waitMs : 60, sl = (o && o.sleep) || sleepMs;
  let last = null;
  for (let i = 0; i <= tries; i++) {
    try { return fn(); } catch (e) { last = e; if (e && e.code === "ENOENT") break; if (i < tries) sl(wait * (i + 1)); }
  }
  throw last;
}
// Returns { project, events, truncated } or null. The slug is checked, so the renderer can never point us at another folder.
function readProject(fs, path, root, slug, opts) {
  if (!SLUG_OK.test(String(slug || "")) || !root) return null;
  const dir = path.join(root, slug), f = path.join(dir, "project.json");
  try {
    const p = withRetry(() => {
      const st = fs.statSync(f); if (!st.isFile() || st.size > MAX_JSON) return null;
      return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
    }, opts);
    if (!p || typeof p !== "object" || p.slug !== slug) return null;
    for (const k of ["milestones", "tasks", "questions"]) if (!Array.isArray(p[k])) p[k] = [];
    if (!p.budget || typeof p.budget !== "object") p.budget = {};
    const ev = readEvents(fs, path.join(dir, "events.jsonl"), opts);
    return { project: p, events: ev.events, truncated: ev.truncated };
  } catch (e) { return null; }
}
function listSlugs(fs, root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && SLUG_OK.test(e.name)).map((e) => e.name).sort().slice(0, 200); } catch (e) { return null; }
}
// `cache` (optional Map slug -> last good input): when a project.json that exists cannot be read right now, the last good copy is shown rather than a vanished card.
function loadAll(fs, path, root, now, cache, opts) {
  const slugs = listSlugs(fs, root); if (slugs == null) return null;
  const inputs = [];
  for (const s of slugs) {
    let i = readProject(fs, path, root, s, opts);
    if (i && cache) cache.set(s, i);
    else if (!i && cache && cache.has(s)) { let there = false; try { there = fs.statSync(path.join(root, s, "project.json")).isFile(); } catch (e) { /* gone */ } if (there) i = cache.get(s); else cache.delete(s); }
    if (i) inputs.push(i);
  }
  return listView(inputs, now);
}
// Draft's conversation (intake.md, optional, read-only, clipped)
function readIntake(fs, path, root, slug) {
  if (!SLUG_OK.test(String(slug || ""))) return "";
  try { const f = path.join(root, slug, "intake.md"); const st = fs.statSync(f); if (!st.isFile()) return ""; return clip(fs.readFileSync(f, "utf8").slice(-20000), 20000); } catch (e) { return ""; }
}

module.exports = { derive, taskState, viewOf, listView, burnup, ageText, dayText, pyRound, readProject, readEvents, listSlugs, loadAll, withRetry, readIntake, SLUG_OK, QID_OK, clip };
