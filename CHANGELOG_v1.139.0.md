# v1.139.0 - (2026-10-24) My Research: third tab "Skills & Plugins"

Iddo (2026-10-24): "we talked about plugins and skills added to Agent Desktop research as a tab ... it doesn't show in the Research tab at all. I want to see what skills and plugins you're going to research."

## What it shows (read-only)
My Research now has three tabs: Findings | My Recommendations | **Skills & Plugins**. The new tab, in plain words:
- **Big numbers** (each a button that jumps to what it counts): agents this week, items found (with last week's count, or "first week, nothing to compare"), answered (of found), places we look, adopted.
- **This week:** who researches skills/plugins this week (from `skills_plugins_rotation.json`), why, and the next run ("Thursday 29 Oct, about 17:00 (in 5 days)", computed from the rotation's own schedule text on the PC clock; the text is also shown as written). Agents without a report yet are marked "(no report yet)"; the others jump to their findings. A note appears when the rotation is for an older week.
- **Found:** the newest week that has `skills_<Agent>.json` files (week picker when there are several), grouped by agent (best item first), each item ranked by score with title (opens the link), "How it helps", "Where it would plug in", the agent's verdict (Use it as it is / Borrow the idea / Skip), "Not checked by Security yet", details (author, licence, what it needs to run), and **your answer** read from ARGUS's verdict store (`recommendations\<week>\<Agent>.json` items[].decision: Install it / Parked / Don't install, or "Not answered yet"). "Answer in ARGUS" opens ARGUS (where the Install it / Park / Don't install / Ask buttons live). Empty state: "Nothing found yet this week." plus the next run.
- **Where we look:** `sources\_skills_plugins.json`, best first, with score, last useful, weeks with nothing new, last checked, notes; first 15, "Show all N places". Entries with no name are shown under their link.
- **Already adopted:** pinned copies under `<shared tools>\skills\<name>\README.md` (title, source, vetted line, number of skills and of fingerprinted files). Currently: Ponytail.

## Code
- `src/skills/service.js` (new, main process, async, read-only; injected folders; clips/type-checks everything; skips bad or >512 KB files and counts them).
- `src/research/main-research.js`: IPC `skills-load` (main window only, same `handle()` guard, needs-setup aware). Folders: research = the existing researchDir(), recommendations = reportsDir()\recommendations, pinned copies = configured sharedTools\skills (sandbox: its own shared_tools). Nothing hard-coded.
- `src/preload.js`: `research.skillsLoad(week)`.
- `src/renderer/research.js`: tab bar has a third tab; the lazy sub-tab loader is generalised (`SUB_TABS`, `mountSub`) and used by both recs and skills; closing the view unmounts both.
- `src/renderer/skills.js` + `styles-skills.css` (new; loaded on first click of the tab; textContent only; no timers, no storage; `--rs-*` tokens only).
- Tests: `tests/skillsTab.test.js` (15) added to `npm test`; `research.test.js` and `research-mag.test.js` allow-lists now include `skills-load`.

## Not changed
The producers (weekly skills job, rotation, sources) and ARGUS's verdict writing. This tab writes nothing.
