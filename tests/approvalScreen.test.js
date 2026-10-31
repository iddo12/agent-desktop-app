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
console.log("approvalScreen ok");
