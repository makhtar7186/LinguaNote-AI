import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { parseLiveEvent } from "../services/liveEvents";
import { initialLiveState, liveReducer } from "../services/liveReducer";
import { type EndedSource, type MicCapture, startMicCapture } from "../services/micCapture";
import type { AudioSourceKind, LiveBridge, LiveClientState, SpokenLanguage } from "../types";

const IDLE_STATUSES = ["idle", "ended", "failed"];
/** Below this loudness (RMS, 0 to 1) a source counts as silent. */
const SILENCE_RMS = 0.002;
/** A source that stays silent this long is probably not delivering anything: say so. */
const SILENT_AFTER_MS = 8_000;

interface Envelope { ok?: unknown; code?: unknown; message?: unknown; state?: unknown; paused?: unknown; source?: unknown }

function asEnvelope(result: unknown): Envelope {
  return (typeof result === "object" && result !== null ? result : {}) as Envelope;
}

function failureOf(result: unknown): { code: string; message: string } | null {
  const envelope = asEnvelope(result);
  if (envelope.ok === true) return null;
  return {
    code: typeof envelope.code === "string" ? envelope.code : "unknown",
    message: typeof envelope.message === "string" ? envelope.message : "Le service en direct n’a pas pu démarrer.",
  };
}

const CLIENT_STATES: readonly string[] = ["idle", "connecting", "active", "reconnecting", "stopping", "ended", "failed"];

const SOURCE_LOST_MESSAGE: Record<EndedSource, string> = {
  system: "Le partage du son de l’ordinateur s’est arrêté : la session est terminée.",
  microphone: "Le microphone a été déconnecté : la session est terminée.",
};

export interface StartOptions {
  source?: AudioSourceKind;
  /** A specific microphone (empty = the system default). */
  deviceId?: string;
  /** One imposed language; undefined: several languages, detected passage by passage. */
  language?: SpokenLanguage;
}

interface Options {
  /** The bubble also obeys commands sent by global shortcuts (start/stop), because it owns the devices for them. */
  handleCommands?: boolean;
  /** What a session started without explicit options (a shortcut) listens to: this window's own current choice. */
  defaultStart?: StartOptions;
}

/**
 * Live dictation, seen from one window.
 *
 * The session lives in the main process and its events reach every window, so this hook always mirrors the
 * current state (a session started from the bubble shows in the main window and vice versa). The window that
 * starts a session also owns its audio source(s): it captures, releases the devices on pause, stop, failure and
 * unmount, and re-acquires them on resume.
 *
 * The source is chosen by the user and never changed by the hook: if a source disappears the session ends with an
 * explicit error instead of continuing with whatever is left.
 *
 * Opening a device is asynchronous (permission, hardware). Every acquisition is tagged with an "epoch"; anything
 * that releases the devices bumps the epoch, so a capture that finishes opening later is closed at once instead of
 * leaking.
 */
