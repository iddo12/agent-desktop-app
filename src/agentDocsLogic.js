// Agent documents side panel (v1.92.0): the pure parts, no DOM. Loaded by renderer/index.html (as ../agentDocsLogic.js) before agent-docs.js
// (window.AgentDocsLogic) and by tests/agentDocsPanel.test.js through require().
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AgentDocsLogic = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const PANEL_W = 380; // list width (UI-UX mockup: ~340-380)
  const VIEWER_W = 560; // "Open here" widens the panel to this (mockup section 4)
  const CHAT_MIN = 360; // the chat never gets narrower than this beside the panel
  const OVERLAY_BELOW = 1100; // window width under which the panel always overlays the chat (mockup section 6)

  // The type pills, in order. `always` = shown even at 0 (the owner v1.75.4: PDF and Word always visible).
  const PILLS = [
    { key: "docs", label: "Documents", always: true },
    { key: "image", label: "Images", always: true },
    { key: "all", label: "All", always: true },
    { key: "pdf", label: "PDF", always: true },
    { key: "word", label: "Word", always: true },
    { key: "sheet", label: "Sheets" },
    { key: "video", label: "Video" },
    { key: "other", label: "Other" },
  ];

  function pills(counts, active) {
    const c = counts || {};
    return PILLS.filter((p) => p.always || (c[p.key] || 0) > 0 || p.key === active).map((p) => ({ key: p.key, label: p.label, n: c[p.key] || 0, active: p.key === active }));
  }

  // Header toggle: total in the count chip, unread as a separate "N new" chip (never colour alone: both have words/titles).
  function badge(summary) {
    const s = summary || {};
    const total = Math.max(0, Number(s.total) || 0);
    const unread = Math.max(0, Math.min(total, Number(s.unread) || 0));
    const t = total > 9999 ? "9999+" : String(total);
    return {
      total: t,
      fresh: unread ? (unread > 999 ? "999+" : String(unread)) + " new" : "",
      // Review N8: the badge counts REGISTERED documents only (before and after first open); the label says so.
      label: "Documents: " + total + (total === 1 ? " registered file" : " registered files") + (unread ? ", " + unread + " not opened yet" : ""),
    };
  }

  // "side" = chat shrinks beside the panel; "overlay" = the panel floats over the chat (narrow window or narrow chat).
  function layoutMode(windowW, chatViewW, viewing) {
    const w = viewing ? VIEWER_W : PANEL_W;
    if (!windowW || windowW < OVERLAY_BELOW) return "overlay";
    if (chatViewW && chatViewW - w < CHAT_MIN) return "overlay";
    return "side";
  }

  // First time an agent's panel opens (no saved choice): an agent that mostly makes images opens on Images as a grid.
  function defaultView(counts) {
    const c = counts || {};
    if ((c.image || 0) > (c.docs || 0)) return { type: "image", view: "grid" };
    return { type: "docs", view: "list" };
  }

  // What to say when the list is empty.
  function emptyState(o) {
    const x = o || {};
    if (!x.allTotal) {
      return { kind: "none", title: "No documents yet", text: "Finished PDFs, images, Word and spreadsheet files this agent produces will show up here. Code and scratch files are never listed." };
    }
    if (x.search) return { kind: "nomatch", title: "Nothing matches “" + x.search + "”", text: "Try fewer words, or clear the type filter.", action: "Clear search" };
    return { kind: "notype", title: "Nothing of this type", text: "This agent has no " + (x.typeLabel || "files of this type").toLowerCase() + " yet.", action: "Show all" };
  }

  // Registry status -> chip class and words (the word is always shown; colour only backs it up).
  function statusChip(status) {
    const s = String(status || "").toLowerCase();
    if (!s) return null;
    const cls = s === "active" ? "ok" : s === "draft" ? "warn" : s === "superseded" ? "old" : "plain";
    return { cls, text: s };
  }

  function fmtSize(b) {
    const n = Number(b) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return Math.round(n / 1024) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  // "today 06:52", "yesterday 18:10", "Oct 3", "Oct 3, 2025".
  function fmtWhen(ms, now) {
    const d = new Date(ms), n = new Date(now == null ? Date.now() : now);
    if (isNaN(d)) return "";
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    if (ms >= start) return "today " + hm;
    if (ms >= start - 86400000) return "yesterday " + hm;
    const mon = d.toLocaleString("en-US", { month: "short" });
    return mon + " " + d.getDate() + (d.getFullYear() === n.getFullYear() ? "" : ", " + d.getFullYear());
  }

  // Keyboard movement in the list.
  function moveSel(sel, key, len) {
    if (!len) return -1;
    const s = Math.max(0, Math.min(len - 1, Number(sel) || 0));
    if (key === "ArrowDown") return Math.min(len - 1, s + 1);
    if (key === "ArrowUp") return Math.max(0, s - 1);
    if (key === "Home") return 0;
    if (key === "End") return len - 1;
    if (key === "PageDown") return Math.min(len - 1, s + 8);
    if (key === "PageUp") return Math.max(0, s - 8);
    return s;
  }

  // v1.92.0 (review S3): the message is typed into the agent's terminal inside a bracketed paste (ESC[200~ ... ESC[201~).
  // A registry title is written by an agent, so it could carry ESC[201~ + CR + keystrokes and end the paste early.
  // Strip every C0/C1 control character (ESC, CSI 0x9B, CR, DEL...) from title and path; the comment keeps only
  // \n and \t. Local to this panel and idempotent, so a central strip in submitToAgent (wake-agent branch) can coexist.
  const CTRL_ALL = /[\u0000-\u001f\u007f-\u009f]/g;
  const CTRL_KEEP_NL_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
  function cleanLine(s, max) {
    return String(s == null ? "" : s).replace(CTRL_ALL, "").slice(0, max || 300);
  }
  function cleanBody(s) {
    return String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(CTRL_KEEP_NL_TAB, "");
  }

  // The text sent to the agent with "Comment & send": the title, the full path and the comment.
  function commentText(title, filePath, comment) {
    const c = cleanBody(comment).trim();
    if (!c) return "";
    const t = cleanLine(title, 300);
    const p = cleanLine(filePath, 1000);
    return "Comment on your document \"" + t + "\"" + (p ? " (" + p + ")" : "") + ":\n" + c;
  }

  // ---- read state on stacked rows (review S4) ----
  // "Mark read" on a stack head means the whole document: the head and every older version. "Mark unread" only the head.
  function idsForRead(item, read) {
    if (!item) return [];
    if (read && item.older && item.older.length) return [item.id].concat(item.older.filter((o) => o.unread).map((o) => o.id));
    return [item.id];
  }
  // Applies one id's new state to the loaded rows (heads and older versions). A head's dot is its own state OR any
  // older version unread. Returns how many loaded copies changed (0 = not on the loaded pages).
  function applyReadToItems(items, id, read) {
    let changed = 0;
    for (const h of items || []) {
      const stacked = !!(h.older && h.older.length);
      if (h.id === id) {
        const own = stacked ? h.selfUnread : h.unread;
        if (own === read) { changed++; if (stacked) h.selfUnread = !read; else h.unread = !read; }
      }
      for (const o of h.older || []) if (o.id === id && o.unread === read) { o.unread = !read; changed++; }
      if (stacked) h.unread = !!h.selfUnread || h.older.some((o) => o.unread);
    }
    return changed;
  }

  // The count line under the pills. It counts ROWS (a stack of versions is one row) and says so when versions fold,
  // so it never reads "7 files" beside a "Documents 59" pill (review N9).
  function countLine(o) {
    const x = o || {};
    if (!x.loaded) return "";
    const files = Math.max(0, Number(x.files) || 0), rows = Math.max(0, Number(x.total) || 0), shown = Math.max(0, Number(x.shown) || 0);
    const folded = files > rows ? " (" + (files - rows) + " older version" + (files - rows === 1 ? "" : "s") + " folded)" : "";
    if (x.search) return rows + " of " + (x.allTotal || 0) + " match";
    if (shown < rows) return "Showing " + shown + " of " + rows + folded;
    return files + (files === 1 ? " file" : " files") + folded;
  }

  return { PANEL_W, VIEWER_W, CHAT_MIN, OVERLAY_BELOW, PILLS, pills, badge, layoutMode, defaultView, emptyState, statusChip, fmtSize, fmtWhen, moveSel,
    commentText, cleanLine, cleanBody, idsForRead, applyReadToItems, countLine };
});
