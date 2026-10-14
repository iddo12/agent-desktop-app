// node tests/research-dates.test.js - My Research card dates (v1.121.1): "<source date> · found <day month>" on every card, found-date only when the
// finding has no usable sourceDate, defensive parsing (ISO, free text, junk), and the renderer shows the line on all four card kinds. Temp folders only.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const D = require("../src/research/dates");
const SV = require("../src/research/service");
let n = 0, fails = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };

t("dateLine: ISO and free-text source dates, with the found day", () => {
  assert.strictEqual(D.dateLine("2026-08-10", "2026-10-12T07:30:00Z"), "Aug 10 2026 · found 12 Oct");
  assert.strictEqual(D.dateLine("2026-08-10T23:59:00-05:00", "2026-10-12"), "Aug 10 2026 · found 12 Oct", "the day as written, no time zone shift");
  assert.strictEqual(D.dateLine("Aug 10 2026", "2026-10-12"), "Aug 10 2026 · found 12 Oct");
  assert.strictEqual(D.dateLine("10 August 2026", "2026-10-12"), "Aug 10 2026 · found 12 Oct");
});
t("dateLine: no usable sourceDate falls back to the found date only; nothing usable gives an empty line", () => {
  for (const bad of [undefined, null, "", "   ", "soon", "Q3 2026", "2026-02-31", "2026-13-01", "0001-01-01", "9999-01-01", {}, [], NaN, "x".repeat(500)])
    assert.strictEqual(D.dateLine(bad, "2026-10-12"), "found 12 Oct", JSON.stringify(bad));
  assert.strictEqual(D.dateLine("2026-08-10", undefined), "Aug 10 2026");
  assert.strictEqual(D.dateLine(undefined, undefined), "");
  assert.strictEqual(D.dateLine("2026-08-10", "garbage"), "Aug 10 2026");
});
t("parseDate never throws, whatever it is given", () => {
  const nasty = [undefined, null, 0, -1, 1e20, true, {}, [], () => 1, Symbol.iterator.toString(), "\u0000", "￿".repeat(100), { toString() { throw new Error("x"); } }];
  for (const v of nasty) { let r; assert.doesNotThrow(() => { r = D.parseDate(v); }); assert.ok(r === null || typeof r === "object"); }
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "research-dates-"));
const wk = path.join(tmp, "2026-W41"); fs.mkdirSync(wk);
fs.writeFileSync(path.join(wk, "Alpha Agent.json"), JSON.stringify({
  agent: "Alpha Agent", week: "2026-W41", generatedAt: "2026-10-12T07:30:00Z", summary: "s",
  findings: [{ id: "a", title: "With date", tier: "high", soWhat: "x", sourceDate: "2026-08-10" }, { id: "b", title: "Without date", soWhat: "y" }, { id: "c", title: "Junk date", soWhat: "z", sourceDate: "sometime" }],
}));
t("service: every finding of the digest carries its dateLine (with and without sourceDate)", () => {
  const r = SV.createService({ researchDir: tmp }).load({ week: "2026-W41" });
  const f = r.digests.find((x) => x.agent === "Alpha Agent").findings;
  const by = (title) => f.find((x) => x.title === title);
  assert.strictEqual(by("With date").dateLine, "Aug 10 2026 · found 12 Oct");
  assert.strictEqual(by("With date").sourceDate, "2026-08-10");
  assert.strictEqual(by("Without date").dateLine, "found 12 Oct");
  assert.strictEqual(by("Junk date").dateLine, "found 12 Oct");
});
t("service: a digest with no generatedAt and no sourceDate has an empty line (the card shows no date row)", () => {
  fs.writeFileSync(path.join(wk, "Beta Agent.json"), JSON.stringify({ agent: "Beta Agent", week: "2026-W41", summary: "s", findings: [{ id: "a", title: "T", soWhat: "x" }] }));
  const r = SV.createService({ researchDir: tmp }).load({ week: "2026-W41" });
  assert.strictEqual(r.digests.find((x) => x.agent === "Beta Agent").findings[0].dateLine, "");
});
t("renderer: the date line is added to the list card, the five card, the magazine hero and the magazine article, direction auto", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "research.js"), "utf8");
  assert.ok(/function dateEl\(f\)[^\n]*dateLine[^\n]*"rs-dates"/.test(js));
  assert.ok(/function dateEl\(f\)[^\n]*auto\(/.test(js), "dir=auto");
  assert.ok(/card\.append\(r1\); addDates\(card, f\)/.test(js), "list card");
  assert.ok(/p\.finding\.dateLine[^\n]*"rs-dates"/.test(js), "five card");
  assert.ok(/addDates\(tx, f\)/.test(js), "hero");
  assert.ok(/addDates\(b, f\)/.test(js), "article");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "styles-research.css"), "utf8");
  assert.ok(/\.rs-dates \{[^}]*var\(--rs-muted\)/.test(css), "small muted style");
});

console.log((n - fails) + "/" + n + " passed");
process.exit(fails ? 1 : 0);
