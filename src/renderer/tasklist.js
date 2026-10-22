// Task List view (Option A of the UI-UX mockup: one list grouped by what needs attention, agent filter, big counts, Live dot,
// "Clear finished" with a 10 s Undo). All text is set with textContent (agents write the task text). Rules live in src/tasklist/.
(function () {
  "use strict";
  const api = window.api && window.api.tasklist;
  if (!api) return;
  const G = [["needs_you", "⚠ Needs you", "Needs you"], ["stuck", "◼ Stuck", "Stuck"], ["working", "▶ Working on it", "Working"], ["not_started", "○ Not started", "Not started"], ["finished", "✓ Finished", "Finished"]];
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // The standalone Task List app runs this same file: it sets window.TASKLIST_STANDALONE (no Escape-to-close) and may add ?compact=1 (second-monitor layout).
  const standalone = !!window.TASKLIST_STANDALONE;
  const view = el("div"); view.id = "tasklist-view"; view.className = "hidden" + (/[?&]compact=1\b/.test(String(location.search)) ? " tl-compact" : "");
  const head = el("div", "tl-head"), stats = el("div", "tl-stats"), body = el("div", "tl-body"), undoBar = el("div", "tl-undo hidden");
  undoBar.setAttribute("role", "status");
  view.append(head, stats, body, undoBar);
  document.getElementById("main-panel").appendChild(view);

  const S = { data: null, agent: "all", err: "", live: false, lastAt: 0, busy: false, undoTimer: null, undoAgent: null, show: {} };
  let open = false, navEl = null, poll = null, tick = null;

  function refresh() {
    return api.load(S.agent).then((r) => {
      if (!open) return;
      if (!r || !r.ok) { S.err = (r && r.reason) || "The task list could not load."; S.data = null; S.live = false; }
      else { S.err = ""; S.data = r; S.live = true; S.lastAt = Date.now(); if (window.tasklistNavCount) window.tasklistNavCount(r.counts.needs_you); }
      render();
    }).catch(() => { S.live = false; S.err = "The task list could not load."; render(); });
  }
  const ago = () => { const s = Math.max(0, Math.round((Date.now() - S.lastAt) / 1000)); return s < 5 ? "just now" : s < 90 ? s + " s ago" : Math.round(s / 60) + " min ago"; };

  function render() {
    head.textContent = ""; stats.textContent = ""; body.textContent = "";
    head.append(el("h2", "tl-title", "Task List"));
    const dot = el("span", "tl-live " + (S.live ? "on" : "off"), S.live ? "● Live" : "○ Paused"); dot.title = S.live ? "Updated " + ago() : "Not updating. Close and open the Task List.";
    head.append(dot, el("span", "tl-ago", S.live ? "updated " + ago() : ""), el("span", "tl-sp"));
    if (S.err) { body.append(el("p", "tl-note", S.err)); return; }
    if (!S.data) { body.append(el("p", "tl-note", "Loading…")); return; }
    const d = S.data, c = d.counts;
    const sel = el("select", "tl-pick"); sel.setAttribute("aria-label", "Which agent");
    const all = el("option", "", "All agents"); all.value = "all"; sel.append(all);
    for (const a of d.agents) { const o = el("option", "", a.agent); o.value = a.agent; sel.append(o); }
    sel.value = S.agent; sel.addEventListener("change", () => { S.agent = sel.value; S.show = {}; refresh(); });
    const clr = el("button", "tl-btn", "Clear finished" + (c.finished ? " (" + c.finished + ")" : "")); clr.type = "button"; clr.disabled = !c.finished || S.busy || !d.canWrite;
    clr.addEventListener("click", () => {
      S.busy = true; api.clear(S.agent).then((r) => { S.busy = false; if (r && r.ok && r.batch) showUndo(r.batch); else if (r && r.ok) say("Nothing to clear."); else say((r && r.reason) || "That did not work."); refresh(); }).catch(() => { S.busy = false; });
    });
    head.append(sel, clr);
    const isAll = S.agent === "all", autoOn = isAll ? d.auto.global : !!(d.auto.agent || d.auto.global);
    const lab = el("label", "tl-auto"); const cb = el("input"); cb.type = "checkbox"; cb.checked = autoOn; cb.disabled = !d.canWrite || (!isAll && d.auto.global);
    lab.append(cb, document.createTextNode(isAll ? " Every agent always continues to its next task, even after a handoff" : " This agent always continues to its next task, even after a handoff" + (d.auto.global ? " (on for everyone)" : "")));
    lab.title = "When on, an agent that fills its memory and restarts goes straight on to its next task without waiting for you. Tasks that need you are skipped.";
    cb.addEventListener("change", () => { cb.disabled = true; api.auto(S.agent, cb.checked).then((r) => { if (!r || !r.ok) say((r && r.reason) || "That did not work."); refresh(); }).catch(() => refresh()); });
    stats.before(lab);
    const stat = (n, label, cls, y) => { const b = el("div", "tl-stat " + cls); b.append(el("b", "tl-n", String(n)), el("span", "tl-l", label + (y != null ? " (yesterday " + y + ")" : ""))); stats.append(b); };
    stat(c.needs_you, "Need you", "amber"); stat(c.stuck, "Stuck", "red"); stat(c.working, "Working", "blue"); stat(c.not_started, "Not started", "grey"); stat(c.doneToday, "Done today", "green", c.doneYesterday);
    if (!d.rows.length) { body.append(el("p", "tl-note", "Nothing here. When an agent starts a task, it appears in this list.")); return; }
    for (const [gid, label] of G) {
      const rows = d.rows.filter((r) => r.group === gid); if (!rows.length) continue;
      const lim = gid === "finished" && !S.show.finished ? 15 : 500;
      const sec = el("section", "tl-group tl-" + gid); sec.append(el("h3", "tl-gh", label + " " + rows.length));
      rows.slice(0, lim).forEach((r, k) => {
        const row = el("div", "tl-row"); const txt = el("div", "tl-txt");
        const rt = el("div", "tl-rt", r.title || "(no title)"); rt.dir = "auto"; txt.append(rt);
        const sub = [r.line, d.canReorder ? "" : r.agent].filter(Boolean).join(" · "); if (sub) { const rs = el("div", "tl-rs", sub); rs.dir = "auto"; txt.append(rs); }
        row.append(txt, el("span", "tl-chip tl-c-" + gid, G.find((g) => g[0] === gid)[2]));
        if (d.canReorder && gid !== "finished" && d.canWrite) {
          const mk = (sym, dir, lab, off) => { const b = el("button", "tl-mv", sym); b.type = "button"; b.setAttribute("aria-label", lab); b.disabled = off || S.busy; b.addEventListener("click", () => { S.busy = true; api.move(S.agent, r.id, dir).then(() => { S.busy = false; refresh(); }).catch(() => { S.busy = false; }); }); return b; };
          row.append(mk("▲", "up", "Move up", k === 0 && false), mk("▼", "down", "Move down", false));
        }
        sec.append(row);
      });
      if (rows.length > lim) { const m = el("button", "tl-btn", "Show " + (rows.length - lim) + " more"); m.type = "button"; m.addEventListener("click", () => { S.show[gid] = true; render(); }); sec.append(m); }
      body.append(sec);
    }
    if (!d.canReorder) body.append(el("p", "tl-note", "To change the order, pick one agent in the list above."));
    if (d.truncated) body.append(el("p", "tl-note", "Only the first rows are shown. Pick one agent to see the rest."));
  }

  function say(t) { undoBar.textContent = t; undoBar.classList.remove("hidden"); clearTimeout(S.undoTimer); S.undoTimer = setTimeout(() => undoBar.classList.add("hidden"), 6000); }
  function showUndo(batch) {
    undoBar.textContent = "Finished tasks cleared from this list. "; const u = el("button", "tl-btn", "Undo"); u.type = "button";
    u.addEventListener("click", () => { clearTimeout(S.undoTimer); undoBar.classList.add("hidden"); api.undo(batch).then(refresh).catch(() => {}); });
    undoBar.append(u); undoBar.classList.remove("hidden"); clearTimeout(S.undoTimer); S.undoTimer = setTimeout(() => undoBar.classList.add("hidden"), 10000);
  }

  let off = null;
  const onKey = (e) => { if (e.key === "Escape" && open && !standalone) { close(); e.preventDefault(); } };
  function openView() {
    if (open) return;
    if (window.viewManager) window.viewManager.closeAll();
    open = true; document.body.classList.add("tasklist-open"); view.classList.remove("hidden");
    if (navEl) navEl.classList.add("active");
    document.addEventListener("keydown", onKey);
    off = api.onChanged(refresh);                 // live: the main process tells us when a task file changed
    poll = setInterval(() => { if (!document.hidden) refresh(); }, 15000);   // safety net only
    tick = setInterval(() => { if (S.live) { const a = head.querySelector(".tl-ago"); if (a) a.textContent = "updated " + ago(); } }, 5000);
    S.data = null; S.agent = "all"; render(); refresh();
  }
  function close() {
    if (!open) return;
    open = false; document.removeEventListener("keydown", onKey); if (off) off(); off = null; clearInterval(poll); clearInterval(tick);
    document.body.classList.remove("tasklist-open"); view.classList.add("hidden");
    if (navEl) navEl.classList.remove("active");
    S.data = null; clearTimeout(S.undoTimer); head.textContent = ""; stats.textContent = ""; body.textContent = ""; undoBar.textContent = ""; undoBar.classList.add("hidden");
  }
  window.tasklistView = { toggle(nav) { if (nav) navEl = nav; open ? close() : openView(); }, close };
})();
