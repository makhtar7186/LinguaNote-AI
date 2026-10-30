import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseHealth,
  parseTranscription,
  transcribeFile,
  TranscriptionError,
  unwrapIpc,
} from "../src/services/transcriptionClient";

afterEach(() => {
  delete window.linguaNote;
  vi.restoreAllMocks();
});

describe("parseTranscription", () => {
  it("normalises a full backend payload", () => {
    const parsed = parseTranscription({
      text: "bonjour", engine: "faster-whisper", model: "base", duration_seconds: 2,
      timing_available: true, language: "fr", language_probability: 0.9,
      segments: [{ start_seconds: 0, end_seconds: 1, text: "bonjour" }],
    });
    expect(parsed.language).toBe("fr");
    expect(parsed.segments).toHaveLength(1);
  });

  it("fills optional fields and drops malformed segments", () => {
    const parsed = parseTranscription({
      text: "", engine: "e", model: "m", segments: [{ text: 1 }, "x", { start_seconds: 0, end_seconds: 1, text: "ok" }],
    });
    expect(parsed.language).toBeNull();
    expect(parsed.timing_available).toBe(false);
    expect(parsed.segments).toEqual([{ start_seconds: 0, end_seconds: 1, text: "ok" }]);
  });

  it("rejects payloads without text", () => {
    expect(() => parseTranscription({ engine: "e", model: "m" })).toThrow(TranscriptionError);
    expect(() => parseTranscription(null)).toThrow(TranscriptionError);
  });
});

describe("parseHealth", () => {
  it("ignores malformed limits", () => {
    expect(parseHealth({ ok: true, limits: { max_upload_bytes: "x" } }).limits).toBeUndefined();
  });

  it("flags an invalid envelope as unavailable", () => {
    expect(parseHealth("nope").ok).toBe(false);
  });
});

describe("unwrapIpc", () => {
  it("returns data on success", () => {
    expect(unwrapIpc({ ok: true, data: { a: 1 } })).toEqual({ a: 1 });
  });

  it("turns an error envelope into a TranscriptionError with its code", () => {
    try {
      unwrapIpc({ ok: false, code: "timeout", message: "trop long" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptionError);
      expect((error as TranscriptionError).code).toBe("timeout");
      expect((error as TranscriptionError).message).toBe("trop long");
    }
  });

  it("rejects values that are not an envelope", () => {
    expect(() => unwrapIpc(undefined)).toThrow(TranscriptionError);
  });
});

describe("transcribeFile through the Electron bridge", () => {
  it("sends the bytes and parses the result", async () => {
    const transcribe = vi.fn().mockResolvedValue({
      ok: true, data: { text: "salut", engine: "e", model: "m" },
    });
    window.linguaNote = { health: vi.fn(), transcribe } as unknown as Window["linguaNote"];
    const file = new File([new Uint8Array([1, 2, 3])], "clip.wav", { type: "audio/wav" });
    const result = await transcribeFile(file);
    expect(result.text).toBe("salut");
    expect(transcribe.mock.calls[0][0].name).toBe("clip.wav");
    expect(transcribe.mock.calls[0][0].bytes).toBeInstanceOf(Uint8Array);
  });

  it("surfaces backend errors without an Electron prefix", async () => {
    window.linguaNote = {
      health: vi.fn(),
      transcribe: vi.fn().mockResolvedValue({ ok: false, code: "ffmpeg_missing", message: "FFmpeg requis" }),
    } as unknown as Window["linguaNote"];
    await expect(transcribeFile(new File(["x"], "a.wav"))).rejects.toThrow("FFmpeg requis");
  });
});
