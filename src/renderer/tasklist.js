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

  let loadSeq = 0;
  function refresh() {
    const mine = ++loadSeq;
    return api.load(S.agent).then((r) => {
      if (!open || mine !== loadSeq) return;   // a newer load is on its way: this answer may predate a just-saved move
      if (!r || !r.ok) { S.err = (r && r.reason) || "The task list could not load."; S.data = null; S.live = false; }
      else { S.err = ""; S.data = r; S.live = true; S.lastAt = Date.now(); if (window.tasklistNavCount) window.tasklistNavCount(r.counts.needs_you); }
      if (S.drag || S.moving) { S.late = true; return; }   // a drag (or its save) is in progress: redrawing now would destroy the lifted row / flash the old order (agents change task files all the time)
      render();
    }).catch(() => { S.live = false; S.err = "The task list could not load."; render(); });
  }
  const ago = () => { const s = Math.max(0, Math.round((Date.now() - S.lastAt) / 1000)); return s < 5 ? "just now" : s < 90 ? s + " s ago" : Math.round(s / 60) + " min ago"; };

  // Pointer drag with a lifted row: the row follows the pointer, the others slide apart to open a gap, it settles into the gap on release.
  // The new order is shown at once (optimistic) and saved in the background; refresh() is held back until the save is done.
  function scroller(n) { for (let p = n.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p; } return document.scrollingElement; }
  function beginPress(e, row, sec, gid, r) {
    const x0 = e.clientX, y0 = e.clientY; let started = false, ghost = null, grab = 0, lastY = y0, raf = 0, sc = null;
    const isRow = (n) => n && n.classList && n.classList.contains("tl-row") ? n : null;
    const orig = { prev: isRow(row.previousElementSibling), next: isRow(row.nextElementSibling) };
    const sibs = () => [...sec.querySelectorAll(".tl-row")].filter((n) => n !== row);
    const place = () => {   // slide the gap to where the pointer is; the other rows animate to their new spots (FLIP)
      const s = sibs(); const before = new Map(s.map((n) => [n, n.getBoundingClientRect().top]));
      let target = null; for (const n of s) { const q = n.getBoundingClientRect(); if (lastY < q.top + q.height / 2) { target = n; break; } }
      if (target) { if (row.nextElementSibling !== target) sec.insertBefore(row, target); } else if (s.length && s[s.length - 1].nextElementSibling !== row) s[s.length - 1].after(row);
      for (const n of s) { const dy = before.get(n) - n.getBoundingClientRect().top; if (dy) { n.style.transition = "none"; n.style.transform = "translateY(" + dy + "px)"; n.getBoundingClientRect(); n.style.transition = "transform 160ms ease"; n.style.transform = ""; } }
    };
    const loop = () => {   // scroll the list when the lifted row is near its top or bottom edge
      if (!started) return;
      const q = sc.getBoundingClientRect(), top = sc === document.scrollingElement ? 0 : q.top, bot = sc === document.scrollingElement ? innerHeight : q.bottom;
      const v = lastY < top + 50 ? -Math.ceil((top + 50 - lastY) / 4) : lastY > bot - 50 ? Math.ceil((lastY - (bot - 50)) / 4) : 0;
      if (v) { sc.scrollTop += v; ghost.style.top = (lastY - grab) + "px"; place(); }
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      started = true; S.drag = { id: r.id, g: gid }; const q = row.getBoundingClientRect(); grab = y0 - q.top; sc = scroller(row);
      ghost = row.cloneNode(true); ghost.classList.add("tl-ghost");
      ghost.style.cssText = "left:" + q.left + "px;top:" + q.top + "px;width:" + q.width + "px;height:" + q.height + "px";
      document.body.appendChild(ghost); row.classList.add("tl-placeholder"); document.body.classList.add("tl-dragging-body"); raf = requestAnimationFrame(loop);
    };
    const mv = (ev) => {
      lastY = ev.clientY;
      if (!started) { if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 6) return; start(); }
      ghost.style.top = (lastY - grab) + "px"; place();
    };
    const done = (cancel) => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cx);
      if (!started) return;
      cancelAnimationFrame(raf); document.body.classList.remove("tl-dragging-body");
      const q = row.getBoundingClientRect(); ghost.style.transition = "top 160ms ease, box-shadow 160ms ease, transform 160ms ease"; ghost.style.top = q.top + "px"; ghost.classList.add("tl-landing");
      const prev = isRow(row.previousElementSibling), next = isRow(row.nextElementSibling);
      const moved = !cancel && (prev !== orig.prev || next !== orig.next);
      setTimeout(() => {
        ghost.remove(); row.classList.remove("tl-placeholder"); S.drag = null;
        if (!moved) { say(cancel ? "Drag was cancelled by the system, nothing changed." : "Dropped back in the same place."); if (S.late) { S.late = false; refresh(); } return; }
        S.moving = (S.moving || 0) + 1;
        const call = next ? api.move(S.agent, r.id, "before", next.dataset.id) : api.move(S.agent, r.id, "after", prev.dataset.id);
        call.then((res) => { if (!res || !res.ok) say((res && res.reason) || "The new order could not be saved."); else if (res.changed === false) say("That move was not possible here."); }, () => say("The new order could not be saved.")).then(() => { S.moving--; S.late = false; refresh(); });
      }, 170);
    };
    const up = () => done(false), cx = () => done(true);
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cx);
  }

  // Remove ("cancel") a task nobody needs any more: asks first, keeps it in the archive, and the bar offers Undo.
  function removeBtns(r, acts) {
    acts.textContent = "";
    if (S.confirm && S.confirm.id === r.id && S.confirm.agent === r.agent) {
      const q = el("span", "tl-ask", "Remove this task?"), y = el("button", "tl-btn tl-yes", "Yes, remove"), n = el("button", "tl-btn", "No");
      y.type = n.type = "button";
      n.addEventListener("click", () => { S.confirm = null; render(); });
      y.addEventListener("click", () => { S.confirm = null; y.disabled = true; api.cancel(r.agent, r.id).then((res) => { if (res && res.ok && res.batch) showUndo(res.batch, "Task removed. "); else say((res && res.reason) || "That did not work."); refresh(); }).catch(() => refresh()); });
      acts.append(q, y, n); return true;
    }
    return false;
  }

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
    view.querySelectorAll(".tl-opts").forEach((n) => n.remove());
    const lab = el("label", "tl-auto"); const cb = el("input"); cb.type = "checkbox"; cb.checked = autoOn; cb.disabled = !d.canWrite || (!isAll && d.auto.global);
    lab.append(cb, document.createTextNode(isAll ? " Every agent always continues to its next task, even after a handoff" : " This agent always continues to its next task, even after a handoff" + (d.auto.global ? " (on for everyone)" : "")));
    lab.title = "When on, an agent that fills its memory and restarts goes straight on to its next task without waiting for you. Tasks that need you are skipped.";
    cb.addEventListener("change", () => { cb.disabled = true; api.auto(S.agent, cb.checked).then((r) => { if (!r || !r.ok) say((r && r.reason) || "That did not work."); refresh(); }).catch(() => refresh()); });
    const opts = el("details", "tl-opts"); opts.append(el("summary", "", "Options"), lab); stats.before(opts);
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
        row.dataset.id = r.id; row.dataset.g = gid;
        if (gid !== "finished" && d.canWrite) {
          const acts = el("div", "tl-acts");
          if (!removeBtns(r, acts)) {
            if (d.canReorder) {
              const mk = (sym, dir, lab) => { const b = el("button", "tl-mv", sym); b.type = "button"; b.setAttribute("aria-label", lab); b.disabled = S.busy; b.addEventListener("click", () => { S.busy = true; api.move(S.agent, r.id, dir).then(() => { S.busy = false; refresh(); }).catch(() => { S.busy = false; }); }); return b; };
              acts.append(mk("⤒", "top", "Move to top"), mk("▲", "up", "Move up"), mk("▼", "down", "Move down"));
            }
            const x = el("button", "tl-mv tl-x", "✕"); x.type = "button"; x.title = "Remove this task"; x.setAttribute("aria-label", "Remove this task");
            x.addEventListener("click", () => { S.confirm = { agent: r.agent, id: r.id }; clearTimeout(S.confirmTimer); S.confirmTimer = setTimeout(() => { S.confirm = null; if (open && !S.drag && !S.moving) render(); }, 10000); render(); });
            acts.append(x);
          }
          row.append(acts);
          if (d.canReorder) { row.classList.add("tl-drag"); row.addEventListener("pointerdown", (e) => { if (e.button !== 0 || e.target.closest("button")) return; beginPress(e, row, sec, gid, r); }); }
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
  function showUndo(batch, msg) {
    undoBar.textContent = msg || "Finished tasks cleared from this list. "; const u = el("button", "tl-btn", "Undo"); u.type = "button";
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
