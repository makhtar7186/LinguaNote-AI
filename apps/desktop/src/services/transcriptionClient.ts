import type { Limits, Segment, ServiceHealth, TranscriptionResponse } from "../types";

const DEV_API = import.meta.env.VITE_TRANSCRIPTION_API || "http://127.0.0.1:8765";
const DEV_TIMEOUT_MS = 15 * 60_000;
// Browser preview only (`npm run dev:web`). The packaged app talks to the backend through Electron IPC,
// where the secret never reaches the renderer.
const DEV_TOKEN = import.meta.env.VITE_TRANSCRIPTION_TOKEN || "";

export class TranscriptionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null;
const optString = (value: unknown) => (typeof value === "string" ? value : null);
const optNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const isPositiveFinite = (value: unknown): value is number => (
  typeof value === "number" && Number.isFinite(value) && value > 0
);

/** Segments must be ordered, finite and non-negative; anything else is dropped, never invented. */
function parseSegments(value: unknown): Segment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRec(item) || typeof item.text !== "string") return [];
    const start = optNumber(item.start_seconds);
    const end = optNumber(item.end_seconds);
    if (start === null || end === null || start < 0 || end < start) return [];
    return [{ start_seconds: start, end_seconds: end, text: item.text, language: optString(item.language) }];
  });
}

function parseWarnings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** A probability outside [0, 1] is a malformed value, not a confidence score. */
function parseProbability(value: unknown): number | null {
  const probability = optNumber(value);
  return probability !== null && probability >= 0 && probability <= 1 ? probability : null;
}

/** The backend is a separate process: never trust its payload shape. */
export function parseTranscription(value: unknown): TranscriptionResponse {
  if (!isRec(value) || typeof value.text !== "string"
    || typeof value.engine !== "string" || typeof value.model !== "string") {
    throw new TranscriptionError("invalid_response", "Réponse invalide du service de transcription.");
  }
  return {
    text: value.text,
    engine: value.engine,
    model: value.model,
    duration_seconds: optNumber(value.duration_seconds) ?? 0,
    timing_available: value.timing_available === true,
    language: optString(value.language),
    language_probability: parseProbability(value.language_probability),
    segments: parseSegments(value.segments),
    warnings: parseWarnings(value.warnings),
  };
}

function parseLimits(value: unknown): Limits | undefined {
  if (!isRec(value) || !isPositiveFinite(value.max_upload_bytes)
    || !isPositiveFinite(value.max_audio_seconds) || !Array.isArray(value.extensions)) return undefined;
  return {
    max_upload_bytes: value.max_upload_bytes,
    max_audio_seconds: value.max_audio_seconds,
    extensions: value.extensions.filter((item): item is string => typeof item === "string"),
  };
}

export function parseHealth(value: unknown): ServiceHealth {
  if (!isRec(value) || typeof value.ok !== "boolean") return { ok: false, message: "Réponse invalide du service." };
  return {
    ok: value.ok,
    engine_selected: value.engine_selected === true,
    engine: optString(value.engine),
    model: optString(value.model),
    setup_message: optString(value.setup_message),
    ffmpeg_available: typeof value.ffmpeg_available === "boolean" ? value.ffmpeg_available : undefined,
    limits: parseLimits(value.limits),
    message: optString(value.message) ?? undefined,
    code: optString(value.code) ?? undefined,
  };
}

/** The main process returns `{ok, data}` or `{ok:false, code, message}`; errors are never thrown across IPC. */
export function unwrapIpc(value: unknown): unknown {
  if (!isRec(value) || typeof value.ok !== "boolean") {
    throw new TranscriptionError("invalid_response", "Réponse invalide du pont Electron.");
  }
  if (!value.ok) {
    throw new TranscriptionError(
      typeof value.code === "string" ? value.code : "unknown",
      typeof value.message === "string" ? value.message : "La transcription a échoué.",
    );
  }
  return value.data;
}

async function devFetch(route: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${DEV_API}${route}`, {
      ...init,
      headers: DEV_TOKEN ? { "X-LinguaNote-Token": DEV_TOKEN } : {},
      signal: AbortSignal.timeout(DEV_TIMEOUT_MS),
    });
  } catch {
    throw new TranscriptionError("service_unavailable", "Service local indisponible. Démarrez le service Python.");
  }
}

export async function getServiceHealth(): Promise<ServiceHealth> {
  if (window.linguaNote) return parseHealth(await window.linguaNote.health());
  try {
    const response = await devFetch("/health");
    if (!response.ok) return { ok: false, message: `Service HTTP ${response.status}` };
    return parseHealth({ ok: true, ...(await response.json()) });
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : "Service local indisponible" };
  }
}

export async function transcribeFile(audioFile: File): Promise<TranscriptionResponse> {
  if (window.linguaNote) {
    const raw = await window.linguaNote.transcribe({
      name: audioFile.name,
      type: audioFile.type || "application/octet-stream",
      bytes: new Uint8Array(await audioFile.arrayBuffer()),
    });
    return parseTranscription(unwrapIpc(raw));
  }
  const form = new FormData();
  form.append("file", audioFile, audioFile.name);
  const response = await devFetch("/api/v1/transcriptions", { method: "POST", body: form });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const body = isRec(payload) ? payload : {};
    throw new TranscriptionError(
      typeof body.code === "string" ? body.code : "http_error",
      typeof body.detail === "string" ? body.detail : `Erreur HTTP ${response.status}`,
    );
  }
  return parseTranscription(payload);
}
