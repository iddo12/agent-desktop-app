// v1.109.0: clickable file paths in agent chat (renderer side). Parser: ../pathLinks.js; validation + opening: main
// (src/openPath.js). Candidates are first drawn as plain text (a span.path-link without .is-link); one batched
// "resolve-paths" call per tick asks main which of them exist; only existing allow-listed files/folders become links.
// A missing file with a known extension stays text with a faint "file not found" tooltip. textContent never changes,
// so the Copy buttons still copy exactly what the agent wrote.
const PATHLINKS = window.PathLinks; // parser from ../pathLinks.js
const PATH_CACHE = new Map(); // guess -> { t, res }
const PATH_CACHE_FOUND_MS = 60000;
const PATH_CACHE_MISSING_MS = 6000;
let pathQueue = [];
let pathFlushTimer = null;

function pathCacheGet(key) {
  const c = PATH_CACHE.get(key);
  if (!c) return undefined;
  if (Date.now() - c.t > (c.res ? PATH_CACHE_FOUND_MS : PATH_CACHE_MISSING_MS)) {
    PATH_CACHE.delete(key);
    return undefined;
  }
  return c;
}

function pathResolveBatch(items) {
  // items: [{text, hasExt}] -> Promise of results (null when the bridge is missing)
  if (!window.api || !window.api.resolvePaths) return Promise.resolve(items.map(() => null));
  return window.api.resolvePaths(items).catch(() => items.map(() => null));
}

function pathApply(el, res) {
  const full = el.textContent;
  const glen = Number(el.dataset.glen) || full.length;
  if (!res) {
    if (el.dataset.hasExt === "1") {
      el.classList.add("is-missing");
      el.title = "file not found";
    } else if (el.parentNode) {
      el.replaceWith(document.createTextNode(full)); // not a path after all: plain text
    }
    return;
  }
  if (res.end < glen && el.parentNode) {
    const tail = document.createTextNode(full.slice(res.end));
    el.textContent = full.slice(0, res.end);
    el.parentNode.insertBefore(tail, el.nextSibling);
  }
  el.dataset.real = res.real;
  el.classList.add("is-link");
  el.classList.toggle("is-folder", res.kind === "folder");
  el.title = (res.kind === "folder" ? "Open folder: " : "Open: ") + res.real;
  el.setAttribute("role", "link");
  el.tabIndex = 0;
}

function pathFlush() {
  pathFlushTimer = null;
  const q = pathQueue;
  pathQueue = [];
  const need = new Map(); // key -> {text, hasExt}
  for (const el of q) {
    const key = el.dataset.guess;
    if (!pathCacheGet(key) && !need.has(key)) need.set(key, { text: key, hasExt: el.dataset.hasExt === "1" });
  }
  const keys = Array.from(need.keys());
  const run = async () => {
    for (let i = 0; i < keys.length; i += 40) {
      const chunk = keys.slice(i, i + 40);
      const out = await pathResolveBatch(chunk.map((k) => need.get(k)));
      if (PATH_CACHE.size > 500) PATH_CACHE.clear();
      chunk.forEach((k, j) => PATH_CACHE.set(k, { t: Date.now(), res: (out && out[j]) || null }));
    }
    for (const el of q) {
      const c = pathCacheGet(el.dataset.guess);
      pathApply(el, c ? c.res : null);
    }
  };
  run().catch(() => {});
}

function pathMakeCandidate(display, guess, hasExt) {
  const s = document.createElement("span");
  s.className = "path-link";
  s.dir = "ltr";
  s.dataset.guess = guess;
  s.dataset.glen = String(guess.length);
  s.dataset.hasExt = hasExt ? "1" : "0";
  s.textContent = display;
  pathQueue.push(s);
  if (!pathFlushTimer) pathFlushTimer = setTimeout(pathFlush, 0);
  return s;
}

// Literal text (code, fenced blocks) with every path in it made a candidate link.
function appendTextWithPathLinks(parent, str, code) {
  const text = String(str);
  const found = PATHLINKS.find(text, { code: code !== false });
  let pos = 0;
  for (const c of found) {
    if (c.start > pos) parent.appendChild(document.createTextNode(text.slice(pos, c.start)));
    parent.appendChild(pathMakeCandidate(text.slice(c.start, c.end), c.guess, c.hasExt));
    pos = c.end;
  }
  if (pos < text.length) parent.appendChild(document.createTextNode(text.slice(pos)));
}

// [label](D:\path\x.pdf) markdown link: exact target, so a missing file just shows the label as text.
function pathMakeMarkdownLink(label, target) {
  const s = pathMakeCandidate(label, PATHLINKS.normalize(target), true);
  s.dataset.glen = String(label.length + 1e6); // the label is not the path: never split it
  s.dataset.exact = "1";
  return s;
}

// Pseudo-regex for appendInlineMarkdown's pattern loop: exec(rest) -> first candidate in prose.
const PATH_PROSE_PATTERN = {
  exec(rest) {
    const c = PATHLINKS.find(rest, { code: false })[0];
    if (!c) return null;
    const m = [rest.slice(c.start, c.end)];
    m.index = c.start;
    m.cand = c;
    return m;
  },
};

function pathOpenLink(el) {
  const p = el && el.dataset && el.dataset.real;
  if (!p || !window.api || !window.api.openPath) return;
  window.api.openPath(p).catch((err) => ({ ok: false, error: String(err) })).then((r) => {
    if (r && r.ok) {
      el.classList.remove("pdf-link-failed", "is-failed");
      el.title = (el.classList.contains("is-folder") ? "Open folder: " : "Open: ") + p;
    } else {
      el.classList.add("is-failed");
      el.title = "Could not open: " + ((r && r.error) || "unknown error");
    }
  });
}

document.addEventListener("click", (ev) => {
  const el = ev.target && ev.target.closest ? ev.target.closest(".path-link.is-link") : null;
  if (!el) return;
  ev.preventDefault();
  ev.stopPropagation();
  pathOpenLink(el);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const el = ev.target && ev.target.classList && ev.target.classList.contains("is-link") && ev.target.classList.contains("path-link") ? ev.target : null;
  if (!el) return;
  ev.preventDefault();
  pathOpenLink(el);
});

// Raw terminal (xterm) view: the same paths, found per visible line; only existing ones are offered as links.
function registerTerminalPathLinks(term) {
  if (!term || !term.registerLinkProvider) return;
  term.registerLinkProvider({
    provideLinks(y, callback) {
      let line;
      try {
        line = term.buffer.active.getLine(y - 1);
      } catch (e) {
        line = null;
      }
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const found = PATHLINKS.find(text, { code: false });
      if (!found.length) return callback(undefined);
      const need = found.filter((c) => !pathCacheGet(c.guess));
      const done = () => {
        const links = [];
        for (const c of found) {
          const k = pathCacheGet(c.guess);
          const res = k && k.res;
          if (!res) continue;
          const endCol = c.start + (res.end < c.guess.length ? res.end : c.end - c.start);
          links.push({
            range: { start: { x: c.start + 1, y }, end: { x: endCol, y } },
            text: text.slice(c.start, endCol),
            activate: () => { if (window.api && window.api.openPath) window.api.openPath(res.real).catch(() => {}); },
          });
        }
        callback(links.length ? links : undefined);
      };
      if (!need.length) return done();
      pathResolveBatch(need.map((c) => ({ text: c.guess, hasExt: c.hasExt }))).then((out) => {
        need.forEach((c, j) => PATH_CACHE.set(c.guess, { t: Date.now(), res: (out && out[j]) || null }));
        done();
      });
    },
  });
}
