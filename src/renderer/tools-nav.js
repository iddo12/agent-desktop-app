// Tools sidebar entry (v1.83.0). The ONLY tools code that runs at startup: one button. The view (tools.js) and its stylesheet are
// fetched the first time the entry is clicked. No timers, no polling, no badge.
(function () {
  "use strict";
  if (!window.api || !window.api.tools) return;
  const agentList = document.getElementById("agent-list");
  if (!agentList || !agentList.parentNode) return;

  const nav = document.createElement("button");
  nav.type = "button";
  nav.className = "tools-nav";
  nav.dataset.systemNav = "tools";             // the left pane turns an entry with this attribute into the Tools tile
  nav.title = "My Tools - the things we built: start them, see their state and releases.";
  const name = document.createElement("span");
  name.className = "tools-nav-name";
  name.textContent = "My Tools";
  nav.appendChild(name);
  agentList.parentNode.insertBefore(nav, document.getElementById("library-nav") || agentList);

  let loading = null;
  function ensure() {
    if (window.toolsView) return Promise.resolve(window.toolsView);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.href = "styles-tools.css";
      document.head.appendChild(link);
      const s = document.createElement("script");
      s.src = "tools.js";
      s.onload = () => (window.toolsView ? resolve(window.toolsView) : reject(new Error("no view")));
      s.onerror = () => reject(new Error("load failed"));
      document.body.appendChild(s);
    }).catch((e) => { loading = null; throw e; });
    return loading;
  }
  nav.addEventListener("click", () => {
    ensure().then((v) => v.toggle(nav)).catch(() => { nav.title = "Tools could not load. Reload the window to try again."; });
  });
})();
