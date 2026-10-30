// Who may call the main process. Free of Electron imports: events are plain objects in the tests.

/**
 * A call is trusted only if it comes from the MAIN frame of one of our windows, and that frame shows exactly one
 * of our pages. An iframe, even one that loads an allowed URL, is never trusted.
 * @param {{sender: object, senderFrame: object|null}} event
 * @param {object[]} windows  the webContents of our windows
 * @param {{isAppUrl: (url: string) => boolean}} urlPolicy
 */
function isTrustedSender(event, windows, urlPolicy) {
  const { sender, senderFrame } = event ?? {};
  if (!sender || !senderFrame || !windows.includes(sender)) return false;
  const main = sender.mainFrame;
  if (!main) return false;
  // Compare identity fields rather than object identity: wrappers may be re-created.
  const sameFrame = senderFrame === main
    || (senderFrame.processId === main.processId && senderFrame.routingId === main.routingId);
  return sameFrame && urlPolicy.isAppUrl(senderFrame.url ?? "");
}

/**
 * The window that started a live session owns the microphone for it: only it may feed audio. Any trusted window
 * may stop or pause the session (the bubble stops what the main window started, and the other way round).
 */
function createOwnership() {
  let owner = null;
  return {
    claim(id) { owner = id; },
    release() { owner = null; },
    isOwner(id) { return owner !== null && owner === id; },
    get current() { return owner; },
  };
}

/**
 * Claims the session for `owner` (a webContents) and ends it if that window disappears (closed, crashed, killed).
 * Nothing would feed the session any more, so it is stopped rather than left open without a microphone.
 * Returns `dispose()`, which removes the listeners: call it when the session ends, so they never pile up.
 * @param {{claim: Function, release: Function, isOwner: Function}} ownership
 * @param {{id: number, once: Function, removeListener: Function}} owner
 * @param {() => void} onOwnerGone
 */
function watchOwner(ownership, owner, onOwnerGone) {
  if (typeof owner.isDestroyed === "function" && owner.isDestroyed()) {
    throw new Error("La fenêtre qui démarre la session n'existe plus.");
  }
  ownership.claim(owner.id);
  const gone = () => {
    // Only if this window still owns the session: a newer session of another window must not be stopped by it.
    if (!ownership.isOwner(owner.id)) return;
    ownership.release();
    onOwnerGone();
  };
  try {
    owner.once("destroyed", gone);
    owner.once("render-process-gone", gone);
  } catch (error) {
    owner.removeListener?.("destroyed", gone);
    ownership.release(); // never leave a claim behind when the window cannot be watched
    throw error;
  }
  return function dispose() {
    try {
      owner.removeListener("destroyed", gone);
      owner.removeListener("render-process-gone", gone);
    } catch {
      // A destroyed webContents may refuse; its listeners are gone with it.
    }
  };
}

/**
 * Starts a session for `owner` in the order that cannot leave anything behind: claim and watch the window FIRST,
 * then start. A start that throws, or that fails or ends synchronously (the live client reports `failed` from
 * inside start()), therefore always finds the claim and the watcher it must release.
 * @param {object} args
 * @param {object} args.ownership
 * @param {object} args.owner   the webContents that asked
 * @param {() => void} args.start  starts the session (may throw)
 * @param {() => void} args.onOwnerGone  stops the session when the owner disappears
 * @param {(dispose: () => void) => void} args.onWatch  receives the watcher's dispose BEFORE start() runs
 * @returns {{ok: true} | {ok: false, error: Error}}
 */
function beginSession({ ownership, owner, start, onOwnerGone, onWatch }) {
  let dispose = () => {};
  try {
    dispose = watchOwner(ownership, owner, onOwnerGone);
    onWatch(dispose);
    start();
    return { ok: true };
  } catch (error) {
    dispose();
    ownership.release();
    return { ok: false, error };
  }
}

module.exports = { isTrustedSender, createOwnership, watchOwner, beginSession };
