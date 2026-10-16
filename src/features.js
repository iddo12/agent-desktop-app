"use strict";
// Feature registry (v1.121.0). Declares every optional feature of Agent Desktop: which settings it needs, how to detect them
// on this computer, the setup steps the Setup panel runs, and the plain-language help for the person and for an agent.
// State (ready / needs-setup / off) is COMPUTED by appConfig.feature(id), never stored.
//
// wired:false = the feature's own code does not consult appConfig yet, so it behaves exactly as before and the Setup panel
// says "works as before". Whoever converts a feature sets wired:true.
//
// Step kinds: folder | file | text | choice | toggle.  create:true = the app may create the folder for the person (inside the workspace).
// suggest(cfg) returns a string (path or text) or null; it only looks, it never writes.

const path = require("path");

// one launchEnv per configuration (its lookups are remembered for 5 minutes, so asking again does not start a process again)
const launchEnvs = new WeakMap();
function launchEnvFor(cfg) {
  let le = launchEnvs.get(cfg);
  if (!le) { le = require("./launchEnv").createLaunchEnv({ cfg }); launchEnvs.set(cfg, le); }
  return le;
}

const CORE = {
  key: "workspaceRoot", kind: "folder", create: true, label: "Workspace folder",
  help: "One folder where Agent Desktop keeps shared reports and tools. Pick an existing folder or accept the suggestion and it will be created.",
  suggest: (cfg) => cfg.get("workspaceRoot") || cfg.suggestWorkspace(),
};
const step = (key, kind, label, help, extra) => Object.assign({ key, kind, label, help, create: false, suggest: (cfg) => cfg.get(key) }, extra || {});

