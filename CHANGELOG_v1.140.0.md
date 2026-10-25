# v1.140.0 - (2026-10-24) Skills & Plugins: answer and discuss inside the tab; hidden agents setting

## 1. Skills & Plugins: answer and discuss in the tab (Iddo)
"Instead of actually answering, I see I need to answer in ARGUS. Why not just say implement it or use it or discuss ... inside the tab itself."
- Each item now has **Install it** (or **Use the idea** on a borrow-the-idea item), **Park**, **Don't install** and **Discuss with <agent>**. The chosen answer is shown with a tick and in the "Your answer" chip; pressing it again takes it back. A plain line confirms "Saved: ... ARGUS shows the same answer." or says why not ("this item is not in the agent's ideas file for this week...", "ARGUS is not set up on this computer").
- **Same store as ARGUS, no new one:** answers go through the existing `argus-set-idea-decision` IPC (`argus-data.setIdeaDecision`) into the item's `decision` in `recommendations\<week>\<Agent>.json`. "Use the idea" is stored as `approved` (ARGUS shows Install it/approved).
- **Discuss, no new transport:** an in-tab box (prefilled "> Re: <title> (<week>)", nothing sent until Send) that sends through the My Recommendations reply path (`recs-write` -> research writer: verified delivery to the agent that found the item, or its pending-notes file when it is not running). Empty message: "Write your message first."
- The "Answer in ARGUS" button is gone. Dates with a time are shown in local time.

## 2. Hidden agents (Iddo: remove Security from Agent Desktop; he talks to it in the Claude app)
- New setting `hiddenAgents` (Setup / app-config.json, env `AGENT_DESKTOP_HIDDEN_AGENTS`): folder or display names separated by `;` or `,`. Default empty; no agent names in code.
- Hidden agents are not listed in the sidebar, the library "send to" picker, ARGUS's fleet states, the all-agents task triage, or the waiting-for-you bar. One quiet line under the agent list says "1 hidden agent - Show" (remembered on this computer). The agent you have open is always shown. Restart-all still lists them, last, marked "(hidden)".
- Display only: hidden agents are NOT stopped, paused or removed. `list-agents` / `get-agent-overview` add `hidden:true`; main's own `listAgents()` (delivery, wake-up, keep-going, handoff, research write) is untouched, and the renderer's `agents` array keeps them, so sending, wake requests, voice and lookups by name still reach them. Rows are built and only not displayed.
- This PC: `hiddenAgents = "Security"` written to this PC's app-config.json (not a code default).

## Code
`src/renderer/skills.js`, `styles-skills.css`; `src/hiddenAgents.js` (new), `src/appConfig.js` (key), `src/main.js` (two IPC handlers mark), `src/overview.js` (hidden field), `src/renderer/renderer.js` (sidebar rows, toggle line, bridge flag, restart-all), `library.js`, `argus.js`, `waiting-queue.js`, `header-tasks.js`, `styles.css`; `SETUP.md` regenerated.
Tests: `tests/skillsTab.test.js` (20: decision round trip tab -> ARGUS -> tab, error paths, discuss path), `tests/hiddenAgents.test.js` (10, new, in npm test).
