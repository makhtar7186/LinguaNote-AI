// Inserts finished transcript text into the application the user chose. Free of Electron imports: the clipboard and
// the desktop are injected, so every rule below is unit-tested without touching a real clipboard or window.
//
// Rules (docs/security.md, "Text insertion"):
//  * It is opt-in and visible: armed by an explicit user action, and its state is always reported.
//  * The target window is locked when arming. Text goes only to that window; if the user leaves it, insertion pauses
//    and the text waits (nothing is typed into another application).
//  * Our own windows are never a target.
//  * The clipboard is borrowed, not owned: its text/html/rtf content is saved and put back after the paste, unless it
//    holds something we cannot restore (an image, files...) — then nothing is overwritten and insertion waits.
//  * Insertions are strictly sequential, in the order the text was finalised.
//  * Text is never logged.

const DEFAULTS = { lockDelayMs: 3000, restoreDelayMs: 300, retryMs: 1000, maxPendingChars: 20_000 };

/**
 * `clipboard` is an async port: snapshot() -> null | {empty} | {parts}, restore(snapshot), writeText(text), readText()
 * (see electron-clipboard.cjs). `desktop`: foreground() -> {id, title, own} | null, paste(expectedId) -> {pasted}.
 */
function createTextInserter({ clipboard, desktop, onStatus = () => {}, timers = { setTimeout, clearTimeout }, options = {} }) {
  const settings = { ...DEFAULTS, ...options };
  let state = "off"; // off | locking | on | paused
  let target = null; // { id, title }
  let pending = []; // chunks of finalised text not inserted yet
  let pendingChars = 0;
  let inserted = 0; // characters inserted since arming
  let problem = null; // { code, message } while paused or after a refusal
  let lockTimer = null;
  let retryTimer = null;
  let working = Promise.resolve();
  let generation = 0; // changes on every arm/disarm, so late work of a previous arming is discarded
  let needsSeparator = false;
  let sessionOver = false; // the live session ended: stop as soon as what was accepted has been inserted
  let pumping = false;

  function status() {
    return {
      state,
      target: target ? { title: target.title } : null,
      pendingChars,
      inserted,
      problem,
    };
  }
  const publish = () => onStatus(status());

  function clearTimers() {
    if (lockTimer) timers.clearTimeout(lockTimer);
    if (retryTimer) timers.clearTimeout(retryTimer);
    lockTimer = retryTimer = null;
  }

  function fail(code, message) {
    problem = { code, message };
    publish();
  }

  /** The user asked to insert into "the application I click next": after a delay, that window becomes the target. */
  function arm() {
    if (state !== "off") return { ok: false, code: "already_armed", message: "L’insertion est déjà active." };
    clearTimers();
    generation += 1;
    const mine = generation;
    state = "locking";
    target = null;
    pending = [];
    pendingChars = 0;
    inserted = 0;
    problem = null;
    needsSeparator = false;
    sessionOver = false;
    publish();
    lockTimer = timers.setTimeout(() => void lockTarget(mine), settings.lockDelayMs);
    return { ok: true, lockDelayMs: settings.lockDelayMs };
  }

  async function lockTarget(mine) {
    lockTimer = null;
    let foreground = null;
    try {
      foreground = await desktop.foreground();
    } catch {
      foreground = null;
    }
    if (mine !== generation) return;
    if (!foreground) return stop("target_unknown", "Impossible d’identifier la fenêtre cible.");
    if (foreground.own) return stop("target_is_self", "Cliquez dans l’application cible pendant le décompte : LinguaNote ne peut pas être la cible.");
    target = { id: foreground.id, title: foreground.title || "Application sans titre" };
    state = "on";
    problem = null;
    publish();
    schedulePump(0);
  }

  /** Ends insertion. Text still waiting is dropped, and the caller is told how much. */
  function stop(code = null, message = "") {
    clearTimers();
    generation += 1;
    const dropped = pendingChars;
    state = "off";
    target = null;
    pending = [];
    pendingChars = 0;
    problem = code ? { code, message } : null;
    publish();
    return { ok: true, dropped };
  }

  /** Called with each finalised utterance. Returns whether the text was accepted for insertion. */
  function submit(text) {
    if (state !== "on" && state !== "paused") return { accepted: false };
    const clean = typeof text === "string" ? text.trim() : "";
    if (!clean) return { accepted: false };
    if (pendingChars + clean.length > settings.maxPendingChars) {
      fail("pending_overflow", "Trop de texte en attente d’insertion : l’insertion est arrêtée pour ne rien perdre en silence.");
      return { accepted: false, overflow: true };
    }
    pending.push(clean);
    pendingChars += clean.length;
    publish();
    schedulePump(0);
    return { accepted: true };
  }

  function schedulePump(delay) {
    if (retryTimer) timers.clearTimeout(retryTimer);
    const mine = generation;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      // Sequential by construction: each pump starts only after the previous one ended.
      working = working.then(() => pump(mine)).catch(() => {});
    }, delay);
  }

  async function pump(mine) {
    if (mine !== generation || (state !== "on" && state !== "paused") || pending.length === 0) return;
    pumping = true;
    try {
      await insertPending(mine);
    } catch {
      // Never swallowed: the user sees it, and the waiting text stays queued for the next attempt.
      if (mine === generation) {
        state = "paused";
        problem = { code: "insertion_failed", message: "L’insertion a échoué (presse-papiers ou fenêtre inaccessible). Nouvel essai en cours." };
        publish();
        schedulePump(settings.retryMs * 3);
      }
    } finally {
      pumping = false;
    }
  }

  async function insertPending(mine) {
    const foreground = await desktop.foreground().catch(() => null);
    if (mine !== generation) return;
    if (!foreground || foreground.id !== target.id) {
      state = "paused";
      problem = { code: "target_left", message: `Insertion en pause : revenez dans « ${target.title} » pour reprendre.` };
      publish();
      return schedulePump(settings.retryMs);
    }

    const snapshot = await clipboard.snapshot();
    if (snapshot === null) {
      state = "paused";
      problem = {
        code: "clipboard_not_restorable",
        message: "Le presse-papiers contient autre chose que du texte (image, fichiers…) : rien n’est écrasé, l’insertion attend.",
      };
      publish();
      return schedulePump(settings.retryMs);
    }

    const chunk = pending.join(" ");
    const payload = needsSeparator ? ` ${chunk}` : chunk;
    let outcome = { pasted: false };
    try {
      await clipboard.writeText(payload);
      outcome = await desktop.paste(target.id);
    } catch {
      outcome = { pasted: false };
    }
    // Put the user's clipboard back — unless they copied something else meanwhile. A failure here is reported, not hidden.
    await new Promise((resolve) => timers.setTimeout(resolve, outcome.pasted ? settings.restoreDelayMs : 0));
    let restoreProblem = null;
    try {
      if ((await clipboard.readText()) === payload) await clipboard.restore(snapshot);
    } catch {
      restoreProblem = { code: "clipboard_restore_failed", message: "Le presse-papiers n’a pas pu être remis dans son état d’origine." };
    }
    if (mine !== generation) return;

    if (!outcome.pasted) {
      state = "paused";
      problem = { code: "target_left", message: `Insertion en pause : revenez dans « ${target.title} » pour reprendre.` };
      publish();
      return schedulePump(settings.retryMs);
    }
    inserted += payload.length;
    needsSeparator = true;
    pending = [];
    pendingChars = 0;
    state = "on";
    problem = restoreProblem;
    publish();
    if (sessionOver) stop(); // the session ended while this chunk was being inserted: nothing else will come
  }

  /** Waits until everything accepted so far has been handled (used by tests and by the end of a session). */
  const idle = () => working;

  return {
    arm,
    stop,
    submit,
    status,
    idle,
    /** The live session is over: stop now if nothing waits, otherwise stay armed so the user can come back. */
    sessionEnded() {
      sessionOver = true;
      if (state === "locking" || (state !== "off" && pendingChars === 0 && !pumping)) stop();
    },
  };
}

module.exports = { createTextInserter, DEFAULTS };
