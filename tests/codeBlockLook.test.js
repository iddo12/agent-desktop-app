// Run: node tests/codeBlockLook.test.js
// v1.109.0: fenced code blocks are a black box with white monospace text and a visible, labelled Copy button.
// Source-level checks (the renderer needs a full Electron window); the copied text is exercised with a tiny DOM stub.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const R = path.join(__dirname, "..", "src", "renderer");
const css = fs.readFileSync(path.join(R, "styles.css"), "utf8");
const js = fs.readFileSync(path.join(R, "renderer.js"), "utf8");

const rule = (sel) => {
  const i = css.indexOf(sel + " {");
  assert.ok(i >= 0, "css rule for " + sel);
  return css.slice(i, css.indexOf("}", i));
};
const pre = rule(".chat-bubble pre.code-block,\n.chat-answer-section pre.code-block".replace(/\n/g, css.includes("\r\n") ? "\r\n" : "\n"));
assert.ok(/background:\s*#0c0c0c/i.test(pre), "black background");
assert.ok(/color:\s*#f2f2f2/i.test(pre), "white text");
assert.ok(/border:\s*1px solid #333/i.test(pre), "dark border");
assert.ok(/Cascadia Code, Consolas/.test(pre) || /Cascadia Code", Consolas/.test(pre), "monospace font");
assert.ok(/overflow-x:\s*auto/.test(pre), "long commands scroll horizontally");
assert.ok(!/var\(--/.test(pre), "fixed colours: same in light and dark theme");
assert.ok(/pre\.code-block \.code-copy-btn\s*\{[^}]*width:\s*auto/.test(css), "copy button shows a text label");
assert.ok(/pre\s*\{|pre,/.test(css) && /pre\.code-block code[^{]*\{[^}]*white-space:\s*pre/.test(css), "no wrapping inside the box");
// RTL context keeps code left-to-right
const rtl = fs.readFileSync(path.join(R, "styles-rtl.css"), "utf8");
assert.ok(/\.chat-bubble pre[\s\S]{0,200}direction:\s*ltr/.test(rtl), "code stays LTR in RTL messages");
// the block is created with the class and the Copy label/timing
assert.ok(/pre\.className = "code-block"/.test(js));
assert.ok(/addCopyButton\(pre, \(\) => code\.textContent, "code-copy-btn"\)/.test(js), "copy = the code text exactly");
assert.ok(/<span class="copy-label">Copy<\/span>/.test(js) && /<span class="copy-label">Copied<\/span>/.test(js), "Copy / Copied labels");
assert.ok(/labelled \? 1500 : 1200/.test(js), "Copied shows for 1.5 s");
// inline code is untouched
assert.ok(/\.chat-bubble code,\s*\n?\s*\.chat-answer-section code \{\s*background: var\(--bg-hover\)/.test(css.replace(/\r/g, "")), "inline code unchanged");

// copied text: a path link inside the block must not change textContent
const PL = require("../src/pathLinks");
const cmd = "powershell -File \"C:\\Example\\Scratch\\UI-UX\\lbracket\\option_a.html\"\nGet-ChildItem C:\\Example\\Workspace";
const found = PL.find(cmd, { code: true });
let rebuilt = "";
let pos = 0;
for (const c of found) { rebuilt += cmd.slice(pos, c.start) + cmd.slice(c.start, c.end); pos = c.end; }
rebuilt += cmd.slice(pos);
assert.strictEqual(rebuilt, cmd, "splitting a code block into text + path spans loses nothing");
console.log("codeBlockLook: OK");
