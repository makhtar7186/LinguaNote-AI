import type { AudioSourceKind } from "../types";
import { usesMicrophone, usesSystemAudio } from "./audioSource";
import { floatToInt16, FrameBuffer, Resampler } from "./pcm";

export interface MicCapture {
  /** Stops capturing and delivers the last partial frame. Always releases every device. Safe to call twice. */
  stop: () => void;
}

export type EndedSource = "microphone" | "system";

export interface CaptureOptions {
  /** What to listen to. Default: the microphone. */
  source?: AudioSourceKind;
  /** A specific microphone (empty = the system default). */
  deviceId?: string;
  /** Loudness of what is captured, 0 to 1, about every 90 ms (so the user can see the source is alive). */
  onLevel?: (rms: number) => void;
  /** A source stopped by itself (device unplugged, sharing ended): reported, never replaced by another source. */
  onSourceEnded?: (source: EndedSource) => void;
}

interface Opened {
  kind: EndedSource;
  stream: MediaStream;
}

function stopAll(opened: readonly Opened[]) {
  for (const { stream } of opened) stream.getTracks().forEach((track) => track.stop());
}

async function openMicrophone(deviceId: string | undefined): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  });
}

/**
 * System audio ("loopback": what the computer plays). Windows only. The main process denies the request unless this
 * window armed it just before; it must hand over a screen source too, so the video track is dropped at once and no
 * frame is ever read.
 */
async function openSystemAudio(): Promise<MediaStream> {
  const capture = window.linguaNote?.capture;
  if (!capture || !navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("La capture du son de l’ordinateur n’est pas disponible dans cet environnement.");
  }
  await capture.armSystemAudio();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (cause) {
    void capture.disarm();
    const reason = cause instanceof Error ? cause.name : "";
    throw new Error(
      reason === "NotAllowedError" || reason === "AbortError"
        ? "Le son de l’ordinateur n’a pas pu être capturé (accès refusé ou non pris en charge sur ce système)."
        : "Le son de l’ordinateur n’a pas pu être capturé.",
    );
  }
  for (const video of stream.getVideoTracks()) {
    video.stop();
    stream.removeTrack(video);
  }
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("Aucun son d’ordinateur n’est disponible : cette fonction demande Windows.");
  }
  return stream;
}

/**
 * Opens the requested sources. If any one of them cannot be opened, everything already opened is closed and the
 * error is raised: "microphone + computer" never quietly becomes "microphone only".
 */
async function openSources(source: AudioSourceKind, deviceId: string | undefined): Promise<Opened[]> {
  if (usesMicrophone(source) && !navigator.mediaDevices?.getUserMedia) {
    throw new Error("L’accès au microphone n’est pas disponible dans cet environnement.");
  }
  const opened: Opened[] = [];
  try {
    if (usesMicrophone(source)) opened.push({ kind: "microphone", stream: await openMicrophone(deviceId) });
    if (usesSystemAudio(source)) opened.push({ kind: "system", stream: await openSystemAudio() });
  } catch (error) {
    stopAll(opened);
    throw error;
  }
  return opened;
}

/**
 * Captures the chosen source(s) and delivers 100 ms frames of 16 kHz mono PCM s16le.
 *
 * Several sources are summed in a mixer (with headroom so two loud voices do not clip). Uses a ScriptProcessorNode
 * (deprecated but supported by Chromium/Electron) because an AudioWorklet module must be loaded from a URL that the
 * packaged `file://` page and its strict CSP would have to allow, which has not been verifiable here. Known debt:
 * migrate to an AudioWorklet once the packaged app can be exercised.
 */
export async function startMicCapture(
  onFrame: (pcm: Uint8Array) => void,
  options: CaptureOptions = {},
): Promise<MicCapture> {
  const { source = "microphone", deviceId, onLevel, onSourceEnded } = options;
  const opened = await openSources(source, deviceId);
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    if (context.state === "suspended") await context.resume();
    const mixer = context.createGain();
    mixer.gain.value = opened.length > 1 ? 0.7 : 1;
    for (const { stream } of opened) context.createMediaStreamSource(stream).connect(mixer);

    const processor = context.createScriptProcessor(4096, 1, 1);
    const silent = context.createGain(); // a processor only runs when connected to the destination
    silent.gain.value = 0;
    const resampler = new Resampler(context.sampleRate);
    const frames = new FrameBuffer(onFrame);

    processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0);
      if (onLevel) {
        let sum = 0;
        for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
        onLevel(Math.sqrt(sum / Math.max(1, samples.length)));
      }
      frames.push(floatToInt16(resampler.process(samples)));
    };
    mixer.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);

    // A source that ends by itself (device unplugged, "stop sharing") is reported, not silently replaced.
    let stopped = false;
    for (const { kind, stream } of opened) {
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => {
          if (!stopped) onSourceEnded?.(kind);
        });
      }
    }

    const openContext = context;
    return {
      stop: () => {
        if (stopped) return; // safe to call from several paths (stop button, error, unmount)
        stopped = true;
        processor.onaudioprocess = null;
        // One failing step must not leave a device open: each release is attempted regardless.
        for (const release of [
          () => mixer.disconnect(),
          () => processor.disconnect(),
          () => silent.disconnect(),
          () => stopAll(opened),
          () => void openContext.close(),
          () => frames.flush(),
        ]) {
          try {
            release();
          } catch {
            // Already disconnected or closed.
          }
        }
      },
    };
  } catch (error) {
    // Never leave a microphone, a loopback or the audio context open on a partial failure.
    stopAll(opened);
    void context?.close();
    throw error;
  }
}
