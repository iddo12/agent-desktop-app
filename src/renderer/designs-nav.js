// My Designs sidebar entry (v1.125.0). The ONLY designs code that runs at startup: one button. The view (designs.js), its filter logic
// (../designsFilter.js) and its stylesheet are fetched the first time the entry is clicked. No timers, no polling, no badge.
(function () {
  "use strict";
  if (!window.api || !window.api.designs) return;
  const agentList = document.getElementById("agent-list");
  if (!agentList || !agentList.parentNode) return;

  const nav = document.createElement("button");
  nav.type = "button";
  nav.className = "designs-nav";
  nav.dataset.systemNav = "designs";           // the left pane turns an entry with this attribute into the My Designs tile
  nav.title = "My Designs - your numbered designs (motion graphics and stills). Say \"use my design #N\".";
  const name = document.createElement("span");
  name.className = "designs-nav-name";
  name.textContent = "My Designs";
  const short = document.createElement("span");
  short.className = "designs-nav-short";       // shown instead of the full name in the narrow layout C tile
  short.textContent = "Designs";
  nav.append(name, short);
  const anchor = document.querySelector(".finance-nav") || document.querySelector(".tools-nav");
  if (anchor && anchor.parentNode === agentList.parentNode) agentList.parentNode.insertBefore(nav, anchor.nextSibling);
  else agentList.parentNode.insertBefore(nav, document.getElementById("library-nav") || agentList);

  let loading = null;
  function addScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error("load failed"));
      document.body.appendChild(s);
    });
  }
  function ensure() {
    if (window.designsView) return Promise.resolve(window.designsView);
    if (loading) return loading;
    loading = (async () => {
      if (!document.querySelector('link[href="styles-designs.css"]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet"; link.href = "styles-designs.css";
        document.head.appendChild(link);
      }
      if (!window.DesignsFilter) await addScript("../designsFilter.js");
      await addScript("designs.js");
      if (!window.designsView) throw new Error("no view");
      return window.designsView;
    })().catch((e) => { loading = null; throw e; });
    return loading;
  }
  nav.addEventListener("click", () => {
    ensure().then((v) => v.toggle(nav)).catch(() => { nav.title = "My Designs could not load. Reload the window to try again."; });
  });
})();
