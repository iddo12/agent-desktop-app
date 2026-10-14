#!/usr/bin/env node
// wake-agent command-line tool - how the COO or the Security agent asks the running Agent Desktop to start/wake an agent.
// The app does every check (caller, wakeable list, never-wake list, fleet throttle, rate limit) and logs the request to
// shared_reports\coo\wake_log.jsonl.
//
//   node "<Agent Desktop folder>\tools\wake-agent.js" --agent "Marketing Agent" --reason "Please run your weekly report"
//   node "<Agent Desktop folder>\tools\wake-agent.js" --agent "SEO Agent" --reason "..." --owner-requested   (only when the owner really asked)
//   node "<Agent Desktop folder>\tools\wake-agent.js" --ping
//   add --test to talk to the sandbox instance
// Always run it with node and the FULL path of this file as the first argument (no node options before it, no relative
// path): Agent Desktop accepts only exactly that command line as a wake request.
//
// Identity: there is no token and no --as switch. The tool sends only its own process id; Agent Desktop reads this
// process's command line (that is where it takes agent / reason / --owner-requested from) and walks its parent processes
// up to the COO's or the Security agent's own `claude --bg` session. Run it from that session (its Bash tool) - from
// anywhere else it is refused as "unverified-caller".
// Exit code 0 = woken (or already working), 1 = refused / failed. Prints the JSON result.
const fs = require("fs");
const path = require("path");
const net = require("net");

const args = process.argv.slice(2);
const isTest = args.includes("--test");
function opt(name) { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; }
function out(o, code) { console.log(JSON.stringify(o)); process.exit(code); }
function fail(reason) { out({ ok: false, refused: false, reason }, 1); }

if (args.includes("--as")) fail("--as is not supported: Agent Desktop identifies the caller from the process tree");
const ping = args.includes("--ping");
if (!ping && !opt("agent")) fail("--agent is required");
if (!ping && !opt("reason")) fail("--reason is required");

const appData = process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming");
const dir = process.env.WAKE_AGENT_DIR || path.join(appData, isTest ? "agent-desktop-test" : "agent-desktop", "wake");
let pipeName;
try { pipeName = fs.readFileSync(path.join(dir, "pipe-name"), "utf8").trim(); } catch (e) { fail("can't find the wake pipe name - is Agent Desktop (v1.96.0+) running?"); }

const sock = net.createConnection(pipeName);
let buf = "";
sock.setTimeout(160000, () => fail("timed out talking to Agent Desktop"));
sock.on("error", (e) => fail(`Agent Desktop isn't reachable (${e.code || e.message})`));
sock.on("connect", () => sock.write(JSON.stringify({ pid: process.pid }) + "\n"));
sock.on("data", (d) => { buf += d.toString("utf8"); });
sock.on("end", () => {
  let res;
  try { res = JSON.parse(buf.trim()); } catch (e) { return fail("bad reply from Agent Desktop"); }
  out(res, res.ok ? 0 : 1);
});
