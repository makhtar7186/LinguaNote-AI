// Deny-by-default gate for system audio capture. Free of Electron imports.
//
// Capturing what the computer plays needs getDisplayMedia, and Electron only answers it through a handler that must
// also hand over a screen source. Without a gate, any script able to call getDisplayMedia would silently get the
// screen. So the handler grants a request only if the trusted window asked for it a moment earlier through an
// explicit IPC call ("arm"), once, for that window only.

const DEFAULT_TTL_MS = 10_000;

function createArmGate({ now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  let armed = null; // { ownerId, expires }

  return {
    /** The window `ownerId` is about to ask for system audio. A new arm replaces the previous one. */
    arm(ownerId) {
      armed = { ownerId, expires: now() + ttlMs };
    },

    /**
     * Called by the display-media handler. True at most once per arm, only for the window that armed it and only
     * before it expires. A request from any other window does not use up (or reveal) the pending arm.
     */
    consume(ownerId) {
      if (!armed || armed.ownerId !== ownerId) return false;
      const valid = now() <= armed.expires;
      armed = null; // one-shot, also when it has expired
      return valid;
    },

    /** Forget a pending arm (the request failed before reaching the handler). */
    disarm() {
      armed = null;
    },

    get isArmed() {
      return armed !== null && now() <= armed.expires;
    },
  };
}

module.exports = { createArmGate, DEFAULT_TTL_MS };
