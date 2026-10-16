## v1.131.0 - My Finance: Hebrew names read correctly, clearer cash-flow chart, a hint for login links, stricter file and link checks

- **Hebrew / right-to-left:** names from the feed (accounts, cards, clients, categories, items) are shown as separate text islands, so a Hebrew name no longer scrambles the stale-data and needs-you strips or the balance list. Checked on screen with a Hebrew synthetic feed (Home, Credit cards, Invoices, Accounts & transactions, Cash flow).
- **Cash flow:** the label of the lowest point now sits under its dot, with room kept free below the line, so it no longer overlaps the line or the item ticks.
- **Sources & import:** when no login links are set, the page says so and points to Setup (the setting `financeLoginLinks`), listing your source ids.
- **Feed file checks:** a file name containing ":" (a Windows alternate data stream) is refused before anything is opened. The "same file as the path" check compares inode and device; it is skipped when the file system reports no inode (0), and the size, regular-file and unchanged-while-reading checks still apply.
- **Links:** the main window now opens only https links in the system browser (plain http is no longer opened); every new window stays denied.
- Tests: `tests/finance-feed.test.js` 36 (adds Hebrew, hint, name and inode, chart layout checks; the window-handler test is updated to https only). Needs a restart.
