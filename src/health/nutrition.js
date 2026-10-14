// My Health stage 1b: Nutrition support, all by simple code rules (no model): the "nutrients in focus" strip derived from your labs,
// how many of the shown recipes speak to each focus, and the shopping list (ingredients aggregated from the recipes you add).
// The marker-to-nutrient links are a plain lookup table, shown on screen as "simple rules, not medical advice".
"use strict";
const C = require("./compare");

// lab key -> nutrient and the direction that makes it a focus ("low": value too low; "high": value too high)
const LINKS = {
  ferritin: ["Iron", "low"], iron: ["Iron", "low"], "transferrin-saturation": ["Iron", "low"],
  "vitamin-b12": ["B12", "low"], b12: ["B12", "low"], "active-b12": ["B12", "low"], holotranscobalamin: ["B12", "low"], homocysteine: ["B12", "high"], mma: ["B12", "high"],
  "vitamin-d": ["Vitamin D", "low"], "25-oh-vitamin-d": ["Vitamin D", "low"], "25-hydroxy-vitamin-d": ["Vitamin D", "low"],
  calcium: ["Calcium", "low"], zinc: ["Zinc", "low"], folate: ["Folate", "low"], "folic-acid": ["Folate", "low"], magnesium: ["Magnesium", "low"], albumin: ["Protein", "low"],
  "omega-3-index": ["Omega-3", "low"], "hs-crp": ["Omega-3", "high"], crp: ["Omega-3", "high"],
  "ldl-cholesterol": ["Fibre", "high"], "total-cholesterol": ["Fibre", "high"], apob: ["Fibre", "high"], hba1c: ["Fibre", "high"], glucose: ["Fibre", "high"], "fasting-glucose": ["Fibre", "high"],
};
const MATCH = { iron: ["iron"], b12: ["b12", "b-12", "cobalamin"], "vitamin d": ["vitamin d"], calcium: ["calcium"], zinc: ["zinc"], folate: ["folate", "folic"], magnesium: ["magnesium"], protein: ["protein"], "omega-3": ["omega-3", "omega 3", "dha", "epa", "ala"], fibre: ["fibre", "fiber"] };

function focusFor(labs) {
  const by = new Map();
  for (const l of labs) { if (LINKS[l.key]) { if (!by.has(l.key)) by.set(l.key, []); by.get(l.key).push(l); } }
  const out = [];
  for (const [key, recs] of by) {
    const [nutrient, bad] = LINKS[key], { last, previous } = C.lastAndPrevious(recs), hist = C.lastN(recs, 3);
    const lowLab = last.refLow != null && last.value < last.refLow, highLab = last.refHigh != null && last.value > last.refHigh;
    const lowOpt = last.optLow != null && last.value < last.optLow, highOpt = last.optHigh != null && last.value > last.optHigh;
    const drifting = hist.length === 3 && (bad === "low" ? hist[0].value > hist[1].value && hist[1].value > hist[2].value : hist[0].value < hist[1].value && hist[1].value < hist[2].value) && Math.abs((hist[2].value - hist[0].value) / (hist[0].value || 1)) >= 0.05;
    let reason = null, rank = 9;
    if ((bad === "low" && lowLab) || (bad === "high" && highLab)) { reason = (bad === "low" ? "below" : "above") + " the lab range"; rank = 0; }
    else if ((bad === "low" && lowOpt) || (bad === "high" && highOpt)) { reason = (bad === "low" ? "below" : "above") + " the optimal zone you entered"; rank = 1; }
    else if (drifting) { reason = "trending " + (bad === "low" ? "down" : "up") + " in its last 3 results"; rank = 2; }
    if (!reason) continue;
    out.push({ nutrient, key, test: last.test, unit: last.unit, value: last.value, ts: last.ts, previous: previous ? previous.value : null, reason, rank,
      series: C.lastN(recs, 24).map((r) => ({ ts: r.ts, v: r.value, s: r.source })), refBand: last.refLow != null && last.refHigh != null ? { low: last.refLow, high: last.refHigh, label: "lab range" } : null });
  }
  out.sort((a, b) => a.rank - b.rank || a.nutrient.localeCompare(b.nutrient));
  return out;
}
// How many of the shown recipes list this nutrient among their per-serving highlights.
function coverage(focus, recipes) {
  return focus.map((f) => {
    const words = MATCH[f.nutrient.toLowerCase()] || [f.nutrient.toLowerCase()];
    const ids = recipes.filter((r) => r.status !== "dismissed" && r.nutrients.some((n) => words.some((w) => n.name.toLowerCase().indexOf(w) >= 0))).map((r) => r.id);
    return Object.assign({}, f, { recipeIds: ids, recipeCount: ids.length });
  });
}

// ---- shopping list: snapshots of the ingredients of the recipes you added, aggregated by ingredient name
const UNIT_RE = /^(\d+(?:[.,]\d+)?)\s*([a-zA-Z]*)$/;
const keyOf = (item) => String(item).toLowerCase().replace(/\s+/g, " ").trim();
function aggregate(lists) {
  const map = new Map();
  for (const rid of Object.keys(lists)) for (const ing of lists[rid].ingredients) {
    const k = keyOf(ing.item); const e = map.get(k) || { key: k, item: ing.item, parts: [], from: [] };
    e.parts.push(ing.amount); if (e.from.indexOf(rid) < 0) e.from.push(rid); map.set(k, e);
  }
  return [...map.values()].map((e) => {
    const parsed = e.parts.map((a) => UNIT_RE.exec(String(a).trim())), same = parsed.every((m) => m) && new Set(parsed.map((m) => m[2].toLowerCase())).size === 1;
    const amount = same ? String(Math.round(parsed.reduce((x, m) => x + parseFloat(m[1].replace(",", ".")), 0) * 100) / 100) + (parsed[0][2] ? " " + parsed[0][2] : "") : e.parts.filter(Boolean).join(" + ");
    return { key: e.key, item: e.item, amount, from: e.from };
  }).sort((a, b) => a.item.localeCompare(b.item));
}

module.exports = { LINKS, focusFor, coverage, aggregate, keyOf };
