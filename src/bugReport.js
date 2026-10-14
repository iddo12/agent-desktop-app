"use strict";
// "Report a problem" (v1.123.0): collect, scrub and write a bug report. PURE: no network, no child processes, no Electron.
// Everything that depends on this computer (versions, log lines, feature states, a terminal tail, a screenshot path) is handed in as `env`
// by the caller (src/bugReportMain.js in the app, tools/bug-report.js on the command line), so tests use temp dirs and fake values.
//
// What can ever be written (the allow-list, ALLOWED_NAMES below): report.md, app-log.txt, feature-states.txt, runtime.json,
// startup-timing.json, dep-doctor.json, app-config-reduced.json, diag-<fixed name>.txt, terminal-tail.txt, screenshot.<ext>.
// Never read: conversations, agent folders, credentials, mail, IRIS keys or messages.
// Every text that goes in passes through scrub() - one function, tested with planted fake secrets.

const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");

const LIMITS = { what: 4000, steps: 4000, jsonFile: 20000, logLines: 300, termLines: 20, lineChars: 600, shotBytes: 10 * 1024 * 1024 };
const SHOT_EXT = { ".png": 1, ".jpg": 1, ".jpeg": 1, ".gif": 1, ".webp": 1, ".bmp": 1 };
const STATUS_FILES = ["runtime.json", "startup-timing.json", "dep-doctor.json"];
const DIAG_LOGS = ["orphan-reaper.log", "stuck-turn-watchdog.log", "cmd-not-recognized.log"]; // small logs the app keeps itself
const ALLOWED_NAMES = new RegExp("^(?:report\\.md|app-log\\.txt|feature-states\\.txt|runtime\\.json|startup-timing\\.json|dep-doctor\\.json|app-config-reduced\\.json|terminal-tail\\.txt|screenshot\\.(?:png|jpg|jpeg|gif|webp|bmp)|diag-(?:" + DIAG_LOGS.map((n) => n.replace(/\./g, "\\.")).join("|") + ")\\.txt)$");

// Items shown in the dialog. always = cannot be turned off. files = what the item adds.
const ITEMS = [
  { id: "basics", always: true, files: ["report.md"] },
  { id: "status", always: true, files: ["runtime.json", "startup-timing.json", "dep-doctor.json"] },
  { id: "config", always: true, files: ["app-config-reduced.json"] },
  { id: "features", always: true, files: ["feature-states.txt"] },
  { id: "log", always: true, files: ["app-log.txt", "diag-orphan-reaper.log.txt", "diag-stuck-turn-watchdog.log.txt", "diag-cmd-not-recognized.log.txt"] },
  { id: "terminal", always: false, files: ["terminal-tail.txt"] },
  { id: "screenshot", always: false, files: ["screenshot.*"] },
];

// ---------------------------------------------------------------------------------------------------------------- scrubber
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAX_TEXT = 400000, MAX_LINE = 20000;

