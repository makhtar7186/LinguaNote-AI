// What the user declared they want to capture. Free of Electron imports.
//
// The renderer cannot be allowed to grab the computer's sound on its own initiative. A window must first DECLARE the
// source it is about to use ("prepare"): the main process then makes the recording indicator (the bubble) visible
// BEFORE any device is opened, and only a declared plan, or an already running session on that source owned by that
// window, allows the system audio gate to be armed (capture-gate.cjs).

const SOURCES = ["microphone", "system", "both"];
const DEFAULT_TTL_MS = 30_000;

const usesSystemAudio = (source) => source === "system" || source === "both";

function createCapturePlan({ now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  let pending = null; // { ownerId, source, expires }

  return {
    SOURCES,

    /** The window `ownerId` declares the source it is about to open. Unknown sources are refused, never defaulted. */
    declare(ownerId, source) {
      if (!SOURCES.includes(source)) return false;
      pending = { ownerId, source, expires: now() + ttlMs };
      return true;
    },

    /**
     * May this window arm the system audio gate? Yes if it declared a plan that uses system audio and the plan has
     * not expired, or if it owns the running session and that session listens to system audio (resume after a pause).
     */
    allowsSystemAudio(ownerId, session = {}) {
      const planned = pending !== null && pending.ownerId === ownerId && now() <= pending.expires && usesSystemAudio(pending.source);
      const running = session.ownerId !== null && session.ownerId !== undefined
        && session.ownerId === ownerId && usesSystemAudio(session.source);
      return planned || running;
    },

    /** The plan is spent once the session exists (the session itself is now the authority). */
    clear() {
      pending = null;
    },

    get current() {
      return pending;
    },
  };
}

module.exports = { createCapturePlan, SOURCES, DEFAULT_TTL_MS, usesSystemAudio };
