// Is this IPC call from the app's own main window, main frame? (v1.126.0 review fix 7). A sub-frame, another window or a webContents the
// app does not own is refused. Same rule as src/finance/main-finance.js. `win` is a BrowserWindow (or a fake with the same three members).
function isMainWindowCall(event, win) {
  try {
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
    const wc = win.webContents;
    return !!(wc && event && event.sender === wc && event.senderFrame && event.senderFrame === wc.mainFrame);
  } catch (e) { return false; }
}
module.exports = { isMainWindowCall };
