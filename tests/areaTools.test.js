// node tests/areaTools.test.js - Tools area on the configuration layer (v1.121.0): the service takes every location from cfg, shows the
// calm needs-setup state when nothing is configured, and behaves exactly as before for the migrated owner config. Temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { createAppConfig } = require("../src/appConfig");
const features = require("../src/features");
const launcher = require("../src/tools/launcher");
const SV = require("../src/tools/service");
let n = 0, fails = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(() => console.log("ok   " + name), (e) => { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); }); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adtools-"));
const mkdir = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const mkcfg = (values) => {
  const ud = mkdir("ud" + Math.random().toString(36).slice(2, 7));
  if (values) fs.writeFileSync(path.join(ud, "app-config.json"), JSON.stringify({ schema: 1, values }));
  const c = createAppConfig({ userDataDir: ud, env: {} }); c.setRegistry(features); return { c, ud };
};
const cat = (tools) => JSON.stringify({ schema: 1, tools });
const tool = (id, launch) => ({ id, name: id, basket: "acmeco", purpose: "Does a thing", status: "built", launch });

(async () => {
  await t("launcher has no built-in roots and refuses everything until some are configured", () => {
    assert.deepStrictEqual(launcher.DEFAULT_ROOTS, []);
    const root = mkdir("wsA"); const f = path.join(root, "a.bat"); fs.writeFileSync(f, "@echo off");
    assert.strictEqual(launcher.check({ path: f }).reason, "outside-allowed-folders");
    assert.ok(launcher.check({ path: f }, { roots: [root] }).ok);
  });

  await t("nothing configured: Tools is in the needs-setup state; load and start answer needs-setup, no crash", async () => {
    const { c, ud } = mkcfg(null);
    assert.strictEqual(c.feature("tools").state, "needs-setup");
    const svc = SV.createService({ cfg: c, userData: ud, testMode: false, env: {}, log: () => {} });
    assert.deepStrictEqual(await svc.load(), { ok: false, reason: "needs-setup" });
    assert.deepStrictEqual(await svc.start("x"), { ok: false, reason: "needs-setup" });
  });

  await t("configured: catalogue from toolsCatalogue, launch allowed only inside toolsAllowedRoots, picked up after a config change without restart", async () => {
    const ws = mkdir("ws"); const tdir = mkdir("ws", "shared_tools", "tools"); const bin = mkdir("ws", "bin"); const other = mkdir("other");
    fs.writeFileSync(path.join(bin, "go.bat"), "@echo off"); fs.writeFileSync(path.join(other, "no.bat"), "@echo off");
    const file = path.join(tdir, "tools.json");
    fs.writeFileSync(file, cat([tool("go", { path: path.join(bin, "go.bat"), args: [] }), tool("no", { path: path.join(other, "no.bat"), args: [] })]));
    const { c, ud } = mkcfg({ workspaceRoot: ws, toolsCatalogue: file, toolsAllowedRoots: [bin] });
    assert.strictEqual(c.feature("tools").state, "ready");
    const spawned = [];
    const svc = SV.createService({ cfg: c, userData: ud, testMode: false, env: {}, log: () => {}, confirm: async () => true, spawn: (e, a) => { spawned.push(e); return { pid: 1, on() {}, unref() {} }; } });
    const snap = await svc.load();
    assert.ok(snap.ok && snap.count === 2, JSON.stringify(snap).slice(0, 200));
    const cards = [].concat(...snap.groups.map((g) => g.cards || g.items || []));
    const byId = Object.fromEntries(cards.map((x) => [x.id, x]));
    assert.ok(byId.go && byId.no);
    assert.notStrictEqual(byId.go.start.state, "disabled");
    assert.strictEqual(byId.no.start.state, "disabled", "outside the allowed roots");
    // widen the roots: the same running service sees it on the next load
    const r = c.set("toolsAllowedRoots", [bin, other]); assert.ok(r.ok, JSON.stringify(r));
    const snap2 = await svc.load();
    const cards2 = [].concat(...snap2.groups.map((g) => g.cards || g.items || []));
    assert.notStrictEqual(cards2.find((x) => x.id === "no").start.state, "disabled");
  });

  await t("the Coming-up strip reads <workspaceRoot>/shared_registry, and is simply empty when there is no workspace", async () => {
    const ws = mkdir("ws2"); const reg = mkdir("ws2", "shared_registry"); const tdir = mkdir("ws2", "shared_tools", "tools");
    fs.writeFileSync(path.join(tdir, "tools.json"), cat([]));
    fs.writeFileSync(path.join(reg, "p1.json"), JSON.stringify({ id: "p1", type: "project", title: "Idea one", stage: "idea", status: "open", updatedAt: "2026-10-01", createdAt: "2026-10-01" }));
    const { c, ud } = mkcfg({ workspaceRoot: ws, toolsCatalogue: path.join(tdir, "tools.json") });
    const svc = SV.createService({ cfg: c, userData: ud, testMode: false, env: {}, log: () => {} });
    const snap = await svc.load();
    assert.ok(snap.ok && snap.coming.total === 1, JSON.stringify(snap.coming));
  });

  await t("sources contain no drive letters or personal names (also guarded by noHardcodedPaths)", () => {
    for (const f of ["src/tools/launcher.js", "src/tools/service.js", "src/renderer/tools.js"]) {
      const s = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      assert.ok(!/\b[A-Za-z]:[\\/]/.test(s) && !/Alex|Sarah|Dropbox|Claude[ ]work/.test(s), f);
    }
  });

  console.log(n - fails + "/" + n + " passed"); process.exit(fails ? 1 : 0);
})();
