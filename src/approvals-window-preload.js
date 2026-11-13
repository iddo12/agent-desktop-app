// Preload of the THYRA dock window: ONLY the approvals calls and the two asks calls (list, answer), nothing else of the app's API.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("api", {
  approvalsList: () => ipcRenderer.invoke("approvals-list"),
  approvalsDecide: (decisions, via) => ipcRenderer.invoke("approvals-decide", { decisions, via }),
  dockAsksList: () => ipcRenderer.invoke("dock-asks-list"),   // v1.154.0 "Questions for you"
  dockAskAnswer: (req) => ipcRenderer.invoke("dock-ask-answer", req),
  dockAskReply: (req) => ipcRenderer.invoke("dock-ask-reply", req),   // v1.155.0 free-text reply from the dock
  dockAskKeep: (req) => ipcRenderer.invoke("dock-ask-keep", req),   // v1.155.0 "Still waiting"
  dockAskUndo: (req) => ipcRenderer.invoke("dock-ask-undo", req),   // v1.155.0 restore an automatically cleared question
  dockAskDismiss: (req) => ipcRenderer.invoke("dock-ask-dismiss", req),   // v1.154.1 "No longer needed": clears an ask, no answer, no seal
  thyraTasksLoad: () => ipcRenderer.invoke("thyra-tasks-load"),   // v1.156.0 Task list tab (read-only)
  thyraIdeasLoad: () => ipcRenderer.invoke("thyra-ideas-load"),   // v1.156.0 Ideas tab
  thyraIdeaSend: (req) => ipcRenderer.invoke("thyra-idea-send", req),
  thyraIdeaBuilt: (req) => ipcRenderer.invoke("thyra-idea-built", req),
  onApprovalsChanged: (callback) => { ipcRenderer.on("approvals-changed", () => callback()); },
  approvalsWindow: (action) => ipcRenderer.invoke("approvals-window", { action }),   // "close" | "ontop-toggle" | "state"
});
