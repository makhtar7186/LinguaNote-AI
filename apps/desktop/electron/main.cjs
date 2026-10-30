const { app, BrowserWindow, globalShortcut, ipcMain, screen, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const api = require("./api-client.cjs");
const launcher = require("./backend-launcher.cjs");
const { createUrlPolicy } = require("./app-urls.cjs");
const { createBubbleController } = require("./bubble-controller.cjs");
const ipcTrust = require("./ipc-trust.cjs");
const { LiveClient } = require("./live-client.cjs");
const { createPositionStore } = require("./position-store.cjs");
const { registerShortcuts, resolveAccelerators, unregisterShortcuts } = require("./shortcuts.cjs");

const DEV_URL = "http://127.0.0.1:5173";
// Smoke test (npm run smoke): loads the built pages like the packaged app, drives them, reports, and exits.
// Windows stay hidden so the check never flashes anything on the user's screen.
const SMOKE = process.env.LINGUANOTE_SMOKE_TEST === "1";
const urls = createUrlPolicy({
  useDist: app.isPackaged || SMOKE, devUrl: DEV_URL, distDir: path.join(__dirname, "..", "dist"),
});

// Production CSP is strict. Development needs inline scripts and a websocket for Vite HMR.
const CSP_PACKAGED = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; "
  + "frame-ancestors 'none'";
const CSP_DEV = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173; object-src 'none'; base-uri 'none'; "
  + "frame-src 'none'";

let mainWindow = null;
let config;
let stopBackend = () => {};
let quitting = false;
let shortcutReport = { registered: [], failed: [] };
// "starting" until the Python service answers; "failed" keeps the reason for the status pill.
let backendState = { status: "starting", message: "Démarrage du service local…" };

const ownership = ipcTrust.createOwnership();

const bubble = createBubbleController({
  BrowserWindow,
  screen,
  preload: path.join(__dirname, "preload.cjs"),
  visibleOnStart: !SMOKE,
  // The bubble is the recording indicator: while the microphone is in use it cannot stay hidden or gone.
  shouldStayVisible: () => liveActive(),
  onClosed: () => {
    if (!quitting && liveActive()) createBubbleWindow();
  },
  positionStore: {
    // userData is only known once the app is ready, so the store is built on first use.
    load: () => positionStore().load(),
    save: (position) => positionStore().save(position),
  },
  loadPage: (window) => loadPage(window, "bubble"),
});
let cachedPositionStore = null;
function positionStore() {
  cachedPositionStore ??= createPositionStore(fs, path.join(app.getPath("userData"), "bubble-position.json"));
  return cachedPositionStore;
}

function loadPage(window, name) {
  if (urls.useDist) window.loadFile(urls.target(name));
  else window.loadURL(urls.target(name));
}

// -- backend ----------------------------------------------------------------------------------------------

async function startBackend() {
  try {
    if (launcher.planBackend().mode === "external") {
      config = api.getConfig();
    } else {
      const backend = await launcher.startManagedBackend(process.env, {
        // Registered as soon as the process exists, so quitting during startup still stops it.
        onSpawn: (stop) => { stopBackend = stop; },
        isCancelled: () => quitting,
        onUnexpectedExit: () => {
          backendState = { status: "failed", message: "Le service local s'est arrêté de façon inattendue. Relancez l'application." };
        },
      });
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

// -- windows and trust --------------------------------------------------------------------------------------

/** Both windows are ours; every IPC channel is checked against them and against the page that sent it. */
function appContents() {
  return [mainWindow?.webContents, bubble.webContents].filter((contents) => contents && !contents.isDestroyed());
}

function isTrustedSender(event) {
  return ipcTrust.isTrustedSender(event, appContents(), urls);
}

function assertTrustedSender(event) {
  if (!isTrustedSender(event)) throw new Error("Untrusted renderer.");
}

function broadcast(channel, payload) {
  for (const contents of appContents()) contents.send(channel, payload);
}

function guardNavigation(contents) {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!urls.isAppUrl(url)) event.preventDefault();
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 820,
    minWidth: 760,
    minHeight: 680,
    show: !SMOKE,
    backgroundColor: "#f5f7fb",
    title: "LinguaNote AI",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  guardNavigation(mainWindow.webContents);
  loadPage(mainWindow, "main");
  // The bubble is a companion of the main window: closing the main window ends the application.
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
}

function createBubbleWindow() {
  const window = bubble.create();
  guardNavigation(window.webContents);
}

// -- live dictation -----------------------------------------------------------------------------------------

let liveClient = null;
let disposeOwnerWatch = () => {};
const LIVE_IDLE_STATES = ["idle", "ended", "failed"];
const liveActive = () => Boolean(liveClient && !LIVE_IDLE_STATES.includes(liveClient.state));

/** Dictation must never run unseen: starting it always brings the bubble (the recording indicator) up. */
function ensureBubbleVisible() {
  if (!SMOKE && bubble.window && !bubble.isVisible()) bubble.setVisible(true);
}

function onLiveEvent(payload) {
  if (payload.type === "client_state" && payload.state === "connecting") ensureBubbleVisible();
  if (payload.type === "client_state" && LIVE_IDLE_STATES.includes(payload.state)) {
    ownership.release();
    disposeOwnerWatch(); // the session is over: stop watching the window that owned it
    disposeOwnerWatch = () => {};
  }
  broadcast("linguanote:live:event", payload);
}

function sendBubbleCommand(action) {
  bubble.webContents?.send("linguanote:command", { action });
}

function setBubbleVisible(visible) {
  if (!visible && liveActive()) {
    return { ok: false, code: "recording_active", message: "Arrêtez la dictée avant de masquer la bulle : elle indique que le micro est actif." };
  }
  return { ok: true, visible: bubble.setVisible(visible) };
}

// -- global shortcuts ---------------------------------------------------------------------------------------

function registerGlobalShortcuts() {
  const accelerators = resolveAccelerators();
  shortcutReport = registerShortcuts(globalShortcut, {
    toggleLive: {
      accelerator: accelerators.toggleLive,
      handler: () => {
        ensureBubbleVisible();
        sendBubbleCommand("toggle_live");
      },
    },
    pauseLive: {
      accelerator: accelerators.pauseLive,
      handler: () => {
        if (!liveClient) return;
        if (liveClient.paused) liveClient.resume();
        else liveClient.pause();
      },
    },
    toggleBubble: {
      accelerator: accelerators.toggleBubble,
      handler: () => setBubbleVisible(!bubble.isVisible()),
    },
  });
}

// -- IPC ----------------------------------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle("linguanote:health", async (event) => {
    assertTrustedSender(event);
    return backendNotReady() ?? api.health(config);
  });

  ipcMain.handle("linguanote:transcribe", async (event, payload) => {
    assertTrustedSender(event);
    return backendNotReady() ?? api.transcribe(config, payload);
  });

  ipcMain.handle("linguanote:live:start", async (event) => {
    assertTrustedSender(event);
    const notReady = backendNotReady();
    if (notReady) return notReady;
    if (liveActive()) return { ok: false, code: "already_running", message: "Une session en direct est déjà en cours." };
    liveClient = new LiveClient(config, {
      onEvent: onLiveEvent,
      onState: (state) => onLiveEvent({ type: "client_state", state }),
    });
    try {
      liveClient.start();
      // The window that starts a session owns the microphone for it; if that window disappears the session ends.
      disposeOwnerWatch();
      disposeOwnerWatch = ipcTrust.watchOwner(ownership, event.sender, () => liveClient?.stop());
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error.code ?? "unknown", message: error.message };
    }
  });

  // Audio is fire-and-forget (many small messages): invalid chunks are dropped, never forwarded.
  ipcMain.on("linguanote:live:audio", (event, chunk) => {
    // Only the window that owns the session's microphone may feed audio; the other window cannot inject any.
    if (!isTrustedSender(event) || !ownership.isOwner(event.sender.id) || !liveClient || !ArrayBuffer.isView(chunk)) return;
    try {
      liveClient.sendAudio(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch {
      // Malformed audio (odd length, too large): ignored; the session itself is unaffected.
    }
  });

  ipcMain.handle("linguanote:live:stop", async (event) => {
    assertTrustedSender(event);
    liveClient?.stop();
    return { ok: true };
  });

  ipcMain.handle("linguanote:live:pause", async (event) => {
    assertTrustedSender(event);
    return { ok: Boolean(liveClient?.pause()) };
  });

  ipcMain.handle("linguanote:live:resume", async (event) => {
    assertTrustedSender(event);
    return { ok: Boolean(liveClient?.resume()) };
  });

  // A window opened (or reloaded) mid-session learns the current state from here.
  ipcMain.handle("linguanote:live:status", async (event) => {
    assertTrustedSender(event);
    return { ok: true, state: liveClient?.state ?? "idle", paused: liveClient?.paused ?? false };
  });

  ipcMain.handle("linguanote:bubble:setExpanded", async (event, value) => {
    assertTrustedSender(event);
    return { ok: true, expanded: bubble.setExpanded(value === true) };
  });

  ipcMain.handle("linguanote:bubble:setVisible", async (event, value) => {
    assertTrustedSender(event);
    return setBubbleVisible(value === true);
  });

  ipcMain.handle("linguanote:bubble:state", async (event) => {
    assertTrustedSender(event);
    return { ok: true, visible: bubble.isVisible(), expanded: bubble.isExpanded() };
  });

  ipcMain.handle("linguanote:shortcuts:get", async (event) => {
    assertTrustedSender(event);
    return { ok: true, ...shortcutReport };
  });
}

// -- smoke test ---------------------------------------------------------------------------------------------

function once(contents, event) {
  return new Promise((resolve) => contents.once(event, resolve));
}

async function runSmokeTest() {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
  const run = (contents, code) => contents.executeJavaScript(code, true);
  const pending = Promise.all([once(mainWindow.webContents, "did-finish-load"), once(bubble.webContents, "did-finish-load")]);
  const loaded = await Promise.race([pending.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 30_000))]);
  check("both pages finished loading from the built files", loaded);

  if (loaded) {
    const probe = `(() => ({
      title: document.title,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
      require: typeof require, process: typeof process,
      bridge: Object.keys(window.linguaNote ?? {}).sort(),
      live: Object.keys(window.linguaNote?.live ?? {}).sort(),
      bubbleApi: Object.keys(window.linguaNote?.bubble ?? {}).sort(),
      hasRoot: document.getElementById('root')?.children.length > 0,
      marker: document.querySelector('[data-testid="bubble"]') !== null,
    }))()`;
    const mainProbe = await run(mainWindow.webContents, probe);
    const bubbleProbe = await run(bubble.webContents, probe);
    check("main page rendered with the strict CSP", mainProbe.hasRoot && /default-src 'self'/.test(mainProbe.csp ?? "") && !/unsafe-inline/.test(mainProbe.csp ?? ""), JSON.stringify(mainProbe.csp));
    check("bubble page rendered with the strict CSP", bubbleProbe.hasRoot && bubbleProbe.marker && /default-src 'self'/.test(bubbleProbe.csp ?? "") && !/unsafe-inline/.test(bubbleProbe.csp ?? ""));
    check("renderers have no Node.js (require/process undefined)", [mainProbe, bubbleProbe].every((p) => p.require === "undefined" && p.process === "undefined"));
    check("preload exposes only the documented API", JSON.stringify(mainProbe.bridge) === JSON.stringify(["bubble", "health", "live", "shortcuts", "transcribe"]), JSON.stringify(mainProbe.bridge));
    check("live API surface", JSON.stringify(mainProbe.live) === JSON.stringify(["onEvent", "pause", "resume", "sendAudio", "start", "status", "stop"]), JSON.stringify(mainProbe.live));

    const frameProbe = `new Promise((resolve) => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
      const frame = document.createElement('iframe');
      frame.src = location.href; // an allowed page of ours, in a frame
      document.body.appendChild(frame);
      setTimeout(() => resolve({ violations, sawLinguaNote: Boolean(frame.contentWindow?.linguaNote) }), 1500);
    })`;
    for (const [label, contents] of [["main", mainWindow.webContents], ["bubble", bubble.webContents]]) {
      const frames = await run(contents, frameProbe);
      check(`${label} page: a frame is blocked by the CSP and gets no bridge`, frames.violations.some((d) => d.startsWith("frame-src") || d.startsWith("child-src")) && !frames.sawLinguaNote, JSON.stringify(frames));
    }

    const win = bubble.window;
    const bounds = win.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    check("bubble is always on top, never focusable, frameless, small", win.isAlwaysOnTop() && !win.isFocusable() && bounds.width === 72 && bounds.height === 72, JSON.stringify(bounds));
    check("bubble is inside a display work area", bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height);

    const waitReady = async () => {
      for (let i = 0; i < 900 && backendState.status === "starting"; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    };
    await waitReady();
    check("local service started by Electron", backendState.status === "ready", backendState.message ?? "");
    if (backendState.status === "ready") {
      const health = await run(mainWindow.webContents, "window.linguaNote.health()");
      check("health through the bridge", health.ok === true && health.engine_selected === true, JSON.stringify({ ok: health.ok, engine: health.engine }));

      const expanded = await run(bubble.webContents, "window.linguaNote.bubble.setExpanded(true)");
      const bigger = win.getBounds();
      await run(bubble.webContents, "window.linguaNote.bubble.setExpanded(false)");
      const back = win.getBounds();
      check("bubble expands and collapses back to the same place", expanded.expanded === true && bigger.width === 340 && back.width === 72 && back.x === bounds.x && back.y === bounds.y, JSON.stringify({ bigger, back }));

      const hidden = await run(mainWindow.webContents, "window.linguaNote.bubble.setVisible(false)");
      check("bubble can be hidden when nothing is recording", hidden.ok === true && hidden.visible === false);

      const liveRun = await run(mainWindow.webContents, `(async () => {
        const events = [];
        const off = window.linguaNote.live.onEvent((event) => events.push(event));
        const wait = async (test, ms) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return test(); };
        const started = await window.linguaNote.live.start();
        const again = await window.linguaNote.live.start();
        const active = await wait(() => events.some((e) => e.type === 'client_state' && e.state === 'active'), 90000);
        const paused = await window.linguaNote.live.pause();
        const pausedAgain = await window.linguaNote.live.pause();
        const status = await window.linguaNote.live.status();
        const resumed = await window.linguaNote.live.resume();
        await window.linguaNote.live.stop();
        const ended = await wait(() => events.some((e) => e.type === 'session_ended'), 30000);
        const finalStatus = await window.linguaNote.live.status();
        off();
        return { started, again, active, paused, pausedAgain, status, resumed, ended, finalStatus,
          sequence: events.map((e) => e.type === 'client_state' ? 'state:' + e.state : e.type) };
      })()`);
      check("a live session opens through IPC (no microphone needed)", liveRun.started.ok && liveRun.active, JSON.stringify(liveRun.sequence));
      check("a second start is refused while one runs", liveRun.again.ok === false && liveRun.again.code === "already_running");
      check("pause, status and resume behave", liveRun.paused.ok && !liveRun.pausedAgain.ok && liveRun.status.paused === true && liveRun.resumed.ok);
      check("stop ends the session and is mirrored to every window", liveRun.ended && liveRun.finalStatus.state === "ended" && liveRun.sequence.includes("pause_state"), JSON.stringify(liveRun.sequence));
      const bubbleSaw = await run(bubble.webContents, "window.linguaNote.live.status()");
      check("the other window reads the same state", bubbleSaw.state === "ended");
    }
  }

  // The defaults are registered for real with Electron, then released at once. Another application holding one is a
  // legitimate outcome (reported, not an error); an accelerator Electron rejects as malformed is a real failure.
  const expectedAccelerators = resolveAccelerators();
  const reported = [...shortcutReport.registered, ...shortcutReport.failed];
  const malformed = shortcutReport.failed.filter((item) => item.reason !== "already_in_use_or_invalid");
  const wrongBinding = reported.filter((item) => expectedAccelerators[item.name] !== item.accelerator);
  check(
    "default global shortcuts: each name has its expected accelerator and Electron accepts it (registered, or reported as taken)",
    reported.length === 3 && new Set(reported.map((item) => item.name)).size === 3 && malformed.length === 0 && wrongBinding.length === 0,
    JSON.stringify({ registered: shortcutReport.registered.map((item) => item.name), taken: shortcutReport.failed.map((item) => item.name), malformed, wrongBinding }),
  );
  const ok = checks.every((item) => item.ok);
  const report = JSON.stringify({ ok, checks, shortcuts: shortcutReport }, null, 1);
  if (process.env.LINGUANOTE_SMOKE_OUTPUT) fs.writeFileSync(process.env.LINGUANOTE_SMOKE_OUTPUT, report, "utf8");
  console.log(`SMOKE_RESULT ${report}`);
  app.exit(ok ? 0 : 1);
}

