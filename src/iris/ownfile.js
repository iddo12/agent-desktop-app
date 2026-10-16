// The only way an agent's reply text may come from a file (tools/iris.js reply|send --file) - v1.126.0 review fix, HIGH 2.
// A reply to a linked person leaves without a human click, so the file must be the agent's own plain note: inside the agent's own folder,
// a text/markdown file, at most MAX_CHARS, no dot-files or dot-folders, no file or folder whose name suggests a secret or a configuration.
// The credential filter in the gateway still runs on the text afterwards. (An agent can of course also paste text into --text; this keeps
// the file option from being a one-line way to ship an arbitrary local file.)
const fs = require("fs");
const path = require("path");

const MAX_CHARS = 4000;
const SECRET_NAME_RE = /(secret|credential|passw|passwd|token|apikey|api[_ -]?key|private|\.env|\.pem|\.pfx|\.key|id_rsa|wp-config|config|cookie|login|vault|\.kdbx|\.sqlite|\.db)/i;
const OK_EXT = new Set([".txt", ".md", ".markdown"]);

// root: the agent's own folder. Returns { ok:true, text } or { ok:false, reason }.
function readOwnFile(file, root, maxChars) {
  const limit = maxChars || MAX_CHARS;
  try {
    if (!file || !root) return { ok: false, reason: "no-file" };
    const rootReal = fs.realpathSync(path.resolve(root));
    const abs = path.resolve(rootReal, String(file));
    const real = fs.realpathSync(abs);
    const rel = path.relative(rootReal, real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, reason: "outside-the-agent-folder" };
    const segs = rel.split(/[\\/]+/);
    if (segs.some((s) => s.startsWith("."))) return { ok: false, reason: "hidden-file-or-folder" };
    if (segs.some((s) => SECRET_NAME_RE.test(s))) return { ok: false, reason: "name-looks-like-a-secret-or-config" };
    if (!OK_EXT.has(path.extname(real).toLowerCase())) return { ok: false, reason: "not-a-text-file" };
    const st = fs.statSync(real);
    if (!st.isFile()) return { ok: false, reason: "not-a-file" };
    if (st.size > limit * 4) return { ok: false, reason: "too-long" };
    const text = fs.readFileSync(real, "utf8");
    if (text.length > limit) return { ok: false, reason: "too-long" };
    if (text.indexOf("\u0000") >= 0) return { ok: false, reason: "not-a-text-file" };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: "cannot-read" };
  }
}

module.exports = { readOwnFile, MAX_CHARS, SECRET_NAME_RE };
