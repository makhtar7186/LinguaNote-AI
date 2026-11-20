const { app, BrowserWindow, ClipboardItem, Menu, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, webContents } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const api = require("./api-client.cjs");
const launcher = require("./backend-launcher.cjs");
const historyClient = require("./history-client.cjs");
const { createUrlPolicy } = require("./app-urls.cjs");
const { createBubbleController } = require("./bubble-controller.cjs");
const { createArmGate } = require("./capture-gate.cjs");
const { createCapturePlan } = require("./capture-plan.cjs");
const ipcTrust = require("./ipc-trust.cjs");
const { LiveClient } = require("./live-client.cjs");
const { createElectronClipboardPort } = require("./electron-clipboard.cjs");
const { createTextInserter } = require("./text-inserter.cjs");
const { createWindowsDesktop } = require("./windows-desktop.cjs");
const { createModelConsent } = require("./model-consent.cjs");
const { createPositionStore } = require("./position-store.cjs");
const { registerShortcuts, resolveAccelerators, unregisterShortcuts } = require("./shortcuts.cjs");

const DEV_URL = "http://127.0.0.1:5173";
// Smoke test (npm run smoke): loads the built pages like the packaged app, drives them, reports, and exits.
// Windows stay hidden so the check never flashes anything on the user's screen.
const SMOKE = process.env.LINGUANOTE_SMOKE_TEST === "1";

