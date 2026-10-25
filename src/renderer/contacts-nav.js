// Contacts sidebar entry. Startup cost: one button. The view (contacts.js) and its stylesheet load on the first click.
(function () {
  "use strict";
  if (!window.api || !window.api.contacts) return;
  const agentList = document.getElementById("agent-list");
  if (!agentList || !agentList.parentNode) return;

  const nav = document.createElement("button");
  nav.type = "button";
  nav.className = "contacts-nav";
  nav.dataset.systemNav = "contacts";
  nav.title = "Contacts - the companies you deal with and who to talk to there.";
  const name = document.createElement("span"); name.className = "contacts-nav-name"; name.textContent = "Contacts";
  nav.append(name);
  const anchor = document.querySelector(".tasklist-nav") || document.querySelector(".intake-nav") || document.querySelector(".finance-nav");
  if (anchor && anchor.parentNode === agentList.parentNode) agentList.parentNode.insertBefore(nav, anchor.nextSibling);
  else agentList.parentNode.insertBefore(nav, agentList);

  let loading = null;
  function ensure() {
    if (window.contactsView) return Promise.resolve(window.contactsView);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      if (!document.querySelector('link[href="styles-contacts.css"]')) {
        const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "styles-contacts.css"; document.head.appendChild(link);
      }
      const s = document.createElement("script"); s.src = "contacts.js";
      s.onload = () => (window.contactsView ? resolve(window.contactsView) : reject(new Error("no view")));
      s.onerror = () => reject(new Error("load failed"));
      document.body.appendChild(s);
    }).catch((e) => { loading = null; throw e; });
    return loading;
  }
  nav.addEventListener("click", () => { ensure().then((v) => v.toggle(nav)).catch(() => { nav.title = "Contacts could not load. Reload the window to try again."; }); });
})();
