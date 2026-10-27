// My Daily - Shipments tab (v1.76.0). Loaded before daily.js, which calls window.dailyShipments.create(ctx) once.
// textContent only (carrier names, events and mail text are never parsed as HTML). No timers: data loads when the tab opens
// or on "Refresh now"; the 3-hourly poll lives in the main process. Event text gets dir="auto" so Hebrew reads right-to-left.
(function () {
  "use strict";
  window.dailyShipments = {
    create(ctx) {
      const { el, btn, say, copyText, api } = ctx;
      let data = null;            // last daily-shipments-load result
      let loading = null;
      let showArchive = false;
      let showAdd = false;
      let showKey = false;
      let busy = false;
      let loadedAt = 0;
      const STALE_MS = 60000;

      const CHIP = {   // state -> [label, css class]
        action_pay: ["Pay now", "bad"], action_pickup: ["Pick up", "warn"], exception_stuck: ["Problem", "bad"],
        out_for_delivery: ["Out for delivery", "ok"], in_transit: ["In transit", ""], customs: ["In customs", ""],
        shipped: ["Shipped", ""], ordered: ["Ordered", "mute"], delivered: ["Delivered", "ok"],
      };
      const CARRIER_ICON = { fedex: "FX", ups: "UPS", dhl: "DHL", dhl_ecom: "DHL", amazon: "AMZ", cainiao: "CNO", israelpost: "IL", yunexpress: "YT", aramex: "ARX", cheetah: "CH", hfd: "HFD", gaash: "GA", orian: "OR", exelot: "EX", other: "?" };
      const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

      function load(force) {
        if (loading) return loading;
        loading = (force ? api.shipmentsRefresh() : api.shipmentsLoad(false))
          .then((r) => { if (r && r.ok) { data = r; loadedAt = Date.now(); } else if (r && r.reason) say(r.reason); return r; })
          .catch((e) => { console.error("shipments load", e); return null; })
          .finally(() => { loading = null; });
        return loading;
      }
      const ago = (ms, now) => {
        if (!ms) return "";
        const m = Math.max(0, Math.round(((now || Date.now()) - ms) / 60000));
        return m < 2 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
      };
      const dayText = (iso, now) => {
        const t = Date.parse(iso || "");
        if (!Number.isFinite(t)) return "";
        const a = new Date(now); a.setHours(0, 0, 0, 0);
        const b = new Date(t); b.setHours(0, 0, 0, 0);
        const d = Math.round((b - a) / 86400000);
        const base = `${b.getDate()} ${MONTHS[b.getMonth()]}`;
        const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][b.getDay()];
        return d === 0 ? `today (${wd} ${base})` : d === 1 ? `tomorrow (${wd} ${base})` : d === -1 ? `yesterday (${wd} ${base})` : `${wd} ${base}`;
      };
      const chipEl = (state) => { const c = CHIP[state] || ["?", ""]; return el("span", "ship-chip " + c[1], c[0]); };

      async function act(op, id, extra, okMsg) {
        if (busy) return;
        busy = true;
        const r = await api.shipmentsOp(Object.assign({ op, id }, extra || {}));
        busy = false;
        if (r && r.ok) { await load(false); ctx.rerender(); if (okMsg) say(okMsg); }
        else say((r && r.reason) || "That did not work.");
        return r;
      }

      // Carrier list comes from the main process (data.carriers); "" = let 17TRACK / the number format decide.
      function carrierSelect(selected) {
        const sel = el("select", "daily-input ship-sel");
        sel.append(Object.assign(el("option", null, "Carrier: auto-detect"), { value: "" }));
        for (const c of (data && data.carriers) || []) {
          const o = el("option", null, c.name); o.value = c.id;
          if (c.id === selected) o.selected = true;
          sel.append(o);
        }
        sel.title = "Optional. Leave on auto-detect unless you know the carrier.";
        return sel;
      }
      const shortDay = (ms) => { const d = new Date(ms); return Number.isFinite(d.getTime()) ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : ""; };
      // what the owner sees to tell parcels apart: merchant, product, order id, order date
      const orderLabel = (s) => [s.merchant, s.title && s.title !== s.merchant ? s.title : "", s.orderId ? "order " + s.orderId : "", s.orderAt ? "ordered " + shortDay(s.orderAt) : ""].filter(Boolean).join(" - ");

      // 16-17 plain digits look like order numbers: the main process answers needsConfirm; the next press of the SAME button is
      // relabelled "Use it anyway" and sends force:true. Returns a click handler for run(force) -> act() result.
      function confirmable(button, run) {
        let force = false;
        return async () => {
          const r = await run(force);
          if (r && r.needsConfirm) { force = true; button.textContent = "Use it anyway"; }
          return r;
        };
      }
      // A parcel that has no valid tracking number yet (only an order number came by mail): box to paste the real one.
      function numberBox(s) {
        const w = el("div", "ship-numbox");
        w.append(el("div", "ship-muted sm", "Tracking number for: " + (orderLabel(s) || "this parcel")));
        const line = el("div", "ship-add");
        const inp = el("input", "daily-input grow");
        inp.placeholder = "Paste the tracking number (not the order number)";
        inp.maxLength = 400; inp.setAttribute("dir", "auto");
        const sel = carrierSelect("");
        let go = () => {};
        const saveBtn = btn("Save number", "daily-btn sm pri", () => go());
        go = confirmable(saveBtn, (force) => { const v = inp.value.trim(); return v ? act("add-number", s.id, { text: v, carrier: sel.value, force }, "Tracking number saved.") : null; });
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
        inp.addEventListener("input", () => { saveBtn.textContent = "Save number"; });
        line.append(inp, sel, saveBtn);
        w.append(line);
        return w;
      }
      // 17TRACK could not identify or find the number: say so plainly and let the owner set the carrier later.
      function carrierBox(s) {
        const w = el("div", "ship-numbox");
        w.append(el("div", "ship-muted sm", "Once you know the carrier, pick it here and the number is registered again with it."));
        const line = el("div", "ship-add");
        const sel = carrierSelect(s.carrier === "other" ? "" : s.carrier);
        line.append(sel, btn("Set carrier", "daily-btn sm pri", () => act("set-carrier", s.id, { carrier: sel.value || "auto" }, "Carrier set. Checking again...")));
        w.append(line);
        return w;
      }
      // the line that says WHY there is no live state (replaces the old generic "state comes from the email" text)
      function reasonLine(s) {
        if (s.needsNumber) return el("div", "ship-ev ship-warnline", "No tracking number yet - the email only had the order number. Paste the real tracking number below.");
        if (s.cantTrack) return el("div", "ship-ev ship-warnline", "Can't track this package yet - ask the sender which carrier they use.");
        if (s.reason && s.reason.text) return el("div", "ship-ev ship-muted", s.reason.text);
        return el("div", "ship-ev ship-muted", s.source === "email" ? "Not checked by the tracking service yet." : "Waiting for the first tracking event.");
      }
      const PROBLEM = new Set(["quota", "key_refused", "rate", "error"]);

      function row(s, now, archived) {
        const r = el("div", "ship-row" + (archived ? " archived" : ""));
        const ico = el("div", "ship-ico", CARRIER_ICON[s.carrier] || "?");
        ico.title = s.carrierName;
        const main = el("div", "ship-main");
        const l1 = el("div", "ship-l1");
        const name = s.title || s.merchant || (s.numbers[0] ? s.carrierName : "Parcel");
        l1.append(el("b", "ship-name", name), chipEl(s.effective));
        if (s.review) l1.append(el("span", "ship-chip mute", "Review sample"));
        if (s.merchant && s.title && s.merchant !== s.title) l1.append(el("span", "ship-merch", s.merchant));
        const l2 = el("div", "ship-l2");
        if (!s.needsNumber) l2.append(el("span", "ship-carrier", s.carrierName));
        else if (s.orderId) l2.append(el("span", "ship-carrier", "Order " + s.orderId + (s.orderAt ? ", " + shortDay(s.orderAt) : "")));
        for (const n of s.numbers.slice(0, 3)) {
          const nb = btn(n.no, "ship-no", () => { copyText(n.no); say("Tracking number copied."); });
          nb.title = `${n.carrierName} - click to copy`;
          l2.append(nb);
        }
        if (s.eta && !archived) l2.append(el("span", "ship-eta", "ETA " + dayText(s.eta, now)));
        main.append(l1, l2);
        if (s.action && !archived) main.append(el("div", "ship-action " + (CHIP[s.effective] || [0, ""])[1], s.action + " !"));
        const ev = s.lastEvent;
        if (ev && ev.text) {
          const l3 = el("div", "ship-ev");
          const t = el("span", "ship-ev-t", ev.text);
          t.setAttribute("dir", "auto");
          l3.append(t);
          const tail = [ev.place, ev.at ? ago(ev.at, now) : ""].filter(Boolean).join(" - ");
          if (tail) { const p = el("span", "ship-ev-p", " (" + tail + ")"); p.setAttribute("dir", "auto"); l3.append(p); }
          main.append(l3);
        } else if (!archived) main.append(reasonLine(s));
        if (!archived && ev && ev.text && s.reason && PROBLEM.has(s.reason.reason)) main.append(el("div", "ship-ev ship-warnline", s.reason.text));
        if (!archived && s.needsNumber) main.append(numberBox(s));
        else if (!archived && s.cantTrack) main.append(carrierBox(s));
        if (s.events && s.events.length > 1) {
          const det = el("details", "ship-hist");
          det.append(el("summary", "ship-muted", "Tracking history (" + s.events.length + " steps)"));
          for (const e of s.events) {
            const li = el("div", "ship-ev");
            const when = e.at ? new Date(e.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
            const tx = el("span", "ship-ev-t", [when, e.place, e.text].filter(Boolean).join(" - "));
            tx.setAttribute("dir", "auto");
            li.append(tx);
            det.append(li);
          }
          main.append(det);
        }
        if (s.note2) main.append(el("div", "ship-ev ship-muted", s.note2));
        if (s.from && s.title !== "From " + s.from) main.append(el("div", "ship-from ship-muted", "From " + s.from + (s.to ? " to " + s.to : "")));
        const acts = el("div", "ship-acts");
        if (s.url) { const o = btn("Carrier page", "daily-btn sm", () => window.open(s.url)); o.title = "Open the carrier's own tracking page in your browser"; acts.append(o); }
        if (!archived) {
          if (s.effective === "action_pickup" || s.effective === "out_for_delivery") acts.append(btn("Mark picked up", "daily-btn sm pri", () => act("picked-up", s.id, null, "Marked as picked up and archived.")));
          else acts.append(btn("Picked up", "daily-btn sm", () => act("picked-up", s.id, null, "Marked as picked up and archived.")));
          acts.append(btn("Archive", "daily-btn sm", () => act("archive", s.id, null, "Archived.")));
        } else {
          acts.append(btn("Bring back", "daily-btn sm", () => act("unarchive", s.id, null, "Back in the active list.")));
          acts.append(btn("Delete", "daily-btn sm", () => act("delete", s.id, null, "Deleted.")));
        }
        r.append(ico, main, acts);
        return r;
      }

      function group(title, list, now, cls, note) {
        const g = el("section", "daily-card ship-group " + (cls || ""));
        const h = el("h3", "daily-card-h");
        h.append(el("span", null, title), el("span", "daily-n " + (cls === "needs" ? "warn" : ""), String(list.length)));
        if (note) h.append(el("span", "daily-muted ship-note", note));
        g.append(h);
        for (const s of list) g.append(row(s, now, false));
        return g;
      }

      // + Add shipment: only the number is required. Carrier is optional (17TRACK auto-detects), label and "Review sample" are optional.
      // While a number is typed, parcels still waiting for a number are listed so it can be attached to the right order.
      function addBar() {
        const box = el("div", "daily-card ship-addcard");
        const w = el("div", "ship-add");
        const inp = el("input", "daily-input grow");
        inp.placeholder = "Tracking number (or paste a tracking link or an SMS)";
        inp.maxLength = 400;
        inp.setAttribute("dir", "auto");
        const w2 = el("div", "ship-add");
        const sel = carrierSelect("");
        const label = el("input", "daily-input grow");
        label.placeholder = "Sender or product (optional)";
        label.maxLength = 120; label.setAttribute("dir", "auto");
        const rv = document.createElement("input"); rv.type = "checkbox";
        const rvl = el("label", "ship-chk"); rvl.append(rv, document.createTextNode(" Review sample"));
        rvl.title = "Tag this parcel as a product sent to you for review";
        const pick = el("div", "ship-pick");
        let go = () => {};
        const addBtn = btn("Add", "daily-btn pri", () => go());
        go = confirmable(addBtn, async (force) => {
          const v = inp.value.trim();
          if (!v) return null;
          const r = await act("add", null, { text: v, carrier: sel.value, label: label.value.trim(), review: rv.checked, force }, "Added.");
          if (r && r.ok) { showAdd = false; ctx.rerender(); if (r.note) say(r.note); }
          return r;
        });
        const showPick = () => {
          pick.textContent = "";
          const v = inp.value.trim();
          const open = (data && data.items || []).filter((s) => s.needsNumber && !s.archived);
          if (!v || !open.length) return;
          pick.append(el("div", "ship-muted sm", "Which order is this? These parcels are still waiting for a tracking number:"));
          for (const s of open.slice(0, 12)) {
            const line = el("div", "ship-pickrow");
            let pickGo = () => {};
            const pb = btn("This one", "daily-btn sm", () => pickGo());
            pickGo = confirmable(pb, async (force) => { const r = await act("add-number", s.id, { text: v, carrier: sel.value, force }, "Tracking number attached."); if (r && r.ok) { showAdd = false; ctx.rerender(); } return r; });
            line.append(el("span", "ship-pickt", orderLabel(s) || "Parcel"), pb);
            pick.append(line);
          }
        };
        inp.addEventListener("input", () => { addBtn.textContent = "Add"; showPick(); });
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); if (e.key === "Escape") { showAdd = false; ctx.rerender(); } });
        w.append(inp, sel);
        w2.append(label, rvl, addBtn, btn("Cancel", "daily-btn", () => { showAdd = false; ctx.rerender(); }));
        box.append(w, w2, pick);
        setTimeout(() => inp.focus(), 0);
        return box;
      }

      // Password field -> IPC -> safeStorage in the main process. The key is never shown again, only "key stored".
      function keyBox() {
        const p = data.provider;
        const box = el("div", "daily-card ship-key");
        box.append(el("b", null, "Live tracking key (17TRACK)"));
        box.append(el("div", "daily-muted sm", p.has17 ? "A key is stored on this PC (encrypted by Windows). Parcels are refreshed twice a day, or when you press Refresh now." : "Free account at 17track.net (200 free parcels). Paste the key once; it is stored encrypted on this PC and never leaves the main process."));
        const row2 = el("div", "ship-add");
        const inp = el("input", "daily-input grow");
        inp.type = "password"; inp.autocomplete = "off"; inp.spellcheck = false; inp.maxLength = 200;
        inp.placeholder = p.has17 ? "Paste a new key to replace the stored one" : "Paste the 17TRACK key";
        const save = async () => {
          const v = inp.value;
          if (!v.trim()) return;
          const r = await api.shipmentsSetKey("17track", v);
          inp.value = "";
          if (r && r.ok) { say("Key saved. Refreshing..."); showKey = false; await load(true); ctx.rerender(); }
          else say((r && r.reason) || "Could not save the key.");
        };
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
        row2.append(inp, btn("Save key", "daily-btn pri", save));
        if (p.has17) row2.append(btn("Remove key", "daily-btn", async () => { await api.shipmentsClearKey("17track"); await load(false); ctx.rerender(); say("Key removed."); }));
        if (!p.canEncrypt) box.append(el("div", "daily-banner", "This PC cannot encrypt the key, so it cannot be stored here."));
        box.append(row2);
        const dh = el("div", "ship-add");
        const inp2 = el("input", "daily-input grow");
        inp2.type = "password"; inp2.autocomplete = "off"; inp2.spellcheck = false; inp2.maxLength = 200;
        inp2.placeholder = p.hasDhl ? "DHL key stored - paste to replace (optional)" : "DHL key (optional, free at developer.dhl.com)";
        const save2 = async () => {
          const v = inp2.value; if (!v.trim()) return;
          const r = await api.shipmentsSetKey("dhl", v); inp2.value = "";
          if (r && r.ok) { say("DHL key saved."); await load(false); ctx.rerender(); } else say((r && r.reason) || "Could not save the key.");
        };
        inp2.addEventListener("keydown", (e) => { if (e.key === "Enter") save2(); });
        dh.append(inp2, btn("Save", "daily-btn", save2));
        if (p.hasDhl) dh.append(btn("Remove", "daily-btn", async () => { await api.shipmentsClearKey("dhl"); await load(false); ctx.rerender(); }));
        box.append(dh);
        return box;
      }

      function render() {
        const wrap = el("div", "daily-plain ship-wrap");
        if (!data || Date.now() - loadedAt > STALE_MS) {
          if (!loading) load(false).then(() => { if (ctx.isActive()) ctx.rerender(); });
          if (!data) { wrap.append(el("div", "daily-muted daily-pad", "Loading shipments...")); return wrap; }
        }
        const now = data.now;
        const p = data.provider;
        const bar = el("div", "ship-bar");
        bar.append(btn("+ Add shipment", "daily-btn pri", () => { showAdd = !showAdd; ctx.rerender(); }));
        const rb = btn(loading ? "Refreshing..." : "Refresh now", "daily-btn", async () => {
          rb.disabled = true; rb.textContent = "Refreshing... (up to a minute)";
          const r = await load(true);
          ctx.rerender();
          if (r && r.ok && r.refresh) say(r.refresh.polled ? `Checked ${r.refresh.polled} tracking number${r.refresh.polled === 1 ? "" : "s"}${r.refresh.errors ? `, ${r.refresh.errors} could not be read${r.refresh.firstError ? " (" + r.refresh.firstError + ")" : ""}` : ""}.` : "Mail scanned. No live tracking key, so there was nothing to poll.");
        });
        bar.append(rb, btn(showKey ? "Hide key settings" : "Tracking key", "daily-btn" + (showKey ? " on" : ""), () => { showKey = !showKey; ctx.rerender(); }));
        bar.append(el("span", "daily-sp"));
        const stamp = [];
        if (p.scannedAt) stamp.push("mail scanned " + ago(p.scannedAt, now));
        if (p.live && p.polledAt) stamp.push("tracking checked " + ago(p.polledAt, now));
        if (stamp.length) bar.append(el("span", "daily-muted ship-note", stamp.join(" - ")));
        wrap.append(bar);
        if (!p.live) {
          const b = el("div", "daily-banner info ship-banner");
          b.append(el("b", null, "Add a tracking key to get live status. "), document.createTextNode("Without it, parcels found in your email show the state the email reported, and nothing updates on its own. "));
          b.append(btn("Add key", "daily-btn sm", () => { showKey = true; ctx.rerender(); }));
          wrap.append(b);
        }
        if (p.lastError) wrap.append(el("div", "daily-banner", "Last mail scan problem: " + p.lastError));
        if (showKey) wrap.append(keyBox());
        if (showAdd) wrap.append(addBar());

        const active = data.items.filter((s) => !s.archived);
        const needs = active.filter((s) => ["action_pay", "action_pickup", "exception_stuck"].includes(s.effective));
        const transit = active.filter((s) => !needs.includes(s));
        const arch = data.items.filter((s) => s.archived).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
        needs.sort((a, b) => (a.pickupBy ? Date.parse(a.pickupBy) : Infinity) - (b.pickupBy ? Date.parse(b.pickupBy) : Infinity) || (b.updated || 0) - (a.updated || 0));
        transit.sort((a, b) => (a.eta ? Date.parse(a.eta) : Infinity) - (b.eta ? Date.parse(b.eta) : Infinity) || (b.updated || 0) - (a.updated || 0));

        // legend: what the chips mean (colours always explained)
        const lg = el("div", "daily-legend ship-legend");
        lg.append(el("span", "daily-muted", "Legend"), el("span", "ship-chip bad", "Pay / problem"), el("span", "ship-chip warn", "Pick up"), el("span", "ship-chip ok", "Out / delivered"), el("span", "ship-chip", "On its way"));
        wrap.append(lg);

        if (!data.items.length) {
          wrap.append(ctx.emptyState("No parcels yet", "Parcels from your email appear here by themselves. You can also add one by hand.", "+ Add shipment", () => { showAdd = true; ctx.rerender(); }));
          return wrap;
        }
        if (needs.length) wrap.append(group("Needs action", needs, now, "needs", "pay, pick up or stuck"));
        if (transit.length) wrap.append(group("On the way", transit, now, "transit"));
        if (!needs.length && !transit.length) wrap.append(el("div", "daily-muted daily-pad", "Nothing is on the way right now."));
        const ag = el("section", "daily-card ship-group archive");
        const ah = el("h3", "daily-card-h");
        const tgl = btn((showArchive ? "▾ " : "▸ ") + "Delivered and archived", "ship-toggle", () => { showArchive = !showArchive; ctx.rerender(); });
        ah.append(tgl, el("span", "daily-n", String(arch.length)));
        ag.append(ah);
        if (showArchive) { if (!arch.length) ag.append(el("div", "daily-muted daily-pad", "Nothing archived yet.")); for (const s of arch.slice(0, 100)) ag.append(row(s, now, true)); }
        wrap.append(ag);
        wrap.append(el("div", "daily-muted sm ship-foot", "Tracking data is read from your email (read-only) and, with a key, from 17TRACK. Only the tracking number is sent to the tracking service."));
        return wrap;
      }

      return {
        render,
        // [needs-action count, colour, tooltip] for the tab, once loaded
        tabCount() { return data && data.counts && data.counts.needs ? [data.counts.needs, "warn", `${data.counts.needs} parcel${data.counts.needs === 1 ? "" : "s"} need action`] : null; },
        invalidate() { loadedAt = 0; },
      };
    },
  };
})();
