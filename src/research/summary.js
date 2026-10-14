// Readable markdown summary of one research week (extra, v1.87.0). Pure function of what service.load() returns, so the app's "Export week
// summary" button and the command line tool (tools/research-aggregate.js) produce the same file: shared_reports\research\<week>\_week_summary.md
"use strict";

const TIER_ORDER = { high: 0, normal: 1, low: 2 };

function counts(snap) {
  const all = snap.digests.flatMap((d) => d.findings);
  const st = {};
  snap.digests.forEach((d) => { st[d.state] = (st[d.state] || 0) + 1; });
  return {
    findings: all.length, high: all.filter((f) => f.tier === "high").length, worth: all.filter((f) => f.worth).length, idea: all.filter((f) => f.idea).length,
    agents: snap.digests.filter((d) => d.findings.length).length, states: st,
  };
}

function buildSummary(snap, opts) {
  const who = (opts && opts.ownerName) || "the user"; // v1.121.0: the configured owner name; the stored data field name is a wire format
  const L = [];
  const c = counts(snap);
  L.push("# Research summary " + snap.week, "");
  const sw = Object.keys(c.states).map((k) => c.states[k] + " " + (k === "ok" ? "ran" : k)).join(", ");
  L.push("This week at a glance: " + c.findings + " findings from " + c.agents + " agents; " + c.high + " high tier; " + c.worth + " flagged 'worth " + who + " knowing'; " + c.idea + " could become an idea. Agent status: " + (sw || "none") + ".", "");
  const t = snap.top5;
  L.push("## The five to read first", "");
  L.push(t.state === "curated" ? "Curated by " + (t.pickedBy || "the COO") + (t.pickedAt ? " (" + t.pickedAt + ")" : "") + "." : "NOT YET CURATED by the COO: the preview below is the first finding of the first five agents.", "");
  t.picks.forEach((p, i) => { L.push((i + 1) + ". **" + p.agent + "**: " + p.title + (p.why ? " - " + p.why : "")); });
  L.push("");
  if (snap.coo && snap.coo.contradictions.length) { L.push("## Contradictions", ""); snap.coo.contradictions.forEach((x) => L.push("- " + (x.between.length ? x.between.join(" / ") + ": " : "") + x.about)); L.push(""); }
  L.push("## By agent", "");
  snap.digests.forEach((d) => {
    L.push("### " + d.agent + " - " + d.label + (d.findings.length ? " (" + d.findings.length + " findings)" : ""));
    if (d.summary) L.push("", d.summary);
    if (d.note) L.push("", "Note: " + d.note);
    d.findings.slice().sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]).forEach((f) => {
      L.push("", "#### [" + f.tier + (f.confidence ? ", " + f.confidence : "") + "] " + f.title);
      if (f.worth) L.push("*Worth " + who + " knowing.*" + (f.idea ? " *Could become an idea.*" : ""));
      else if (f.idea) L.push("*Could become an idea.*");
      if (f.whatChanged) L.push("", "What changed: " + f.whatChanged);
      if (f.soWhat) L.push("", "Why it matters: " + f.soWhat);
      if (f.sources.length) { L.push("", "Sources:"); f.sources.forEach((s) => L.push("- " + (s.kind ? s.kind + ": " : "") + (s.title || "") + (s.url ? " <" + s.url + ">" : ""))); }
    });
    L.push("");
  });
  return L.join("\n") + "\n";
}

module.exports = { buildSummary, counts };
