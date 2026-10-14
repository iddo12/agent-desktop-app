// My Health: the one atomic-write helper (review F14). Write a temp file in the SAME folder (stale one removed, created with "wx" so a planted
// link is never followed), fsync, rename over the target. A crash leaves the old file or the new one, never half. Stale `*.tmp-<pid>` files
// from a crash are removed at service start (cleanTmp).
"use strict";
const fs = require("fs");
const path = require("path");
const { withFsRetry } = require("../fsRetry");

function write(fsx, target, text) {
  const f = fsx || fs;
  f.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + ".tmp-" + process.pid;
  withFsRetry(() => {
    try { f.unlinkSync(tmp); } catch (e) { /* none */ }
    const fd = f.openSync(tmp, "wx");
    try { f.writeSync(fd, text); try { f.fsyncSync(fd); } catch (e) { /* fsync unsupported: still renamed */ } } finally { f.closeSync(fd); }
    f.renameSync(tmp, target);
  }, { attempts: 3, delayMs: 100 });
}
// Remove leftovers of crashed writes (names ending .tmp-<digits>) directly inside `dir` and `dir\agent`. Returns how many were removed.
function cleanTmp(dir, fsx) {
  const f = fsx || fs; let n = 0;
  for (const d of [dir, path.join(dir, "agent")]) {
    let names = []; try { names = f.readdirSync(d); } catch (e) { continue; }
    for (const name of names) if (/\.tmp-\d+$/.test(name)) { try { f.unlinkSync(path.join(d, name)); n++; } catch (e) { /* in use */ } }
  }
  return n;
}
module.exports = { write, cleanTmp };
