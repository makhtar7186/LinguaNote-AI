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

module.exports = { isTrustedSender, createOwnership };