const FEATURES = [
  {
    id: "workspace", group: "core", hidden: true, title: "Workspace folder", tileId: null, wired: false, requires: ["workspaceRoot"],
    steps: [CORE],
    help: "The one folder where Agent Desktop keeps shared reports and tools.",
    agentHelp: "workspaceRoot = the folder that holds shared_reports and shared_tools (a new empty folder is fine).",
  },
  {
    id: "argus", group: "daily", title: "ARGUS (the Bridge)", tileId: "argus", wired: true, requires: ["workspaceRoot", "sharedReports"],
    steps: [CORE, step("sharedReports", "folder", "Shared reports folder", "Where your agents write their status files.", { create: true }), step("argusBuilder", "file", "Status builder (build_status.py)", "Optional: the script that gathers every agent's status into one set of files. Without it ARGUS only shows what is already there.", { optional: true }), step("roleCoo", "text", "Your lead agent (folder name)", "The agent that coordinates the others, for example the folder name under your agents folder. Gives ARGUS its brief and Discuss buttons. Leave empty if you have none.", { optional: true }), step("roleSecurity", "text", "Your security agent (folder name)", "Optional. Adds the security score and a Discuss button.", { optional: true }), step("roleOptimization", "text", "Your maintenance agent (folder name)", "Optional. Adds the maintenance score and a Discuss button. A * at the end matches the start of the name.", { optional: true }), step("roleSeo", "text", "Your SEO agent (folder name)", "Optional. Adds the SEO score.", { optional: true }), step("argusJobPrefixes", "text", "Scheduled-job prefixes per role", "Optional, for example SEC_=security;OPT_=optimization;COO_=coo. Tells ARGUS which agent owns a scheduled job.", { optional: true }), step("argusShortNames", "text", "Short names for agents", "Optional, for example Some Long Folder*=Short. Only changes how a name is shown.", { optional: true })],
    help: "ARGUS shows what your agents are doing. It reads the status and report files they write into the shared reports folder.",
    agentHelp: "Set workspaceRoot to the folder that holds the agent folders' shared files; sharedReports defaults to <workspaceRoot>/shared_reports. Agents write status JSON there. argusBuilder (optional) = the script that refreshes it, default <sharedTools>/bridge/build_status.py. Roles (all optional text, exact agent folder name, a trailing * = starts with): roleCoo, roleSecurity, roleOptimization, roleSeo; unset = that role's score tile and Discuss buttons are simply not shown, the rest of ARGUS works. argusJobPrefixes = \"PREFIX=role;PREFIX=role\" (roles coo, security, optimization, seo) so scheduled jobs are matched to an agent; argusShortNames = \"Folder name=Short name;...\" (display only).",
  },
  {
    id: "memory", group: "daily", title: "Memory", tileId: "memory", wired: true, requires: ["agentsRoot", "memoryStatsFile"],
    steps: [step("agentsRoot", "folder", "Agents folder", "The folder that contains one sub-folder per agent."), step("memoryStatsFile", "file", "Memory statistics file (memory_stats.json)", "A file that something on this computer keeps up to date with the size of each agent's memory."), step("memoryBaselineFile", "file", "Starting-context baseline (baseline_context.json)", "Optional: adds the tokens each agent starts with.", { optional: true })],
    help: "Shows how full each agent's memory is. It needs to know the folder that contains your agents.",
    agentHelp: "agentsRoot = the folder whose sub-folders are agent folders (same as AGENT_DESKTOP_ROOT). memoryStatsFile = JSON { generated, agents: [ { agent: <memory key>, l1_bytes, l2_bytes, l3_bytes, l3_files, l1_cap } ] } written by whatever measures agent memory; memoryBaselineFile (optional) = { at, agents: { <name>: { medianFirstTurnTokens } }, history: [] }. memoryKeyPrefix (auto from agentsRoot) is how Claude Code names an agent's memory folder.",
  },
  {
    id: "myDaily", group: "daily", title: "My Daily", tileId: "daily", wired: true, requires: [],
    steps: [
      step("ownerName", "text", "Your name", "Shown in your calendar and in the messages sent to your agents.", { optional: true }),
      step("partnerName", "text", "Partner's name (optional)", "Only if you share a calendar or shopping list with someone. Without a name nothing is shared and the sharing buttons are hidden.", { optional: true }),
      step("pythonExe", "file", "Python (for the task list)", "The python program that runs the task tool. Optional: without it My Daily works, but the task list is off.", { optional: true }),
      step("tasksTool", "file", "Task tool (tasks.py)", "The script that keeps each agent's task list. Optional: without it the task list is off.", { optional: true }),
    ],
    help: "Tasks, calendar, shopping, mail and parcels in one place. It keeps its data on this computer and needs no folders. The task list (Tasks and Decisions) needs the shared task folder, Python and the task tool; without them everything else still works.",
    agentHelp: "My Daily needs nothing to start: its data lives in userData/daily (an existing <agentsRoot>/daily folder is still used until userData/daily exists). Optional text keys ownerName and partnerName (without partnerName nothing is shared); the task list needs sharedReports (tasks are read from <sharedReports>/tasks/<agent>.json), pythonExe and tasksTool. Optional \"daily\" block in app-config.json for the rest: { \"dataDir\", \"taskDir\", \"mailFeedFile\", \"mailRulesFile\", \"gmailExportFile\" (absolute paths), \"ownDomains\": [...], \"sharePartnerDefault\": true, \"ownerPronouns\"/\"partnerPronouns\": \"he\"|\"she\"|\"they\" }.",
  },
  {
    id: "myHealth", group: "private", title: "My Health", tileId: "health", wired: true, requires: ["healthParent"],
    steps: [step("healthParent", "folder", "Health folder", "Where your health data is kept. It stays on this computer.", { create: true })],
    help: "Your health records and charts. They stay in a folder on this computer.",
    agentHelp: "healthParent = folder that holds the health vault; defaults to <userData>/health.",
  },
  {
    id: "myFinance", group: "private", title: "My Finance", tileId: "finance", wired: true, requires: ["financeVault"],
    steps: [step("financeVault", "folder", "Finance folder", "Where your ledger and receipts are kept. They stay on this computer.", { create: true })],
    help: "Money in and out, accounts and receipts. Everything stays in one folder on this computer.",
    agentHelp: "financeVault = finance vault folder; defaults to <userData>/finance-vault.",
  },
  {
    id: "pcHealth", group: "computer", title: "PC Health", tileId: null, parent: "argus", wired: true, requires: ["pcHealthScript", "pythonExe"],
    steps: [step("pythonExe", "file", "Python", "The python program used to measure this PC."), step("pcHealthScript", "file", "PC Health collector (pc_health.py)", "The measuring script.")],
    help: "Live PC measurements inside ARGUS. It needs Python and the collector script.",
    agentHelp: "pythonExe (auto-detected from PATH) and pcHealthScript (default <sharedTools>/pc_health/pc_health.py).",
  },
  {
    id: "claudeCode", group: "computer", title: "Claude Code", tileId: null, wired: true, requires: ["claudeExe"],
    // "ready" means launchEnv can really find claude (PATH, the npm folder, the native installer, the Claude Desktop package), not only that PATH has it.
    // main.js replaces this probe with one that also knows the Claude Desktop package folder.
    probe: (cfg) => { try { return !!launchEnvFor(cfg).claude().ok; } catch (e) { return false; } },
    steps: [step("claudeExe", "file", "Claude Code program (claude)", "The claude program that runs your agents. Agent Desktop looks for it by itself; choose it only if it was installed somewhere unusual.")],
    help: "Agent Desktop runs your agents with Claude Code. If it is not installed, agents cannot start. Install it from claude.com/product/claude-code, sign in once, then press Fix.",
    agentHelp: "claudeExe = full path of claude.exe or claude.cmd (auto-detected from PATH, the npm folder and the native installer folder). Install Claude Code first if it is missing; the person signs in themselves. nodeExe, gitExe and pythonExe work the same way and are only needed when the program is not on PATH.",
  },
  {
    id: "claudeIntegration", kind: "consent", group: "advanced", title: "Claude Code integration", tileId: null, wired: true, requires: [],
    steps: [],
    help: "Lets Agent Desktop change two settings in the Claude Code settings file of your Windows account: a status line that feeds the usage figures, and connecting your sessions to your Claude account so you can reach them from your phone. Off until you turn it on.",
    agentHelp: "OFF by default and cannot be turned on by an agent: it edits the person's own Claude Code settings file (a statusLine and remoteControlAtStartup), so it only turns on after the person confirms in Agent Desktop > Setup (a consent record, claudeIntegration.consentAt, is written by the app UI only). Do not set claudeIntegration.enabled yourself; ask the person to press Turn on in Setup.",
  },
  {
    id: "telegram", group: "connections", title: "Telegram tasks", tileId: null, wired: true, requires: ["telegramTasksDir", "telegramBridgeDir", "pythonExe"],
    steps: [
      step("telegramTasksDir", "folder", "Telegram task queue folder", "The folder where the Telegram bridge saves the tasks you dictate while away."),
      step("telegramBridgeDir", "folder", "Telegram bridge folder", "The folder that holds the bridge's tasks.py, used to approve a task."),
      step("pythonExe", "file", "Python", "The python program that runs the bridge's tasks.py."),
    ],
    help: "Shows tasks you sent from your phone through a Telegram bridge, and lets you approve them. Only for people who run such a bridge.",
    agentHelp: "telegramTasksDir = folder of the bridge's task .json files; telegramBridgeDir = folder with its tasks.py; pythonExe auto-detected.",
  },
  {
    id: "tools", group: "daily", title: "Tools", tileId: "tools", wired: true, requires: ["toolsCatalogue"],
    steps: [step("toolsCatalogue", "file", "Tools catalogue (tools.json)", "The list of tools to show.")],
    help: "A catalogue of the tools you built or use, with launch buttons.",
    agentHelp: "toolsCatalogue = tools.json (default <sharedTools>/tools/tools.json); toolsAllowedRoots lists folders launchers may live in; toolsBasketLabel (optional text) = heading of the first group (basket \"acmeco\" in tools.json), default \"Tools\".",
  },
  {
    id: "designs", group: "daily", title: "My Designs", tileId: "designs", wired: true, requires: ["styleLibrary"],
    steps: [step("styleLibrary", "folder", "My Designs library folder", "The folder that holds styles.json and the preview files of your numbered designs.")],
    help: "A numbered gallery of your designs (motion graphics and stills), so you can say \"use my design #12\".",
    agentHelp: "styleLibrary = the folder with styles.json (schema lensvid.style_library: styles[] with id, name, group, type motion|still, kind, tags, preview (relative file: png/jpg/webp/gif/mp4/webm), source, reference, palette, status draft|approved); default <workspaceRoot>/shared_assets/style_library. The page is read only. To let the \"Open source folder\" button work, the design's source folder must be under the workspace folder or one of openPathRoots / outputRoots.",
  },
  {
    id: "library", group: "daily", title: "Library", tileId: "library", wired: true, requires: ["workspaceRoot"],
    steps: [CORE],
    help: "Documents, images and projects your agents made. It looks in the folders under your workspace folder.",
    agentHelp: "workspaceRoot = the folder that holds your agents' work; documentRoots (optional list, default the agents folder) lists the folders scanned for documents. The library does not run any tool, so nothing else is needed.",
  },
  {
    id: "research", group: "daily", title: "My Research", tileId: "research", wired: true, requires: ["sharedReports"],
    steps: [step("sharedReports", "folder", "Shared reports folder", "Where the weekly research files are written.", { create: true })],
    help: "Weekly research picks written by your agents.",
    agentHelp: "Uses sharedReports/research.",
  },
  {
    id: "fleet", group: "connections", title: "Shared fleet", tileId: "fleet", wired: true, requires: ["exchangeDir"],
    steps: [step("exchangeDir", "folder", "Fleet mailbox folder", "A shared folder (for example synced) where two people's agents leave each other notes. Leave this feature off if you have none."), step("fleetLabel", "text", "Name for this link", "What the sidebar calls it. Leave empty for \"Shared fleet\".", { optional: true }), step("ownerName", "text", "Your name", "Used on the notes you send.", { optional: true }), step("partnerName", "text", "Other person's name", "Shown on the conversation.", { optional: true }), step("exchangeInboxName", "text", "Sub-folder for notes to you", "The folder inside the mailbox where the other side leaves notes for you. Leave empty for \"to_me\".", { optional: true }), step("exchangeOutboxName", "text", "Sub-folder for notes from you", "The folder inside the mailbox where your notes for the other side go. Leave empty for \"from_me\".", { optional: true }), step("leadRole", "text", "Role of your lead agent", "The role of the agent that talks to the other side, for example COO. Used in wording only.", { optional: true })],
    help: "A conversation view of the notes exchanged with another person's agents. Off unless you pick a shared mailbox folder.",
    agentHelp: "exchangeDir = shared mailbox folder (not set = the feature needs setup); exchangeInboxName / exchangeOutboxName = the two sub-folders of it (defaults to_me / from_me; the other side must use the same two names mirrored); ownerName, partnerName, fleetLabel, leadRole are wording only.",
  },
  {
    id: "iris", kind: "consent", group: "connections", title: "IRIS", tileId: "iris", wired: true, requires: ["agentsRoot"],
    steps: [step("agentsRoot", "folder", "Agents folder", "The folder that contains one sub-folder per agent."), step("leadRole", "text", "Role of the agent that receives IRIS messages", "Incoming IRIS messages are handed to the agent whose name contains this role (for example COO). Leave empty and they wait until you set it.", { optional: true })],
    help: "A private link between your Agent Desktop and another person's. Pairing is done inside the IRIS panel.",
    agentHelp: "IRIS is OFF by default and cannot be enabled by an agent: it listens on the local network, so it only turns on after the person at the machine confirms in Agent Desktop > Setup (a consent record, iris.consentAt, is written by the app UI only). Do not try to set iris.enabled yourself; ask the person to press Turn on for IRIS in Setup. IRIS data lives in userData/iris; it needs agentsRoot to deliver messages to an agent. leadRole = role word (for example COO) of the agent whose name receives incoming IRIS messages; unset = messages wait.",
  },
  {
    id: "loadGovernor", group: "computer", title: "Load governor", tileId: null, wired: true, requires: [],
    steps: [
      step("governorMaxWorking", "text", "Most agents working at once", "Agents above this number wait for a slot. Default 6.", { optional: true, suggest: () => "6" }),
      step("governorMaxWorkingHeavy", "text", "Most agents working while a heavy app is in front", "Used while one of the heavy apps below is the window in front. Default 3.", { optional: true, suggest: () => "3" }),
      step("governorHeavyApps", "text", "Heavy apps (program names, separated by commas)", "For example: premiere, afterfx, resolve. Default: premiere.", { optional: true, suggest: () => "premiere" }),
    ],
    help: "Keeps the PC responsive: agents start one at a time when the PC is calm, only a limited number work at once, and nudges and starts pause by themselves while the PC lags. On by default; turn it off here.",
    agentHelp: "No setting is required. Optional text values: governorMaxWorking (default 6), governorMaxWorkingHeavy (3), governorHeavyApps (comma-separated program names, default premiere), governorCalmCpuPct (50), governorSlowLagMs (1500). Switch off with features.loadGovernor.enabled=false. Decisions are logged to stuck-turn-watchdog.log with the prefix \"governor:\".",
  },
  {
    id: "keepGoing", group: "advanced", title: "Keep working", tileId: null, wired: true, requires: ["tasksTool", "pythonExe"],
    steps: [step("pythonExe", "file", "Python", "The python program that runs the task tool."), step("tasksTool", "file", "Task tool (tasks.py)", "The script that keeps each agent's task list.")],
    help: "Lets you tell an agent to keep working through its task list. Needs the task tool and Python.",
    agentHelp: "tasksTool = tasks.py (default <sharedTools>/tasks/tasks.py); pythonExe auto-detected.",
  },
  {
    id: "usage", group: "computer", title: "Usage and limits", tileId: null, wired: true, requires: ["usageNowFile"],
    steps: [step("usageNowFile", "file", "Usage file (usage_now.json)", "A file that something on this computer keeps up to date with your plan usage."), step("planTier", "choice", "Your Claude plan", "Used to estimate how much of the 5-hour window is used when Claude does not report it. Leave empty if unsure.", { optional: true })],
    help: "Shows how much of your plan is used. Needs a usage file kept up to date by a usage tracker.",
    agentHelp: "usageNowFile = JSON file with the current usage numbers; planTier (pro|max5x|max20x) is optional.",
  },
  {
    id: "voice", group: "computer", title: "Voice", tileId: null, wired: true, requires: ["whisperExe", "whisperModel"],
    steps: [step("whisperExe", "file", "Speech program (whisper-cli.exe)", "The whisper.cpp program that turns speech into text on this computer. A GPU build is much faster."), step("whisperModel", "file", "Speech model (ggml-*.bin)", "The model file the program uses, for example ggml-large-v3-turbo.bin."), step("whisperModelHe", "file", "Hebrew speech model (optional)", "A Hebrew model, used when a recording is in Hebrew.", { optional: true })],
    help: "Dictation with the microphone button. It needs a speech program and a speech model installed on this computer; until then the button says so instead of recording. (An online speech service set up in the Windows environment also works without these.)",
    agentHelp: "whisperExe = path to whisper-cli.exe (whisper.cpp; whisper-server.exe must sit beside it for the fast warm mode), whisperModel = path to a ggml-*.bin model, whisperModelHe = optional Hebrew ggml model. Nothing is auto-detected. Without them the microphone button shows a needs-setup note. Online fallback: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN in the environment (secrets: never put them in the settings file). PHEME/Stream Deck delivery needs no setting here.",
  },
];

