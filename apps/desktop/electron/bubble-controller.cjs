// Lifecycle of the floating bubble window. Electron objects are injected so the logic can be tested without a GUI.
const geometry = require("./bubble-geometry.cjs");

const SAVE_DELAY_MS = 400;

/**
 * @param {object} deps
 * @param {Function} deps.BrowserWindow
 * @param {{getAllDisplays: Function, getPrimaryDisplay: Function}} deps.screen
 * @param {{load: Function, save: Function}} deps.positionStore
 * @param {string} deps.preload       absolute path of the preload script
 * @param {(window: object) => void} deps.loadPage  loads the bubble page into the window
 * @param {boolean} [deps.visibleOnStart=true]  false in the smoke test, which must not flash windows
 */
function createBubbleController({ BrowserWindow, screen, positionStore, preload, loadPage, visibleOnStart = true }) {
  let win = null;
  let expanded = false;
  let saveTimer = null;

  const workAreaFor = (bounds) => geometry.pickWorkArea(bounds, screen.getAllDisplays(), screen.getPrimaryDisplay());

  function startBounds() {
    const saved = positionStore.load();
    if (!saved) return geometry.defaultBounds(screen.getPrimaryDisplay().workArea);
    // A saved spot on a screen that is gone (or a changed resolution) must not strand the bubble off screen.
    const probe = { ...saved, ...geometry.COLLAPSED };
    return geometry.clampToWorkArea(probe, workAreaFor(probe));
  }

  function create() {
    if (win && !win.isDestroyed()) return win;
    expanded = false;
    win = new BrowserWindow({
      ...startBounds(),
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true, // a utility window: the main window keeps the taskbar entry
      focusable: false, // clicking the bubble must not take the keyboard focus away from the user's document
      show: false,
      title: "LinguaNote AI",
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    loadPage(win);

    win.once("ready-to-show", () => {
      if (visibleOnStart && win && !win.isDestroyed()) win.showInactive();
    });
    win.on("moved", () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (win && !win.isDestroyed()) {
          const { x, y } = win.getBounds();
          positionStore.save({ x, y });
        }
      }, SAVE_DELAY_MS);
    });
    win.on("closed", () => {
      clearTimeout(saveTimer);
      win = null;
    });
    return win;
  }

  return {
    create,
    get window() { return win && !win.isDestroyed() ? win : null; },
    get webContents() { return win && !win.isDestroyed() ? win.webContents : null; },
    isVisible: () => Boolean(win && !win.isDestroyed() && win.isVisible()),
    isExpanded: () => expanded,

    /** Collapsed <-> expanded, anchored on the nearest screen corner and always kept on screen. */
    setExpanded(value) {
      if (!win || win.isDestroyed()) return false;
      const bounds = win.getBounds();
      win.setBounds(geometry.resizeAnchored(bounds, value ? geometry.EXPANDED : geometry.COLLAPSED, workAreaFor(bounds)));
      expanded = Boolean(value);
      return expanded;
    },

    /** Shows without stealing focus, or hides. Returns the resulting visibility. */
    setVisible(value) {
      if (!win || win.isDestroyed()) return false;
      if (value) win.showInactive();
      else win.hide();
      return win.isVisible();
    },

    destroy() {
      clearTimeout(saveTimer);
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}

module.exports = { createBubbleController, SAVE_DELAY_MS };
