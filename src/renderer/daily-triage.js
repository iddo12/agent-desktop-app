// My Daily - Tasks tab, triage redesign (v1.79.0). Loaded before daily.js, which calls window.dailyTriage.create(ctx) once.
// Default view = only tasks flagged "needs the owner" (go/no-go first, then priority, then age). The agents' own backlog, Ideas and Snoozed are
// collapsed groups below, never mixed in. textContent only (titles/details come from agents' task files).
// LIGHT: no timers while the tab is not on screen. While it IS on screen: one re-read every REFRESH_MS (60 s, not faster than My Daily's own
// 60 s cache) and one on window focus; both skipped while typing, sending or a confirm is open. Listeners are removed when the tab is left.
(function () {
  "use strict";
  const RT = (window.dailyContract && window.dailyContract.reasonText) || ((x) => x);   // "needs-setup" -> a calm sentence
  window.dailyTriage = {
    create(ctx) {
      const { el, btn, say, api } = ctx;
      const REFRESH_MS = 60000, STALE_MS = 20000, UNDO_MS = 6000, ROW_CAP = 200;
      let data = null, loading = null, loadedAt = 0;
      let live = false, timer = null;
      let oldOnly = false, triage = false, writeOpen = false;
      const groupOpen = { backlog: false, ideas: false, snoozed: false };
      const writing = new Set();   // rows whose "Write an answer" box is open (v1.88.2)
      const expanded = new Set(), selected = new Set(), hidden = new Set(), skipList = [];
      const drafts = new Map(), clearFlag = new Map(), sending = new Set(), results = new Map();
      let cur = null;            // id of the row Y / N act on (list mode)
      let pending = null;        // { label, ids, timer, run } : the last action, undoable for UNDO_MS
      let modal = null;          // { kind: "close"|"snooze", ids, titles, note, days }
      let showAll = { needs: false, backlog: false, ideas: false, snoozed: false };

      // ---------------------------------------------------------------- data
      function load() {
        if (loading) return loading;
        loading = api.triageLoad()
          .then((r) => { if (r && r.ok) { data = r; loadedAt = Date.now(); } else if (r && r.reason) say(RT(r.reason)); return r; })
          .catch((e) => { console.error("triage load", e); return null; })
          .finally(() => { loading = null; });
        return loading;
      }
      const all = () => (data ? data.needs.concat(data.backlog, data.ideas, data.snoozed) : []);
      const byId = (id) => all().find((x) => x.id === id) || null;
      const visibleNeeds = () => (data ? data.needs.filter((x) => !hidden.has(x.id)) : []);
      const dayText = (d) => (d == null ? "unknown" : d === 0 ? "today" : d === 1 ? "1 d ago" : d + " d ago");
      const typingNow = () => { const a = document.activeElement; return !!(a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && a.closest && a.closest(".tri-wrap")); };
      const busy = () => typingNow() || sending.size > 0 || !!pending || !!modal;

      // triage queue: needs-owner cards in list order, skipped ones moved to the end (in the order they were skipped)
      function queue() {
        const q = visibleNeeds();
        const rank = (x) => skipList.indexOf(x.id) + 1;
        return q.map((x, i) => [x, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((p) => p[0]);
      }

      // ---------------------------------------------------------------- live refresh (only while the tab is on screen)
      function ensureLive() {
        if (live) return;
        live = true;
        timer = setTimeout(tick, REFRESH_MS);
        if (typeof window.addEventListener === "function") window.addEventListener("focus", onFocus);
        if (typeof document.addEventListener === "function") document.addEventListener("keydown", onKey, true);
      }
      function stopLive() {
        live = false; clearTimeout(timer); timer = null;
        if (typeof window.removeEventListener === "function") window.removeEventListener("focus", onFocus);
        if (typeof document.removeEventListener === "function") document.removeEventListener("keydown", onKey, true);
      }
      function refresh() { return load().then(() => { if (!ctx.isActive()) return; if (!busy()) ctx.rerender(); else ctx.refreshTabs(); }); }
      function tick() { if (!ctx.isActive()) { stopLive(); return; } if (!document.hidden) refresh(); timer = setTimeout(tick, REFRESH_MS); }
      function onFocus() { if (ctx.isActive() && Date.now() - loadedAt > 5000) refresh(); }

      // ---------------------------------------------------------------- actions (all by id; a click only carries its own id and the stamp it showed)
      function flushPending() { if (pending) { const p = pending; pending = null; clearTimeout(p.timer); return p.run(); } return Promise.resolve(); }
      function undo() {
        if (!pending) return;
        const p = pending; pending = null; clearTimeout(p.timer);
        for (const id of p.ids) hidden.delete(id);
        say("Undone: " + p.label + " (nothing was sent).");
        ctx.rerender();
      }
      // Queue an action: the card leaves the list at once, runs after UNDO_MS unless undone. A newer action flushes the older one first.
      function queueAction(label, ids, run) {
        flushPending();
        for (const id of ids) hidden.add(id);
        const p = { label, ids, run: async () => { for (const id of ids) sending.add(id); let r = null; try { r = await run(); } catch (e) { r = { ok: false, reason: String((e && e.message) || e) }; } for (const id of ids) sending.delete(id); await load(); for (const id of ids) hidden.delete(id); ctx.rerender(); return r; } };
        p.timer = setTimeout(() => { if (pending === p) { pending = null; p.run(); } }, UNDO_MS);
        pending = p;
        ctx.rerender();
      }
      const fail = (item, r) => { results.set(item.id, { text: RT(r && r.reason) || "That did not work. Nothing was recorded.", bad: true, reload: !!(r && r.changed) }); say(RT(r && r.reason) || "That did not work."); };

      function answer(item, kind, text) {   // kind yes | no | text
        if (item.queuedAt && kind !== "text") return;
        const label = kind === "text" ? "note to " + item.agent : (kind === "yes" ? "YES" : "NO") + " to " + item.agent;
        queueAction(label, [item.id], async () => {
          const clear = clearFlag.has(item.id) ? clearFlag.get(item.id) : true;
          const r = await api.triageAnswer(item.id, kind, text, item.rev, clear);
          if (r && r.ok) {
            drafts.delete(item.id); results.delete(item.id); expanded.delete(item.id);
            say(r.delivery === "queued" ? "Queued, not yet confirmed: handed to a busy agent. The task stays on your list until it is confirmed." : (kind === "text" && !r.cleared ? "Sent and confirmed." : "Sent and confirmed. Task cleared from your list.") + (r.warning ? " " + r.warning : ""));
          } else fail(item, r);
          return r;
        });
      }
      function snooze(ids, kind) {
        if (!ids.length) return;
        queueAction(`snooze ${ids.length === 1 ? "1 task" : ids.length + " tasks"} ${kind === "week" ? "for 1 week" : "until tomorrow"}`, ids, async () => {
          const r = await api.triageSnooze(ids, kind);
          if (r && r.ok) { for (const id of ids) selected.delete(id); say(`Snoozed ${r.count} ${kind === "week" ? "for 1 week" : "until tomorrow 08:00"}.`); } else say(RT(r && r.reason) || "Could not snooze.");
          return r;
        });
      }
      async function unsnooze(ids) { const r = await api.triageUnsnooze(ids); if (!(r && r.ok)) say(RT(r && r.reason) || "Could not wake it."); await load(); ctx.rerender(); }
      async function ask(item) {
        if (sending.has(item.id)) return;
        sending.add(item.id); ctx.rerender();
        let r = null;
        try { r = await api.triageAsk(item.id); } catch (e) { r = { ok: false, reason: String((e && e.message) || e) }; }
        sending.delete(item.id);
        if (r && r.ok) say(r.delivery === "queued" ? "Asked (queued: the agent is busy)." : "Asked " + item.agent + " for a recommendation.");
        else fail(item, r);
        await load(); ctx.rerender();
      }
      async function doClose() {
        const m = modal; modal = null;
        const r = await api.triageClose(m.ids, m.note, m.revs);
        for (const id of m.ids) selected.delete(id);
        say(r && r.results ? `Closed ${r.closed}${r.skipped ? ", " + r.skipped + " skipped: changed since shown" : ""}${r.failed ? ", " + r.failed + " failed" : ""}.` : RT(r && r.reason) || "Could not close.");
        await load(); ctx.rerender();
      }
      function askClose(items, note) { modal = { kind: "close", ids: items.map((x) => x.id), revs: Object.fromEntries(items.map((x) => [x.id, x.rev])), titles: items.map((x) => x.agent + ": " + x.title), note: note || "" }; ctx.rerender(); }
      function askSnoozeBulk(items, kind) { modal = { kind: "snooze", days: kind, ids: items.map((x) => x.id), titles: items.map((x) => x.agent + ": " + x.title) }; ctx.rerender(); }

      // ---------------------------------------------------------------- keyboard
      function onKey(e) {
        if (!ctx.isActive() || e.ctrlKey || e.metaKey || e.altKey) return;
        const tg = e.target, tag = tg && tg.tagName;
        const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
        if (modal) { if (e.key === "Escape") { modal = null; ctx.rerender(); } return; }
        if (typing) { if (e.key === "Escape" && triage && writeOpen) { writeOpen = false; if (tg.blur) tg.blur(); ctx.rerender(); } return; }
        const k = String(e.key || "").toLowerCase();
        let item = null;
        if (triage) { if (k === "escape") { triage = false; e.preventDefault(); ctx.rerender(); return; } item = queue()[0] || null; }
        else item = cur ? byId(cur) : null;
        if (k === "z") { if (pending) { e.preventDefault(); undo(); } return; }
        if (!item) return;
        if (k === "y" || k === "n") { if (item.gonogo && item.group === "needs" && !item.queuedAt && !hidden.has(item.id)) { e.preventDefault(); answer(item, k === "y" ? "yes" : "no"); } return; }
        if (!triage) return;
        if (k === "w") { e.preventDefault(); writeOpen = true; ctx.rerender(); const t = document.querySelector && document.querySelector(".tri-card .tri-box"); if (t && t.focus) t.focus(); }
        else if (k === "s") { e.preventDefault(); snooze([item.id], "tomorrow"); }
        else if (k === " " || k === "spacebar") { e.preventDefault(); skipList.push(item.id); writeOpen = false; ctx.rerender(); }
      }

      // ---------------------------------------------------------------- pieces
      function whenLine(x) {
        const s = el("span", "daily-muted tri-when", `created ${dayText(x.ageDays)} · agent updated ${x.updDays == null ? "never" : dayText(x.updDays)}`);
        return s;
      }
      function blocks(x, headlineAsk) {
        const box = el("div", "tri-blocks");
        const add = (label, text, cls) => { if (!text) return; const b = el("div", "tri-block " + (cls || "")); b.append(el("div", "tri-lbl", label)); const t = el("div", "tri-txt", text); t.setAttribute("dir", "auto"); b.append(t); box.append(b); };
        if (x.structured) {
          if (!headlineAsk) add("ASK", x.ask, "ask");
          add("RECOMMEND", x.recommend, "rec"); add("WHY IT MATTERS", x.why, "why");
        }
        if (!x.structured || !x.recommend) {
          if (!x.structured) { const d = el("div", "tri-txt tri-plain", x.preview || "(no detail)"); d.setAttribute("dir", "auto"); box.append(d); if (x.previewCut) box.append(el("div", "daily-muted sm", "(first 600 characters)")); }
          const row = el("div", "tri-norec");
          row.append(el("span", "daily-muted", "No agent recommendation yet."));
          const asked = x.askedAt && Date.now() - x.askedAt < 12 * 3600000;
          const b = btn(asked ? "Asked, waiting for the agent" : "Ask the agent for a recommendation", "daily-btn sm", () => ask(x));
          b.disabled = !!asked || sending.has(x.id);
          row.append(b); box.append(row);
        }
        if (x.structured && x.rest) { const d = el("div", "tri-rest daily-muted", x.rest); d.setAttribute("dir", "auto"); box.append(d); }
        return box;
      }
      function writeForm(x, inTriage) {
        const f = el("div", "tri-form");
        const ta = el("textarea", "daily-input tri-box");
        ta.rows = 3; ta.maxLength = data.max + 1000; ta.setAttribute("dir", "auto");
        ta.placeholder = "Write to " + x.agent + " (delivered straight to the agent). Ctrl+Enter sends.";
        ta.value = drafts.get(x.id) || "";
        ta.addEventListener("input", () => drafts.set(x.id, ta.value));
        const go = () => { const v = ta.value; if (!v.trim()) { say("Write your note first."); return; } if (v.length > data.max) { say(`That is ${v.length} characters; the limit is ${data.max}. Shorten it (nothing was sent).`); return; } writeOpen = false; answer(x, "text", v); };
        ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
        f.append(ta);
        const row = el("div", "tri-acts");
        row.append(btn("Send", "daily-btn pri tri-send", go));
        if (x.group === "needs") {
          const lab = el("label", "tri-clear");
          const cb = el("input"); cb.type = "checkbox"; cb.checked = clearFlag.has(x.id) ? clearFlag.get(x.id) : true;
          cb.addEventListener("change", () => clearFlag.set(x.id, cb.checked));
          lab.append(cb, el("span", null, " Mark answered (clears the 'needs you' flag)"));
          row.append(lab);
        }
        f.append(row);
        return f;
      }
      function manageRow(x) {
        const r = el("div", "tri-acts tri-manage");
        r.append(el("span", "daily-muted", "Snooze:"), btn("Until tomorrow", "daily-btn sm", () => snooze([x.id], "tomorrow")), btn("1 week", "daily-btn sm", () => snooze([x.id], "week")), el("span", "daily-sp"),
          btn("Close with note...", "daily-btn sm tri-close", () => askClose([x], drafts.get(x.id) || "")));
        return r;
      }
      function yesNo(x, big) {
        const w = el("div", "tri-yn" + (big ? " big" : ""));
        const q = !!x.queuedAt;
        const y = btn("Yes", "daily-btn pri tri-yes", () => answer(x, "yes")), n = btn("No", "daily-btn tri-no", () => answer(x, "no"));
        y.title = "Yes (Y)"; n.title = "No (N)";
        y.disabled = n.disabled = q || sending.has(x.id);
        w.append(y, n);
        if (q) w.append(el("span", "ship-chip warn", "Answer queued, not confirmed"));
        return w;
      }
      function resultLine(x) {
        const res = results.get(x.id);
        if (!res) return null;
        const rd = el("div", "dec-result" + (res.bad ? " bad" : ""), res.text);
        if (res.reload) { rd.append(el("span", null, " "), btn("Reload", "daily-btn sm", async () => { results.delete(x.id); await load(); ctx.rerender(); })); }
        return rd;
      }

      function rowEl(x) {
        const isOpen = expanded.has(x.id);
        const card = el("section", "daily-card tri-row" + (x.group === "needs" ? " needs" : "") + (cur === x.id ? " cur" : "") + (sending.has(x.id) ? " sending" : ""));
        card.dataset.id = x.id;
        const top = el("div", "tri-top");
        const cb = el("input", "tri-sel"); cb.type = "checkbox"; cb.checked = selected.has(x.id); cb.title = "Select for Close selected / Snooze selected";
        cb.addEventListener("change", () => { if (cb.checked) selected.add(x.id); else selected.delete(x.id); ctx.rerender(); });
        top.append(cb, el("span", "dec-agent", x.agent));
        if (x.priority === 1) top.append(el("span", "ship-chip bad", "High"));
        if (x.gonogo) top.append(el("span", "ship-chip", "Yes / No"));
        if (x.old) top.append(el("span", "ship-chip warn", "Old"));
        if (x.snoozedUntil) top.append(el("span", "ship-chip", "Snoozed until " + new Date(x.snoozedUntil).toLocaleString()));
        top.append(el("span", "daily-sp"), whenLine(x));
        card.append(top);
        const t = el("div", "dec-q tri-title", x.title); t.setAttribute("dir", "auto");
        t.addEventListener("click", () => { cur = x.id; ctx.rerender(); });
        card.append(t);
        const acts = el("div", "tri-acts");
        if (x.group === "needs" && x.gonogo) acts.append(yesNo(x, true));
        if (x.group === "needs") acts.append(btn(writing.has(x.id) ? "✎ Close the answer box" : (x.gonogo ? "✎ Or write an answer" : "✎ Write an answer"), x.gonogo ? "daily-btn sm tri-writebtn" : "daily-btn pri tri-writebtn", () => { cur = x.id; if (writing.has(x.id)) writing.delete(x.id); else writing.add(x.id); ctx.rerender(); }));
        acts.append(btn((isOpen ? "▾ " : "▸ ") + "What is this?", "dec-toggle tri-toggle", () => { cur = x.id; if (expanded.has(x.id)) expanded.delete(x.id); else expanded.add(x.id); ctx.rerender(); }));
        if (x.snoozedUntil) acts.append(el("span", "daily-sp"), btn("Wake now", "daily-btn sm", () => unsnooze([x.id])));
        card.append(acts);
        if (writing.has(x.id) && !isOpen) card.append(writeForm(x));
        if (isOpen) {
          const body = el("div", "tri-body");
          if (x.structured) { const h = el("div", "tri-ask", x.ask); h.setAttribute("dir", "auto"); body.append(h); }
          body.append(blocks(x, x.structured), writeForm(x), manageRow(x));
          card.append(body);
        }
        const rl = resultLine(x); if (rl) card.append(rl);
        return card;
      }

      function groupEl(key, title, hint, items) {
        const g = el("section", "tri-group");
        const h = el("h3", "daily-card-h dec-group-h");
        const total = data.counts[key === "needs" ? "needs" : key], shown = items.length;
        const open = key === "needs" || groupOpen[key];
        const label = key === "needs" ? el("span", "tri-gtitle", title) : btn((open ? "▾ " : "▸ ") + title, "ship-toggle", () => { groupOpen[key] = !groupOpen[key]; ctx.rerender(); });
        h.append(label, el("span", "daily-n" + (key === "needs" && shown ? " warn" : ""), oldOnly && shown !== total ? `${shown} of ${total}` : String(shown)));
        if (open && shown) { const sa = btn(items.every((x) => selected.has(x.id)) ? "Unselect all" : "Select all", "dec-link", () => { const everyOn = items.every((x) => selected.has(x.id)); for (const x of items.slice(0, 200)) { if (everyOn) selected.delete(x.id); else selected.add(x.id); } ctx.rerender(); }); h.append(el("span", "daily-sp"), sa); }
        g.append(h);
        if (hint) g.append(el("div", "daily-muted sm dec-hint", hint));
        if (!open) return g;
        if (!shown) g.append(el("div", "daily-muted daily-pad", key === "needs" ? (oldOnly ? "Nothing old is waiting on you." : "Nothing is waiting on you.") : "Nothing here."));
        const rows = showAll[key] ? items : items.slice(0, ROW_CAP);
        for (const x of rows) g.append(rowEl(x));
        if (items.length > rows.length) { const m = el("div", "daily-more-row"); m.append(el("span", "daily-muted", `Showing ${rows.length} of ${items.length}. `), btn(`Show all ${items.length}`, "daily-btn sm daily-showall", () => { showAll[key] = true; ctx.rerender(); })); g.append(m); }
        return g;
      }

      function triageCard() {
        const wrap = el("div", "tri-triage");
        const q = queue();
        const bar = el("div", "ship-bar");
        bar.append(el("b", null, q.length ? `${q.length} left` : "All done"), el("span", "daily-muted", "  Y yes · N no · W write · S snooze (tomorrow) · Space skip · Z undo · Esc leave"), el("span", "daily-sp"), btn("Back to list", "daily-btn", () => { triage = false; writeOpen = false; ctx.rerender(); }));
        wrap.append(bar);
        const x = q[0];
        if (!x) { wrap.append(ctx.emptyState("Nothing is waiting on you", "Every task that needs you is answered, snoozed or closed.", null, null)); return wrap; }
        const c = el("section", "daily-card tri-card");
        const top = el("div", "tri-top");
        top.append(el("span", "dec-agent", x.agent));
        if (x.priority === 1) top.append(el("span", "ship-chip bad", "High"));
        if (x.old) top.append(el("span", "ship-chip warn", "Old"));
        top.append(el("span", "daily-sp"), whenLine(x));
        c.append(top);
        const h = el("div", "tri-ask big", x.structured ? x.ask : x.title); h.setAttribute("dir", "auto"); c.append(h);
        if (x.structured) { const s = el("div", "daily-muted sm", "Task: " + x.title); s.setAttribute("dir", "auto"); c.append(s); }
        c.append(blocks(x, true));
        const acts = el("div", "tri-acts tri-big");
        if (x.gonogo) acts.append(yesNo(x, true));
        else { const y = btn("Yes", "daily-btn", () => {}), n = btn("No", "daily-btn", () => {}); y.disabled = n.disabled = true; y.title = n.title = "This is not a yes/no question: use Write"; acts.append(y, n); }
        acts.append(btn("Write (W)", "daily-btn", () => { writeOpen = true; ctx.rerender(); }), btn("Snooze (S)", "daily-btn", () => snooze([x.id], "tomorrow")), btn("1 week", "daily-btn sm", () => snooze([x.id], "week")), btn("Skip (Space)", "daily-btn", () => { skipList.push(x.id); writeOpen = false; ctx.rerender(); }));
        c.append(acts);
        if (writeOpen) c.append(writeForm(x, true));
        const rl = resultLine(x); if (rl) c.append(rl);
        wrap.append(c);
        return wrap;
      }

      function modalEl() {
        const m = el("div", "tri-modal");
        const box = el("div", "daily-card tri-modal-box");
        const n = modal.ids.length;
        box.append(el("h3", "daily-card-h", modal.kind === "close" ? `Close ${n} task${n === 1 ? "" : "s"}?` : `Snooze ${n} task${n === 1 ? "" : "s"} ${modal.days === "week" ? "for 1 week" : "until tomorrow 08:00"}?`));
        const ul = el("div", "tri-list");
        for (const t of modal.titles.slice(0, 50)) { const li = el("div", "tri-li", t); li.setAttribute("dir", "auto"); ul.append(li); }
        if (n > 50) ul.append(el("div", "daily-muted", `... and ${n - 50} more`));
        box.append(ul);
        if (modal.kind === "close") {
          const ta = el("textarea", "daily-input tri-box"); ta.rows = 2; ta.placeholder = "Closing note (optional, kept in the task)"; ta.value = modal.note || ""; ta.setAttribute("dir", "auto");
          ta.addEventListener("input", () => { modal.note = ta.value; });
          box.append(ta, el("div", "daily-muted sm", "Closing is recorded in the agents' task stores (tasks.py --close). It cannot be undone from here."));
        }
        const row = el("div", "tri-acts");
        row.append(btn(modal.kind === "close" ? "Close task" + (n === 1 ? "" : "s") : "Snooze", "daily-btn pri tri-confirm", () => { if (modal.kind === "close") doClose(); else { const mm = modal; modal = null; snooze(mm.ids, mm.days); } }), btn("Cancel", "daily-btn", () => { modal = null; ctx.rerender(); }));
        box.append(row); m.append(box);
        return m;
      }

      function render() {
        const wrap = el("div", "daily-plain dec-wrap tri-wrap");
        if (ctx.isActive()) ensureLive();
        if (!data || Date.now() - loadedAt > STALE_MS) {
          if (!loading) load().then(() => { if (ctx.isActive() && !busy()) ctx.rerender(); else if (ctx.isActive()) ctx.refreshTabs(); });
          if (!data) { wrap.append(el("div", "daily-muted daily-pad", "Loading tasks...")); return wrap; }
        }
        if (pending) {
          const u = el("div", "tri-undo");
          u.append(el("span", null, "Will " + pending.label + " in a few seconds. "), btn("Undo (Z)", "daily-btn sm", undo));
          wrap.append(u);
        }
        if (triage) { wrap.append(triageCard()); if (modal) wrap.append(modalEl()); return wrap; }
        const oldF = (l) => (oldOnly ? l.filter((x) => x.old) : l);
        const needs = oldF(visibleNeeds());
        const bar = el("div", "ship-bar tri-bar");
        const c = data.counts;
        const big = el("span", "tri-count"); big.append(el("b", null, String(visibleNeeds().length)), el("span", null, " need you"));
        bar.append(big, el("span", "daily-muted", `${c.gonogo ? c.gonogo + " yes/no · " : ""}${c.needsOld} old (>7 d) · ${c.backlog + c.ideas} agents' own work hidden below`), el("span", "daily-sp"));
        const tb = btn("Triage", "daily-btn pri", () => { triage = true; writeOpen = false; ctx.rerender(); }); tb.title = "One card at a time: Y / N / W / S / Space";
        const ob = btn("Old (>7 d)" + (oldOnly ? " ✓" : ""), "daily-btn" + (oldOnly ? " on" : ""), () => { oldOnly = !oldOnly; ctx.rerender(); }); ob.title = "Only tasks with no agent update for more than 7 days";
        bar.append(tb, ob, btn("Reload", "daily-btn", async () => { await load(); ctx.rerender(); }));
        if (ctx.recordBtn) { const rb = ctx.recordBtn(); if (rb) bar.append(rb); }
        wrap.append(bar);
        if (ctx.voicePanel) { const vp = ctx.voicePanel(); if (vp) wrap.append(vp); }
        if (data.skipped) wrap.append(el("div", "daily-banner", `${data.skipped} task file${data.skipped === 1 ? "" : "s"} could not be read and ${data.skipped === 1 ? "is" : "are"} left out.`));
        if (selected.size) {
          const sel = all().filter((x) => selected.has(x.id));
          const sb = el("div", "ship-bar tri-bulk");
          sb.append(el("b", null, `${sel.length} selected`), btn("Snooze selected: tomorrow", "daily-btn", () => askSnoozeBulk(sel, "tomorrow")), btn("1 week", "daily-btn", () => askSnoozeBulk(sel, "week")), btn("Close selected", "daily-btn tri-close", () => askClose(sel, "")), el("span", "daily-sp"), btn("Clear selection", "daily-btn", () => { selected.clear(); ctx.rerender(); }));
          wrap.append(sb);
        }
        wrap.append(groupEl("needs", "Needs you", "Yes/No questions first, then priority, then oldest.", needs));
        wrap.append(groupEl("backlog", "Agents' own backlog", "Work the agents are doing themselves. Not waiting on you.", oldF(data.backlog.filter((x) => !hidden.has(x.id)))));
        wrap.append(groupEl("ideas", "Ideas", "", oldF(data.ideas.filter((x) => !hidden.has(x.id)))));
        if (data.counts.snoozed) wrap.append(groupEl("snoozed", "Snoozed", "Hidden until the time shown.", oldF(data.snoozed)));
        if (modal) wrap.append(modalEl());
        return wrap;
      }

      return {
        render,
        prefetch() { if (data && Date.now() - loadedAt < STALE_MS) return Promise.resolve(data); return load(); },
        tabCount() { const n = data ? visibleNeeds().length : null; return n ? [n, "warn", `${n} task${n === 1 ? "" : "s"} need you`] : null; },
        needsCount() { return data ? visibleNeeds().length : null; },
        invalidate() { loadedAt = 0; },
        _state() { return { triage, pending: !!pending, selected: selected.size, live, oldOnly }; },
      };
    },
  };
})();
