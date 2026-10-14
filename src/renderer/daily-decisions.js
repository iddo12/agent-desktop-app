// My Daily - Decisions tab (v1.78.0). Loaded before daily.js, which calls window.dailyDecisions.create(ctx) once.
// textContent only (titles and details come from agents' task files and are never parsed as HTML). No timers of its own: the list loads
// when the tab opens, on a stale re-open, after each answer, and once after My Daily's own load (for the tab badge).
// An item is answered by id (agent::task id) only; a click on one item can never touch another. Drafts survive re-draws.
(function () {
  "use strict";
  const RT = (window.dailyContract && window.dailyContract.reasonText) || ((x) => x);   // "needs-setup" -> a calm sentence
  window.dailyDecisions = {
    create(ctx) {
      const { el, btn, say, api } = ctx;
      let data = null;
      let loading = null;
      let loadedAt = 0;
      let showArchive = false;
      let showOther = false;
      const STALE_MS = 30000;
      const drafts = new Map();      // id -> text in the box
      const sending = new Set();     // ids with a send in flight (double-click guard)
      const results = new Map();     // id -> { text, bad } shown inside the item after a failed or special result
      const open = new Set();        // ids whose context is expanded

      function load() {
        if (loading) return loading;
        loading = api.decisionsLoad()
          .then((r) => { if (r && r.ok) { data = r; loadedAt = Date.now(); } else if (r && r.reason) say(RT(r.reason)); return r; })
          .catch((e) => { console.error("decisions load", e); return null; })
          .finally(() => { loading = null; });
        return loading;
      }
      const ago = (ms, now) => {
        if (!ms) return "";
        const m = Math.max(0, Math.round(((now || Date.now()) - ms) / 60000));
        return m < 2 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
      };
      const stamp = (ms) => {
        const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      const typingNow = () => { const a = document.activeElement; return !!(a && a.tagName === "TEXTAREA" && a.closest && a.closest(".dec-wrap")); };

      async function send(item, answer, text) {   // sends item.rev: the stamp of what this card showed
        if (sending.has(item.id)) return;
        sending.add(item.id);
        results.delete(item.id);
        ctx.rerender();
        let r = null;
        try { r = await api.decisionsAnswer(item.id, answer, text, item.rev); } catch (e) { r = { ok: false, reason: String((e && e.message) || e) }; }
        sending.delete(item.id);
        if (r && r.ok) {
          drafts.delete(item.id); results.delete(item.id);
          await load();
          say(r.delivery === "queued" ? "Queued, not yet confirmed: handed to a busy agent, not seen in its transcript yet. Moved to the Archive." : "Sent and confirmed. Moved to the Archive.");
          if (r.warning) say(r.warning);
        } else {
          results.set(item.id, { text: RT(r && r.reason) || "That did not work. Nothing was recorded.", bad: true, reload: !!(r && r.changed) });
          await load();
        }
        ctx.rerender();
      }

      async function switchKind(item) {
        if (sending.has(item.id)) return;
        const r = await api.decisionsSetKind(item.id, item.kind === "gonogo" ? "text" : "gonogo");
        if (!(r && r.ok)) say(RT(r && r.reason) || "Could not switch.");
        await load();
        ctx.rerender();
      }

      function itemEl(item, now) {
        const busy = sending.has(item.id);
        const card = el("section", "daily-card dec-item" + (busy ? " sending" : ""));
        card.dataset.id = item.id;
        const top = el("div", "dec-top");
        top.append(el("span", "dec-agent", item.agent));
        if (item.priority === 1) top.append(el("span", "ship-chip bad", "High"));
        const when = item.updated || item.created;
        if (when) top.append(el("span", "daily-muted dec-age", ago(when, now)));
        card.append(top);
        const q = el("div", "dec-q", item.title);
        q.setAttribute("dir", "auto");
        card.append(q);
        if (item.detail) {
          const isOpen = open.has(item.id);
          const tg = btn((isOpen ? "▾ " : "▸ ") + "Context", "dec-toggle", () => { if (open.has(item.id)) open.delete(item.id); else open.add(item.id); ctx.rerender(); });
          card.append(tg);
          if (isOpen) { const d = el("div", "dec-detail", item.detail); d.setAttribute("dir", "auto"); card.append(d); }
        }
        const acts = el("div", "dec-acts");
        if (item.kind === "gonogo") {
          const go = btn("Go", "daily-btn pri", () => send(item, "go"));
          const no = btn("No-go", "daily-btn", () => send(item, "nogo"));
          go.disabled = no.disabled = busy;
          acts.append(go, no);
        } else {
          const ta = el("textarea", "daily-input dec-box");
          ta.rows = 3; ta.maxLength = data.max + 1000;
          ta.placeholder = (item.group === "other" ? "A short note to " + item.agent + " (delivered straight to the agent)." : "Write your answer. It is delivered straight to " + item.agent + ".");
          ta.setAttribute("dir", "auto");
          ta.value = drafts.get(item.id) || "";
          ta.disabled = busy;
          const cnt = el("span", "daily-muted dec-count");
          const upd = () => { const n = ta.value.length; cnt.textContent = n > data.max * 0.8 ? `${n} / ${data.max}` : ""; cnt.classList.toggle("over", n > data.max); };
          ta.addEventListener("input", () => { drafts.set(item.id, ta.value); upd(); });
          upd();
          const sb = btn("Send answer", "daily-btn pri", () => send(item, "text", ta.value));
          sb.disabled = busy;
          card.append(ta);
          acts.append(sb, cnt);
        }
        if (busy) acts.append(el("span", "daily-muted dec-state", "Sending... (waiting for the agent to take it)"));
        else {
          const sw = btn(item.kind === "gonogo" ? "Answer with text instead" : "Answer with Go / No-go instead", "dec-link", () => switchKind(item));
          acts.append(el("span", "daily-sp"), sw);
        }
        card.append(acts);
        const res = results.get(item.id);
        if (res && !busy) {
          const rd = el("div", "dec-result" + (res.bad ? " bad" : ""), res.text);
          if (res.reload) rd.append(el("span", null, " "), btn("Reload", "daily-btn sm", async () => { results.delete(item.id); await load(); ctx.rerender(); }));
          card.append(rd);
        }
        return card;
      }

      function archiveEl(a) {
        const r = el("div", "dec-arch");
        const queued = a.delivery === "queued";
        r.append(el("span", "dec-tick" + (queued ? " queued" : ""), queued ? "…" : "✓"));   // V = confirmed delivery only
        const main = el("div", "dec-arch-main");
        const l1 = el("div", "dec-arch-l1");
        l1.append(el("span", "dec-agent", a.agent));
        const label = a.answer === "go" ? "GO" : a.answer === "nogo" ? "NO-GO" : "Written answer";
        l1.append(el("span", "ship-chip " + (a.answer === "go" ? "ok" : a.answer === "nogo" ? "bad" : ""), label));
        if (queued) l1.append(el("span", "ship-chip warn", "Queued, not yet confirmed"));
        l1.append(el("span", "daily-muted dec-age", stamp(a.answeredAt)));
        main.append(l1);
        const t = el("div", "dec-q sm", a.title); t.setAttribute("dir", "auto");
        main.append(t);
        if (a.text) { const x = el("div", "dec-sent", a.text); x.setAttribute("dir", "auto"); main.append(x); }
        if (a.taskNote === "failed") main.append(el("div", "dec-result bad", "The fleet task was not updated; the agent was told."));
        r.append(main);
        return r;
      }

      function render() {
        const wrap = el("div", "daily-plain dec-wrap");
        if (!data || Date.now() - loadedAt > STALE_MS) {
          if (!loading) load().then(() => { if (ctx.isActive() && !typingNow() && !sending.size) ctx.rerender(); else if (ctx.isActive()) ctx.refreshTabs(); });
          if (!data) { wrap.append(el("div", "daily-muted daily-pad", "Loading decisions...")); return wrap; }
        }
        const now = data.now;
        const bar = el("div", "ship-bar");
        const qs = data.open.filter((x) => x.group !== "other");
        const others = data.open.filter((x) => x.group === "other");
        bar.append(el("span", "daily-muted", `${qs.length} question${qs.length === 1 ? "" : "s"} for you - ${others.length} other - ${data.archive.length} answered`));
        bar.append(el("span", "daily-sp"), btn("Reload", "daily-btn", async () => { await load(); ctx.rerender(); }));
        wrap.append(bar);
        if (data.skipped) wrap.append(el("div", "daily-banner", `${data.skipped} task file${data.skipped === 1 ? "" : "s"} could not be read and ${data.skipped === 1 ? "is" : "are"} left out.`));
        const g1 = el("section", "dec-group dec-questions");
        const h1 = el("h3", "daily-card-h dec-group-h");
        h1.append(el("span", null, "Questions for you"), el("span", "daily-n warn", String(qs.length)));
        g1.append(h1, el("div", "daily-muted sm dec-hint", "Agents: tag a task decision or decision:gonogo to put it here."));
        if (!qs.length) g1.append(ctx.emptyState("No questions waiting for you", "When an agent tags a task decision, or asks you a question, it appears here.", null, null));
        for (const it of qs) g1.append(itemEl(it, now));
        wrap.append(g1);
        const g2 = el("section", "dec-group dec-other");
        const h2 = el("h3", "daily-card-h dec-group-h");
        h2.append(btn((showOther ? "▾ " : "▸ ") + "Other things waiting on you", "ship-toggle", () => { showOther = !showOther; ctx.rerender(); }), el("span", "daily-n", String(others.length)));
        g2.append(h2);
        if (showOther) { if (!others.length) g2.append(el("div", "daily-muted daily-pad", "Nothing else is waiting on you.")); for (const it of others) g2.append(itemEl(it, now)); }
        wrap.append(g2);
        const ag = el("section", "daily-card ship-group archive");
        const ah = el("h3", "daily-card-h");
        const tgl = btn((showArchive ? "▾ " : "▸ ") + "Archive (answered)", "ship-toggle", () => { showArchive = !showArchive; ctx.rerender(); });
        ah.append(tgl, el("span", "daily-n", String(data.archive.length)));
        ag.append(ah);
        if (showArchive) { if (!data.archive.length) ag.append(el("div", "daily-muted daily-pad", "Nothing answered yet.")); for (const a of data.archive.slice(0, 200)) ag.append(archiveEl(a)); }
        wrap.append(ag);
        return wrap;
      }

      return {
        render,
        prefetch() { if (data && Date.now() - loadedAt < STALE_MS) return Promise.resolve(data); return load(); },
        tabCount() { const c = data ? data.open.filter((x) => x.group !== "other").length : 0; return c ? [c, "warn", `${c} question${c === 1 ? "" : "s"} waiting for you`] : null; },
        invalidate() { loadedAt = 0; },
      };
    },
  };
})();
