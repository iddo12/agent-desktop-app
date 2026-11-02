// node tests/auditFixes.test.js - validators added by the security audit (AUDIT.md): ids, prompt args, date keys, confinement
"use strict";
const assert = require("assert"), path = require("path"), os = require("os");
const { isSafeId, safePromptArg, isDateKey, isUnder } = require("../src/argGuard");
const archive = require("../src/archive");
let fails = 0;
const t = (name, fn) => { try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n  " + e.message); } };

t("isSafeId accepts uuids and short ids", () => {
  assert(isSafeId("3f2c9a6e-1b2d-4c5e-8f00-123456789abc")); assert(isSafeId("a1b2c3d4")); assert(isSafeId("bg_01-x"));
});
t("isSafeId refuses cmd.exe metacharacters, options, spaces, empties and non-strings", () => {
  for (const bad of ["a&calc.exe", "x|y", "a^b", "%PATH%", "--model", "-x", "a b", 'a"b', "", "a\nb", "..", 5, null, undefined, {}, "x".repeat(101)]) assert(!isSafeId(bad), String(bad));
});
t("safePromptArg strips metacharacters from a bare word only", () => {
  assert.strictEqual(safePromptArg("x&calc"), "x calc");
  assert.strictEqual(safePromptArg("hello"), "hello");
  assert.strictEqual(safePromptArg("two words & more"), "two words & more"); // quoted by node-pty, left as typed
});
t("isDateKey", () => {
  assert(isDateKey("2026-10-02"));
  for (const bad of ["../../../x-y-z", "2026-10-2", "2026/10/02", "", null, "2026-10-02/../x"]) assert(!isDateKey(bad), String(bad));
});
t("readArchivedDay refuses a traversal key without touching the disk", () => {
  const base = path.join(os.tmpdir(), "ad-audit-none-" + process.pid);
  assert.strictEqual(archive.readArchivedDay(base, "../../../etc-x-passwd"), null);
  assert(!require("fs").existsSync(base), "no directory may be created");
});
t("isUnder is separator-terminated and rejects ../ escapes", () => {
  const d = path.join(os.tmpdir(), "rec");
  assert(isUnder(d, path.join(d, "a.wav")));
  assert(!isUnder(d, path.join(d + "-evil", "a.wav")));
  assert(!isUnder(d, path.join(d, "..", "x.wav")));
  assert(!isUnder(d, d));
});
if (fails) { console.log(fails + " FAILED"); process.exit(1); } console.log("all passed");
