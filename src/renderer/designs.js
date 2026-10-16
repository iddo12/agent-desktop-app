// My Designs view (v1.125.0, read only). Loaded on first click of the My Designs entry (designs-nav.js), not at startup.
// A numbered gallery of the designs in the shared style library: cards with a big #number, a lazy preview (images load when they scroll
// into view; a video shows its first frame (loaded lazily like an image) and plays only while the pointer is on the card), name, group, tags, status and palette.
// Click a card for the side panel: larger preview, source folder, reference, palette and a "Copy 'use my design #N'" button.
// LIGHT/PRIVACY: textContent only; no polling; the list is read when the view opens and when Refresh is clicked, and is dropped when
// the view closes. The renderer sends only a design id to main (it never sends a path or a link).
(function () {
  "use strict";
  const api = window.api && window.api.designs;
  const F = window.DesignsFilter;
  if (!api || !F) return;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(label, cls, onClick) { const b = el("button", cls || "dg-btn", label); b.type = "button"; b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); onClick(ev); }); return b; }
  const fileUrl = (p) => { const q = String(p).replace(/\\/g, "/"); const enc = (x) => x.split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:"); return q.startsWith("//") ? "file://" + enc(q.slice(2)) : "file:///" + enc(q); };   // UNC host/share/x -> file://host/share/x
  const typeLabel = (t) => (t === "still" ? "Still" : "Motion");

  // ================================================================ lazy loading (no polling: one observer, created on first need)
  let io = null;
  let bodyHost = null;
  function ensureSrc(n) { if (n && n.dataset && n.dataset.src && !n.src) { if (n.tagName === "VIDEO") { n.preload = "metadata"; n.src = n.dataset.src + "#t=0.8"; } else n.src = n.dataset.src; } }   // video: the #t=0.8 fragment makes the first frame show as a poster
  function lazy(n) {
    if (n.tagName !== "IMG" && n.tagName !== "VIDEO") return;   // videos too: metadata + first frame only when scrolled near (v1.128.1), playing still only on hover/focus
    if (!("IntersectionObserver" in window)) { ensureSrc(n); return; }
    if (!io) io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { ensureSrc(en.target); io.unobserve(en.target); }
    }, { root: bodyHost, rootMargin: "200px" });
    io.observe(n);
  }

  // ================================================================ NAMED RENDER FUNCTIONS (restyle here / in the css)
  function renderSwatches(palette, withHex) {
    const row = el("span", "dg-sw-row");
    for (const c of palette || []) {
      const s = el("span", "dg-sw"); s.style.background = c; s.title = c; row.appendChild(s);
      if (withHex) row.appendChild(el("code", "dg-hex", c));
    }
    return row;
  }

  function renderPreview(e, big) {
    const box = el("div", "dg-prev" + (big ? " dg-prev-big" : ""));
    if (e.previewKind === "image") {
      const im = el("img"); im.alt = e.name; im.decoding = "async";
      if (big) im.src = fileUrl(e.preview); else { im.dataset.src = fileUrl(e.preview); lazy(im); }
      box.appendChild(im);
    } else if (e.previewKind === "video") {
      const v = el("video"); v.muted = true; v.loop = true; v.playsInline = true; v.preload = "none"; v.setAttribute("muted", "");
      if (big) { v.src = fileUrl(e.preview); v.controls = true; v.autoplay = true; v.preload = "auto"; }
      else { v.dataset.src = fileUrl(e.preview); box.appendChild(el("span", "dg-play", "▶")); }
      box.appendChild(v);
      if (!big) lazy(v);
    } else {
      box.appendChild(el("span", "dg-noprev", "No preview"));
    }
    return box;
  }

  function renderCard(e, S) {
    const c = el("button", "dg-card" + (S.openId === e.id ? " dg-sel" : "")); c.type = "button"; c.dataset.id = String(e.id);
    c.setAttribute("aria-label", "Design " + e.id + ", " + e.name);
    const top = el("div", "dg-card-top");
    top.append(renderPreview(e, false), el("span", "dg-num", "#" + e.id), el("span", "dg-type dg-type-" + e.type, typeLabel(e.type)));
    const body = el("div", "dg-card-body");
    const line = el("div", "dg-card-line");
    line.append(el("b", "dg-name", e.name), el("span", "dg-chip dg-chip-" + e.status, e.status));
    body.append(line, el("div", "dg-group", e.group || "(no group)"));
    if (e.tags.length) { const t = el("div", "dg-tags"); e.tags.slice(0, 6).forEach((x) => t.appendChild(el("span", "dg-tag", x))); body.appendChild(t); }
    if (e.palette.length) body.appendChild(renderSwatches(e.palette, false));
    c.append(top, body);
    c.addEventListener("click", () => S.onOpen(e.id));
    if (e.previewKind === "video") {
      const v = () => c.querySelector("video");
      const play = () => { const x = v(); ensureSrc(x); if (x && x.src) { const p = x.play(); if (p && p.catch) p.catch(() => {}); } };
      const stop = () => { const x = v(); if (x) x.pause(); };
      c.addEventListener("mouseenter", play); c.addEventListener("mouseleave", stop);
      c.addEventListener("focus", play); c.addEventListener("blur", stop);
    }
    return c;
  }

  function renderPanel(e, S) {
    const p = el("aside", "dg-panel"); p.setAttribute("aria-label", "Design " + e.id + " details");
    const head = el("div", "dg-panel-head");
    head.append(el("span", "dg-num dg-num-inline", "#" + e.id), el("b", "dg-panel-name", e.name), el("span", "dg-sp"), btn("Close", "dg-btn", S.onClosePanel));
    const row = (label, node) => { const r = el("div", "dg-kv"); r.append(el("span", "dg-k", label), node); return r; };
    const val = (t) => el("span", "dg-v", t);
    const use = btn("Copy \"" + F.useText(e.id) + "\"", "dg-btn dg-pri", () => S.onCopy(F.useText(e.id)));
    use.title = "Copies the sentence to the clipboard so you can paste it to an agent.";
    const actions = el("div", "dg-actions"); actions.appendChild(use);
    const src = el("div", "dg-src");
    src.appendChild(el("code", "dg-path", e.source || "(not recorded)"));
    if (e.source) { const ob = btn("Open source folder", "dg-btn", () => S.onOpenSource(e.id)); ob.title = "Opens the design's source folder (only inside the allowed folders)."; src.appendChild(ob); }
    const ref = el("div", "dg-src");
    if (e.reference) { ref.appendChild(el("span", "dg-v", e.reference)); if (e.referenceIsUrl) ref.appendChild(btn("Open link", "dg-btn", () => S.onOpenRef(e.id))); }
    else ref.appendChild(val("(none)"));
    const facts = el("div", "dg-facts");
    facts.append(
      row("Type", val(typeLabel(e.type) + (e.kind ? " - " + e.kind : "") + (e.durationS ? " - " + e.durationS + " s" : ""))),
      row("Group", val(e.group || "(none)")), row("Status", el("span", "dg-chip dg-chip-" + e.status, e.status)),
      row("Source", src), row("Reference", ref));
    if (e.palette.length) facts.appendChild(row("Palette", renderSwatches(e.palette, true)));
    if (e.tags.length) { const t = el("div", "dg-tags"); e.tags.forEach((x) => t.appendChild(el("span", "dg-tag", x))); facts.appendChild(row("Tags", t)); }
    if (e.notes) facts.appendChild(row("Notes", val(e.notes)));
    if (e.addedBy || e.added) facts.appendChild(row("Added", val([e.addedBy, (e.added || "").slice(0, 10)].filter(Boolean).join(", "))));
    p.append(head, renderPreview(e, true), actions, facts);
    return p;
  }

  function selectOf(label, key, opts, S, allLabel) {
    const w = el("label", "dg-f"); w.appendChild(el("span", "dg-f-l", label));
    const s = el("select", "dg-sel-box"); s.setAttribute("aria-label", label);
    const all = el("option", "", allLabel); all.value = ""; s.appendChild(all);
    opts.forEach((o) => { const x = el("option", "", o.value + " (" + o.count + ")"); x.value = o.value; s.appendChild(x); });
    s.value = S.f[key] || ""; if (s.value !== (S.f[key] || "")) S.f[key] = "";
    s.addEventListener("change", () => { S.f[key] = s.value; S.onFilter(false); });
    w.appendChild(s); return w;
  }

  function renderHeader(S) {
    const head = el("div", "dg-head");
    const n = S.items ? S.items.length : 0, shown = S.shown ? S.shown.length : 0;
    head.append(el("b", "dg-title", "My Designs"), el("span", "dg-sub", S.items ? (shown === n ? n + " designs" : shown + " of " + n + " designs") : ""), el("span", "dg-sp"));
    const rb = btn(S.loading ? "Refreshing..." : "Refresh", "dg-btn dg-pri", S.onRefresh); rb.disabled = !!S.loading;
    head.appendChild(rb);
    return head;
  }

  function renderFilters(S) {
    const bar = el("div", "dg-filters");
    const seg = el("div", "dg-seg"); seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Type");
    [["all", "All"], ["motion", "Motion"], ["still", "Still"]].forEach(([k, l]) => {
      const on = (S.f.type || "all") === k;
      const b = btn(l, "dg-seg-b" + (on ? " dg-on" : ""), () => { S.f.type = k; S.onFilter(false); }); b.setAttribute("aria-pressed", on ? "true" : "false"); seg.appendChild(b);
    });
    const q = el("input", "dg-search"); q.type = "search"; q.placeholder = "Search name, tag, #number..."; q.value = S.f.q || ""; q.setAttribute("aria-label", "Search designs");
    q.addEventListener("input", () => { S.f.q = q.value; S.onFilter(true); });
    bar.append(seg, selectOf("Group", "group", F.facets(S.items, "group"), S, "All groups"), selectOf("Tag", "tag", F.facets(S.items, "tags"), S, "All tags"),
      selectOf("Status", "status", F.facets(S.items, "status"), S, "Any status"), q);
    return bar;
  }

  function renderEmpty(S, reason) {
    const c = el("section", "dg-empty");
    if (reason === "needs-setup" && window.NeedsSetup) { c.appendChild(window.NeedsSetup.card("designs")); return c; }
    if (reason === "unreadable" || reason === "too-big") { c.append(el("b", "", "The designs list could not be read"), el("p", "dg-text", "styles.json exists but is not readable. Ask an agent to run the style library validate command.")); return c; }
    c.appendChild(el("b", "", reason === "missing" ? "No designs yet - the library has no styles.json" : "No designs yet"));
    c.appendChild(el("p", "dg-text", "Each design gets a number when an agent adds it. Add one with the style library tool:"));
    c.appendChild(el("pre", "dg-code", "python style_lib.py add --name \"...\" --group \"...\" --kind text --type still --preview <file> --reference <link or note> --palette \"#111111,#dc4056\" --added-by \"<agent>\""));
    c.appendChild(el("p", "dg-text", "Or tell an agent \"create this and put it in My Designs\" and give it the reference. The tool and its README are in the shared tools folder (style_library). Then click Refresh."));
    return c;
  }

  function renderNoMatch(S) {
    const c = el("section", "dg-empty");
    c.append(el("b", "", "No design matches these filters"), btn("Clear filters", "dg-btn", S.onClear));
    return c;
  }

  // ================================================================ SHELL, STATE AND DATA (logic: leave alone when restyling)
  const view = el("div"); view.id = "designs-view"; view.className = "hidden";
  const headHost = el("div"), filterHost = el("div");
  bodyHost = el("div", "dg-body");
  const panelHost = el("div", "dg-panel-host hidden"), toast = el("div", "dg-toast hidden");
  toast.setAttribute("role", "status"); toast.setAttribute("aria-live", "polite");
  const main = el("div", "dg-main"); main.append(filterHost, bodyHost);
  const split = el("div", "dg-split"); split.append(main, panelHost);
  view.append(headHost, split, toast);
  document.getElementById("main-panel").appendChild(view);

  const S = { items: null, shown: null, reason: "", loading: false, openId: null, f: { type: "all", group: "", tag: "", status: "", q: "" } };
  let open = false, navEl = null, toastTimer = null, qTimer = null;

  function say(msg) { toast.textContent = msg; toast.classList.remove("hidden"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600); }

  function paintBody() {
    if (io) { io.disconnect(); io = null; }
    bodyHost.textContent = "";
    if (!S.items) { bodyHost.appendChild(el("p", "dg-text dg-pad", S.loading ? "Loading..." : "")); return; }
    if (!S.items.length) { bodyHost.appendChild(renderEmpty(S, S.reason)); return; }
    if (!S.shown.length) { bodyHost.appendChild(renderNoMatch(S)); return; }
    const grid = el("div", "dg-grid");
    const frag = document.createDocumentFragment();
    S.shown.forEach((e) => frag.appendChild(renderCard(e, S)));
    grid.appendChild(frag); bodyHost.appendChild(grid);
  }
  function paintPanel() {
    panelHost.textContent = "";
    const e = S.items && S.openId != null ? S.items.find((x) => x.id === S.openId) : null;
    if (!e) { S.openId = null; panelHost.classList.add("hidden"); return; }
    panelHost.appendChild(renderPanel(e, S)); panelHost.classList.remove("hidden");
  }
  function paintHead() { headHost.textContent = ""; headHost.appendChild(renderHeader(S)); }
  function paintFilters() { filterHost.textContent = ""; if (S.items && S.items.length) filterHost.appendChild(renderFilters(S)); }
  function recompute() { S.shown = S.items ? F.apply(S.items, S.f) : null; }
  function render() { recompute(); paintHead(); paintFilters(); paintBody(); paintPanel(); }
  function markSel() { bodyHost.querySelectorAll(".dg-card").forEach((c) => c.classList.toggle("dg-sel", c.dataset.id === String(S.openId))); }

  S.onFilter = (typing) => {
    if (typing) { clearTimeout(qTimer); qTimer = setTimeout(() => { recompute(); paintHead(); paintBody(); }, 120); return; }   // typing: redraw cards only, the search box keeps focus
    render();
  };
  S.onClear = () => { S.f = { type: "all", group: "", tag: "", status: "", q: "" }; render(); };
  S.onOpen = (id) => { S.openId = S.openId === id ? null : id; markSel(); paintPanel(); };
  S.onClosePanel = () => { S.openId = null; markSel(); paintPanel(); };
  S.onCopy = (text) => {
    const done = () => say("Copied: " + text);
    const fallback = () => { try { const t = el("textarea"); t.value = text; t.style.position = "fixed"; t.style.opacity = "0"; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); done(); } catch (e) { say("Could not copy."); } };
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback(); } catch (e) { fallback(); }
  };
  const act = (fn, id) => fn(id).then((r) => { if (!r || !r.ok) say((r && r.reason) || "That did not work."); }).catch(() => say("That did not work."));
  S.onOpenSource = (id) => act(api.openSource, id);
  S.onOpenRef = (id) => act(api.openReference, id);

  function refresh() {
    if (S.loading) return Promise.resolve();
    S.loading = true; paintHead();
    return api.load().then((r) => {
      if (r && r.ok) { S.items = r.items; S.reason = ""; S.f = F.sanitize(S.items, S.f); } else { S.items = []; S.reason = (r && r.reason) || "unreadable"; }
    }).catch(() => { S.items = []; S.reason = "unreadable"; }).then(() => { S.loading = false; if (open) render(); });
  }
  S.onRefresh = () => refresh();

  const onDocKey = (e) => { if (e.key === "Escape") { if (S.openId != null) S.onClosePanel(); else close(); } };
  function openView() {
    if (open) return;
    open = true;
    document.body.classList.add("designs-open");
    view.classList.remove("hidden");
    if (navEl) navEl.classList.add("active");
    document.addEventListener("keydown", onDocKey);
    render(); refresh();
  }
  function close() {
    if (!open) return;
    open = false; clearTimeout(qTimer); clearTimeout(toastTimer);
    document.removeEventListener("keydown", onDocKey);
    document.body.classList.remove("designs-open");
    view.classList.add("hidden");
    if (navEl) navEl.classList.remove("active");
    if (io) { io.disconnect(); io = null; }
    S.items = null; S.shown = null; S.openId = null; S.reason = "";    // nothing from the library stays in the page
    headHost.textContent = ""; filterHost.textContent = ""; bodyHost.textContent = ""; panelHost.textContent = ""; toast.textContent = ""; toast.classList.add("hidden");
  }
  window.designsView = { toggle(nav) { if (nav) navEl = nav; open ? close() : openView(); }, close };
})();
