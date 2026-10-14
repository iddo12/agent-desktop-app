// MY FINANCE synthetic data (v1.90.0 skeleton, main process). Builds an INVENTED ledger so the screens can be built and tested before
// any real bank file exists. Every merchant, client and account label carries "demo"/"דמו"; the ledger itself says synthetic:true and the
// view shows a "Demo data - not real" banner for as long as it does. Deterministic: the same `now` and seed give the same ledger.
// Shape = the ledger format the real importer will write later (see FINANCE_SKELETON_REPORT.md, "Ledger format").
"use strict";

const ACCOUNTS = [
  { id: "leumi", name: "Leumi - demo", kind: "bank", opening: 18000 },
  { id: "discount", name: "Discount - demo", kind: "bank", opening: 42000 },
  { id: "card-a", name: "Card A - demo", kind: "card", opening: 0 },
  { id: "card-b", name: "Card B - demo", kind: "card", opening: 0 },
  { id: "cash", name: "Cash - demo", kind: "cash", opening: 600 },
];

// About 20 categories from the build report (section 5.2), Hebrew + English, an icon, and a group.
const CATEGORIES = [
  { id: "gear", en: "Gear", he: "ציוד צילום", icon: "📷", group: "business" },
  { id: "software", en: "Software & subscriptions", he: "תוכנה ומנויים", icon: "💻", group: "business" },
  { id: "travel", en: "Travel & trade shows", he: "נסיעות ותערוכות", icon: "✈️", group: "business" },
  { id: "car", en: "Car & fuel", he: "רכב ודלק", icon: "⛽", group: "business" },
  { id: "phone", en: "Phone & internet", he: "טלפון ואינטרנט", icon: "📱", group: "business" },
  { id: "hosting", en: "Hosting & domains", he: "אחסון ודומיינים", icon: "🌐", group: "business" },
  { id: "office", en: "Office & studio", he: "משרד וסטודיו", icon: "🏢", group: "business" },
  { id: "marketing", en: "Marketing & ads", he: "שיווק ופרסום", icon: "📣", group: "business" },
  { id: "fees", en: "Fees (bank, card, FX)", he: "עמלות", icon: "🏦", group: "business" },
  { id: "taxes", en: "Taxes & National Insurance", he: "מסים וביטוח לאומי", icon: "🏛️", group: "business" },
  { id: "food", en: "Food", he: "מזון", icon: "🛒", group: "personal" },
  { id: "home", en: "Home", he: "בית", icon: "🏠", group: "personal" },
  { id: "health", en: "Health", he: "בריאות", icon: "💊", group: "personal" },
  { id: "family", en: "Family", he: "משפחה", icon: "👪", group: "personal" },
  { id: "inc-sponsors", en: "Income: sponsors", he: "הכנסה: ספונסרים", icon: "🤝", group: "income" },
  { id: "inc-video", en: "Income: video ads", he: "הכנסה: פרסום בווידאו", icon: "▶️", group: "income" },
  { id: "inc-clients", en: "Income: clients", he: "הכנסה: לקוחות", icon: "💼", group: "income" },
  { id: "transfer", en: "Transfers (not counted)", he: "העברות (לא נספר)", icon: "🔁", group: "transfer" },
  { id: "other", en: "Uncategorised", he: "לא מסווג", icon: "❔", group: "personal" },
];

// mulberry32: small seeded PRNG, so tests can pin the output
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pad = (n) => String(n).padStart(2, "0");
const r2 = (n) => Math.round(n * 100) / 100;

