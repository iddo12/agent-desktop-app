// My Health: "the app never shows an amount of a supplement or medicine" (review finding F2). Text written by the Health agent is
// normalised first, then any sentence that pairs a quantity with a dosing unit is REPLACED by a fixed notice (not dropped, so a
// useful card is not lost); the record is marked `amountRemoved`. Recipes are NOT filtered (food amounts are the point).
//
// Normalisation: NFKC (full-width digits, vulgar fractions), zero-width / bidi / format characters removed, every Unicode decimal digit
// mapped to ASCII 0-9, lower case, non-breaking and thin spaces collapsed, "5 m g" joined to "5 mg", "3x500mg" split.
// Detection: a quantity (a digit run, or a number word in English or Hebrew, or "a/an" before a dose-form word) within 3 tokens of a unit
// from a broad lexicon (mass, volume, IU, tablets, capsules, scoops, spoons, drops, doses, servings; English and Hebrew).
// The strict mode (used for the Plan "vitamins" group and supplement/medicine insights) additionally neutralises any sentence with a digit
// that is not a year or a duration. A lexicon can never be complete: the doctor line stays on screen as defence in depth.
"use strict";

const NOTICE = "[amount removed: ask your doctor]";

const UNITS = new Set(["mg", "mcg", "ug", "milligram", "milligrams", "microgram", "micrograms", "milliliter", "milliliters", "millilitre", "millilitres", "µg", "μg", "g", "gr", "gram", "grams", "gramme", "grammes", "kg", "ml", "l", "liter", "liters", "litre", "litres", "cc", "dl", "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds",
  "iu", "ui", "unit", "units", "mmol", "mol", "meq", "mcl", "ng", "pg", "tablet", "tablets", "tab", "tabs", "pill", "pills", "capsule", "capsules", "cap", "caps", "softgel", "softgels", "gummy", "gummies", "scoop", "scoops",
  "tsp", "tbsp", "teaspoon", "teaspoons", "tablespoon", "tablespoons", "drop", "drops", "spray", "sprays", "sachet", "sachets", "patch", "patches", "dose", "doses", "dosage", "serving", "servings", "cup", "cups", "glass", "glasses", "ampoule", "ampoules", "ampule", "ampules", "injection", "injections", "shot", "shots", "puff", "puffs", "lozenge", "lozenges",
  // Hebrew
  "מ\"ג", "מג", "מיקרוגרם", "גרם", "גרמים", "ק\"ג", "מ\"ל", "מל", "מיליליטר", "ליטר", "כדור", "כדורים", "כמוסה", "כמוסות",
  "כפית", "כפיות", "כף", "כפות", "טיפות", "טיפה", "מנה", "מנות", "יחידות", "יחידה",
  // a few other languages the owner may meet in labels
  "comprimé", "comprimés", "gélule", "gélules", "tabletten", "tablette", "kapsel", "kapseln", "tabletas", "cápsulas", "gotas"]);

const NUMBER_WORDS = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "half", "quarter", "couple", "dozen", "few",
  "אחד", "אחת", "שניים", "שתיים", "שתי", "שלוש", "שלושה", "ארבע", "ארבעה", "חמש", "חמישה", "שש", "שישה", "שבע", "שבעה", "שמונה", "תשע", "תשעה", "עשר", "עשרה", "חצי", "רבע",
  "un", "une", "deux", "ein", "eine", "zwei", "uno", "dos"]);
const ARTICLES = new Set(["a", "an"]);
const DOSE_FORMS = new Set(["tablet", "capsule", "pill", "scoop", "tsp", "tbsp", "teaspoon", "tablespoon", "drop", "sachet", "dose", "softgel", "gummy", "spray", "patch", "ampoule", "injection", "lozenge", "puff", "shot"]);
const FWD = new Set([...DOSE_FORMS, "כדור", "כדורים", "כמוסה", "כמוסות", "כפית", "כף", "טיפות", "מנה"]);
const DURATION = new Set(["day", "days", "week", "weeks", "month", "months", "year", "years", "hour", "hours", "minute", "minutes", "min", "mins", "time", "times", "night", "nights", "sec", "seconds",
  "יום", "ימים", "שבוע", "שבועות", "חודש", "חודשים", "שנה", "שנים", "שעה", "שעות", "דקות"]);

