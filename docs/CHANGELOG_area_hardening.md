# v1.121.0 - hardening round (release notes text)

Review findings on the configuration layer, all fixed:

- **Faster Setup and start-up.** Finding programs on PATH (Python, Node, Git, Claude Code) is now done by listing each PATH folder once and remembering the answer for a minute. Reading the whole Setup panel dropped from about 1.3 s to a few milliseconds on a PC with 37 PATH folders (one value from 22 ms to under 1 ms). The renderer's own start-up read is lighter (values only) and waits until the window has painted and is idle.
- **Safer settings.** Program settings must point to a .exe, .cmd or .bat (scripts to .py) and never to a network share or device path; agent roles and mailbox folder names must be a single folder name. The same rules apply to values from the environment, and again where the names are used (wake-agent callers, fleet replies). Folders the app creates in Setup must sit inside the workspace folder (decided from the saved setting, not from what the page sends) and never on a network share.
- **Migration tools.** `tools/write-migration-config.js --force` now merges (existing IRIS / Claude Code consent records, the daily block and other settings are kept; a .bak is written) and prints the deploy order. New `tools/deploy-migration.js` runs migration, daily migration and consent flags in order and verifies the result by loading it. Consent stays an honour-system record, as documented in SETUP.md.
- **Claude Code integration, existing installs.** An install that already has Agent Desktop's status line (or remote control switched on) in the Claude Code settings is recognised once at start and keeps working; any other install stays off until the person turns it on in Setup. Parse errors fail closed.
- **settings.json edits are atomic** (temp file + rename) with a one-time backup `settings.json.agentdesktop.bak` that is never overwritten.
- **Setup states.** Library no longer waits for a tool it never used; Claude Code shows ready whenever it can really be found (package folder, native installer, npm), not only on PATH.
- **My Health** heals a vault whose marker file could not be written at first start; the message no longer mentions another agent.
- **Test sandbox** no longer reads the live usage file or live folders from a copied config unless explicitly allowed (AGENT_DESKTOP_THROTTLE_FILE, AGENT_DESKTOP_TEST_ALLOW_READ).
- **Program lookups** (`where`, registry) are remembered for 5 minutes, use a 2-second timeout, no shell, and are warmed in the background a moment after start.
- **Migration data**: duplicate folders are removed from document/open-path folder lists; My Daily's data folder is pinned explicitly.
