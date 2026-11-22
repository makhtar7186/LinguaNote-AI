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

const HEALTH_LIMITS = { limits: { max_upload_bytes: 1024, max_audio_seconds: 30, extensions: [".wav", ".ogg"] } };

/** Routes by URL and builds a fresh Response per call (a Response body can only be read once). */
function backend({ health = HEALTH_LIMITS, post }: { health?: unknown; post: () => Response | Promise<Response> }) {
  return vi.fn(async (url: string, _init?: { headers?: Record<string, string> }) => (
    String(url).endsWith("/health") ? jsonResponse(health) : post()
  ));
}
const posts = (fetchImpl: ReturnType<typeof backend>) => fetchImpl.mock.calls.filter(([url]) => !String(url).endsWith("/health"));

describe("transcribe", () => {
  it("sends the token header and returns data", async () => {
    const fetchImpl = backend({ post: () => jsonResponse({ text: "ok" }) });
    const result = await api.transcribe(config, { name: "a.wav", type: "audio/wav", bytes }, fetchImpl);
    expect(result).toEqual({ ok: true, data: { text: "ok" } });
    expect(posts(fetchImpl)[0][1]?.headers).toEqual({ "X-LinguaNote-Token": "tok" });
  });

  it("maps backend errors to the envelope", async () => {
    const fetchImpl = backend({ post: () => jsonResponse({ detail: "trop long", code: "audio_too_long" }, 413) });
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
    const fetchImpl = backend({ post: () => Promise.reject(timeout) });
    const result = await api.transcribe(config, { name: "a.wav", type: "audio/wav", bytes }, fetchImpl);
    expect(result).toMatchObject({ ok: false, code: "timeout" });
  });

  it("never uploads an invalid payload", async () => {
    const fetchImpl = backend({ post: () => jsonResponse({}) });
    const result = await api.transcribe(config, { name: "a.exe", type: "x", bytes }, fetchImpl);
    expect(result).toMatchObject({ ok: false, code: "unsupported_extension" });
    expect(posts(fetchImpl)).toHaveLength(0);
  });

  it("enforces the limits advertised by the service rather than hardcoded ones", async () => {
    const fetchImpl = backend({ post: () => jsonResponse({ text: "ok" }) });
    const big = new Uint8Array(2048);
    expect(await api.transcribe(config, { name: "a.wav", type: "audio/wav", bytes: big }, fetchImpl))
      .toMatchObject({ ok: false, code: "file_too_large" });
    expect(await api.transcribe(config, { name: "a.mp3", type: "audio/mpeg", bytes }, fetchImpl))
      .toMatchObject({ ok: false, code: "unsupported_extension" });
    expect(posts(fetchImpl)).toHaveLength(0);
  });

  it("falls back to default limits when /health is malformed", async () => {
    const fetchImpl = backend({ health: { limits: { max_upload_bytes: -1, extensions: "wav" } }, post: () => jsonResponse({ text: "ok" }) });
    expect(await api.transcribe(config, { name: "a.mp3", type: "audio/mpeg", bytes }, fetchImpl))
      .toEqual({ ok: true, data: { text: "ok" } });
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

describe("spoken language", () => {
  it("sends the imposed language as a form field, and none in the several-languages mode", async () => {
    const fetchImpl = backend({ post: () => jsonResponse({ text: "ok" }) });
    await api.transcribe(config, { name: "a.wav", type: "audio/wav", bytes, language: "wo" }, fetchImpl);
    await api.transcribe(config, { name: "a.wav", type: "audio/wav", bytes }, fetchImpl);
    const [imposed, auto] = posts(fetchImpl).map(([, init]) => (init as RequestInit | undefined)?.body as FormData);
    expect(imposed.get("language")).toBe("wo");
    expect(auto.get("language")).toBeNull();
  });

  it("never uploads an unknown language", async () => {
    const fetchImpl = backend({ post: () => jsonResponse({ text: "ok" }) });
    const result = await api.transcribe(config, { name: "a.wav", type: "audio/wav", bytes, language: "de" }, fetchImpl);
    expect(result).toEqual({ ok: false, code: "unsupported_language", message: "Langue inconnue." });
    expect(posts(fetchImpl)).toHaveLength(0);
  });
});
