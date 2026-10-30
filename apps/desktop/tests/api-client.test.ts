import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

// The main-process client is CommonJS and has no Electron dependency.
const api = createRequire(import.meta.url)("../electron/api-client.cjs");
const config = { base: "http://127.0.0.1:8765", token: "tok" };
const bytes = new Uint8Array([1, 2, 3]);
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("getConfig", () => {
  it("defaults to the loopback API", () => {
    expect(api.getConfig({}).base).toBe("http://127.0.0.1:8765");
  });

  it("refuses non-loopback or non-http backends", () => {
    expect(() => api.getConfig({ LINGUANOTE_API_URL: "http://example.com:8765" })).toThrow();
    expect(() => api.getConfig({ LINGUANOTE_API_URL: "https://127.0.0.1:8765" })).toThrow();
  });
});

describe("validateTranscribePayload", () => {
  const valid = { name: "a.wav", type: "audio/wav", bytes };

  it("accepts a well-formed payload", () => {
    expect(() => api.validateTranscribePayload(valid)).not.toThrow();
  });

  it.each([
    [null],
    [{ ...valid, name: 3 }],
    [{ ...valid, name: "a.exe" }],
    [{ ...valid, bytes: new Uint8Array(0) }],
    [{ ...valid, bytes: [1, 2] }],
  ])("rejects invalid payload %#", (payload) => {
    expect(() => api.validateTranscribePayload(payload)).toThrow();
  });
});

describe("transcribe", () => {
  it("sends the token header and returns data", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ text: "ok" }));
    const result = await api.transcribe(config, { name: "a.wav", type: "audio/wav", bytes }, fetchImpl);
    expect(result).toEqual({ ok: true, data: { text: "ok" } });
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ "X-LinguaNote-Token": "tok" });
  });

  it("maps backend errors to the envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ detail: "trop long", code: "audio_too_long" }, 413));
    const result = await api.transcribe(config, { name: "a.wav", type: "audio/wav", bytes }, fetchImpl);
    expect(result).toEqual({ ok: false, code: "audio_too_long", message: "trop long" });
  });

  it("reports an unreachable service", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const result = await api.transcribe(config, { name: "a.wav", type: "audio/wav", bytes }, fetchImpl);
    expect(result).toMatchObject({ ok: false, code: "service_unavailable" });
  });

  it("reports a timeout", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const fetchImpl = vi.fn().mockRejectedValue(timeout);
    const result = await api.transcribe(config, { name: "a.wav", type: "audio/wav", bytes }, fetchImpl);
    expect(result).toMatchObject({ ok: false, code: "timeout" });
  });

  it("never calls the backend for an invalid payload", async () => {
    const fetchImpl = vi.fn();
    const result = await api.transcribe(config, { name: "a.exe", type: "x", bytes }, fetchImpl);
    expect(result).toMatchObject({ ok: false, code: "unsupported_extension" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("health", () => {
  it("merges the backend payload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "ok", engine_selected: true }));
    expect(await api.health(config, fetchImpl)).toMatchObject({ ok: true, engine_selected: true });
  });

  it("returns ok:false instead of throwing when the service is down", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("down"));
    expect(await api.health(config, fetchImpl)).toMatchObject({ ok: false, code: "service_unavailable" });
  });
});
