import { useCallback, useEffect, useReducer, useRef } from "react";
import { parseLiveEvent } from "../services/liveEvents";
import { initialLiveState, liveReducer } from "../services/liveReducer";
import { type MicCapture, startMicCapture } from "../services/micCapture";
import type { LiveBridge, LiveClientState } from "../types";

const IDLE_STATUSES = ["idle", "ended", "failed"];

interface Envelope { ok?: unknown; code?: unknown; message?: unknown; state?: unknown; paused?: unknown }

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

interface Options {
  /** The bubble also obeys commands sent by global shortcuts (start/stop), because it owns the microphone for them. */
  handleCommands?: boolean;
}

/**
 * Live dictation, seen from one window.
 *
 * The session lives in the main process and its events reach every window, so this hook always mirrors the
 * current state (a session started from the bubble shows in the main window and vice versa). The window that
 * starts a session also owns the microphone: it captures, releases the device on pause, stop, failure and
 * unmount, and re-acquires it on resume.
 *
 * Opening the microphone is asynchronous (permission, device). Every acquisition is tagged with an "epoch";
 * anything that releases the microphone bumps the epoch, so a capture that finishes opening later is closed
 * at once instead of leaking.
 */
export function useLiveTranscription({ handleCommands = false }: Options = {}) {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState);
  const bridge: LiveBridge | undefined = window.linguaNote?.live;
  const supported = Boolean(bridge);
  const captureRef = useRef<MicCapture | null>(null);
  const epochRef = useRef(0);
  const startingRef = useRef(false); // synchronous lock: two quick calls to start() must open one microphone
  const ownerRef = useRef(false); // true in the window that started the running session
  const statusRef = useRef(state.status);
  useEffect(() => {
    statusRef.current = state.status; // read by callbacks that must not be re-created on every status change
  }, [state.status]);

  const releaseMicrophone = useCallback(() => {
    epochRef.current += 1; // invalidates any acquisition still in flight
    captureRef.current?.stop();
    captureRef.current = null;
  }, []);

  /** Opens the microphone unless it was released meanwhile. Resolves to whether it is now open. */
  const acquireMicrophone = useCallback(async (sink: (pcm: Uint8Array) => void): Promise<boolean> => {
    epochRef.current += 1;
    const epoch = epochRef.current;
    const capture = await startMicCapture(sink);
    if (epoch !== epochRef.current) {
      capture.stop(); // stopped, paused or closed while the device was opening
      return false;
    }
    captureRef.current = capture;
    return true;
  }, []);

  const syncFromMainProcess = useCallback(async () => {
    if (!bridge) return;
    const status = asEnvelope(await bridge.status());
    if (typeof status.state === "string" && CLIENT_STATES.includes(status.state) && status.state !== "idle") {
      dispatch({ type: "client_state", state: status.state as LiveClientState });
      if (status.paused === true) dispatch({ type: "pause_state", paused: true });
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

  // The session is over: free the microphone and give up ownership.
  useEffect(() => {
    if (state.status === "ended" || state.status === "failed") {
      releaseMicrophone();
      ownerRef.current = false;
    }
  }, [state.status, releaseMicrophone]);

  // Pause releases the microphone (the indicator goes off); resume takes it back.
  useEffect(() => {
    if (!bridge || !ownerRef.current) return;
    if (state.paused) {
      releaseMicrophone(); // also cancels a re-acquisition that was still opening
    } else if (!captureRef.current && (state.status === "live" || state.status === "reconnecting")) {
      acquireMicrophone((pcm) => bridge.sendAudio(pcm)).catch((cause: unknown) => {
        dispatch({
          type: "error", code: "microphone_lost", fatal: true,
          message: cause instanceof Error ? cause.message : "Le microphone n’a pas pu être repris.",
        });
        void bridge.stop();
      });
    }
  }, [bridge, state.paused, state.status, releaseMicrophone, acquireMicrophone]);

  const start = useCallback(async () => {
    if (!bridge || startingRef.current || captureRef.current || !IDLE_STATUSES.includes(statusRef.current)) return;
    startingRef.current = true;
    dispatch({ type: "reset" });
    ownerRef.current = true;
    try {
      // Microphone first: if permission is refused, no session is opened for nothing. Frames captured while the
      // session is being opened are held back (the main process drops audio that arrives before it exists).
      const held: Uint8Array[] = [];
      let sessionOpen = false;
      const opened = await acquireMicrophone((pcm) => {
        if (sessionOpen) bridge.sendAudio(pcm);
        else held.push(pcm);
      });
      if (!opened) {
        ownerRef.current = false; // stopped before the microphone finished opening: nothing to undo
        return;
      }
      const failure = failureOf(await bridge.start());
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
        await bridge.stop(); // stopped while the session was opening: end it, no microphone is left to feed it
        return;
      }
      sessionOpen = true;
      held.forEach((pcm) => bridge.sendAudio(pcm));
    } catch (cause) {
      releaseMicrophone();
      ownerRef.current = false;
      dispatch({
        type: "error", code: "start_failed", fatal: true,
        message: cause instanceof Error ? cause.message : "Impossible de démarrer la transcription en direct.",
      });
    } finally {
      startingRef.current = false;
    }
  }, [bridge, acquireMicrophone, releaseMicrophone, syncFromMainProcess]);

  const stop = useCallback(async () => {
    if (!bridge) return;
    releaseMicrophone(); // delivers the last partial frame before the stop request
    dispatch({ type: "client_state", state: "stopping" });
    await bridge.stop();
  }, [bridge, releaseMicrophone]);

  const pause = useCallback(async () => { await bridge?.pause(); }, [bridge]);
  const resume = useCallback(async () => { await bridge?.resume(); }, [bridge]);

  // Global shortcut "start / stop dictation" (the bubble is the window that owns the microphone for it).
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

  // Closing the window must not leave a running session without a microphone.
  useEffect(() => () => {
    releaseMicrophone();
    if (ownerRef.current) void bridge?.stop();
  }, [bridge, releaseMicrophone]);

  return { state, supported, start, stop, pause, resume };
}
