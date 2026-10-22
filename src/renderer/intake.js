// Intake view: category tabs, the amber "N waiting for your approval" button, the list, and one item open with Approve / Reject.
// All text is set with textContent (item text comes from the phone and is untrusted). Sealed rows show counts only; no Send-to for them.
// Rules live in the main process (src/intake/intakeLogic.js); this file only draws and asks.
(function () {
  "use strict";
  const api = window.api && window.api.intake;
  if (!api) return;
  const TABS = [["all", "All"], ["notes", "Notes & commands"], ["review", "Review & products"], ["receipts", "Receipts"], ["medical", "🔒 Medical"], ["food", "🔒 Food"], ["health", "🔒 Health"], ["rejected", "Rejected"]];
  const SEALED_TABS = { medical: 1, food: 1, health: 1 };
  const STATUS = { new: ["New", "●", "new"], pending_approval: ["Waiting for you", "⏸", "wait"], approved: ["Approved", "✓", "ok"], sent: ["Sent", "✓", "ok"], rejected: ["Rejected", "✕", "grey"] };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const view = el("div"); view.id = "intake-view"; view.className = "hidden";
  const head = el("div", "in-head"), tabsHost = el("div", "in-tabs"), body = el("div", "in-body"), toast = el("div", "in-toast hidden");
  tabsHost.setAttribute("role", "tablist"); toast.setAttribute("role", "status");
  view.append(head, tabsHost, body, toast);
  document.getElementById("main-panel").appendChild(view);

  const S = { data: null, tab: "all", pendingOnly: false, openId: null, sealedOpen: {}, busy: false, err: "" };
  let open = false, navEl = null, toastTimer = null;
  const say = (t) => { toast.textContent = t; toast.classList.remove("hidden"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add("hidden"), 6000); };
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }); };

  function refresh() {
    return api.load().then((r) => {
      if (!open) return;
      if (!r || !r.ok) { S.err = (r && r.reason) || "Intake could not load."; S.data = null; } else { S.err = ""; S.data = r; if (window.intakeNavCount) window.intakeNavCount(r.counts.pending); }
      render();
    }).catch(() => { S.err = "Intake could not load."; render(); });
  }

  function statusChip(st) { const s = STATUS[st] || STATUS.new; const c = el("span", "in-chip in-" + s[2]); c.append(el("span", "in-chip-i", s[1]), document.createTextNode(" " + s[0])); return c; }

  function render() {
    head.textContent = ""; tabsHost.textContent = ""; body.textContent = "";
    head.append(el("h2", "in-title", "Intake"), el("span", "in-sp"));
    if (S.err) { body.append(el("p", "in-note", S.err)); return; }
    if (!S.data) { body.append(el("p", "in-note", "Loading…")); return; }
    const c = S.data.counts;
    const btn = el("button", "in-approve-btn" + (c.pending ? "" : " in-zero"));
    btn.type = "button";
    btn.append(el("b", "in-approve-n", String(c.pending)), document.createTextNode(c.pending ? " waiting for your approval ›" : " waiting ✓"));
    btn.addEventListener("click", () => { S.pendingOnly = c.pending ? !S.pendingOnly : false; S.tab = "all"; S.openId = null; render(); });
    head.append(btn);
    if (S.data.synced) body.append(el("p", "in-note in-warn", "Warning: the Intake folder is inside a synced folder (Dropbox, OneDrive or similar). Anyone who can write there could forge entries. Move it to a local, unsynced folder in Setup (intakeDir)."));
    if (S.data.requireVerified === false) body.append(el("p", "in-note in-warn", "Warning: phone signing is not live yet, so Intake cannot tell that an item really came from your phone. Check each one before you approve."));
    if (S.openId) return renderItem();
    for (const [id, label] of TABS) {
      const b = el("button", "in-tab" + (S.tab === id ? " active" : ""), label + " " + (id === "all" ? c.all : c[id] || 0));
      b.type = "button"; b.setAttribute("role", "tab");
      b.addEventListener("click", () => { S.tab = id; S.pendingOnly = false; render(); });
      tabsHost.append(b);
    }
    if (SEALED_TABS[S.tab] && !S.sealedOpen[S.tab]) {
      const box = el("div", "in-sealed");
      box.append(el("b", "", "🔒 Sealed. " + (c[S.tab] || 0) + " item" + (c[S.tab] === 1 ? "" : "s") + "."), el("p", "", "Shown only on this PC, only to you. Never sent to any agent."));
      const o = el("button", "in-btn", "Open"); o.type = "button"; o.addEventListener("click", () => { S.sealedOpen[S.tab] = true; render(); });
      box.append(o); body.append(box); return;
    }
    let rows = S.data.rows.filter((r) => (S.tab === "all" ? !r.sealed : r.tab === S.tab));
    if (S.pendingOnly) rows = rows.filter((r) => r.status === "pending_approval" && !r.sealed);
    rows.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    if (!rows.length) { const e = el("div", "in-empty"); e.append(el("b", "", S.data.empty ? "📬 Nothing from your phone yet" : "✓ Nothing here"), el("p", "", "Record a note or snap a receipt on the Pixel and it appears here within a minute.")); body.append(e); return; }
    for (const r of rows) {
      const row = el("button", "in-row"); row.type = "button";
      const t = el("div", "in-row-t");
      t.append(el("b", "", r.sealed ? "🔒 Sealed item" : (r.title || "(no text)")));
      const meta = el("div", "in-row-m");
      meta.append(statusChip(r.status), el("span", "", [r.sealed ? r.kind : (r.sub || r.kind), r.suggestedAgent ? "→ " + r.suggestedAgent : "", when(r.created), r.verified ? "verified" : ""].filter(Boolean).join(" · ")));
      t.append(meta); row.append(t);
      row.addEventListener("click", () => { S.openId = r.id; render(); });
      body.append(row);
    }
  }

  function renderItem() {
    const row = S.data.rows.find((r) => r.id === S.openId);
    const back = el("button", "in-btn", "‹ Back"); back.type = "button"; back.addEventListener("click", () => { S.openId = null; render(); });
    body.append(back);
    if (!row) { body.append(el("p", "in-note", "That item is gone.")); return; }
    const card = el("div", "in-card");
    card.append(el("h3", "", row.sealed ? "Sealed item" : (row.sub || row.kind)), statusChip(row.status));
    const txt = el("p", "in-text", "Loading…"); card.append(txt);
    body.append(card);
    api.item(row.id).then((r) => {
      if (!open || S.openId !== row.id) return;
      if (!r || !r.ok) { txt.textContent = (r && r.reason) || "Could not open."; return; }
      txt.textContent = row.sealed ? "Kept on this PC. Not sent anywhere." : (r.message || r.text || "(no text)");
      if (row.sealed || row.status === "sent" || row.status === "rejected" || row.status === "approved") { if (row.status === "approved") { card.append(el("p", "in-note", r.retry ? "Approved, but the agent did not confirm receipt." : "Approved. The watcher delivers it within a minute.")); if (r.retry) { const rb = el("button", "in-btn in-go", "Try delivering again"); rb.type = "button"; rb.addEventListener("click", () => { rb.disabled = true; api.decide(row.id, "approve", "", r.hash).then((d) => { say(d && d.sent ? "Delivered." : (d && d.reason) || "That did not work."); S.openId = null; refresh(); }).catch(() => { rb.disabled = false; }); }); card.append(rb); } } return; }
      card.append(el("p", "in-note", "Nothing has been sent. This goes out only if you approve it here."));
      const pick = el("select", "in-pick"); pick.setAttribute("aria-label", "Send to");
      const def = r.defaultAgent || "";
      const add = (v, label) => { const o = el("option", "", label); o.value = v; pick.append(o); };
      if (def) add(def, (row.suggestedAgent && row.suggestedAgent !== def ? "Default: " : "") + def + " (default)"); else add("", "Choose an agent…");
      if (row.suggestedAgent && row.suggestedAgent !== def) add(row.suggestedAgent, "⭐ " + row.suggestedAgent + " (suggested)");
      api.agents(false).then((ar) => { if (ar && ar.ok) for (const n of ar.agents) if (n !== def && n !== row.suggestedAgent) add(n, n); }).catch(() => {});
      if (row.suggestedAgent && row.suggestedAgent !== def) pick.value = row.suggestedAgent;
      const ok = el("button", "in-btn in-go", "✓ Approve and send"), no = el("button", "in-btn", "✕ Reject");
      ok.type = no.type = "button";
      const act = (action) => {
        if (S.busy) return; S.busy = true; ok.disabled = no.disabled = true;
        api.decide(row.id, action, pick.value, r.hash).then((d) => {
          S.busy = false;
          if (!d || !d.ok) { say((d && d.reason) || "That did not work."); ok.disabled = no.disabled = false; return; }
          say(action === "reject" ? "Rejected." : d.sent ? "Approved and sent." : d.reason || "Approved.");
          S.openId = null; refresh();
        }).catch(() => { S.busy = false; ok.disabled = no.disabled = false; say("That did not work."); });
      };
      ok.addEventListener("click", () => act("approve")); no.addEventListener("click", () => act("reject"));
      const lab = el("label", "in-lab", "Send to "); lab.append(pick);
      card.append(lab, el("div", "in-actions"));
      card.lastChild.append(ok, no);
    }).catch(() => { txt.textContent = "Could not open."; });
  }

  const onKey = (e) => { if (e.key === "Escape" && open) { if (S.openId) { S.openId = null; render(); } else close(); e.preventDefault(); } };
  function openView() {
    if (open) return;
    if (window.viewManager) window.viewManager.closeAll();
    open = true; document.body.classList.add("intake-open"); view.classList.remove("hidden");
    if (navEl) navEl.classList.add("active");
    document.addEventListener("keydown", onKey);
    S.data = null; S.openId = null; S.sealedOpen = {}; render(); refresh();
  }
  function close() {
    if (!open) return;
    open = false; document.removeEventListener("keydown", onKey);
    document.body.classList.remove("intake-open"); view.classList.add("hidden");
    if (navEl) navEl.classList.remove("active");
    clearTimeout(toastTimer); S.data = null; S.sealedOpen = {};
    head.textContent = ""; tabsHost.textContent = ""; body.textContent = ""; toast.textContent = ""; toast.classList.add("hidden");   // nothing stays in the page
  }
  window.intakeView = { toggle(nav) { if (nav) navEl = nav; open ? close() : openView(); }, close };
})();