function digitValue(ch) {
  // Unicode decimal digits come in runs of ten starting at a code point whose predecessor is not a digit
  const cp = ch.codePointAt(0); let z = cp;
  while (/\p{Nd}/u.test(String.fromCodePoint(z - 1))) z--;
  return (cp - z) % 10;
}
// Cheap, reliable: Unicode decimal digits come in runs of 10 starting at a code point whose previous code point is not a digit of that run.
function toAsciiDigits(s) { return s.replace(/\p{Nd}/gu, (c) => (c >= "0" && c <= "9" ? c : String(digitValue(c)))); }

function normalize(text) {
  let s = String(text == null ? "" : text).normalize("NFKC");
  s = s.replace(/[\p{Cf}­]/gu, "").replace(/[  -   　]/g, " ");
  s = toAsciiDigits(s).toLowerCase().replace(/\s+/g, " ");
  return s;
}
const TOKEN_RE = /\p{L}+(?:["'״׳’]\p{L}+)?|\d+(?:[.,]\d+)?/gu;
function tokens(norm) {
  const raw = norm.match(TOKEN_RE) || []; const out = [];
  for (let i = 0; i < raw.length; i++) {            // join spaced single letters: "m g" -> "mg", "i u" -> "iu"
    let t = raw[i];
    if (/^\p{L}$/u.test(t)) { let j = i, m = t; while (j + 1 < raw.length && /^\p{L}$/u.test(raw[j + 1]) && m.length < 3) { m += raw[++j]; if (UNITS.has(m)) { t = m; i = j; break; } } }
    out.push(t);
  }
  return out;
}
const isNum = (t) => /^\d/.test(t) || NUMBER_WORDS.has(t);

// true when the text pairs a quantity with a dosing unit
function hasAmount(text) {
  const tk = tokens(normalize(text));
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i]; const unit = UNITS.has(t) || UNITS.has(t.replace(/s$/, ""));
    if (!unit) continue;
    for (let d = 1; d <= 3; d++) { const b = tk[i - d]; if (b && isNum(b)) return true; if (b && ARTICLES.has(b) && DOSE_FORMS.has(t.replace(/s$/, ""))) return true; }
    const nx = tk[i + 1]; if (nx && isNum(nx) && (FWD.has(t) || FWD.has(t.replace(/s$/, "")) || t === "mg" || t === "iu")) return true;   // "mg 500", Hebrew "tablet one"
  }
  return false;
}
// strict: ANY digit that is not a year (1900-2099) and not next to a duration word counts
function hasLooseNumber(text) {
  const tk = tokens(normalize(text));
  for (let i = 0; i < tk.length; i++) {
    if (!/^\d/.test(tk[i])) continue;
    if (/^(19|20)\d\d$/.test(tk[i])) continue;
    const nb = [tk[i - 1], tk[i + 1], tk[i + 2]].filter(Boolean);
    if (nb.some((w) => DURATION.has(w))) continue;
    return true;
  }
  return false;
}

// Replace each offending sentence by the notice. Returns {text, removed}.
function clean(text, opts) {
  const strict = !!(opts && opts.strict), s = String(text == null ? "" : text);
  if (!s) return { text: s, removed: 0 };
  const parts = s.split(/(?<=[.!?;\n׃])\s+/u); let removed = 0;
  const out = parts.map((p) => { if (hasAmount(p) || (strict && hasLooseNumber(p))) { removed++; return NOTICE; } return p; });
  const joined = out.filter((p, i) => !(p === NOTICE && out[i - 1] === NOTICE)).join(" ");
  return { text: joined, removed };
}
// Clean several named fields of an object copy; returns {values, removed}
function cleanAll(list, opts) { let removed = 0; const values = list.map((t) => { const r = clean(t, opts); removed += r.removed; return r.text; }); return { values, removed }; }

module.exports = { NOTICE, normalize, tokens, hasAmount, hasLooseNumber, clean, cleanAll, toAsciiDigits };
