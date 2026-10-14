// v1.103.0: voice input must never feed digital silence to the speech engine, and must offer a microphone choice (generic: no hard-coded hardware).
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf8");
let n = 0; const ok = (c, m) => { n++; if (!c) { console.error("FAIL: " + m); process.exit(1); } };
ok(/localStorage\.getItem\("voiceMicId"\)/.test(src), "remembered microphone is read");
ok(/deviceId: \{ exact: micId \}/.test(src), "remembered microphone used as a constraint");
ok(/catch \(e\) \{\s*if \(!micId\) throw e;/.test(src), "falls back to the default when the remembered mic is gone");
ok(/peak < 0\.004/.test(src) && /No sound came from the microphone/.test(src), "digital silence is rejected before transcription");
ok(/thank you\|thanks/i.test(src) && /peak2 < 0\.02/.test(src), "near-silence hallucinations are dropped");
ok(/async function showMicChooser/.test(src) && /enumerateDevices/.test(src), "mic chooser lists real input devices");
ok(!/logitech|rode/i.test(src.slice(src.indexOf("async function showMicChooser"), src.indexOf("async function showMicChooser") + 2500)), "no hard-coded hardware names");
ok(/\^you\[,\.\]\?\s\+\(\?=\[A-Z/.test(src) || /invents a lowercase "you"/.test(src), "a lone leading lowercase you is stripped");
console.log("voiceMic.test.js: " + n + "/" + n + " passed");
