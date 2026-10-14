# Agent Desktop: install and use (written for a Claude Code agent helping a new user)

You are a Claude Code agent helping a person install and run **Agent Desktop** on their Windows PC. Do the steps yourself with your own tools; only hand back to the person for things only they can do (signing in to Claude, approving permission prompts). Repository: the URL the person was given together with this file

## What it is (tell the person in two sentences)
Agent Desktop is a window for running several Claude Code agents side by side. Each agent is a normal folder on disk with its own instructions; you see all agents in a sidebar, chat with them, and they keep running in the background when you close the window. It does not replace Claude Code: it uses the person's own Claude Code and their own Claude account.

## READ_FIRST: the plain scripts in the repo folder (v1.121.0)
These are ordinary text files you can read and change. None of them contains a path that belongs to one person's computer any more.
- **`Launch.vbs`** starts the app with no console window. It finds Node.js by itself: first the folder the Node.js installer recorded in the registry, then the Windows `ProgramFiles` folder, then whatever is on `PATH`. If Node.js is nowhere, it shows one short message (install the LTS version from nodejs.org) and stops. To use a Node.js that is somewhere unusual, put it on `PATH` before you start the script. Logs go to `%APPDATA%\agent-desktop\logs`.
- **`Start-TestDesktop.bat`** starts a disposable test copy on fixture agents (for people who change the app). Where it keeps its fixtures: `AGENT_DESKTOP_ROOT` (the fixture agents folder) if you set it, otherwise `%AGENT_DESKTOP_WORK%\agents`, where `AGENT_DESKTOP_WORK` defaults to `%LOCALAPPDATA%\AgentDesktopSandbox`. To keep your own values, copy `Start-TestDesktop.local.bat.example` to `Start-TestDesktop.local.bat` (it is git-ignored) and edit the two lines. The script finds `node` on `PATH`, or through the Node.js registry entry, and says so if there is none.
- **`sandbox-smoke.js`** and **`tools/health-pane-sandbox.cjs`** drive a test copy with Playwright. They read `AD_APP`, `AD_PLAYWRIGHT`, `AD_ELECTRON`, `AGENT_DESKTOP_WORK` and `AGENT_DESKTOP_ROOT` from the environment (defaults: this folder, the `playwright-core` package, the `electron` package, a temp folder).
- **Where programs are found.** Agent Desktop looks for Claude Code, Node.js/npm, git and python in this order: the path you set (Setup > Claude Code, or `claudeExe` / `nodeExe` / `gitExe` / `pythonExe` in `app-config.json`) > the places it always tried (`PATH`, the Claude Desktop package folder, the npm folder) > the usual install places built from Windows variables such as `ProgramFiles`. If Claude Code is not found, the app says so in words ("Claude Code is not installed") with an **Open Setup** button instead of failing quietly.
- **Settings in your Claude Code settings file are opt-in.** Agent Desktop used to write a usage status line and `remoteControlAtStartup` into `~/.claude/settings.json` on every start. Now it does that only after you turn on **Setup > Claude Code integration** (a plain-words confirmation). A fresh install never touches that file. An agent cannot turn it on for you.
- **Where updates come from** is configuration: `updateRepo` (GitHub `owner/name`, used by installed copies to look up the latest Release; empty = no update source, nothing is checked) and `updateChannel` (the branch a git checkout follows, default `main`).

## Requirements
- Windows 10 or 11.
- [Node.js](https://nodejs.org/) 18 or newer (check: `node --version`).
- [Git](https://git-scm.com/) (check: `git --version`).
- [Claude Code](https://claude.com/product/claude-code) installed and signed in (check: `claude --version`, then `claude` once to sign in; the person does the sign-in themselves, you never see or type their password).

## Install
1. Pick a folder for the workspace, for example `C:\Projects`. Agent Desktop's agents live as sibling folders next to the `agent-desktop` folder, so `C:\Projects\agent-desktop` means agents are created in `C:\Projects\<AgentName>`. (To keep agents elsewhere, set the `AGENT_DESKTOP_ROOT` environment variable.)
2. In PowerShell:
   ```powershell
   cd C:\Projects
   git clone <the Agent Desktop repository URL, as given to the person by whoever sent them this file>
   cd agent-desktop
   npm install
   npm start
   ```
3. The window opens. If `npm install` fails, read the error; the usual causes are an old Node version or no internet. Fix and retry, do not skip steps.
4. For daily use, `Launch.vbs` in the repo folder starts the app with no console window; the person can make a shortcut to it.

## First use
- Click **+ Agent**, give it a name (for example "Assistant"). That creates its folder. Select it and chat: it is a real `claude` session in that folder.
- Put the agent's standing instructions in a `CLAUDE.md` file inside its folder. Claude Code reads it every session.
- Closing the window does not stop the agents; they run in the background. Reopen the app to see them again.
- Only one Agent Desktop window runs at a time per PC (a second launch focuses the first).
- Deleting an agent shows a 30 second countdown on purpose (Windows can keep the folder locked for a few seconds after an agent stops).

## Things worth knowing
- **Updating is ONE click, inside the app:** when a new version exists, a button appears in the sidebar (and a "New version ... ready - click to update" line above the version). Click it ("Update & restart"); the app pulls the new version, installs any components it needs by itself, and restarts when your agents are idle. If something cannot be installed the update is undone and the app says why - nothing is left half-updated. Do NOT run `git pull` / `npm install` by hand for a normal update. Last resort only, if the app cannot start at all: `cd` to the repo, `git pull`, `npm install`, then start the app. (A change of the Electron or node-pty version is the one thing the app cannot install for you; it says so and you do a full reinstall.) Check the version in the sidebar footer afterwards.
- **"File not found" or "is not recognized" when starting an agent:** `claude` is not on the PATH. Open a new terminal, run `claude --version`; if it fails, reinstall Claude Code. The README has a longer section on this.
- **Windows Defender "Controlled Folder Access"** can block writes in Documents or Desktop. Keep the workspace in a normal folder such as `C:\Projects`, or allow Node/Electron in Defender. The README explains how.
- **Cloud-synced folders** (Dropbox, OneDrive) can briefly lock files; the app retries, but a workspace outside sync is more reliable.
- The app asks for no password and sends nothing to any server of its own. Everything goes through the person's own Claude Code.

## Reporting a bug (do this for the person)
When something misbehaves, do NOT guess at fixes in the code. Make a report the maintainer can process:
1. Ask the person what went wrong and what they did just before. Ask them to take a screenshot (`Win+Shift+S`, paste into Paint, save as PNG) if it is visual.
2. From the `agent-desktop` folder run:
   ```powershell
   node tools/bug-report.js --what "short description" --steps "what I did before" --shot "C:\path\to\screenshot.png"
   ```
   (`--shot` can be repeated.) It writes a folder `bug-report-<date>-<time>` and a `.zip` of it next to the app. The report holds only: app version, Windows/Node/Claude Code versions, two small status files, the description and the screenshots. No conversations, no agent folders, no credentials; the Windows user name is replaced with `<user>`.
3. Open `report.md` and show the person what is inside, so they know what they are sending.
4. They send the `.zip` to whoever maintains their copy of Agent Desktop (the person who gave them this file). That person gives it to their own agent, which finds the cause and releases a fixed version; then they update from inside the app (see "Updating").
