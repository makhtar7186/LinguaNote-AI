const { contextBridge, ipcRenderer } = require("electron");

// A listener subscription on one fixed channel; returns the function that removes it.
function subscribe(channel, listener) {
  if (typeof listener !== "function") return () => {};
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// Every call below maps to one fixed channel validated by the main process; nothing is forwarded blindly.
contextBridge.exposeInMainWorld("linguaNote", {
  health: () => ipcRenderer.invoke("linguanote:health"),
  transcribe: (payload) => ipcRenderer.invoke("linguanote:transcribe", payload),

  // Live dictation. The main process owns the connection and the secret; the renderer only hands over
  // audio and receives events (every window receives them: the bubble and the main window mirror each other).
  live: {
    // options.source: "microphone" | "system" | "both" (validated by the main process; unknown values are refused)
    start: (options) => ipcRenderer.invoke("linguanote:live:start", { source: options?.source }),
    sendAudio: (pcm) => {
      // ArrayBuffer.isView: `instanceof` is unreliable across the context-isolation boundary.
      if (ArrayBuffer.isView(pcm)) ipcRenderer.send("linguanote:live:audio", pcm);
    },
    stop: () => ipcRenderer.invoke("linguanote:live:stop"),
    pause: () => ipcRenderer.invoke("linguanote:live:pause"),
    resume: () => ipcRenderer.invoke("linguanote:live:resume"),
    status: () => ipcRenderer.invoke("linguanote:live:status"),
    onEvent: (listener) => subscribe("linguanote:live:event", listener),
  },

  // System audio capture is denied unless this is called first (see capture-gate.cjs).
  capture: {
    armSystemAudio: () => ipcRenderer.invoke("linguanote:capture:armSystemAudio"),
    disarm: () => ipcRenderer.invoke("linguanote:capture:disarm"),
  },

  // The floating bubble.
  bubble: {
    setExpanded: (value) => ipcRenderer.invoke("linguanote:bubble:setExpanded", value === true),
    setVisible: (value) => ipcRenderer.invoke("linguanote:bubble:setVisible", value === true),
    getState: () => ipcRenderer.invoke("linguanote:bubble:state"),
    // Commands from global shortcuts that need the microphone (only the renderer can capture audio).
    onCommand: (listener) => subscribe("linguanote:command", listener),
  },

  shortcuts: {
    getReport: () => ipcRenderer.invoke("linguanote:shortcuts:get"),
  },
});
