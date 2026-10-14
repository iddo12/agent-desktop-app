// node tests/cfgVoice.test.js - Voice on the configuration layer (v1.121.0).
// Temp folders only (no fixed drive), AGENT_DESKTOP_* unset: a fresh computer shows "needs setup" with a plain explanation, a configured one works,
// and nothing is read from the Windows environment unless a transcription really needs the cloud.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { createAppConfig } = require("../src/appConfig");
const features = require("../src/features");
const VM = require("../src/voice-main");
let n = 0, fails = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(() => console.log("ok   " + name), (e) => { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); }); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adcvr-"));
const mk = (name) => { const d = path.join(tmp, name + Math.random().toString(36).slice(2, 6)); fs.mkdirSync(d, { recursive: true }); return d; };
const make = (env) => { const c = createAppConfig({ userDataDir: mk("ud"), env: env || {} }); c.setRegistry(features); return c; };
const wc = { mainFrame: {} }, win = { webContents: wc, isDestroyed: () => false }, good = { sender: wc, senderFrame: wc.mainFrame };

function voiceRig(cfg, envMap) {
  const handlers = {}, reads = [];
  VM.init({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, log: () => {}, app: { getPath: () => mk("vud") }, cfg, readEnv: (name) => { reads.push(name); return (envMap || {})[name] || ""; } });
  return { handlers, reads };
}
(async () => {
  await t("registry: voice is wired and needs the speech program and model", () => {
    assert.strictEqual(features.get("voice").wired, true);
    assert.deepStrictEqual(features.get("voice").requires, ["whisperExe", "whisperModel"]);
    assert.ok(features.get("voice").steps.some((s) => s.key === "whisperModelHe" && s.optional));
  });
  await t("voice: a fresh computer is needs-setup, and the answer says so plainly (no recording is attempted, no environment read)", async () => {
    const cfg = make();
    assert.strictEqual(cfg.feature("voice").state, "needs-setup");
    const v = voiceRig(cfg);
    const eng = await v.handlers["voice-engine"]({});
    assert.deepStrictEqual([eng.local, eng.needsSetup], [false, true]);
    assert.deepStrictEqual(await v.handlers["voice-warm"]({}), { ok: false });
    const r = await v.handlers["voice-transcribe"]({}, { wavBase64: "A".repeat(400) });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, "needs-setup"); assert.ok(/not set up/.test(r.error) && /Setup/.test(r.error));
    assert.ok(!v.reads.some((x) => /WHISPER/.test(x)), "the engine is never looked up in the environment/registry any more: " + v.reads);
  });
  await t("voice: with the speech program and model configured the local engine is used and the cloud is never consulted", async () => {
    const d = mk("w"); const exe = path.join(d, "whisper-cli.exe"), model = path.join(d, "ggml-x.bin"); fs.writeFileSync(exe, "x"); fs.writeFileSync(model, "x");
    const cfg = make({ AGENT_DESKTOP_WHISPER_EXE: exe, AGENT_DESKTOP_WHISPER_MODEL: model });
    assert.strictEqual(cfg.feature("voice").state, "ready");
    const v = voiceRig(cfg);
    assert.deepStrictEqual(await v.handlers["voice-engine"]({}), { local: true, needsSetup: false });
    assert.deepStrictEqual(v.reads, []);
  });
  await t("voice: no local engine but a cloud account in the environment is NOT needs-setup (it works as before)", async () => {
    const v = voiceRig(make(), { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_AI_TOKEN: "b" });
    assert.deepStrictEqual(await v.handlers["voice-engine"]({}), { local: false, needsSetup: false });
  });
  await t("voice: the settings file route works too (paths saved by Setup), and a missing file is needs-attention, not a crash", async () => {
    const d = mk("w2"); const exe = path.join(d, "a.exe"), model = path.join(d, "m.bin"); fs.writeFileSync(exe, "x"); fs.writeFileSync(model, "x");
    const cfg = make(); const r = cfg.setFeature("voice", { enabled: true, values: { whisperExe: exe, whisperModel: model } });
    assert.strictEqual(r.ok, true); assert.strictEqual(cfg.feature("voice").state, "ready");
    fs.unlinkSync(model);
    assert.strictEqual(cfg.feature("voice").state, "needs-attention");
    const v = voiceRig(cfg); assert.strictEqual((await v.handlers["voice-engine"]({})).local, false);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(n - fails + "/" + n + " passed");
  process.exit(fails ? 1 : 0);
})();
