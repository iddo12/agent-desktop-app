// v1.153.0 APPROVALS POP-UP: one panel listing every agent that waits on a permission prompt, with Approve all / Deny all and per-agent Approve / Deny.
// Only the owner's real click sends anything (isTrusted), and each click carries exactly what was drawn; main re-checks every prompt (src/approvalsPopup.js).
// Nothing is approved automatically and a prompt that appears after the panel was drawn is never covered by "Approve all".
(function () {
  if (!window.api || !window.api.approvalsList) return;
  const WIN = !!(document.body && document.body.dataset.thyraWindow === "1");   // the dock window: always shown, compact, own preload
  let docked = false, onTop = true;
  let box = null, items = [], hidden = false, hiddenKey = "", busy = false, lastDraw = "", changedAt = 0, shownKey = "";
  const msgs = new Map();
  const STR = { title: (n) => (n === 1 ? "1 agent is waiting for your approval" : n + " agents are waiting for your approval"), all: (n) => "Approve all " + n, denyAll: "Deny all", yes: "Approve", no: "Deny", hide: "Hide",
    notYet: "The prompt is not on this agent's screen yet; it cannot be answered from here.", note: "Your click goes into each agent's prompt. Nothing is approved on its own. Every answer is logged." };
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const fmt = (ms) => { const s = Math.round(ms / 1000); return s < 90 ? s + " s" : s < 5400 ? Math.round(s / 60) + " min" : (s / 3600).toFixed(1) + " h"; };
  function ensure() {
    if (box) return box;
    if (WIN) { box = document.getElementById("approvals-popup"); return box; }
    box = el("div"); box.id = "approvals-popup"; box.className = "hidden"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Agents waiting for approval");
    document.body.appendChild(box); return box;
  }
  const keyOf = (list) => list.map((i) => i.agentPath + "|" + i.since + "|" + (i.answerable ? 1 : 0)).join("\n");
  function draw() {
    const b = ensure(), k = keyOf(items);
    if (!WIN && (docked || !items.length || (hidden && hiddenKey === k))) { b.classList.add("hidden"); b.textContent = ""; lastDraw = ""; return; }
    if (hidden && hiddenKey !== k) hidden = false;     // something new arrived: show again
    if (k !== shownKey) { shownKey = k; changedAt = Date.now(); setTimeout(draw, 1100); }   // buttons stay disabled for 1 s after the list changes, so a click cannot land on a different set than the one the owner was looking at
    const sig = k + "|" + busy + "|" + (Date.now() - changedAt < 1000) + "|" + Array.from(msgs.entries()).join(",");
    if (sig === lastDraw) { b.querySelectorAll(".ap-wait").forEach((w, i) => { if (items[i]) w.textContent = fmt(Date.now() - items[i].since); }); return; }
    lastDraw = sig;
    const settling = Date.now() - changedAt < 1000;
    b.textContent = "";
    const act = items.filter((i) => i.answerable);
    const head = el("div", "ap-head"); head.append(el("span", "", items.length ? STR.title(items.length) : "Approvals"));
    const x = el("button", "ap-x", "×"); x.title = STR.hide; x.addEventListener("click", (ev) => { if (!ev.isTrusted) return; hidden = true; hiddenKey = keyOf(items); draw(); });
    if (WIN) {
      const pin = el("button", "ap-x", onTop ? "On top" : "Normal"); pin.title = "Keep this window above all others"; pin.addEventListener("click", async (ev) => { if (!ev.isTrusted) return; const r = await window.api.approvalsWindow("ontop-toggle").catch(() => null); if (r) { onTop = !!r.onTop; lastDraw = ""; draw(); } });
      const cl = el("button", "ap-x", "Close"); cl.addEventListener("click", (ev) => { if (ev.isTrusted) window.api.approvalsWindow("close"); });
      head.append(pin, cl);
    } else head.append(x);
    const list = el("div", "ap-list");
    for (const it of items) {
      const row = el("div", "ap-item"), top = el("div", "ap-top");
      top.append(el("span", "ap-name", it.name));
      if (it.tool) top.append(el("span", "ap-tool", it.tool));
      top.append(el("span", "ap-wait", fmt(Date.now() - it.since)));
      row.append(top, el("div", "ap-act", it.action || it.needs));
      const btns = el("div", "ap-btns");
      if (it.answerable) {
        const mk = (label, cls, ans) => { const bt = el("button", cls, label); bt.disabled = busy || settling; bt.addEventListener("click", (ev) => { if (ev.isTrusted) decide([it], ans, "item"); }); return bt; };
        btns.append(mk(STR.yes, "ap-yes", "approve"), mk(STR.no, "ap-no", "deny"));
      } else btns.append(el("span", "ap-msg", STR.notYet));
      const m = msgs.get(it.agentPath); if (m) btns.append(el("span", "ap-msg", m));
      row.append(btns); list.append(row);
    }
    const foot = el("div", "ap-foot");
    if (act.length) {
      const all = el("button", "ap-all", STR.all(act.length)); all.disabled = busy || settling; all.addEventListener("click", (ev) => { if (ev.isTrusted) decide(act, "approve", "all"); });
      const da = el("button", "ap-denyall", STR.denyAll); da.disabled = busy || settling; da.addEventListener("click", (ev) => { if (ev.isTrusted) decide(act, "deny", "all"); });
      foot.append(all, da);
    }
    if (WIN && !items.length) list.append(el("div", "ap-empty", "Nothing waiting"));
    b.append(head, list, foot, el("div", "ap-note", STR.note));
    b.classList.remove("hidden");
  }
  async function decide(list, answer, via) {
    if (busy) return;
    busy = true; draw();
    const decisions = list.map((i) => ({ agentPath: i.agentPath, since: i.since, needs: i.needs, answer }));
    let r;
    try { r = await window.api.approvalsDecide(decisions, via); } catch (e) { r = { ok: false, error: e.message, results: [] }; }
    for (const d of decisions) msgs.delete(d.agentPath);
    if (!r || !r.ok) for (const d of decisions) msgs.set(d.agentPath, "Could not answer: " + ((r && r.error) || "unknown"));
    else for (const x of r.results) msgs.set(x.agentPath, x.ok ? (answer === "approve" ? "Approved" : "Denied") : "Not answered: " + x.reason);
    busy = false; await refresh();
    setTimeout(() => { msgs.clear(); lastDraw = ""; draw(); }, 6000);
  }
  async function refresh() {
    try { const r = await window.api.approvalsList(); items = r && r.ok ? r.items : []; docked = !!(r && r.docked); } catch (e) { items = []; }
    draw();
  }
  // the always-there entry point in the main window: a small "Approvals" chip (count when something waits) that opens the dock window
  if (!WIN && window.api.approvalsWindow) {
    const chip = el("button", "ap-chip", "Approvals"); chip.id = "approvals-chip"; chip.title = "Open the approvals window (Ctrl+Alt+A): small, movable, can stay on top of everything";
    chip.addEventListener("click", (ev) => { if (ev.isTrusted) window.api.approvalsWindow("open"); });
    document.body.appendChild(chip);
    const upd = () => { chip.textContent = items.length ? "Approvals " + items.length : "Approvals"; chip.classList.toggle("ap-chip-hot", items.length > 0); chip.style.display = docked ? "none" : ""; };
    const oldDraw = draw; draw = function () { oldDraw(); upd(); };   // eslint-disable-line no-func-assign
  }
  window.api.onApprovalsChanged(() => refresh());
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  if (WIN && window.api.approvalsWindow) window.api.approvalsWindow("state").then((r) => { if (r) onTop = !!r.onTop; lastDraw = ""; draw(); }).catch(() => {});
  refresh();
})();
