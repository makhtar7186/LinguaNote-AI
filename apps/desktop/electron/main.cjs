const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const api = require("./api-client.cjs");
const launcher = require("./backend-launcher.cjs");

const DEV_URL = "http://127.0.0.1:5173";
const PACKAGED_INDEX = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;

// Production CSP is strict. Development needs inline scripts and a websocket for Vite HMR.
const CSP_PACKAGED = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CSP_DEV = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173; object-src 'none'; base-uri 'none'";

let mainWindow;
let config;
let backend = null;
// "starting" until the Python service answers; "failed" keeps the reason for the status pill.
let backendState = { status: "starting", message: "Démarrage du service local…" };

async function startBackend() {
  try {
    if (launcher.planBackend().mode === "external") {
      config = api.getConfig();
    } else {
      backend = await launcher.startManagedBackend();
      config = { base: backend.base, token: backend.token };
    }
    backendState = { status: "ready" };
  } catch (error) {
    backendState = { status: "failed", message: error instanceof Error ? error.message : "Le service local n'a pas démarré." };
  }
}

function backendNotReady() {
  if (backendState.status === "ready") return null;
  return { ok: false, code: backendState.status === "starting" ? "starting" : "backend_start_failed", message: backendState.message };
}

function isAppUrl(url) {
  return app.isPackaged ? url === PACKAGED_INDEX : url.startsWith(`${DEV_URL}/`) || url === DEV_URL;
}

function isTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  return isAppUrl(event.senderFrame?.url ?? "");
}

function assertTrustedSender(event) {
  if (!isTrustedSender(event)) throw new Error("Untrusted renderer.");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 820,
    minWidth: 760,
    minHeight: 680,
    backgroundColor: "#f5f7fb",
    title: "LinguaNote AI",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    mainWindow.loadURL(DEV_URL);
  }
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  void startBackend();

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [app.isPackaged ? CSP_PACKAGED : CSP_DEV],
      },
    });
  });

  // Only the microphone, and only for our own window. Camera/screen requests are refused.
  const isOwnWindow = (webContents) => Boolean(mainWindow && webContents === mainWindow.webContents);
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => (
    isOwnWindow(webContents) && permission === "media" && details?.mediaType === "audio"
  ));
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const audioOnly = Array.isArray(details?.mediaTypes) && details.mediaTypes.every((type) => type === "audio");
    callback(isOwnWindow(webContents) && permission === "media" && audioOnly);
  });

  ipcMain.handle("linguanote:health", async (event) => {
    assertTrustedSender(event);
    return backendNotReady() ?? api.health(config);
  });

  ipcMain.handle("linguanote:transcribe", async (event, payload) => {
    assertTrustedSender(event);
    return backendNotReady() ?? api.transcribe(config, payload);
  });

  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", () => { backend?.stop(); });
