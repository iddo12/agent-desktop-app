# Release notes text: launch and start-up area (v1.121.0)

Paste into the v1.121.0 entry. Plain words first, details below.

## What changes for you
- **Agent Desktop no longer assumes where things are on your computer.** Where your agents live, where Claude Code, Node.js, git and Python are, where updates come from: all of it is read from the one settings file (Setup writes it). Nothing in the program points at one person's folders any more.
- **Claude Code missing is now said in words.** If Claude Code cannot be found, a banner says "Claude Code is not installed", what to do, and has an **Open Setup** button. Setup has a new **Claude Code** row (Fix lets you point to the program).
- **Your Claude Code settings are no longer edited behind your back.** Before, every start wrote a usage status line and "remote control at startup" into your Claude Code settings file. Now that only happens after you turn on **Setup > Claude Code integration** and confirm in a plain-words dialog. A fresh install never touches the file. An agent cannot turn it on for you. (A computer that already had it keeps it: its migration config carries your earlier consent.)
- **PC Health** shows a calm "not set up" state with a **Set up** button when Python or its measuring script is missing, instead of a failed collector.
- **Telegram tasks** (the approval queue in the tasks header) has its own Setup row; with no bridge configured the queue is simply empty.
- **Updates**: the place updates come from (`updateRepo`) and the branch a checkout follows (`updateChannel`, default `main`) are settings. The update steps themselves are unchanged.

## For people who read the scripts
- `Launch.vbs` finds Node.js through the installer's registry entry, then `ProgramFiles`, then `PATH`, and shows one message if there is none. `Start-TestDesktop.bat` and the two Playwright dev scripts take their work folder from the environment (`AGENT_DESKTOP_WORK`, `AGENT_DESKTOP_ROOT`, optional git-ignored `Start-TestDesktop.local.bat`). See the READ_FIRST section of `INSTALL_AND_USE_FOR_CLAUDE.md`.

## Technical notes (for the maintainer)
- New: `src/launchEnv.js` (Claude/Node/npm/git/python discovery, injected fs for tests), `src/agentsRoot.js` (the agents-folder rule: `AGENT_DESKTOP_AGENTS_ROOT` > `AGENT_DESKTOP_ROOT` > Setup's `agentsRoot` > the old "folder the program sits in" rule when it holds agent folders > none).
- Features: `claudeCode`, `claudeIntegration` (consent), `telegram` added; `pcHealth` wired. New keys: `telegramBridgeDir`, `updateRepo`, `updateChannel`.
- Migration: `tools/write-migration-config.js --from-legacy [--iris-consent] --claude-integration` (the new flag writes the integration consent with source "migration").
- `agents.js` / `groups.js` no longer fix the agents folder at load: a folder chosen in Setup lists its agents at once. The few modules handed `AGENTS_ROOT` at start-up (registry, wake, usage fallbacks) pick it up on the next start; a log line says so.
- Tests: `tests/launchConfig.test.js` (new, 20); `tests/pchealth-main.test.js` passes a script now (a collector with no script is needs-setup, not a made-up path); `features`/`setupPanel` tests know the converted features.
