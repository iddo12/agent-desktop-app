// Preload of the THYRA dock window: ONLY the three approvals calls, nothing else of the app's API.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("api", {
  approvalsList: () => ipcRenderer.invoke("approvals-list"),
  approvalsDecide: (decisions, via) => ipcRenderer.invoke("approvals-decide", { decisions, via }),
  onApprovalsChanged: (callback) => { ipcRenderer.on("approvals-changed", () => callback()); },
  approvalsWindow: (action) => ipcRenderer.invoke("approvals-window", { action }),   // "close" | "ontop-toggle" | "state"
});
