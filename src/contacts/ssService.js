// CONTACTS: starts the Betterbird Super Search service when mail is needed and nothing answers on its port, so nobody types a command after a reboot.
// Settings (all empty by default = never started by us): superSearchDir (the package folder that holds "supersearch", used as the working folder),
// superSearchDb (the index file), pythonExe (auto-detected). The service is started detached and hidden from Agent Desktop's own (real) process, so it
// keeps running after the app closes and its token file is written where this app reads it. `serve` creates the token itself on first start.
"use strict";
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const HOST = "127.0.0.1", PORT = 48766, WAIT_MS = 15000;

function probe(port, timeout) {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port }); let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) { /* gone */ } resolve(v); };
    s.setTimeout(timeout || 800); s.on("connect", () => fin(true)); s.on("timeout", () => fin(false)); s.on("error", () => fin(false));
  });
}
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } };
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } };

/**
 * cfg(key) -> setting value. opts: { port, spawnFn, wait } test hooks.
 * Returns { ensure() -> Promise<{ running, started, reason? }> }. Concurrent calls share one start; a failed start is not retried for 60 s.
 */
function createService(cfg, opts) {
  const o = opts || {}, port = o.port || PORT, spawnFn = o.spawnFn || spawn, waitMs = o.wait || WAIT_MS;
  let inflight = null, lastFail = 0;
  const get = (k) => { try { const v = cfg(k); return v ? String(v) : ""; } catch (e) { return ""; } };
  async function start() {
    if (await probe(port)) return { running: true, started: false };
    if (Date.now() - lastFail < 60000) return { running: false, started: false, reason: "The Super Search service did not start a moment ago." };
    const dir = get("superSearchDir"), db = get("superSearchDb"), py = get("pythonExe");
    if (!dir || !db) return { running: false, started: false, reason: "Super Search is not set up in Setup (superSearchDir and superSearchDb)." };
    if (!isDir(path.join(dir, "supersearch")) || !isFile(db)) return { running: false, started: false, reason: "The Super Search folder or its index file was not found." };
    if (!py || !isFile(py)) return { running: false, started: false, reason: "Python was not found for Super Search (Setup: Python)." };
    try {
      const c = spawnFn(py, ["-m", "supersearch", "serve", "--db", db], { cwd: dir, detached: true, stdio: "ignore", windowsHide: true, shell: /\.(cmd|bat)$/i.test(py) });
      if (c && c.on) c.on("error", () => { /* reported by the probe below */ });
      if (c && c.unref) c.unref();
    } catch (e) { lastFail = Date.now(); return { running: false, started: false, reason: "Super Search could not be started." }; }
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) { await new Promise((r) => setTimeout(r, 400)); if (await probe(port)) return { running: true, started: true }; }
    lastFail = Date.now(); return { running: false, started: true, reason: "Super Search was started but did not answer in time." };
  }
  return { ensure() { if (!inflight) inflight = start().finally(() => { inflight = null; }); return inflight; } };
}

module.exports = { createService, probe, PORT };
