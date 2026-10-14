// Stand-in for shared_tools\pc_health\pc_health.py used by tests/pchealth-main.test.js. FAKE_MODE selects the behaviour.
const mode = process.env.FAKE_MODE || "stream";
const args = process.argv.slice(2);
const tick = (i) => JSON.stringify({ live: true, taken_at: "2026-10-10T00:00:0" + (i % 10), cpu: { total_pct: 10 + i, cores: [], state: "ok" }, summary: { state: "ok", watch: [], problems: [] }, elapsed_s: i });
if (mode === "stream") {
  let i = 0;
  const t = setInterval(() => {
    i++;
    const line = tick(i) + "\n";
    if (i === 1) { process.stdout.write(line.slice(0, 20)); setTimeout(() => process.stdout.write(line.slice(20)), 20); } // a line split across chunks
    else process.stdout.write(line);
  }, 60);
  process.stdout.on("error", () => { clearInterval(t); process.exit(0); });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
} else if (mode === "exit1") {
  process.stderr.write("Traceback...\nModuleNotFoundError: No module named 'psutil'\n");
  process.exit(1);
} else if (mode === "silent") {
  setInterval(() => {}, 1000);
} else if (mode === "garbage") {
  process.stdout.write("hello not json\n" + tick(1) + "\n{broken\n");
  setInterval(() => {}, 1000);
} else if (mode === "cleanexit") {
  setTimeout(() => process.exit(0), 700);
} else if (mode === "snapshot") {
  setTimeout(() => { process.stdout.write(JSON.stringify({ taken_at: "x", cpu: { total_pct: 33 }, top_procs: [{ name: "a.exe", cpu_pct: 1, ram_gb: 1, count: 1 }] }, null, 1)); process.exit(0); }, 150);
}
void args;
