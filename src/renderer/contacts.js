// Contacts view (layout A: search box + category chips). Company-first: pick a company, see who to talk to now.
// All names, emails, subjects and notes are untrusted: they are set with textContent only. No Send button anywhere (replies happen in Betterbird).
(function () {
  "use strict";
  const api = window.api && window.api.contacts;
  if (!api) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (text, cls, fn) => { const b = el("button", "ct-btn" + (cls ? " " + cls : ""), text); b.type = "button"; b.addEventListener("click", fn); return b; };
  const TAG = { "they wrote": ["ct-t-they", "They wrote"], "waiting on them": ["ct-t-wait", "Waiting on them"], quiet: ["ct-t-quiet", "Quiet"] };
  const ago = (d) => (d == null ? "never" : d === 0 ? "today" : d < 60 ? d + " d ago" : d < 700 ? Math.round(d / 30) + " mo ago" : Math.round(d / 365) + " y ago");
  const initials = (n) => (String(n).replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join("") || "?").toUpperCase();

  const view = el("div"); view.id = "contacts-view"; view.className = "hidden";
  const head = el("div", "ct-head"), chips = el("div", "ct-chips"), show = el("div", "ct-show"), main = el("div", "ct-main"), foot = el("div", "ct-foot");
  const list = el("div", "ct-list"), detail = el("div", "ct-detail");
  main.append(list, detail); view.append(head, chips, show, main, foot);
  document.getElementById("main-panel").appendChild(view);

  const search = el("input", "ct-search"); search.type = "search"; search.placeholder = "Search a company, person, email or category ( / )"; search.setAttribute("aria-label", "Search contacts");
  const S = { q: "", category: "", filter: "", sort: "latest", offset: 0, rows: [], total: 0, chips: null, meta: null, sel: null, selKind: "", err: "", mode: "list", people: [] };
  let open = false, off = null, seq = 0, debounce = null, noteTimer = null;

  function load(more) {
    const mine = ++seq; if (!more) { S.offset = 0; list.scrollTop = 0; }
    return api.list({ q: S.q, category: S.category, filter: S.filter, sort: S.sort, offset: S.offset }).then((r) => {
      if (!open || mine !== seq) return;
      if (!r || !r.ok) { S.err = (r && r.reason) || "Contacts could not load."; S.rows = []; render(); return; }
      S.err = ""; S.chips = r.chips; S.meta = r.meta; S.total = r.page.total; S.people = r.people || [];
      S.rows = more ? S.rows.concat(r.page.rows) : r.page.rows; render();
    }).catch(() => { S.err = "Contacts could not load."; render(); });
  }

  function renderHead() {
    head.textContent = ""; const t = el("h2", "ct-title", "Contacts");
    const sort = el("select", "ct-inp"); sort.setAttribute("aria-label", "Sort");
    [["latest", "Latest contact"], ["az", "A to Z"], ["category", "Category"]].forEach(([v, l]) => { const o = el("option", "", l); o.value = v; if (S.sort === v) o.selected = true; sort.append(o); });
    sort.addEventListener("change", () => { S.sort = sort.value; load(); });
    head.append(t, search, sort);
    if (S.chips && S.chips.uncategorised) head.append(btn("Review suggestions (" + S.chips.uncategorised + " without a category)", "pri", openSuggestions));
  }
  function chip(label, n, on, fn) { const b = el("button", "ct-chip" + (on ? " on" : ""), label); b.type = "button"; if (n != null) b.append(el("b", "", String(n))); b.setAttribute("aria-pressed", on ? "true" : "false"); b.addEventListener("click", fn); return b; }
  function renderChips() {
    chips.textContent = show.textContent = ""; const c = S.chips; if (!c) return;
    chips.append(chip("All", c.total, !S.category, () => { S.category = ""; load(); }));
    Object.keys(c.counts).sort((a, b) => c.counts[b] - c.counts[a] || a.localeCompare(b)).forEach((k) => chips.append(chip(k, c.counts[k], S.category === k, () => { S.category = S.category === k ? "" : k; load(); })));
    if (c.uncategorised) chips.append(chip("Uncategorised", c.uncategorised, S.category === "__none", () => { S.category = S.category === "__none" ? "" : "__none"; load(); }));
    show.append(el("span", "", "Show:"));
    [["", "all", null], ["needs", "Needs my reply", c.needs], ["waiting", "Waiting on them", c.waiting], ["quiet", "Quiet over 60 d", c.quiet]].forEach(([f, l, n]) => show.append(chip(l, n, S.filter === f, () => { S.filter = f; load(); })));
  }
  function rowFor(r) {
    const b = el("button", "ct-row" + (S.selKind === "company" && S.sel === r.id ? " on" : "")); b.type = "button";
    const t = el("div", "ct-rt"); t.append(el("div", "ct-rn", r.name), el("div", "ct-rs", (r.cats.length ? r.cats.join(", ") + " · " : "") + "last contact " + ago(r.daysAgo) + (r.dir === "in" ? " · they wrote last" : r.dir === "out" ? " · I wrote last" : "") + " · " + r.current + " current"));
    b.append(el("span", "ct-ini", initials(r.name)), t);
    if (r.tag && TAG[r.tag]) b.append(el("span", "ct-tag " + TAG[r.tag][0], TAG[r.tag][1] + (r.tag === "quiet" && r.daysAgo != null ? " " + r.daysAgo + " d" : "")));
    b.addEventListener("click", () => { openCompany(r.id); }); return b;
  }
  function peopleBlock() {
    list.append(el("div", "ct-sh ct-empty", "People"));
    S.people.slice(0, 8).forEach((p) => { const b = el("button", "ct-row"); b.type = "button"; const t = el("div", "ct-rt"); t.append(el("div", "ct-rn", p.name), el("div", "ct-rs", p.company)); b.append(el("span", "ct-ini", initials(p.name)), t); b.addEventListener("click", () => openPerson(p.id)); list.append(b); });
  }
  function renderList() {
    list.textContent = "";
    if (S.err) { list.append(el("p", "ct-empty", S.err)); return; }
    if (!S.rows.length) { if (S.q && S.people.length) { peopleBlock(); return; } list.append(el("p", "ct-empty", S.q ? "Nothing matches that search." : S.filter ? "Nothing in this view. That is good news." : "No contacts yet. Waiting for the Personal Assistant agent's export.")); return; }
    S.rows.forEach((r) => list.append(rowFor(r)));
    if (S.rows.length < S.total) { const m = btn("Show " + Math.min(50, S.total - S.rows.length) + " more", "", () => { S.offset = S.rows.length; load(true); }); m.style.margin = "10px 14px"; list.append(m); }
    if (S.q && S.people.length) { peopleBlock(); }
  }
  function renderFoot() {
    foot.textContent = ""; const m = S.meta; if (!m) return;
    if (m.unknownPeople) foot.append(el("span", "", m.unknownPeople + " people have no company (shown only by search)"));
    foot.append(el("span", "", m.generatedAt ? "Data from " + m.generatedAt.slice(0, 16).replace("T", " ") : "No data time"));
    if (m.stale) foot.append(el("span", "ct-warn", "Warning: the contact list is " + m.ageDays + " days old"));
  }
  function render() {
    if (S.mode === "suggest") return;
    renderHead(); renderChips(); renderList(); renderFoot(); if (!S.sel) { detail.textContent = ""; detail.append(el("p", "ct-empty", S.chips && S.chips.uncategorised ? "Pick a company to see who to talk to. " + S.chips.uncategorised + " companies have no category yet." : "Pick a company to see who to talk to.")); }
    view.classList.toggle("ct-showdetail", !!S.sel);
  }

  // ---- company page
  function saved(n) { const s = el("span", "ct-saved"); n.append(s); return (t) => { s.textContent = t; }; }
  function noteBox(parent, label, kind, id, value) {
    const sec = el("div", "ct-sec"); sec.append(el("div", "ct-sh", label));
    const ta = el("textarea", "ct-note"); ta.value = value || ""; ta.maxLength = 4000; ta.setAttribute("aria-label", label); sec.append(ta);
    const say = saved(sec); let t = null;
    const save = () => { clearTimeout(t); api.setNote(kind, id, ta.value).then((r) => { say(r && r.ok ? "Saved " + new Date().toTimeString().slice(0, 5) : (r && r.reason) || "Not saved"); }).catch(() => say("Not saved")); };
    let dirty = false;
    ta.addEventListener("input", () => { dirty = true; clearTimeout(t); say("Typing..."); t = setTimeout(() => { dirty = false; save(); }, 900); }); ta.addEventListener("blur", () => { if (dirty) { dirty = false; clearTimeout(t); save(); } });
    parent.append(sec); return ta;
  }
  function openCompany(id) {
    S.sel = id; S.selKind = "company"; if (S.mode === "suggest") { S.mode = "list"; } renderList();
    api.company(id).then((r) => {
      if (S.sel !== id || S.selKind !== "company") return; detail.textContent = "";
      if (!r || !r.ok) { detail.append(el("p", "ct-empty", (r && r.reason) || "Could not load.")); return; }
      const c = r.company;
      detail.append(btn("Back to list", "ct-back", () => { S.sel = null; render(); }));
      detail.append(el("h2", "ct-title", c.name));
      const cs = el("div", "ct-sec"); const cats = el("div", "ct-cats");
      const setCats = (list2) => api.setCategories(c.id, list2).then((x) => { if (x && x.ok) { openCompany(c.id); load(); } });
      c.categories.forEach((k) => { const w = el("span", "ct-cat", k); const x = el("button", "", "×"); x.type = "button"; x.setAttribute("aria-label", "Remove category " + k); x.addEventListener("click", () => setCats(c.categories.filter((y) => y !== k))); w.append(x); cats.append(w); });
      const add = el("input", "ct-inp"); add.placeholder = "+ add category"; add.maxLength = 40; add.setAttribute("aria-label", "Add category");
      add.addEventListener("keydown", (e) => { if (e.key === "Enter" && add.value.trim()) { e.preventDefault(); setCats(c.categories.concat([add.value.trim()])); } });
      cats.append(add); cs.append(cats); detail.append(cs);
      const lk = el("div", "ct-links");
      const linkEdit = (kind, label) => { const cur = c.links && c.links[kind]; const w = el("span", ""); w.append(el("span", "", label + ": ")); const i = el("input", "ct-inp"); i.value = cur || ""; i.placeholder = kind === "web" ? "https://..." : "+972 ..."; i.setAttribute("aria-label", label); i.addEventListener("change", () => api.setLink(c.id, kind, i.value.trim()).then((x) => { i.title = x && x.ok ? "Saved" : (x && x.reason) || "Not saved"; if (!(x && x.ok)) i.value = cur || ""; })); w.append(i); return w; };
      lk.append(linkEdit("web", "Website"), linkEdit("phone", "Phone"));
      if (c.domain) lk.append(el("span", "", "Domain: " + c.domain)); if (c.aliases.length) lk.append(el("span", "", "Also: " + c.aliases.join(", ")));
      detail.append(lk);
      const who = el("div", "ct-sec"); who.append(el("div", "ct-sh", "Who to talk to"));
      if (!c.current.length) who.append(el("p", "ct-rs", "Nobody has written or been written to in the last 12 months."));
      c.current.forEach((p) => who.append(personCard(p, c)));
      detail.append(who);
      const rest = c.people.filter((p) => !c.current.some((x) => x.id === p.id));
      if (rest.length) { const sec = el("div", "ct-sec"); sec.append(el("div", "ct-sh", "Other people (" + rest.length + ")")); rest.slice(0, 40).forEach((p) => sec.append(personCard(p, c))); detail.append(sec); }
      noteBox(detail, "Company note", "company", c.id, c.note); noteBox(detail, "Handover", "handover", c.id, c.handover);
      view.classList.add("ct-showdetail");
    }).catch(() => {});
  }
  function personCard(p, c) {
    const card = el("button", "ct-card ct-row"); card.type = "button"; card.style.borderRadius = "10px";
    const t = el("div", "ct-rt"); t.append(el("div", "ct-rn", p.name || "(no name)"), el("div", "ct-rs", (p.role && p.role.text ? p.role.text + " · " : "") + "last " + ago(p.daysAgo) + (p.dir === "in" ? " · they wrote" : p.dir === "out" ? " · I wrote" : "")));
    card.append(el("span", "ct-ini", initials(p.name)), t);
    if (p.silent) card.append(el("span", "ct-tag ct-t-wait", "Silent " + ago(p.daysAgo).replace(" ago", "")));
    else if (p.reply === "needs") card.append(el("span", "ct-tag ct-t-they", "Needs my reply")); else if (p.reply === "waiting") card.append(el("span", "ct-tag ct-t-wait", "Waiting on them"));
    if (p.automated) card.append(el("span", "ct-tag ct-t-quiet", "Automated"));
    card.addEventListener("click", () => openPerson(p.id)); return card;
  }
  function openPerson(id) {
    S.sel = id; S.selKind = "person";
    api.person(id).then((r) => {
      if (S.sel !== id || S.selKind !== "person") return; detail.textContent = "";
      if (!r || !r.ok) { detail.append(el("p", "ct-empty", (r && r.reason) || "Could not load.")); return; }
      const p = r.person;
      detail.append(btn("‹ " + p.company, "", () => openCompany(p.companyId)));
      detail.append(el("h2", "ct-title", p.name || "(no name)"));
      detail.append(el("p", "ct-rs", (p.role && p.role.text ? p.role.text + " (" + (p.role.source || "source unknown") + ") · " : "Role not known yet · ") + p.emails.join(", ")));
      const st = el("div", "ct-btns"); const refresh = () => openPerson(id);
      if (p.reply === "needs") st.append(el("span", "ct-tag ct-t-they", "Needs my reply · " + ago(p.daysAgo))); else if (p.reply === "waiting") st.append(el("span", "ct-tag ct-t-wait", "Waiting on them · " + ago(p.daysAgo)));
      else st.append(el("span", "ct-tag ct-t-quiet", p.noReply ? "No reply needed" : p.snoozeUntil ? "Snoozed until " + p.snoozeUntil : "Last contact " + ago(p.daysAgo)));
      if (p.reply) { st.append(btn("Snooze 7 d", "", () => api.snooze(id, "snooze", 7).then(() => { refresh(); load(); })), btn("No reply needed", "", () => api.snooze(id, "noreply").then(() => { refresh(); load(); }))); }
      if (p.noReply || p.snoozeUntil) st.append(btn("Clear", "", () => api.snooze(id, "clear").then(() => { refresh(); load(); })));
      detail.append(st);
      const em = el("div", "ct-sec"); em.append(el("div", "ct-sh", "Recent emails (" + p.mails.length + (p.mailsTotal > p.mails.length ? " of " + p.mailsTotal : "") + ")"));
      if (!p.mails.length) em.append(el("p", "ct-rs", "No emails yet."));
      p.mails.forEach((m) => { const row = el("div", "ct-mail"); row.append(el("span", "", m.date), el("span", "", m.dir === "in" ? "they wrote" : "I wrote"), el("span", "", m.subject)); em.append(row); });
      detail.append(em); noteBox(detail, "Note", "person", id, p.note);
      view.classList.add("ct-showdetail");
    }).catch(() => {});
  }

  // ---- suggested categories: the agent proposes, nothing is saved until Iddo confirms
  function openSuggestions() {
    S.mode = "suggest"; S.sel = null; detail.textContent = ""; list.textContent = ""; list.scrollTop = 0; view.classList.remove("ct-showdetail");
    api.suggestions().then((r) => {
      list.textContent = ""; list.append(btn("Back to the list", "", () => { S.mode = "list"; load(); }));
      if (!r || !r.ok) { list.append(el("p", "ct-empty", (r && r.reason) || "Could not load.")); return; }
      list.append(el("p", "ct-empty", r.suggestions.length ? "Review " + r.suggestions.length + " suggestions. Nothing is saved until you confirm." : r.uncategorised ? "No suggestions left. " + r.uncategorised + " companies still have no category: set them from the company page." : "All sorted."));
      r.suggestions.slice(0, 60).forEach((s) => {
        const card = el("div", "ct-sug"); card.append(el("div", "ct-rn", s.name)); const cs = el("div", "ct-cats"); s.categories.forEach((k) => cs.append(el("span", "ct-cat", k))); card.append(cs);
        if (s.why) card.append(el("div", "ct-rs", "Why: " + s.why));
        const bs = el("div", "ct-btns");
        bs.append(btn("Confirm", "pri", () => api.resolveSuggestion(s.id, "confirm", s.categories).then(() => { card.remove(); })), btn("Not this", "", () => api.resolveSuggestion(s.id, "reject").then(() => { card.remove(); })));
        card.append(bs); list.append(card);
      });
    }).catch(() => {});
  }

  // ---- keyboard: / focuses search, Esc steps back
  const onKey = (e) => {
    if (!open) return; const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") { e.preventDefault(); search.focus(); }
    else if (e.key === "Escape") { if (tag === "INPUT" || tag === "TEXTAREA") { document.activeElement.blur(); } else if (S.sel) { S.sel = null; render(); } else if (S.mode === "suggest") { S.mode = "list"; load(); } else close(); e.preventDefault(); }
  };
  search.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(() => { S.q = search.value; load(); }, 200); });

  let navEl = null;
  function openView() {
    if (open) return; if (window.viewManager) window.viewManager.closeAll();
    open = true; document.body.classList.add("contacts-open"); view.classList.remove("hidden"); if (navEl) navEl.classList.add("active");
    document.addEventListener("keydown", onKey); off = api.onChanged(() => { if (open && S.mode === "list") load(); });
    S.mode = "list"; S.sel = null; render(); load();
  }
  function close() {
    if (!open) return; open = false; document.removeEventListener("keydown", onKey); if (off) off(); off = null; clearTimeout(debounce);
    document.body.classList.remove("contacts-open"); view.classList.add("hidden"); if (navEl) navEl.classList.remove("active");
    S.rows = []; S.people = []; S.sel = null; list.textContent = ""; detail.textContent = "";
  }
  window.contactsView = { toggle(nav) { if (nav) navEl = nav; open ? close() : openView(); }, close };
})();
