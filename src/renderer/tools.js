// Tools view (v1.83.0). Loaded on first click of the Tools entry (tools-nav.js), not at startup.
// STRUCTURE FOR RESTYLING (UI-UX): all look is in styles-tools.css (tokens --tl-*). All markup is built by the NAMED render functions
// below (renderHeader, renderBasket, renderCard, renderChip, renderDots, renderStats, renderDrawer, renderComingUp, renderEmpty);
// restyle or re-lay them out without touching the data/logic section at the bottom.
// PRIVACY/LIGHT: textContent only; no timers (one 2.5 s re-check after a Start and one toast fade); the page keeps nothing from the
// catalogue once the view closes; the renderer never sends a path or command, only a tool id.
(function () {
  "use strict";
  const api = window.api && window.api.tools;
  if (!api) return;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(label, cls, onClick) { const b = el("button", cls || "tl-btn", label); b.type = "button"; b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); onClick(ev); }); return b; }
  const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "0");
  const when = (ms) => { if (!ms) return ""; const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()); };

  // ================================================================ NAMED RENDER FUNCTIONS (restyle here / in the css)
  function renderHeader(S) {
    const head = el("div", "tl-head");
    head.append(el("b", "tl-title", "My Tools"), el("span", "tl-sub", S.snap && S.snap.ok ? S.snap.count + " tools" : ""), el("span", "tl-sp"));
    const st = S.snap && S.snap.stats;
    if (st) {
      const asOf = st.asOf ? "GitHub stats as of " + when(st.asOf) : "GitHub stats not fetched yet";
      head.appendChild(el("span", "tl-stat", asOf + " - " + st.callsLeft + " of " + st.guard + " calls left this hour"));
    }
    head.appendChild(renderSizeGroup(S));
    const rb = btn(S.refreshing ? "Refreshing..." : "Refresh", "tl-btn tl-pri", S.onRefresh);
    rb.title = "Fetch public GitHub numbers (stars, forks, issues, releases, downloads) for tools with a public repo. Runs only when you click.";
    rb.disabled = !!S.refreshing || !(st && st.anyRepo);
    head.appendChild(rb);
    return head;
  }

  // v1.122.0: two tabs, "Programs" (kind app, the default) and "Behind the scenes" (kind service). One Tab stop, arrows/Home/End move, remembered per user.
  const TAB_KINDS = ["app", "service"], TAB_LABELS = { app: "Programs", service: "Behind the scenes" };
  const tabInfo = (S, k) => { const t = S.snap && S.snap.ok && Array.isArray(S.snap.tabs) ? S.snap.tabs.find((x) => x.kind === k) : null; return t || { kind: k, label: TAB_LABELS[k], count: 0, groups: [] }; };
  function renderTabs(S) {
    const bar = el("div", "tl-tabs"); bar.setAttribute("role", "tablist"); bar.setAttribute("aria-label", "Tool types");
    TAB_KINDS.forEach((k) => {
      const on = S.tab === k, ti = tabInfo(S, k);
      const b = el("button", "tl-tab", TAB_LABELS[k] + (S.snap && S.snap.ok ? " (" + ti.count + ")" : "")); b.type = "button"; b.id = "tl-tab-" + k; b.dataset.tab = k;
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", on ? "true" : "false"); b.setAttribute("aria-controls", "tl-panel"); b.tabIndex = on ? 0 : -1;
      b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); S.onTab(k, false); });
      b.addEventListener("keydown", (ev) => {
        const i = TAB_KINDS.indexOf(k);
        const j = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? (i + 1) % TAB_KINDS.length : ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? (i + TAB_KINDS.length - 1) % TAB_KINDS.length : ev.key === "Home" ? 0 : ev.key === "End" ? TAB_KINDS.length - 1 : -1;
        if (j >= 0) { ev.preventDefault(); S.onTab(TAB_KINDS[j], true); }
      });
      bar.appendChild(b);
    });
    return bar;
  }
  function renderTabEmpty(k) {
    return el("div", "tl-muted tl-tab-empty", k === "service" ? "Nothing behind the scenes yet." : "No programs yet.");
  }

  // card size S / M / L (UI-UX spec 2026-10-08): segmented control left of Refresh, one Tab stop, arrows move, remembered per user
  const SIZE_NAMES = { S: "Small", M: "Medium", L: "Large" };
  const SIZE_GLYPH = { S: "∷", M: "⌹", L: "■" };   // 3x3-ish dots / 2x2 / one big square
  function renderSizeGroup(S) {
    const g = el("span", "tl-size"); g.setAttribute("role", "group"); g.setAttribute("aria-label", "Card size");
    g.appendChild(el("span", "tl-size-l", "Card size"));
    Object.keys(SIZE_NAMES).forEach((k) => {
      const b = el("button", "tl-size-b"); b.type = "button"; b.dataset.size = k;
      const gl = el("span", "tl-size-g", SIZE_GLYPH[k]); gl.setAttribute("aria-hidden", "true");
      b.append(gl, el("span", "", k));
      b.title = SIZE_NAMES[k] + " cards"; b.setAttribute("aria-label", SIZE_NAMES[k] + " cards");
      b.setAttribute("aria-pressed", S.size === k ? "true" : "false"); b.tabIndex = S.size === k ? 0 : -1;
      b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); S.onSize(k); });
      b.addEventListener("keydown", (ev) => {
        const ks = Object.keys(SIZE_NAMES), i = ks.indexOf(k);
        const j = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? (i + 1) % 3 : ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? (i + 2) % 3 : -1;
        if (j >= 0) { ev.preventDefault(); S.onSize(ks[j]); }
      });
      g.appendChild(b);
    });
    return g;
  }

  // chip = status word, never colour-only
  function renderChip(card) { return el("span", "tl-chip tl-s-" + card.status, card.statusLabel); }

  // three health dots, each with its word in the tooltip and as visible text in the drawer
  function renderDots(card, withText) {
    const w = el("span", "tl-dots");
    for (const d of card.dots) {
      const dot = el("span", "tl-dot tl-d-" + d.state);
      dot.title = d.label + ": " + d.text;
      dot.setAttribute("role", "img"); dot.setAttribute("aria-label", d.label + ": " + d.text);
      dot.textContent = d.state === "ok" ? "✓" : d.state === "bad" ? "✕" : d.state === "warn" ? "!" : "?";
      if (withText) { const row = el("div", "tl-dotrow"); row.append(dot, el("span", "", d.label + ": " + d.text)); w.appendChild(row); } else w.appendChild(dot);
    }
    return w;
  }

  // ---------------------------------------------------------------- screenshots (v1.85.0)
  // Card image: thumbnail only (640x400 JPEG made once by the main process), lazy, fixed 16:10 box. Full size loads only in the lightbox.
  const STATUS_ICON = { built: "✓", partial: "◐", tested: "◇", "in-dev": "…", released: "★" };
  const takenText = (sh) => "Screenshot taken " + sh.taken;
  const altText = (card, sh) => card.name + " screenshot: " + sh.caption;
  function staleTag(sh) { if (!sh.stale) return null; const t = el("span", "tl-tag-stale"); t.append(el("span", "tl-tag-ic", "⚠"), document.createTextNode(" " + sh.stale)); t.querySelector(".tl-tag-ic").setAttribute("aria-hidden", "true"); return t; }
  function renderPlaceholder(card, words) {
    const p = el("div", "tl-ph tl-s-" + card.status);
    const tile = el("span", "tl-ph-tile", (card.name.trim().charAt(0) || "?").toUpperCase()); tile.setAttribute("aria-hidden", "true");
    const ic = el("span", "tl-ph-ic tl-s-" + card.status, STATUS_ICON[card.status] || "•"); ic.setAttribute("aria-hidden", "true");
    const row = el("div", "tl-ph-row"); row.append(ic, el("span", "tl-ph-words", words || "No screenshot yet"));
    p.append(tile, row);
    if (card.owner) p.appendChild(el("span", "tl-ph-owner", "Owner: " + card.owner));
    return p;
  }
  // Thumbnail only: never falls back to the full-size file. No thumbnail yet (or a broken one) -> an empty tile, not an image.
  function failTile(cls, text) { const f = el("span", "tl-img-fail " + (cls || ""), text || ""); f.setAttribute("role", "img"); return f; }
  function shotImg(card, sh, cls) {
    if (!sh.thumb) return failTile(cls, "");
    const img = el("img", cls); img.loading = "lazy"; img.decoding = "async"; img.alt = altText(card, sh); img.src = sh.thumb; img.draggable = false;
    img.addEventListener("error", () => { const f = failTile(cls, "Image unavailable"); f.setAttribute("aria-label", altText(card, sh) + " (unavailable)"); if (img.parentNode) img.replaceWith(f); });
    return img;
  }
  function renderMedia(card, S) {
    const box = el("div", "tl-media");
    const shots = card.screenshots || [];
    if (!shots.length) { box.classList.add("tl-media-empty"); box.appendChild(renderPlaceholder(card)); return box; }
    const sh = shots[0];
    if (!sh.thumb) { box.classList.add("tl-media-empty"); box.appendChild(renderPlaceholder(card, "Preparing screenshot")); return box; }
    const b = el("button", "tl-media-btn"); b.type = "button"; b.dataset.shotFor = card.id;
    b.setAttribute("aria-label", "Enlarge screenshot: " + card.name + (shots.length > 1 ? " (" + shots.length + " screenshots)" : ""));
    b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); S.onLbOpen(card.id, 0); });
    const img = shotImg(card, sh, "tl-img");
    img.addEventListener("error", () => { box.textContent = ""; box.classList.add("tl-media-empty"); box.appendChild(renderPlaceholder(card)); });
    b.appendChild(img); box.appendChild(b);
    const tag = staleTag(sh); if (tag) box.appendChild(tag);
    if (shots.length > 1) box.appendChild(el("span", "tl-tag-count", "1 / " + shots.length));
    return box;
  }

  function renderLightbox(card, S) {
    const shots = card.screenshots, n = shots.length, sh = shots[S.lb.i];
    const wrap = el("div", "tl-lb"); wrap.setAttribute("role", "dialog"); wrap.setAttribute("aria-modal", "true"); wrap.setAttribute("aria-label", card.name + " screenshot");
    wrap.addEventListener("click", (ev) => { if (ev.target === wrap) S.onLbClose(); });
    const boxEl = el("div", "tl-lb-box");
    const img = el("img", "tl-lb-img"); img.decoding = "async"; img.alt = altText(card, sh); img.src = sh.full;
    img.addEventListener("error", () => { const f = el("div", "tl-muted tl-lb-fail", "This screenshot could not be loaded."); f.setAttribute("role", "img"); f.setAttribute("aria-label", altText(card, sh) + " (unavailable)"); if (img.parentNode) img.replaceWith(f); });
    const cap = el("div", "tl-lb-cap");
    const cn = el("b", "", card.name), cc = el("span", "", sh.caption); cn.dir = "auto"; cc.dir = "auto";
    cap.append(cn, cc, el("span", "tl-lb-date", takenText(sh)));
    const tag = staleTag(sh); if (tag) cap.appendChild(tag);
    const bar = el("div", "tl-lb-bar");
    if (n > 1) {
      const pv = btn("Previous", "tl-btn tl-sm", () => S.onLbStep(-1, "prev")); pv.dataset.role = "prev";
      const nx = btn("Next", "tl-btn tl-sm", () => S.onLbStep(1, "next")); nx.dataset.role = "next";
      bar.append(pv, el("span", "tl-lb-n", (S.lb.i + 1) + " / " + n), nx);
    }
    bar.appendChild(el("span", "tl-sp"));
    const cl = btn("Close", "tl-btn tl-sm", S.onLbClose); cl.dataset.role = "close"; bar.appendChild(cl);
    boxEl.append(img, cap, bar); wrap.appendChild(boxEl);
    return wrap;
  }

  // Drawer gallery: big current shot, 96x60 thumbs (max 6), dated captions, Prev/Next. Keeps its own index; redraws only itself.
  function renderGallery(card, S) {
    const shots = card.screenshots || [];
    const sec = el("section", "tl-sec tl-gal");
    const h = el("h3", "tl-sec-h", "Screenshots "); h.appendChild(el("span", "tl-count", String(shots.length))); sec.appendChild(h);
    if (!shots.length) { sec.appendChild(el("div", "tl-muted", "No screenshot yet.")); return sec; }
    const body = el("div", "tl-gal-body"); sec.appendChild(body);
    const draw = (focusRole) => {
      const i = Math.min(S.galIdx[card.id] || 0, shots.length - 1), sh = shots[i];
      body.textContent = "";
      const media = el("div", "tl-media tl-gal-main");
      const b = el("button", "tl-media-btn"); b.type = "button"; b.dataset.shotFor = card.id; b.setAttribute("aria-label", "Enlarge screenshot: " + sh.caption);
      b.addEventListener("click", () => S.onLbOpen(card.id, i));
      b.appendChild(shotImg(card, sh, "tl-img")); media.appendChild(b);
      const tag = staleTag(sh); if (tag) media.appendChild(tag);
      body.appendChild(media);
      const cap = el("div", "tl-gal-cap"); const gc = el("span", "", sh.caption); gc.dir = "auto"; cap.append(gc, el("span", "tl-muted tl-small", takenText(sh))); body.appendChild(cap);
      if (shots.length > 1) {
        const bar = el("div", "tl-gal-bar");
        const go = (d, role) => { S.galIdx[card.id] = (i + d + shots.length) % shots.length; draw(role); };
        const pv = btn("Previous", "tl-btn tl-sm", () => go(-1, "prev")); pv.dataset.role = "prev";
        const nx = btn("Next", "tl-btn tl-sm", () => go(1, "next")); nx.dataset.role = "next";
        bar.append(pv, el("span", "tl-small tl-muted", (i + 1) + " of " + shots.length), nx); body.appendChild(bar);
        const strip = el("div", "tl-strip");
        shots.forEach((s, k) => {
          const tb = el("button", "tl-thumb"); tb.type = "button"; tb.setAttribute("aria-label", "Show screenshot " + (k + 1) + ": " + s.caption); tb.setAttribute("aria-pressed", k === i ? "true" : "false");
          tb.appendChild(shotImg(card, s, "tl-thumb-img")); tb.dataset.role = "t" + k;
          tb.addEventListener("click", () => { S.galIdx[card.id] = k; draw("t" + k); });
          strip.appendChild(tb);
        });
        body.appendChild(strip);
      }
      if (focusRole) { const f = body.querySelector('[data-role="' + focusRole + '"]'); if (f) f.focus(); }
    };
    draw(null);
    return sec;
  }

  function renderCard(card, S) {
    const c = el("article", "tl-card" + (S.openId === card.id ? " tl-open" : ""));
    c.tabIndex = 0; c.setAttribute("role", "group"); c.setAttribute("aria-label", card.name + ", " + card.statusLabel);
    c.addEventListener("keydown", (ev) => { if (ev.target === c && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); S.onOpen(card.id); } });
    c.appendChild(renderMedia(card, S));
    const top = el("div", "tl-card-top");
    const nm = el("b", "tl-name", card.name); nm.dir = "auto"; nm.title = card.name; top.append(nm, renderChip(card));
    c.appendChild(top);
    c.appendChild(el("div", "tl-purpose", card.purpose));
    const meta = el("div", "tl-meta");
    meta.appendChild(el("span", "tl-ver", card.version ? "v" + card.version.replace(/^v/i, "") : "no version"));
    if (card.owner) meta.appendChild(el("span", "tl-owner", card.owner));
    c.appendChild(meta);
    c.appendChild(el("div", "tl-next", card.next ? "Next: " + card.next : "Next: nothing planned"));
    if (card.uncertain && card.uncertain.length) c.appendChild(el("div", "tl-guess", "Guess, to confirm: " + card.uncertain.join(", ")));
    const foot = el("div", "tl-card-foot");
    foot.appendChild(renderDots(card, false));
    foot.appendChild(el("span", "tl-sp"));
    { const db = btn("Details", "tl-btn tl-sm", () => S.onOpen(card.id)); db.dataset.toolId = card.id; db.setAttribute("aria-label", "Details for " + card.name); foot.appendChild(db); }
    const sb = btn(card.start.label, "tl-btn tl-start tl-st-" + card.start.state, () => S.onStart(card.id));
    sb.disabled = card.start.state !== "ready" || S.starting === card.id;
    if (card.start.state === "running") sb.textContent = "Running";
    if (S.starting === card.id) sb.textContent = "Starting...";
    if (card.start.reason) sb.title = card.start.reason;
    foot.appendChild(sb);
    c.appendChild(foot);
    if (card.start.state === "disabled") c.appendChild(el("div", "tl-reason", card.start.reason));
    c.addEventListener("click", () => S.onOpen(card.id));
    return c;
  }

  function renderBasket(group, S) {
    const sec = el("section", "tl-basket");
    const h = el("h2", "tl-basket-h"); h.append(el("span", "", group.label), el("span", "tl-count", String(group.cards.length)));
    sec.appendChild(h);
    if (!group.cards.length) { sec.appendChild(el("div", "tl-muted", "None yet.")); return sec; }
    const grid = el("div", "tl-grid");
    group.cards.forEach((c) => grid.appendChild(renderCard(c, S)));
    sec.appendChild(grid);
    return sec;
  }

  // actual numbers with labels (no bare trends): every figure is "<label>: <value>"
  function renderStats(card) {
    try { return renderStatsRaw(card); } catch (e) { const w = el("div", "tl-stats"); w.appendChild(el("div", "tl-muted", "Stats unreadable. Press Refresh.")); return w; }
  }
  function renderStatsRaw(card) {
    const w = el("div", "tl-stats");
    if (!card.hasRepo) { w.appendChild(el("div", "tl-muted", card.visibility === "private" ? "Private tool: no public repository." : "No public repository.")); return w; }
    const s = card.stats;
    if (!s || !s.fetched) { w.appendChild(el("div", "tl-muted", "Not fetched yet. Press Refresh at the top.")); return w; }
    if (s.notFound) { w.appendChild(el("div", "tl-muted", "Repository not found or not public.")); return w; }
    w.appendChild(el("div", "tl-asof" + (s.stale ? " tl-stale" : ""), "As of " + when(s.asOf) + (s.stale ? " (older than 24 hours)" : "")));
    const t = el("table", "tl-table");
    for (const [k, v] of [["Stars", fmt(s.stars)], ["Forks", fmt(s.forks)], ["Watchers", fmt(s.watchers)], ["Open issues and pull requests", fmt(s.openIssues)], ["Last push", s.pushedAt || "unknown"], ["Total downloads of release files", fmt(s.downloadsTotal)]]) {
      const r = el("tr"); r.append(el("th", "", k), el("td", "", v)); t.appendChild(r);
    }
    w.appendChild(t);
    if (s.hasRelease === null) w.appendChild(el("div", "tl-muted", "Release info not checked yet (the call limit stopped it). Press Refresh again later."));
    else if (!s.hasRelease) w.appendChild(el("div", "tl-muted", "no public release yet"));
    else for (const r of s.releases) {
      const box = el("div", "tl-rel");
      box.appendChild(el("b", "", r.tag + (r.name && r.name !== r.tag ? " - " + r.name : "") + (r.date ? " (" + r.date + ")" : "") + (r.prerelease ? " pre-release" : "")));
      if (!r.assets.length) box.appendChild(el("div", "tl-muted", "No downloadable files attached."));
      else { const at = el("table", "tl-table"); r.assets.forEach((a) => { const row = el("tr"); row.append(el("th", "", a.name), el("td", "", fmt(a.downloads) + " downloads")); at.appendChild(row); }); box.appendChild(at); }
      box.appendChild(el("div", "tl-small", "Release total: " + fmt(r.downloads) + " downloads"));
      w.appendChild(box);
    }
    return w;
  }

  function trustText(card) {
    if (card.trust === "trusted") return "approved" + (card.trustedOn ? " on " + card.trustedOn : "") + " (file unchanged)";
    if (card.trust === "changed") return "CHANGED since approval" + (card.trustedOn ? " on " + card.trustedOn : "") + ": you will be asked before it starts";
    if (card.trust === "new") return "not approved yet: you will be asked on first Start";
    return "not applicable";
  }
  function section(title, node) { const s = el("section", "tl-sec"); s.appendChild(el("h3", "tl-sec-h", title)); s.appendChild(node); return s; }
  function textBlock(t, emptyText) { return el("div", t ? "tl-text" : "tl-muted", t || emptyText); }
  function listBlock(items, emptyText, fn) { if (!items.length) return el("div", "tl-muted", emptyText); const ul = el("ul", "tl-ul"); items.forEach((i) => ul.appendChild(fn(i))); return ul; }

  function renderDrawer(card, S) {
    const d = el("aside", "tl-drawer"); d.setAttribute("role", "dialog"); d.setAttribute("aria-label", card.name + " details"); d.tabIndex = -1;
    const head = el("div", "tl-drawer-head");
    head.append(el("b", "tl-drawer-title", card.name), renderChip(card), el("span", "tl-sp"), btn("Close", "tl-btn tl-sm", S.onClose));
    d.appendChild(head);
    const body = el("div", "tl-drawer-body");
    body.appendChild(renderGallery(card, S));
    body.appendChild(el("div", "tl-purpose", card.purpose));
    body.appendChild(section("About", textBlock(card.description, "No long description yet.")));
    const facts = el("table", "tl-table");
    for (const [k, v] of [["Version", card.version || "not set"], ["Next", card.next || "nothing planned"], ["Owner agent", card.owner || "not set"], ["Folder", card.folder || "not set"], ["Launcher file (resolved)", card.resolved || "none"], ["Launcher trust", trustText(card)], ["Visibility", card.visibility], ["Last release date", card.release.date || "none"]]) {
      const r = el("tr"); r.append(el("th", "", k), el("td", "", v)); facts.appendChild(r);
    }
    body.appendChild(section("Facts", facts));
    body.appendChild(section("Health", renderDots(card, true)));
    const rel = el("div");
    const links = el("div", "tl-actions");
    if (card.hasRepo) {
      links.appendChild(btn("Open repository", "tl-btn tl-sm", () => S.onLink(card.id, "repo")));
      links.appendChild(btn("Releases page", "tl-btn tl-sm", () => S.onLink(card.id, "releases")));
      if (card.release && card.release.url) links.appendChild(btn("Latest release", "tl-btn tl-sm", () => S.onLink(card.id, "release")));
    }
    rel.appendChild(links);
    if (card.releaseNote) rel.appendChild(el("div", "tl-muted", card.releaseNote));
    rel.appendChild(renderStats(card));
    body.appendChild(section("Repository and releases", rel));
    body.appendChild(section("Notes", textBlock(card.notes, "No notes.")));
    body.appendChild(section("Upcoming work", listBlock(card.upcoming, "Nothing listed.", (u) => el("li", "", u))));
    body.appendChild(section("Feedback", listBlock(card.feedback, "No feedback entries.", (f) => el("li", "", (f.date ? f.date + " - " : "") + (f.source ? f.source + ": " : "") + f.text))));
    if (card.uncertain && card.uncertain.length) body.appendChild(section("To confirm", el("div", "tl-guess", "The seed script guessed: " + card.uncertain.join(", ") + ". Edit tools.json to confirm.")));
    d.appendChild(body);
    return d;
  }

  function renderComingUp(coming, S) {
    const sec = el("section", "tl-coming");
    const h = el("h2", "tl-coming-h"); h.append(el("span", "", "Coming up"), el("span", "tl-count", String(coming.total)));
    sec.appendChild(h);
    sec.appendChild(el("div", "tl-small tl-muted", "Ideas and researched projects from the Library. Read-only; open the Library to work with them."));
    if (!coming.items.length) { sec.appendChild(el("div", "tl-muted", "Nothing in the Library pipeline right now.")); return sec; }
    const row = el("div", "tl-chips");
    coming.items.forEach((i) => { const b = btn(i.title, "tl-pill tl-pill-" + i.stage, S.onLibrary); b.title = i.stage + " - open the Library Projects view"; row.appendChild(b); });
    if (coming.total > coming.items.length) row.appendChild(el("span", "tl-small tl-muted", "and " + (coming.total - coming.items.length) + " more in the Library"));
    sec.appendChild(row);
    return sec;
  }

  function renderEmpty(snap) {
    const c = el("section", "tl-empty");
    c.appendChild(el("b", "", "No tools in the catalogue yet"));
    const why = snap && snap.catalogue && snap.catalogue.file === "unreadable" ? "tools.json exists but could not be read." : "tools.json was not found.";
    c.appendChild(el("p", "tl-text", why + " The catalogue file is set in Setup (Tools). Add tools to it, or ask your agent to propose the first one, then review it."));
    return c;
  }

  // ================================================================ SHELL, STATE AND DATA (logic: leave alone when restyling)
  const view = el("div"); view.id = "tools-view"; view.className = "hidden";
  const headHost = el("div"), bodyHost = el("div", "tl-body"), toast = el("div", "tl-toast hidden"); toast.setAttribute("role", "status"); toast.setAttribute("aria-live", "polite");
  view.append(headHost, bodyHost, toast);
  document.getElementById("main-panel").appendChild(view);

  const S = { snap: null, openId: null, starting: null, refreshing: false, galIdx: {}, lb: null, size: "M", tab: "app" };
  view.dataset.size = S.size;
  // remembered size (main process file); read when the view is built, long before the first click shows it
  function paintHead() { headHost.textContent = ""; headHost.appendChild(renderHeader(S)); if (S.snap && S.snap.ok && S.snap.count) headHost.appendChild(renderTabs(S)); }   // no tabs in the setup, error or empty states
  if (api.getPrefs) api.getPrefs().then((r) => {
    const p = r && r.ok && r.prefs; if (!p) return;
    let changed = false;
    if ((p.cardSize === "S" || p.cardSize === "L") && p.cardSize !== S.size) { S.size = p.cardSize; view.dataset.size = p.cardSize; changed = true; }
    if (p.tab === "service" && S.tab !== "service") { S.tab = "service"; changed = true; }
    if (changed) { if (open && S.snap) render(); else paintHead(); }
  }).catch(() => {});
  const lbHost = el("div", "tl-lb-host hidden"); view.appendChild(lbHost);
  let open = false, navEl = null, toastTimer = null, recheck = null;
  const say = (t) => { toast.textContent = t; toast.classList.remove("hidden"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add("hidden"), 6000); };
  const findCard = (id) => { if (!S.snap || !S.snap.groups) return null; for (const g of S.snap.groups) for (const c of g.cards) if (c.id === id) return c; return null; };

  S.onOpen = (id) => { if (S.openId === id) { S.onClose(); return; } S.openId = id; S.focus = "drawer"; S.opener = id; render(); };
  S.onClose = () => { const o = S.opener; S.openId = null; S.focus = "opener"; S.opener = o; render(); };
  // lightbox (screenshots): opens over the Tools view, never navigates. Focus is trapped inside and returns to the opener on close.
  function showLb(focusRole) {
    lbHost.textContent = "";
    const card = S.lb ? findCard(S.lb.id) : null;
    if (!card || !card.screenshots || !card.screenshots[S.lb.i]) { S.lb = null; lbHost.classList.add("hidden"); return; }
    lbHost.appendChild(renderLightbox(card, S)); lbHost.classList.remove("hidden");
    const f = lbHost.querySelector('[data-role="' + (focusRole || "close") + '"]') || lbHost.querySelector('[data-role="close"]'); if (f) f.focus();
  }
  S.onLbOpen = (id, i) => { S.lb = { id, i }; showLb("close"); };
  S.onLbStep = (d, role) => { const c = S.lb && findCard(S.lb.id); if (!c) return; const n = c.screenshots.length; S.lb.i = (S.lb.i + d + n) % n; showLb(role); };
  S.onLbClose = () => {
    const id = S.lb && S.lb.id; S.lb = null; lbHost.textContent = ""; lbHost.classList.add("hidden");
    if (id) { const o = [...view.querySelectorAll("[data-shot-for]")].find((x) => x.dataset.shotFor === id); if (o) o.focus(); }
  };
  lbHost.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab") return;
    const f = [...lbHost.querySelectorAll("button:not(:disabled)")]; if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); } else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); } else if (!lbHost.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
  });
  S.onLibrary = () => { close(); const n = document.getElementById("library-nav"); if (n) n.click(); setTimeout(() => { const t = [...document.querySelectorAll("#library-view button, #library-view [role=tab]")].find((b) => /^projects/i.test((b.textContent || "").trim())); if (t) t.click(); }, 300); };
  S.onLink = (id, kind) => { api.openLink(id, kind).then((r) => { if (r && !r.ok) say(r.reason || "Could not open it."); }).catch(() => say("Could not open it.")); };
  S.onStart = (id) => {
    if (S.starting) return;
    S.starting = id; render();
    api.start(id).then((r) => { if (r && r.ok) { say("Started. It may take a few seconds to appear."); scheduleRecheck(2500); } else say((r && r.reason) || "Could not start it."); })
      .catch(() => say("Could not start it.")).then(() => { S.starting = null; if (open) render(); });
  };
  S.onRefresh = () => {
    if (S.refreshing) return;
    S.refreshing = true; render();
    api.refresh().then((r) => {
      if (!r || !r.ok) { say((r && r.reason) || "Refresh failed."); return; }
      const s = r.summary || {};
      say(r.none ? "No tool has a public repository to check." : s.offline ? "Offline: showing the last saved numbers." : s.limited ? "GitHub call limit reached: showing the last saved numbers." : "Updated: " + s.fetched + " repo(s) fetched, " + s.notModified + " unchanged.");
    }).catch(() => say("Refresh failed.")).then(() => { S.refreshing = false; return refresh(); });
  };

  S.onSize = (k) => {
    S.size = k; view.dataset.size = k;
    if (api.setPrefs) api.setPrefs({ cardSize: k }).catch(() => {});   // not remembered if it fails; the change still applies
    paintHead();   // only the header is redrawn: the cards and the scroll position stay
    const nb = headHost.querySelector('.tl-size-b[data-size="' + k + '"]'); if (nb) nb.focus();
    say("Card size: " + SIZE_NAMES[k]);
  };

  S.onTab = (k, focus) => {
    if (S.tab === k) return;
    S.tab = k; S.openId = null;   // the open card may belong to the other tab
    if (api.setPrefs) api.setPrefs({ tab: k }).catch(() => {});   // not remembered if it fails; the change still applies
    render();
    if (focus) { const nb = headHost.querySelector('.tl-tab[data-tab="' + k + '"]'); if (nb) nb.focus(); }
  };

  function render() {
    bodyHost.textContent = "";
    paintHead();
    if (!S.snap) { bodyHost.appendChild(el("div", "tl-muted tl-pad", "Reading the catalogue...")); return; }
    if (!S.snap.ok && S.snap.reason === "needs-setup") {   // v1.121.0: calm state, not an error; the Setup panel does the rest
      const c = el("section", "tl-empty");
      c.appendChild(el("b", "", "Tools needs a quick setup"));
      c.appendChild(el("p", "tl-text", "Choose where your tools list (tools.json) is, and which folders tools may be started from."));
      c.appendChild(btn("Set up", "tl-btn", () => { if (window.setupView) window.setupView.open(); }));
      bodyHost.appendChild(c); return;
    }
    if (!S.snap.ok) { bodyHost.appendChild(el("div", "tl-error tl-pad", S.snap.reason || "Tools is not available.")); return; }
    const wrap = el("div", "tl-wrap");
    const main = el("div", "tl-main");
    main.id = "tl-panel"; main.setAttribute("role", "tabpanel"); main.setAttribute("aria-labelledby", "tl-tab-" + S.tab);
    if (!S.snap.count) main.appendChild(renderEmpty(S.snap));
    else { const ti = tabInfo(S, S.tab); if (!ti.count) main.appendChild(renderTabEmpty(S.tab)); else ti.groups.forEach((g) => { if (g.cards.length) main.appendChild(renderBasket(g, S)); }); }
    if (S.snap.catalogue && S.snap.catalogue.shots && S.snap.catalogue.shots.length) main.appendChild(el("div", "tl-warn", "Some screenshots were ignored: " + S.snap.catalogue.shots.map((r) => r.id + " (" + r.count + ": " + r.codes.join(", ") + ")").join("; ")));
    if (S.snap.catalogue && S.snap.catalogue.kinds && S.snap.catalogue.kinds.length) main.appendChild(el("div", "tl-warn", "Unknown type ignored (shown under Programs): " + S.snap.catalogue.kinds.map((r) => r.id + " (kind: " + r.code + ")").join("; ")));
    if (S.snap.catalogue && S.snap.catalogue.rejected.length) main.appendChild(el("div", "tl-warn", S.snap.catalogue.rejected.length + " catalogue entr" + (S.snap.catalogue.rejected.length === 1 ? "y was" : "ies were") + " skipped as invalid: " + S.snap.catalogue.rejected.map((r) => (r.id || "?") + " (" + r.fields.join(", ") + ")").join("; ")));
    main.appendChild(renderComingUp(S.snap.coming || { total: 0, items: [] }, S));
    wrap.appendChild(main);
    const card = S.openId ? findCard(S.openId) : null;
    if (card) wrap.appendChild(renderDrawer(card, S));
    bodyHost.appendChild(wrap);
    if (S.focus === "drawer") { const d = wrap.querySelector(".tl-drawer"); if (d) d.focus(); }
    else if (S.focus === "opener" && S.opener) { const b = [...bodyHost.querySelectorAll(".tl-card .tl-btn")].find((x) => x.dataset.toolId === S.opener); if (b) b.focus(); }
    S.focus = null;
  }

  let thumbTries = 0;
  function scheduleRecheck(ms) { clearTimeout(recheck); recheck = setTimeout(() => { if (open) refresh(); }, ms); }   // the one re-check timer (after a Start, or while thumbnails are still being made)
  function refresh() { return api.load().then((s) => { S.snap = s; render(); if (S.lb) showLb("close"); if (s && s.thumbsPending && thumbTries < 6) { thumbTries++; scheduleRecheck(1500); } else thumbTries = 0; }).catch(() => { S.snap = { ok: false, reason: "The tools catalogue could not be read." }; render(); }); }

  const onDocClick = (e) => { if (e.target.closest(".argus-nav, .iris-nav, .memory-nav, #library-nav, .daily-nav, .health-nav, #agent-list .agent-item")) close(); };
  const onDocKey = (e) => {
    if (S.lb) {
      if (e.key === "Escape") { e.preventDefault(); S.onLbClose(); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); S.onLbStep(-1, "prev"); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); S.onLbStep(1, "next"); return; }
      return;
    }
    if (e.key === "Escape") { if (S.openId) S.onClose(); else close(); } };
  function openView() {
    if (open) return;
    const b = document.body;
    if (b.classList.contains("argus-open")) document.querySelector("#argus-view .argus-close")?.click();
    if (b.classList.contains("iris-open")) document.querySelector("#iris-view .iris-close")?.click();
    if (b.classList.contains("daily-open")) document.querySelector(".daily-nav")?.click();
    if (b.classList.contains("health-open")) document.querySelector(".health-nav")?.click();
    if (b.classList.contains("memory-open")) { b.classList.remove("memory-open"); document.getElementById("memory-view")?.classList.add("hidden"); document.querySelector(".memory-nav")?.classList.remove("active"); }
    const lib = document.getElementById("library-view");
    if (lib && !lib.classList.contains("hidden")) document.querySelector("#library-view .library-close")?.click();
    open = true;
    b.classList.add("tools-open");
    view.classList.remove("hidden");
    if (navEl) navEl.classList.add("active");
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onDocKey);
    render(); refresh();
  }
  function close() {
    if (!open) return;
    open = false; clearTimeout(recheck);
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onDocKey);
    document.body.classList.remove("tools-open");
    view.classList.add("hidden");
    if (navEl) navEl.classList.remove("active");
    S.lb = null; S.galIdx = {}; lbHost.textContent = ""; lbHost.classList.add("hidden");
    S.snap = null; S.openId = null; headHost.textContent = ""; bodyHost.textContent = ""; toast.textContent = ""; toast.classList.add("hidden");   // nothing from the catalogue stays in the page
  }
  window.toolsView = { toggle(nav) { if (nav) navEl = nav; open ? close() : openView(); }, close };
})();