export function useLiveTranscription({ handleCommands = false, defaultStart }: Options = {}) {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState);
  const [level, setLevel] = useState(0); // 0 (silence) to 10
  const [silent, setSilent] = useState(false);
  const bridge: LiveBridge | undefined = window.linguaNote?.live;
  const supported = Boolean(bridge);
  const captureRef = useRef<MicCapture | null>(null);
  const epochRef = useRef(0);
  const acquiringRef = useRef<number | null>(null); // epoch of the acquisition in flight, if any
  const startingRef = useRef(false); // synchronous lock: two quick calls to start() must open one capture
  const ownerRef = useRef(false); // true in the window that started the running session
  const startOptionsRef = useRef<StartOptions>({});
  const lastSoundRef = useRef(0); // set when a source opens
  const statusRef = useRef(state.status);
  const defaultStartRef = useRef(defaultStart);
  useEffect(() => {
    statusRef.current = state.status; // read by callbacks that must not be re-created on every change
    defaultStartRef.current = defaultStart;
  }, [state.status, defaultStart]);

  /** Withdraws a declaration that did not become a session (stop, failure, abort), so nothing can still be armed. */
  const cancelDeclaration = useCallback(() => {
    void window.linguaNote?.capture?.disarm?.();
  }, []);

  const releaseMicrophone = useCallback(() => {
    epochRef.current += 1; // invalidates any acquisition still in flight
    acquiringRef.current = null; // ...so a fresh one may begin (resume after a pause) without waiting for it
    captureRef.current?.stop();
    captureRef.current = null;
  }, []);

  /** Opens the chosen source(s) unless released meanwhile. Resolves to whether they are now open. */
  const acquireMicrophone = useCallback(async (sink: (pcm: Uint8Array) => void): Promise<boolean> => {
    epochRef.current += 1;
    const epoch = epochRef.current;
    acquiringRef.current = epoch;
    try {
      const { source, deviceId } = startOptionsRef.current;
      lastSoundRef.current = Date.now();
      const capture = await startMicCapture(sink, {
        source,
        deviceId,
        onLevel: (rms) => {
          if (rms > SILENCE_RMS) lastSoundRef.current = Date.now();
          setLevel(Math.min(10, Math.round(Math.sqrt(rms) * 14)));
        },
        onSourceEnded: (kind) => {
          if (epoch !== epochRef.current) return; // an older capture, already replaced or stopped
          releaseMicrophone();
          dispatch({ type: "error", code: "source_lost", message: SOURCE_LOST_MESSAGE[kind], fatal: true });
          void bridge?.stop(); // end the session explicitly: no quiet continuation with another source
        },
      });
      if (epoch !== epochRef.current) {
        capture.stop(); // stopped, paused or closed while the device was opening
        return false;
      }
      captureRef.current = capture;
      return true;
    } finally {
      if (acquiringRef.current === epoch) acquiringRef.current = null;
    }
  }, [bridge, releaseMicrophone]);

  const syncFromMainProcess = useCallback(async () => {
    if (!bridge) return;
    const status = asEnvelope(await bridge.status());
    if (typeof status.state === "string" && CLIENT_STATES.includes(status.state) && status.state !== "idle") {
      dispatch({ type: "client_state", state: status.state as LiveClientState });
      if (status.paused === true) dispatch({ type: "pause_state", paused: true });
      if (status.source === "microphone" || status.source === "system" || status.source === "both") {
        dispatch({ type: "capture_source", source: status.source });
      }
    }
  }, [bridge]);

  // Mirror: events from the main process, whichever window started the session.
  useEffect(() => {
    if (!bridge) return undefined;
    const unsubscribe = bridge.onEvent((raw) => {
      const event = parseLiveEvent(raw);
      if (event) dispatch(event);
    });
    void syncFromMainProcess().catch(() => undefined);
    return unsubscribe;
  }, [bridge, syncFromMainProcess]);

  // The session is over: free the devices and give up ownership.
  useEffect(() => {
    if (state.status === "ended" || state.status === "failed") {
      releaseMicrophone();
      ownerRef.current = false;
    }
  }, [state.status, releaseMicrophone]);

  // Pause releases the devices (the indicator goes off); resume takes them back.
  useEffect(() => {
    if (!bridge || !ownerRef.current) return;
    if (state.paused) {
      releaseMicrophone(); // also cancels a re-acquisition that was still opening
    } else if (
      // Not while a capture is open or still opening: a status change (live -> reconnecting) re-runs this effect.
      !captureRef.current && acquiringRef.current === null && (state.status === "live" || state.status === "reconnecting")
    ) {
      acquireMicrophone((pcm) => bridge.sendAudio(pcm)).catch((cause: unknown) => {
        dispatch({
          type: "error", code: "microphone_lost", fatal: true,
          message: cause instanceof Error ? cause.message : "La source audio n’a pas pu être reprise.",
        });
        void bridge.stop();
      });
    }
  }, [bridge, state.paused, state.status, releaseMicrophone, acquireMicrophone]);

  // A source that delivers nothing for a while is almost always a mistake (wrong device, nothing playing): say so.
  const listening = state.status === "live" && !state.paused;
  useEffect(() => {
    if (!listening) return undefined;
    const timer = window.setInterval(() => {
      if (captureRef.current) setSilent(Date.now() - lastSoundRef.current > SILENT_AFTER_MS);
    }, 1_000);
    return () => {
      window.clearInterval(timer);
      setSilent(false);
      setLevel(0);
    };
  }, [listening]);

  const start = useCallback(async (options?: StartOptions) => {
    if (!bridge || startingRef.current || captureRef.current || !IDLE_STATUSES.includes(statusRef.current)) return;
    startingRef.current = true;
    // The choice is explicit: from the caller, else this window's own current choice (a shortcut), else the microphone.
    startOptionsRef.current = { source: "microphone", ...defaultStartRef.current, ...options };
    dispatch({ type: "reset" });
    ownerRef.current = true;
    const epochBefore = epochRef.current;
    try {
      // Step 1: declare the source. The main process shows the recording indicator before any device opens, and
      // refuses an unknown source instead of guessing one.
      const declared = failureOf(await bridge.prepare({ source: startOptionsRef.current.source }));
      if (declared) {
        ownerRef.current = false;
        if (declared.code === "already_running") {
          await syncFromMainProcess(); // another window runs the session: just mirror it
          return;
        }
        throw new Error(declared.message);
      }
      if (epochRef.current !== epochBefore) {
        ownerRef.current = false; // stopped while declaring: no device was opened, nothing to undo
        cancelDeclaration();
        return;
      }
      // Step 2: the sources. If a permission is refused, no session is opened for nothing. Frames captured while
      // the session is being opened are held back (the main process drops audio that arrives before it exists).
      const held: Uint8Array[] = [];
      let sessionOpen = false;
      const opened = await acquireMicrophone((pcm) => {
        if (sessionOpen) bridge.sendAudio(pcm);
        else held.push(pcm);
      });
      if (!opened) {
        ownerRef.current = false; // stopped before the devices finished opening: nothing to undo
        cancelDeclaration();
        return;
      }
      const { source, language } = startOptionsRef.current;
      const failure = failureOf(await bridge.start({ source, ...(language ? { language } : {}) }));
      if (failure) {
        releaseMicrophone();
        ownerRef.current = false;
        if (failure.code === "already_running") {
          await syncFromMainProcess(); // another window runs the session: just mirror it
          return;
        }
        throw new Error(failure.message);
      }
      if (!captureRef.current) {
        await bridge.stop(); // stopped while the session was opening: end it, no source is left to feed it
        return;
      }
      sessionOpen = true;
      held.forEach((pcm) => bridge.sendAudio(pcm));
    } catch (cause) {
      releaseMicrophone();
      ownerRef.current = false;
      cancelDeclaration();
      dispatch({
        type: "error", code: "start_failed", fatal: true,
        message: cause instanceof Error ? cause.message : "Impossible de démarrer la transcription en direct.",
      });
    } finally {
      startingRef.current = false;
    }
  }, [bridge, acquireMicrophone, releaseMicrophone, syncFromMainProcess, cancelDeclaration]);

  const stop = useCallback(async () => {
    if (!bridge) return;
    cancelDeclaration();
    releaseMicrophone(); // delivers the last partial frame before the stop request
    dispatch({ type: "client_state", state: "stopping" });
    await bridge.stop();
  }, [bridge, releaseMicrophone, cancelDeclaration]);

  const pause = useCallback(async () => { await bridge?.pause(); }, [bridge]);
  const resume = useCallback(async () => { await bridge?.resume(); }, [bridge]);

  // Global shortcut "start / stop dictation" (the bubble is the window that owns the devices for it).
  useEffect(() => {
    const commands = window.linguaNote?.bubble;
    if (!handleCommands || !commands) return undefined;
    return commands.onCommand((raw) => {
      const action = typeof raw === "object" && raw !== null ? (raw as { action?: unknown }).action : undefined;
      if (action !== "toggle_live") return;
      if (IDLE_STATUSES.includes(statusRef.current)) void start();
      else void stop();
    });
  }, [handleCommands, start, stop]);

  // Closing the window must not leave a running session without its audio source.
  useEffect(() => () => {
    releaseMicrophone();
    if (ownerRef.current) void bridge?.stop();
  }, [bridge, releaseMicrophone]);

  return { state, supported, level, silent, start, stop, pause, resume };
}
