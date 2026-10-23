// Projects sidebar entry (Project Autopilot). Startup cost: one button. The red number (projects blocked, waiting for you) is checked at start, whenever the ledger folder changes,
// and every 5 min as a safety net while the window is visible. The view (projects.js) and its stylesheet load on the first click.
(function () {
  "use strict";
  if (!window.api || !window.api.projects) return;
  const agentList = document.getElementById("agent-list");
  if (!agentList || !agentList.parentNode) return;

  const nav = document.createElement("button");
  nav.type = "button";
  nav.className = "projects-nav";
  nav.dataset.systemNav = "projects";
  nav.title = "Projects - what the team builds on its own, and the few things it needs from you.";
  // the name/badge reuse the Task List tile classes so the left-pane tile rules (labels, badge position) apply with no extra rules
  const name = document.createElement("span"); name.className = "tasklist-nav-name projects-nav-name"; name.textContent = "Projects";
  const badge = document.createElement("span"); badge.className = "tasklist-nav-badge projects-nav-badge hidden"; badge.setAttribute("aria-live", "polite");
  nav.append(name, badge);
  const anchor = document.querySelector(".tasklist-nav") || document.querySelector(".intake-nav") || document.querySelector(".finance-nav");
  if (anchor && anchor.parentNode === agentList.parentNode) agentList.parentNode.insertBefore(nav, anchor.nextSibling);
  else agentList.parentNode.insertBefore(nav, agentList);

  function setCount(n) {
    badge.textContent = String(n);
    badge.classList.toggle("hidden", !(n > 0));
    nav.title = n > 0 ? "Projects - " + n + " blocked, waiting for you" : "Projects - nothing is blocked";
  }
  window.projectsNavCount = setCount;
  function pollCount() {
    if (document.hidden) return;
    window.api.projects.list().then((r) => { if (r && r.ok && r.counts) setCount(r.counts.red); }).catch(() => {});
  }
  pollCount();
  // the folder watcher (started by the first list) pushes "projects-changed"; the slow timer is only a safety net
  try { if (window.api.projects.onChanged) window.api.projects.onChanged(pollCount); } catch (e) { /* no push channel */ }
  setInterval(pollCount, 300000);

  let loading = null;
  function ensure() {
    if (window.projectsView) return Promise.resolve(window.projectsView);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      if (!document.querySelector('link[href="styles-projects.css"]')) {
        const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "styles-projects.css"; document.head.appendChild(link);
      }
      const s = document.createElement("script"); s.src = "projects.js";
      s.onload = () => (window.projectsView ? resolve(window.projectsView) : reject(new Error("no view")));
      s.onerror = () => reject(new Error("load failed"));
      document.body.appendChild(s);
    }).catch((e) => { loading = null; throw e; });
    return loading;
  }
  nav.addEventListener("click", () => { ensure().then((v) => v.toggle(nav)).catch(() => { nav.title = "Projects could not load. Reload the window to try again."; }); });
  window.projectsOpen = () => ensure().then((v) => { if (!v.isOpen()) v.toggle(nav); });   // the Task List's "Projects" tab can call this
})();
