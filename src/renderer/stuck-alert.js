// v1.134.0 STUCK ALERT (Security, 2026-10-21). Shows, in plain words, an agent whose automatic restarts did not help ("STUCK 5 h - auto-restart
// failed", red) or that has several live copies with conversations (amber), in the agent list and in the chat header line that normally
// says "Working...". This is NOT the blocked "!" badge: blocked = waiting for a person, stuck = frozen. The state comes from the main
// process (src/stuckEscalation.js) through "stuck-state" events; main re-sends every watchdog tick (30 s) so the minute count stays fresh.
// textContent only.
(function () {
  "use strict";
  var states = {}; // agentPath -> { stuck: {label, detail, since, escalatedAt, freshFailed} | null, dup: {label, count} | null }

  // Pure: what to show for one state entry: { kind: "stuck" | "dup", label, title } or null.
  function pick(st) {
    if (!st) return null;
    if (st.stuck) return { kind: "stuck", label: st.stuck.label, title: st.stuck.label + ". " + (st.stuck.detail || "") + " This is not a normal wait: the agent is frozen. Open it, or use Restart Session / + New chat." };
    if (st.dup) return { kind: "dup", label: st.dup.label, title: st.dup.label + ". Click to see the copies, pick the one to keep and close the others." };
    return null;
  }
  // Pure helpers for the "Close a duplicate copy" dialog (v1.135.0).
  function fmtAge(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    if (m < 1) return "under a minute";
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60), r = m % 60;
    return h < 48 ? h + " h" + (r && h < 6 ? " " + r + " min" : "") : Math.round(h / 24) + " days";
  }
  // One copy's plain description (rows come from main: duplicateCopies.describeCopies()).
  function describeCopy(c) {
    var started = c.startedAt ? new Date(c.startedAt).toLocaleString() : "unknown";
    var state = c.busy ? "BUSY" : "idle for " + fmtAge(c.idleMs || 0);
    var bits = ["copy " + c.shortId, "started " + started, state];
    if (c.unfinished) bits.push("holds an unfinished turn");
    if (c.handoffResume) bits.push("started by a handoff reset");
    return bits.join(" - ");
  }
  // Default choice: keep the newest copy.
  function defaultKeep(copies) {
    var best = null;
    (copies || []).forEach(function (c) { if (!best || (c.startedAt || 0) >= (best.startedAt || 0)) best = c; });
    return best ? best.id : null;
  }
  window.StuckAlertPure = { pick: pick, describeCopy: describeCopy, defaultKeep: defaultKeep, fmtAge: fmtAge };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // The dialog: lists every live copy, lets the owner pick the one to KEEP, closes the others through main (textContent only).
  function openCloseDialog(agentPath) {
    var old = document.getElementById("dup-close-overlay"); if (old) old.remove();
    var overlay = el("div", "dup-overlay"); overlay.id = "dup-close-overlay";
    var box = el("div", "dup-dialog"); overlay.appendChild(box);
    var title = el("h3", "dup-title", "Close a duplicate copy");
    var intro = el("p", "dup-intro", "This agent has more than one live copy. Pick the copy to KEEP; the others are closed through Agent Desktop. The last copy is never closed.");
    var list = el("div", "dup-list");
    var msg = el("div", "dup-msg");
    var btns = el("div", "dup-btns");
    var closeBtn = el("button", "dup-go", "Close the other copies");
    var refreshBtn = el("button", "dup-refresh", "Refresh");
    var cancelBtn = el("button", "dup-cancel", "Cancel");
    btns.appendChild(closeBtn); btns.appendChild(refreshBtn); btns.appendChild(cancelBtn);
    box.appendChild(title); box.appendChild(intro); box.appendChild(list); box.appendChild(msg); box.appendChild(btns);
    document.body.appendChild(overlay);
    var copies = [], keepId = null, confirmBusy = false;
    function done() { overlay.remove(); }
    cancelBtn.onclick = done;
    overlay.addEventListener("click", function (ev) { if (ev.target === overlay) done(); });
    function render() {
      list.textContent = "";
      copies.forEach(function (c) {
        var row = el("label", "dup-row" + (c.id === keepId ? " keep" : ""));
        var radio = document.createElement("input"); radio.type = "radio"; radio.name = "dup-keep"; radio.value = c.id; radio.checked = c.id === keepId;
        radio.onchange = function () { keepId = c.id; confirmBusy = false; msg.textContent = ""; render(); };
        var txt = el("div", "dup-row-text");
        txt.appendChild(el("div", "dup-row-head", (c.id === keepId ? "KEEP  " : "close  ") + describeCopy(c)));
        txt.appendChild(el("div", "dup-row-prev", c.preview || "(no message yet)"));
        row.appendChild(radio); row.appendChild(txt); list.appendChild(row);
      });
      closeBtn.disabled = copies.length < 2 || !keepId;
      closeBtn.textContent = confirmBusy ? "Close busy copy anyway" : "Close the other copies";
    }
    function load(keepMsg) {
      if (!keepMsg) msg.textContent = "Looking at the live copies...";
      window.api.getDuplicateCopies(agentPath).then(function (r) {
        if (!r || !r.ok) { msg.textContent = "Could not read the copies: " + ((r && r.error) || "unknown error"); return; }
        copies = r.copies || [];
        if (!keepId || !copies.some(function (c) { return c.id === keepId; })) keepId = defaultKeep(copies);
        if (!keepMsg) msg.textContent = copies.length < 2 ? "Only one live copy is left. Nothing to close." : "";
        render();
      }).catch(function (e) { msg.textContent = "Could not read the copies: " + (e && e.message); });
    }
    refreshBtn.onclick = function () { confirmBusy = false; load(); };
    closeBtn.onclick = function () {
      closeBtn.disabled = true; msg.textContent = "Closing...";
      window.api.closeDuplicateCopies(agentPath, keepId, null, confirmBusy).then(function (r) {
        if (r && r.ok) {
          confirmBusy = false;
          msg.textContent = "Closed " + r.closed.length + " copy(ies). " + r.remaining + " left running.";
          load(true);
          setTimeout(function () { if (copies.length < 2) done(); }, 2500);
          return;
        }
        if (r && r.needsConfirm) { confirmBusy = true; msg.textContent = r.error; render(); return; }
        msg.textContent = "Not closed: " + ((r && r.error) || "unknown error"); render();
      }).catch(function (e) { msg.textContent = "Not closed: " + (e && e.message); render(); });
    };
    load();
  }
  window.openDuplicateCloseDialog = openCloseDialog;

  function onState(snap) {
    if (!snap || !snap.agentPath) return;
    if (!snap.stuck && !snap.dup) delete states[snap.agentPath]; else states[snap.agentPath] = snap;
    paintList();
    try { if (window.updateThinkingIndicator) window.updateThinkingIndicator(); } catch (e) { /* the 1 s tick repaints anyway */ }
  }

  function paintList() {
    var rows = document.querySelectorAll("#agent-list .agent-item");
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i], p = row.dataset.agentPath, shown = pick(p && states[p]);
      var pill = row.querySelector(".stuck-pill");
      var dupBtn = row.querySelector(".dup-close-btn");
      if ((!shown || shown.kind !== "dup") && dupBtn) { dupBtn.remove(); dupBtn = null; }
      if (!shown) { if (pill) pill.remove(); row.classList.remove("xp-stuck", "xp-dup"); continue; }
      row.classList.toggle("xp-stuck", shown.kind === "stuck");
      row.classList.toggle("xp-dup", shown.kind === "dup");
      if (!pill) {
        pill = document.createElement("div");
        pill.setAttribute("role", "status");
        var host = row.querySelector(".agent-item-text") || row;
        host.appendChild(pill);
      }
      pill.className = "stuck-pill " + shown.kind;
      if (pill.textContent !== shown.label) pill.textContent = shown.label;
      pill.title = shown.title;
      if (shown.kind === "dup" && !dupBtn) {
        dupBtn = el("button", "dup-close-btn", "Close a copy...");
        dupBtn.title = "Show the live copies of this agent and close the ones you do not want";
        (function (agentPath) { dupBtn.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); openCloseDialog(agentPath); }; })(p);
        pill.parentNode.appendChild(dupBtn);
      }
    }
  }

  // Header line (the element that shows "Working..."): returns true when it took over the line.
  function paint(agentPath, indEl) {
    var shown = pick(agentPath && states[agentPath]);
    if (!shown) { indEl.classList.remove("stuck-failing", "dup-copies"); return false; }
    indEl.classList.remove("conn-lost", "long");
    indEl.classList.toggle("stuck-failing", shown.kind === "stuck");
    indEl.classList.toggle("dup-copies", shown.kind === "dup");
    var text = (shown.kind === "stuck" ? "\u25A0 " : "\u25CF ") + shown.label + (shown.kind === "dup" ? " (click to close a copy)" : "");
    indEl._dupAgent = shown.kind === "dup" ? agentPath : "";
    if (!indEl._dupBound && indEl.addEventListener) { indEl._dupBound = true; indEl.addEventListener("click", function () { if (indEl._dupAgent) openCloseDialog(indEl._dupAgent); }); }
    if (indEl.textContent !== text) indEl.textContent = text;
    indEl.title = shown.title;
    indEl.classList.remove("hidden");
    return true;
  }

  window.stuckAlert = { paint: paint, _states: states };
  try {
    window.api.onStuckState(onState);
    window.api.getStuckStates().then(function (list) { (list || []).forEach(onState); }).catch(function () {});
    setInterval(paintList, 2000); // the list is rebuilt on refresh; put the label back
  } catch (e) { /* older preload: stays off */ }
})();
