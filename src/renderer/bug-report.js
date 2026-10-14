// "Report a problem" dialog (v1.123.0). Opened by the button in the Setup panel header (window.BugReport.open(langCode)).
// textContent only (no innerHTML), no timers; the renderer never builds a path: the folder and the picture come from main's file dialogs,
// the terminal from an agent id main hands out. Words: bug-report-strings.js (English + Hebrew, RTL for Hebrew). Styles: styles-bug-report.css.
(function () {
  "use strict";
  const api = window.api && window.api.bugReport;
  const BS = window.BugReportStrings;
  if (!api || !BS) return;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  let overlay = null, code = "en", prevFocus = null;
  const T = (k) => { const v = BS.pick(code)[k]; return v !== undefined ? v : BS.lang.en[k]; };
  const err = (r) => { const m = BS.pick(code).errors || {}; return m[r && r.error] || BS.lang.en.errors[r && r.error] || m.generic; };

  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* element gone */ } }
  }

  async function open(langCode) {
    if (overlay) return;
    code = BS.lang[langCode] ? langCode : "en";
    prevFocus = document.activeElement;
    const info = await api.info();
    if (!info || !info.ok) return;
    const S = { dest: info.defaultDir, shotName: "", previewId: null, busy: false };
    const boxes = {};   // item id -> checkbox
    overlay = el("div"); overlay.id = "bugreport-overlay";
    const dlg = el("div"); dlg.id = "bugreport-dialog"; dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-labelledby", "bugreport-title");
    dlg.setAttribute("dir", BS.pick(code).dir); dlg.setAttribute("lang", code);
    overlay.appendChild(dlg);
    const msg = el("div", "br-msg"); msg.setAttribute("role", "status");
    const say = (t, bad) => { msg.textContent = t || ""; msg.className = "br-msg" + (bad ? " br-bad" : ""); };

    const h = el("h2", null, T("title")); h.id = "bugreport-title";
    const what = el("textarea"); what.id = "bugreport-what"; what.rows = 3; what.maxLength = 4000; what.setAttribute("dir", "auto");
    const whatLbl = el("label", "br-lbl", T("whatLabel")); whatLbl.htmlFor = "bugreport-what";
    const steps = el("textarea"); steps.id = "bugreport-steps"; steps.rows = 2; steps.maxLength = 4000; steps.setAttribute("dir", "auto");
    const stepsLbl = el("label", "br-lbl", T("stepsLabel")); stepsLbl.htmlFor = "bugreport-steps";

    const list = el("div", "br-items");
    const previewBox = el("pre", "br-preview hidden"); previewBox.setAttribute("dir", "ltr"); previewBox.tabIndex = 0;
    const agentSel = el("select"); agentSel.id = "bugreport-agent"; agentSel.setAttribute("aria-label", T("pickAgent"));
    const first = el("option", null, T("chooseAgent")); first.value = ""; agentSel.appendChild(first);
    for (const a of info.agents) { const o = el("option", null, a.name); o.value = a.id; agentSel.appendChild(o); }
    const shotInfo = el("span", "br-shotinfo", T("noShot"));
    const shotBtn = el("button", "br-btn", T("pickShot")); shotBtn.type = "button";
    const shotClear = el("button", "br-btn hidden", T("removeShot")); shotClear.type = "button";

    const form = () => ({
      what: what.value, steps: steps.value, agentId: agentSel.value, previewId: S.previewId,
      include: { terminal: boxes.terminal.checked, screenshot: boxes.screenshot.checked },
    });

    async function showPreview(itemId) {
      const need = form();
      if (need.include.terminal && !need.agentId) { say(T("needAgent"), true); return; }
      if (need.include.screenshot && !S.shotName) { say(T("needShot"), true); return; }
      say("");
      // a preview of an optional item shows it even while it is not ticked yet
      if (itemId === "terminal" && !need.agentId) { say(T("needAgent"), true); return; }
      if (itemId === "terminal") need.include.terminal = true;
      if (itemId === "screenshot") { if (!S.shotName) { say(T("needShot"), true); return; } need.include.screenshot = true; }
      const r = await api.preview(need);
      if (!r || !r.ok) { say(err(r), true); return; }
      S.previewId = need.include.terminal === boxes.terminal.checked && need.include.screenshot === boxes.screenshot.checked ? r.previewId : null;
      previewBox.textContent = "";
      for (const f of r.files.filter((x) => x.item === itemId)) {
        previewBox.appendChild(el("div", "br-pv-name", "=== " + f.name + " ==="));
        const body = el("div", "br-pv-text", f.text != null ? f.text : T("picNote") + " " + f.bytes + " " + T("bytes")); if (f.text == null) body.setAttribute("dir", "auto");
        previewBox.appendChild(body);
      }
      previewBox.dataset.item = itemId;
      previewBox.classList.remove("hidden");
    }

    for (const it of info.items) {
      const words = BS.pick(code).items[it.id] || BS.lang.en.items[it.id];
      const row = el("div", "br-item");
      const cb = el("input"); cb.type = "checkbox"; cb.id = "bugreport-it-" + it.id; cb.checked = !!it.always; cb.disabled = !!it.always; boxes[it.id] = cb;
      const lbl = el("label", "br-item-name", words[0]); lbl.htmlFor = cb.id;
      const tag = el("span", "br-tag", it.always ? T("always") : T("optional"));
      const pv = el("button", "br-link", T("preview")); pv.type = "button";
      pv.addEventListener("click", () => {
        if (!previewBox.classList.contains("hidden") && previewBox.dataset.item === it.id) { previewBox.classList.add("hidden"); return; }
        showPreview(it.id);
      });
      const top = el("div", "br-item-top"); top.append(cb, lbl, tag, pv);
      row.append(top, el("div", "br-item-why", words[1]));
      if (it.id === "terminal") { const w = el("div", "br-extra"); w.append(el("span", null, T("pickAgent") + " "), agentSel); row.appendChild(w); }
      if (it.id === "screenshot") { const w = el("div", "br-extra"); w.append(shotBtn, shotClear, shotInfo); row.appendChild(w); }
      list.appendChild(row);
    }
    shotBtn.addEventListener("click", async () => {
      const r = await api.pickScreenshot();
      if (!r || !r.ok) { say(err(r), true); return; }
      if (r.canceled) return;
      say(""); S.shotName = r.name; shotInfo.textContent = r.name; shotBtn.textContent = T("changeShot"); shotClear.classList.remove("hidden"); boxes.screenshot.checked = true; S.previewId = null;
    });
    shotClear.addEventListener("click", async () => {
      await api.pickScreenshot(true); S.shotName = ""; shotInfo.textContent = T("noShot"); shotBtn.textContent = T("pickShot"); shotClear.classList.add("hidden"); boxes.screenshot.checked = false; S.previewId = null;
    });
    for (const x of [what, steps, agentSel, boxes.terminal, boxes.screenshot]) { x.addEventListener("input", () => { S.previewId = null; }); x.addEventListener("change", () => { S.previewId = null; }); }

    const destPath = el("code", "br-dest", S.dest); destPath.setAttribute("dir", "ltr");
    const destBtn = el("button", "br-btn", T("change")); destBtn.type = "button";
    destBtn.addEventListener("click", async () => { const r = await api.pickFolder(); if (!r || !r.ok) { say(err(r), true); return; } if (r.canceled) return; S.dest = r.path; destPath.textContent = r.path; });
    const dest = el("div", "br-dest-row"); dest.append(el("span", null, T("saveIn") + " "), destPath, destBtn);

    const create = el("button", "br-btn br-primary", T("create")); create.type = "button";
    const cancel = el("button", "br-btn", T("cancel")); cancel.type = "button"; cancel.addEventListener("click", close);
    const actions = el("div", "br-actions"); actions.append(create, cancel);
    create.addEventListener("click", async () => {
      if (S.busy) return;
      const f = form();
      if (!f.what.trim()) { say(T("needWhat"), true); what.focus(); return; }
      if (f.include.terminal && !f.agentId) { say(T("needAgent"), true); return; }
      if (f.include.screenshot && !S.shotName) { say(T("needShot"), true); return; }
      S.busy = true; create.disabled = true; say(T("working"));
      const r = await api.create(f);
      S.busy = false; create.disabled = false;
      if (r && r.error === "preview-required") { say(T("previewFirst"), true); await showPreview("terminal"); return; }
      if (!r || !r.ok) { const m = BS.pick(code).errors || {}; say(r && r.hint && (m[r.hint] || BS.lang.en.errors[r.hint]) ? (m[r.hint] || BS.lang.en.errors[r.hint]) : err(r), true); return; }
      dlg.textContent = "";
      const done = el("div", "br-done");
      const zipP = el("code", "br-dest", r.zip); zipP.setAttribute("dir", "ltr");
      const dirP = el("code", "br-dest", r.dir); dirP.setAttribute("dir", "ltr");
      const open2 = el("button", "br-btn br-primary", T("openFolder")); open2.type = "button"; open2.addEventListener("click", () => { api.openFolder(); });
      const closeBtn = el("button", "br-btn", T("close")); closeBtn.type = "button"; closeBtn.addEventListener("click", close);
      const row = el("div", "br-actions"); row.append(open2, closeBtn);
      const l1 = el("div", "br-line"); l1.append(el("span", null, T("zipLabel") + " "), zipP);
      const l2 = el("div", "br-line"); l2.append(el("span", null, T("folderLabel") + " "), dirP);
      done.append(el("h2", null, T("doneTitle")), el("p", null, T("doneText")));
      if (r.fellBack) done.append(el("p", "br-note", T("fellBack")));
      done.append(l1, l2, row);
      dlg.appendChild(done); open2.focus();
    });

    dlg.append(h, el("p", "br-intro", T("intro")), whatLbl, what, el("div", "br-hint", T("whatHint")), stepsLbl, steps, el("h3", null, T("included")), list, previewBox, dest, msg, actions);
    overlay.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } });
    overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) close(); });
    document.body.appendChild(overlay);
    what.focus();
  }
  window.BugReport = { open };
})();