const byId = new Map(FEATURES.map((f) => [f.id, f]));
const list = (all) => FEATURES.filter((f) => all || !f.hidden);
const get = (id) => byId.get(id) || null;
const KNOWN_STEP_KINDS = ["folder", "file", "text", "choice", "toggle"];

// What detect() finds on this computer: for every key the feature needs, a suggested value that exists.
function detect(cfg, id) {
  const f = get(id); const found = {};
  if (!f) return { ok: false, found };
  for (const s of f.steps) {
    let sug = null; try { sug = s.suggest ? s.suggest(cfg) : null; } catch (e) { sug = null; }
    if (sug && (s.kind === "text" || cfg.usable(s.key) || (s.kind === "folder" && s.suggestExists))) found[s.key] = sug;
  }
  return { ok: f.requires.every((k) => cfg.usable(k)), found };
}

// suggestions[] for the Setup panel: for each folder/file step, the choices to offer (already-existing first, tagged "detected";
// otherwise a "new" folder the app would create). Paths come from main only; the renderer just shows them.
function suggestions(cfg, id) {
  const f = get(id); const out = [];
  if (!f) return out;
  for (const s of f.steps) {
    if (s.kind !== "folder" && s.kind !== "file") continue;
    const seen = new Set();
    const add = (p, tag) => { if (typeof p === "string" && p && !seen.has(p)) { seen.add(p); out.push({ key: s.key, path: p, exists: cfg.usable ? existsAs(cfg, s, p) : false, tag }); } };
    const cur = cfg.get(s.key);
    if (cur && cfg.usable(s.key)) add(cur, "detected");
    let sug = null; try { sug = s.suggest ? s.suggest(cfg) : null; } catch (e) { sug = null; }
    add(sug, sug && cfg.usable(s.key) ? "detected" : "new");
  }
  return out;
}
function existsAs(cfg, s, p) { try { const st = require("fs").statSync(p); return s.kind === "folder" ? st.isDirectory() : st.isFile(); } catch (e) { return false; } }

