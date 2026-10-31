// Run: node tests/approvalScreen.test.js
// v1.152.3: long chained / heredoc permission prompts (Merav's PC 2026-10-31): the 1500-char screen text lost the command start
// and the 600-char window lost "Esc to cancel"; the 8000-char text must still see the prompt.
const assert = require("assert");
const A = require("../src/approvalScreen");
const DS = require("../src/deliveryScreen");

const heredoc = "cat > report.md <<'EOF'\n" + Array.from({ length: 60 }, (_, i) => `line ${i} of the long document body text here`).join("\n") + "\nEOF";
const dialog = " Bash command\n   " + heredoc + "\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No\n Esc to cancel · Tab to amend\n";
const chatter = "x".repeat(0) + " ctx 41% · opus ".repeat(60); // repaint chatter after the footer (no marker)
const stream = dialog + chatter;
const short = stream.slice(-1500), long = A.appendLong("", stream);
const needs = "approve Bash: cat > report.md <<'EOF' line 0 of the long document";

// old behaviour reproduced: short text neither shows the prompt nor the command start
assert.strictEqual(DS.promptWaiting(short), false, "600-char window lost the footer");
assert.strictEqual(A.commandOnScreen(short, needs), false, "command start scrolled out of 1500");
// new: long text sees both
assert.strictEqual(A.longPromptOpen(long), true);
assert.strictEqual(A.commandOnScreen(long, needs), true);
// unrelated command is not accepted
assert.strictEqual(A.commandOnScreen(long, "approve Bash: rm -rf something_else_entirely"), false);
// after approval the CLI shows the working indicator: no longer open
assert.strictEqual(A.longPromptOpen(A.appendLong(long, "\n* Working... (esc to interrupt)")), false);
// no dialog at all
assert.strictEqual(A.longPromptOpen("just some output"), false);
assert.strictEqual(A.longPromptOpen(""), false);
// buffer is capped
assert.strictEqual(A.appendLong("a".repeat(9000), "b").length, A.LONG_KEEP);
// diagnose carries no text
const d = A.diagnose({ shortLen: 1, longLen: 2, dialogOpen: false, promptWaiting: false, longOpen: true, cmdShort: false, cmdLong: true, needsLen: 5 });
assert.ok(/longOpen=true/.test(d) && !/report/.test(d));

// --- review round: bound to the OPEN dialog, Merav's real command wrapped at 100 columns ---
const wrap = (t, n) => t.match(new RegExp(".{1," + n + "}", "gs")).join("\r\n");
const real = 'cd "C:/Merav work/video" && ls -l --time-style=full-iso ~/AppData/Local/CapCut/User\ Data/Projects/com.lveditor.draft/1030_v4/draft_content.json; tasklist | grep -ic "^capcut.exe"; python -I -X utf8 cmp_v4.py';
const dlg = (cmd) => "\r\n Bash command\r\n\r\n   " + wrap(cmd, 96) + "\r\n   Run cmp\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n Esc to cancel · Tab to amend\r\n";
const needsReal = "approve Bash: " + real;
const w = dlg(real) + " ctx 41% ".repeat(80);
assert.strictEqual(DS.promptWaiting(w.slice(-1500)), false, "old 600-char test fails on the real example");
assert.strictEqual(A.openPromptFor(A.appendLong("", w), needsReal), true, "real example passes");
const B = real.slice(0, 40) + " && rm -rf /something_else; python other.py";
const seq = dlg(real) + "\n* Working (esc to interrupt)\n" + dlg(B);
assert.strictEqual(A.openPromptFor(A.appendLong("", seq), needsReal), false, "A's needs against B's screen refused");
assert.strictEqual(A.openPromptFor(A.appendLong("", seq), "approve Bash: " + B), true, "B's needs accepted");
assert.strictEqual(A.openPromptFor(A.appendLong("", dlg(real) + "\n* Working (esc to interrupt)\n"), needsReal), false);
assert.strictEqual(A.openPromptFor(A.appendLong("", dlg(real) + dlg("echo hi")), needsReal), false);
assert.strictEqual(A.openPromptFor(A.appendLong("", dlg(real) + dlg(real)), needsReal), true);
const L = A.appendLong("", w);
assert.strictEqual(A.likelyOpen({ dialogOpen: false, shortWaiting: false, pending: true, long: L }), true);
assert.strictEqual(A.likelyOpen({ dialogOpen: false, shortWaiting: false, pending: false, long: L }), false, "no daemon block, no long-text rescue");
assert.strictEqual(A.likelyOpen({ dialogOpen: true, shortWaiting: false, pending: false, long: "" }), true);
assert.strictEqual(A.likelyOpen({ dialogOpen: false, shortWaiting: false, pending: true, long: "" }), false);
console.log("approvalScreen ok");
