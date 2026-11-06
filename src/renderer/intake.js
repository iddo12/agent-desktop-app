// Intake view: category tabs, the amber "N waiting for your approval" button, the list, and one item open with Approve / Reject.
// All text is set with textContent (item text comes from the phone and is untrusted). Sealed rows show counts only; no Send-to for them.
// Rules live in the main process (src/intake/intakeLogic.js); this file only draws and asks.
(function () {
  "use strict";
  const api = window.api && window.api.intake;
  if (!api) return;
  const HL = window.heldLogic;
  if (!HL) return;
  const TABS = [["all", "All"], ["notes", "Notes & commands"], ["review", "Review & products"], ["receipts", "Receipts"], ["medical", "🔒 Medical"], ["food", "🔒 Food"], ["health", "🔒 Health"], ["msgs", "Messages to agents"], ["rejected", "Rejected"]];
  const SEALED_TABS = { medical: 1, food: 1, health: 1 };
  const STATUS = { new: ["New", "●", "new"], pending_approval: ["Waiting for you", "⏸", "wait"], approved: ["Approved", "✓", "ok"], sent: ["Sent", "✓", "ok"], rejected: ["Rejected", "✕", "grey"] };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const view = el("div"); view.id = "intake-view"; view.className = "hidden";
  const head = el("div", "in-head"), tabsHost = el("div", "in-tabs"), body = el("div", "in-body"), toast = el("div", "in-toast hidden");
  tabsHost.setAttribute("role", "tablist"); toast.setAttribute("role", "status");
  view.append(head, tabsHost, body, toast);
  document.getElementById("main-panel").appendChild(view);

  const S = { data: null, msgs: null, tab: "all", pendingOnly: false, openId: null, sealedOpen: {}, busy: false, err: "", sel: {}, notes: {}, confirmAll: false, confirmFrozen: null, thumbs: {}, edits: {} };
  let open = false, navEl = null, toastTimer = null;
  const say = (t) => { toast.textContent = t; toast.classList.remove("hidden"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add("hidden"), 6000); };
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }); };

  function refresh() {
    // messages you sent from the phone to an agent: read separately, so a failure here never hides the Intake list
    if (api.messages) api.messages().then((m) => { if (!open) return; setMsgs(m && m.ok ? m : null); navCount(); render(); }).catch(() => { S.msgs = null; });
    return api.load().then((r) => {
      if (!open) return;
      if (!r || !r.ok) { S.err = (r && r.reason) || "Intake could not load."; S.data = null; } else { S.err = ""; S.data = r; navCount(); }
      render();
    }).catch(() => { S.err = "Intake could not load."; render(); });
  }

  // held phone messages (waiting for approval) count with the commands: same amber button, same nav badge
  // Every refresh of the message list goes through here: if the held set changed while the "approve all" bar is open, the bar closes (nothing new is ever approved unseen).
  function setMsgs(m) {
    S.msgs = m;
    if (S.confirmAll && S.confirmFrozen && m && HL.changed(S.confirmFrozen, m.rows, S.edits)) { S.confirmAll = false; S.confirmFrozen = null; say("New messages arrived, review again."); }
  }
  const heldRows = () => (S.msgs ? S.msgs.rows.filter((m) => m.status === "held" && !m.queued) : []);
  function navCount() { if (window.intakeNavCount && S.data) window.intakeNavCount(S.data.counts.pending + heldRows().length); }

  function statusChip(st) { const s = STATUS[st] || STATUS.new; const c = el("span", "in-chip in-" + s[2]); c.append(el("span", "in-chip-i", s[1]), document.createTextNode(" " + s[0])); return c; }

  function render() {
    const keepScroll = body.scrollTop;
    head.textContent = ""; tabsHost.textContent = ""; body.textContent = "";
    head.append(el("h2", "in-title", "Intake"), el("span", "in-sp"));
    if (S.err) { body.append(el("p", "in-note", S.err)); return; }
    if (!S.data) { body.append(el("p", "in-note", "Loading…")); return; }
    const c = S.data.counts, waitingN = c.pending + heldRows().length;
    const btn = el("button", "in-approve-btn" + (waitingN ? "" : " in-zero"));
    btn.type = "button";
    btn.append(el("b", "in-approve-n", String(waitingN)), document.createTextNode(waitingN ? " waiting for your approval ›" : " waiting ✓"));
    btn.addEventListener("click", () => { S.pendingOnly = waitingN ? !S.pendingOnly : false; S.tab = "all"; S.openId = null; render(); });
    head.append(btn);
    if (S.data.synced) body.append(el("p", "in-note in-warn", "Warning: the Intake folder is inside a synced folder (Dropbox, OneDrive or similar). Anyone who can write there could forge entries. Move it to a local, unsynced folder in Setup (intakeDir)."));
    if (S.data.requireVerified === false) body.append(el("p", "in-note in-warn", "Warning: phone signing is not live yet, so Intake cannot tell that an item really came from your phone. Check each one before you approve."));
    if (S.openId) return renderItem();
    for (const [id, label] of TABS) {
      const b = el("button", "in-tab" + (S.tab === id ? " active" : ""), label + " " + (id === "all" ? c.all + (S.msgs ? S.msgs.total : 0) : id === "msgs" ? (S.msgs ? S.msgs.total : 0) : c[id] || 0));
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
    if (S.tab === "msgs") { renderMessages(); body.scrollTop = keepScroll; return; }
    let rows = S.data.rows.filter((r) => (S.tab === "all" ? !r.sealed : r.tab === S.tab));
    if (S.pendingOnly) rows = rows.filter((r) => r.status === "pending_approval" && !r.sealed);
    // The All tab also lists the messages you sent to agents (read-only rows), mixed in by time. Not in the "waiting for approval" filter.
    // Held phone messages (not delivered, need approval) are in All and in the "waiting for approval" filter; delivered ones only in All.
    if (S.tab === "all" && S.msgs) rows = rows.concat(S.msgs.rows.filter((m) => !S.pendingOnly || (m.status === "held" && !m.queued)).map((m) => ({ _msg: m, created: m.at })));
    if (S.tab === "all" && heldRows().length) body.append(heldToolbar());
    rows.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    if (!rows.length) { const e = el("div", "in-empty"); e.append(el("b", "", S.data.empty ? "📬 Nothing from your phone yet" : "✓ Nothing here"), el("p", "", "Record a note or snap a receipt on the Pixel and it appears here within a minute.")); body.append(e); return; }
    for (const r of rows) {
      if (r._msg) { body.append(messageRow(r._msg)); continue; }
      const row = el("button", "in-row"); row.type = "button";
      const t = el("div", "in-row-t");
      t.append(el("b", "", r.sealed ? "🔒 Sealed item" : (r.title || "(no text)")));
      const meta = el("div", "in-row-m");
      meta.append(statusChip(r.status), el("span", "", [r.sealed ? r.kind : (r.sub || r.kind), r.suggestedAgent ? "→ " + r.suggestedAgent : "", when(r.created), r.verified ? "verified" : ""].filter(Boolean).join(" · ")));
      t.append(meta); row.append(t);
      row.addEventListener("click", () => { S.openId = r.id; render(); });
      body.append(row);
    }
    body.scrollTop = keepScroll;
  }

  // "Messages to agents": what you sent from the phone to an agent, and whether the agent has read and handled it. Read-only, no actions.
  function renderMessages() {
    body.append(el("p", "in-note", "Messages you sent from the phone to an agent. They wait here until you approve them; nothing reaches an agent before that. \"Delivered\" means the PC put it in the agent's phone_inbox; \"Read and handled\" means the agent marked it done. Agents check their inbox when they next run, so Delivered can take a while."));
    const m = S.msgs;
    if (!m) { body.append(el("p", "in-note", "Loading…")); return; }
    if (!m.rows.length) { const e = el("div", "in-empty"); e.append(el("b", "", "📬 No messages to agents yet"), el("p", "", "Use an agent tile on the phone's Home screen: write, record or snap, then Send.")); body.append(e); return; }
    if (heldRows().length) body.append(heldToolbar());
    for (const r of m.rows) body.append(messageRow(r));
  }

  // ---- held messages: read them in full, optionally add a note, then approve or reject. Nothing reaches an agent before that.
  function decideMessages(ids, action) {
    if (S.busy || !ids.length) return;
    S.busy = true;
    const notes = {}; for (const id of ids) if (action === "approve" && S.notes[id] && S.notes[id].trim()) notes[id] = S.notes[id];
    const edits = action === "approve" ? HL.editsFor(ids, S.msgs ? S.msgs.rows : [], S.edits) : {};
    const CHUNK = 200, chunks = []; for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    let done = 0, bad = 0, failure = "";
    const next = () => {
      if (!chunks.length) return Promise.resolve();
      const part = chunks.shift(), pn = {}, pe = {}; for (const id of part) { if (notes[id]) pn[id] = notes[id]; if (edits[id]) pe[id] = edits[id]; }
      return api.decideMessages(part, action, pn, pe).then((d) => {
        if (!d || !d.ok) { failure = (d && d.reason) || "That did not work."; chunks.length = 0; return; }
        bad += d.results.filter((x) => !x.ok).length; done += d.done;
        for (const x of d.results) if (x.ok) { delete S.sel[x.id]; delete S.notes[x.id]; delete S.edits[x.id]; }
        return next();
      });
    };
    next().then(() => {
      S.busy = false; S.confirmAll = false; S.confirmFrozen = null;
      if (failure && !done) { say(failure); render(); return; }
      say((action === "approve" ? "Approved " : "Rejected ") + done + (done === 1 ? " message" : " messages") + (action === "approve" ? (done === 1 ? ". The PC delivers it within a minute." : ". The PC delivers them within a minute.") : ".") + (bad || failure ? " " + (bad || "Some") + " could not be changed." : ""));
      refresh();
    }).catch(() => { S.busy = false; say("That did not work."); render(); });
  }
  function heldToolbar() {
    const rows = heldRows(), ids = rows.map((r) => r.id), picked = ids.filter((id) => S.sel[id]);
    const pickedPlan = HL.plan(picked, S.msgs ? S.msgs.rows : []), liveSkipped = HL.plan(ids, S.msgs ? S.msgs.rows : []).skipped;
    const bar = el("div", "in-held-bar");
    bar.append(el("b", "", rows.length + " phone message" + (rows.length === 1 ? "" : "s") + " waiting for your approval"), el("span", "in-note", " Not delivered to any agent yet."));
    if (S.msgs && S.msgs.synced) { bar.append(el("p", "in-note in-warn", "The Intake folder is inside a synced folder, so approving is switched off. Move it to a local folder in Setup (intakeDir).")); return bar; }
    const act = el("div", "in-actions");
    const mk = (cls, label, fn, off) => { const b = el("button", "in-btn " + cls, label); b.type = "button"; b.disabled = !!off || S.busy; b.addEventListener("click", fn); act.append(b); return b; };
    mk("in-go", "Approve all waiting (" + (ids.length - liveSkipped) + ")", () => { S.confirmFrozen = HL.freeze(S.msgs.rows, S.edits); S.confirmAll = true; render(); }, ids.length === liveSkipped);
    mk("", "Approve selected (" + pickedPlan.ids.length + ")", () => {
      const p = HL.plan(picked, S.msgs ? S.msgs.rows : []);      // exactly the ticked ids, minus voice notes still transcribing
      if (p.skipped) say(p.skipped + (p.skipped === 1 ? " voice note is" : " voice notes are") + " still transcribing and " + (p.skipped === 1 ? "was" : "were") + " skipped.");
      decideMessages(p.ids, "approve");
    }, !pickedPlan.ids.length);
    mk("", "Reject selected (" + picked.length + ")", () => decideMessages(picked, "reject"), !picked.length);
    bar.append(act);
    if (liveSkipped) bar.append(el("p", "in-note in-warn", liveSkipped + (liveSkipped === 1 ? " voice note is" : " voice notes are") + " still transcribing; approving is off for " + (liveSkipped === 1 ? "it" : "them") + " until the transcript is ready or has failed."));
    if (S.confirmAll && S.confirmFrozen) {
      const fr = S.confirmFrozen, n = fr.ids.length, withNotes = fr.ids.filter((id) => S.notes[id] && S.notes[id].trim()).length;
      const box = el("div", "in-confirm");
      box.append(el("b", "", "Approve these " + n + " waiting message" + (n === 1 ? "" : "s") + "?" + (withNotes ? " (" + withNotes + " with a note you added)" : "") + (fr.skipped ? " " + fr.skipped + " voice note" + (fr.skipped === 1 ? "" : "s") + " still transcribing will be skipped." : "")),
        el("p", "in-note in-warn", "Only approve messages you recognise as yours."));
      const a2 = el("div", "in-actions");
      const yes = el("button", "in-btn in-go", "Yes, approve " + n), no = el("button", "in-btn", "Cancel"); yes.type = no.type = "button"; yes.disabled = S.busy;
      yes.addEventListener("click", () => {
        const p = HL.confirmIds(fr, S.msgs ? S.msgs.rows : [], S.edits);      // only the frozen ids, only if the held set is unchanged
        S.confirmAll = false; S.confirmFrozen = null;
        if (!p) { say("New messages arrived, review again."); render(); return; }
        if (p.skipped) say(p.skipped + " skipped (still transcribing).");
        decideMessages(p.ids, "approve");
      });
      no.addEventListener("click", () => { S.confirmAll = false; S.confirmFrozen = null; render(); });
      a2.append(yes, no); box.append(a2); bar.append(box);
    }
    return bar;
  }
  // Editable copy of the phone text or the transcript. The draft lives in S.edits[id] (kept across re-renders); only a real difference from the original counts as an edit.
  function editBox(r, field, original) {
    const wrap = el("div", "in-editbox");
    const ta = el("textarea", "in-edit-ta"); ta.rows = 6; ta.maxLength = 20000; ta.dir = "auto";
    ta.setAttribute("aria-label", field === "text" ? "Phone text (editable)" : "Voice transcript (editable)");
    const d = S.edits[r.id] || {};
    ta.value = typeof d[field] === "string" ? d[field] : original;
    const tag = el("span", "in-chip in-new", "edited"), reset = el("a", "in-reset", "reset to original"); reset.href = "#"; reset.setAttribute("role", "button");
    const sync = () => {
      const isEdit = ta.value.trim() !== String(original).trim();
      tag.classList.toggle("hidden", !isEdit); reset.classList.toggle("hidden", !isEdit);
      const cur = S.edits[r.id] || {};
      if (isEdit) cur[field] = ta.value; else delete cur[field];
      if (Object.keys(cur).length) S.edits[r.id] = cur; else delete S.edits[r.id];
      ta.style.height = "auto"; ta.style.height = Math.min(Math.max(ta.scrollHeight + 2, 110), 420) + "px";
    };
    ta.addEventListener("input", () => {
      sync();
      if (S.confirmAll && S.confirmFrozen && HL.changed(S.confirmFrozen, S.msgs ? S.msgs.rows : [], S.edits)) {      // an edit after the confirm bar opened: review again
        S.confirmAll = false; S.confirmFrozen = null;
        const box = document.querySelector(".in-confirm"); if (box) box.remove();
        say("A message was edited, review again.");
      }
    });
    reset.addEventListener("click", (e) => { e.preventDefault(); ta.value = original; sync(); });
    wrap.append(ta, el("div", "in-edit-bar")); wrap.lastChild.append(tag, reset);
    sync0(ta, tag, reset, original);
    return wrap;
  }
  function sync0(ta, tag, reset, original) { const e = ta.value.trim() !== String(original).trim(); tag.classList.toggle("hidden", !e); reset.classList.toggle("hidden", !e); }
  const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  function heldRow(r) {
    const row = el("div", "in-row in-held");
    const t = el("div", "in-row-t");
    const meta = el("div", "in-row-m");
    const failed = r.queued === "approve" && r.deliveryFailed;
    const chip = el("span", "in-chip in-wait"); chip.append(el("span", "in-chip-i", "⏸"), document.createTextNode(failed ? " Approved, delivery failed - will retry" : r.queued ? (r.queued === "approve" ? " Approved, being delivered" : " Rejected, being removed") : " Waiting for your approval"));
    meta.append(chip, el("span", "", ["Message to " + r.agent, when(r.at), "NOT delivered yet"].filter(Boolean).join(" · ")));
    if (r.hidden) meta.append(el("span", "in-chip in-wait", "⚠ contained hidden characters (removed)"));
    const canEdit = !r.queued && !(S.msgs && S.msgs.synced);
    t.append(meta, canEdit ? editBox(r, "text", r.text || "") : el("div", "in-text", r.text || (r.voice ? "(no text, only a voice message)" : "(no text)")));
    if (r.voice) {
      const v = el("div", "in-voice");
      if (r.transcriptState === "ready") v.append(el("b", "", "Voice message, transcribed on the PC:"), canEdit ? editBox(r, "transcript", r.transcript || "") : el("div", "in-text", r.transcript || "(silent or empty)"));
      else if (r.transcriptState === "failed") v.append(el("b", "", "Voice message: transcription failed."), el("div", "in-note in-warn", "The audio is delivered unreviewed if you approve. You can type what it says below."), canEdit ? editBox(r, "transcript", "") : el("span"));
      else v.append(el("b", "", r.transcriptState === "waiting" ? "Voice message: waiting its turn to be transcribed (many voice notes queued)…" : "Voice message: transcribing…"), el("div", "in-note in-warn", "Approve is off until the transcript is ready or has failed."));
      t.append(v);
    }
    if (r.photos) {
      const strip = el("div", "in-thumbs"); strip.append(el("span", "in-note", r.photos + (r.photos === 1 ? " photo" : " photos") + (r.thumbs ? "" : " (no preview)")), el("span", "in-note in-warn", " Text inside a picture is not readable here but the agent will see it."));
      t.append(strip);
      if (r.thumbs) {
        const fill = (list) => { for (const u of list) { const im = el("img", "in-thumb"); im.src = u; im.alt = "photo preview"; strip.append(im); } };
        if (S.thumbs[r.id]) fill(S.thumbs[r.id]);
        else if (api.messageThumbs) api.messageThumbs(r.id).then((x) => { if (x && x.ok) { S.thumbs[r.id] = x.thumbs; if (open && strip.isConnected) fill(x.thumbs); } }).catch(() => {});
      }
    }
    if (r.video) t.append(el("div", "in-row-m", "Video: " + (r.videoName || "video") + ", " + fmtBytes(r.videoBytes || 0) + ". Delivered unreviewed (no preview)."));
    if (!(S.msgs && S.msgs.synced) && (!r.queued || failed)) {
      if (!r.queued) {
        const lab = el("label", "in-lab in-notebox", "Add a note for the agent (optional, sent with Approve)");
        const ta = el("textarea", "in-note-ta"); ta.rows = 2; ta.maxLength = 2000; ta.value = S.notes[r.id] || ""; ta.setAttribute("aria-label", "Note for the agent");
        const tag = el("span", "in-chip in-new" + (ta.value.trim() ? "" : " hidden"), "note added");
        ta.addEventListener("input", () => { S.notes[r.id] = ta.value; tag.classList.toggle("hidden", !ta.value.trim()); });
        lab.append(ta); t.append(tag, lab);
      }
      const act = el("div", "in-actions");
      const ok = el("button", "in-btn in-go", "✓ Approve"), no = el("button", "in-btn", "✕ Reject"); ok.type = no.type = "button"; ok.disabled = no.disabled = S.busy; ok.disabled = S.busy || !HL.approvable(r); if (!HL.approvable(r) && !r.queued) ok.title = "Wait for the transcript";
      ok.addEventListener("click", () => decideMessages([r.id], "approve")); no.addEventListener("click", () => decideMessages([r.id], "reject"));
      if (!r.queued) act.append(ok);
      act.append(no); t.append(act);
      if (!r.queued) {
        const cb = el("input"); cb.type = "checkbox"; cb.checked = !!S.sel[r.id]; cb.setAttribute("aria-label", "Select this message");
        cb.addEventListener("change", () => { S.sel[r.id] = cb.checked; render(); });
        row.append(cb);
      }
    }
    row.append(t);
    return row;
  }
  function messageRow(r) {
    if (r.status === "held") return heldRow(r);
    const row = el("div", "in-row");
    const t = el("div", "in-row-t");
    t.append(el("b", "", r.preview || "(no text)"));
    const meta = el("div", "in-row-m");
    const done = r.status === "handled";
    const chip = el("span", "in-chip " + (done ? "in-ok" : "in-wait")); chip.append(el("span", "in-chip-i", done ? "✓" : "●"), document.createTextNode(" " + (done ? "Read and handled" : "Delivered, not yet read")));
    meta.append(chip, el("span", "", ["Message to " + r.agent, when(r.at)].filter(Boolean).join(" · ")));
    t.append(meta); row.append(t);
    return row;
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

  let pollT = null;
  function schedulePoll() {
    clearInterval(pollT);
    pollT = setInterval(() => {
      if (!open || !api.messages || !S.msgs || !S.msgs.rows.some((m) => m.status === "held" && (m.transcriptState === "pending" || m.transcriptState === "waiting"))) return;
      const a = document.activeElement; if (a && a.tagName === "TEXTAREA") return;
      api.messages().then((m) => { if (open && m && m.ok) { setMsgs(m); render(); } }).catch(() => {});
    }, 10000);
  }
  const onKey = (e) => { if (e.key === "Escape" && open) { if (S.openId) { S.openId = null; render(); } else close(); e.preventDefault(); } };
  function openView() {
    if (open) return;
    if (window.viewManager) window.viewManager.closeAll();
    open = true; document.body.classList.add("intake-open"); view.classList.remove("hidden");
    if (navEl) navEl.classList.add("active");
    document.addEventListener("keydown", onKey);
    S.data = null; S.msgs = null; S.openId = null; S.sealedOpen = {}; S.sel = {}; S.notes = {}; S.confirmAll = false; S.confirmFrozen = null; S.thumbs = {}; S.edits = {}; render(); refresh(); schedulePoll();
  }
  function close() {
    if (!open) return;
    open = false; clearInterval(pollT); S.edits = {}; document.removeEventListener("keydown", onKey);
    document.body.classList.remove("intake-open"); view.classList.add("hidden");
    if (navEl) navEl.classList.remove("active");
    clearTimeout(toastTimer); S.data = null; S.msgs = null; S.sealedOpen = {}; S.sel = {}; S.notes = {}; S.confirmAll = false; S.thumbs = {};
    head.textContent = ""; tabsHost.textContent = ""; body.textContent = ""; toast.textContent = ""; toast.classList.add("hidden");   // nothing stays in the page
  }
  window.intakeView = { toggle(nav) { if (nav) navEl = nav; open ? close() : openView(); }, close };
})();
