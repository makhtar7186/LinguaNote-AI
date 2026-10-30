// Backend client used by the Electron main process. Kept free of Electron imports so it can be unit-tested.
const path = require("node:path");

const DEFAULT_API_BASE = "http://127.0.0.1:8765";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 5_000;
const TRANSCRIBE_TIMEOUT_MS = 15 * 60_000;
const ALLOWED_EXTENSIONS = new Set([
  ".aac", ".flac", ".m4a", ".mkv", ".mov", ".mp3", ".mp4",
  ".oga", ".ogg", ".opus", ".wav", ".webm", ".wma",
]);

class IpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function getConfig(env = process.env) {
  const base = (env.LINGUANOTE_API_URL || DEFAULT_API_BASE).replace(/\/$/, "");
  const { hostname, protocol } = new URL(base);
  // The backend must stay on loopback (AGENTS.md section 5).
  if (protocol !== "http:" || !["127.0.0.1", "localhost"].includes(hostname)) {
    throw new Error("LINGUANOTE_API_URL must be an http loopback address.");
  }
  return { base, token: env.LINGUANOTE_API_TOKEN || "" };
}

function validateTranscribePayload(payload) {
  if (!payload || typeof payload.name !== "string" || typeof payload.type !== "string") {
    throw new IpcError("invalid_payload", "Fichier invalide.");
  }
  const extension = path.extname(payload.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new IpcError("unsupported_extension", "Format de fichier non pris en charge.");
  }
  if (!(payload.bytes instanceof Uint8Array) || payload.bytes.byteLength === 0) {
    throw new IpcError("empty_file", "Le fichier audio est vide ou illisible.");
  }
  if (payload.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new IpcError("file_too_large", "La limite de taille est de 50 Mio.");
  }
}

async function request(config, route, init, timeoutMs, fetchImpl = fetch) {
  const headers = config.token ? { "X-LinguaNote-Token": config.token } : {};
  try {
    return await fetchImpl(`${config.base}${route}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    if (cause?.name === "TimeoutError") {
      throw new IpcError("timeout", "Le service local n'a pas répondu à temps.");
    }
    throw new IpcError("service_unavailable", "Service local indisponible. Démarrez le service Python.");
  }
}

// Errors are returned as data instead of thrown: Electron prefixes thrown IPC
// errors with "Error invoking remote method ...", which would reach the user.
async function health(config, fetchImpl) {
  try {
    const response = await request(config, "/health", {}, HEALTH_TIMEOUT_MS, fetchImpl);
    if (!response.ok) return { ok: false, code: "http_error", message: `Service HTTP ${response.status}` };
    return { ok: true, ...(await response.json()) };
  } catch (error) {
    return { ok: false, code: error.code ?? "unknown", message: error.message };
  }
}

async function transcribe(config, payload, fetchImpl) {
  try {
    validateTranscribePayload(payload);
    const body = new FormData();
    body.append("file", new Blob([payload.bytes], { type: payload.type }), payload.name);
    const response = await request(
      config, "/api/v1/transcriptions", { method: "POST", body }, TRANSCRIBE_TIMEOUT_MS, fetchImpl,
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        code: typeof result.code === "string" ? result.code : "http_error",
        message: typeof result.detail === "string" ? result.detail : `Erreur HTTP ${response.status}`,
      };
    }
    return { ok: true, data: result };
  } catch (error) {
    if (error instanceof IpcError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "unknown", message: "La transcription a échoué." };
  }
}

module.exports = { IpcError, getConfig, validateTranscribePayload, health, transcribe, MAX_UPLOAD_BYTES };
