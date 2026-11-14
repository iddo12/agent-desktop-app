# v1.159.0 (2026-11-14): My Tools ordered by rank, readiness % on the card
- `tools.json` entries may carry `rank` (1..9999) and `readiness` (0-100). `schema.js` keeps both (soft: a bad value loads as null). `model.js` `byRankThenNewest`: each group sorts by rank ascending; unranked tools follow, newest first (old `updated` order). The card shows "Ready NN%" (tooltip: beta-readiness, target 90%).
- Requested by Security (grading overhaul, ask 20261114-080522-f11e sealed "Yes all"). Test: `node tests/toolsRankReadiness.test.js`. Needs a full restart.
- Next (v1.160.0): the "All programs" tab (spec E:\Claude work\Security\mytools_grading\AD_TAB_SPEC.md).
