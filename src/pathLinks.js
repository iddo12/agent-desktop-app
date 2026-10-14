// v1.109.0: clickable file paths in agent chat - the PARSER (shared by the renderer and the tests; no DOM, no fs).
// It only finds candidates: a drive-letter absolute path (or file:///) that ends in a known extension, or that could be
// a folder. Whether a candidate really exists, and whether it may be opened, is decided by main (src/openPath.js).
(function (root) {
  "use strict";

  // The ALLOW-LIST. Anything not here is never a link and never opened (exe, bat, cmd, ps1, vbs, js, msi, lnk, scr,
  // jar, reg, hta, dll, com ... are simply absent). Macro-enabled Office formats (xlsm, docm, pptm, xlam) are left out too.
  const EXT_GROUPS = {
    documents: ["pdf", "doc", "docx", "dotx", "rtf", "odt", "xls", "xlsx", "ods", "ppt", "pptx", "odp"],
    text: ["txt", "md", "markdown", "csv", "tsv", "json", "log", "xml", "yaml", "yml", "toml"],
    images: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff", "ico"],
    media: ["mp3", "wav", "m4a", "flac", "ogg", "aac", "mp4", "mov", "mkv", "avi", "webm", "wmv"],
    web: ["html", "htm"],
  };
  const ALLOWED_EXTS = new Set([].concat(...Object.values(EXT_GROUPS)));
  const EXT_ALT = Array.from(ALLOWED_EXTS).sort((a, b) => b.length - a.length).join("|");

  const MAX_SPAN = 400;
  const START_RE = /(?<![\w\\/])(file:\/\/\/)?[A-Za-z]:[\\/]/g;
  // Ends a path: line breaks, characters Windows forbids, backtick, ':' (stream/line syntax), bidi control marks.
  const STOP_RE = /[\n\r<>"|?*`:\u0000\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  const EXT_IN_RE = /\.([A-Za-z0-9]{1,5})(?![\w])/g;
  const LINE_SUFFIX_RE = /^:\d+(?::\d+)?(?![\w])/;

  function extOf(p) {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(p));
    return m ? m[1].toLowerCase() : "";
  }
  function isAllowedExt(e) { return ALLOWED_EXTS.has(String(e).toLowerCase()); }

  // Trailing sentence punctuation is never part of a path. A closing ')' stays when the path has its own '('.
  function trimTail(s) {
    let out = s;
    for (;;) {
      const c = out.slice(-1);
      if (c && " 	.,;!'\u2019\u201d\u2026]}".includes(c)) { out = out.slice(0, -1); continue; }
      if (c === ")" && (out.match(/\(/g) || []).length < (out.match(/\)/g) || []).length) { out = out.slice(0, -1); continue; }
      break;
    }
    return out;
  }

  // find(text, {code}) -> [{start, end, guess, hasExt}]. [start,end) is the text to link (includes a ':12' line suffix);
  // guess is the path part only. In inline code / quotes a folder path may contain spaces to the end of the line;
  // in prose a folder guess stops at the first space after the last separator (main shrinks it to the longest existing prefix).
  function find(text, opts) {
    const code = !!(opts && opts.code);
    const s = String(text);
    const out = [];
    START_RE.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = START_RE.exec(s)) && guard++ < 500) {
      const start = m.index;
      const bodyStart = start + m[0].length;
      const prev = start > 0 ? s[start - 1] : "";
      const quote = prev === "'" ? "'" : prev === '"' ? '"' : "";
      let i = bodyStart;
      const lim = Math.min(s.length, start + MAX_SPAN);
      while (i < lim && !STOP_RE.test(s[i]) && !(quote === "'" && s[i] === "'")) i++;
      const spanEnd = i;
      if (spanEnd <= bodyStart) { START_RE.lastIndex = bodyStart; continue; }
      const body = s.slice(bodyStart, spanEnd);
      let guessEnd = -1;
      let hasExt = false;
      EXT_IN_RE.lastIndex = 0;
      let e;
      while ((e = EXT_IN_RE.exec(body))) {
        const after = body[e.index + e[0].length];
        if (isAllowedExt(e[1]) && e.index > 0 && after !== "\\" && after !== "/" && !/[\\/]/.test(body[e.index - 1])) {
          guessEnd = bodyStart + e.index + e[0].length;
          hasExt = true;
          break;
        }
      }
      if (!hasExt) {
        let cut = spanEnd;
        const lastSep = Math.max(body.lastIndexOf("\\"), body.lastIndexOf("/"));
        if (!code && !quote) {
          const ws = body.slice(lastSep + 1).search(/\s/);
          if (ws >= 0) cut = bodyStart + lastSep + 1 + ws;
        }
        guessEnd = bodyStart + trimTail(s.slice(bodyStart, cut)).length;
        if (guessEnd <= bodyStart) { START_RE.lastIndex = bodyStart; continue; }
      }
      let end = guessEnd;
      const sm = LINE_SUFFIX_RE.exec(s.slice(guessEnd, guessEnd + 16));
      if (sm) end = guessEnd + sm[0].length;
      out.push({ start, end, guess: s.slice(start, guessEnd), hasExt });
      START_RE.lastIndex = Math.max(end, bodyStart);
    }
    return out;
  }

  // 'file:///D:/a%20b/x.pdf' / 'D:/a/b' -> 'D:\a b\x.pdf'
  function normalize(raw) {
    let p = String(raw).trim().replace(/^<|>$/g, "");
    if (/^file:\/\/\//i.test(p)) {
      p = p.slice(8);
      try { p = decodeURIComponent(p); } catch (err) { /* leave as is; main will refuse it if it does not exist */ }
    }
    return p.replace(/\//g, "\\");
  }

  // Shorter guesses to try when the whole guess does not exist, longest first: the guess, then every cut before a space
  // (so 'D:\a b\folder and more words' still finds 'D:\a b\folder'). A guess with a known extension is tried alone.
  function prefixes(guess, hasExt) {
    const g = String(guess);
    const out = [{ end: g.length, text: g }];
    if (hasExt || isAllowedExt(extOf(g))) return out;
    const seen = new Set([g]);
    const lastSep = Math.max(g.lastIndexOf(String.fromCharCode(92)), g.lastIndexOf("/"));
    for (let i = g.length - 1; i > lastSep + 1 && out.length < 30; i--) { // only trailing words after the last separator are dropped
      if (/\s/.test(g[i])) {
        const t = trimTail(g.slice(0, i).replace(/\s+$/, ""));
        if (t.length > 3 && !seen.has(t)) { seen.add(t); out.push({ end: t.length, text: t }); }
      }
    }
    return out;
  }

  // Markdown link target: [label](D:\path\x.pdf) or [label](file:///D:/x.html), any allowed extension.
  const MD_LINK_RE = new RegExp("\\[([^\\]]+)\\]\\(<?((?:file:\\/\\/\\/)?[A-Za-z]:[\\\\/][^<>\\n]*?\\.(?:" + EXT_ALT + "))>?\\)", "i");

  const api = { EXT_GROUPS, ALLOWED_EXTS, EXT_ALT, MD_LINK_RE, find, normalize, prefixes, extOf, isAllowedExt, trimTail };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PathLinks = api;
})(typeof window !== "undefined" ? window : globalThis);
