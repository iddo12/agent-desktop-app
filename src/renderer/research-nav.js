// My Research sidebar entry (v1.87.0). The ONLY research code that runs at startup: one button. The view (research.js) and its stylesheet
// are fetched the first time the entry is clicked.
// v1.107.0: a blue unread badge (same look as My Daily's) with the number of new research findings the owner has not read. One read shortly after start,
// then again when the window is shown or focused (at most every 2 minutes, no timer loop); the open view pushes the new number through the "research-badge" event.
(function () {
  "use strict";
  if (!window.api || !window.api.research) return;
  const agentList = document.getElementById("agent-list");
  if (!agentList || !agentList.parentNode) return;

  const nav = document.createElement("button");
  nav.type = "button";
  nav.className = "research-nav";
  nav.dataset.systemNav = "research";          // the left pane turns an entry with this attribute into the My Research tile
  nav.title = "My Research - what the agents found this week: the COO's five, then every agent's findings.";
  const name = document.createElement("span");
  name.className = "research-nav-name";
  name.textContent = "My Research";
  nav.appendChild(name);
  const badge = document.createElement("span");
  badge.className = "research-nav-badge blue hidden";
  nav.appendChild(badge);
  function paintBadge(n) {
    n = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    badge.textContent = n ? (n > 99 ? "99+" : String(n)) : "";
    badge.classList.toggle("hidden", !n);
    badge.title = n + " new research finding" + (n === 1 ? "" : "s") + " you have not read";
    nav.dataset.unread = String(n);
  }
  function pollBadge() {
    if (!window.api.research.badge) return;
    window.api.research.badge().then((r) => { if (r && r.ok) paintBadge(r.count); }).catch(() => { /* keep the last number */ });
  }
  window.addEventListener("research-badge", (ev) => { if (ev && ev.detail) paintBadge(ev.detail.count); });
  // no timer loop: one read shortly after start, then whenever the window is shown or focused again (at most once every 2 minutes)
  let lastPoll = 0;
  const pollSoon = () => { if (document.hidden || Date.now() - lastPoll < 120000) return; lastPoll = Date.now(); pollBadge(); };
  setTimeout(() => { lastPoll = Date.now(); pollBadge(); }, 3000);
  document.addEventListener("visibilitychange", pollSoon);
  window.addEventListener("focus", pollSoon);
  agentList.parentNode.insertBefore(nav, document.getElementById("library-nav") || agentList);

  let loading = null;
  function ensure() {
    if (window.researchView) return Promise.resolve(window.researchView);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.href = "styles-research.css";
      document.head.appendChild(link);
      const mag = document.createElement("link");          // v1.91.0 magazine view (tokens --rm-*), loaded with the view, after the base sheet
      mag.rel = "stylesheet"; mag.href = "styles-research-mag.css";
      document.head.appendChild(mag);
      // v1.102.0: the pure filter logic (research-filter.js) loads first; research.js needs window.researchFilter
      const fl = document.createElement("script");
      fl.src = "research-filter.js";
      fl.onerror = () => reject(new Error("load failed"));
      fl.onload = () => {
        const s = document.createElement("script");
        s.src = "research.js";
        s.onload = () => (window.researchView ? resolve(window.researchView) : reject(new Error("no view")));
        s.onerror = () => reject(new Error("load failed"));
        document.body.appendChild(s);
      };
      document.body.appendChild(fl);
    }).catch((e) => { loading = null; throw e; });
    return loading;
  }
  nav.addEventListener("click", () => {
    ensure().then((v) => v.toggle(nav)).catch(() => { nav.title = "My Research could not load. Reload the window to try again."; });
  });
})();
