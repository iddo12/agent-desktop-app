// node tests/ownerRenderer.test.js - Library and My Research messages to agents name the configured owner through AppCfg (v1.121.0), "the user" otherwise.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
let n = 0, fails = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };
const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", "renderer", f), "utf8");

t("library.js and research.js take the sender name from AppCfg.owner and carry no fixed first name", () => {
  assert.ok(/AppCfg\.owner\(\{ cap: true \}\)\s*:\s*"The user"\} read the document/.test(src("library.js")));
  assert.ok(/AppCfg\.owner\(\)\s*:\s*"the user"\)\s*\+\s*", via the My Research tab \("/.test(src("research.js")));
  assert.ok(!/"From Alex|`Alex read/.test(src("library.js") + src("research.js")));
});
t("AppCfg.owner gives the configured name, capitalised on request, and 'the user' when none is set", () => {
  const run = (vals) => {
    const w = { api: { config: { getAll: () => Promise.resolve({ ok: true, values: vals }) } } };
    vm.runInNewContext(src("app-cfg.js"), { window: w, Promise });
    return w.AppCfg.ready.then(() => w.AppCfg);
  };
  return Promise.all([run({ ownerName: "dana" }), run({})]).then(([a, b]) => {
    assert.strictEqual(a.owner(), "dana"); assert.strictEqual(a.owner({ cap: true }), "Dana");
    assert.strictEqual(b.owner(), "the user"); assert.strictEqual(b.owner({ cap: true }), "The user");
  });
});
setTimeout(() => { console.log((n - fails) + "/" + n + " passed"); process.exit(fails ? 1 : 0); }, 200);
