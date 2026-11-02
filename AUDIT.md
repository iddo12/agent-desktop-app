# Security and bug audit (branch `claude/audit-fixes`)

Scope: main process, IPC and preload, local servers and pipes, file and path handling, command execution, untrusted text
(transcripts, mail, other agents), secrets, Electron hardening. Method: code reading by area (renderer, main/IPC/paths, network/untrusted
input); each fixed finding was re-read in the code before changing it. Nothing was run in a real Electron/Windows session, so
Windows-only behaviour (`cmd.exe`, ConPTY) is argued from the code, not reproduced.

**Baseline hardening that is already good:** `contextIsolation: true`, `nodeIntegration: false`, no generic `ipcRenderer` in the preload,
strict CSP (`script-src 'self'`), `will-navigate`/`will-redirect` blocked, `window.open` https-only, `execFile`/`spawn` with argument arrays
nearly everywhere, `safeStorage` for Gmail/IMAP/shipment secrets, SSRF guards on research images and link metadata, `openPath.js` and
`agentDocs.js` (extension allow-list, realpath, root checks), IRIS crypto/gateway, wake-agent caller check.

## Fixed in this branch

| # | Sev | Where | Problem / failure scenario | Fix |
|---|-----|-------|----------------------------|-----|
| F1 | High (Windows) | `src/main.js` `dispatchBackgroundAgentImpl` (`resumeSessionId`, `initialPrompt`), `startTerminalSessionInner` (`knownAgentId`) | `claude` is a `.cmd`, so spawns go through `cmd.exe /d /c`. node-pty only quotes args containing whitespace. A renderer-supplied `resumeSessionId`/`knownAgentId` such as `a&calc.exe`, or a one-word prompt `x&calc`, runs a command. Needs a compromised renderer or a forged IPC call. | `src/argGuard.js`: ids must match `[A-Za-z0-9][A-Za-z0-9_-]{0,99}`; a prompt with no whitespace has `& \| < > ^ % ! ( )` replaced by spaces (prompts with spaces are untouched). |
| F2 | High | `src/voice-main.js` `voice-transcribe` | `file` is a renderer path that was read and, if the local engine fails, uploaded to Cloudflare (and passed to whisper-cli). Any readable file (keys, cookies) can be exfiltrated. | `file` accepted only if it is a `.wav` inside the voice-recordings folder. |
| F3 | Med | `src/archive.js` `readArchivedDay` | `dateKey` is split into path segments: `../../x-y-z` reads any `<day>.md` and `mkdir -p`s directories. | Require `YYYY-MM-DD` before touching disk. |
| F4 | Med | `src/renderer/library.js` viewer iframe | Library viewer can show agent-written `.html`; the iframe had no `sandbox`, and a `file://` child frame does not inherit the page CSP, so scripts in it can load remote resources. (agent-docs already sandboxed.) | `sandbox=""` for everything except PDF (the PDF plugin needs none). Behaviour change: scripts inside HTML reports no longer run in the Library viewer. |
| F5 | Low | `src/main.js` `save-pasted-image` | `ext` is spliced into the file name: `/../../x.bat` escapes the temp folder (arbitrary-extension file write). The app itself only sends MIME-derived extensions. | `ext` must be 1-5 alphanumerics, else `png`. |
| F6 | Low | `src/main.js` context menu | "Open Link in Browser" passed any scheme (`file:`, `ms-msdt:`, custom protocols) to `shell.openExternal`. | Only `http`, `https`, `mailto`; entry disabled otherwise. |
| F7 | Low | `src/iris/main-iris.js` pipe | A request line `null` made `req.token` throw inside an async handler (unhandled rejection, socket held open). | Non-object requests destroy the socket. |
| F8 | Low | `src/iris/service.js` | After `listen`, the TCP server had no `error` listener (a later accept error, e.g. EMFILE, is an uncaught exception in main); `_pumpDirect()` was called un-awaited without `.catch` (unhandled rejection if a save throws). | Permanent `error` listener that logs; `.catch(() => {})` on all four `_pumpDirect` calls. |
| F9 | Med | `src/daily/linkmeta.js` (`metaContent`, `jsonLdBlocks`), `src/contacts/logos.js` (`<link`) | Regexes with unbounded `[^>]*` over up to 2 MB of attacker HTML are quadratic on many unclosed `<meta`/`<link` openers: main process freezes for seconds or more when adding a product by link / fetching a sender's logo. A 100k-opener page took about 5 s even with a length bound. | Tag bodies are `[^<>]{0,2000}` (fails at the next `<`, so linear). Test: 100k openers parse in under 3 s. Tags whose attribute values contain a literal `<` no longer match (rare; text is tag-stripped anyway). |