// -- lifecycle ----------------------------------------------------------------------------------------------

app.whenReady().then(() => {
  void startBackend();

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [urls.useDist ? CSP_PACKAGED : CSP_DEV],
      },
    });
  });

  // Only the microphone, and only for our own windows. Camera/screen requests are refused.
  const isOwnWindow = (contents) => appContents().includes(contents);
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => (
    isOwnWindow(contents) && permission === "media" && details?.mediaType === "audio"
  ));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const audioOnly = Array.isArray(details?.mediaTypes) && details.mediaTypes.every((type) => type === "audio");
    callback(isOwnWindow(contents) && permission === "media" && audioOnly);
  });

  registerIpc();
  createMainWindow();
  createBubbleWindow();
  if (!SMOKE) registerGlobalShortcuts();
  else {
    // Smoke test: really register the defaults to prove they are valid, then release them immediately.
    const accelerators = resolveAccelerators();
    shortcutReport = registerShortcuts(globalShortcut, Object.fromEntries(
      Object.entries(accelerators).map(([name, accelerator]) => [name, { accelerator, handler: () => {} }]),
    ));
    unregisterShortcuts(globalShortcut, shortcutReport.registered);
  }

  app.on("activate", () => {
    if (!mainWindow) createMainWindow();
    if (!bubble.window) createBubbleWindow();
  });
  if (SMOKE) void runSmokeTest().catch((error) => {
    console.log(`SMOKE_RESULT ${JSON.stringify({ ok: false, error: String(error) })}`);
    app.exit(1);
  });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", () => {
  quitting = true;
  unregisterShortcuts(globalShortcut, shortcutReport.registered);
  liveClient?.close();
  bubble.destroy();
  stopBackend();
});