// The text copied by "Copy setup instructions for Claude" and written to SETUP.md. Same function for both so they never drift.
function agentInstructions(cfg, opts) {
  const o = opts || {};
  const cfgPath = o.generic ? "<userData>/app-config.json  (userData = the Agent Desktop data folder: %APPDATA%/agent-desktop on Windows)" : (cfg && cfg.configPath && cfg.configPath()) || "<userData>/app-config.json";
  const keys = Object.keys(require("./appConfig").KEYS);
  const K = require("./appConfig").KEYS;
  const L = [];
  L.push("# Agent Desktop setup instructions (for an agent)");
  L.push("");
  L.push("Goal: make Agent Desktop work on this computer by writing its one configuration file. Do not edit source code; nothing in the app is tied to a particular person's folders.");
  L.push("");
  L.push("Config file: " + cfgPath);
  L.push("Format (schema 1): { \"schema\": 1, \"values\": { \"<key>\": \"<absolute path>\" }, \"features\": { \"<featureId>\": { \"enabled\": true } } }");
  L.push("Resolution order for each key: environment variable AGENT_DESKTOP_<KEY_IN_SNAKE_CASE> (for example AGENT_DESKTOP_WORKSPACE_ROOT) > this file > auto-detect > not set. A feature whose keys are missing stays off and says what it needs.");
  L.push("Paths must be absolute, without \"..\". Folders must exist (create them first). Lists (outputRoots, documentRoots, openPathRoots, toolsAllowedRoots) are JSON arrays.");
  L.push("Program keys (pythonExe, claudeExe, nodeExe, gitExe, whisperExe) must end in .exe, .cmd or .bat on Windows; script keys (tasksTool, pcHealthScript, argusBuilder, registryTool) must end in .py. Network (UNC \\\\server\\share) and device paths (\\\\?\\, \\\\.\\) are refused for them, in the file and in the environment. Role keys (roleCoo, roleSecurity, roleOptimization, roleSeo; a trailing * only there) and exchangeInboxName / exchangeOutboxName are ONE folder name: no \\, /, :, .. or drive letter. A value that does not pass is ignored, as if it were not set.");
  L.push("Consent (iris, claudeIntegration): these two sections are an honour-system record. The app only acts on a section that has enabled:true AND a consentAt time; whoever can edit app-config.json can write one, so the record states that the person agreed, it cannot prove it. An agent must never write one: ask the person to press Turn on in Setup. an install that already had IRIS paired, or our status line in the Claude Code settings, is recognised once at the first start.");
  L.push("Easiest route: open Agent Desktop > Setup and press the button of each feature; or write the file by hand and restart the app.");
  L.push("");
  L.push("## Keys");
  for (const k of keys) {
    const d = K[k];
    L.push("- " + k + " (" + d.kind + (d.choices ? ": " + d.choices.join("|") : "") + "): " + d.label + "  [env " + require("./appConfig").envName(k) + "]");
  }
  L.push("");
  L.push("## Features");
  for (const f of FEATURES) {
    L.push("### " + f.id + " - " + f.title + (f.wired ? "" : "  (works as before in this version; its settings are recorded for the next one)"));
    L.push("Needs: " + (f.requires.length ? f.requires.join(", ") : "nothing"));
    L.push(f.agentHelp);
    L.push("");
  }
  L.push("## Rules for whoever converts a feature");
  L.push("Every hard-coded value you replace with cfg.get/cfg.path must keep the previous behaviour as its default, so an existing install behaves identically. Until a feature is converted (wired:false) its code is not touched.");
  return L.join("\n") + "\n";
}

// Instructions for ONE feature ("Copy for Claude" in a row's help drawer).
function agentInstructionsFor(cfg, id) {
  const f = get(id);
  if (!f) return "";
  const K = require("./appConfig");
  const where = (cfg && cfg.configPath && cfg.configPath()) || "<userData>/app-config.json";
  return [
    "Agent Desktop setup, feature \"" + f.id + "\" (" + f.title + ")",
    "Config file: " + where,
    "Format: { \"schema\": 1, \"values\": { \"<key>\": \"<absolute path>\" }, \"features\": { \"" + f.id + "\": { \"enabled\": true } } }",
    "Needs: " + (f.requires.length ? f.requires.map((k) => k + " (env " + K.envName(k) + ")").join(", ") : "nothing"),
    f.agentHelp, "",
  ].join("\n");
}

module.exports = { agentInstructionsFor, list, get, detect, suggestions, agentInstructions, FEATURES, KNOWN_STEP_KINDS };
