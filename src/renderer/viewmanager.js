// View manager (v1.84.2). The sidebar destinations (ARGUS, Memory, My Daily, IRIS, Library, Tools, My Health) are separate
// scripts that each closed only SOME of the others by hand, so tiles could stack: Memory + Library + IRIS highlighted at once,
// a click on Memory landing on a Library that was still open underneath, and so on. This is the one place that enforces
// "exactly one destination open": whichever overlay class lands on <body> last wins, every other one is closed through its
// OWN close control (so its timers/listeners are released), and stale "active" highlights on the tiles are cleared.
// No timers, no polling: a MutationObserver on <body class> only.
(function () {
  "use strict";
  const body = document.body;
  if (!body || window.viewManager) return;

  const click = (sel) => () => { const n = document.querySelector(sel); if (n) n.click(); };
  const VIEWS = [
    { id: "argus",   cls: "argus-open",   nav: ".argus-nav",   close: click("#argus-view .argus-close") },
    { id: "iris",    cls: "iris-open",    nav: ".iris-nav",    close: click("#iris-view .iris-close") },
    { id: "library", cls: "library-open", nav: "#library-nav .library-nav-btn", close: click("#library-view .library-close") },
    { id: "daily",   cls: "daily-open",   nav: ".daily-nav",   close: click(".daily-nav") },          // its nav toggles
    { id: "memory",  cls: "memory-open",  nav: ".memory-nav",
      close: () => { body.classList.remove("memory-open"); const v = document.getElementById("memory-view"); if (v) v.classList.add("hidden"); } },
    { id: "tools",   cls: "tools-open",   nav: ".tools-nav",   close: () => { if (window.toolsView) window.toolsView.close(); } },
    { id: "research", cls: "research-open", nav: ".research-nav", close: () => { if (window.researchView) window.researchView.close(); } },
    { id: "health",  cls: "health-open",  nav: ".health-nav",  close: () => { if (window.healthView) window.healthView.close(); } },
    { id: "designs", cls: "designs-open", nav: ".designs-nav", close: () => { if (window.designsView) window.designsView.close(); } },
    { id: "setup",   cls: "setup-open",   nav: "#setup-nav",   close: () => { if (window.setupView) window.setupView.close(); } },
    { id: "finance", cls: "finance-open", nav: ".finance-nav", close: () => { if (window.financeView) window.financeView.close(); else if (window.demoFinance) window.demoFinance.close(); } },
    { id: "intake", cls: "intake-open", nav: ".intake-nav", close: () => { if (window.intakeView) window.intakeView.close(); } },
  ];

  const openSet = () => new Set(VIEWS.filter((v) => body.classList.contains(v.cls)).map((v) => v.id));
  let prev = openSet();
  let busy = false;

  function settle() {
    if (busy) return;
    busy = true;
    try {
      const now = openSet();
      const added = [...now].filter((id) => !prev.has(id));
      if (now.size > 1) {
        // The newest wins. If we cannot tell which is newest (several appeared in one tick), keep the last one in VIEWS order.
        const winner = added.length ? added[added.length - 1] : [...now][now.size - 1];
        for (const v of VIEWS) {
          if (v.id !== winner && now.has(v.id)) { try { v.close(); } catch (e) { /* a view that cannot close itself is forced below */ } }
        }
        // Belt and braces: if a close control did nothing, drop the overlay class and hide the pane by id.
        for (const v of VIEWS) {
          if (v.id !== winner && body.classList.contains(v.cls)) {
            body.classList.remove(v.cls);
            const pane = document.getElementById(v.id + "-view");
            if (pane) pane.classList.add("hidden");
          }
        }
      }
      // Highlights: a tile is "active" only while its own view is open.
      const open = openSet();
      for (const v of VIEWS) {
        if (open.has(v.id)) continue;
        document.querySelectorAll(v.nav).forEach((n) => n.classList.remove("active"));
      }
      prev = open;
    } finally { busy = false; }
  }

  // The closers above change <body class> themselves; that fires this again, and settle() is idempotent.
  new MutationObserver(settle).observe(body, { attributes: true, attributeFilter: ["class"] });

  window.viewManager = { open: () => [...openSet()], closeAll: () => { for (const v of VIEWS) if (body.classList.contains(v.cls)) { try { v.close(); } catch (e) {} } settle(); } };
})();
