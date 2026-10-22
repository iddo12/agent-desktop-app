// Task List sidebar entry. Startup cost: one button. The amber number (tasks that need you) is checked every 60 s while the window is visible.
// The view (tasklist.js) and its stylesheet load on the first click.
(function () {
  "use strict";
  if (!window.api || !window.api.tasklist) return;
  const agentList = document.getElementById("agent-list");
  if (!agentList || !agentList.parentNode) return;

  const nav = document.createElement("button");
  nav.type = "button";
  nav.className = "tasklist-nav";
  nav.dataset.systemNav = "tasklist";
  nav.title = "Task List - what each agent is working on, in plain words.";
  const name = document.createElement("span"); name.className = "tasklist-nav-name"; name.textContent = "Task List";
  const badge = document.createElement("span"); badge.className = "tasklist-nav-badge hidden"; badge.setAttribute("aria-live", "polite");
  nav.append(name, badge);
  const anchor = document.querySelector(".intake-nav") || document.querySelector(".finance-nav");
  if (anchor && anchor.parentNode === agentList.parentNode) agentList.parentNode.insertBefore(nav, anchor.nextSibling);
  else agentList.parentNode.insertBefore(nav, agentList);

  function setCount(n) {
    badge.textContent = String(n);
    badge.classList.toggle("hidden", !(n > 0));
    nav.title = n > 0 ? "Task List - " + n + " need you" : "Task List - nothing needs you";
  }
  window.tasklistNavCount = setCount;
  function pollCount() {
    if (document.hidden) return;
    window.api.tasklist.load("all").then((r) => { if (r && r.ok && r.counts) setCount(r.counts.needs_you); }).catch(() => {});
  }
  pollCount();
  setInterval(pollCount, 60000);

  let loading = null;
  function ensure() {
    if (window.tasklistView) return Promise.resolve(window.tasklistView);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      if (!document.querySelector('link[href="styles-tasklist.css"]')) {
        const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "styles-tasklist.css"; document.head.appendChild(link);
      }
      const s = document.createElement("script"); s.src = "tasklist.js";
      s.onload = () => (window.tasklistView ? resolve(window.tasklistView) : reject(new Error("no view")));
      s.onerror = () => reject(new Error("load failed"));
      document.body.appendChild(s);
    }).catch((e) => { loading = null; throw e; });
    return loading;
  }
  nav.addEventListener("click", () => { ensure().then((v) => v.toggle(nav)).catch(() => { nav.title = "The Task List could not load. Reload the window to try again."; }); });
})();
