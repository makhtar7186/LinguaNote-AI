import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMicCapture } from "../src/services/micCapture";

function fakeTrack(label: string) {
  const listeners = new Map<string, () => void>();
  return {
    label,
    stop: vi.fn(),
    addEventListener: (event: string, callback: () => void) => { listeners.set(event, callback); },
    end: () => listeners.get("ended")?.(), // the device or the sharing ended by itself
  };
}

function fakeStream(audio: string[], video: string[] = []) {
  const audioTracks = audio.map(fakeTrack);
  const videoTracks = video.map(fakeTrack);
  return {
    audioTracks,
    videoTracks,
    getTracks: () => [...audioTracks, ...videoTracks],
    getAudioTracks: () => audioTracks,
    getVideoTracks: () => videoTracks,
    removeTrack: vi.fn((track: unknown) => { videoTracks.splice(videoTracks.indexOf(track as never), 1); }),
  };
}

type FakeStream = ReturnType<typeof fakeStream>;

interface Setup {
  failAt?: "processor" | "context";
  mic?: FakeStream | Error;
  system?: FakeStream | Error;
  withBridge?: boolean;
}

function install({ failAt, mic = fakeStream(["Microphone"]), system = fakeStream(["System audio"], ["Écran"]), withBridge = true }: Setup = {}) {
  const calls: string[] = [];
  const getUserMedia = vi.fn(async (constraints: unknown) => {
    calls.push("getUserMedia");
    if (mic instanceof Error) throw mic;
    void constraints;
    return mic;
  });
  const getDisplayMedia = vi.fn(async (constraints: unknown) => {
    calls.push("getDisplayMedia");
    void constraints;
    if (system instanceof Error) throw system;
    return system;
  });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia, getDisplayMedia } });

  const capture = {
    armSystemAudio: vi.fn(async () => { calls.push("arm"); return { ok: true }; }),
    disarm: vi.fn(async () => ({ ok: true })),
  };
  window.linguaNote = (withBridge ? { capture } : {}) as unknown as Window["linguaNote"];

  const sources: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; stream: unknown }[] = [];
  const gains: { gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null as null | ((event: unknown) => void) };
  const close = vi.fn().mockResolvedValue(undefined);
  class FakeContext {
    state = "running";
    sampleRate = 48_000;
    destination = {};
    close = close;
    resume = vi.fn();
    constructor() { if (failAt === "context") throw new Error("no audio device"); }
    createMediaStreamSource(stream: unknown) {
      const node = { connect: vi.fn(), disconnect: vi.fn(), stream };
      sources.push(node);
      return node;
    }
    createGain() {
      const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      gains.push(node);
      return node;
    }
    createScriptProcessor() {
      if (failAt === "processor") throw new Error("no processor");
      return processor;
    }
  }
  vi.stubGlobal("AudioContext", FakeContext);
  return { calls, getUserMedia, getDisplayMedia, capture, sources, gains, processor, close, mic, system };
}

const speak = (processor: { onaudioprocess: null | ((event: unknown) => void) }, level = 0.25, samples = 4_800) => {
  const data = new Float32Array(samples).fill(level);
  processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } });
};
const allStopped = (stream: FakeStream) => stream.getTracks().every((track) => track.stop.mock.calls.length >= 1);

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.unstubAllGlobals();
  delete window.linguaNote;
});

describe("microphone (default)", () => {
  it("streams 100 ms frames of 16 kHz PCM and releases everything on stop", async () => {
    const env = install();
    const frames: Uint8Array[] = [];
    const capture = await startMicCapture((pcm) => frames.push(pcm));
    speak(env.processor);
    expect(frames).toHaveLength(1);
    expect(frames[0].byteLength).toBe(3_200); // 1600 samples of 16 bits

    capture.stop();
    expect(allStopped(env.mic as FakeStream)).toBe(true);
    expect(env.close).toHaveBeenCalledOnce();
    expect(env.processor.onaudioprocess).toBeNull();
    expect(env.calls).toEqual(["getUserMedia"]); // never touches system audio unless asked
  });

  it("asks for the chosen microphone exactly, or the default one when none is chosen", async () => {
    const env = install();
    await startMicCapture(() => undefined, { deviceId: "usb-mic-42" });
    expect(env.getUserMedia.mock.calls[0][0]).toMatchObject({ audio: { deviceId: { exact: "usb-mic-42" } } });
    await startMicCapture(() => undefined);
    expect(env.getUserMedia.mock.calls[1][0]).toEqual({ audio: expect.not.objectContaining({ deviceId: expect.anything() }) });
  });

  it("reports the loudness of what is captured, so a dead source is visible", async () => {
    const env = install();
    const levels: number[] = [];
    await startMicCapture(() => undefined, { onLevel: (level) => levels.push(level) });
    speak(env.processor, 0.5);
    speak(env.processor, 0);
    expect(levels[0]).toBeCloseTo(0.5, 5);
    expect(levels[1]).toBe(0);
  });

  it("releases the microphone even if a node throws while disconnecting, and stop is idempotent", async () => {
    const env = install();
    const capture = await startMicCapture(() => undefined);
    env.gains[0].disconnect.mockImplementation(() => { throw new Error("already disconnected"); });
    expect(() => capture.stop()).not.toThrow();
    capture.stop();
    expect((env.mic as FakeStream).audioTracks[0].stop).toHaveBeenCalledOnce();
    expect(env.close).toHaveBeenCalledOnce();
  });

  it("closes both the microphone and the audio context when setting up the graph fails", async () => {
    const env = install({ failAt: "processor" });
    await expect(startMicCapture(() => undefined)).rejects.toThrow("no processor");
    expect(allStopped(env.mic as FakeStream)).toBe(true);
    expect(env.close).toHaveBeenCalledOnce();
  });

  it("cleans up when the audio context itself cannot be created", async () => {
    const env = install({ failAt: "context" });
    await expect(startMicCapture(() => undefined)).rejects.toThrow("no audio device");
    expect(allStopped(env.mic as FakeStream)).toBe(true);
  });

  it("reports an environment without microphone access", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    await expect(startMicCapture(() => undefined)).rejects.toThrow(/microphone/);
  });
});

