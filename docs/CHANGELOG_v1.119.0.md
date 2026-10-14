## v1.119.0 - Fleet conversations pane

the owner's request (2026-10-13, "really important"): one place in Agent Desktop to see all conversation between his agents and the partner's agents, and to answer open questions right there.

- **New sidebar button "the partner's side"** with an unread badge (the partner-side notes newer than the last time the pane was opened; the "last seen" time is kept in `ui-flags.json` as `fleetPaneLastSeen`). Clicking it opens a pane on the **right** of the normal conversation; the chat stays visible and shrinks to make room (pane width 300-440 px, readable at small windows). Esc or x closes it.
- **Source v1 = the Exchange file mailbox** (the shared Exchange folder, folders `to_owner_fleet` = from the partner's side, `from_owner_fleet` = from the owner's fleet). Override with `AGENT_DESKTOP_FLEET_DIR` (sandbox/tests). Date from the file-name prefix (fallback mtime), sender/recipient from the `To:/From:` lines (fallback file name, else "unknown"), notes grouped into best-effort threads by shared topic words, newest first. Missing folders show a calm "Mailbox not found" state.
- **Waiting for your answer** (dark box at the top): the newest note of a thread from the partner's side, under 7 days old, containing a question mark or "please confirm"/"waiting for you", with no later note from the owner's side. Each has an answer box; **Send answer** writes `YYYY-MM-DD_Owner_reply_<slug>.md` into `from_owner_fleet` (`To: <recipient>. From: the owner (via Agent Desktop).` + the text). Never overwrites (a taken name gets -2, -3); the pane then opens the written note and says where it was saved. Any opened note also has a Reply box.
- **Light:** one listing per 60 s (names + stat of the newest 300 files; the first 3 KB of each cached by mtime for sender/question detection); whole notes are read only when opened; no new dependencies. Rendering uses `textContent` only.
- **Safety:** reads only the two folders, writes only the reply files above; the message id is validated (no path parts).
- **Not done / TODO:** IRIS messages are not in this list yet (marked TODO in `fleet-pane.js`; only undelivered IRIS items are cheaply listable, and without text).
- Files: `src/fleetMailbox.js` (new), `src/renderer/fleet-pane.js` + `styles-fleet-pane.css` (new), IPC `fleet-list/fleet-read/fleet-reply` in `src/main.js`, `window.api.fleet` in `src/preload.js`, `tests/fleetPane.test.js` (17 checks).

### Review fixes (same version)
- Async fs (8 in flight), only the newest 300 candidate names are stat'ed, a re-list is skipped when the fingerprint (names + newest files' size/mtime) is unchanged; polling every 5 min when closed (plus window focus, max every 30 s), 60 s when open.
- Open questions: same-day order decided by real file times; every the partner note of a thread is checked; threads need 2+ shared topic words (or the same slug); "no reply needed" always wins (unless "except"); `?` in URLs/quotes ignored; Dismiss button.
- Unread: first run starts at "now"; last-seen moves only to the newest the partner note of a successful listing; badge stays in step while open.
- Safety: only regular files are read (no symlinks/devices/reserved names), failed head reads are not cached, header parsing only from the first lines.
- UI: drafts/focus/caret/scroll survive refreshes, Esc closes only the fleet pane, pane sits above the waiting-queue controls.
