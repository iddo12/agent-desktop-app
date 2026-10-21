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
    if (st.dup) return { kind: "dup", label: st.dup.label, title: st.dup.label + ". Pick the copy to keep and stop the others (Agent Desktop never stops a copy that holds a conversation)." };
    return null;
  }
  window.StuckAlertPure = { pick: pick };

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
    }
  }

  // Header line (the element that shows "Working..."): returns true when it took over the line.
  function paint(agentPath, indEl) {
    var shown = pick(agentPath && states[agentPath]);
    if (!shown) { indEl.classList.remove("stuck-failing", "dup-copies"); return false; }
    indEl.classList.remove("conn-lost", "long");
    indEl.classList.toggle("stuck-failing", shown.kind === "stuck");
    indEl.classList.toggle("dup-copies", shown.kind === "dup");
    var text = (shown.kind === "stuck" ? "\u25A0 " : "\u25CF ") + shown.label;
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
