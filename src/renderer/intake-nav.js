// Intake sidebar entry. Startup cost: one button and one cheap count check every 60 s while the window is visible. The view (intake.js) and its
// stylesheet load on the first click. The amber number is items waiting for approval; sealed items never count.
(function () {
  "use strict";
  if (!window.api || !window.api.intake) return;
  const agentList = document.getElementById("agent-list");
  if (!agentList || !agentList.parentNode) return;

  const nav = document.createElement("button");
  nav.type = "button";
  nav.className = "intake-nav";
  nav.dataset.systemNav = "intake";
  nav.title = "Intake - notes, ideas, receipts and commands from your phone. Commands wait here for your approval.";
  const name = document.createElement("span"); name.className = "intake-nav-name"; name.textContent = "Intake";
  const badge = document.createElement("span"); badge.className = "intake-nav-badge hidden"; badge.setAttribute("aria-live", "polite");
  nav.append(name, badge);
  const fin = document.querySelector(".finance-nav");
  if (fin && fin.parentNode === agentList.parentNode) agentList.parentNode.insertBefore(nav, fin.nextSibling);
  else agentList.parentNode.insertBefore(nav, agentList);

  function setCount(n) {
    badge.textContent = String(n);
    badge.classList.toggle("hidden", !(n > 0));
    nav.title = n > 0 ? "Intake - " + n + " waiting for your approval" : "Intake - nothing waiting";
  }
  window.intakeNavCount = setCount;
  function poll() {
    if (document.hidden) return;
    window.api.intake.load().then((r) => { if (r && r.ok && r.counts) setCount(r.counts.pending); }).catch(() => {});
  }
  poll();
  setInterval(poll, 60000);

  let loading = null;
  function ensure() {
    if (window.intakeView) return Promise.resolve(window.intakeView);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      if (!document.querySelector('link[href="styles-intake.css"]')) {
        const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "styles-intake.css"; document.head.appendChild(link);
      }
      const s = document.createElement("script"); s.src = "intake.js";
      s.onload = () => (window.intakeView ? resolve(window.intakeView) : reject(new Error("no view")));
      s.onerror = () => reject(new Error("load failed"));
      document.body.appendChild(s);
    }).catch((e) => { loading = null; throw e; });
    return loading;
  }
  nav.addEventListener("click", () => { ensure().then((v) => v.toggle(nav)).catch(() => { nav.title = "Intake could not load. Reload the window to try again."; }); });
})();
