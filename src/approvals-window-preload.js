// Preload of the THYRA dock window: ONLY the approvals calls and the two asks calls (list, answer), nothing else of the app's API.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("api", {
  approvalsList: () => ipcRenderer.invoke("approvals-list"),
  approvalsDecide: (decisions, via) => ipcRenderer.invoke("approvals-decide", { decisions, via }),
  dockAsksList: () => ipcRenderer.invoke("dock-asks-list"),   // v1.154.0 "Questions for you"
  dockAskAnswer: (req) => ipcRenderer.invoke("dock-ask-answer", req),
  dockAskDismiss: (req) => ipcRenderer.invoke("dock-ask-dismiss", req),   // v1.154.1 "No longer needed": clears an ask, no answer, no seal
  onApprovalsChanged: (callback) => { ipcRenderer.on("approvals-changed", () => callback()); },
  approvalsWindow: (action) => ipcRenderer.invoke("approvals-window", { action }),   // "close" | "ontop-toggle" | "state"
});