function makeLedger(opts) {
  const o = opts || {};
  const now = o.now instanceof Date ? o.now : new Date();
  const rnd = prng(o.seed == null ? 20261008 : o.seed);
  const months = Math.max(2, Math.min(12, o.months || 6));
  const between = (lo, hi) => r2(lo + rnd() * (hi - lo));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const tx = [], receipts = [];
  let n = 0;
  const today = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  function add(date, amount, account, merchant, category, extra) {
    if (date > today) return null;
    const t = Object.assign({ id: "t" + (++n), date, amount: r2(amount), account, merchant, raw: merchant + " " + (1000 + Math.floor(rnd() * 9000)), category, bp: "personal", transfer: false, receipt: null }, extra || {});
    if (category === "transfer") t.transfer = true;
    tx.push(t);
    return t;
  }
  const biz = { bp: "business" };
  const first = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  const cardTotals = {};   // "card-a|2026-09" -> total spent that month (negative)
  for (let m = 0; m < months; m++) {
    const d0 = new Date(first.getFullYear(), first.getMonth() + m, 1);
    const ym = d0.getFullYear() + "-" + pad(d0.getMonth() + 1);
    const day = (d) => ym + "-" + pad(Math.min(d, 28));
    const card = (acc, d, amt, merchant, cat, extra) => { const t = add(day(d), amt, acc, merchant, cat, extra); if (t) cardTotals[acc + "|" + ym] = (cardTotals[acc + "|" + ym] || 0) + t.amount; return t; };
    // income (business account)
    add(day(5), between(11500, 12500), "discount", "Sponsor North (demo)", "inc-sponsors", biz);
    add(day(10), 8500, "discount", "Sponsor South (demo)", "inc-sponsors", biz);
    add(day(20), between(1900, 3600), "discount", "VideoAds payout (demo)", "inc-video", biz);
    if (rnd() < 0.8) add(day(8 + Math.floor(rnd() * 15)), between(3000, 11800), "discount", pick(["Client 7 (demo)", "Client 12 (demo)", "לקוח 3 (דמו)"]), "inc-clients", biz);
    // recurring subscriptions on card A (two overlapping stock-music services and a price rise in month 4, for the advisor later)
    card("card-a", 3, -89, "CloudPix Pro (demo)", "software", biz);
    card("card-a", 4, -245, "EditSuite Monthly (demo)", "software", biz);
    card("card-a", 6, -59, "StockTunes (demo)", "software", biz);
    card("card-a", 7, m >= 3 ? -75 : -65, "StockBeats (demo)", "software", biz);
    card("card-a", 12, -140, "HostBox Demo", "hosting", biz);
    // fuel on card A
    for (let i = 0; i < 3 + Math.floor(rnd() * 2); i++) card("card-a", 2 + Math.floor(rnd() * 26), -between(250, 420), pick(["תחנת דלק הדמו", "Fuel Stop Demo"]), "car", biz);
    // food and family on card B
    for (let i = 0; i < 8 + Math.floor(rnd() * 5); i++) card("card-b", 1 + Math.floor(rnd() * 28), -between(40, 650), pick(["סופר השכונה (דמו)", "מאפיית הבוקר (דמו)", "Green Grocer Demo", "שוק הדמו"]), "food");
    if (rnd() < 0.7) card("card-b", 14, -between(120, 480), "בית מרקחת (דמו)", "health");
    card("card-b", 1, -380, "חוג ילדים (דמו)", "family");
    // bank direct debits (Leumi = household, Discount = business)
    add(day(9), -129, "leumi", "סלולר הדמו", "phone", biz);
    add(day(9), -109, "leumi", "FiberNet Demo", "phone", biz);
    add(day(1), -250, "leumi", "ועד הבית (דמו)", "home");
    add(day(15), -680, "leumi", "ארנונה (דמו)", "home");
    if (m % 2 === 1) add(day(22), -between(600, 900), "leumi", "חשמל לבית (דמו)", "home");
    add(day(28), -32, "leumi", "עמלת ניהול חשבון (דמו)", "fees", biz);
    add(day(28), -32, "discount", "עמלת ניהול חשבון (דמו)", "fees", biz);
    add(day(15), -3200, "discount", "מקדמות מס (דמו)", "taxes", biz);
    add(day(15), -1450, "discount", "ביטוח לאומי (דמו)", "taxes", biz);
    // one-off business spend, so months differ
    if (m === 1) card("card-a", 3, -7400, "עדשות וחצובות בע\"מ (דמו)", "gear", biz);
    if (m === months - 2) card("card-a", 18, -1250, "Pixel Gear Shop (demo)", "gear", biz);
    if (m === 2) { card("card-a", 11, -4800, "Demo Air", "travel", biz); card("card-a", 12, -2600, "מלון התערוכה (דמו)", "travel", biz); card("card-a", 13, -between(20, 60), "FX fee (demo)", "fees", biz); }
    if (m === 3) card("card-a", 16, -1500, "AdReach Demo", "marketing", biz);
    if (m % 3 === 0) card("card-a", 19, -between(150, 400), "דפוס ומשרד (דמו)", "office", biz);
    // owner draw: business -> household (a transfer, not income or spend)
    add(day(16), -12000, "discount", "העברה לחשבון הבית (דמו)", "transfer");
    add(day(16), 12000, "leumi", "העברה מחשבון העסק (דמו)", "transfer");
    // cash: ATM withdrawal (transfer) and cash spend
    add(day(11), -400, "leumi", "משיכת מזומן (דמו)", "transfer");
    add(day(11), 400, "cash", "משיכת מזומן (דמו)", "transfer");
    add(day(12), -between(60, 180), "cash", "שוק הדמו", "food");
  }
  // card settlements: on the 2nd of the next month the bank pays the card's month in one lump. That lump is a TRANSFER (not an expense), so
  // the itemised card lines are counted once. The current month is still open, so its card spending shows as owed on the card.
  for (const key of Object.keys(cardTotals)) {
    const [acc, ym] = key.split("|");
    const [y, mo] = ym.split("-").map(Number);
    const next = new Date(y, mo, 2), date = next.getFullYear() + "-" + pad(next.getMonth() + 1) + "-02";
    const lump = -cardTotals[key];
    if (add(date, -lump, "leumi", (acc === "card-a" ? "Card A" : "Card B") + " settlement (demo)", "transfer")) add(date, lump, acc, "Payment received (demo)", "transfer");
  }
  tx.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // receipts: most business expenses have one (matched), some arrived but nobody looked yet (new), a few have no bank line yet
  let rn = 0;
  for (const t of tx) {
    if (t.bp !== "business" || t.amount >= 0 || t.transfer || t.category === "taxes" || t.category === "fees") continue;
    const roll = rnd();
    if (roll < 0.72) { const id = "r" + (++rn); receipts.push({ id, date: t.date, vendor: t.merchant, total: -t.amount, status: "matched", tx: t.id }); t.receipt = id; }
    else if (roll < 0.86) receipts.push({ id: "r" + (++rn), date: t.date, vendor: t.merchant, total: -t.amount, status: "new", tx: null, suggestTx: t.id });
  }
  for (const v of ["Studio Props Demo", "קפה פגישות (דמו)", "Cable Shop Demo"]) {
    const d = new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - 1 - Math.floor(rnd() * 10)));
    receipts.push({ id: "r" + (++rn), date: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()), vendor: v, total: between(35, 480), status: "no-line", tx: null });
  }
  const rules = [
    { contains: "Sponsor", category: "inc-sponsors", bp: "business", learned: false },
    { contains: "CloudPix", category: "software", bp: "business", learned: false },
    { contains: "StockTunes", category: "software", bp: "business", learned: true },
    { contains: "StockBeats", category: "software", bp: "business", learned: true },
    { contains: "דלק", category: "car", bp: "business", learned: false },
    { contains: "סופר", category: "food", bp: "personal", learned: false },
    { contains: "settlement", category: "transfer", bp: "personal", learned: false },
    { contains: "ארנונה", category: "home", bp: "personal", learned: true },
  ];
  return {
    schema: 1,
    synthetic: true,
    note: "DEMO DATA - every name and number in this file is invented. Not real money.",
    createdAt: now.toISOString(),
    accounts: ACCOUNTS.map((a) => Object.assign({}, a)),
    categories: CATEGORIES.map((c) => Object.assign({}, c)),
    rules,
    transactions: tx,
    receipts,
  };
}

