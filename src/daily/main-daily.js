// My Daily - main-process side (v1.72.0). Loaded from main.js inside try/catch like IRIS, so a fault here can
// only disable My Daily. LIGHT by design: no timers, nothing runs until the renderer asks (view opened, sidebar
// hover, one badge read after start). The assembled payload is cached for 60 s.
//
// Data (all local JSON in the Daily data folder, atomic writes; see dailyConfig.dataDir): settings.json, shopping.json, dates.json,
// appointments.json. Tasks are READ from the shared task store <shared reports>/tasks/<agent>.json
// (tasks.py schema "agent-tasks/1"); in test mode fixtures are used instead. Every location, name and helper program comes from the
// configuration layer (appConfig + dailyConfig.js); with nothing configured the task list is simply off and the rest keeps working. Email and calendar come from
// a provider (providers: placeholder only in this build, clearly labelled "demo data" in the UI).
const fs = require("fs");
const path = require("path");
const model = require("./model");
const linkmeta = require("./linkmeta");
const mailfeed = require("./mailfeed");
const calendarMod = require("./calendar");
const gmailMod = require("./gmail");
const imapMod = require("./imap");
const shipMain = require("./shipments-main");
const shipTrack = require("./shipments-track");
const decMain = require("./decisions-main");
const triMain = require("./triage-main");
const triModel = require("./triage-model");
const { execFile } = require("child_process");
const { withFsRetry } = require("../fsRetry");
const emailDismiss = require("./emaildismiss");
const C = require("./contract");
const dailyConfig = require("./dailyConfig");

const CACHE_MS = 60000;
// v1.86.0 demo mode: invented mail and calendar instead of the built-in placeholder examples (null when demo mode is off).
const demoP = process.env.AGENT_DESKTOP_DEMO === "1" ? require("../demo/dailyProvider") : null;

const MAX_ITEMS = 5000;                      // appointments / dates kept per store
const MAX_STORE_BYTES = 25 * 1024 * 1024;   // a store bigger than this is treated as damaged, never loaded

function parseText(txt) { return JSON.parse(String(txt).replace(/^\uFEFF/, "")); }
function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }

// Plain reader (no recovery): used where a missing/odd file just means "nothing yet".
function readJson(file, fallback) {
  try {
    const v = parseText(fs.readFileSync(file, "utf8"));
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

// Reader with recovery. Missing file -> fallback (a fresh start). Oversized, not JSON or not an object ->
// the damaged file is kept as <file>.corrupt-<time>, the previous good copy <file>.bak is restored when it is valid,
// and a notice is recorded so My Daily can say so. A file that merely cannot be read right now (locked) is left
// untouched. Never throws.
function readStore(file, fallback, notices, label) {
  let txt;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_STORE_BYTES) throw Object.assign(new Error("file is too large"), { code: "ETOOBIG" });
    txt = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return fallback;
    if (!(e && e.code === "ETOOBIG")) { note(notices, label, `could not be read (${e && e.code ? e.code : "error"}); showing it empty. Nothing was overwritten.`); return fallback; }
    return recover(file, fallback, notices, label, e.message);
  }
  try {
    const v = parseText(txt);
    if (!isObj(v)) throw new Error("not an object");
    return v;
  } catch (e) {
    return recover(file, fallback, notices, label, e.message);
  }
}
function note(notices, label, text) {
  if (!notices) return;
  const msg = `${label} ${text}`;
  if (!notices.includes(msg)) notices.push(msg);
}
function recover(file, fallback, notices, label, why) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const kept = `${file}.corrupt-${stamp}`;
  let keptOk = true;
  try { fs.renameSync(file, kept); } catch (e) { keptOk = false; }
  let restored = null;
  try {
    const st = fs.statSync(file + ".bak");
    if (st.size <= MAX_STORE_BYTES) { const v = parseText(fs.readFileSync(file + ".bak", "utf8")); if (isObj(v)) restored = v; }
  } catch (e) { /* no usable backup */ }
  if (restored) {
    try { fs.copyFileSync(file + ".bak", file); } catch (e) { /* the restored data is still used for this run */ }
    note(notices, label, `was damaged (${why}); the last good copy was restored. The damaged file was kept as ${path.basename(kept)}.`);
    return restored;
  }
  note(notices, label, keptOk ? `was damaged (${why}) and no backup exists, so it starts empty. The damaged file was kept as ${path.basename(kept)}.` : `was damaged (${why}); it could not be moved aside, so it will be replaced on the next save.`);
  return fallback;
}

