// The calm "needs setup" card (v1.121.0) that a screen shows instead of an error or an empty page when its feature has not been set up yet.
// One card, one button: "Set up" opens the Setup panel. Words come from setup-strings.js (English + Hebrew); textContent only, no timers, no I/O.
//   window.NeedsSetup.card("argus") -> HTMLElement
(function () {
  "use strict";
  const SS = window.SetupStrings;
  let code = "en";
  try { if (/^he\b/i.test(navigator.language || "")) code = "he"; } catch (e) { /* English */ }
  function card(featureId) {
    const L = SS ? SS.pick(code) : null;
    const f = SS ? SS.feature(code, featureId) : ["", featureId, "", "", ""];
    const box = document.createElement("div");
    box.className = "needs-setup-card";
    box.setAttribute("role", "status");
    if (L) { box.setAttribute("dir", L.dir); box.setAttribute("lang", code); }
    const h = document.createElement("div"); h.className = "needs-setup-title"; h.textContent = (f[0] ? f[0] + " " : "") + f[1];
    const p = document.createElement("p"); p.className = "needs-setup-body"; p.textContent = (L && L.tileNeedsBody ? L.tileNeedsBody : "This needs a little setup first.");
    const n = document.createElement("p"); n.className = "needs-setup-needs"; n.textContent = (L ? L.needs : "Needs: ") + (f[3] || "");
    const b = document.createElement("button"); b.type = "button"; b.className = "needs-setup-btn"; b.textContent = L ? L.btnSetup : "Set up";
    b.addEventListener("click", () => { try { window.setupView.open(); } catch (e) { /* the panel is not available in this build */ } });
    box.append(h, p, n, b);
    return box;
  }
  window.NeedsSetup = { card };
})();
