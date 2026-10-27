// My Daily - Shipments: pull parcel information out of mail (pure, no network, read-only). Input is a plain mail object
// { from, subject, body | snippet, date, messageId } produced by the existing mail code (Betterbird feed, Gmail read-only
// headers/body). Sender domains and subject patterns are from research/tracking_sources.md section 3 and are [K] there:
// validate them against the real mailbox. Nothing here leaves the machine.
"use strict";
const M = require("./shipments-model");

const DAY = 86400000;
const MAX_BODY = 30000;

// sender domain -> { merchant, carrier hint }. Domain matches itself and any subdomain.
const SENDERS = [
  ["fedex.com", { merchant: "FedEx", carrier: "fedex", isCarrier: true }],
  ["ups.com", { merchant: "UPS", carrier: "ups", isCarrier: true }],
  ["dhl.com", { merchant: "DHL", carrier: "dhl", isCarrier: true }],
  ["dhl.de", { merchant: "DHL", carrier: "dhl", isCarrier: true }],
  ["amazon.com", { merchant: "Amazon", carrier: "amazon" }],
  ["amazon.co.uk", { merchant: "Amazon", carrier: "amazon" }],
  ["amazon.de", { merchant: "Amazon", carrier: "amazon" }],
  ["amazon.co.il", { merchant: "Amazon", carrier: "amazon" }],
  ["aliexpress.com", { merchant: "AliExpress", carrier: "cainiao" }],
  ["notice.aliexpress.com", { merchant: "AliExpress", carrier: "cainiao" }],
  ["cainiao.com", { merchant: "AliExpress", carrier: "cainiao", isCarrier: true }],
  ["iherb.com", { merchant: "iHerb", carrier: "" }],
  ["israelpost.co.il", { merchant: "Israel Post", carrier: "israelpost", isCarrier: true }],
  ["postil.com", { merchant: "Israel Post", carrier: "israelpost", isCarrier: true }],
  ["temu.com", { merchant: "Temu", carrier: "" }],
  ["shein.com", { merchant: "Shein", carrier: "" }],
  ["aramex.com", { merchant: "Aramex", carrier: "aramex", isCarrier: true }],
  ["chitadelivery.co.il", { merchant: "Cheetah", carrier: "cheetah", isCarrier: true }],
  ["hfd.co.il", { merchant: "HFD", carrier: "hfd", isCarrier: true }],
  ["gaashwd.com", { merchant: "GAASH", carrier: "gaash", isCarrier: true }],
  ["orian.com", { merchant: "ORIAN", carrier: "orian", isCarrier: true }],
  ["exelot.com", { merchant: "Exelot", carrier: "exelot", isCarrier: true }],
  ["ebay.com", { merchant: "eBay", carrier: "" }],
  ["bhphotovideo.com", { merchant: "B&H", carrier: "" }],
];
const CARRIER_HOSTS = [   // link host -> carrier id
  ["fedex.com", "fedex"], ["ups.com", "ups"], ["dhl.com", "dhl"], ["dhl.de", "dhl"], ["cainiao.com", "cainiao"],
  ["israelpost.co.il", "israelpost"], ["aramex.com", "aramex"], ["yuntrack.com", "yunexpress"],
];
const SUBJECT_RE = /(your (?:order|package|parcel|shipment)|shipped|shipment|tracking|track your|out for delivery|delivered|delivery (?:update|notification|attempt)|on its way|has been delayed|customs|import (?:duty|fee)|pick ?up|collection|getting a shipment|package|parcel|החבילה|המשלוח|משלוח|חבילה|דואר ישראל|נשלח|נמסר)/i;

function domainOf(from) {
  const m = /<([^>]+)>/.exec(String(from || ""));
  const addr = (m ? m[1] : String(from || "")).trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  return at >= 0 ? addr.slice(at + 1).replace(/[^a-z0-9.\-]/g, "") : "";
}
function senderInfo(from) {
  const d = domainOf(from);
  if (!d) return null;
  let best = null;
  for (const [dom, info] of SENDERS) if (d === dom || d.endsWith("." + dom)) { if (!best || dom.length > best.dom.length) best = { dom, info }; }
  return best ? best.info : null;
}

