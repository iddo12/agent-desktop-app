# Agent Desktop setup instructions (for an agent)

Goal: make Agent Desktop work on this computer by writing its one configuration file. Do not edit source code; nothing in the app is tied to a particular person's folders.

Config file: <userData>/app-config.json  (userData = the Agent Desktop data folder: %APPDATA%/agent-desktop on Windows)
Format (schema 1): { "schema": 1, "values": { "<key>": "<absolute path>" }, "features": { "<featureId>": { "enabled": true } } }
Resolution order for each key: environment variable AGENT_DESKTOP_<KEY_IN_SNAKE_CASE> (for example AGENT_DESKTOP_WORKSPACE_ROOT) > this file > auto-detect > not set. A feature whose keys are missing stays off and says what it needs.
Paths must be absolute, without "..". Folders must exist (create them first). Lists (outputRoots, documentRoots, openPathRoots, toolsAllowedRoots) are JSON arrays.
Program keys (pythonExe, claudeExe, nodeExe, gitExe, whisperExe) must end in .exe, .cmd or .bat on Windows; script keys (tasksTool, pcHealthScript, argusBuilder, registryTool) must end in .py. Network (UNC \\server\share) and device paths (\\?\, \\.\) are refused for them, in the file and in the environment. Role keys (roleCoo, roleSecurity, roleOptimization, roleSeo; a trailing * only there) and exchangeInboxName / exchangeOutboxName are ONE folder name: no \, /, :, .. or drive letter. A value that does not pass is ignored, as if it were not set.
Consent (iris, claudeIntegration): these two sections are an honour-system record. The app only acts on a section that has enabled:true AND a consentAt time; whoever can edit app-config.json can write one, so the record states that the person agreed, it cannot prove it. An agent must never write one: ask the person to press Turn on in Setup. an install that already had IRIS paired, or our status line in the Claude Code settings, is recognised once at the first start.
Easiest route: open Agent Desktop > Setup and press the button of each feature; or write the file by hand and restart the app.

