import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMicCapture } from "../src/services/micCapture";

const track = () => ({ stop: vi.fn() });

function installAudio({ failAt }: { failAt?: "processor" } = {}) {
  const tracks = [track(), track()];
  const stream = { getTracks: () => tracks };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });

  const nodes = { source: { connect: vi.fn(), disconnect: vi.fn() }, processor: {} as Record<string, unknown>, gain: { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } } };
  const close = vi.fn().mockResolvedValue(undefined);
  class FakeContext {
    state = "running";
    sampleRate = 48_000;
    destination = {};
    close = close;
    resume = vi.fn();
    createMediaStreamSource() { return nodes.source; }
    createScriptProcessor() {
      if (failAt === "processor") throw new Error("no processor");
      nodes.processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
      return nodes.processor;
    }
    createGain() { return nodes.gain; }
  }
  vi.stubGlobal("AudioContext", FakeContext);
  return { tracks, close, nodes };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("startMicCapture", () => {
  it("streams 100 ms frames of 16 kHz PCM and releases everything on stop", async () => {
    const { tracks, close, nodes } = installAudio();
    const frames: Uint8Array[] = [];
    const capture = await startMicCapture((pcm) => frames.push(pcm));

    const process = nodes.processor.onaudioprocess as (event: unknown) => void;
    const samples = new Float32Array(4_800).fill(0.25); // 100 ms at 48 kHz
    process({ inputBuffer: { getChannelData: () => samples } });
    expect(frames).toHaveLength(1);
    expect(frames[0].byteLength).toBe(3_200); // 1600 samples of 16 bits

    capture.stop();
    expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(nodes.processor.onaudioprocess).toBeNull();
  });

  it("closes both the microphone and the audio context when setting up the graph fails", async () => {
    const { tracks, close } = installAudio({ failAt: "processor" });
    await expect(startMicCapture(() => undefined)).rejects.toThrow("no processor");
    expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("releases the microphone even if a node throws while disconnecting, and stop is idempotent", async () => {
    const { tracks, close, nodes } = installAudio();
    const capture = await startMicCapture(() => undefined);
    nodes.source.disconnect.mockImplementation(() => { throw new Error("already disconnected"); });
    expect(() => capture.stop()).not.toThrow();
    capture.stop(); // a second call (e.g. unmount after the stop button) does nothing
    expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("cleans up when the audio context itself cannot be created", async () => {
    const { tracks } = installAudio();
    vi.stubGlobal("AudioContext", class { constructor() { throw new Error("no audio device"); } });
    await expect(startMicCapture(() => undefined)).rejects.toThrow("no audio device");
    expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
  });

  it("reports an environment without microphone access", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    await expect(startMicCapture(() => undefined)).rejects.toThrow(/microphone/);
  });
});
