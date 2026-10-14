## v1.119.4 - Small screens: the agent list is never squeezed out; the update dialog fits

the partner's screen is smaller than the owner's and the sidebar footer (selected-agent card, Plan, Left pane, Restart, notices) pushed her agent list out of reach; the Update & restart dialog with a long red error also covered the app. Design by the UI/UX agent (UI-UX Agent\docsgent_desktop_small_screen_2026-10-13.pdf), items 1 and 5 (the safety net, no visible redesign).
- `#agent-list` always keeps at least 168 px (about 4 agent rows) and `#sidebar` scrolls when the footer is taller than the window.
- Update dialog: at most the window height minus 24 px; the buttons stay pinned at the bottom while the body scrolls; a long error shows its first 140 characters and the whole text behind a native "Show details" (max 30% of the window height, selectable).
- Next (needs the owner's OK, they move familiar things): gear popover for the settings rows, one-line notices badge, icon strip by default on screens under 780 px high.
