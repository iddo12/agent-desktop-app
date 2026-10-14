// v1.96.0: text that is typed into an agent's terminal inside a bracketed paste (ESC[200~ ... ESC[201~) must be text, never
// key sequences. Drops ESC, the other C0 controls except tab / newline / carriage return, DEL and the C1 range (incl. the
// 8-bit CSI U+009B), so no message can end the paste early and have the rest read as typed keys (ESC[201~ then Enter).
// Used by main.js typeIntoPty and connectionHealth's re-send; renderer.js submitToAgent uses the same character class inline.
const PASTE_UNSAFE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
function cleanPasteText(text) {
  return String(text == null ? "" : text).replace(PASTE_UNSAFE_RE, "");
}
module.exports = { cleanPasteText, PASTE_UNSAFE_RE };
