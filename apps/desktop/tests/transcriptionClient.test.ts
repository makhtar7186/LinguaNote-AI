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
    expect(parsed.segments).toEqual([{ start_seconds: 0, end_seconds: 1, text: "ok", language: null }]);
    expect(parsed.warnings).toEqual([]);
  });

  it("keeps the language of each routed segment and the warnings, and ignores wrong types", () => {
    const parsed = parseTranscription({
      text: "bonjour waaw", engine: "language-router", model: "small+wolof",
      segments: [
        { start_seconds: 0, end_seconds: 1, text: "bonjour", language: "fr" },
        { start_seconds: 1, end_seconds: 2, text: "waaw", language: 42 },
      ],
      warnings: ["passage_failed: 2.0-3.0 s (wo) is missing from the text", 7, null],
    });
    expect(parsed.segments.map((segment) => segment.language)).toEqual(["fr", null]);
    expect(parsed.warnings).toEqual(["passage_failed: 2.0-3.0 s (wo) is missing from the text"]);
  });

  it("drops segments with non-finite, negative or reversed timestamps", () => {
    const parsed = parseTranscription({
      text: "t", engine: "e", model: "m",
      segments: [
        { start_seconds: Number.NaN, end_seconds: 1, text: "nan" },
        { start_seconds: -1, end_seconds: 1, text: "negative" },
        { start_seconds: 3, end_seconds: 2, text: "reversed" },
        { start_seconds: 0, end_seconds: Number.POSITIVE_INFINITY, text: "infinite" },
        { start_seconds: 1, end_seconds: 2, text: "good" },
      ],
    });
    expect(parsed.segments).toEqual([{ start_seconds: 1, end_seconds: 2, text: "good", language: null }]);
  });

  it("treats an out-of-range language probability as absent", () => {
    const base = { text: "t", engine: "e", model: "m" };
    expect(parseTranscription({ ...base, language_probability: 1.7 }).language_probability).toBeNull();
    expect(parseTranscription({ ...base, language_probability: 0.42 }).language_probability).toBe(0.42);
  });

  it("rejects payloads without text", () => {
    expect(() => parseTranscription({ engine: "e", model: "m" })).toThrow(TranscriptionError);
    expect(() => parseTranscription(null)).toThrow(TranscriptionError);
  });
});

describe("parseHealth", () => {
  it("keeps only known languages, and tells an older service (no list) apart from an empty list", () => {
    expect(parseHealth({ ok: true, languages: ["fr", "wo", "de", 3] }).languages).toEqual(["fr", "wo"]);
    expect(parseHealth({ ok: true, languages: [] }).languages).toEqual([]);
    expect(parseHealth({ ok: true }).languages).toBeUndefined();
  });

  it("ignores malformed limits", () => {
    expect(parseHealth({ ok: true, limits: { max_upload_bytes: "x" } }).limits).toBeUndefined();
  });

  it("rejects zero, negative or infinite limits", () => {
    const limits = (max_upload_bytes: number, max_audio_seconds: number) => ({
      ok: true, limits: { max_upload_bytes, max_audio_seconds, extensions: [".wav"] },
    });
    expect(parseHealth(limits(0, 10)).limits).toBeUndefined();
    expect(parseHealth(limits(10, -5)).limits).toBeUndefined();
    expect(parseHealth(limits(10, Number.POSITIVE_INFINITY)).limits).toBeUndefined();
    expect(parseHealth(limits(10, 30)).limits?.max_audio_seconds).toBe(30);
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
