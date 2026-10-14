// node tests/areaLibrary.test.js - Library / My Research on the configuration layer (v1.121.0): the open-path allow-list and the Agent documents
// roots can be functions (read on every use), messages to agents carry the configured owner name (or a neutral "the user"), and the
// command-line digest tool refuses to guess a workspace. Temp folders only.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), cp = require("child_process");
const { createOpener } = require("../src/openPath");
const W = require("../src/research/write");
let n = 0, fails = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(() => console.log("ok   " + name), (e) => { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); }); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adlib-"));
const mkdir = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

(async () => {
  await t("open-path allow-list given as a function follows the configuration as it changes", async () => {
    const a = mkdir("rootA"), b = mkdir("rootB");
    const fa = path.join(a, "x.pdf"), fb = path.join(b, "y.pdf"); fs.writeFileSync(fa, "%PDF"); fs.writeFileSync(fb, "%PDF");
    let roots = [a];
    const opened = [];
    const op = createOpener({ roots: () => roots, log: () => {}, shell: { openPath: async (p) => { opened.push(p); return ""; } } });
    const r1 = await op.open(fa); assert.ok(r1.ok, JSON.stringify(r1));
    const r2 = await op.open(fb); assert.ok(!r2.ok, "B is not allowed yet");
    roots = [a, b];
    const r3 = await op.open(fb); assert.ok(r3.ok, JSON.stringify(r3));
  });

  await t("open-path with no roots configured refuses everything", async () => {
    const a = mkdir("rootC"); const f = path.join(a, "z.pdf"); fs.writeFileSync(f, "%PDF");
    const op = createOpener({ roots: () => [], log: () => {}, shell: { openPath: async () => "" } });
    assert.ok(!(await op.open(f)).ok);
  });

  await t("messages to an agent name the configured owner, or 'the user' when none is set; nothing says a fixed first name", () => {
    const ref = { week: "2026-W41", findingId: "f1", title: "A finding" };
    assert.ok(W.messageFor(ref, "hello", "Dana").startsWith("From Dana, via the My Research tab"));
    assert.ok(W.messageFor(ref, "hello").startsWith("From the user, via the My Research tab"));
    assert.ok(W.messageFor({ week: "2026-W41", findingId: W.WEEK_ID }, "x", "").startsWith("From the user,"));
    assert.ok(!/Alex/.test(W.messageFor(ref, "hello")));
  });

  await t("the pending-notes fallback is written in the folder given, with the owner's name", async () => {
    const root = mkdir("wsW"), rd = mkdir("wsW", "research");
    const wr = W.createWriter({ researchDir: rd, root, owner: () => "Dana", log: () => {}, now: () => Date.UTC(2026, 9, 14, 8, 0), deliver: async () => ({ delivered: false }), isRunning: () => false });
    assert.ok(wr, "writer created");
    const f = W.pendingFileFor(root, "Some Agent");
    assert.strictEqual(path.dirname(f), root);
  });

  await t("research-aggregate refuses to guess a workspace (no --root, no env)", () => {
    const env = Object.assign({}, process.env); delete env.AGENT_DESKTOP_WORKSPACE_ROOT;
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "research-aggregate.js"), "2026-W41"], { env, encoding: "utf8" });
    assert.strictEqual(r.status, 2);
    assert.ok(/--root/.test(r.stderr));
  });

  console.log((n - fails) + "/" + n + " passed");
  process.exit(fails ? 1 : 0);
})();