// Cheap pre-filter: worth reading the body of?
function looksLikeShipment(mail) {
  if (!mail) return false;
  const s = senderInfo(mail.from);
  const subj = String(mail.subject || "");
  if (s && s.isCarrier) return true;
  if (s) return SUBJECT_RE.test(subj);
  return /\b(tracking (?:number|no|id)|shipment|your parcel|your package)\b/i.test(subj) && /\d{8,}|\b1Z[0-9A-Z]{16}\b/i.test(subj + " " + String(mail.snippet || ""));
}

// ---------------------------------------------------------------- tracking numbers
const URL_PARAMS = /[?&](?:trknbr|tracknum|tracknumbers?|trackingnumber|tracking[-_]?(?:id|number|no)|mailnolist|barcode|itemcode|shipmentnumber|waybill)=([A-Za-z0-9\-]{8,32})/gi;
const LABELLED = /(?:tracking|track(?:ing)?\s*(?:number|no\.?|id|code|#)|waybill|parcel\s*(?:number|no\.?|id)|consignment|shipment\s*(?:number|no\.?|id|#)|barcode|מספר מעקב|מספר משלוח|מס['׳]? מעקב)\s*(?:number|no\.?|id|#)?\s*(?:is)?\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9 \-]{7,36}[A-Za-z0-9])/gi;
const STRONG = [/\b(1Z[0-9A-Z]{16})\b/g, /\b([A-Z]{2}\d{9}[A-Z]{2})\b/g, /\b(LP\d{10,20}[A-Z]{0,2})\b/g, /\b(TB[ACM]\d{12})\b/g, /\b((?:JJD|JVGL)[0-9A-Z]{10,24})\b/g, /\b(YT\d{16})\b/g];
const AMAZON_ORDER = /\b(\d{3}-\d{7}-\d{7})\b/;

// 2026-10-27: values that follow an order label ("Order number: 1123450589717403", "Order ID", "הזמנה") are references, never
// tracking numbers. They are collected first and pushNum refuses them, so no later rule can pick them up by accident.
const ORDER_LABEL = /(?:order\s*(?:number|no\.?|id|#|ref(?:erence)?)|reference\s*(?:number|no\.?)|הזמנה(?: מספר)?|מספר הזמנה)\s*[:#\-]?\s*(?:is\s*)?([A-Z0-9][A-Z0-9\- ]{5,30}[A-Z0-9])/gi;
function orderRefs(whole) {
  const set = new Set();
  let m;
  ORDER_LABEL.lastIndex = 0;
  while ((m = ORDER_LABEL.exec(whole))) {
    const tok = m[1].trim().split(/\s+/);
    set.add(M.normNumber(tok[0]));
    if (/^\d{1,4}$/.test(tok[0]) && tok.length > 1) set.add(M.normNumber(tok.slice(0, 4).join("")));
  }
  for (const a of whole.matchAll(/\b(\d{3}-\d{7}-\d{7})\b/g)) set.add(M.normNumber(a[1]));
  return set;
}
function pushNum(out, raw, why, hint, refs) {
  const no = M.normNumber(raw);
  if (!no || no.length < 8) return;
  if (refs && refs.has(no)) return;                                                // labelled as an order number in this mail
  // an order id by format (Amazon 3-7-7 always; 16/17 plain digits only when the number is NOT explicitly a tracking value: a link
  // parameter, a tracking label or a carrier format is explicit, so a genuine 16-digit Evri number in a carrier mail survives)
  if (/^\d{3}-\d{7}-\d{7}$/.test(String(raw).trim())) return;
  if ((why === "subject" || why === "bare") && M.looksLikeOrderNumber(raw)) return;
  if (/^(19|20)\d{6,}$/.test(no) && no.length <= 8) return;                        // a date
  if (out.some((x) => x.no === no)) return;
  const d = M.detectCarrier(no, hint);
  out.push({ no, carrier: d.carrier, confidence: d.confidence, why });
}

// opts.fromMail + opts.isCarrier: in a mail from a shop (not a carrier) an unlabelled bare digit run is never a tracking number.
function extractNumbers(text, subject, hint, opts) {
  const out = [];
  const whole = subject + "\n" + text;
  const refs = orderRefs(whole);
  const o = opts || {};
  let m;
  URL_PARAMS.lastIndex = 0;
  while ((m = URL_PARAMS.exec(whole))) pushNum(out, m[1], "link", hint, refs);
  for (const re of STRONG) { re.lastIndex = 0; while ((m = re.exec(whole.toUpperCase()))) pushNum(out, m[1], "format", hint, refs); }
  LABELLED.lastIndex = 0;
  while ((m = LABELLED.exec(whole))) {
    // a labelled value is a number only when it has digits and (after trimming trailing words) looks like one
    const tok = m[1].trim().split(/\s+/);
    let cand = tok[0];
    if (/^\d{1,4}$/.test(cand) && tok.length > 1) { cand = tok.slice(0, 4).join(""); }   // "8782 4785 3307"
    const n = M.normNumber(cand);
    if (/\d/.test(n) && n.length >= 8 && n.length <= 30) pushNum(out, cand, "label", hint, refs);
  }
  // FedEx / DHL / UPS subjects such as "You're getting a shipment 878247853307": a bare long digit run next to a shipment word
  // ("order" was removed from this list on 2026-10-27: "Your order 1123450589717403 has shipped" carries the ORDER number)
  const subj = /(?:shipment|package|parcel|tracking|delivery)\D{0,12}(\d{10,22})\b/i.exec(subject);
  if (subj && !/\border\b[^\d]{0,12}$/i.test(subject.slice(0, subj.index + subj[0].length - subj[1].length))) pushNum(out, subj[1], "subject", hint, refs);
  // a mail from a carrier that has a bare digit number in the body but no label
  if (!out.length && hint && ["fedex", "dhl"].includes(hint) && !(o.fromMail && !o.isCarrier)) {
    const bare = new RegExp("\\b(\\d{" + (hint === "dhl" ? "10,11" : "12,15") + "})\\b", "g");
    const stripped = whole.replace(/\b(?:\+?\d[\d\-() ]{8,}\d)\b(?=\s*(?:phone|tel|fax))/gi, "");
    while ((m = bare.exec(stripped))) { if (!/^(19|20)\d{2}/.test(m[1])) { pushNum(out, m[1], "bare", hint, refs); if (out.length) break; } }
  }
  return out;
}

// ---------------------------------------------------------------- dates and fields
const MONTHS = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };
// Parse the first date in `s`. Numeric dates are DAY/MONTH (Israel/Europe) unless the first part is > 12 or it is yyyy-mm-dd.
// `ref` (ms) supplies a missing year: the next occurrence not more than ~60 days in the past.
function parseDateText(s, ref) {
  const t = String(s || "");
  const refD = new Date(ref || Date.now());
  const fix = (y, mo, d) => {
    let year = y;
    if (year == null) {
      year = refD.getFullYear();
      const cand = Date.UTC(year, mo, d, 12);
      if (cand < refD.getTime() - 60 * DAY) year++;
    } else if (year < 100) year += 2000;
    const dt = new Date(Date.UTC(year, mo, d, 12));
    return dt.getUTCMonth() === mo && dt.getUTCDate() === d ? dt.toISOString() : null;
  };
  let m = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(t);
  if (m) return fix(+m[1], +m[2] - 1, +m[3]);
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?(?:\s+(20\d{2}))?\b/.exec(t);
  if (m && MONTHS[m[2].toLowerCase()] != null) return fix(m[3] ? +m[3] : null, MONTHS[m[2].toLowerCase()], +m[1]);
  m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/.exec(t);
  if (m && MONTHS[m[1].toLowerCase()] != null) return fix(m[3] ? +m[3] : null, MONTHS[m[1].toLowerCase()], +m[2]);
  m = /\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/.exec(t);
  if (m) {
    let a = +m[1], b = +m[2];
    let day = a, mon = b;
    if (a <= 12 && b > 12) { day = b; mon = a; }     // clearly month/day
    return fix(m[3] ? +m[3] : null, mon - 1, day);
  }
  return null;
}

function firstMatch(re, text) { const m = re.exec(text); return m ? m[1] : ""; }

function extractEta(text, ref) {
  const re = /(?:estimated|expected|scheduled|planned)?\s*(?:delivery|deliver(?:y)? date|arriv(?:al|es|ing)|delivered by|תאריך (?:מסירה|אספקה)(?: משוער)?)(?:\s+(?:date|time|on|by|between))?\s*[:\-]?\s*([^\n.]{4,60})/gi;
  let m;
  while ((m = re.exec(text))) {
    const eta = parseDateText(m[1], ref);
    if (eta) return { eta, etaText: M.clean(m[1], 40) };
  }
  return { eta: null, etaText: "" };
}
function extractPickupBy(text, ref) {
  const m = /(?:pick ?-?up|collect(?:ion)?|retrieve)[^\n.]{0,70}?\b(?:by|until|before|within|deadline)\b\s*[:\-]?\s*([^\n.]{4,40})/i.exec(text);
  return m ? parseDateText(m[1], ref) : null;
}
function extractAmount(text) {
  const m = /(?:customs|duty|duties|VAT|import|fee|payment|amount due|to pay|לתשלום|מכס)[^\n.]{0,60}?((?:NIS|ILS|₪|USD|US\$|\$|EUR|€|GBP|£)\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:NIS|ILS|₪|USD|EUR|GBP|ש"ח))/i.exec(text);
  return m ? M.clean(m[1], 30) : "";
}
function extractFrom(text, merchant, isCarrier) {
  let m = /^\s*(?:ship(?:ped)? from|from|sender|shipper)\s*[:\-]\s*(.{3,80})$/im.exec(text);
  if (m) return M.clean(m[1].replace(/\s{2,}.*$/, ""), 80);
  m = /([A-Z][^\n,.]{2,40}(?:,\s*[A-Z][A-Za-z .]{2,30}){0,2})\s+(?:is sending|has sent|sent|is shipping|has shipped)\s+you/.exec(text);
  if (m) return M.clean(m[1], 80);
  m = /(?:your (?:order|package|shipment|parcel)) from ([A-Z][^\n,.]{2,40})/.exec(text);
  if (m) return M.clean(m[1], 80);
  return "";
}
function extractTo(text) {
  const m = /(?:deliver(?:ing|y)? to|ship(?:ping|ped)? to|\bto)\s*[:\-]\s*([^\n]{3,80})/i.exec(text);
  if (!m) return "";
  const parts = m[1].split(",").map((p) => p.trim()).filter(Boolean);
  // city only: drop anything with digits (street, postcode) and keep the first plain-text part (the city comes before the country)
  const city = parts.filter((p) => !/\d/.test(p) && /^[A-Za-z֐-׿ .'\-]{2,30}$/.test(p));
  return city.length ? city[0] : "";
}
function extractOrderId(text, subject) {
  const a = AMAZON_ORDER.exec(subject + "\n" + text);
  if (a) return a[1];
  const m = /(?:order\s*(?:number|no\.?|id|#)|הזמנה(?: מספר)?)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-]{5,25})/i.exec(text);
  return m && /\d/.test(m[1]) ? m[1] : "";
}
function hostCarrier(text) {
  const re = /https?:\/\/([a-z0-9.\-]+)/gi;
  let m;
  while ((m = re.exec(text))) {
    const h = m[1].toLowerCase();
    for (const [dom, c] of CARRIER_HOSTS) if (h === dom || h.endsWith("." + dom)) return c;
  }
  return "";
}
function bodyCarrier(text) {
  if (/\bFedEx\b/.test(text)) return "fedex";
  if (/\bUPS\b/.test(text)) return "ups";
  if (/\bDHL\b/.test(text)) return "dhl";
  if (/Israel Post|דואר ישראל/.test(text)) return "israelpost";
  if (/Cainiao/i.test(text)) return "cainiao";
  return "";
}


// ---------------------------------------------------------------- what is in the parcel (2026-10-27, best effort)
// B&H shipped mails list "<name> / B&H #SKU / QTY: n" per item; Amazon says "Shipped 2 items: Headphone Accessories, Adhesives"
// (categories, not names) or, for a single item, the product name in quotes. -> { items:[{name,qty}], count } (count 0 = unknown).
function extractItems(text, subject) {
  const lines = String(text || "").split(/\n+/).map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
  const items = [];
  for (let i = 1; i < lines.length && items.length < 12; i++) {
    if (!/^B&H #[A-Z0-9-]+/i.test(lines[i])) continue;
    const name = lines[i - 1];
    let qty = 1;
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) { const q = /^QTY:?\s*(\d{1,3})\b/i.exec(lines[j]); if (q) { qty = +q[1]; break; } }
    if (name.length >= 3 && name.length <= 200 && !/^(?:QTY|B&H #)/i.test(name)) items.push({ name: M.clean(name, 100), qty });
  }
  if (items.length) return { items, count: items.reduce((a, x) => a + x.qty, 0) };
  const whole = String(subject || "") + "\n" + lines.join("\n");
  let m = /\b(?:ordered|shipped|delivered)\s*:?\s*(\d{1,3})\s+items?\s*:?\s*([^\n]{0,200})/i.exec(whole);
  if (m) {
    const names = m[2].split(/,\s*(?:and\s+)?|\s+and\s+/i).map((x) => x.replace(/[.\s]+$/, "").trim()).filter((x) => x && !/^more$/i.test(x) && x.length <= 60 && !/^https?:/i.test(x)).slice(0, 8);
    return { items: names.map((n) => ({ name: M.clean(n, 100), qty: 1 })), count: +m[1] };
  }
  m = /\b(?:ordered|shipped|delivered)\s*:\s*["“']([^"”\n]{3,120})["”']/i.exec(whole);
  if (m) return { items: [{ name: M.clean(m[1].replace(/…|\.\.\.$/g, ""), 100), qty: 1 }], count: 1 };
  return { items: [], count: 0 };
}
// Pair picture URLs with items only when it is unambiguous: same number of pictures as items, or one extra (a logo first).
function pairImages(items, urls) {
  const good = (Array.isArray(urls) ? urls : []).filter((u) => /^https:\/\//i.test(u) && u.length <= 400 && !/(logo|banner|spacer|pixel|track|facebook|twitter|instagram|youtube|icon|badge|footer)/i.test(u));
  const pick = good.length === items.length ? good : (good.length === items.length + 1 ? good.slice(1) : []);
  return items.map((it, i) => (pick[i] ? Object.assign({}, it, { src: pick[i] }) : it));
}

// ---------------------------------------------------------------- main entry
// -> array of candidates for M.mergeCandidate (usually 0 or 1; several numbers in one mail are the SAME parcel unless the
// subject says otherwise), each { numbers:[{no,carrier}], carrier, orderId, merchant, from, to, eta, state, pickupBy,
// amountDue, title, msgId, at, source:"email" }.
function extractShipments(mail, now) {
  if (!mail || typeof mail !== "object") return [];
  const subject = M.clean(mail.subject, 200);
  let body = String(mail.body != null ? mail.body : mail.snippet || "").slice(0, MAX_BODY);
  body = body.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<\/(?:p|div|tr|td|li|h\d|table)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const sInfo = senderInfo(mail.from);
  if (!looksLikeShipment(mail) && !(sInfo)) return [];
  const at = Number.isFinite(Date.parse(mail.date)) ? Date.parse(mail.date) : (now || Date.now());
  const text = body.replace(/[ \t]+/g, " ");
  const hint = (sInfo && sInfo.carrier) || hostCarrier(body) || bodyCarrier(subject + " " + text.slice(0, 1500)) || "";
  let nums = extractNumbers(text, subject, hint, { fromMail: true, isCarrier: !!(sInfo && sInfo.isCarrier) });
  // 2026-10-27: Amazon's mails carry shipment/link ids that are not carrier numbers (2367361581 matched an old Milan parcel). A number
  // from an Amazon shop mail counts only when its format names a real carrier; otherwise the owner supplies it (typed or screenshot).
  if (sInfo && sInfo.merchant === "Amazon" && !sInfo.isCarrier) nums = nums.filter((n) => n.carrier && n.carrier !== "other" && !(M.CARRIER_BY_ID[n.carrier] && M.CARRIER_BY_ID[n.carrier].weak));
  const orderId = extractOrderId(text, subject);
  const state = M.stateFromText(subject) || M.stateFromText(text.slice(0, 1200)) || (nums.length ? "shipped" : null);
  if (!nums.length && !(orderId && sInfo && state)) return [];
  // a mail that only says "order confirmed" without a number is an "ordered" placeholder keyed by order id
  const { eta, etaText } = extractEta(subject + "\n" + text, at);
  const merchant = sInfo ? sInfo.merchant : "";
  const from = extractFrom(text, merchant, sInfo && sInfo.isCarrier);
  const got = extractItems(body, subject);
  // pictures are fetched only for mail from a known shop (not a carrier, not an unknown sender) AND whose sender passed DKIM or SPF (Gmail's Authentication-Results)
  const cand = {
    items: (sInfo && !sInfo.isCarrier && mail.verified === true) ? pairImages(got.items, mail.images) : got.items, itemCount: got.count,
    numbers: nums.map((n) => ({ no: n.no, carrier: n.carrier })),
    carrier: nums.length ? nums[nums.length - 1].carrier : (hint || "other"),
    orderId, merchant, from, to: extractTo(text), eta, etaText,
    state: state || "ordered",
    pickupBy: extractPickupBy(text, at),
    amountDue: (state === "action_pay" || /duty|customs|VAT|payment/i.test(subject)) ? extractAmount(text + " " + subject) : "",
    title: from && sInfo && sInfo.isCarrier ? "From " + from.split(",")[0] : "",
    msgId: M.clean(mail.messageId, 200) || "", at, source: "email",
    confidence: nums.length ? nums[0].confidence : "none",
  };
  if (sInfo && sInfo.isCarrier && from) cand.merchant = from.split(",")[0].trim();   // a parcel notice from FedEx: the shipper is the merchant
  return [cand];
}

// "Add manually" box: a bare number, a tracking link, a pasted SMS, or a dictated phrase such as "tracking 878247853307 FedEx
// from Cartoni". -> { ok, numbers:[{no,carrier}], carrier, title } or { ok:false, reason }.
const WORD_CARRIER = { fedex: "fedex", ups: "ups", dhl: "dhl", cainiao: "cainiao", aliexpress: "cainiao", aramex: "aramex", cheetah: "cheetah", hfd: "hfd", gaash: "gaash", orian: "orian", exelot: "exelot", amazon: "amazon" };
function parseAddInput(raw) {
  const text = String(raw == null ? "" : raw).slice(0, 2000).trim();
  if (!text) return { ok: false, reason: "Paste a tracking number or a tracking link." };
  let hint = hostCarrier(text);
  let nums = extractNumbers(text, "", hint);
  const words = text.split(/[\s,;]+/).filter(Boolean);
  for (const w of words) { const c = WORD_CARRIER[w.toLowerCase().replace(/[^a-z]/g, "")]; if (c && !hint) hint = c; }
  if (!nums.length) {
    const toks = words.map((w) => M.normNumber(w)).filter((n) => M.plausibleNumber(n));
    nums = toks.filter((n, i) => toks.indexOf(n) === i).slice(0, 4).map((n) => { const d = M.detectCarrier(n, hint); return { no: n, carrier: d.carrier, confidence: d.confidence }; });
  }
  if (!nums.length) return { ok: false, reason: "No tracking number found in that text." };
  const used = new Set(nums.map((n) => n.no));
  const title = /https?:\/\//i.test(text) ? "" : words.filter((w) => !used.has(M.normNumber(w)) && !WORD_CARRIER[w.toLowerCase().replace(/[^a-z]/g, "")] && !/^(tracking|number|no|id|from|parcel|package|shipment)$/i.test(w)).join(" ");
  if (hint && nums.length) nums = nums.map((n) => (n.confidence === "high" ? n : { no: n.no, carrier: M.detectCarrier(n.no, hint).carrier, confidence: "low" }));
  return { ok: true, numbers: nums.map((n) => ({ no: n.no, carrier: n.carrier })), carrier: nums[nums.length - 1].carrier, title: M.clean(title, 80) };
}

module.exports = { extractItems, pairImages, looksLikeShipment, extractShipments, extractNumbers, parseDateText, parseAddInput, senderInfo, domainOf, SENDERS };