Tests: new `tests/auditFixes.test.js` (added to `npm test`) covers F1 validators, F2/F3 confinement helpers, F3 no-mkdir, F9 timing.
`argGuard.js` is about 25 lines and is only required when the affected code runs, so startup is unchanged.

## Not fixed (needs a decision, or changes behaviour)

| Sev | Where | Problem / failure scenario | Suggested fix |
|-----|-------|----------------------------|---------------|
| High (design) | `src/phemeDelivery.js` `sendToSelected`, `renderer.js` `phemeSend` | Any same-user process with the static token in `<userData>\pheme\local-token` (e.g. a prompt-injected agent with Bash/Read) can type text into the on-screen agent as the owner. No label, and `!cmd` / `/cmd` are accepted. Mail to agent A to agent B with owner authority. | Reject leading `!`/`/` on the pipe path; prefix pipe text with a visible marker; rotate the token per start; check caller by process ancestry like `wakeAgent.js`. Left because it changes how dictation works. |
| Med-High | ~25 handlers in `main.js` (`start-terminal`, `switch-conversation`, `list-/rename-conversation`, `update-agent`, `set-agent-paused`, duplicate-copies, `terminal-input`...) | `agentPath` is trusted. `sessionCwdFor` does `mkdir .claude-session` in any directory, `update-agent` writes `agent_config.json`/`avatar.png` into any existing directory, `start-terminal` starts `claude --bg` there (Claude's trust prompt is the only gate). Needs a compromised renderer. | One `assertAgentPath()` (resolve, `dirname === realpath(AGENTS_ROOT)`, exists) at the top of each handler. Not done: many call sites, risk of rejecting legitimate paths (sandbox roots, case on Windows). |
| Med | `src/registry.js` `registryAction` open/openPdf/openOlder | `shell.openPath` on any extension and any local path from an agent-writable registry JSON (`.bat`, `.lnk`, `.hta`, `x.pdf.exe`); only apk/aab/ipa denied. | Route through `pathOpener.open()` (roots, allow-list, realpath). |
| Med | `src/argus-data.js` `argus-open-source` | Opens any path found in agent-writable `status/*.json`, including UNC (NTLM leak, long freeze) and executables. | Same: `pathOpener.open()`, plus `isPlainLocalPath`. |
| Med | `src/setupMain.js` / `appConfig.js` `config-set-feature` | Renderer can set `pythonExe`/`nodeExe`/`claudeExe`/`whisperExe` and `*.py` tool paths without a dialog; next use runs them. | Accept exec paths only from a main-process dialog result, or confirm natively. |
| Med | `src/app-update.js` | Git self-update fast-forwards to whatever `origin/<channel>` holds; no signature check, no check that `origin` is `updateRepo`; merge runs checkout hooks. | Verify `origin` URL equals `https://github.com/<updateRepo>`; `git verify-commit` against pinned signers. |
| Low-Med | `src/pathLinks.js` / `openPath.js` | Allow-list for opening includes `html`, `htm`, `svg`, `xml`, `doc`, `xls`, `rtf`, `ppt`; `agentDocs.js` deliberately excludes them. | Align the two lists. |
| Low-Med | `delete-agent` / `agents.js deleteAgent` | Deletes any direct child of the agents root, which includes `shared_state`, `shared_registry`, `shared_tools`. Type-the-name gate is renderer-side only. Comparison is case-sensitive (fails closed on Windows). | Require the folder to be a listed agent; case-insensitive compare on win32; refuse symlinks/junctions. |
| Low-Med | `create-agent` / `update-agent` `avatarPath` | Reads any file; it is copied to `avatar.png` and returned as a data URL. `config.avatar` (agent-writable) is joined to the agent dir unchecked. | Accept only the path returned by `pick-avatar`; check magic bytes and size; basename-only `config.avatar`. |
| Low-Med | `renderer` / `index.html` CSP | `frame-src` allows `file:` and `data:`; F4 limits the impact. | Drop `data:` (and `file:` if the viewers can use a narrower source). |
| Low-Med | `wakeAgent.js`, `guards-main.js`, `renderer/guards.js`, `outbox.js` | `[[HANDOFF-RESUME]]`, `[[KEEPGOING]]`, `[hid:..]` markers are matched anywhere in text and are forgeable (a wake note or tool output containing the marker can make the handoff flow mark itself done, or hide a message from the unsent ledger). No nonce. | Reject `[[` / `[hid:` in wake reasons; add a nonce to the resume marker; verify only against `type:"user"` entries. |
| Low-Med | `iris/service.js` `_flushOnce` | Outbox is flushed sequentially: an unreachable peer costs up to 10 s per item and delays every other peer; pipe handlers await the flush. | Per-peer concurrency and skip after first connect failure. |
| Low-Med | `daily/gmail.js` `readAccounts` | Returns `[]` on any decrypt/parse error; adding an account then overwrites the file and loses other accounts' refresh tokens. | Copy the `unreadable` guard from `daily/imap.js`. |
| Low | `contacts/logos.js` private-address guard | Misses hex IPv4-mapped IPv6, `fe80::/10` beyond `fe80`, 198.18/15, NAT64/6to4. HTTPS + cert check limits impact. | Reuse `isPrivateAddress` from `research/images.js`. |
| Low | `contacts/mailsearch.js` | Token sent in clear to fixed loopback port 48766; another local process could bind it first. | Named pipe / challenge-response. |
| Low | `daily/linkmeta.js` price fallback | `<script[\s\S]*?<\/script>` strip can still be quadratic on many unclosed `<script`. | `indexOf` loop. |
| Low | `iris/service.js` `join()` | Hello sent to any private IP and port from a pasted invite, including 169.254.169.254. | Restrict ports; drop link-local. |
| Low | `main.js` core handlers | ~90 handlers have no sender/frame check (feature modules do). Mitigated: one window, preload not exposed to sub-frames. | Wrap `ipcMain.handle/on` once with a main-window guard. |
| Low | `read-long-message`, other `readFileSync` | No realpath; a junction under the temp folder escapes the prefix check. | `realpathSync` before the prefix check. |
| Low | `iris/local-token`, `daily/calendar.js` secret iCal URL | Stored in plaintext (other secrets use `safeStorage`). | Store via `safeStorage`. |
| Low | `voice-main.js` | `voice-transcribe`/`voice-save` have no sender check or size cap; Cloudflare fetch has no timeout. | Size cap, `AbortSignal.timeout(60000)`. |
| Low | `wakeWatcherMain.js:80` | Marker files carry a self-declared `hop`; resets loop protection (rate caps still apply). | Derive hop from app-written records. |
| Low | `create-agent` name | Sanitiser keeps `..`; blocked only by the "folder has files" check. | Reject names made only of dots. |
| Note | renderer links | Link text can differ from target (spoofing only). Agent text can display any local image by path (privacy only). IRIS audit log has no retention limit. | Show host in link title; add retention. |

## Tests

`npm test` is one `&&` chain and stops at the first failure, so each listed test file was run on its own, before and after.
- Before the changes: 116 pass, 18 fail (`tools`, `tools-fixes`, `agentDocs`, `finance`, `finance-feed`, `agentDocsPanel`, `research-mag`, `wake-agent`, `perfPass`, `clickablePaths`, `registryCache`, `phemeDelivery`, `pchealth-main`, `areaTools`, `areaLibrary`, `cfgRoles`, `hardening`, `bugReport`). The ones inspected assert Windows paths (`launcher: ... UNC and device paths`) and fail on Linux; the rest were not individually investigated.
- After: the same 18 fail, plus `tests/auditFixes.test.js` passes. One full run showed `tests/iris.test.js` failing once; it passes 3 of 3 on rerun and is a real-socket/timing test, so treat it as a flake.
