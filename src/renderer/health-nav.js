// My Health sidebar entry (v1.81.0). This is the ONLY health code that runs at startup: one button. The view (health.js) and its
// stylesheet are fetched the first time the entry is clicked, so a PC that never opens My Health never loads them.
// No timers, no polling, no badge number (a count would put a health fact on the sidebar).
(function () {
  "use strict";
  if (!window.api || !window.api.health) return;
  const agentList = document.getElementById("agent-list");
  if (!agentList || !agentList.parentNode) return;

  const nav = document.createElement("button");
  nav.type = "button";
  nav.className = "health-nav";
  nav.dataset.systemNav = "health";            // the left pane turns an entry with this attribute into the Health tile
  nav.title = "My Health - your numbers, labs and medications. Stays on this PC.";
  const name = document.createElement("span");
  name.className = "health-nav-name";
  name.textContent = "My Health";
  nav.appendChild(name);
  agentList.parentNode.insertBefore(nav, document.getElementById("library-nav") || agentList);

  let loading = null;
  function ensure() {
    if (window.healthView) return Promise.resolve(window.healthView);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.href = "styles-health.css";
      document.head.appendChild(link);
      const c = document.createElement("script");
      c.src = "health-chart.js";
      c.onerror = () => reject(new Error("load failed"));
      c.onload = () => {
        const s = document.createElement("script");
        s.src = "health.js";
        s.onload = () => (window.healthView ? resolve(window.healthView) : reject(new Error("no view")));
        s.onerror = () => reject(new Error("load failed"));
        document.body.appendChild(s);
      };
      document.body.appendChild(c);
    }).catch((e) => { loading = null; throw e; });
    return loading;
  }
  nav.addEventListener("click", () => {
    ensure().then((v) => v.toggle(nav)).catch(() => { nav.title = "My Health could not load. Reload the window to try again."; });
  });
})();