// Two instances would mean two bubbles, two recording indicators and global shortcuts fighting each other. A second
// launch brings the running one forward instead. The smoke test is exempt: it may run beside a real session.
if (!SMOKE && !app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

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
let armDialogOpen = false; // one insertion confirmation at a time
// Insertion into other applications is implemented for Windows only (docs/security.md); elsewhere it reports "unsupported".
const INSERTION_SUPPORTED = process.platform === "win32";
const inserter = INSERTION_SUPPORTED
  ? createTextInserter({
    clipboard: createElectronClipboardPort({ clipboard, ClipboardItem }),
    desktop: createWindowsDesktop(),
    onStatus: (status) => broadcast("linguanote:insertion:status", status),
  })
  : null;
const captureGate = createArmGate();
// The source a window declared before opening any device (see capture-plan.cjs).
const capturePlan = createCapturePlan();
// What the session listens to. Chosen explicitly by the user; never changed behind their back.
const CAPTURE_SOURCES = ["microphone", "system", "both"];
let liveSource = null;

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

/** The service and FFmpeg shipped next to the application (electron-builder extraResources), never inside the asar. */
function shippedService() {
  return {
    executable: path.join(process.resourcesPath, "service", "linguanote-service.exe"),
    ffmpeg: path.join(process.resourcesPath, "ffmpeg", "ffmpeg.exe"),
  };
}

/** An installed application asks before fetching model weights. The smoke test sets its own policy and never asks. */
async function downloadPolicy() {
  if (!app.isPackaged || SMOKE) return {};
  const consent = createModelConsent({
    fs,
    file: path.join(app.getPath("userData"), "model-download-consent.json"),
    ask: async () => {
      const choice = await dialog.showMessageBox({
        type: "question",
        buttons: ["Autoriser le téléchargement", "Pas maintenant"],
        defaultId: 0,
        cancelId: 1,
        title: "Modèle de reconnaissance vocale",
        message: "Autoriser le téléchargement du modèle de reconnaissance vocale ?",
        detail: "LinguaNote transcrit sur cet ordinateur, mais doit d'abord récupérer le modèle depuis Hugging Face, à la première transcription (environ 150 Mo pour le modèle par défaut). Aucun audio ni aucun texte n'est envoyé.\n\nSans ce modèle, la transcription reste indisponible. La question sera reposée au prochain lancement.",
      });
      return choice.response === 0;
    },
  });
  return consent.environment(process.env);
}

async function startBackend() {
  try {
    if (launcher.planBackend().mode === "external") {
      config = api.getConfig();
    } else {
      // History and logs live in the user's profile, not in the install folder; an explicit LINGUANOTE_DATA_DIR wins.
      const env = {
        ...process.env,
        LINGUANOTE_DATA_DIR: process.env.LINGUANOTE_DATA_DIR || path.join(app.getPath("userData"), "data"),
        ...(await downloadPolicy()),
      };
      const backend = await launcher.startManagedBackend(env, {
        packagedService: app.isPackaged ? shippedService() : undefined,
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
  if (SMOKE) return;
  if (!bubble.window) createBubbleWindow(); // it was closed: bring it back before anything records
  else if (!bubble.isVisible()) bubble.setVisible(true);
}

function onLiveEvent(payload) {
  if (inserter && payload.type === "final" && typeof payload.text === "string") inserter.submit(payload.text);
  if (payload.type === "client_state" && payload.state === "connecting") ensureBubbleVisible();
  if (payload.type === "client_state" && LIVE_IDLE_STATES.includes(payload.state)) {
    ownership.release();
    inserter?.sessionEnded();
    liveSource = null;
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

  // Insertion into the application in front. Armed by the user, bound to a running session, status always broadcast.
  ipcMain.handle("linguanote:insertion:arm", async (event) => {
    assertTrustedSender(event);
    if (!inserter) return { ok: false, code: "unsupported", message: "L’insertion dans une autre application n’est disponible que sur Windows." };
    if (!liveActive()) return { ok: false, code: "no_live_session", message: "Démarrez d’abord une dictée en direct." };
    // A system dialog the page cannot click: the main process cannot tell a real click from a script calling the
    // bridge, so typing into other applications needs this explicit confirmation (skipped only by the smoke test).
    if (armDialogOpen) return { ok: false, code: "declined", message: "Une confirmation est déjà affichée." };
    if (!SMOKE) {
      armDialogOpen = true;
      const choice = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender) ?? undefined, {
        type: "question",
        buttons: ["Activer l’insertion", "Annuler"],
        defaultId: 1,
        cancelId: 1,
        title: "Insérer dans une autre application",
        message: "Coller le texte dicté dans une autre application ?",
        detail: "Après ce message, vous aurez 3 secondes pour cliquer dans la fenêtre cible. Le texte y sera collé au fur et à mesure (Ctrl+V). Vous pourrez arrêter à tout moment.",
      }).finally(() => { armDialogOpen = false; });
      if (choice.response !== 0) return { ok: false, code: "declined", message: "Insertion annulée." };
      if (!liveActive()) return { ok: false, code: "no_live_session", message: "La dictée en direct s’est arrêtée." };
    }
    return inserter.arm();
  });
  ipcMain.handle("linguanote:insertion:stop", async (event) => {
    assertTrustedSender(event);
    return inserter ? inserter.stop() : { ok: true, dropped: 0 };
  });
  ipcMain.handle("linguanote:insertion:status", async (event) => {
    assertTrustedSender(event);
    return { supported: Boolean(inserter), ...(inserter ? inserter.status() : { state: "off" }) };
  });

  // History: one channel per operation of an allow-list; arguments are validated in history-client.cjs.
  ipcMain.handle("linguanote:history:run", async (event, operation, args) => {
    assertTrustedSender(event);
    if (typeof operation !== "string") return { ok: false, code: "invalid_argument", message: "Opération inconnue." };
    return backendNotReady() ?? historyClient.run(config, operation, args);
  });

  // The file is written here, in the main process, to a place the user picks in a native dialog:
  // the renderer never supplies a path.
  ipcMain.handle("linguanote:history:export", async (event, args) => {
    assertTrustedSender(event);
    const notReady = backendNotReady();
    if (notReady) return notReady;
    const exported = await historyClient.exportSession(config, args);
    if (!exported.ok) return exported;
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const choice = await dialog.showSaveDialog(owner, {
      title: "Exporter la transcription",
      defaultPath: path.join(app.getPath("documents"), exported.suggestedName),
      filters: [{ name: args.format.toUpperCase(), extensions: [args.format] }],
    });
    if (choice.canceled || !choice.filePath) return { ok: true, saved: false };
    try {
      await fs.promises.writeFile(choice.filePath, exported.content, "utf8");
    } catch {
      return { ok: false, code: "write_failed", message: "Le fichier n'a pas pu être écrit à cet emplacement." };
    }
    return { ok: true, saved: true };
  });

  // Step 1 of a session: the window declares the source it is about to open. The recording indicator (the bubble) is
  // made visible NOW, before any microphone or loopback is opened, and system audio can only be armed after this.
  ipcMain.handle("linguanote:live:prepare", async (event, options) => {
    assertTrustedSender(event);
    const notReady = backendNotReady();
    if (notReady) return notReady;
    if (liveActive()) return { ok: false, code: "already_running", message: "Une session en direct est déjà en cours." };
    if (!capturePlan.declare(event.sender.id, options?.source ?? "microphone")) {
      return { ok: false, code: "invalid_source", message: "Source audio inconnue." };
    }
    ensureBubbleVisible();
    return { ok: true };
  });

  ipcMain.handle("linguanote:live:start", async (event, options) => {
    assertTrustedSender(event);
    const notReady = backendNotReady();
    if (notReady) return notReady;
    // An unknown source is an error, never a silent fallback to the microphone.
    const requested = options?.source ?? "microphone";
    if (!CAPTURE_SOURCES.includes(requested)) {
      capturePlan.clear();
      return { ok: false, code: "invalid_source", message: "Source audio inconnue." };
    }
    if (liveActive()) return { ok: false, code: "already_running", message: "Une session en direct est déjà en cours." };
    liveClient = new LiveClient(config, {
      onEvent: onLiveEvent,
      onState: (state) => onLiveEvent({ type: "client_state", state }),
      source: requested,
    });
    // Claim and watch the owning window BEFORE starting, so a start that fails at once leaves nothing behind.
    disposeOwnerWatch();
    const started = ipcTrust.beginSession({
      ownership,
      owner: event.sender,
      start: () => liveClient.start(),
      onOwnerGone: () => liveClient?.stop(),
      onWatch: (dispose) => { disposeOwnerWatch = dispose; },
    });
    capturePlan.clear(); // the session is now the authority for its own source
    if (!started.ok) {
      disposeOwnerWatch = () => {};
      return { ok: false, code: started.error.code ?? "unknown", message: started.error.message };
    }
    if (liveActive()) {
      liveSource = requested;
      onLiveEvent({ type: "capture_source", source: liveSource }); // every window shows what is being listened to
    }
    return { ok: true };
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
    // A stop, whatever the stage, also cancels a declaration that has not become a session yet: no capture of the
    // computer sound may be armed afterwards on the strength of an intention the user has just withdrawn.
    capturePlan.clear();
    captureGate.disarm();
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
    return { ok: true, state: liveClient?.state ?? "idle", paused: liveClient?.paused ?? false, source: liveSource };
  });

  // The renderer announces it is about to ask for system audio. Without this, the display handler denies.
  ipcMain.handle("linguanote:capture:armSystemAudio", async (event) => {
    assertTrustedSender(event);
    // Only after the window declared a plan that uses the computer sound, or for the running session that does. A
    // script cannot arm the gate on its own, so the bubble is guaranteed to be up whenever system audio is captured.
    const allowed = capturePlan.allowsSystemAudio(event.sender.id, { ownerId: ownership.current, source: liveSource });
    if (!allowed) {
      return { ok: false, code: "not_declared", message: "Choisissez d'abord le son de l'ordinateur comme source." };
    }
    ensureBubbleVisible();
    captureGate.arm(event.sender.id);
    return { ok: true };
  });

  ipcMain.handle("linguanote:capture:disarm", async (event) => {
    assertTrustedSender(event);
    captureGate.disarm();
    capturePlan.clear(); // withdrawing the request also withdraws the declaration it relied on
    return { ok: true };
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
  check("no developer menu (reload, developer tools) in the built application", Menu.getApplicationMenu() === null);
  if (app.isPackaged) {
    const shipped = shippedService();
    check("installed application: the service and FFmpeg are shipped outside the archive", fs.existsSync(shipped.executable) && fs.existsSync(shipped.ffmpeg), JSON.stringify(shipped));
  }

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
    check("preload exposes only the documented API", JSON.stringify(mainProbe.bridge) === JSON.stringify(["bubble", "capture", "health", "history", "insertion", "live", "shortcuts", "transcribe"]), JSON.stringify(mainProbe.bridge));
    check("live API surface", JSON.stringify(mainProbe.live) === JSON.stringify(["onEvent", "pause", "prepare", "resume", "sendAudio", "start", "status", "stop"]), JSON.stringify(mainProbe.live));

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

    // A declaration is refused while the service starts: without this wait, the checks below could pass for that reason.
    for (let i = 0; i < 1200 && backendState.status === "starting"; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));

    // System audio capture is denied unless the window armed it first, once, and only for itself.
    const askForSystemAudio = `(async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const audio = stream.getAudioTracks().map((t) => t.label);
        const hadVideo = stream.getVideoTracks().length;
        stream.getTracks().forEach((t) => t.stop());
        return { granted: true, audio, hadVideo };
      } catch (error) { return { granted: false, name: error.name }; }
    })()`;
    const unarmed = await run(mainWindow.webContents, askForSystemAudio);
    check("system audio is denied when nothing armed it", unarmed.granted === false, JSON.stringify(unarmed));

    // A script cannot arm the gate on its own: the window must first declare a plan that uses the computer sound.
    const armBare = await run(mainWindow.webContents, "window.linguaNote.capture.armSystemAudio()");
    check("arming without declaring the source is refused", armBare.ok === false && armBare.code === "not_declared", JSON.stringify(armBare));

    await run(mainWindow.webContents, "window.linguaNote.live.prepare({ source: 'microphone' })");
    const armForMicrophone = await run(mainWindow.webContents, "window.linguaNote.capture.armSystemAudio()");
    check("arming after declaring the microphone only is refused", armForMicrophone.ok === false, JSON.stringify(armForMicrophone));

    const unknown = await run(mainWindow.webContents, "window.linguaNote.live.prepare({ source: 'cloud' })");
    check("declaring an unknown source is refused, not defaulted", unknown.ok === false && unknown.code === "invalid_source", JSON.stringify(unknown));
    const stillRefused = await run(mainWindow.webContents, "window.linguaNote.capture.armSystemAudio()");
    check("a refused declaration leaves nothing armable", stillRefused.ok === false);

    // Withdrawing the intention (stop, or disarm) must leave nothing armable, even though the plan has 30 s to live.
    await run(mainWindow.webContents, "window.linguaNote.live.prepare({ source: 'system' })");
    await run(mainWindow.webContents, "window.linguaNote.live.stop()");
    const afterStop = await run(mainWindow.webContents, "window.linguaNote.capture.armSystemAudio()");
    check("a stop withdraws the declaration: arming afterwards is refused", afterStop.ok === false && afterStop.code === "not_declared", JSON.stringify(afterStop));
    await run(mainWindow.webContents, "window.linguaNote.live.prepare({ source: 'system' })");
    await run(mainWindow.webContents, "window.linguaNote.capture.disarm()");
    const afterDisarm = await run(mainWindow.webContents, "window.linguaNote.capture.armSystemAudio()");
    check("withdrawing the request also withdraws the declaration", afterDisarm.ok === false && afterDisarm.code === "not_declared", JSON.stringify(afterDisarm));

    const declared = await run(mainWindow.webContents, "window.linguaNote.live.prepare({ source: 'system' })");
    check("declaring the computer sound is accepted", declared.ok === true, JSON.stringify(declared));
    const armed1 = await run(mainWindow.webContents, "window.linguaNote.capture.armSystemAudio()");
    check("arming after declaring the computer sound is accepted", armed1.ok === true, JSON.stringify(armed1));

    const otherWindow = await run(bubble.webContents, askForSystemAudio);
    check("an arm made by one window cannot be used by the other", otherWindow.granted === false, JSON.stringify(otherWindow));

    const armed = await run(mainWindow.webContents, askForSystemAudio);
    check("system audio is granted to the window that armed it (loopback audio track)", armed.granted === true && armed.audio.length === 1 && /audio/i.test(armed.audio[0]), JSON.stringify(armed));

    const reused = await run(mainWindow.webContents, askForSystemAudio);
    check("the arm is single-use: a second request is denied", reused.granted === false, JSON.stringify(reused));

    const win = bubble.window;
    const bounds = win.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    check("bubble is always on top, never focusable, frameless, small", win.isAlwaysOnTop() && !win.isFocusable() && bounds.width === 72 && bounds.height === 72, JSON.stringify(bounds));
    check("bubble is inside a display work area", bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height);

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

      // History through the real bridge, IPC and service. The run's data folder is a throw-away one (see scripts/smoke.cjs).
      const history = await run(mainWindow.webContents, `(async () => {
        const h = window.linguaNote.history;
        const before = await h.getSettings();
        const offLive = await h.list({});
        const badRetention = await h.setSettings(true, 13);
        const badId = await h.get('../health');
        const noConfirm = await h.removeAll(false);
        const enabled = await h.setSettings(true, 30);
        const events = [];
        const off = window.linguaNote.live.onEvent((event) => events.push(event));
        await window.linguaNote.live.start({ source: 'microphone' });
        const wait = async (test, ms) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return test(); };
        await wait(() => events.some((e) => e.type === 'client_state' && e.state === 'active'), 90000);
        await window.linguaNote.live.stop();
        await wait(() => events.some((e) => e.type === 'session_ended'), 30000);
        off();
        const listed = await h.list({});
        const first = listed.data?.items?.[0];
        const detail = first ? await h.get(first.id) : null;
        const renamed = first ? await h.rename(first.id, 'Essai fumée') : null;
        const deleted = first ? await h.remove(first.id) : null;
        const afterDelete = await h.list({});
        const all = await h.removeAll(true);
        await h.setSettings(false, 30);
        return { before, offLive, badRetention, badId, noConfirm, enabled, listed, detail, renamed, deleted, afterDelete, all };
      })()`);
      check("history is off by default", history.before.ok && history.before.data.enabled === false && history.offLive.data.total === 0, JSON.stringify(history.before));
      check("history refuses an invalid retention, a path-like id and an unconfirmed wipe", history.badRetention.ok === false && history.badId.ok === false && history.noConfirm.ok === false, JSON.stringify({ a: history.badRetention, b: history.badId, c: history.noConfirm }));
      check("history can be turned on through the bridge", history.enabled.ok && history.enabled.data.enabled === true);
      check("a live session is recorded once the history is on, with the source the window declared", history.listed.ok && history.listed.data.total === 1 && history.detail.data.source === "microphone" && history.detail.data.status === "complete", JSON.stringify(history.listed.data?.items?.[0]));
      check("a session can be renamed and deleted, and deleting everything works", history.renamed.ok && history.deleted.ok && history.afterDelete.data.total === 0 && history.all.ok);
    }
  }

  if (process.env.LINGUANOTE_SMOKE_SYSTEM_AUDIO === "1" && backendState.status === "ready") {
    // AUDIBLE: the computer speaks one short sentence through its default output, which is captured as "computer
    // sound" through the real UI and the real pipeline, and must come back as text.
    const driveUi = `(async () => {
      const wait = async (test, ms) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 200)); return test(); };
      const select = [...document.querySelectorAll('label')].find((l) => l.textContent.startsWith('Source audio'))?.querySelector('select');
      const press = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(label));
      if (!select || !press('Démarrer le direct')) return { error: 'controls not found' };
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'system');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      press('Démarrer le direct').click();
      const live = await wait(() => document.querySelector('[data-testid="active-source"]'), 90000);
      return { live: Boolean(live), badge: document.querySelector('[data-testid="active-source"]')?.textContent ?? null,
               alerts: [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent) };
    })()`;
    const started = await run(mainWindow.webContents, driveUi);
    check("the real UI starts a session on the computer sound", started.live === true && /Son de l’ordinateur/.test(started.badge ?? ""), JSON.stringify(started));

    if (started.live) {
      const speaker = require("node:child_process").spawn("powershell", ["-NoProfile", "-Command",
        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Hortense Desktop'); Start-Sleep -Milliseconds 800; $s.Speak('Le train pour Dakar part de la gare a huit heures du matin.')"],
      { windowsHide: true, stdio: "ignore" });
      const heard = await run(mainWindow.webContents, `(async () => {
        const wait = async (test, ms) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 300)); return test(); };
        const text = () => document.querySelector('.live-transcript')?.textContent ?? '';
        await wait(() => /matin/i.test(text()), 60000); // the last word of the sentence
        const level = document.querySelector('[role="meter"]')?.getAttribute('aria-valuenow');
        const transcript = text();
        [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Arrêter'))?.click();
        await wait(() => /Session terminée/.test(document.body.textContent), 30000);
        return { transcript, level, ended: /Session terminée/.test(document.body.textContent) };
      })()`);
      speaker.kill();
      // Not a quality measurement: the smallest model may mishear a word. The check is that the captured computer sound
      // really travelled through the pipeline and came back as most of the sentence.
      const reference = "le train pour dakar part de la gare a huit heures du matin".split(" ");
      const words = new Set(heard.transcript.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/));
      const overlap = reference.filter((word) => words.has(word)).length / reference.length;
      check(`what the computer played came back as text (${Math.round(overlap * 100)} % of the words; system audio -> live transcription)`, overlap >= 0.5, JSON.stringify(heard));
      check("the session ended cleanly after the audible scenario", heard.ended === true);
    }
  }

  if (process.env.LINGUANOTE_SMOKE_INSERTION === "1" && backendState.status === "ready" && inserter) {
    // OPT-IN (it takes the focus and types): a small test window with a text box is opened, insertion is armed while it
    // is in front, and finalised sentences must arrive in that text box, with the user's clipboard put back afterwards.
    const os = require("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "linguanote-insert-"));
    const readyFile = path.join(tmp, "ready");
    const doneFile = path.join(tmp, "done");
    const resultFile = path.join(tmp, "result.txt");
    const title = "LinguaNote cible de test";
    const formScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $f = New-Object System.Windows.Forms.Form
      $f.Text = '${title}'; $f.Width = 520; $f.Height = 220; $f.TopMost = $true; $f.StartPosition = 'CenterScreen'
      $t = New-Object System.Windows.Forms.TextBox
      $t.Multiline = $true; $t.Dock = 'Fill'; $f.Controls.Add($t)
      $f.Add_Shown({ $f.Activate(); $t.Focus(); Set-Content -Path '${readyFile}' -Value 'ready' })
      $timer = New-Object System.Windows.Forms.Timer
      $timer.Interval = 300
      $timer.Add_Tick({ if (Test-Path '${doneFile}') { [System.IO.File]::WriteAllText('${resultFile}', $t.Text); $f.Close() } })
      $timer.Start()
      [void]$f.ShowDialog()`;
    const form = require("node:child_process").spawn("powershell.exe", ["-NoProfile", "-Command", formScript], { windowsHide: false, stdio: "ignore" });
    const waitFile = async (file, ms) => { const end = Date.now() + ms; while (!fs.existsSync(file) && Date.now() < end) await new Promise((r) => setTimeout(r, 200)); return fs.existsSync(file); };
    const originalClipboard = "PRESSE-PAPIERS DE L'UTILISATEUR";
    try {
      const formUp = await waitFile(readyFile, 20000);
      check("insertion test window opened", formUp);
      if (formUp) {
        const startedLive = await run(mainWindow.webContents, "window.linguaNote.live.start()");
        let active = false;
        for (let i = 0; i < 900 && !active; i += 1) { active = liveClient?.state === "active"; if (!active) await new Promise((r) => setTimeout(r, 100)); }
        check("a live session is running for the insertion test", startedLive.ok && active);
        await clipboard.writeText(originalClipboard);
        const armedResult = await run(mainWindow.webContents, "window.linguaNote.insertion.arm()");
        check("insertion can be armed during a live session", armedResult.ok === true, JSON.stringify(armedResult));
        for (let i = 0; i < 100 && inserter.status().state === "locking"; i += 1) await new Promise((r) => setTimeout(r, 100));
        const locked = inserter.status();
        const targetOk = locked.state === "on" && locked.target?.title === title;
        check("the window in front when the countdown ends is the one locked", targetOk, JSON.stringify(locked));
        if (targetOk) {
          inserter.submit("Le train pour Dakar");
          inserter.submit("part à huit heures.");
          for (let i = 0; i < 150 && (inserter.status().pendingChars > 0 || inserter.status().inserted === 0); i += 1) await new Promise((r) => setTimeout(r, 100));
          await new Promise((r) => setTimeout(r, 600));
          const clipboardAfter = await clipboard.readText();
          check("the clipboard of the user is back after the insertion", clipboardAfter === originalClipboard, clipboardAfter);
        } else {
          inserter.stop(); // never type into a window that is not the test window
        }
        await run(mainWindow.webContents, "window.linguaNote.live.stop()");
      }
    } finally {
      fs.writeFileSync(doneFile, "done");
      await waitFile(resultFile, 10000);
      const typed = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, "utf8") : null;
      check("the sentences arrived in the target window, in order, with their accents", typed !== null && typed.replace(/\s+/g, " ").trim() === "Le train pour Dakar part à huit heures.", JSON.stringify(typed));
      form.kill();
      fs.rmSync(tmp, { recursive: true, force: true });
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
  const report = JSON.stringify({ ok, packaged: app.isPackaged, checks, shortcuts: shortcutReport }, null, 1);
  if (process.env.LINGUANOTE_SMOKE_OUTPUT) fs.writeFileSync(process.env.LINGUANOTE_SMOKE_OUTPUT, report, "utf8");
  console.log(`SMOKE_RESULT ${report}`);
  app.exit(ok ? 0 : 1);
}

// -- lifecycle ----------------------------------------------------------------------------------------------

app.whenReady().then(() => {
  // Electron's default menu offers reload and the developer tools: not for an installed application. Copy and paste
  // keep working: Chromium handles those keys itself.
  if (urls.useDist) Menu.setApplicationMenu(null);
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
  // "display-capture" (system audio) is allowed only for our windows and only while the gate is armed; the display
  // media handler below then still checks the frame and consumes the single-use arm.
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => (
    isOwnWindow(contents)
    && ((permission === "media" && details?.mediaType === "audio") || (permission === "display-capture" && captureGate.isArmed))
  ));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const audioOnly = Array.isArray(details?.mediaTypes) && details.mediaTypes.every((type) => type === "audio");
    callback(
      isOwnWindow(contents)
      && ((permission === "media" && audioOnly) || (permission === "display-capture" && captureGate.isArmed)),
    );
  });

  // System audio ("loopback": what the computer plays). Electron only serves it together with a screen source,
  // so the handler hands one over and the page drops the video track at once. Denied unless a trusted window armed
  // the gate a moment earlier; the answer is always audio loopback, never anything else.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const contents = request.frame ? webContents.fromFrame(request.frame) : null;
      const trusted = contents && ipcTrust.isTrustedSender({ sender: contents, senderFrame: request.frame }, appContents(), urls);
      if (!trusted || !request.audioRequested || !captureGate.consume(contents.id)) {
        callback(); // deny
        return;
      }
      const [screenSource] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
      if (!screenSource) {
        callback();
        return;
      }
      callback({ video: screenSource, audio: "loopback" });
    } catch {
      try { callback(); } catch { /* the request is already settled */ }
    }
  }, { useSystemPicker: false });

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
  inserter?.stop();
  quitting = true;
  unregisterShortcuts(globalShortcut, shortcutReport.registered);
  liveClient?.close();
  bubble.destroy();
  stopBackend();
});