// Atomic write: temp file in the same folder, then rename. The previous version is kept as <file>.bak first.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const text = JSON.stringify(value, null, 2);
  if (text.length > MAX_STORE_BYTES) throw new Error("That would make the file too large to keep safely.");
  try {
    withFsRetry(() => {
      fs.writeFileSync(tmp, text, "utf8");
      try { fs.copyFileSync(file, file + ".bak"); } catch (e) { /* first write: nothing to back up */ }
      fs.renameSync(tmp, file);
    });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* already gone */ }
    throw e;
  }
}

// The provider interface. A real provider (Google Calendar, IMAP/Gmail) will implement the same two methods
// and report connected:true; none is built yet, so the placeholder serves the mockups' demo data.
const providers = {
  placeholder: {
    connected: false,
    label: "Not connected - demo data",
    emails: (now) => model.placeholderEmails(now),
    events: (now) => model.placeholderEvents(now),
    accounts: ["Personal", "Editor", "Contact"],
  },
};

function init({ ipcMain: rawIpc, cfg, dataDir, safeStorage, openExternal, testMode, log, runPython, fetchProduct, makeThumb, getMainWindow, deliverToAgent, knownAgent }) {
  const say = typeof log === "function" ? log : () => {};
  const notices = [];   // damaged-store notices, kept until dismissed (daily-notices-clear)
  // Every daily-* channel: only the main window's own frame may call it (same idea as IRIS), and an oversized
  // argument is refused before any handler looks at it. With no main window known, everything is refused.
  const MAX_ARG_CHARS = 262144;
  const ipcMain = {
    handle: (channel, fn) => rawIpc.handle(channel, (event, arg) => {
      try {
        const w = typeof getMainWindow === "function" ? getMainWindow() : null;
        const wc = w && !(typeof w.isDestroyed === "function" && w.isDestroyed()) ? w.webContents : null;
        if (!wc || !event || event.sender !== wc || (event.senderFrame && wc.mainFrame && event.senderFrame !== wc.mainFrame)) { say(`${channel} refused: not the main window`); return { ok: false, reason: "Not allowed." }; }
        if (arg !== undefined && arg !== null) {
          let n = 0;
          try { n = JSON.stringify(arg).length; } catch (e) { return { ok: false, reason: "Bad request." }; }
          if (n > MAX_ARG_CHARS) return { ok: false, reason: "That request is too large." };
        }
      } catch (e) { return { ok: false, reason: "Not allowed." }; }
      return fn(event, arg);
    }),
  };
  // Locations and names: configuration only (nothing points at a particular person's folders). `dataDir` here is the app data (userData) folder.
  const dc = dailyConfig.create({ cfg, userDataDir: dataDir });
  const dir = dc.dataDir();                     // resolved once: moving the Daily data folder takes effect after a restart
  const f = (n) => path.join(dir || "", n);
  const taskDir = () => dc.taskDir();
  const rootOf = () => { try { return cfg && typeof cfg.get === "function" ? cfg.get("agentsRoot") : null; } catch (e) { return null; } };
  const featureReady = () => { try { return !(cfg && typeof cfg.isReady === "function") || cfg.isReady("myDaily"); } catch (e) { return true; } };
  const shareDefaults = () => ({ [C.SHARE_SETTING_KEY]: dc.sharePartnerDefault() });
  const readSettings = () => model.cleanSettings(readStore(f("settings.json"), {}, notices, "Settings"), shareDefaults());
  const mailRules = () => {
    const r = mailfeed.loadRules(dc.mailRulesFile());
    if (r && !r.ownDomains && dc.ownDomains()) r.ownDomains = dc.ownDomains();
    return r;
  };
  let cache = null;
  // A change made in Setup (names, tasks tool, Python, task folder) shows on the next read instead of after the 60 s cache.
  if (cfg && typeof cfg.onChange === "function") { try { cfg.onChange(() => { cache = null; }); } catch (e) { /* no live updates: the 60 s cache applies */ } }
  // v1.113.1: dismissed email items (local only, never touches a mailbox). App data folder, not a synced folder; falls back to the daily folder.
  const dismissFile = dataDir ? path.join(dataDir, "daily-email-dismissed.json") : f("email-dismissed.json");
  const loadDismissed = () => emailDismiss.cleanStore(readStore(dismissFile, emailDismiss.emptyStore(), notices, "Dismissed emails"));
  // Calendar sources (Google's secret iCal link) live in the app data folder, not in a synced folder; none in test mode.
  const cal = dataDir && !testMode ? calendarMod.create({ dataDir, log: say }) : null;
  // Gmail (read-only Google sign-in). The Google connection (client id/secret of the app's Google project: not a secret in Google's
  // desktop-app model, but still kept out of the repo) is read from <app data>\gmail-client.json; without it Gmail stays off.
  let gmailClient = null;
  try { if (dataDir) gmailClient = readJson(path.join(dataDir, "gmail-client.json"), null); } catch (e) { gmailClient = null; }
  const gmail = dataDir && !testMode ? gmailMod.create({
    dataDir, safeStorage, client: gmailClient && gmailClient.clientId && gmailClient.clientSecret ? gmailClient : null, log: say,
    exportFile: dc.gmailExportFile(),
    openExternal: (u) => { if (typeof openExternal === "function" && /^https:\/\/accounts\.google\.com\//.test(String(u))) openExternal(u); },
  }) : null;
  // E-mail over IMAP with an app password (v1.112.0): address + app password only, no Google project. Read-only (see imap.js).
  const imap = dataDir && !testMode ? imapMod.create({ dataDir, safeStorage, log: say }) : null;
  let skippedTaskFiles = 0;
  const thumbDir = path.join(dir || "", "thumbs");
  const fixtureAdded = [];          // test mode: tasks added by voice live in memory only
  const fixtureEdits = new Map();   // test mode: edits to fixture tasks live in memory only
  // The task tool: python and tasks.py come from configuration. Absent -> a calm "needs-setup" (the task list is off), never a crash.
  const run = runPython || ((args) => new Promise((resolve, reject) => {
    const r = dc.run();
    if (!r) return reject(Object.assign(new Error("needs-setup"), { needsSetup: true }));
    execFile(r.python, [r.tool].concat(args), { timeout: 30000, windowsHide: true }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim().slice(0, 200))) : resolve(out)));
  }));
  const getProduct = fetchProduct || linkmeta.fetchProduct;

  // Test mode may pin the clock (screenshots at a known time of day). Ignored outside test mode.
  const clockNow = () => {
    if (testMode && process.env.AGENT_DESKTOP_DAILY_NOW) {
      const t = Date.parse(process.env.AGENT_DESKTOP_DAILY_NOW);
      if (Number.isFinite(t)) return t;
    }
    return Date.now();
  };

  async function loadTasks(now) {
    if (testMode && process.env.AGENT_DESKTOP_DAILY_REAL_TASKS !== "1") {
      return { tasks: model.fixtureTasks(now).concat(fixtureAdded).map((t) => (fixtureEdits.has(t.id) ? model.applyTaskEdit(t, fixtureEdits.get(t.id)) : t)), source: "fixture" };
    }
    let names = [];
    const taskDirNow = taskDir();
    if (!taskDirNow) return { tasks: [], source: "missing" };
    try { names = (await fs.promises.readdir(taskDirNow)).filter((n) => n.endsWith(".json")); } catch (e) { return { tasks: [], source: "missing" }; }
    skippedTaskFiles = 0;
    const stores = await Promise.all(names.map(async (n) => {
      try {
        const file = path.join(taskDirNow, n);
        if ((await fs.promises.stat(file)).size > MAX_STORE_BYTES) throw new Error("too large");
        const v = parseText(await fs.promises.readFile(file, "utf8"));
        if (!isObj(v)) throw new Error("not an object");
        return v;
      } catch (e) { skippedTaskFiles++; return null; }
    }));
    return { tasks: model.mapTaskStores(stores.filter(Boolean), now), source: "store" };
  }

  // Reads shopping.json and applies the lazy archive move (done > 1 h -> archive, archive > 90 d -> gone).
  function loadShopping(now) {
    const s = model.cleanShopping(readStore(f("shopping.json"), { lists: [] }, notices, "Shopping lists"));
    if (model.sweepShopping(s, now)) { try { writeJsonAtomic(f("shopping.json"), s); } catch (e) { say(`shopping sweep not saved: ${e.message}`); } }
    return s;
  }
  function saveShopping(s) { writeJsonAtomic(f("shopping.json"), s); cache = null; }

  async function assemble() {
    const now = clockNow();
    const p = providers.placeholder;
    const { tasks, source } = await loadTasks(now);
    try {   // v1.79.0: snoozed tasks do not count toward the badge / "needs you" numbers
      const sn = readStore(f("triage.json"), { snoozes: {} }, notices, "Tasks triage").snoozes || {};
      for (const t of tasks) if ((Number(sn[t.agent + "::" + t.id]) || 0) > now) t.snoozed = true;
    } catch (e) { /* counts only */ }
    const own = readStore(f("appointments.json"), { items: [] }, notices, "Appointments");
    const ownEvents = (Array.isArray(own.items) ? own.items : []).filter((e) => e && Number.isFinite(e.start)).map((e) => Object.assign({ cal: C.CAL_OWNER }, e, { own: true }));
    let calRes = null;
    try { calRes = cal ? await cal.load(now, { onUpdated: () => { cache = null; } }) : null; } catch (e) { say(`calendar load failed: ${e && e.message}`); }
    const calOn = !!(calRes && calRes.connected);
    const events = (demoP ? demoP.events(now) : calOn ? calRes.events : p.events(now)).concat(ownEvents).sort((a, b) => a.start - b.start);
    // Real email from a local mail feed (a read-only file written by whichever agent indexes the mail; daily.mailFeedFile) when it is readable;
    // otherwise the placeholder demo data. Calendar stays on the placeholder until Google Calendar is connected.
    const feed = testMode ? { connected: false } : mailfeed.loadMailFeed(dc.mailFeedFile(), now);
    let gm = null;
    try { gm = gmail ? await gmail.load(now, {}) : null; } catch (e) { say(`gmail load failed: ${e && e.message}`); }
    const gmOn = !!(gm && gm.connected);
    let im = null;
    try { im = imap ? await imap.load(now, {}) : null; } catch (e) { say(`imap load failed: ${e && e.message}`); }
    const imOn = !!(im && im.connected);
    const parts = [];
    if (feed.connected) parts.push({ name: "Betterbird local feed", emails: feed.emails, accounts: feed.accounts, at: feed.updatedAt });
    if (gmOn) parts.push({ name: `Gmail (${gm.accounts.length} account${gm.accounts.length === 1 ? "" : "s"})`, emails: gm.emails, accounts: gm.accounts, at: gm.updatedAt });
    if (imOn) parts.push({ name: `IMAP (${im.accounts.length} account${im.accounts.length === 1 ? "" : "s"})`, emails: im.emails, accounts: im.accounts, at: im.updatedAt });
    const mailOn = parts.length > 0 || !!demoP;
    const mailAccounts = demoP ? demoP.accounts : [].concat(...parts.map((x) => x.accounts));
    const shaped = demoP ? demoP.emails(now) : mailOn ? mailfeed.shapeEmails(mailfeed.mergeEmails(parts.map((x) => x.emails)), mailRules(), now) : p.emails(now);
    const dis = emailDismiss.apply(shaped, loadDismissed());   // dismissed items leave the lists (and so the counts); they come back with a newer last message
    const data = {
      tasks, emails: dis.emails, emailsDismissed: dis.dismissed, events,
      dates: (() => { const d = readStore(f("dates.json"), { items: [] }, notices, "Birthdays & dates").items; return Array.isArray(d) ? d.filter(isObj) : []; })(),
      shopping: loadShopping(now),
    };
    const summary = model.summarize(data, now);
    return {
      now, generatedAt: Date.now(), data, summary, digest: model.buildDigest(summary, now), badge: model.badge(summary),
      settings: readSettings(),
      people: { ownerName: dc.people().ownerName, partnerName: dc.hasPartner() ? dc.people().partnerName : null, hasPartner: dc.hasPartner(), shareDefault: dc.sharePartnerDefault(), partnerWords: dc.partnerWords() },
      capabilities: { tasks: source === "fixture" || typeof runPython === "function" ? { read: true, edit: true, reason: "" } : (({ read, edit, reason }) => ({ read, edit, reason }))(dc.tasks()) },
      notices: notices.concat(skippedTaskFiles ? [`${skippedTaskFiles} task file${skippedTaskFiles === 1 ? "" : "s"} could not be read and ${skippedTaskFiles === 1 ? "is" : "are"} left out.`] : []),
      provider: { connected: calOn || !!demoP || p.connected, calendarConnected: calOn || !!demoP, calendars: calRes ? calRes.sources : [], label: p.label, accounts: mailOn ? mailAccounts : p.accounts, emailsConnected: mailOn, emailsLabel: demoP ? demoP.label + " connected (read-only)" : mailOn ? parts.map((x) => x.name).join(" + ") + " connected (read-only)" : "", emailsUpdatedAt: demoP ? Date.now() : mailOn ? Math.max(...parts.map((x) => x.at || 0)) : null, emailsCounts: null, gmail: { configured: !!(gmail && gmail.configured()), accounts: gmail ? gmail.list() : [] }, imap: { available: !!imap, accounts: imap ? imap.list() : [] }  }, taskSource: source, test: !!testMode,
    };
  }

  ipcMain.handle("daily-load", async (e, args) => {
    try {
      if (!featureReady() || !dir) return { ok: false, reason: "needs-setup" };
      if (!(args && args.force) && cache && Date.now() - cache.generatedAt < CACHE_MS) return cache;
      cache = await assemble();
      return cache;
    } catch (err) {
      say(`my daily load failed: ${err.message}`);
      return { error: err.message };
    }
  });

  // v1.113.1: dismiss / restore email items. Local file only; the renderer sends the entries (list, account, id, subject, who).
  ipcMain.handle("daily-email-dismiss", (e, args) => {
    try {
      const entries = Array.isArray(args && args.entries) ? args.entries.slice(0, 1000) : [];
      if (!entries.length) return { ok: false, reason: "Nothing to dismiss." };
      const next = emailDismiss.add(loadDismissed(), entries, Date.now());
      writeJsonAtomic(dismissFile, next);
      cache = null;
      return { ok: true, keys: entries.map((x) => emailDismiss.keyOf(x && x.list, x)).filter(Boolean) };
    } catch (err) { say("email dismiss failed: " + err.message); return { ok: false, reason: err.message }; }
  });
  ipcMain.handle("daily-email-restore", (e, args) => {
    try {
      const keys = args && args.all ? null : (Array.isArray(args && args.keys) ? args.keys.slice(0, 5000).map(String) : []);
      writeJsonAtomic(dismissFile, emailDismiss.restore(loadDismissed(), keys));
      cache = null;
      return { ok: true };
    } catch (err) { say("email restore failed: " + err.message); return { ok: false, reason: err.message }; }
  });

  ipcMain.handle("daily-calendar-add", async (e, args) => {
    try {
      if (!cal) return { ok: false, reason: "Calendars are not available here." };
      const r = cal.add(args && args.name, args && args.url);
      if (!r.ok) return r;
      cache = null;
      const res = await cal.load(clockNow(), { force: true });
      const mine = res.sources[res.sources.length - 1];
      if (mine && mine.error) { cal.remove(res.sources.length - 1); cache = null; return { ok: false, reason: `Could not read that calendar: ${mine.error}` }; }
      return { ok: true, count: mine ? mine.count : 0 };
    } catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle("daily-calendar-remove", (e, args) => {
    try { if (!cal) return { ok: false, reason: "Calendars are not available here." }; const r = cal.remove(args && args.index); cache = null; return r; }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle("daily-calendar-refresh", async () => {
    try { if (!cal) return { ok: false, reason: "Calendars are not available here." }; await cal.load(clockNow(), { force: true }); cache = null; return { ok: true }; }
    catch (err) { return { ok: false, reason: err.message }; }
  });

  ipcMain.handle("daily-gmail-add", async () => {
    try { if (!gmail) return { ok: false, reason: "Gmail is not available here." }; const r = await gmail.addAccount(); cache = null; if (r.ok) await gmail.load(clockNow(), { force: true }); return r; }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle("daily-gmail-remove", (e, args) => {
    try { if (!gmail) return { ok: false, reason: "Gmail is not available here." }; const r = gmail.remove(args && args.email); cache = null; return r; }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  // IMAP: the password only ever travels renderer -> main (typed by the person); nothing here returns it.
  const imapArgs = (a) => ({ email: a && a.email, password: a && a.password, host: a && a.host, port: a && a.port });
  ipcMain.handle("daily-imap-help", (e, a) => { try { return { ok: true, help: imapMod.helpFor(a && a.email) }; } catch (err) { return { ok: false, reason: err.message }; } });
  ipcMain.handle("daily-imap-test", async (e, a) => {
    try { if (!imap) return { ok: false, reason: "E-mail over IMAP is not available here." }; const r = await imap.testConnection(imapArgs(a)); return { ok: r.ok, reason: r.reason, needHost: !!r.needHost }; }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle("daily-imap-add", async (e, a) => {
    try { if (!imap) return { ok: false, reason: "E-mail over IMAP is not available here." }; const r = await imap.addAccount(imapArgs(a)); cache = null; if (r.ok) await imap.load(clockNow(), { force: true }); return { ok: r.ok, email: r.email, reason: r.reason, needHost: !!r.needHost }; }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle("daily-imap-remove", (e, a) => {
    try { if (!imap) return { ok: false, reason: "E-mail over IMAP is not available here." }; const r = imap.remove(a && a.email); cache = null; return r; }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle("daily-gmail-refresh", async () => {
    try { if (!gmail && !imap) return { ok: false, reason: "Gmail is not available here." }; if (gmail) await gmail.load(clockNow(), { force: true }); if (imap) await imap.load(clockNow(), { force: true }); cache = null; return { ok: true }; }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  // Shipments (v1.76.0): own store, mail scan through the existing read-only mail code, tracking keys only in this process.
  const shipTracker = shipTrack.createTracker({ dataDir: dataDir || path.join(dir, "..", "daily-keys-unavailable"), safeStorage: dataDir ? safeStorage : null, log: say,
    fakeProvider: testMode && process.env.AGENT_DESKTOP_SHIPMENTS_FAKE === "1" ? shipTrack.createFake({}) : null });
  const shipments = shipMain.createService({
    file: f("shipments.json"), readStore, writeJsonAtomic, tracker: shipTracker, notices, testMode, say, now: clockNow,
    getMails: async (now) => {
      if (testMode) return [];
      const out = [];
      try { out.push(...mailfeed.loadShipmentMails(dc.mailFeedFile(), now)); } catch (e) { say("shipments feed: " + e.message); }
      try { if (gmail) out.push(...(await gmail.shipmentMails(now))); } catch (e) { say("shipments gmail: " + e.message); }
      return out;
    },
  });
  if (!testMode) shipments.syncTimer();
  ipcMain.handle("daily-shipments-load", async (e, args) => { try { return await shipments.load(args); } catch (err) { say("shipments load failed: " + err.message); return { ok: false, reason: err.message }; } });
  ipcMain.handle("daily-shipments-refresh", async () => { try { return await shipments.refreshNow(); } catch (err) { return { ok: false, reason: err.message }; } });
  ipcMain.handle("daily-shipments-op", (e, args) => { try { return shipments.op(args); } catch (err) { return { ok: false, reason: err.message }; } });
  ipcMain.handle("daily-shipments-key", (e, args) => { try { return shipments.setKey(args); } catch (err) { return { ok: false, reason: err.message }; } });
  // Decisions (v1.78.0): open tasks that need the owner, of every agent; an answer is delivered to that agent (verified path injected from main.js).
  // Test mode reads fixtures and never updates the real task store; with no delivery function nothing can be answered.
  const decFixtures = testMode && process.env.AGENT_DESKTOP_DAILY_REAL_TASKS !== "1";
  const decisionsLoadStores = async () => {
      let names = [];
      const taskDirNow = taskDir();
      if (!taskDirNow) return { stores: [], skipped: 0 };
      try { names = (await fs.promises.readdir(taskDirNow)).filter((n) => n.endsWith(".json")); } catch (e) { return { stores: [], skipped: 0 }; }
      let skipped = 0;
      const stores = await Promise.all(names.map(async (n) => {
        try {
          const file = path.join(taskDirNow, n);
          if ((await fs.promises.stat(file)).size > MAX_STORE_BYTES) throw new Error("too large");
          const v = parseText(await fs.promises.readFile(file, "utf8"));
          if (!isObj(v)) throw new Error("not an object");
          return v;
        } catch (e) { skipped++; return null; }
      }));
      return { stores: stores.filter(Boolean), skipped };
    };
  const decisionsDeliver = (agentPath, text) => (typeof deliverToAgent === "function" ? deliverToAgent(agentPath, text) : Promise.resolve({ delivered: false, dry: true }));
  const decisions = decMain.createService({
    root: rootOf, people: () => dc.who(), file: f("decisions.json"), readStore, writeJsonAtomic, notices, testMode, say, now: clockNow, path, fixtures: decFixtures,
    loadStores: decisionsLoadStores,
    deliver: decisionsDeliver,
    knownAgent: typeof knownAgent === "function" ? knownAgent : null,
    run: (args) => run(args),
  });
  ipcMain.handle("daily-decisions-load", async () => { try { return await decisions.view(); } catch (err) { say("decisions load failed: " + err.message); return { ok: false, reason: err.message }; } });
  ipcMain.handle("daily-decisions-answer", async (e, args) => { try { const r = await decisions.answer(args); cache = null; return r; } catch (err) { say("decisions answer failed: " + err.message); return { ok: false, reason: err.message }; } });
  ipcMain.handle("daily-decisions-kind", async (e, args) => { try { return await decisions.setKind(args); } catch (err) { return { ok: false, reason: err.message }; } });
  // Tasks triage (v1.79.0): same task store, same verified delivery as Decisions; test mode uses in-memory fixtures.
  const triage = triMain.createService({
    root: rootOf, people: () => dc.who(), file: f("triage.json"), readStore, writeJsonAtomic, notices, say, now: clockNow, path, fixtures: decFixtures,
    loadStores: decisionsLoadStores, deliver: decisionsDeliver, knownAgent: typeof knownAgent === "function" ? knownAgent : null, run: (args) => run(args),
  });
  const triIpc = (name, fn, after) => ipcMain.handle(name, async (e, args) => { try { const r = await triage[fn](args); if (after) cache = null; return r; } catch (err) { say("triage " + fn + " failed: " + err.message); return { ok: false, reason: err.message }; } });
  triIpc("daily-triage-load", "view"); triIpc("daily-triage-answer", "answer", true); triIpc("daily-triage-ask", "askRecommendation");
  triIpc("daily-triage-snooze", "snooze", true); triIpc("daily-triage-unsnooze", "unsnooze", true); triIpc("daily-triage-close", "close", true);
  ipcMain.handle("daily-notices-clear", () => { notices.length = 0; cache = null; return { ok: true }; });

  ipcMain.handle("daily-settings-set", (e, patch) => {
    try {
      const cur = readSettings();
      const next = model.cleanSettings(Object.assign({}, cur, patch && typeof patch === "object" ? patch : {}), shareDefaults());
      writeJsonAtomic(f("settings.json"), next);
      cache = null;
      return { ok: true, settings: next };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle("daily-shopping-create-list", (e, args) => {
    try {
      const s = loadShopping(clockNow());
      const r = model.shoppingOp(s, { op: "create-list", name: args && args.name }, clockNow());
      if (r.ok) saveShopping(s);
      return r;
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  // Thumbnails: download the product image (same SSRF rules), shrink it, keep a small PNG under daily/thumbs/.
  async function makeThumbFor(imageUrl, id) {
    if (makeThumb) return makeThumb(imageUrl, id, thumbDir);
    const r = await linkmeta.guardedGet(imageUrl, "image/*");
    if (r.status >= 400 || !/^image\//i.test(String(r.headers["content-type"] || ""))) return "";
    const { nativeImage } = require("electron");
    const img = nativeImage.createFromBuffer(r.body);
    if (img.isEmpty()) return "";
    const sz = img.getSize();
    const small = img.resize(sz.width >= sz.height ? { width: 120 } : { height: 120 });
    fs.mkdirSync(thumbDir, { recursive: true });
    const name = `${id}.png`;
    fs.writeFileSync(path.join(thumbDir, name), small.toPNG());
    return name;
  }

  ipcMain.handle("daily-shopping", async (e, args) => {
    try {
      const a = args || {};
      const now = clockNow();
      const s = loadShopping(now);
      if (a.op === "share") {
        const l = model.findList(s, a.listId);
        return l ? { ok: true, text: model.shoppingShareText(l) } : { ok: false, reason: "That list no longer exists." };
      }
      if (a.op === "add-link") {
        if (!model.findList(s, a.listId)) return { ok: false, reason: "That list no longer exists." };
        const m = await getProduct(String(a.url || "").trim());
        if (m.rejected) return { ok: false, reason: m.reason };
        const op = { op: "add", listId: a.listId, addedBy: a.addedBy, fromLink: true, link: m.link, source: m.source, price: m.price };
        op.text = m.found && m.title ? m.title : `Link from ${m.source || "the web"}`;
        if (!m.found) op.detailsMissing = true;
        const s2 = loadShopping(now);   // re-read: the fetch took a while
        const r = model.shoppingOp(s2, op, now);
        if (!r.ok) return r;
        if (m.found && m.image) {
          try { const t = await makeThumbFor(m.image, r.item.id); if (t) r.item.thumb = t; } catch (err) { say(`thumbnail failed: ${err.message}`); }
        }
        saveShopping(s2);
        return { ok: true, detailsMissing: !!op.detailsMissing, reason: m.reason };
      }
      let thumb = null;
      if (a.op === "remove") { const l = model.findList(s, a.listId); const it = l && (l.items || []).find((x) => x.id === a.itemId); thumb = it && it.thumb; }
      const r = model.shoppingOp(s, a, now);
      if (r.ok) {
        saveShopping(s);
        if (thumb && /^[\w-]+\.png$/.test(thumb)) fs.promises.unlink(path.join(thumbDir, thumb)).catch(() => {});
      }
      return r.ok ? { ok: true } : r;
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle("daily-thumbs", async (e, names) => {
    const out = {};
    for (const n of (Array.isArray(names) ? names : []).slice(0, 100)) {
      if (!/^[\w-]+\.png$/.test(String(n))) continue;
      try { out[n] = "data:image/png;base64," + (await fs.promises.readFile(path.join(thumbDir, n))).toString("base64"); } catch (err) { /* missing thumb: shown without */ }
    }
    return out;
  });

  ipcMain.handle("daily-task-edit", async (e, args) => {
    try {
      const a = args || {};
      const change = { status: a.status || undefined, priority: a.priority || undefined };
      const { tasks, source } = await loadTasks(clockNow());
      const t = tasks.find((x) => x.id === a.id && x.agent === a.agent);
      if (!t) return { ok: false, reason: "That task is no longer open." };
      const cliArgs = model.taskEditArgs(t, change);   // validates the change
      if (source === "fixture") fixtureEdits.set(t.id, Object.assign({}, fixtureEdits.get(t.id), change));
      else await run(cliArgs);
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  // Voice: a new task through the same tasks.py runner the edits use (test mode: in-memory fixture, nothing is written).
  ipcMain.handle("daily-task-add", async (e, raw) => {
    try {
      const c = model.cleanNewTask(raw);
      if (c.error) return { ok: false, reason: c.error };
      const t = c.task;
      if (testMode && process.env.AGENT_DESKTOP_DAILY_REAL_TASKS !== "1") {
        const now = clockNow();
        fixtureAdded.push({ id: "v" + (fixtureAdded.length + 1), agent: t.agent, title: t.title, detail: "", status: "working", priority: t.priority, tags: t.tags, area: t.area, list: t.list, created: new Date(now).toISOString(), ageDays: 0 });
      } else await run(model.taskAddArgs(t));
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  // Own appointments (appointments.json). Placeholder/provider events are never written here.
  ipcMain.handle("daily-appointment-save", (e, raw) => {
    try {
      const c = model.cleanAppointment(raw || {}, { shareDefault: dc.sharePartnerDefault() });
      if (c.error) return { ok: false, reason: c.error };
      const d = readStore(f("appointments.json"), { items: [] }, notices, "Appointments");
      if (!Array.isArray(d.items)) d.items = [];
      if (d.items.length >= MAX_ITEMS && !d.items.some((x) => x && x.id === c.item.id)) return { ok: false, reason: "That list is full." };
      const i = d.items.findIndex((x) => x.id === c.item.id);
      if (i >= 0) d.items[i] = c.item; else d.items.push(c.item);
      writeJsonAtomic(f("appointments.json"), d);
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
  ipcMain.handle("daily-appointment-delete", (e, args) => {
    try {
      const d = readStore(f("appointments.json"), { items: [] }, notices, "Appointments");
      d.items = (d.items || []).filter((x) => x.id !== (args && args.id));
      writeJsonAtomic(f("appointments.json"), d);
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle("daily-dates-save", (e, raw) => {
    try {
      const c = model.cleanDate(raw || {});
      if (c.error) return { ok: false, reason: c.error };
      const d = readStore(f("dates.json"), { items: [] }, notices, "Birthdays & dates");
      if (!Array.isArray(d.items)) d.items = [];
      if (d.items.length >= MAX_ITEMS && !d.items.some((x) => x && x.id === c.item.id)) return { ok: false, reason: "That list is full." };
      const i = d.items.findIndex((x) => x.id === c.item.id);
      if (i >= 0) d.items[i] = c.item; else d.items.push(c.item);
      writeJsonAtomic(f("dates.json"), d);
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
  ipcMain.handle("daily-dates-delete", (e, args) => {
    try {
      const d = readStore(f("dates.json"), { items: [] }, notices, "Birthdays & dates");
      d.items = (d.items || []).filter((x) => x.id !== (args && args.id));
      writeJsonAtomic(f("dates.json"), d);
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
}

module.exports = { init, readJson, readStore, writeJsonAtomic, providers };
