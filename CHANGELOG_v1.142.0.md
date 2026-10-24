# v1.142.0 - (2026-10-25) Contacts tab, phase 1: a basic CRM over the Personal Assistant agent's contact export

Company-first directory (layout A): search box (company, alias, person, email, category; folds case and accents), category chips with counts, "Show: needs my reply / waiting on them / quiet over 60 d", sort by latest contact / A to Z / category, 50 rows per page. Company page: categories (editable, a company can have several), website and phone, "Who to talk to" = ALL people who wrote or were written to in the last 12 months (newest first; a person quiet while colleagues are active gets a "Silent" flag; automated senders never count), other people, company note and handover. Person page: role with its source (role is null until the PA role pass), recent emails (last 6, direction + subject), snooze 7 d / "No reply needed" / Clear, note. "Review suggestions": the PA agent's category_suggestions.json, one click Confirm / Not this, nothing saved until confirmed. Footer: people without a company, data time, warning when the export is older than 3 days. Keys: `/` search, Esc steps back.

NOT in this version (decided with Iddo): no Send button anywhere, no drafts yet (Phase 2, needs the Betterbird bridge), no loan tracker, quiet-company alert, key dates or relationship types.

## Security (requirements section A)
- IPC only, no HTTP port; every handler checks the sender is the main window and bounds the request size; logs carry channel names and codes only (never names, subjects or notes).
- Reads `contacts.json` only; never writes it. Iddo's own records (categories, links, notes, snooze, rejected suggestions) live in ONE file beside it, `contacts_ui.json`, written atomically. The folder (new setting `contactsDir`) is refused when it is inside Dropbox/OneDrive/Google Drive/iCloud: contact data stays in the scratch area.
- Everything shown is set with `textContent` (names, emails, subjects and notes are untrusted); categories reject `<`/`>` and control characters; links accept `https://` only; phone numbers a strict pattern.

## For other agents
Read-only export `contacts_directory.json` (rewritten after every change and when a new PA export is seen; no mail subjects, no email addresses) and the CLI `shared_tools\contacts\contacts_lookup.py --company smallrig | --person "name" | --list-categories`.

## Tests
`tests/contactsLogic.test.js`, `tests/contactsMain.test.js` (added to `npm test`); the renderer was driven in a real Electron window against the real handlers and the PA data (551 companies, 1,025 people; index built in ~30 ms).
