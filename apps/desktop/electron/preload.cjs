const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("linguaNote", {
  health: () => ipcRenderer.invoke("linguanote:health"),
  transcribe: (payload) => ipcRenderer.invoke("linguanote:transcribe", payload),
});
