// Predicted replies (v1.108.0) - renderer side. Logic and model call live in src/predict.js (main); this file only
//   1. decides WHEN to ask (an agent that is open here has finished a turn and spoke last),
//   2. shows the answer as ghost text by borrowing the message box's own placeholder (so it lines up with auto-grow, RTL,
//      dark/light and every view for free, and the browser hides it by itself the moment any text is in the box),
//   3. Tab / Right-arrow accept it INTO the box (never sends); typing, paste, Esc, switching agent dismiss it.
// It reads these globals from renderer.js: activeAgentPath, terminals, chatInputEl, sendInputBtn.
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.api || !window.api.predictRequest) return;

  const RECENT_MS = 30 * 60 * 1000; // never guess about a conversation that went quiet long ago
  const SETTLE_MS = 1200; // let the "working" flag settle before asking
  const HINT = "   ⇥ Tab";
  const basePlaceholder = chatInputEl.placeholder;
  const baseDir = chatInputEl.getAttribute("dir");
  const baseLabel = chatInputEl.getAttribute("aria-label");

  let enabled = true;
  let ghost = null; // { text, agentPath, key }
  let timer = null;

  function isHebrew(s) {
    return /^[^A-Za-z֐-׿]*[֐-׿]/.test(s);
  }

  function dismiss() {
    clearTimeout(timer);
    if (!ghost) return;
    const agentPath = ghost.agentPath;
    ghost = null;
    chatInputEl.placeholder = basePlaceholder;
    chatInputEl.classList.remove("predict-ghost");
    if (baseDir === null) chatInputEl.removeAttribute("dir");
    else chatInputEl.setAttribute("dir", baseDir);
    if (baseLabel === null) chatInputEl.removeAttribute("aria-label");
    else chatInputEl.setAttribute("aria-label", baseLabel);
    chatInputEl.removeAttribute("aria-keyshortcuts");
    try { window.api.predictCancel(agentPath); } catch (e) { /* app closing */ }
  }

  function show(text, agentPath, key) {
    ghost = { text, agentPath, key };
    chatInputEl.placeholder = text + HINT;
    chatInputEl.classList.add("predict-ghost");
    if (isHebrew(text)) chatInputEl.setAttribute("dir", "rtl"); // placeholders follow the box direction; put it back on dismiss
    chatInputEl.setAttribute("aria-label", "Message this agent. Suggested reply: " + text + ". Press Tab to use it, Escape to hide it.");
    chatInputEl.setAttribute("aria-keyshortcuts", "Tab");
  }

  function accept() {
    if (!ghost) return false;
    const text = ghost.text;
    dismiss();
    chatInputEl.value = text; // fills the box only; sending stays his
    chatInputEl.dispatchEvent(new Event("input", { bubbles: true })); // auto-grow + draft saving
    chatInputEl.focus();
    chatInputEl.setSelectionRange(text.length, text.length);
    return true;
  }

  function workingNow(session) {
    return !!(session && (session.busy || session.transcriptWorking || session.turnStartedAt));
  }
  function lastTurn(blocks) {
    let i = blocks.length - 1;
    while (i >= 0 && blocks[i].role === "status") i--;
    const last = i >= 0 ? blocks[i] : null;
    if (!last || last.role !== "agent") return null;
    const ts = Date.parse(last.timestamp);
    if (!ts || Date.now() - ts > RECENT_MS) return null;
    const text = (last.lines || []).join("\n");
    const users = [];
    for (let j = i - 1; j >= 0 && users.length < 3; j--) {
      if (blocks[j].role === "user") users.unshift((blocks[j].lines || []).join(" "));
    }
    return { key: last.timestamp + ":" + text.length, text, users };
  }

  // Called from renderer.js after every transcript read of the open agent (cheap: a few comparisons unless a new turn ended).
  function consider(agentPath, session, blocks) {
    if (!enabled || agentPath !== activeAgentPath || document.hidden || !session || !Array.isArray(blocks)) return;
    if (workingNow(session) || chatInputEl.value || (session.pendingSent && session.pendingSent.length) || (session.sendQueue && session.sendQueue.length)) return;
    const turn = lastTurn(blocks);
    if (!turn || session.predictKey === turn.key) return;
    session.predictKey = turn.key; // once per turn
    clearTimeout(timer);
    timer = setTimeout(() => ask(agentPath, session, turn), SETTLE_MS);
  }

  async function ask(agentPath, session, turn) {
    if (!enabled || agentPath !== activeAgentPath || document.hidden || workingNow(session) || chatInputEl.value) return;
    let r = null;
    try {
      r = await window.api.predictRequest({ agentPath, turnKey: turn.key, assistantText: turn.text, userMessages: turn.users, boxEmpty: true });
    } catch (e) {
      return;
    }
    // stale: he switched agent, started typing, a new turn began, the window was hidden, or the setting was turned off
    if (!r || !r.suggestion || !enabled || agentPath !== activeAgentPath || session.predictKey !== turn.key || document.hidden) return;
    if (chatInputEl.value || workingNow(session) || (session.pendingSent && session.pendingSent.length)) return;
    if (ghost) dismiss();
    show(r.suggestion, agentPath, turn.key);
  }

  function onSwitch(agentPath) {
    dismiss();
    try { window.api.predictOpen(agentPath); } catch (e) { /* ignore */ }
  }

  // ---- keys: capture phase so Tab / Right never reach the box's own handling while a suggestion is showing
  chatInputEl.addEventListener("keydown", (e) => {
    if (!ghost) return;
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key === "Tab" && !e.shiftKey && !mod && !chatInputEl.value) { e.preventDefault(); accept(); return; }
    if (e.key === "ArrowRight" && !e.shiftKey && !mod && !chatInputEl.value && chatInputEl.selectionStart === chatInputEl.value.length) { e.preventDefault(); accept(); return; }
    if (e.key === "Escape") { e.preventDefault(); dismiss(); return; }
    if (["Shift", "Control", "Alt", "Meta", "CapsLock", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "F5", "F12"].includes(e.key)) return;
    dismiss(); // anything else is typing (or sending)
  }, true);
  for (const ev of ["input", "paste", "drop", "compositionstart", "cut"]) chatInputEl.addEventListener(ev, dismiss, true);
  if (typeof sendInputBtn !== "undefined" && sendInputBtn) sendInputBtn.addEventListener("click", dismiss, true);
  document.addEventListener("visibilitychange", () => { if (document.hidden) dismiss(); });

  // ---- the setting (sidebar checkbox)
  const cb = document.getElementById("predict-pref-cb");
  window.api.predictPrefsGet().then((p) => {
    enabled = !(p && p.enabled === false);
    if (cb) cb.checked = enabled;
  }).catch(() => {});
  if (cb) {
    cb.addEventListener("change", async () => {
      enabled = cb.checked;
      if (!enabled) dismiss();
      try { await window.api.predictPrefsSet({ enabled }); } catch (e) { /* keeps the in-memory value for this run */ }
    });
  }
  if (typeof activeAgentPath === "string" && activeAgentPath) { try { window.api.predictOpen(activeAgentPath); } catch (e) { /* ignore */ } }

  window.predictReplies = { consider, onSwitch, dismiss, _state: () => ({ enabled, ghost: ghost && { ...ghost } }) };
})();
