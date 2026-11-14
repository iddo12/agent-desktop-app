// v1.152.3: the Approve banner's "is the prompt on the agent's screen?" test, made robust for LONG prompts.
// Merav's PC, 2026-10-31: chained Bash lines and heredoc writes made the banner say "The prompt is not on this screen yet"
// and Approve did nothing for 17 min to 17.8 h. Cause: main's rolling screen text (dialogTails) keeps only 1500 characters
// and promptLikelyOpen() looks at the last 600/900 of it. A long command is repainted by the CLI together with the dialog,
// so the command start (what approval-answer matches to be sure it answers THIS prompt) scrolls out of the 1500, and any
// repaint chatter after the footer pushes "Esc to cancel" out of the last 600. The CLI still waits; the app thinks not.
// Pure functions on a longer rolling text (dialogLongTails, 8000 chars). Nothing here sends keys or reads prompt text out.
"use strict";
const squash = (s) => String(s || "").replace(/\s+/g, "");
const DLG = ["esctocancel", "doyouwanttoproceed", "entertoconfirm"];
const LONG_KEEP = 8000;

// the rolling long text: append, strip nothing here (caller strips terminal codes), keep the last LONG_KEEP chars
function appendLong(prev, chunk) { return (String(prev || "") + String(chunk || "")).slice(-LONG_KEEP); }

// the newest dialog marker is newer than the newest "esc to interrupt" (working) marker, and not stale-far-back
function longPromptOpen(longText) {
  const s = squash(longText).toLowerCase();
  let iDlg = -1;
  for (const m of DLG) iDlg = Math.max(iDlg, s.lastIndexOf(m));
  if (iDlg < 0) return false;
  return iDlg > s.lastIndexOf("esctointerrupt");
}

// v1.158.1: the text to look for on the screen. "approve Bash: ls -la" -> "ls -la"; a name-only request such as "approve Agent"
// (a sub-agent launch has no argument text) -> "Agent". The old regex (approve\s*\w*\s*:?) ate the tool name when there was no colon,
// left "", and refused every such card as "not the same prompt" (Review Writer, 2026-11-14: Approve never worked for Agent launches).
function wantedText(needs) {
  const t = String(needs || "").trim();
  const m = /^approve\s+\w+\s*:\s*([\s\S]*)$/i.exec(t);
  if (m) return m[1];
  return t.replace(/^approve\s+/i, "");
}

// the start of the pending command (first 30 non-space chars, as approval-answer already compares) is anywhere in the long text
function commandOnScreen(longText, needs) {
  const want = squash(wantedText(needs)).slice(0, 30);
  return want.length >= 3 && squash(longText).includes(want);
}

// channel names and booleans only, never prompt text
function diagnose(o) {
  return `short=${o.shortLen} long=${o.longLen} dialogOpen=${!!o.dialogOpen} promptWaiting=${!!o.promptWaiting} longOpen=${!!o.longOpen} cmdInShort=${!!o.cmdShort} cmdInLong=${!!o.cmdLong} needsLen=${o.needsLen}`;
}

// v1.152.3 review: bind the click to the OPEN dialog. The command (first 120 non-space chars, the daemon may clip the rest) must
// sit AFTER the last "esc to interrupt" (an earlier, answered prompt does not count) and at most one dialog footer may follow it
// (a second prompt with the same start, drawn later, fails because its own text is the last occurrence and the old one is before
// a working marker; two dialogs after the command mean we cannot tell which one the click would answer).
function openPromptFor(longText, needs) {
  const want = squash(wantedText(needs)).slice(0, 120);
  if (want.length < 3) return false;
  const s = squash(longText), l = s.toLowerCase();
  const i = l.lastIndexOf(want.toLowerCase());
  if (i < 0 || i <= l.lastIndexOf("esctointerrupt")) return false;
  const seg = l.slice(i + want.length);
  const count = (m) => seg.split(m).length - 1;
  return count("doyouwanttoproceed") + count("entertoconfirm") <= 1 && count("esctocancel") === 1 && longPromptOpen(longText);
}
// the whole promptLikelyOpen decision, pure so it is testable: o = { dialogOpen, shortWaiting, pending, long }
function likelyOpen(o) {
  if (o.dialogOpen || o.shortWaiting) return true;
  return !!o.pending && longPromptOpen(o.long);
}

module.exports = { wantedText, appendLong, longPromptOpen, commandOnScreen, openPromptFor, likelyOpen, diagnose, LONG_KEEP, squash };
