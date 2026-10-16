// v1.128.6: the status line must not rewrite its shared files on every refresh, and must never leave a .tmp behind.
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sl-test-"));
fs.mkdirSync(path.join(home, ".claude"));
const script = path.join(__dirname, "..", "src", "statusline.cjs");
const input = (p5) => JSON.stringify({ session_id: "s1", model: { display_name: "M" }, workspace: { current_dir: "C:/x/y" },
  context_window: { used_percentage: 10 }, rate_limits: { five_hour: { used_percentage: p5, resets_at: "2026-10-16T10:00:00Z" }, seven_day: { used_percentage: 6, resets_at: "2026-10-22T16:00:00Z" } } });
const run = (p5) => cp.execFileSync(process.execPath, [script], { input: input(p5), env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home }) }).toString();
const dir = path.join(home, ".claude");
const f1 = path.join(dir, "agent-desktop-rate-limits.json"), f2 = path.join(dir, "agent-desktop-rate-limits-by-session.json");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } };
ok(/5h 5%/.test(run(5)), "renders the status line");
const m1 = [fs.statSync(f1).mtimeMs, fs.statSync(f2).mtimeMs];
const t0 = Date.now(); while (Date.now() - t0 < 30) {}   // make an mtime difference detectable
run(5); run(5);
ok(fs.statSync(f1).mtimeMs === m1[0], "unchanged values do not rewrite the shared cache");
ok(fs.statSync(f2).mtimeMs === m1[1], "unchanged values do not rewrite the per-session file");
run(7);
ok(JSON.parse(fs.readFileSync(f1, "utf8")).fiveHourUsedPct === 7, "a changed value is written");
ok(JSON.parse(fs.readFileSync(f2, "utf8")).s1.p5 === 7, "a changed value reaches the per-session file");
ok(fs.readdirSync(dir).every((n) => !n.endsWith(".tmp")), "no .tmp files are left behind");
fs.rmSync(home, { recursive: true, force: true });
if (fails) process.exit(1);
console.log("statuslineThrottle ok");