## Keys
- workspaceRoot (folder): Workspace folder  [env AGENT_DESKTOP_WORKSPACE_ROOT]
- agentsRoot (folder): Agents folder  [env AGENT_DESKTOP_AGENTS_ROOT]
- sharedReports (folder): Shared reports folder  [env AGENT_DESKTOP_SHARED_REPORTS]
- sharedTools (folder): Shared tools folder  [env AGENT_DESKTOP_SHARED_TOOLS]
- tasksDir (folder): Tasks folder  [env AGENT_DESKTOP_TASKS_DIR]
- workDir (folder): Big and throwaway files folder  [env AGENT_DESKTOP_WORK_DIR]
- exchangeDir (folder): Fleet mailbox (Exchange) folder  [env AGENT_DESKTOP_EXCHANGE_DIR]
- usageNowFile (file): Usage file (usage_now.json)  [env AGENT_DESKTOP_USAGE_NOW_FILE]
- tasksTool (file): tasks.py  [env AGENT_DESKTOP_TASKS_TOOL]
- registryTool (file): registry.py  [env AGENT_DESKTOP_REGISTRY_TOOL]
- pcHealthScript (file): pc_health.py  [env AGENT_DESKTOP_PC_HEALTH_SCRIPT]
- toolsCatalogue (file): Tools catalogue (tools.json)  [env AGENT_DESKTOP_TOOLS_CATALOGUE]
- styleLibrary (folder): My Designs library folder (holds styles.json)  [env AGENT_DESKTOP_STYLE_LIBRARY]
- toolsBasketLabel (text): Tools: heading of the first group of tools (the one your catalogue marks with basket "acmeco")  [env AGENT_DESKTOP_TOOLS_BASKET_LABEL]
- financeVault (folder): Finance folder  [env AGENT_DESKTOP_FINANCE_VAULT]
- healthParent (folder): Health folder  [env AGENT_DESKTOP_HEALTH_PARENT]
- telegramTasksDir (folder): Telegram task queue folder  [env AGENT_DESKTOP_TELEGRAM_TASKS_DIR]
- telegramBridgeDir (folder): Telegram bridge folder (holds tasks.py)  [env AGENT_DESKTOP_TELEGRAM_BRIDGE_DIR]
- updateRepo (text): Where updates come from (owner/repository)  [env AGENT_DESKTOP_UPDATE_REPO]
- updateChannel (text): Update channel (branch)  [env AGENT_DESKTOP_UPDATE_CHANNEL]
- outputRoots (folders): Folders where agents write big outputs  [env AGENT_DESKTOP_OUTPUT_ROOTS]
- documentRoots (folders): Folders scanned for agent documents  [env AGENT_DESKTOP_DOCUMENT_ROOTS]
- openPathRoots (folders): Folders whose files can be opened from chat  [env AGENT_DESKTOP_OPEN_PATH_ROOTS]
- toolsAllowedRoots (folders): Folders tool launchers may live in  [env AGENT_DESKTOP_TOOLS_ALLOWED_ROOTS]
- memoryKeyPrefix (text): Memory folder key prefix  [env AGENT_DESKTOP_MEMORY_KEY_PREFIX]
- pythonExe (file): Python  [env AGENT_DESKTOP_PYTHON_EXE]
- nodeExe (file): Node.js  [env AGENT_DESKTOP_NODE_EXE]
- gitExe (file): Git  [env AGENT_DESKTOP_GIT_EXE]
- claudeExe (file): Claude Code (claude)  [env AGENT_DESKTOP_CLAUDE_EXE]
- fleetLabel (text): Name of the fleet link in the sidebar  [env AGENT_DESKTOP_FLEET_LABEL]
- exchangeInboxName (text): Mailbox sub-folder for notes TO you  [env AGENT_DESKTOP_EXCHANGE_INBOX_NAME]
- exchangeOutboxName (text): Mailbox sub-folder for notes FROM you  [env AGENT_DESKTOP_EXCHANGE_OUTBOX_NAME]
- leadRole (text): Role name of the agent that talks to the other side (for example COO)  [env AGENT_DESKTOP_LEAD_ROLE]
- ownerName (text): Your name  [env AGENT_DESKTOP_OWNER_NAME]
- partnerName (text): Partner's name (for the fleet and shared calendar)  [env AGENT_DESKTOP_PARTNER_NAME]
- memoryStatsFile (file): Memory statistics file (memory_stats.json)  [env AGENT_DESKTOP_MEMORY_STATS_FILE]
- memoryBaselineFile (file): Starting-context baseline file (baseline_context.json)  [env AGENT_DESKTOP_MEMORY_BASELINE_FILE]
- argusBuilder (file): ARGUS status builder (build_status.py)  [env AGENT_DESKTOP_ARGUS_BUILDER]
- roleCoo (text): Folder name of your lead / coordinating agent  [env AGENT_DESKTOP_ROLE_COO]
- roleSecurity (text): Folder name of your security agent  [env AGENT_DESKTOP_ROLE_SECURITY]
- roleOptimization (text): Folder name of your maintenance / optimization agent (a trailing * matches the start)  [env AGENT_DESKTOP_ROLE_OPTIMIZATION]
- roleSeo (text): Folder name of your SEO agent  [env AGENT_DESKTOP_ROLE_SEO]
- argusJobPrefixes (text): ARGUS: scheduled-job prefixes per role (for example SEC_=security;OPT_=optimization)  [env AGENT_DESKTOP_ARGUS_JOB_PREFIXES]
- argusShortNames (text): ARGUS: short names for agent folders (for example Some Folder=Short)  [env AGENT_DESKTOP_ARGUS_SHORT_NAMES]
- governorMaxWorking (text): Load governor: most agents working at once (default 6)  [env AGENT_DESKTOP_GOVERNOR_MAX_WORKING]
- governorMaxWorkingHeavy (text): Load governor: most agents working while a heavy app is in front (default 3)  [env AGENT_DESKTOP_GOVERNOR_MAX_WORKING_HEAVY]
- governorHeavyApps (text): Load governor: heavy apps, program names separated by commas (default premiere)  [env AGENT_DESKTOP_GOVERNOR_HEAVY_APPS]
- governorCalmCpuPct (text): Load governor: CPU percent below which the PC counts as calm (default 50)  [env AGENT_DESKTOP_GOVERNOR_CALM_CPU_PCT]
- governorSlowLagMs (text): Load governor: system lag in milliseconds that triggers the slow-down (default 1500)  [env AGENT_DESKTOP_GOVERNOR_SLOW_LAG_MS]
- planTier (choice: pro|max5x|max20x): Claude plan  [env AGENT_DESKTOP_PLAN_TIER]
- whisperExe (file): Speech program (whisper-cli)  [env AGENT_DESKTOP_WHISPER_EXE]
- whisperModel (file): Speech model (ggml .bin)  [env AGENT_DESKTOP_WHISPER_MODEL]
- whisperModelHe (file): Hebrew speech model (optional)  [env AGENT_DESKTOP_WHISPER_MODEL_HE]

