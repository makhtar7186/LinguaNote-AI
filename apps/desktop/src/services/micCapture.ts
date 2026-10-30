import { floatToInt16, FrameBuffer, Resampler } from "./pcm";

export interface MicCapture {
  /** Stops the microphone and delivers the last partial frame. Always releases the device. */
  stop: () => void;
}

/**
 * Opens the microphone and delivers 100 ms frames of 16 kHz mono PCM s16le.
 *
 * Uses a ScriptProcessorNode (deprecated but supported by Chromium/Electron) because an AudioWorklet module must
 * be loaded from a URL that the packaged `file://` page and its strict CSP would have to allow, which has not
 * been verifiable here. Known debt: migrate to an AudioWorklet once the packaged app can be exercised.
 */
export async function startMicCapture(onFrame: (pcm: Uint8Array) => void): Promise<MicCapture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("L’accès au microphone n’est pas disponible dans cet environnement.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    if (context.state === "suspended") await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silent = context.createGain(); // a processor only runs when connected to the destination
    silent.gain.value = 0;
    const resampler = new Resampler(context.sampleRate);
    const frames = new FrameBuffer(onFrame);

    processor.onaudioprocess = (event) => {
      frames.push(floatToInt16(resampler.process(event.inputBuffer.getChannelData(0))));
    };
    source.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);

    const openContext = context;
    return {
      stop: () => {
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
        silent.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        void openContext.close();
        frames.flush();
      },
    };
  } catch (error) {
    // Never leave the microphone or the audio context open on a partial failure.
    stream.getTracks().forEach((track) => track.stop());
    void context?.close();
    throw error;
  }
}
