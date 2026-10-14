// PC health panel (v1.111.0): live dials for CPU / GPU / memory / temperatures / fans / drives, inside the Bridge (Argus).
// Design: UI-UX mockup "pc_health_panel_concepts_v3" (dark theme A). Logic that can be tested without a DOM is in ../pcHealthCore.js;
// the collector process is owned by the main process (pcHealthMain.js) and runs ONLY while this panel is open and not paused:
//   open  -> api.pcHealthStart()          (main spawns the collector)
//   leave / Esc / Bridge closed -> api.pcHealthStop("left")   (main kills it)
// Window minimised/hidden is handled in main (it stops the collector and tells us "window-hidden"; it restarts it on restore).
// Every number comes from the collector's JSON; a missing sensor is shown as "n/a", never 0. All text goes in through textContent.

(() => {
  "use strict";
  const C = window.PcHealthCore;
  const api = window.api;
  const argusView = document.getElementById("argus-view");
  if (!C || !api || !api.pcHealthStart || !argusView) return;

  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const sv = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs || {}) n.setAttribute(k, attrs[k]); return n; };

  let isOpen = false;
  let mode = "idle";          // idle | starting | live | paused-user | paused-cap | paused-hidden | snapshot | snapshot-done | error | needs-setup
  let lastData = null;
  let lastDataAt = 0;
  let gotData = false;
  const gate = C.createGate(2);        // a new state must hold 2 ticks before chips and banner switch
  const sticky = C.createSticky(20000); // temps, fans and drive free space keep their last value between slower updates

  // ------------------------------------------------------------------ skeleton
  const view = el("div", "pch hidden");
  view.id = "pchealth-view";
  view.setAttribute("aria-label", "PC health");

  const top = el("div", "pch-top");
  const backBtn = el("button", "pch-btn o", "← Bridge");
  backBtn.title = "Back to the Bridge (Esc). Leaving this page stops the live sampling.";
  const h2 = el("h2", "", "PC health");
  const pill = el("span", "pch-live"); pill.setAttribute("role", "status");
  const dot = el("span", "pch-dot"); const pillWord = el("span", "", "");
  pill.append(dot, pillWord);
  const stamp = el("span", "pch-stamp");
  const pauseBtn = el("button", "pch-btn o", "Pause");
  const snapBtn = el("button", "pch-btn o", "Snapshot (15 s)");
  snapBtn.title = "Take one 15-second averaged reading (also fills the top-processes list at once). Pauses live.";
  top.append(backBtn, h2, pill, stamp, pauseBtn, snapBtn);

  const body = el("div", "pch-body dim");
  const err = el("div", "pch-err hidden"); err.setAttribute("role", "alert");
  const prog = el("div", "pch-prog hidden"); prog.appendChild(el("i"));
  const sum = el("div", "pch-sum na"); sum.setAttribute("role", "status");
  const sumIc = el("div", "ic", "–");
  const sumTxt = el("div"); const sumB = el("b", "", "Waiting for the first reading..."); const sumS = el("span", "", "");
  sumTxt.append(sumB, sumS); sum.append(sumIc, sumTxt);

  // dials
  function makeDial(label, width, maxLabel) {
    const wrap = el("div", "pch-gc");
    wrap.appendChild(el("div", "pch-gl", label));
    const s = sv("svg", { viewBox: "0 0 200 175", width: String(width), role: "img" });
    const trk = sv("path", { d: C.arcPath(), class: "pch-trk" });
    const val = sv("path", { d: C.arcPath(), class: "pch-val na" });
    val.style.strokeDasharray = String(C.ARC_LEN);
    val.style.strokeDashoffset = String(C.ARC_LEN);
    s.append(trk, val);
    for (const t of C.ticks()) s.appendChild(sv("line", { x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2, class: "pch-tk" }));
    const lbl = (x, y, t) => { const n = sv("text", { x: String(x), y: String(y), class: "pch-tkl", "text-anchor": "middle" }); n.textContent = t; return n; };
    s.append(lbl(9, 156, "0"), lbl(100, -1, maxLabel === "" ? "" : "50"), lbl(191, 156, maxLabel || "100"));
    const r = C.needleRestPoint();
    const ndl = sv("line", { x1: "100", y1: "100", x2: r.x2, y2: r.y2, class: "pch-ndl" });
    const hub = sv("circle", { cx: "100", cy: "100", r: "7", class: "pch-hub" });
    const big = sv("text", { x: "100", y: "140", class: "pch-big", "text-anchor": "middle" });
    const sub = sv("text", { x: "100", y: "157", class: "pch-sub", "text-anchor": "middle" });
    s.append(ndl, hub, big, sub);
    const chip = el("div", "pch-chip na");
    wrap.append(s, chip);
    return {
      wrap,
      update(spec, state) {
        const pct = spec.pct;
        val.setAttribute("class", "pch-val " + state);
        val.style.strokeDashoffset = String(C.dashOffset(pct == null ? 0 : pct));
        ndl.style.transform = `rotate(${C.needleDeg(pct == null ? 0 : pct)}deg)`;
        ndl.style.opacity = pct == null ? "0.3" : "1";
        big.textContent = spec.big;
        sub.textContent = spec.sub || "";
        setChip(chip, state, false);
        s.setAttribute("aria-label", `${label} ${spec.big} ${C.WORD[state]}`);
      },
    };
  }
  function setChip(node, state, small) {
    node.className = "pch-chip" + (small ? " s " : " ") + state;
    node.textContent = "";
    node.appendChild(el("b", "", C.SYMBOL[state]));
    if (!small) node.appendChild(document.createTextNode(" " + C.WORD[state]));
    node.setAttribute("aria-label", C.WORD[state]);
  }

  const D = {
    cpu: makeDial("CPU", 190), gpu: makeDial("GPU", 190), ram: makeDial("RAM", 190), vram: makeDial("GPU memory", 190),
    pagefile: makeDial("Page file", 150), cputemp: makeDial("CPU temp", 150, "100"), gputemp: makeDial("GPU temp", 150, "84"),
  };
  const row1 = el("div", "pch-row"); row1.append(D.cpu.wrap, D.gpu.wrap, D.ram.wrap, D.vram.wrap);
  const row3 = el("div", "pch-row small"); row3.append(D.pagefile.wrap, D.cputemp.wrap, D.gputemp.wrap);

  // per-core bars
  const coreCard = el("div", "pch-card");
  coreCard.appendChild(el("h3", "", "CPU per core"));
  const coreGrp = el("div", "pch-grp", "8 P-cores (fast)  |  16 E-cores (efficient)");
  const cores = el("div", "pch-cores");
  coreCard.append(coreGrp, cores);
  const row2 = el("div", "pch-row"); row2.appendChild(coreCard);
  let coreEls = [];
  function buildCores(list) {
    cores.textContent = ""; coreEls = [];
    const hasType = list.some((c) => c.type);
    coreGrp.textContent = hasType ? `${list.filter((c) => c.type === "P").length} P-cores (fast)  |  ${list.filter((c) => c.type === "E").length} E-cores (efficient)` : `${list.length} cores`;
    let pi = 0, ei = 0;
    for (const c of list) {
      const cell = el("div", c.type === "E" ? "e" : "p");
      const bar = el("i");
      const name = c.type === "P" ? "P" + pi++ : c.type === "E" ? "E" + ei++ : String(c.id);
      cell.append(bar, document.createTextNode(name));
      cores.appendChild(cell);
      coreEls.push({ bar, cell, name });
    }
  }

  // drives / fans / network / uptime
  const driveCard = el("div", "pch-card"); const driveH = el("h3", "", "Drives");
  const driveRows = el("div"); const driveNote = el("div", "pch-note");
  driveCard.append(driveH, driveRows, driveNote);
  const fanCard = el("div", "pch-card");
  fanCard.appendChild(el("h3", "", "Fans (no maximum known: bar scale is a fixed 0-2000 rpm)"));
  const fanRows = el("div");
  const netH = el("h3", "", "Network"); netH.style.marginTop = "12px";
  const netRows = el("div");
  const upRow = el("div", "pch-br"); const upL = el("span", "bl", "Uptime"); const upV = el("span", "bv ink", "n/a"); upRow.append(upL, upV);
  fanCard.append(fanRows, netH, netRows, upRow);
  const row4 = el("div", "pch-row"); row4.append(driveCard, fanCard);

  function barRow(label, state, pct, valueText) {
    const r = el("div", "pch-br");
    const l = el("span", "bl", label);
    const t = el("span", "bt"); const i = el("i", state); t.appendChild(i);
    const v = el("span", "bv", valueText);
    const chip = el("span"); setChip(chip, state, true);
    r.append(l, t, v, chip);
    i.style.width = Math.max(0, Math.min(100, pct)) + "%";
    return { r, i, v, chip, l };
  }
  const barCache = new Map(); // key -> row, so bars ease from their old width instead of being rebuilt
  function syncBars(host, prefix, items) { // items: [{key,label,state,pct,text}]
    const seen = new Map(); // two fans with the same name (or any repeated key) get an index suffix so they never share a bar
    items = items.map((x) => { const n = seen.get(x.key) || 0; seen.set(x.key, n + 1); return n ? Object.assign({}, x, { key: x.key + "#" + n }) : x; });
    const keep = new Set(items.map((x) => prefix + x.key));
    for (const [k, row] of [...barCache]) if (k.startsWith(prefix) && !keep.has(k)) { row.r.remove(); barCache.delete(k); }
    items.forEach((x, idx) => {
      const k = prefix + x.key;
      let row = barCache.get(k);
      if (!row) { row = barRow(x.label, x.state, x.pct, x.text); barCache.set(k, row); }
      row.i.className = x.state; row.i.style.width = Math.max(0, Math.min(100, x.pct)) + "%";
      row.v.textContent = x.text; setChip(row.chip, x.state, true);
      if (host.children[idx] !== row.r) host.insertBefore(row.r, host.children[idx] || null);
    });
  }

  // top processes
  const procCard = el("div", "pch-card");
  const procTable = el("table");
  const procHead = el("tr"); procHead.append(el("th", "", "Top processes"), el("th", "n", "CPU"), el("th", "n", "RAM"));
  const procBody = el("tbody");
  procTable.append(el("thead")); procTable.firstChild.appendChild(procHead); procTable.appendChild(procBody);
  procCard.appendChild(procTable);
  const row5 = el("div", "pch-row"); row5.appendChild(procCard);
  function drawProcs(list) {
    procBody.textContent = "";
    if (!list || !list.length) {
      const tr = el("tr", "ph"); const td = el("td", "", "Collecting top processes..."); td.colSpan = 3; tr.appendChild(td); procBody.appendChild(tr); return;
    }
    for (const p of list) {
      const tr = el("tr");
      tr.append(el("td", "", p.name + (p.count > 1 ? " ×" + p.count : "")), el("td", "n", C.pctText(p.cpu_pct)),
        el("td", "n", typeof p.ram_gb === "number" ? C.gbText(p.ram_gb) + " GB" : "n/a"));
      procBody.appendChild(tr);
    }
  }
  drawProcs([]);

  // legend (always visible)
  const leg = el("div", "pch-leg");
  const legItem = (state, text) => { const s = el("span"); const c = el("span"); setChip(c, state, false); s.append(c, document.createTextNode(text)); return s; };
  leg.append(legItem("ok", "normal range"), legItem("warn", "high or filling up, still working"),
    legItem("bad", "red = broken or about to be (throttling, drive full, memory exhausted)"),
    el("span", "", "Colour is never the only signal: every state also has a symbol and a word."));
  const foot = el("div", "pch-note");

  body.append(err, prog, sum, row1, row2, row3, row4, row5, leg, foot);
  view.append(top, body);
  argusView.appendChild(view);

  // ------------------------------------------------------------------ rendering one tick
  const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function render(d0) {
    // temps / fans / drives hold their last value between slower updates; a long gap becomes n/a
    const now = Date.now();
    const d = Object.assign({}, d0);
    d.cpu = Object.assign({}, d0.cpu, { temp_c: sticky.get("cpu.temp", d0.cpu && d0.cpu.temp_c, now) });
    d.gpu = Object.assign({}, d0.gpu, { temp_c: sticky.get("gpu.temp", d0.gpu && d0.gpu.temp_c, now) });
    d.fans = sticky.get("fans", d0.fans, now) || [];
    d.drives = sticky.get("drives", d0.drives, now) || [];

    const items = C.scoredItems(d, gate);   // updates the gate for cpu/gpu/ram/pagefile/drives/fans
    const b = C.banner(items);
    sum.className = "pch-sum " + b.state;
    sumIc.textContent = C.SYMBOL[b.state];
    sumB.textContent = b.title; sumS.textContent = b.detail;

    const dl = C.dials(d);
    for (const k of ["cpu", "gpu", "ram", "pagefile"]) dl[k].state = gate.shown(k);
    dl.vram.state = gate.update("vram", dl.vram.state);
    dl.cputemp.state = gate.update("cputemp", dl.cputemp.state);
    dl.gputemp.state = gate.update("gputemp", dl.gputemp.state);
    for (const k of Object.keys(D)) D[k].update(dl[k], dl[k].state);

    const cl = (d.cpu && d.cpu.cores) || [];
    if (cl.length !== coreEls.length) buildCores(cl);
    cl.forEach((c, i) => {
      const e = coreEls[i]; if (!e) return;
      e.bar.style.height = Math.max(3, Math.round((C.clampPct(c.pct) / 100) * 66)) + "px";
      e.cell.title = `${e.name}: ${C.pctText(c.pct)}`;
    });

    driveH.textContent = `Drives (${d.drives.length})`;
    syncBars(driveRows, "d:", d.drives.map((x) => ({
      key: x.letter, label: x.label, state: gate.shown("drive:" + x.letter), pct: x.used_pct || 0,
      text: `${C.pctText(x.used_pct)} full · ${C.freeText(x.free_gb)} free`,
    })));
    const busy = d.drives.filter((x) => typeof x.busy_pct === "number");
    const top1 = d.drives.filter((x) => typeof x.mb_s === "number").sort((a, b2) => b2.mb_s - a.mb_s)[0];
    driveNote.textContent = busy.length
      ? "Disk busy: " + busy.map((x) => `${x.letter} ${Math.round(x.busy_pct)}%`).join(", ") + (top1 && top1.mb_s > 0.1 ? ` · ${top1.letter}: ${top1.mb_s.toFixed(1)} MB/s` : "")
      : "Disk busy: n/a";

    syncBars(fanRows, "f:", d.fans.map((x) => ({
      key: x.name, label: x.name, state: gate.shown("fan:" + x.name), pct: C.fanPct(x.rpm),
      text: typeof x.rpm === "number" ? `${Math.round(x.rpm)} rpm` : "n/a",
    })));
    if (!d.fans.length && !fanRows.firstChild) fanRows.appendChild(el("div", "pch-note", "No fan readings (the sensor logger has no fresh data): n/a"));
    else if (d.fans.length) { const n = fanRows.querySelector(".pch-note"); if (n) n.remove(); }

    const net = d0.net || {}; const link = typeof net.link_mbit === "number" && net.link_mbit > 0 ? net.link_mbit : null;
    syncBars(netRows, "n:", [
      { key: "down", label: "Download", state: "ok", pct: link && typeof net.down_mbit === "number" ? (net.down_mbit / link) * 100 : 0, text: C.mbitText(net.down_mbit) },
      { key: "up", label: "Upload", state: "ok", pct: link && typeof net.up_mbit === "number" ? (net.up_mbit / link) * 100 : 0, text: C.mbitText(net.up_mbit) },
    ]);
    upV.textContent = C.uptimeText(d0.uptime_s);

    drawProcs(d0.top_procs);
    foot.textContent = (d0.snapshot ? "Snapshot: 15-second average, taken " : "Reading from ") + fmtClock(now) + (d0.sensors_fresh === false ? " · temperature and fan sensors are not reporting (n/a)" : "");
    body.classList.remove("dim");
    gotData = true;
  }

  // ------------------------------------------------------------------ mode (header, banner of the collector's own state)
  function setMode(m, message) {
    mode = m;
    pill.className = "pch-live" + (m === "live" ? "" : m === "starting" || m === "snapshot" ? " busy" : m === "error" ? " err" : " pz");
    const word = { live: "LIVE", starting: "STARTING", snapshot: "SAMPLING", error: "NO DATA", "needs-setup": "SET UP", idle: "" }[m] || "PAUSED";
    pillWord.textContent = word;
    const at = lastDataAt ? fmtClock(lastDataAt) : "";
    stamp.textContent = {
      live: "updated every ~1.5 s · stops when you leave this page",
      starting: "Starting the collector...",
      snapshot: "Sampling for 15 seconds...",
      "paused-user": "Paused" + (at ? ". The readings below are from " + at : ""),
      "paused-cap": "Live stopped after 5 minutes to save power",
      "paused-hidden": "Paused while the window is hidden; it resumes by itself when you come back",
      "snapshot-done": "Snapshot taken" + (at ? " at " + at : "") + " (15-second average). Live is paused.",
      error: "The live reading stopped",
      "needs-setup": "PC Health is not set up on this computer yet",
    }[m] || "";
    const live = m === "live" || m === "starting";
    pauseBtn.textContent = live ? "Pause" : "Resume live";
    pauseBtn.className = "pch-btn " + (live ? "o" : "p");
    pauseBtn.disabled = m === "snapshot";
    snapBtn.disabled = m === "snapshot";
    prog.classList.toggle("hidden", m !== "snapshot");
    err.classList.toggle("hidden", m !== "error" && m !== "needs-setup");
    err.classList.toggle("calm", m === "needs-setup");
    if (m === "error") err.textContent = message || "The PC health collector stopped.";
    if (m === "needs-setup") { // a calm state, not an error: say what is missing and offer the one button that fixes it
      err.textContent = (message || "PC Health needs Python and its measuring script.") + " ";
      const go = el("button", "pch-btn p", "Set up");
      go.addEventListener("click", () => { const sn = document.getElementById("setup-nav"); close(); if (sn) sn.click(); });
      err.appendChild(go);
    }
    if (m === "paused-cap" || m === "paused-user" || m === "paused-hidden" || m === "snapshot-done") body.classList.toggle("dim", !gotData);
  }

  // ------------------------------------------------------------------ events from main
  api.onPcHealthData((d) => {
    if (!isOpen || !d || typeof d !== "object") return;
    lastData = d; lastDataAt = Date.now();
    try { render(d); } catch (e) { console.error("[pchealth] render", e); }
  });
  api.onPcHealthStatus((s) => {
    if (!isOpen || !s) return;
    if (s.state === "starting") { if (mode !== "snapshot") setMode("starting"); return; }
    if (s.state === "running") { setMode("live"); return; }
    if (s.state === "error") { setMode("error", s.message); return; }
    if (s.state === "needs-setup") { setMode("needs-setup", s.message); return; }
    if (s.state === "stopped") {
      if (s.reason === "cap") setMode("paused-cap");
      else if (s.reason === "window-hidden") setMode("paused-hidden");
      else if (s.reason === "snapshot-done") setMode("snapshot-done");
      else if (s.reason === "reload" || s.reason === "gone" || s.reason === "closed" || s.reason === "quit") setMode("paused-user"); // never claim LIVE with no collector
      // user / left / switch: the renderer already knows ("switch" = the snapshot sets its own mode)
    }
  });

  // ------------------------------------------------------------------ controls
  function startLive() {
    setMode("starting");
    api.pcHealthStart().then((r) => {
      if (!isOpen) return;
      if (r && r.visible === false) setMode("paused-hidden");
      else if (r && r.ok === false && r.reason === "needs-setup") setMode("needs-setup");
      else if (r && r.ok === false) setMode("error", "Could not start the PC health collector.");
    }).catch((e) => { if (isOpen) setMode("error", "Could not start the PC health collector: " + String((e && e.message) || e)); });
  }
  pauseBtn.addEventListener("click", () => {
    if (mode === "live" || mode === "starting") { setMode("paused-user"); api.pcHealthStop("user"); }
    else startLive();
  });
  snapBtn.addEventListener("click", () => {
    setMode("snapshot");
    api.pcHealthSnapshot().then((r) => { if (isOpen && r && r.ok === false) { if (r.reason === "needs-setup") setMode("needs-setup"); else setMode("error", "Could not start the snapshot."); } })
      .catch((e) => { if (isOpen) setMode("error", "Could not start the snapshot: " + String((e && e.message) || e)); });
  });

  function open() {
    if (isOpen) return;
    const nav = document.querySelector(".argus-nav");
    if (!document.body.classList.contains("argus-open") && nav) nav.click(); // the panel lives inside the Bridge
    isOpen = true; gotData = false; lastData = null; lastDataAt = 0;
    gate.reset(); sticky.reset();
    body.classList.add("dim");
    view.classList.remove("hidden");
    document.body.classList.add("pchealth-open");
    startLive();
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    view.classList.add("hidden");
    document.body.classList.remove("pchealth-open");
    setMode("idle");
    api.pcHealthStop("left");
  }
  backBtn.addEventListener("click", close);
  // Esc leaves the panel first (before the Bridge's own Esc), and the Bridge closing takes the panel with it.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) { e.stopImmediatePropagation(); close(); }
  }, true);
  new MutationObserver(() => { if (isOpen && !document.body.classList.contains("argus-open")) close(); })
    .observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("beforeunload", () => { try { api.pcHealthStop("left"); } catch (e) { /* page is going away; main also stops on reload */ } });

  // ------------------------------------------------------------------ entry points: a "PC health" tab in the Bridge header, and a small icon in the title bar
  const heartIcon = () => {
    const s = sv("svg", { viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
    s.appendChild(sv("polyline", { points: "3 12 7 12 9.5 6 14 18 16.5 12 21 12" }));
    return s;
  };
  const head = argusView.querySelector(".argus-head");
  if (head) {
    const tab = el("button", "argus-btn pch-tab");
    tab.append(heartIcon(), document.createTextNode(" PC health"));
    tab.title = "PC health: live CPU, GPU, memory, temperatures, fans and drives. Only samples while this page is open.";
    tab.addEventListener("click", open);
    const refresh = [...head.children].find((n) => n.classList && n.classList.contains("argus-btn"));
    head.insertBefore(tab, refresh || head.lastChild);
  }
  let icon = null;
  function ensureIcon() {
    const controls = document.querySelector("#chat-header .xp-controls");
    if (!controls) return;
    if (!icon) {
      icon = el("button", "pch-icon");
      icon.appendChild(heartIcon());
      icon.title = "PC health (live CPU, GPU, memory, temperatures, fans, drives)";
      icon.setAttribute("aria-label", "PC health");
      icon.addEventListener("click", open);
    }
    if (!controls.contains(icon)) controls.insertBefore(icon, controls.firstChild);
  }
  new MutationObserver(ensureIcon).observe(document.getElementById("chat-view") || document.body, { childList: true, subtree: true });
  ensureIcon();

  window.pcHealthView = { open, close, isOpen: () => isOpen, mode: () => mode };
})();
