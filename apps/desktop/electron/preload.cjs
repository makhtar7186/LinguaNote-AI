const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("linguaNote", {
  health: () => ipcRenderer.invoke("linguanote:health"),
  transcribe: (payload) => ipcRenderer.invoke("linguanote:transcribe", payload),
  // Live transcription. The main process owns the connection and the secret; the renderer only
  // hands over audio and receives events. Each call below is a fixed channel, nothing is forwarded blindly.
  live: {
    start: () => ipcRenderer.invoke("linguanote:live:start"),
    sendAudio: (pcm) => {
      // ArrayBuffer.isView: `instanceof` is unreliable across the context-isolation boundary.
      if (ArrayBuffer.isView(pcm)) ipcRenderer.send("linguanote:live:audio", pcm);
    },
    stop: () => ipcRenderer.invoke("linguanote:live:stop"),
    onEvent: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("linguanote:live:event", handler);
      return () => ipcRenderer.removeListener("linguanote:live:event", handler);
    },
  },
});
