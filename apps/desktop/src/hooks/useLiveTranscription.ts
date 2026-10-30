import { useCallback, useEffect, useReducer, useRef } from "react";
import { parseLiveEvent } from "../services/liveEvents";
import { initialLiveState, liveReducer } from "../services/liveReducer";
import { type MicCapture, startMicCapture } from "../services/micCapture";
import type { LiveBridge } from "../types";

interface Envelope { ok?: unknown; message?: unknown }

function failureMessage(result: unknown): string | null {
  const envelope = (typeof result === "object" && result !== null ? result : {}) as Envelope;
  if (envelope.ok === true) return null;
  return typeof envelope.message === "string" ? envelope.message : "Le service en direct n’a pas pu démarrer.";
}

/**
 * Live dictation: microphone -> main process (which owns the WebSocket and the secret) -> events back.
 * The microphone is released on stop, on failure, and on unmount.
 */
export function useLiveTranscription() {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState);
  const captureRef = useRef<MicCapture | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const bridge: LiveBridge | undefined = window.linguaNote?.live;
  const supported = Boolean(bridge);

  const releaseMicrophone = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
  }, []);

  const unsubscribe = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  // The session is over (ended or failed): nothing more will arrive, stop listening and free the device.
  useEffect(() => {
    if (state.status === "ended" || state.status === "failed") {
      releaseMicrophone();
      unsubscribe();
    }
  }, [state.status, releaseMicrophone, unsubscribe]);

  useEffect(() => () => {
    releaseMicrophone();
    unsubscribe();
  }, [releaseMicrophone, unsubscribe]);

  const start = useCallback(async () => {
    if (!bridge || captureRef.current) return;
    dispatch({ type: "reset" });
    unsubscribe();
    unsubscribeRef.current = bridge.onEvent((raw) => {
      const event = parseLiveEvent(raw);
      if (event) dispatch(event);
    });
    try {
      // Microphone first: if permission is refused, no session is opened for nothing. Frames captured while the
      // session is being opened are held back (the main process drops audio that arrives before it exists).
      const held: Uint8Array[] = [];
      let sessionOpen = false;
      captureRef.current = await startMicCapture((pcm) => {
        if (sessionOpen) bridge.sendAudio(pcm);
        else held.push(pcm);
      });
      const failure = failureMessage(await bridge.start());
      if (failure) throw new Error(failure);
      sessionOpen = true;
      held.forEach((pcm) => bridge.sendAudio(pcm));
    } catch (cause) {
      releaseMicrophone();
      unsubscribe();
      dispatch({
        type: "error", code: "start_failed", fatal: true,
        message: cause instanceof Error ? cause.message : "Impossible de démarrer la transcription en direct.",
      });
    }
  }, [bridge, releaseMicrophone, unsubscribe]);

  const stop = useCallback(async () => {
    if (!bridge) return;
    releaseMicrophone(); // delivers the last partial frame before the stop request
    dispatch({ type: "client_state", state: "stopping" });
    await bridge.stop();
  }, [bridge, releaseMicrophone]);

  return { state, supported, start, stop };
}
