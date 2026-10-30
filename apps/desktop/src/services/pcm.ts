/** Converts microphone audio (any sample rate, float) to the live protocol format: 16 kHz mono PCM s16le. */

export const TARGET_RATE = 16_000;
export const FRAME_SAMPLES = 1_600; // 100 ms per frame sent to the service

/**
 * Streaming area-averaging resampler (mono). Each output sample is the average of the input span it covers,
 * which also acts as a simple anti-aliasing low-pass filter. Chunk boundaries never change the result.
 */
export class Resampler {
  private readonly ratio: number; // input samples per output sample
  private consumed = 0; // input samples consumed so far
  private produced = 0; // output samples produced so far
  private accumulator = 0;

  constructor(inputRate: number, outputRate = TARGET_RATE) {
    if (!Number.isFinite(inputRate) || inputRate <= 0) throw new RangeError("Invalid input sample rate.");
    this.ratio = inputRate / outputRate;
  }

  process(input: Float32Array): Float32Array {
    const output: number[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const sample = input[index];
      const end = this.consumed + 1;
      let cursor = this.consumed;
      while (cursor < end) {
        const boundary = (this.produced + 1) * this.ratio;
        const stop = Math.min(end, boundary);
        this.accumulator += sample * (stop - cursor);
        cursor = stop;
        if (stop >= boundary - 1e-9) {
          output.push(this.accumulator / this.ratio);
          this.accumulator = 0;
          this.produced += 1;
        }
      }
      this.consumed = end;
    }
    return Float32Array.from(output);
  }
}

export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    out[index] = Math.round(clamped * 32_767);
  }
  return out;
}

/** Collects samples and emits fixed-size little-endian PCM frames. */
export class FrameBuffer {
  private pending = new Int16Array(0);

  constructor(
    private readonly onFrame: (pcm: Uint8Array) => void,
    private readonly frameSamples = FRAME_SAMPLES,
  ) {}

  push(samples: Int16Array): void {
    const merged = new Int16Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    let offset = 0;
    while (merged.length - offset >= this.frameSamples) {
      this.onFrame(toBytes(merged.subarray(offset, offset + this.frameSamples)));
      offset += this.frameSamples;
    }
    this.pending = merged.slice(offset);
  }

  /** Emits what is left (less than one frame), e.g. when recording stops. */
  flush(): void {
    if (this.pending.length > 0) this.onFrame(toBytes(this.pending));
    this.pending = new Int16Array(0);
  }
}

function toBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}
