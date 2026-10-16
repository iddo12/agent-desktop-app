// My Finance sidebar entry (v1.90.0 skeleton). The ONLY finance code that runs at startup: one button, placed right after My Health.
// The view (finance.js) and its stylesheet are fetched the first time the entry is clicked. No timers, no polling, and no badge
// (a number on the sidebar would put a money fact on screen).
(function () {
  "use strict";
  if (!window.api || !window.api.finance) return;
  const agentList = document.getElementById("agent-list");
  if (!agentList || !agentList.parentNode) return;

  const nav = document.createElement("button");
  nav.type = "button";
  nav.className = "finance-nav";
  nav.dataset.systemNav = "finance";           // the left pane turns an entry with this attribute into the My Finance tile
  nav.title = "My Finance - money in and out, accounts, receipts. Stays on this PC.";
  const name = document.createElement("span");
  name.className = "finance-nav-name";
  name.textContent = "My Finance";
  const short = document.createElement("span");
  short.className = "finance-nav-short";        // shown instead of the full name in the narrow layout C tile
  short.textContent = "Finance";
  nav.append(name, short);
  const health = document.querySelector(".health-nav");
  if (health && health.parentNode === agentList.parentNode) agentList.parentNode.insertBefore(nav, health.nextSibling);
  else agentList.parentNode.insertBefore(nav, document.getElementById("library-nav") || agentList);

  let loading = null;
  function ensure() {
    if (window.financeView) return Promise.resolve(window.financeView);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      if (!document.querySelector('link[href="styles-finance.css"]')) {   // a retry after a failed load does not add a second copy
        const link = document.createElement("link");
        link.rel = "stylesheet"; link.href = "styles-finance.css";
        document.head.appendChild(link);
      }
      const load = (src, ok, bad) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = bad; document.body.appendChild(s); };
      // the feed pages (slice 2) first: finance.js picks them up when it starts; if they fail to load the other tabs still work
      const view = () => load("finance.js", () => (window.financeView ? resolve(window.financeView) : reject(new Error("no view"))), () => reject(new Error("load failed")));
      load("finance-pages.js", view, view);
    }).catch((e) => { loading = null; throw e; });
    return loading;
  }
  nav.addEventListener("click", () => {
    ensure().then((v) => v.toggle(nav)).catch(() => { nav.title = "My Finance could not load. Reload the window to try again."; });
  });
})();
