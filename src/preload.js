const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  listAgents: () => ipcRenderer.invoke("list-agents"),
  setAgentPaused: (agentPath, paused) => ipcRenderer.invoke("set-agent-paused", { agentPath, paused }),
  listGroups: () => ipcRenderer.invoke("list-groups"),
  saveGroups: (doc) => ipcRenderer.invoke("save-groups", { doc }),
  // Dropped File objects don't carry their real filesystem path directly in a
  // contextIsolation:true renderer - webUtils.getPathForFile is the modern
  // (Electron 32+) replacement for the old File.path, only callable from the
  // preload/main side.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  savePastedImage: (base64, ext) => ipcRenderer.invoke("save-pasted-image", { base64, ext }),
  saveLongMessage: (text) => ipcRenderer.invoke("save-long-message", { text }),
  readLongMessage: (filePath) => ipcRenderer.invoke("read-long-message", { filePath }),
  createAgent: (payload) => ipcRenderer.invoke("create-agent", payload),
  updateAgent: (payload) => ipcRenderer.invoke("update-agent", payload),
  readInstructions: (agentPath) => ipcRenderer.invoke("read-instructions", { agentPath }),
  writeInstructions: (payload) => ipcRenderer.invoke("write-instructions", payload),
  deleteAgent: (agentPath) => ipcRenderer.invoke("delete-agent", { agentPath }),
  pickAvatar: () => ipcRenderer.invoke("pick-avatar"),

  startTerminal: (agentPath, cols, rows, knownAgentId) => ipcRenderer.invoke("start-terminal", { agentPath, cols, rows, knownAgentId }),
  transcribeAudio: (wavBase64, file) => ipcRenderer.invoke("voice-transcribe", { wavBase64, file }),
  voiceEngine: () => ipcRenderer.invoke("voice-engine"),
  voiceWarm: () => ipcRenderer.invoke("voice-warm"),
  voiceSave: (wavBase64) => ipcRenderer.invoke("voice-save", { wavBase64 }),
  logGuard: (line) => ipcRenderer.send("guard-log", { line }),
  sendInput: (agentPath, data, opts) => ipcRenderer.send("terminal-input", { agentPath, data, app: !!(opts && opts.app) }),
  onPhemeRequest: (callback) => { ipcRenderer.on("pheme-request", (event, payload) => callback(payload)); }, // v1.77.4 PHEME delivery
  phemeReply: (id, result) => ipcRenderer.send("pheme-reply", { id, result }),
  onVoiceInbox: (callback) => { ipcRenderer.on("voice-inbox-request", (event, payload) => callback(payload)); }, // v1.113.0 voice inbox (dictation addressed to one agent)
  voiceInboxReply: (id, result) => ipcRenderer.send("voice-inbox-reply", { id, result }),
  activeAgentChanged: (sel) => ipcRenderer.send("active-agent-changed", sel),
  onWakeRequest: (callback) => { ipcRenderer.on("wake-request", (event, payload) => callback(payload)); }, // v1.96.0 wake-agent
  wakeReply: (id, result) => ipcRenderer.send("wake-reply", { id, result }),
  onPressEnter: (callback) => { ipcRenderer.on("press-enter", (event, payload) => callback(payload)); },
  terminalBlankCheck: (agentPath, blank) => ipcRenderer.invoke("terminal-blank-check", { agentPath, blank: !!blank }), // v1.69.4
  canSendCtrlC: (agentPath, snippet) => ipcRenderer.invoke("can-send-ctrlc", { agentPath, text: snippet }), // v1.69.4
  onSendKeys: (callback) => { ipcRenderer.on("send-keys", (event, payload) => callback(payload)); }, // v1.69.4 recovery ladder
  resizeTerminal: (agentPath, cols, rows) => ipcRenderer.send("terminal-resize", { agentPath, cols, rows }),

  listArchivedDays: (agentPath) => ipcRenderer.invoke("list-archived-days", { agentPath }),
  readArchivedDay: (agentPath, dateKey) => ipcRenderer.invoke("read-archived-day", { agentPath, dateKey }),

  listConversations: (agentPath) => ipcRenderer.invoke("list-conversations", { agentPath }),
  renameConversation: (agentPath, sessionId, title) => ipcRenderer.invoke("rename-conversation", { agentPath, sessionId, title }),
  switchConversation: (agentPath, opts) => ipcRenderer.invoke("switch-conversation", { agentPath, ...opts }),
  getContextUsage: (agentPath) => ipcRenderer.invoke("get-context-usage", { agentPath }),
  getUsageWindows: () => ipcRenderer.invoke("get-usage-windows"),
  getInferredPlanId: () => ipcRenderer.invoke("get-inferred-plan-id"),
  notifySendFailed: (agentPath, text, info) => ipcRenderer.invoke("notify-send-failed", { agentPath, text, info }),
  clearStaleInput: (agentPath, text) => ipcRenderer.invoke("clear-stale-input", { agentPath, text }),
  listOpenQuestions: () => ipcRenderer.invoke("list-open-questions"),
  resolveOpenQuestion: (id) => ipcRenderer.invoke("resolve-open-question", id),
  fleet: {
    settings: () => ipcRenderer.invoke("fleet-settings"), // v1.121.0: state + wording (names, label, role); never a path
    list: (lastSeen, force) => ipcRenderer.invoke("fleet-list", { lastSeen, force }),
    read: (id) => ipcRenderer.invoke("fleet-read", id),
    timeline: (lastSeen, force) => ipcRenderer.invoke("fleet-timeline", { lastSeen, force }),
    reply: (recipient, topic, text) => ipcRenderer.invoke("fleet-reply", { recipient, topic, text }),
  },
  getLiveTranscript: (agentPath, ifChanged, peek) => ipcRenderer.invoke("get-live-transcript", { agentPath, ifChanged: !!ifChanged, peek: !!peek }), // v1.115.0: peek = last 14 blocks, never touches the chat view's "unchanged" bookkeeping
  perfLog: (lines) => ipcRenderer.send("perf-log", { lines }),
  getSessionActivity: (agentPath) => ipcRenderer.invoke("get-session-activity", { agentPath }),
  agentInputHoldsText: (agentPath, snippet) => ipcRenderer.invoke("agent-input-holds-text", { agentPath, snippet }),
  agentDialogOpen: (agentPath) => ipcRenderer.invoke("agent-dialog-open", { agentPath }),
  approvalPending: (agentPath) => ipcRenderer.invoke("approval-pending-get", { agentPath }),
  approvalAnswer: (agentPath, answer, since) => ipcRenderer.invoke("approval-answer", { agentPath, answer, since }),
  getTranscriptQuietMs: (agentPath) => ipcRenderer.invoke("get-transcript-quiet-ms", { agentPath }),
  getAgentOverview: () => ipcRenderer.invoke("get-agent-overview"),
  registryList: () => ipcRenderer.invoke("registry-list"),
  libraryReady: () => ipcRenderer.invoke("library-ready"), // v1.121.0: { ready } - false shows the needs-setup card
  argusData: (opts) => ipcRenderer.invoke("argus-data", opts),
  argusDecisionCount: () => ipcRenderer.invoke("argus-decision-count"),
  // v1.111.0 PC health panel: the collector runs only between start and stop (main kills it on stop, hide, cap, reload and quit)
  pcHealthStart: () => ipcRenderer.invoke("pchealth-start"),
  pcHealthStop: (reason) => ipcRenderer.invoke("pchealth-stop", { reason }),
  pcHealthSnapshot: () => ipcRenderer.invoke("pchealth-snapshot"),
  onPcHealthData: (cb) => ipcRenderer.on("pchealth-data", (_e, d) => cb(d)),
  onPcHealthStatus: (cb) => ipcRenderer.on("pchealth-status", (_e, d) => cb(d)),
  memoryData: () => ipcRenderer.invoke("memory-data"),
  memoryOpenFolder: (key) => ipcRenderer.invoke("memory-open-folder", key),
  argusOpenSource: (file) => ipcRenderer.invoke("argus-open-source", { file }),
  argusSetIdeaDecision: (payload) => ipcRenderer.invoke("argus-set-idea-decision", payload),
  libraryStateGet: () => ipcRenderer.invoke("library-state-get"),
  libraryStateOp: (op) => ipcRenderer.invoke("library-state-op", op),
  // v1.92.0: `agent` is the agent's folder name (main resolves it); documents go by id, never by path.
  agentDocsList: (agent, query) => ipcRenderer.invoke("agent-docs-list", { agent, query }),
  agentDocsSummary: (agent) => ipcRenderer.invoke("agent-docs-summary", { agent }),
  agentDocsOpen: (agent, id, how) => ipcRenderer.invoke("agent-docs-open", { agent, id, how }),
  agentDocsThumb: (agent, id) => ipcRenderer.invoke("agent-docs-thumb", { agent, id }),
  agentDocsPrefsGet: () => ipcRenderer.invoke("agent-docs-prefs-get"),
  agentDocsPrefsSet: (patch) => ipcRenderer.invoke("agent-docs-prefs-set", patch),
  registryAction: (id, action) => ipcRenderer.invoke("registry-action", { id, action }),
  openLocalPdf: (filePath) => ipcRenderer.invoke("open-path", { filePath }),
  openPath: (filePath) => ipcRenderer.invoke("open-path", { filePath }),
  resolvePaths: (guesses) => ipcRenderer.invoke("resolve-paths", { guesses }),
  approveTelegramTasks: (ids) => ipcRenderer.invoke("approve-telegram-tasks", { ids }),
  heldSave: (json) => ipcRenderer.invoke("guard-held-save", { json }),
  heldLoad: () => ipcRenderer.invoke("guard-held-load"),
  ledgerSave: (json) => ipcRenderer.invoke("ledger-save", { json }),
  ledgerLoad: () => ipcRenderer.invoke("ledger-load"),
  outboxSave: (json) => ipcRenderer.invoke("outbox-save", { json }),          // v1.100.0 message outbox
  agentIsPaused: (agentPath) => ipcRenderer.invoke("agent-is-paused", { agentPath }), // v1.110.0: asked right before an automatic re-send (true/false/null)
  onAgentPausedChanged: (cb) => ipcRenderer.on("agent-paused-changed", (_e, d) => cb(d)),
  outboxLoad: () => ipcRenderer.invoke("outbox-load"),
  outboxSeen: (agentPath, text, sinceMs, lastSentMs) => ipcRenderer.invoke("outbox-seen", { agentPath, text, sinceMs, lastSentMs }),
  channelSend: (agentPath, text) => ipcRenderer.invoke("guard-channel-send", { agentPath, text }),
  channelCancel: (id) => ipcRenderer.invoke("guard-channel-cancel", { id }),
  getHandoffInfo: (agentPath) => ipcRenderer.invoke("guard-handoff-info", { agentPath }),
  archiveHandoff: (agentPath) => ipcRenderer.invoke("guard-archive-handoff", { agentPath }),
  transcriptHas: (agentPath, needle) => ipcRenderer.invoke("guard-transcript-has", { agentPath, needle }),
  getLimitStatus: (agentPath) => ipcRenderer.invoke("guard-limit-status", { agentPath }),
  triggerClaudeLogin: () => ipcRenderer.invoke("guard-trigger-login"),

  getUiFlags: () => ipcRenderer.invoke("ui-flags-get"),
  config: { // v1.121.0 Setup panel (src/setupMain.js)
    getAll: () => ipcRenderer.invoke("config-get-all"),
    getValues: () => ipcRenderer.invoke("config-get-values"),
    setFeature: (featureId, values, enabled, create) => ipcRenderer.invoke("config-set-feature", { featureId, values, enabled, create }),
    pickFolder: (featureId, key) => ipcRenderer.invoke("config-pick-folder", { featureId, key }),
    createFolders: (featureId, values) => ipcRenderer.invoke("config-create-folders", { featureId, values }),
    consent: (featureId) => ipcRenderer.invoke("config-consent", { featureId }),
    agentInstructions: (featureId) => ipcRenderer.invoke("config-agent-instructions", featureId === undefined ? undefined : { featureId }),
  },
  bugReport: { // v1.123.0 "Report a problem" (src/bugReportMain.js). Nothing here can send anything anywhere; the files are written where the person chooses.
    info: () => ipcRenderer.invoke("bug-report-info"),
    pickFolder: () => ipcRenderer.invoke("bug-report-pick-folder"),
    pickScreenshot: (clear) => ipcRenderer.invoke("bug-report-pick-screenshot", clear ? { clear: true } : {}),
    preview: (form) => ipcRenderer.invoke("bug-report-preview", form),
    create: (form) => ipcRenderer.invoke("bug-report-create", form),
    openFolder: () => ipcRenderer.invoke("bug-report-open-folder", {}),
  },
  setUiFlag: (key, value) => ipcRenderer.invoke("ui-flag-set", { key, value }),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  // Update & restart (v1.58.0) - see src/app-update.js.
  getAppUpdateStatus: (opts) => ipcRenderer.invoke("app-update-status", opts),
  applyAppUpdate: () => ipcRenderer.invoke("app-update-apply"),
  getDepStatus: () => ipcRenderer.invoke("app-dep-status"), // v1.119.1 dep-doctor
  onDepDoctorStatus: (callback) => { ipcRenderer.on("dep-doctor-status", (event, payload) => callback(payload)); },
  restartAppNow: () => ipcRenderer.invoke("app-restart-now"),
  openAppRelease: (url) => ipcRenderer.invoke("app-update-open-release", url),
  checkClaudeCodeUpdate: () => ipcRenderer.invoke("check-claude-code-update"),
  updateClaudeCode: () => ipcRenderer.invoke("update-claude-code"),
  // Predicted replies (v1.108.0)
  predictRequest: (req) => ipcRenderer.invoke("predict-request", req),
  predictCancel: (agentPath) => ipcRenderer.send("predict-cancel", agentPath),
  predictOpen: (agentPath) => ipcRenderer.send("predict-open", agentPath),
  predictPrefsGet: () => ipcRenderer.invoke("predict-prefs-get"),
  predictPrefsSet: (patch) => ipcRenderer.invoke("predict-prefs-set", patch),
  updateClaudeCli: () => ipcRenderer.invoke("update-claude-cli"),
  onCliUpdateProgress: (cb) => ipcRenderer.on("cli-update-progress", (_e, d) => cb(d)),

  checkInterferingServices: () => ipcRenderer.invoke("check-interfering-services"),
  disableInterferingService: (serviceName) => ipcRenderer.invoke("disable-interfering-service", { serviceName }),
  checkClaudeExecutableHealth: () => ipcRenderer.invoke("check-claude-executable-health"),

  // Startup countdown overlay (v1.53.0) - see startupState in main.js.
  getStartupState: () => ipcRenderer.invoke("get-startup-state"),
  dismissStartup: () => ipcRenderer.send("startup-dismiss"),
  onStartupProgress: (callback) => {
    ipcRenderer.on("startup-progress", (event, payload) => callback(payload));
  },
  onStartupReady: (callback) => {
    ipcRenderer.on("startup-ready", (event, payload) => callback(payload));
  },

  // Untrusted agents (v1.54.0) - see untrustedAgents in main.js.
  getUntrustedAgents: () => ipcRenderer.invoke("get-untrusted-agents"),
  trustAgentFolders: (agentPaths) => ipcRenderer.invoke("trust-agent-folders", { agentPaths }),
  onUntrustedAgents: (callback) => {
    ipcRenderer.on("untrusted-agents", (event, list) => callback(list));
  },

  // load governor (v1.127.0) - see src/loadGovernor.js
  governorAdmit: (kind, agentPath) => ipcRenderer.invoke("governor-admit", { kind, agentPath }),
  governorRelease: () => ipcRenderer.invoke("governor-release"),
  getGovernorState: () => ipcRenderer.invoke("governor-state"),
  // CPU guard + start limiter (v1.66.0) - see src/cpuGuardGlue.js.
  getCpuGuardState: () => ipcRenderer.invoke("cpuguard-state"),
  cpuGuardAction: (action) => ipcRenderer.invoke("cpuguard-action", { action }),
  onCpuGuardState: (callback) => {
    ipcRenderer.on("cpuguard-state", (event, state) => callback(state));
  },

  onTerminalData: (callback) => {
    ipcRenderer.on("terminal-data", (event, payload) => callback(payload));
  },
  onConnectionState: (callback) => {
    ipcRenderer.on("connection-state", (event, payload) => callback(payload));
  },
  getConnectionStates: () => ipcRenderer.invoke("get-connection-states"),
  // v1.134.0 stuck-failing agents / duplicate live copies (src/stuckEscalation.js)
  onStuckState: (callback) => {
    ipcRenderer.on("stuck-state", (event, payload) => callback(payload));
  },
  getStuckStates: () => ipcRenderer.invoke("get-stuck-states"),
  // v1.135.0 close a duplicate live copy (src/duplicateCopies.js)
  getDuplicateCopies: (agentPath) => ipcRenderer.invoke("get-duplicate-copies", agentPath),
  closeDuplicateCopies: (agentPath, keepId, closeIds, confirmBusy) => ipcRenderer.invoke("close-duplicate-copies", { agentPath, keepId, closeIds, confirmBusy }),
  // v1.69.0 Keep going (see src/keepGoing.js)
  keepGoingGet: () => ipcRenderer.invoke("keepgoing-get"),
  keepGoingSet: (agentPath, enabled) => ipcRenderer.invoke("keepgoing-set", { agentPath, enabled }),
  keepGoingSetRelentless: (agentPath, on) => ipcRenderer.invoke("keepgoing-set-relentless", { agentPath, on }),
  keepGoingHandoffActive: (agents) => ipcRenderer.send("keepgoing-handoff-active", { agents }),
  keepGoingResumePrompt: (agentPath, archivedPath) => ipcRenderer.invoke("keepgoing-resume-prompt", { agentPath, archivedPath }),
  onKeepGoingState: (callback) => {
    ipcRenderer.on("keepgoing-state", (event, payload) => callback(payload));
  },
  onTerminalExit: (callback) => {
    ipcRenderer.on("terminal-exit", (event, payload) => callback(payload));
  },

  // v1.81.0 My Health stage 1 (renderer/health.js). The renderer never names a file path: the chooser opens in main.
  health: {
    load: () => ipcRenderer.invoke("health-load"),
    viewState: (open) => ipcRenderer.invoke("health-view-state", { open: !!open }),
    importPick: () => ipcRenderer.invoke("health-import-pick"),
    importFolder: () => ipcRenderer.invoke("health-import-folder"),
    importChoose: (token, order) => ipcRenderer.invoke("health-import-choose", { token, order }),
    addLab: (p) => ipcRenderer.invoke("health-lab-add", p),
    addReading: (p) => ipcRenderer.invoke("health-reading-add", p),
    addMed: (p) => ipcRenderer.invoke("health-med-add", p),
    stopMed: (id) => ipcRenderer.invoke("health-med-stop", { id }),
    agentLoad: () => ipcRenderer.invoke("health-agent-load"),
    agentAct: (p) => ipcRenderer.invoke("health-agent-act", p),
    extraLoad: (p) => ipcRenderer.invoke("health-extra-load", p),
    extraAct: (p) => ipcRenderer.invoke("health-extra-act", p),
    openLink: (url) => ipcRenderer.invoke("health-open-link", { url }),
    // v1.118.0 Body tab (pain log): the file stays in main; the renderer sends entries and gets the merged log back
    bodyLoad: () => ipcRenderer.invoke("health-body-load"),
    bodySave: (entries) => ipcRenderer.invoke("health-body-save", { entries }),
    // v1.114.0 visual pane: parsed feed JSON only (no path); the event carries no content
    paneFeed: () => ipcRenderer.invoke("health-pane-feed"),
    onPaneChanged: (cb) => ipcRenderer.on("health-pane-changed", () => cb()),
  },
  // v1.83.0 TOOLS v1 (renderer/tools.js). The renderer sends only a tool id; commands live in tools.json and run in main.
  // v1.87.0 MY RESEARCH tab (renderer/research.js): the renderer sends a week name and a finding's identity; the folder is fixed in main.
  research: {
    load: (week) => ipcRenderer.invoke("research-load", { week }),
    mark: (m) => ipcRenderer.invoke("research-mark", m),
    openLink: (url) => ipcRenderer.invoke("research-open", { url }),
    addIdea: (m) => ipcRenderer.invoke("research-idea", m),
    exportWeek: (week) => ipcRenderer.invoke("research-export", { week }),
    getPrefs: () => ipcRenderer.invoke("research-prefs-get"),
    setPrefs: (p) => ipcRenderer.invoke("research-prefs-set", p),
    write: (week, agent, findingId, text) => ipcRenderer.invoke("research-write", { week, agent, findingId, text }),
    recsLoad: (all) => ipcRenderer.invoke("recs-load", { all: !!all }),
    recsWrite: (week, agent, itemId, text) => ipcRenderer.invoke("recs-write", { week, agent, itemId, text }),
    // v1.91.0 magazine view: a finding's cached lead image (main fetches it once, safely; never a remote URL) and the owner's sent thread
    image: (week, agent, findingId) => ipcRenderer.invoke("research-image", { week, agent, findingId }),
    thread: (week, agent, findingId) => ipcRenderer.invoke("research-thread", { week, agent, findingId }),
    cancelImages: () => ipcRenderer.invoke("research-image-cancel"),
    // v1.107.0: the unread badge (count of new visible findings), "these were read" (week/agent/findingId only) and Mark all as read
    badge: () => ipcRenderer.invoke("research-badge"),
    seen: (items) => ipcRenderer.invoke("research-seen", { items }),
    seenAll: () => ipcRenderer.invoke("research-seen-all"),
  },
  // v1.90.0 MY FINANCE skeleton (renderer/finance.js): the renderer sends filter values and "drop"/"vault"; the folder is fixed in main.
  finance: {
    load: () => ipcRenderer.invoke("finance-load"),
    feed: (scope, page, offset, filter, from, to) => ipcRenderer.invoke("finance-feed", { scope, page, offset, filter, from, to }),
    transactions: (q) => ipcRenderer.invoke("finance-transactions", q),
    importScan: () => ipcRenderer.invoke("finance-import-scan"),
    demoCreate: () => ipcRenderer.invoke("finance-demo-create"),
    demoRemove: () => ipcRenderer.invoke("finance-demo-remove"),
    openFolder: (which) => ipcRenderer.invoke("finance-open-folder", { which }),
    getPrefs: () => ipcRenderer.invoke("finance-prefs-get"),
    setPrefs: (p) => ipcRenderer.invoke("finance-prefs-set", p),
    closed: () => ipcRenderer.invoke("finance-closed"),
  },
  // v1.125.0 My Designs (read only). The renderer sends only a design id.
  designs: {
    load: () => ipcRenderer.invoke("designs-load"),
    openSource: (id) => ipcRenderer.invoke("designs-open-source", { id }),
    openReference: (id) => ipcRenderer.invoke("designs-open-reference", { id }),
  },
  tools: {
    load: () => ipcRenderer.invoke("tools-load"),
    getPrefs: () => ipcRenderer.invoke("tools-prefs-get"),
    setPrefs: (p) => ipcRenderer.invoke("tools-prefs-set", p),
    start: (id) => ipcRenderer.invoke("tools-start", { id }),
    refresh: () => ipcRenderer.invoke("tools-refresh"),
    openLink: (id, kind) => ipcRenderer.invoke("tools-open-link", { id, kind }),
  },
  // v1.72.0 My Daily (renderer/daily.js)
  daily: {
    load: (force) => ipcRenderer.invoke("daily-load", { force: !!force }),
    setSettings: (patch) => ipcRenderer.invoke("daily-settings-set", patch),
    calendarAdd: (name, url) => ipcRenderer.invoke("daily-calendar-add", { name, url }),
    calendarRemove: (index) => ipcRenderer.invoke("daily-calendar-remove", { index }),
    calendarRefresh: () => ipcRenderer.invoke("daily-calendar-refresh"),
    gmailAdd: () => ipcRenderer.invoke("daily-gmail-add"),
    gmailRemove: (email) => ipcRenderer.invoke("daily-gmail-remove", { email }),
    gmailRefresh: () => ipcRenderer.invoke("daily-gmail-refresh"),
    imapHelp: (email) => ipcRenderer.invoke("daily-imap-help", { email }),
    imapTest: (a) => ipcRenderer.invoke("daily-imap-test", a),
    imapAdd: (a) => ipcRenderer.invoke("daily-imap-add", a),
    imapRemove: (email) => ipcRenderer.invoke("daily-imap-remove", { email }),
    createShoppingList: (name) => ipcRenderer.invoke("daily-shopping-create-list", { name }),
    shopping: (args) => ipcRenderer.invoke("daily-shopping", args),
    thumbs: (names) => ipcRenderer.invoke("daily-thumbs", names),
    editTask: (args) => ipcRenderer.invoke("daily-task-edit", args),
    addTask: (task) => ipcRenderer.invoke("daily-task-add", task),
    saveDate: (item) => ipcRenderer.invoke("daily-dates-save", item),
    deleteDate: (id) => ipcRenderer.invoke("daily-dates-delete", { id }),
    saveAppointment: (item) => ipcRenderer.invoke("daily-appointment-save", item),
    deleteAppointment: (id) => ipcRenderer.invoke("daily-appointment-delete", { id }),
    clearNotices: () => ipcRenderer.invoke("daily-notices-clear"),
    emailDismiss: (entries) => ipcRenderer.invoke("daily-email-dismiss", { entries }),
    emailRestore: (keys) => ipcRenderer.invoke("daily-email-restore", keys ? { keys } : { all: true }),
    shipmentsLoad: (force) => ipcRenderer.invoke("daily-shipments-load", { force: !!force }),
    shipmentsRefresh: () => ipcRenderer.invoke("daily-shipments-refresh"),
    shipmentsOp: (args) => ipcRenderer.invoke("daily-shipments-op", args),
    shipmentsSetKey: (provider, key) => ipcRenderer.invoke("daily-shipments-key", { provider, key }),
    shipmentsClearKey: (provider) => ipcRenderer.invoke("daily-shipments-key", { provider, clear: true }),
    decisionsLoad: () => ipcRenderer.invoke("daily-decisions-load"),
    decisionsAnswer: (id, answer, text, rev) => ipcRenderer.invoke("daily-decisions-answer", { id, answer, text, rev }),
    decisionsSetKind: (id, kind) => ipcRenderer.invoke("daily-decisions-kind", { id, kind }),
    triageLoad: () => ipcRenderer.invoke("daily-triage-load"),
    triageAnswer: (id, answer, text, rev, clear) => ipcRenderer.invoke("daily-triage-answer", { id, answer, text, rev, clear }),
    triageAsk: (id) => ipcRenderer.invoke("daily-triage-ask", { id }),
    triageSnooze: (ids, kind) => ipcRenderer.invoke("daily-triage-snooze", { ids, kind }),
    triageUnsnooze: (ids) => ipcRenderer.invoke("daily-triage-unsnooze", { ids }),
    triageClose: (ids, note, revs) => ipcRenderer.invoke("daily-triage-close", { ids, note, revs }),
  },
  // v1.55.0 IRIS (renderer/iris.js)
  iris: {
    status: () => ipcRenderer.invoke("iris-status"),
    setEnabled: (on) => ipcRenderer.invoke("iris-set-enabled", { on }),
    setName: (name) => ipcRenderer.invoke("iris-set-name", { name }),
    createInvite: () => ipcRenderer.invoke("iris-create-invite"),
    cancelInvite: () => ipcRenderer.invoke("iris-cancel-invite"),
    join: (invite) => ipcRenderer.invoke("iris-join", { invite }),
    setPeer: (peerId, patch) => ipcRenderer.invoke("iris-set-peer", { peerId, patch }),
    unpair: (peerId) => ipcRenderer.invoke("iris-unpair", { peerId }),
    send: (peerId, text, type, replyTo) => ipcRenderer.invoke("iris-send", { peerId, text, type, replyTo }),
    approveSend: (id) => ipcRenderer.invoke("iris-approve-send", { id }),
    rejectSend: (id) => ipcRenderer.invoke("iris-reject-send", { id }),
    log: (limit) => ipcRenderer.invoke("iris-log", { limit }),
    pending: () => ipcRenderer.invoke("iris-pending"),
    prepareDelivery: (id, agentPath) => ipcRenderer.invoke("iris-prepare-delivery", { id, agentPath }),
    delivered: (id, to) => ipcRenderer.invoke("iris-delivered", { id, to }),
    // v1.126.0 Chats page (renderer/iris-chats.js): direct agent messaging
    chats: () => ipcRenderer.invoke("iris-chats"),
    chatSend: (peerId, toAgent, text, thread) => ipcRenderer.invoke("iris-chat-send", { peerId, toAgent, text, thread }),
    chatRetry: (id) => ipcRenderer.invoke("iris-chat-retry", { id }),
    chatViewed: (peerId) => ipcRenderer.invoke("iris-chat-viewed", { peerId }),
    directSet: (peerId, patch) => ipcRenderer.invoke("iris-direct-set", { peerId, patch }),
    onChanged: (cb) => ipcRenderer.on("iris-changed", () => cb()),
    onIncoming: (cb) => ipcRenderer.on("iris-incoming", (e, p) => cb(p)),
  },
});

// v1.93.0: AD_PERF=1 only - renderer long tasks, paint timings and IPC round trips recorded into the page's own
// window.__adPerf (read by the perf harness). Injected into the main world before any page script runs, so the
// startup long tasks are caught. A no-op without the env var.
if (process.env.AD_PERF === "1") {
  try {
    require("electron").webFrame.executeJavaScript(`(() => {
      const P = window.__adPerf = { longtasks: [], paints: [], origin: performance.timeOrigin, marks: [] };
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longtasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch (e) { P.ltErr = String(e); }
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.paints.push([e.name, Math.round(e.startTime)]); }).observe({ type: "paint", buffered: true }); } catch (e) {}
      document.addEventListener("DOMContentLoaded", () => P.marks.push(["DOMContentLoaded", Math.round(performance.now())]));
      window.addEventListener("load", () => P.marks.push(["load", Math.round(performance.now())]));
    })()`);
  } catch (e) { /* perf hook is best effort */ }
}
