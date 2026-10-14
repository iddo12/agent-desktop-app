// Test fixture for tests/wake-agent.test.js: builds a REAL process tree shaped like a Claude Code background session.
//   node wake-tree.js --bg-pty-host \\.\pipe\cc-daemon-test-pty-<id> 80 24 -- <session-id> <cli args...>
//     -> node wake-tree.js --session-id <session-id> <cli args...>      (the "session" process)
//       -> node ../../tools/wake-agent.js <cli args...>                 (the CLI, as the session's Bash tool would run it)
// The session process writes its own pid to WAKE_TREE_PID_FILE before starting the CLI. stdio is inherited all the way down,
// so the CLI's JSON result reaches the test.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
if (argv[0] === "--bg-pty-host") {
  const dd = argv.indexOf("--");
  const sid = argv[dd + 1];
  const rest = argv.slice(dd + 2);
  const p = spawn(process.execPath, [__filename, "--session-id", sid, ...rest], { stdio: "inherit", env: process.env });
  p.on("exit", (code) => process.exit(code == null ? 1 : code));
} else if (argv[0] === "--session-id") {
  if (process.env.WAKE_TREE_PID_FILE) fs.writeFileSync(process.env.WAKE_TREE_PID_FILE, String(process.pid));
  // WAKE_TREE_DELAY_MS: time for a sandbox script to register this session before the CLI connects
  setTimeout(() => {
    const cli = path.join(__dirname, "..", "..", "tools", "wake-agent.js");
    // WAKE_TREE_LOOKALIKE=1: run a look-alike instead (`node wake-tree.js --lookalike <cli path> <args>`), which connects with its own pid
    const run = process.env.WAKE_TREE_LOOKALIKE ? [__filename, "--lookalike", cli, ...argv.slice(2)] : [cli, ...argv.slice(2)];
    const p = spawn(process.execPath, run, { stdio: "inherit", env: process.env });
    p.on("exit", (code) => process.exit(code == null ? 1 : code));
  }, Number(process.env.WAKE_TREE_DELAY_MS) || 0);
} else if (argv[0] === "--lookalike") {
  const net = require("net");
  const pipe = fs.readFileSync(path.join(process.env.WAKE_AGENT_DIR, "pipe-name"), "utf8").trim();
  const c = net.createConnection(pipe);
  let b = "";
  c.on("connect", () => c.write(JSON.stringify({ pid: process.pid }) + "\n"));
  c.on("data", (d) => { b += d; });
  c.on("end", () => { process.stdout.write(b.trim() + "\n"); process.exit(1); });
} else if (argv[0] === "--echo-argv") {
  // prints its own argv and waits for a line on stdin (so the test can read its command line while it is alive)
  process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\n");
  process.stdin.once("data", () => process.exit(0));
}
