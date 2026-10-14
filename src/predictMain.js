// v1.108.0 Predicted replies - main-process wiring (logic and tests: src/predict.js). Loaded from main.js inside try/catch, so a
// fault here can only switch the feature off, never break the app.
//   <userData>\predict-prefs.json   { enabled }   (default ON; the sidebar checkbox "Predicted replies")
//   <userData>\suggestions.log      one line per call: time, agent, token estimates, ms, result. NEVER message text.
// Test mode (the sandbox) never spawns the model: the answer is read from <userData>\predict-stub.txt (default NONE).
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const predict = require("./predict");
const { createWarmPool } = require("./predictWarm"); // v1.114.2: a helper started in advance, thinking off (see src/predictWarm.js)

function init({ ipcMain, app, getMainWindow, privateCliDir, testMode }) {
  const userData = app.getPath("userData");
  const prefs = predict.createPrefs(path.join(userData, "predict-prefs.json"));
  const logFile = path.join(userData, "suggestions.log");
  let openAgent = null; // the agent shown in the chat view, as last reported by the renderer

  const isWindowVisible = () => {
    const w = getMainWindow();
    if (testMode && process.env.AD_PREDICT_ASSUME_VISIBLE === "1") return !!(w && !w.isDestroyed()); // sandbox runs minimized so it never covers the owner's screen
    return !!(w && !w.isDestroyed() && w.isVisible() && !w.isMinimized());
  };
  const fromApp = (event) => {
    const w = getMainWindow();
    return !!(w && !w.isDestroyed() && event.sender === w.webContents);
  };

  function modelExe() {
    const exe = path.join(privateCliDir(), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    return fs.existsSync(exe) ? exe : null;
  }

  // v1.114.2: one single-use helper is started in the background BEFORE it is needed (agent opened, answer used, feature switched on) and closed after
  // 8 idle minutes, so a prediction no longer pays the 8-12 s start of the CLI; thinking is off (hundreds of hidden tokens for one word).
  let pool = null;
  let poolExe = null;
  function getPool() {
    const exe = modelExe();
    if (!exe) return null;
    if (!pool || poolExe !== exe) {
      if (pool) pool.shutdown();
      pool = createWarmPool({
        exe,
        cwd: path.join(userData, "predict-cwd"),
        keepWarm: () => !testMode && prefs.get().enabled && isWindowVisible(),
        onEvent: (e) => predict.appendLogFile(logFile, new Date().toISOString() + " helper=" + e),
      });
      poolExe = exe;
    }
    return pool;
  }
  function maybePrewarm() {
    try {
      if (testMode || !prefs.get().enabled || !isWindowVisible()) return;
      try { fs.mkdirSync(path.join(userData, "predict-cwd"), { recursive: true }); } catch (e) { /* spawn will report it */ }
      const p = getPool();
      if (p) p.prewarm(predict.SYSTEM_PROMPT, predict.MODEL);
    } catch (e) { /* the feature can only get slower, never break */ }
  }

  // The only thing that costs tokens. One short Haiku call through Agent Desktop's own CLI copy, in a neutral empty folder (no
  // CLAUDE.md, no workspace trust prompt), no tools, no MCP servers, nothing saved to disk. The prompt goes in over stdin.
  function callModel({ system, prompt, model, timeoutMs, signal }) {
    if (testMode) {
      let stub = "NONE";
      try {
        stub = fs.readFileSync(path.join(userData, "predict-stub.txt"), "utf-8").replace(/^﻿/, "").trim() || "NONE";
      } catch (e) {
        /* no stub file: say NONE */
      }
      return new Promise((resolve) => setTimeout(() => resolve(stub), 150));
    }
    const warmPool = getPool();
    if (warmPool) {
      try { fs.mkdirSync(path.join(userData, "predict-cwd"), { recursive: true }); } catch (e) { /* spawn will report it */ }
      return warmPool.ask({ system, prompt, model, timeoutMs, signal });
    }
    return new Promise((resolve, reject) => {
      const exe = modelExe();
      if (!exe) return reject(new Error("no private Claude CLI"));
      const cwd = path.join(userData, "predict-cwd");
      try {
        fs.mkdirSync(cwd, { recursive: true });
      } catch (e) {
        /* spawn will report it */
      }
      const args = [
        "-p", "--model", model, "--output-format", "text", "--no-session-persistence",
        "--tools", "", "--setting-sources", "project", "--disable-slash-commands", "--strict-mcp-config", "--system-prompt", system,
      ];
      let out = "";
      let done = false;
      let child;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve(val);
      };
      const kill = () => {
        try {
          child.kill();
        } catch (e) {
          /* gone already */
        }
      };
      const onAbort = () => {
        kill();
        const e = new Error("aborted");
        e.aborted = true;
        finish(e);
      };
      const timer = setTimeout(() => {
        kill();
        const e = new Error("timed out");
        e.timedOut = true;
        finish(e);
      }, timeoutMs);
      try {
        child = spawn(exe, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, DISABLE_AUTOUPDATER: "1" } });
      } catch (e) {
        return finish(e);
      }
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort);
      }
      child.stdout.on("data", (d) => {
        if (out.length < 4000) out += d.toString("utf-8");
      });
      child.on("error", (e) => finish(e));
      child.on("close", (code) => (code === 0 ? finish(null, out) : finish(new Error("exit " + code))));
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  }

  const service = predict.createService({
    callModel,
    isEnabled: () => prefs.get().enabled,
    isWindowVisible,
    getOpenAgent: () => openAgent,
    appendLog: (line) => predict.appendLogFile(logFile, line),
    recentCalls: () => predict.callTimesFromLog(logFile, Date.now()),
    ownerName: () => { try { return require("./appConfig").get("ownerName") || null; } catch (e) { return null; } }, // v1.121.0
  });

  const startupTimer = setTimeout(maybePrewarm, 20000);
  if (startupTimer.unref) startupTimer.unref();
  if (app && app.on) app.on("will-quit", () => { try { if (pool) pool.shutdown(); } catch (e) { /* quitting */ } });

  ipcMain.handle("predict-prefs-get", () => prefs.get());
  ipcMain.handle("predict-prefs-set", (event, patch) => {
    if (!fromApp(event)) return { ok: false };
    const r = prefs.set(patch);
    if (r.ok && !r.enabled && openAgent) service.cancel(openAgent);
    if (r.ok && !r.enabled && pool) pool.shutdown(); // switched off: close the idle helper now
    if (r.ok && r.enabled) maybePrewarm();
    return r;
  });
  ipcMain.on("predict-open", (event, agentPath) => {
    if (!fromApp(event)) return;
    if (openAgent && openAgent !== agentPath) service.cancel(openAgent);
    openAgent = typeof agentPath === "string" && agentPath ? agentPath.slice(0, 600) : null;
    if (openAgent) maybePrewarm(); // an agent is on screen: have a helper ready for when its turn ends
  });
  ipcMain.on("predict-cancel", (event, agentPath) => {
    if (fromApp(event) && typeof agentPath === "string") service.cancel(agentPath);
  });
  ipcMain.handle("predict-request", async (event, req) => {
    if (!fromApp(event) || !req || typeof req !== "object") return { suggestion: null, reason: "bad-sender" };
    try {
      const r = await service.request({
        agentPath: typeof req.agentPath === "string" ? req.agentPath : "",
        turnKey: typeof req.turnKey === "string" ? req.turnKey.slice(0, 200) : "",
        assistantText: typeof req.assistantText === "string" ? req.assistantText.slice(-20000) : "",
        userMessages: Array.isArray(req.userMessages) ? req.userMessages.slice(-6).map((m) => String(m).slice(0, 4000)) : [],
        boxEmpty: req.boxEmpty !== false,
        queue: req.queue === true,
      });
      return { suggestion: r.suggestion || null, reason: r.reason, turnKey: r.turnKey, agentPath: r.agentPath };
    } catch (e) {
      return { suggestion: null, reason: "error" };
    }
  });
}

module.exports = { init };
