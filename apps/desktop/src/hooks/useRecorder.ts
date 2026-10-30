import { useCallback, useEffect, useRef, useState } from "react";

export const MAX_RECORDING_SECONDS = 300;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

interface Options {
  onRecorded: (file: File) => void;
  onError: (message: string) => void;
  maxSeconds?: number;
}

/** Microphone recording, isolated from the UI. Always releases the stream on stop, error or unmount. */
export function useRecorder({ onRecorded, onError, maxSeconds = MAX_RECORDING_SECONDS }: Options) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const callbacks = useRef({ onRecorded, onError });
  callbacks.current = { onRecorded, onError };

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      recorder.onstop = null;
      recorder.stop();
    }
    releaseStream();
  }, [releaseStream]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setElapsed(seconds);
      if (seconds >= maxSeconds) stop();
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording, maxSeconds, stop]);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      callbacks.current.onError("L’enregistrement micro n’est pas disponible dans cet environnement.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        releaseStream();
        setRecording(false);
        setElapsed(0);
        callbacks.current.onError("L’enregistrement a été interrompu par une erreur du micro.");
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const extension = blob.type.includes("mp4") ? "mp4" : "webm";
        releaseStream();
        setRecording(false);
        setElapsed(0);
        if (blob.size === 0) {
          callbacks.current.onError("Aucun son n’a été enregistré.");
          return;
        }
        callbacks.current.onRecorded(new File([blob], `linguanote-${Date.now()}.${extension}`, { type: blob.type }));
      };
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      recorder.start(250);
    } catch (cause) {
      releaseStream();
      callbacks.current.onError(cause instanceof Error ? cause.message : "Impossible d’accéder au microphone.");
    }
  }, [releaseStream]);

  return { recording, elapsed, start, stop };
}