describe("computer sound (system audio)", () => {
  it("arms the request first, drops the screen video at once, and listens to the audio track only", async () => {
    const env = install();
    const frames: Uint8Array[] = [];
    const capture = await startMicCapture((pcm) => frames.push(pcm), { source: "system" });

    expect(env.calls).toEqual(["arm", "getDisplayMedia"]); // armed BEFORE asking, and no microphone involved
    expect(env.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    const system = env.system as FakeStream;
    expect(system.removeTrack).toHaveBeenCalledOnce();
    expect(system.videoTracks).toHaveLength(0); // the video track is gone...
    expect(env.sources).toHaveLength(1);
    expect(env.sources[0].stream).toBe(system); // ...and only audio reaches the graph

    speak(env.processor);
    expect(frames).toHaveLength(1);
    capture.stop();
    expect(system.audioTracks[0].stop).toHaveBeenCalledOnce();
    expect(env.close).toHaveBeenCalledOnce();
  });

  it("stops the screen video track immediately, before any audio is processed", async () => {
    const stream = fakeStream(["System audio"], ["Écran"]);
    const video = stream.videoTracks[0];
    const env = install({ system: stream });
    await startMicCapture(() => undefined, { source: "system" });
    expect(video.stop).toHaveBeenCalledOnce();
    expect(env.processor.onaudioprocess).not.toBeNull();
  });

  it.each(["NotAllowedError", "AbortError"])("explains a refusal (%s) and disarms", async (name) => {
    const env = install({ system: Object.assign(new Error("x"), { name }) });
    await expect(startMicCapture(() => undefined, { source: "system" })).rejects.toThrow(/n’a pas pu être capturé/);
    expect(env.capture.disarm).toHaveBeenCalledOnce();
    expect(env.sources).toHaveLength(0);
  });

  it("fails clearly when the system provides no audio track, and stops what it was given", async () => {
    const stream = fakeStream([], ["Écran"]);
    const env = install({ system: stream });
    await expect(startMicCapture(() => undefined, { source: "system" })).rejects.toThrow(/Aucun son d’ordinateur/);
    expect(allStopped(stream)).toBe(true);
    expect(env.sources).toHaveLength(0);
  });

  it("is unavailable without the preload capture API (e.g. the browser preview)", async () => {
    install({ withBridge: false });
    await expect(startMicCapture(() => undefined, { source: "system" })).rejects.toThrow(/pas disponible/);
  });
});

describe("microphone + computer sound", () => {
  it("mixes both sources with headroom and releases both on stop", async () => {
    const env = install();
    const capture = await startMicCapture(() => undefined, { source: "both" });
    expect(env.calls).toEqual(["getUserMedia", "arm", "getDisplayMedia"]);
    expect(env.sources).toHaveLength(2);
    expect(env.gains[0].gain.value).toBeLessThan(1); // two voices summed must not clip
    for (const node of env.sources) expect(node.connect).toHaveBeenCalledWith(env.gains[0]); // both into the mixer

    capture.stop();
    expect(allStopped(env.mic as FakeStream)).toBe(true);
    expect(allStopped(env.system as FakeStream)).toBe(true);
  });

  it("never falls back to the microphone alone when the computer sound cannot be captured", async () => {
    const env = install({ system: Object.assign(new Error("denied"), { name: "NotAllowedError" }) });
    await expect(startMicCapture(() => undefined, { source: "both" })).rejects.toThrow(/n’a pas pu être capturé/);
    expect(allStopped(env.mic as FakeStream)).toBe(true); // the microphone it had opened is released, not kept
    expect(env.sources).toHaveLength(0); // and nothing is being recorded
    expect(env.close).not.toHaveBeenCalled();
  });

  it("does not even ask for the computer sound when the microphone is refused", async () => {
    const env = install({ mic: Object.assign(new Error("no mic"), { name: "NotAllowedError" }) });
    await expect(startMicCapture(() => undefined, { source: "both" })).rejects.toThrow("no mic");
    expect(env.capture.armSystemAudio).not.toHaveBeenCalled();
    expect(env.getDisplayMedia).not.toHaveBeenCalled();
  });
});

describe("a source that ends by itself", () => {
  it("is reported with its kind and never replaced by another source", async () => {
    const env = install();
    const ended: string[] = [];
    await startMicCapture(() => undefined, { source: "both", onSourceEnded: (kind) => ended.push(kind) });
    (env.system as FakeStream).audioTracks[0].end(); // the user clicked "stop sharing"
    (env.mic as FakeStream).audioTracks[0].end(); // the headset was unplugged
    expect(ended).toEqual(["system", "microphone"]);
    expect(env.getUserMedia).toHaveBeenCalledTimes(1); // nothing was reopened behind the user's back
    expect(env.getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it("is not reported when the capture was stopped on purpose", async () => {
    const env = install();
    const onSourceEnded = vi.fn();
    const capture = await startMicCapture(() => undefined, { onSourceEnded });
    capture.stop();
    (env.mic as FakeStream).audioTracks[0].end();
    expect(onSourceEnded).not.toHaveBeenCalled();
  });
});
