// My Daily - Shipments: read a screenshot of an order / "Track package" page (2026-10-27).
// A vision model reads the picture and returns JSON { orderId, merchant, parcels:[{carrier, trackingNumber, items:[...], eta}] };
// applyReading() then puts the numbers and item names on the right cards. No electron import: the model call is injected.
// Tracking numbers alone can never say which products are in a parcel; the screenshot is the only source of that.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const M = require("./shipments-model");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Every daily-* IPC call is refused above 262144 JSON characters (main-daily.js MAX_ARG_CHARS). The renderer shrinks the picture until
// its data URL is at most this many characters, which leaves room for the other fields. Keep in step with renderer/daily-shipments.js.
const MAX_DATAURL_CHARS = 230000;
const CARRIER_IDS = M.CARRIERS.map((c) => c.id).join(", ");

const PROMPT = (file, orderHint) =>
  "Read the image file at " + file + " with the Read tool. It is a screenshot of an online shop's order or package-tracking page (Amazon, AliExpress, iHerb, ...).\n" +
  "Reply with ONE JSON object and nothing else, no markdown:\n" +
  '{"orderId":"","merchant":"","parcels":[{"carrier":"","trackingNumber":"","items":[],"eta":""}]}\n' +
  "Rules: one entry in parcels per separate package/shipment shown. trackingNumber is the CARRIER's tracking id exactly as printed " +
  "(letters and digits, no spaces); leave it empty if the page does not show one. NEVER put an order number (like 113-6007992-3663405 or a 16-digit AliExpress order id) in trackingNumber. " +
  "carrier is one of: " + CARRIER_IDS + " (use \"other\" if unsure). items are the short product names in that package (max 6, each under 60 characters). " +
  "eta is the delivery date text shown, or empty. If a field is not visible, leave it empty. Do not guess." +
  (orderHint ? "\nThe owner says this is for order " + orderHint + "." : "");

// Pull the JSON object out of the model's reply (it may wrap it in prose or a code fence) and clean every field.
function parseReading(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return { ok: false, reason: "The picture could not be read (no answer from the reader)." };
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { return { ok: false, reason: "The picture could not be read (unreadable answer)." }; }
  const parcels = (Array.isArray(j.parcels) ? j.parcels : []).slice(0, 8).map((p) => {
    p = p && typeof p === "object" ? p : {};
    return {
      carrier: M.CARRIER_BY_ID[String(p.carrier || "").toLowerCase()] ? String(p.carrier).toLowerCase() : "",
      no: M.normNumber(p.trackingNumber),
      items: (Array.isArray(p.items) ? p.items : []).slice(0, 6).map((x) => M.clean(x, 60)).filter(Boolean),
      eta: M.clean(p.eta, 40),
    };
  });
  return { ok: true, orderId: M.clean(j.orderId, 40), merchant: M.clean(j.merchant, 40), parcels };
}

// Put a reading on the cards. Returns { ok, summary:[...], created, changed } and never throws.
// Rules: a number already on a card only gets items/ETA; a new number goes to a card of the same order that still needs one,
// else to a new sibling card; a parcel without a number is only used to name the single numberless card of that order.
function applyReading(items, reading, t, hintOrderId) {
  const out = { ok: true, summary: [], created: 0, changed: 0 };
  const orderId = hintOrderId || reading.orderId || "";
  const same = (x) => orderId && x.orderId === orderId && !x.archived;
  for (const p of reading.parcels) {
    const title = p.items.join(", ").slice(0, 160);
    const withNo = p.no ? items.find((x) => x.numbers.some((n) => n.no === p.no)) : null;
    if (p.no && M.looksLikeOrderNumber(p.no)) { out.summary.push("Skipped " + p.no + ": that is an order number, not a tracking number."); continue; }
    if (p.no && !M.plausibleNumber(p.no)) { out.summary.push("Skipped " + p.no + ": does not look like a tracking number."); continue; }
    if (withNo) {
      if (title && !withNo.title) withNo.title = title;
      withNo.updated = t; out.changed++; out.summary.push(p.no + ": already tracked" + (title ? ", items noted" : ""));
      continue;
    }
    const sameOrder = items.filter(same);
    if (!p.no) {
      const bare = sameOrder.filter((x) => M.needsNumber(x));
      if (title && bare.length === 1 && reading.parcels.length === 1) { bare[0].title = title; bare[0].updated = t; out.changed++; out.summary.push("Items noted; the page shows no tracking number yet."); }
      else out.summary.push("A parcel without a tracking number was skipped" + (title ? " (" + title + ")" : "") + ".");
      continue;
    }
    const d = M.detectCarrier(p.no, p.carrier);
    const carrier = p.carrier && p.carrier !== "other" ? p.carrier : d.carrier;
    const num = { no: p.no, carrier, carrierSet: !!(p.carrier && p.carrier !== "other"), at: t };
    let card = sameOrder.find((x) => M.needsNumber(x));
    if (card) {
      card.numbers.push(num); card.carrier = carrier;
      if (card.state === "ordered") M.setState(card, "shipped", t, "screenshot", t);
      out.changed++;
    } else {
      card = M.makeShipment({ orderId, merchant: reading.merchant || (sameOrder[0] && sameOrder[0].merchant) || "", carrier, state: "shipped", source: "manual", split: !!sameOrder.length, numbers: [num], eta: sameOrder[0] && sameOrder[0].eta, at: t }, t);
      if (sameOrder.length) for (const x of sameOrder) { x.split = true; }
      items.push(card); out.created++;
    }
    if (title) card.title = title;
    if (p.eta && !card.etaText) card.etaText = p.eta;
    card.updated = t; card.polledAt = null;
    out.summary.push(p.no + " (" + M.carrierName(carrier) + ")" + (title ? ": " + title : ""));
  }
  if (!reading.parcels.length) { out.ok = false; out.reason = "No parcels were found in that picture."; }
  else if (!out.created && !out.changed && !out.summary.length) { out.ok = false; out.reason = "Nothing in that picture could be used."; }
  return out;
}

// dataUrl -> temp png -> model -> parseReading. callModel({ prompt, cwd, addDir }) -> text. Test mode reads a stub text instead.
function createReader({ callModel, tmpDir, testMode, stubFile }) {
  async function read(dataUrl, orderHint) {
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
    if (!m) return { ok: false, reason: "That is not a picture I can read (paste a PNG or JPG screenshot)." };
    const buf = Buffer.from(m[2], "base64");
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: "The picture is empty or larger than 8 MB." };
    if (testMode) {
      let stub = "";
      try { stub = fs.readFileSync(stubFile, "utf8"); } catch (e) { /* none */ }
      return parseReading(stub);
    }
    const dir = tmpDir || os.tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "ship-shot-" + process.pid + "-" + Date.now() + "." + (m[1] === "jpeg" ? "jpg" : m[1]));
    fs.writeFileSync(file, buf);
    try {
      const text = await callModel({ prompt: PROMPT(file, orderHint), dir });
      return parseReading(text);
    } catch (e) {
      return { ok: false, reason: "The reader failed: " + M.clean(e && e.message, 100) };
    } finally { try { fs.unlinkSync(file); } catch (e) { /* gone */ } }
  }
  return { read };
}

module.exports = { parseReading, applyReading, createReader, PROMPT, MAX_DATAURL_CHARS };