## Features
### workspace - Workspace folder  (works as before in this version; its settings are recorded for the next one)
Needs: workspaceRoot
workspaceRoot = the folder that holds shared_reports and shared_tools (a new empty folder is fine).

### argus - ARGUS (the Bridge)
Needs: workspaceRoot, sharedReports
Set workspaceRoot to the folder that holds the agent folders' shared files; sharedReports defaults to <workspaceRoot>/shared_reports. Agents write status JSON there. argusBuilder (optional) = the script that refreshes it, default <sharedTools>/bridge/build_status.py. Roles (all optional text, exact agent folder name, a trailing * = starts with): roleCoo, roleSecurity, roleOptimization, roleSeo; unset = that role's score tile and Discuss buttons are simply not shown, the rest of ARGUS works. argusJobPrefixes = "PREFIX=role;PREFIX=role" (roles coo, security, optimization, seo) so scheduled jobs are matched to an agent; argusShortNames = "Folder name=Short name;..." (display only).

### memory - Memory
Needs: agentsRoot, memoryStatsFile
agentsRoot = the folder whose sub-folders are agent folders (same as AGENT_DESKTOP_ROOT). memoryStatsFile = JSON { generated, agents: [ { agent: <memory key>, l1_bytes, l2_bytes, l3_bytes, l3_files, l1_cap } ] } written by whatever measures agent memory; memoryBaselineFile (optional) = { at, agents: { <name>: { medianFirstTurnTokens } }, history: [] }. memoryKeyPrefix (auto from agentsRoot) is how Claude Code names an agent's memory folder.

### myDaily - My Daily
Needs: nothing
My Daily needs nothing to start: its data lives in userData/daily (an existing <agentsRoot>/daily folder is still used until userData/daily exists). Optional text keys ownerName and partnerName (without partnerName nothing is shared); the task list needs sharedReports (tasks are read from <sharedReports>/tasks/<agent>.json), pythonExe and tasksTool. Optional "daily" block in app-config.json for the rest: { "dataDir", "taskDir", "mailFeedFile", "mailRulesFile", "gmailExportFile" (absolute paths), "ownDomains": [...], "sharePartnerDefault": true, "ownerPronouns"/"partnerPronouns": "he"|"she"|"they" }.

### myHealth - My Health
Needs: healthParent
healthParent = folder that holds the health vault; defaults to <userData>/health.

### myFinance - My Finance
Needs: financeVault
financeVault = finance vault folder; defaults to <userData>/finance-vault.

### pcHealth - PC Health
Needs: pcHealthScript, pythonExe
pythonExe (auto-detected from PATH) and pcHealthScript (default <sharedTools>/pc_health/pc_health.py).

### claudeCode - Claude Code
Needs: claudeExe
claudeExe = full path of claude.exe or claude.cmd (auto-detected from PATH, the npm folder and the native installer folder). Install Claude Code first if it is missing; the person signs in themselves. nodeExe, gitExe and pythonExe work the same way and are only needed when the program is not on PATH.

