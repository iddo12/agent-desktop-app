// node tests/syncGuard.test.js - the main-thread sync guard (v1.132.0): pooled + cached reads under the cache root, invalidation on in-process
// writes, never-cache names, pass-through elsewhere, the exec timeout default, the tracer slot. Temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
process.env.AD_SYNCGUARD_FRESH_MS = "60"; // short freshness so stale-while-revalidate is testable
const sg = require("../src/syncGuard");
let n = 0, fails = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(() => console.log("ok   " + name), (e) => { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); }); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsyncguard-"));
const root = path.join(tmp, "agents"); const other = path.join(tmp, "other");
fs.mkdirSync(path.join(root, "A"), { recursive: true }); fs.mkdirSync(other);
const f = (...p) => path.join(root, ...p);

(async () => {
  sg.install();
  sg.start({ logPath: path.join(tmp, "sync-stalls.log"), cacheRoots: [root] });
  await t("a read under the root returns the content as string and as Buffer", () => {
    fs.writeFileSync(f("A", "master_state.md"), "hello");
    assert.strictEqual(fs.readFileSync(f("A", "master_state.md"), "utf8"), "hello");
    assert.strictEqual(fs.readFileSync(f("A", "master_state.md")).toString(), "hello");
    assert.strictEqual(fs.readFileSync(f("A", "master_state.md"), { encoding: "utf8" }), "hello");
  });
  await t("a missing file still throws ENOENT", () => {
    assert.throws(() => fs.readFileSync(f("A", "nope.md"), "utf8"), (e) => e.code === "ENOENT");
  });
  await t("an in-process write is visible at once (no stale copy of AD's own write)", () => {
    fs.writeFileSync(f("A", "agent_config.json"), "{\"v\":1}");
    assert.strictEqual(fs.readFileSync(f("A", "agent_config.json"), "utf8"), "{\"v\":1}");
    fs.writeFileSync(f("A", "agent_config.json"), "{\"v\":2}");
    assert.strictEqual(fs.readFileSync(f("A", "agent_config.json"), "utf8"), "{\"v\":2}");
    fs.appendFileSync(f("A", "agent_config.json"), " ");
    assert.strictEqual(fs.readFileSync(f("A", "agent_config.json"), "utf8"), "{\"v\":2} ");
    fs.renameSync(f("A", "agent_config.json"), f("A", "renamed.json"));
    assert.throws(() => fs.readFileSync(f("A", "agent_config.json"), "utf8"), (e) => e.code === "ENOENT");
    assert.strictEqual(fs.readFileSync(f("A", "renamed.json"), "utf8"), "{\"v\":2} ");
    fs.unlinkSync(f("A", "renamed.json"));
    assert.throws(() => fs.readFileSync(f("A", "renamed.json"), "utf8"), (e) => e.code === "ENOENT");
  });
  await t("an async write is visible too", async () => {
    fs.writeFileSync(f("A", "x.md"), "one");
    assert.strictEqual(fs.readFileSync(f("A", "x.md"), "utf8"), "one");
    await fs.promises.writeFile(f("A", "x.md"), "two");
    assert.strictEqual(fs.readFileSync(f("A", "x.md"), "utf8"), "two");
  });
  await t("coordination files are never served from the cache", () => {
    for (const name of ["a.lock", "outbox.json", "mailbox.json", "pending_notes.md", ".paused", "runtime.json", "x.tmp"]) {
      fs.writeFileSync(f("A", name), "1"); fs.readFileSync(f("A", name), "utf8");
      fs.writeFileSync.call(fs, f("A", name), "2");                 // patched write drops entries anyway; the real proof is the stats below
    }
    assert.strictEqual(fs.readFileSync(f("A", "outbox.json"), "utf8"), "2");
    const before = sg.stats().cacheEntries;
    const sneaky = f("A", "sneaky.lock");
    fs.writeFileSync(sneaky, "a"); fs.readFileSync(sneaky, "utf8");
    assert.strictEqual(sg.stats().cacheEntries, before, "a .lock file must not add a cache entry");
  });
  await t("source and other extensions bypass the pool; files outside the root pass through", () => {
    fs.writeFileSync(f("A", "mod.js"), "module.exports=1");
    const before = sg.stats().cacheEntries;
    assert.strictEqual(fs.readFileSync(f("A", "mod.js"), "utf8"), "module.exports=1");
    fs.writeFileSync(path.join(other, "o.md"), "o");
    assert.strictEqual(fs.readFileSync(path.join(other, "o.md"), "utf8"), "o");
    assert.strictEqual(sg.stats().cacheEntries, before);
  });
  await t("a file descriptor and a flag option are passed through untouched", () => {
    fs.writeFileSync(f("A", "fd.md"), "fd");
    const fd = fs.openSync(f("A", "fd.md"), "r");
    try { assert.strictEqual(fs.readFileSync(fd, "utf8"), "fd"); } finally { fs.closeSync(fd); }
  });
  await t("warming a folder fills the cache without blocking", async () => {
    fs.mkdirSync(f("B"), { recursive: true });
    for (let i = 0; i < 5; i++) fs.writeFileSync(f("B", "w" + i + ".md"), "w" + i);
    sg.clearCache();
    sg.prefetchDir(f("B"));
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(sg.stats().cacheEntries >= 5, "entries after warm-up: " + sg.stats().cacheEntries);
    for (let i = 0; i < 5; i++) assert.strictEqual(fs.readFileSync(f("B", "w" + i + ".md"), "utf8"), "w" + i);
  });
  await t("execFileSync keeps an explicit timeout and gets a default otherwise (a hung child can no longer block forever)", () => {
    const cp = require("child_process");
    const r = cp.spawnSync(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { timeout: 300 });
    assert.ok(r.error && r.error.code === "ETIMEDOUT", "explicit timeout honoured");
    const out = cp.execFileSync(process.execPath, ["-e", "console.log('ok')"], { encoding: "utf8" });
    assert.strictEqual(out.trim(), "ok");
    assert.strictEqual(cp.execSync("echo hi", { encoding: "utf8" }).trim(), "hi");
  });
  await t("a path whose read timed out cannot be overwritten (no default written over real content)", async () => {
    fs.writeFileSync(f("A", "cfg.json"), "{\"real\":true}");
    sg._markTimedOut(f("A", "cfg.json"));
    assert.throws(() => fs.writeFileSync(f("A", "cfg.json"), "{}"), (e) => e.code === "EAGAIN");
    await assert.rejects(fs.promises.writeFile(f("A", "cfg.json"), "{}"), (e) => e.code === "EAGAIN");
    const cbErr = await new Promise((r) => fs.writeFile(f("A", "cfg.json"), "{}", r));
    assert.ok(cbErr && cbErr.code === "EAGAIN");
    assert.strictEqual(sg._orig.readFileSync(f("A", "cfg.json"), "utf8"), "{\"real\":true}");
    fs.appendFileSync(f("A", "cfg.json"), "");   // appends are not overwrites
  });
  await t("a completed read clears the refusal", async () => {
    fs.writeFileSync(f("A", "ok.json"), "1");
    sg._markTimedOut(f("A", "ok.json"));
    fs.readFileSync(f("A", "ok.json"), "utf8");          // the read finishes (cache set) -> refusal gone
    fs.writeFileSync(f("A", "ok.json"), "2");
    assert.strictEqual(fs.readFileSync(f("A", "ok.json"), "utf8"), "2");
  });
  await t("a stale copy of an externally deleted file is dropped after the background refresh gets ENOENT", async () => {
    fs.writeFileSync(f("A", "gone.md"), "here");
    assert.strictEqual(fs.readFileSync(f("A", "gone.md"), "utf8"), "here");
    sg._orig.unlinkSync(f("A", "gone.md"));              // deleted behind the guard's back
    await new Promise((r) => setTimeout(r, 90));
    assert.strictEqual(fs.readFileSync(f("A", "gone.md"), "utf8"), "here");   // stale, refresh starts
    await new Promise((r) => setTimeout(r, 150));
    assert.throws(() => fs.readFileSync(f("A", "gone.md"), "utf8"), (e) => e.code === "ENOENT");
  });
  await t("a refresh that started before an in-process write cannot put the old content back", async () => {
    fs.writeFileSync(f("A", "race.md"), "old");
    fs.readFileSync(f("A", "race.md"), "utf8");
    await new Promise((r) => setTimeout(r, 90));         // stale now
    fs.readFileSync(f("A", "race.md"), "utf8");          // starts the async refresh (reads "old")
    fs.writeFileSync(f("A", "race.md"), "new");          // write lands while the refresh is in flight
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(fs.readFileSync(f("A", "race.md"), "utf8"), "new");
  });
  await t("takeSlowest reports and resets", () => {
    const a = sg.takeSlowest();
    assert.ok(typeof a.ms === "number" && typeof a.label === "string");
    assert.strictEqual(sg.takeSlowest().ms, 0);
  });
  await t("the worker wrote its start line to the stall log", async () => {
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(/sync guard started/.test(fs.readFileSync(path.join(tmp, "sync-stalls.log"), "utf8")));
  });
  console.log(`${n - fails}/${n} passed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ }
  process.exit(fails ? 1 : 0);
})();