// Secret-named variables. The key is matched as a bounded candidate (<= 64 characters) and judged in JS, so no regex has two nested
// unbounded runs (an earlier version back-tracked cubically on "authauthauth...").
const SECRET_WORD = /pass(?:word|wd|phrase)|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token|credential|auth(?!ors?\b|entication|ority)/i;
const RE_KEYVAL = /([\w.-]{1,64})(["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;&}\]]+)/g;
const RE_FLAG = /(?<![\w-])(--?[\w-]{1,64})(\s+)(?!-)("[^"\r\n]*"|'[^'\r\n]*'|\S+)/g;
// secrets in a URL query string only (code=ENOENT, state=running, pass=true elsewhere are ordinary log text)
const RE_SIG = /(?<=[?&])((?:sig|signature|code|state|pass|x-amz-[\w-]+|access_token|refresh_token|id_token)=)[^&\s"'#]+/gi;
const RE_SIGPLAIN = /(?<![\w.-])((?:sig|signature)\s*[:=]\s*)[^\s"',;&]+/gi;
const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const OCT = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const RE_IPV4 = new RegExp("(?<![\\d.])" + OCT + "(?:\\." + OCT + "){3}(?![\\d]|\\.\\d)", "g");
const H = "[0-9a-fA-F]{1,4}";
const RE_IPV6 = new RegExp("(?<![\\w:])(?:(?:" + H + ":){7}" + H + "|(?:" + H + ":){1,7}:(?:" + H + "(?::" + H + "){0,6})?|::" + H + "(?::" + H + "){0,6})(?:%[\\w]+)?(?![\\w:])", "g");

const wholeToken = (w) => new RegExp("(?<![\\p{L}\\p{N}_])" + esc(w) + "(?![\\p{L}\\p{N}_])", "giu");

// An agent name is replaced only where it clearly IS the agent: inside a path, in quotes, next to the word "agent", or when the name is distinctive
// (has _ - a digit, an inner capital or a space). Plain words that happen to equal an agent name ("Security update", "Sales are up") stay readable.
function aliasContext(w, m, off, str) {
  if (/[_\-\d\s]|[a-z][A-Z]/.test(w)) return true;
  const before = str.slice(Math.max(0, off - 12), off), after = str.slice(off + m.length, off + m.length + 12);
  return /[\\/]$/.test(before) || /^[\\/]/.test(after) || (/["'`]$/.test(before) && /^["'`]/.test(after)) || /\bagents?[\s:=-]{1,3}$/i.test(before) || /^\s{0,2}agents?\b/i.test(after);
}

// scrub(text, ctx) -> text with secrets and personal identifiers replaced by placeholders.
// ctx = { user, host, homedir, names: [extra words to hide: owner, partner, domain, computer name], aliases: [[agent folder or display name, "agent-N"], ...] }
// Linear-time rules only; every line is cut at 20 000 characters first.
function scrub(text, ctx) {
  const c = ctx || {};
  let s = String(text == null ? "" : text);
  if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT) + "\n...(cut)";
  // PEM blocks span lines, so they go first
  s = s.replace(/-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]{0,30}PRIVATE KEY-----/g, "<private-key>");
  s = s.split("\n").map((line) => earlyPass(line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line)).join("\n");
  // agent names -> stable aliases (whole words only), then this computer's own names
  for (const pair of Array.isArray(c.aliases) ? c.aliases : []) {
    const w = String(pair && pair[0] != null ? pair[0] : "").trim();
    if (w.length >= 2) s = s.replace(wholeToken(w), (m, off, str) => (aliasContext(w, m, off, str) ? String(pair[1]) : m));
  }
  let homeBase = "";
  if (c.homedir && String(c.homedir).length >= 4) {
    const SEP = "[\\\\/]{1,2}";
    const parts = String(c.homedir).replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
    if (parts.length) {
      s = s.replace(new RegExp((/^[\\/]/.test(String(c.homedir)) ? SEP : "") + parts.map(esc).join(SEP), "gi"), "<userprofile>");
      homeBase = parts[parts.length - 1];
    }
  }
  const words = [c.user, c.host, homeBase].concat(Array.isArray(c.names) ? c.names : []).map((w) => String(w == null ? "" : w).trim()).filter((w) => w.length >= 2);
  for (const w of Array.from(new Set(words)).sort((a, b) => b.length - a.length)) {
    const label = w === c.host ? "<machine>" : "<name>";
    s = s.replace(w.length >= 4 ? new RegExp(esc(w), "gi") : wholeToken(w), label);
  }
  s = s.split("\n").map((line) => scrubLine(line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "...(cut)" : line, c)).join("\n");
  return s;
}

// Runs BEFORE the name and alias passes, so an address like jdoe@example.com disappears whole (not "<name>@example.com").
function earlyPass(s) {
  if (s.indexOf("://") >= 0) s = s.replace(/(\b[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@]+@/gi, "$1<credentials>@");           // scheme://user:password@host, scheme://token@host: any host
  s = s.replace(/(\b(?:smb|cifs|nfs|afp):\/\/(?:<credentials>@)?)[^\s/]+/gi, "$1<server>");   // file-server names
  if (s.indexOf("@") >= 0) s = s.replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, (m, dom) => (/^[0-9.]+$/.test(dom) ? m : "<email>"));   // pkg@1.2.3.4 is a version, not an address; anchored at the start of a run: linear
  return s;
}

function scrubLine(s, c) {
  // 1. whole-line headers: Authorization / Proxy-Authorization / Cookie / Set-Cookie
  s = s.replace(/((?:proxy-)?authorization|set-cookie|cookie)(["']?\s*[:=]\s*)[^\r\n]*/gi, "$1$2<redacted>");
  // 2. Bearer / Basic tokens anywhere
  s = s.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 <redacted>");
  // 4. well-known token shapes
  s = s.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{6,}/g, "<token>")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{6,}/g, "<token>")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "<token>")
    .replace(/\b[spr]k_(?:live|test)_[A-Za-z0-9]{4,}/g, "<token>")
    .replace(/\bxox[abprso]-[A-Za-z0-9-]{6,}/g, "<token>")
    .replace(/\bnpm_[A-Za-z0-9]{16,}/g, "<token>")
    .replace(/\bGOCSPX-[A-Za-z0-9_-]{8,}/g, "<token>")
    .replace(/\bya29\.[A-Za-z0-9_-]{8,}/g, "<token>")
    .replace(/\b1\/\/[A-Za-z0-9_-]{20,}/g, "<token>")
    .replace(/\bSG\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<token>")
    .replace(/\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, "<token>")
    .replace(/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, "hooks.slack.com/services/<token>")
    .replace(/\bAKIA[0-9A-Z]{12,}/g, "<token>")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "<token>")
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, "<token>");
  // 5. secret-named variables: key=value / "key": "value" (SECRET_KEY, authKey, DB_PWD, ...), --flag value, query-string secrets
  if (/[:=]/.test(s)) s = s.replace(RE_KEYVAL, (m, k, sep) => (SECRET_WORD.test(k) ? k + sep + "<redacted>" : m));
  if (s.indexOf("-") >= 0) s = s.replace(RE_FLAG, (m, k, ws) => (SECRET_WORD.test(k) ? k + ws + "<redacted>" : m));
  s = s.replace(RE_SIG, "$1<redacted>").replace(RE_SIGPLAIN, "$1<redacted>");
  // 7. paths: user profiles (a folder name may hold spaces or non-Latin letters; the segment ends at the next separator), WSL, UNC, URL-encoded
  s = s.replace(/[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/"'|:*?\r\n]+?(?=[\\/])/gi, "<userprofile>")
    .replace(/[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s"'|:*?]+/gi, "<userprofile>")
    .replace(/\/(?:Users|home)\/[^\\/\s"'<>|:*?]+/g, "<userprofile>")
    .replace(/[A-Za-z]%3A(?:%5C|%2F)Users(?:%5C|%2F)(?:(?!%5C|%2F)[^\s"'<>&?#])+/gi, "<userprofile>")
    .replace(/(\\\\wsl(?:\$|\.localhost))\\([^\\\s]+)\\home\\[^\\\s"']+/gi, "$1\\<distro>\\home\\<user>")
    .replace(/(?<![\w:.\\/$])\\{2,4}(?![?.\\])[^\\/\s"'<>|:*?]+\\{1,2}[^\\/\s"'<>|:*?]+/g, (m) => (/^\\\\(?:<|wsl)/i.test(m) ? m : "\\\\<server>\\<share>"));
  // 8. hardware and network identifiers: MAC, IPv6 (not ::1), IPv4 (not 127.0.0.1 / 0.0.0.0)
  s = s.replace(/(?<![0-9a-fA-F:-])[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5}(?![0-9a-fA-F:-])/g, "<mac>")
    .replace(RE_IPV6, (m) => (m === "::1" || m === "::" ? m : "<ip>"))
    .replace(RE_IPV4, (m, off, str) => (m === "127.0.0.1" || m === "0.0.0.0" || /(?:\bv|\/|@|\b(?:version|build|electron|chrome|node|npm|release|claude code)\s)$/i.test(str.slice(Math.max(0, off - 12), off)) ? m : "<ip>"));
  // 9. phone-number-like and card-like sequences (international +NN..., local 0NN-NNN-NNNN, 4x4 digits); versions and timestamps do not match
  s = s.replace(/(?<![\w.+])\+\d[\d\s().-]{7,}\d(?![\w])/g, "<phone>")
    .replace(/(?<![\w.-])0\d{1,2}[-\s]\d{3}[-\s]?\d{4}(?![\w-])/g, "<phone>")
    .replace(/(?<![\d-])\d{4}(?:[ -]\d{4}){3}(?![\d-])/g, "<number>");
  // 9b. UUIDs (session ids ...) are not secrets: each distinct one becomes a stable <id-N> within one report, so lines stay correlatable
  const ids = c && c.uuids ? c.uuids : (c ? (c.uuids = new Map()) : new Map());
  s = s.replace(RE_UUID, (m) => { const k = m.toLowerCase(); if (!ids.has(k)) ids.set(k, ids.size + 1); return "<id-" + ids.get(k) + ">"; });
  // 10. long hex / base64 / base64url strings (>= 24 chars): keys, hashes, tokens nobody listed above
  s = s.replace(/[A-Za-z0-9+/_=-]{24,}/g, (m) => {
    const body = m.replace(/=+$/, "");
    if (body.length < 24) return m;
    const hasDigit = /\d/.test(body), hasLetter = /[A-Za-z]/.test(body), hasUp = /[A-Z]/.test(body), hasLow = /[a-z]/.test(body);
    if (/^[0-9a-fA-F]+$/.test(body)) return "<secret-like>";
    if (hasDigit && hasLetter) return "<secret-like>";
    if (hasUp && hasLow && !/[/-]/.test(body) && body.length >= 32) return "<secret-like>";
    return m;
  });
  return s;
}

const tailLines = (text, n) => { const l = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n"); while (l.length && l[l.length - 1] === "") l.pop(); return l.slice(-n); };
const cap = (s, n) => (s.length > n ? s.slice(0, n) + "\n...(cut)" : s);
const cutLine = (l) => (l.length > LIMITS.lineChars ? l.slice(0, LIMITS.lineChars) + "...(cut)" : l);

// Scrub a parsed JSON value leaf by leaf (keys and strings), so the result is still valid JSON. A secret-named key loses its whole value.
const SECRET_NAME = /pass|secret|token|credential|api[_-]?key|private[_-]?key|cookie|authorization/i;
function scrubDeep(v, ctx, key) {
  if (v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => scrubDeep(x, ctx, key));
  if (typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[scrub(k, ctx)] = scrubDeep(v[k], ctx, k); return o; }
  if (typeof v === "string") return key && SECRET_NAME.test(String(key)) && !/^\((?:not )?set\)$|^(?:yes|no)$/.test(v) ? "<redacted>" : scrub(v.length > LIMITS.jsonFile ? v.slice(0, LIMITS.jsonFile) : v, ctx);
  return v;
}
// JSON text from the app's own files: scrubbed leaf by leaf when it parses (still valid JSON), as plain text when it does not.
function scrubJsonText(raw, ctx) {
  try { return JSON.stringify(scrubDeep(JSON.parse(raw), ctx), null, 2) + "\n"; } catch (e) { return scrub(raw, ctx); }
}

// ------------------------------------------------------------------------------------------------- app-config.json reduced
const SECRET_KEY = /pass|secret|token|key|auth|credential|cookie|pair|seal|nonce/i;
const CONSENT_KEY = /consent/i;
const looksLikePath = (v) => /^[A-Za-z]:[\\/]/.test(v) || /^[\\/]/.test(v) || /^~/.test(v);
// A path value keeps only its last folder name (the rest could hold family, company or agent names); network paths become a fixed word.
const reducePath = (v) => { if (/^[\\/]{2}/.test(v)) return "(network path)"; const seg = v.split(/[\\/]+/).filter(Boolean); return seg.length ? "\\...\\" + seg[seg.length - 1] : "(set)"; };

// Paths keep only their last folder name (no drive letter); secret-named keys become "(set)" / "(not set)"; consent times become yes/no;
// every other free text becomes "(set)" (it could be a name); numbers and booleans stay.
function reduceConfig(value, key) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((x) => reduceConfig(x, key));
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = reduceConfig(value[k], k);
    return out;
  }
  const k = String(key || "");
  if (CONSENT_KEY.test(k)) return value ? "yes" : "no";
  if (SECRET_KEY.test(k)) return value ? "(set)" : "(not set)";
  if (typeof value === "string") {
    if (!value) return "(not set)";
    if (looksLikePath(value)) return reducePath(value);
    return /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(value) ? value : "(set)"; // language codes stay; any other text could be a name
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------- build
// Reads at most maxBytes (the start, or the end when tail is true): a huge file never gets loaded whole.
function readSmall(file, maxBytes, tail) {
  let fd = null;
  try {
    const st = fs.statSync(file); if (!st.isFile()) return null;
    const n = Math.min(st.size, maxBytes || 200000), buf = Buffer.alloc(n);
    fd = fs.openSync(file, "r"); fs.readSync(fd, buf, 0, n, tail ? st.size - n : 0);
    return buf.toString("utf8");
  } catch (e) { return null; } finally { if (fd != null) { try { fs.closeSync(fd); } catch (x) { /* closed */ } } }
}

function validShot(p) {
  if (typeof p !== "string" || !p) return { ok: false, error: "screenshot-missing" };
  const ext = path.extname(p).toLowerCase();
  if (!SHOT_EXT[ext]) return { ok: false, error: "screenshot-type" };
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { ok: false, error: "screenshot-missing" };
    if (st.size > LIMITS.shotBytes) return { ok: false, error: "screenshot-too-big" };
    return { ok: true, ext, size: st.size };
  } catch (e) { return { ok: false, error: "screenshot-missing" }; }
}

// build(input, env) -> { ok, files: [{ name, item, text?, data: Buffer }], createdAt } (nothing is written yet; this IS the preview)
// input = { what, steps, include: { terminal: bool, screenshot: bool } }
// env   = { userDataDir, appVersion, gitCommit, claudeVersion, windows, ramGb, nodeVersion, electronVersion, user, host, names,
//           featureStates: [{ id, title, state, reason }], appLog: [lines], terminalTail: string, terminalAgent: string, screenshotPath, now: Date }
function build(input, env) {
  const inp = input || {}, e = env || {};
  const ctx = { user: e.user != null ? e.user : (() => { try { return os.userInfo().username; } catch (x) { return ""; } })(), host: e.host != null ? e.host : os.hostname(), homedir: e.homedir != null ? e.homedir : (() => { try { return os.homedir(); } catch (x) { return ""; } })(), names: e.names, aliases: e.aliases };
  const S = (t) => scrub(t, ctx);
  const inc = inp.include || {};
  const files = [];
  const add = (name, item, text) => { if (!ALLOWED_NAMES.test(name)) throw new Error("not on the allow-list: " + name); files.push({ name, item, text, data: Buffer.from(text, "utf8") }); };
  const what = S(String(inp.what == null ? "" : inp.what).slice(0, LIMITS.what));
  const steps = S(String(inp.steps == null ? "" : inp.steps).slice(0, LIMITS.steps));
  const when = e.now instanceof Date ? e.now : new Date();

  // screenshot first, so a bad file stops the whole report before anything is built
  let shot = null;
  if (inc.screenshot) {
    const v = validShot(e.screenshotPath);
    if (!v.ok) return { ok: false, error: v.error };
    shot = { ext: v.ext === ".jpeg" ? ".jpg" : v.ext, data: fs.readFileSync(e.screenshotPath) };
  }
  const included = ["report.md", "runtime.json", "startup-timing.json", "dep-doctor.json", "app-config-reduced.json", "feature-states.txt", "app-log.txt"];
  if (inc.terminal) included.push("terminal-tail.txt");
  if (shot) included.push("screenshot" + shot.ext);

  add("report.md", "basics", [
    "# Agent Desktop bug report", "",
    "- Created: " + when.toISOString(),
    "- Agent Desktop version: " + S(e.appVersion || "(unknown)"),
    "- Git commit of this copy: " + S(e.gitCommit || "(not available)"),
    "- Windows: " + S(e.windows || (os.release() + " (" + os.arch() + ")")),
    "- RAM: " + (e.ramGb != null ? e.ramGb : Math.round(os.totalmem() / 1e9)) + " GB",
    "- Node: " + S(e.nodeVersion || process.version),
    "- Electron: " + S(e.electronVersion || "(not in the app)"),
    "- Claude Code: " + S(e.claudeVersion || "(not available)"),
    "", "## What went wrong", what || "(not given)",
    "", "## What I did before it happened", steps || "(not given)",
    "", "## Files in this report", ...included.map((n) => "- " + n),
    "", "Nothing in this report was uploaded anywhere. Names, e-mail addresses, tokens, long keys, private network addresses and your user folder were replaced by placeholders.", "",
  ].join("\n"));

  for (const n of STATUS_FILES) {
    const raw = e.userDataDir ? readSmall(path.join(e.userDataDir, n), LIMITS.jsonFile + 1) : null;
    add(n, "status", raw == null ? "(not found)\n" : scrubJsonText(cap(raw, LIMITS.jsonFile), ctx));
  }
  let cfgText = "(not found)\n";
  const rawCfg = e.userDataDir ? readSmall(path.join(e.userDataDir, "app-config.json"), 200000) : null;
  if (rawCfg != null) { try { cfgText = JSON.stringify(scrubDeep(reduceConfig(JSON.parse(rawCfg)), ctx), null, 2) + "\n"; } catch (x) { cfgText = "(could not be read)\n"; } }
  add("app-config-reduced.json", "config", cfgText);

  const fs2 = Array.isArray(e.featureStates) ? e.featureStates : [];
  add("feature-states.txt", "features", S(fs2.length ? fs2.map((f) => (f.id || "?") + ": " + (f.state || "?") + (f.reason ? " - " + f.reason : "")).join("\n") : "(none)") + "\n");

  add("app-log.txt", "log", (S(tailLines((e.appLog || []).join("\n"), LIMITS.logLines).join("\n")).split("\n").map(cutLine).join("\n") || "(empty)") + "\n");
  for (const n of DIAG_LOGS) {
    const raw = e.userDataDir ? readSmall(path.join(e.userDataDir, n), 100000, true) : null;
    if (raw != null) add("diag-" + n + ".txt", "log", S(tailLines(raw, 100).join("\n")).split("\n").map(cutLine).join("\n") + "\n");
  }
  if (inc.terminal) {
    const t = tailLines(e.terminalTail || "", LIMITS.termLines).map(cutLine).join("\n");
    add("terminal-tail.txt", "terminal", "Last " + LIMITS.termLines + " lines of the terminal of: " + S(e.terminalAgent || "(one agent)") + "\n\n" + S(t || "(empty)") + "\n");
  }
  if (shot) { const name = "screenshot" + shot.ext; if (!ALLOWED_NAMES.test(name)) throw new Error("not on the allow-list: " + name); files.push({ name, item: "screenshot", data: shot.data }); }
  return { ok: true, files, createdAt: when.toISOString() };
}

// What the dialog's Preview shows: the very text that will be written (the screenshot is shown by name and size only).
function previewOf(bundle) {
  return (bundle.files || []).map((f) => (f.text != null ? { name: f.name, item: f.item, text: f.text } : { name: f.name, item: f.item, text: null, bytes: f.data.length }));
}

// ---------------------------------------------------------------------------------------------------------------- zip
let CRC = null;
function crc32(buf) {
  if (!CRC) { CRC = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; } }
  let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function dosTime(d) {
  const t = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const dt = (((Math.max(d.getFullYear(), 1980) - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { t, d: dt };
}
// entries: [{ name, data }] -> Buffer (deflate; names UTF-8, forward slashes)
function makeZip(entries, when) {
  const dt = dosTime(when instanceof Date ? when : new Date());
  const locals = [], centrals = []; let off = 0;
  for (const en of entries) {
    const name = Buffer.from(en.name, "utf8"), raw = en.data, def = zlib.deflateRawSync(raw), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dt.t, 10); lh.writeUInt16LE(dt.d, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(def.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dt.t, 12); ch.writeUInt16LE(dt.d, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(def.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, def); centrals.push(ch, name); off += 30 + name.length + def.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
// readZip(buf) -> [{ name, data }]  (only what makeZip writes; used by the tests and by a "verify" step after writing)
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip");
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString("utf8");
    const lnl = buf.readUInt16LE(lo + 26), lel = buf.readUInt16LE(lo + 28), start = lo + 30 + lnl + lel;
    const comp = buf.slice(start, start + csize); const data = method === 8 ? zlib.inflateRawSync(comp) : comp;
    if (crc32(data) !== crc) throw new Error("crc mismatch: " + name);
    out.push({ name, data }); p += 46 + nl + el + cl;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- destination folder
// The folder the person chose. Must be a plain absolute local path: no "..", no network share (UNC), no device path (\\?\ \\.\ NUL...), must exist.
function validateDestDir(p) {
  if (typeof p !== "string" || !p || p.length > 500 || /[\0\r\n]/.test(p)) return { ok: false, error: "invalid-folder" };
  if (/^[\\/]{2}/.test(p)) return { ok: false, error: "invalid-folder" };                                  // UNC, \\?\, \\.\
  if (!path.isAbsolute(p)) return { ok: false, error: "invalid-folder" };
  if (p.split(/[\\/]+/).some((seg) => seg === "..")) return { ok: false, error: "invalid-folder" };
  if (/(^|[\\/])(?:con|prn|aux|nul|com\d|lpt\d)(?:\.[^\\/]*)?([\\/]|$)/i.test(p)) return { ok: false, error: "invalid-folder" }; // reserved device names
  if (process.platform === "win32" && /:/.test(p.replace(/^[A-Za-z]:/, ""))) return { ok: false, error: "invalid-folder" };   // alternate data streams
  const norm = path.resolve(p);
  try { if (!fs.statSync(norm).isDirectory()) return { ok: false, error: "folder-missing" }; } catch (e) { return { ok: false, error: "folder-missing" }; }
  return { ok: true, dir: norm };
}

// write(bundle, destDir) -> { ok, dir, zip, files: [names] }: ONE folder bug-report-<stamp> and ONE zip beside it. Only allow-listed names are written.
function write(bundle, destDir, opts) {
  const F = (opts && opts.fs) || fs;   // tests inject a file system that fails for chosen paths (Windows Controlled Folder Access)
  if (!bundle || !bundle.ok) return { ok: false, error: "nothing-to-write" };
  const v = validateDestDir(destDir);
  if (!v.ok) return v;
  for (const f of bundle.files) if (!ALLOWED_NAMES.test(f.name)) return { ok: false, error: "not-allowed-file" };
  const stamp = String(bundle.createdAt || new Date().toISOString()).replace(/[:T]/g, "-").slice(0, 16);
  let base = "bug-report-" + stamp, n = 1;
  while (F.existsSync(path.join(v.dir, base)) || F.existsSync(path.join(v.dir, base + ".zip"))) base = "bug-report-" + stamp + "-" + (++n);
  const dir = path.join(v.dir, base), zip = dir + ".zip";
  try {
    F.mkdirSync(dir);
    for (const f of bundle.files) F.writeFileSync(path.join(dir, f.name), f.data);
    F.writeFileSync(zip, makeZip(bundle.files.map((f) => ({ name: base + "/" + f.name, data: f.data })), new Date(bundle.createdAt || Date.now())));
  } catch (e) {
    try { F.rmSync(dir, { recursive: true, force: true }); } catch (x) { /* nothing half-written is left behind when it can be helped */ }
    return { ok: false, error: "cannot-write", hint: e && (e.code === "EPERM" || e.code === "EACCES" || e.code === "EBUSY") ? "blocked-by-windows" : undefined };
  }
  return { ok: true, dir, zip, files: bundle.files.map((f) => f.name) };
}

module.exports = { scrub, reduceConfig, build, previewOf, write, makeZip, readZip, validateDestDir, validShot, ITEMS, ALLOWED_NAMES, LIMITS, STATUS_FILES, DIAG_LOGS };