### claudeIntegration - Claude Code integration
Needs: nothing
OFF by default and cannot be turned on by an agent: it edits the person's own Claude Code settings file (a statusLine and remoteControlAtStartup), so it only turns on after the person confirms in Agent Desktop > Setup (a consent record, claudeIntegration.consentAt, is written by the app UI only). Do not set claudeIntegration.enabled yourself; ask the person to press Turn on in Setup.

### telegram - Telegram tasks
Needs: telegramTasksDir, telegramBridgeDir, pythonExe
telegramTasksDir = folder of the bridge's task .json files; telegramBridgeDir = folder with its tasks.py; pythonExe auto-detected.

### tools - Tools
Needs: toolsCatalogue
toolsCatalogue = tools.json (default <sharedTools>/tools/tools.json); toolsAllowedRoots lists folders launchers may live in; toolsBasketLabel (optional text) = heading of the first group (basket "acmeco" in tools.json), default "Tools".

### designs - My Designs
Needs: styleLibrary
styleLibrary = the folder with styles.json (schema lensvid.style_library: styles[] with id, name, group, type motion|still, kind, tags, preview (relative file: png/jpg/webp/gif/mp4/webm), source, reference, palette, status draft|approved); default <workspaceRoot>/shared_assets/style_library. The page is read only. To let the "Open source folder" button work, the design's source folder must be under the workspace folder or one of openPathRoots / outputRoots.

### library - Library
Needs: workspaceRoot
workspaceRoot = the folder that holds your agents' work; documentRoots (optional list, default the agents folder) lists the folders scanned for documents. The library does not run any tool, so nothing else is needed.

### research - My Research
Needs: sharedReports
Uses sharedReports/research.

### fleet - Shared fleet
Needs: exchangeDir
exchangeDir = shared mailbox folder (not set = the feature needs setup); exchangeInboxName / exchangeOutboxName = the two sub-folders of it (defaults to_me / from_me; the other side must use the same two names mirrored); ownerName, partnerName, fleetLabel, leadRole are wording only.

### iris - IRIS
Needs: agentsRoot
IRIS is OFF by default and cannot be enabled by an agent: it listens on the local network, so it only turns on after the person at the machine confirms in Agent Desktop > Setup (a consent record, iris.consentAt, is written by the app UI only). Do not try to set iris.enabled yourself; ask the person to press Turn on for IRIS in Setup. IRIS data lives in userData/iris; it needs agentsRoot to deliver messages to an agent. leadRole = role word (for example COO) of the agent whose name receives incoming IRIS messages; unset = messages wait.

### loadGovernor - Load governor
Needs: nothing
No setting is required. Optional text values: governorMaxWorking (default 6), governorMaxWorkingHeavy (3), governorHeavyApps (comma-separated program names, default premiere), governorCalmCpuPct (50), governorSlowLagMs (1500). Switch off with features.loadGovernor.enabled=false. Decisions are logged to stuck-turn-watchdog.log with the prefix "governor:".

### keepGoing - Keep working
Needs: tasksTool, pythonExe
tasksTool = tasks.py (default <sharedTools>/tasks/tasks.py); pythonExe auto-detected.

### usage - Usage and limits
Needs: usageNowFile
usageNowFile = JSON file with the current usage numbers; planTier (pro|max5x|max20x) is optional.

### voice - Voice
Needs: whisperExe, whisperModel
whisperExe = path to whisper-cli.exe (whisper.cpp; whisper-server.exe must sit beside it for the fast warm mode), whisperModel = path to a ggml-*.bin model, whisperModelHe = optional Hebrew ggml model. Nothing is auto-detected. Without them the microphone button shows a needs-setup note. Online fallback: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN in the environment (secrets: never put them in the settings file). PHEME/Stream Deck delivery needs no setting here.

## Rules for whoever converts a feature
Every hard-coded value you replace with cfg.get/cfg.path must keep the previous behaviour as its default, so an existing install behaves identically. Until a feature is converted (wired:false) its code is not touched.