// Two small demo "bank export" files for the Import tab: one plain comma CSV in UTF-8, one Israeli-style file with a title line,
// semicolons and separate debit/credit columns. Invented rows only. Returns [{name, text}].
function demoExports(ledger) {
  const rows = (ledger.transactions || []).filter((t) => t.account === "leumi").slice(-40);
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const dmy = (d) => d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4);
  const a = ["תאריך,תיאור,סכום,יתרה"];
  let bal = 18000;
  for (const t of rows) { bal = r2(bal + t.amount); a.push([dmy(t.date), q(t.merchant), t.amount.toFixed(2), bal.toFixed(2)].join(",")); }
  const cardRows = (ledger.transactions || []).filter((t) => t.account === "card-b" && !t.transfer).slice(-30);
  const b = ["פירוט עסקאות - כרטיס דמו (לא אמיתי)", "", "תאריך עסקה;שם בית העסק;חובה;זכות"];
  for (const t of cardRows) b.push([dmy(t.date), t.merchant.replace(/;/g, ","), t.amount < 0 ? (-t.amount).toFixed(2) : "", t.amount > 0 ? t.amount.toFixed(2) : ""].join(";"));
  return [
    { name: "DEMO_bank_export.csv", text: a.join("\r\n") + "\r\n" },
    { name: "DEMO_card_export.csv", text: b.join("\r\n") + "\r\n" },
  ];
}

module.exports = { makeLedger, demoExports, ACCOUNTS, CATEGORIES, prng };
