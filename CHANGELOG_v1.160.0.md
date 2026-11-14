# v1.160.0 (2026-11-14): My Tools "All programs" tab, Beta NN% badge
- New third tab "All programs": list graded from `grades.json` (schema `mytools-grades/1`, Security's grade.py). Header: mean readiness and count at/above target, each with "(was ...)" vs the previous file generation. Sort (readiness, name, hours, LensVid) and filters (yes / maybe / internal / needs Iddo) run in main. Detail view: criteria bars with evidence, task list (pct, hours, Needs Iddo / Zotac OK / Opus badges), "Open in Tools view". Empty state when the file is missing or invalid.
- Config key `toolsGradesFile` (default `<sharedTools>/tools/grades.json`); test override `AGENT_DESKTOP_TOOLS_GRADES`.
- `readiness` in tools.json may be a number or `{score,target,stage}`; card shows "Beta NN%" with a marker at the target; order: rank, then readiness desc, then newest.
- Reload on window focus (no timers). Open folder button omitted (no safe IPC yet).
- Tests: tests/toolsGrades.test.js (8). Verified in a hidden Electron window against the real grades.json (44 tools).
