// Global keyboard shortcuts. Free of Electron imports: `globalShortcut` is passed in so it can be faked in tests.

const DEFAULT_ACCELERATORS = {
  toggleLive: "CommandOrControl+Alt+Space", // start / stop dictation
  pauseLive: "CommandOrControl+Alt+P", // pause / resume dictation
  toggleBubble: "CommandOrControl+Alt+B", // show / hide the floating bubble
};

const ENV_NAMES = {
  toggleLive: "LINGUANOTE_SHORTCUT_TOGGLE_LIVE",
  pauseLive: "LINGUANOTE_SHORTCUT_PAUSE_LIVE",
  toggleBubble: "LINGUANOTE_SHORTCUT_TOGGLE_BUBBLE",
};

const REPEAT_GUARD_MS = 400; // holding the keys down repeats the event: act once

/** Accelerators, overridable by environment variables (an empty value disables that shortcut). */
function resolveAccelerators(env = process.env) {
  return Object.fromEntries(Object.entries(DEFAULT_ACCELERATORS).map(([name, fallback]) => {
    const override = env[ENV_NAMES[name]];
    return [name, override === undefined ? fallback : override.trim()];
  }));
}

/**
 * Registers each binding and reports honestly: a shortcut already taken by another application, an invalid
 * accelerator or a thrown error is a failure to show the user, never silently ignored.
 * @param {{register: Function, unregister: Function}} globalShortcut
 * @param {Record<string, {accelerator: string, handler: () => void}>} bindings
 * @returns {{registered: {name: string, accelerator: string}[], failed: {name: string, accelerator: string, reason: string}[]}}
 */
function registerShortcuts(globalShortcut, bindings, now = Date.now) {
  const registered = [];
  const failed = [];
  for (const [name, { accelerator, handler }] of Object.entries(bindings)) {
    if (!accelerator) {
      failed.push({ name, accelerator, reason: "disabled" });
      continue;
    }
    let lastRun = 0;
    const guarded = () => {
      const at = now();
      if (at - lastRun < REPEAT_GUARD_MS) return;
      lastRun = at;
      try {
        handler();
      } catch {
        // A shortcut handler must never take the application down.
      }
    };
    try {
      if (globalShortcut.register(accelerator, guarded)) registered.push({ name, accelerator });
      else failed.push({ name, accelerator, reason: "already_in_use_or_invalid" });
    } catch (error) {
      failed.push({ name, accelerator, reason: error instanceof Error ? error.message : "error" });
    }
  }
  return { registered, failed };
}

function unregisterShortcuts(globalShortcut, registered) {
  for (const { accelerator } of registered) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // Already released.
    }
  }
}

module.exports = { DEFAULT_ACCELERATORS, ENV_NAMES, REPEAT_GUARD_MS, resolveAccelerators, registerShortcuts, unregisterShortcuts };
