// History operations of the Electron main process. Free of Electron imports so it can be unit-tested.
// The renderer never sees the token or the URLs: it asks for a fixed set of operations whose arguments are validated here.
const TIMEOUT_MS = 15_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RETENTION_DAYS = [7, 30, 90, 365, null];
const EXPORT_FORMATS = ["txt", "md", "srt", "vtt", "json"];
const MAX_QUERY_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_PAGE = 200;

class InvalidArgument extends Error {
  constructor(message) {
    super(message);
    this.code = "invalid_argument";
  }
}

function requireId(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new InvalidArgument("Identifiant de session invalide.");
  return id;
}

function integerIn(value, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new InvalidArgument("Paramètre de pagination invalide.");
  return value;
}

/** Each operation turns validated arguments into one request; anything else never reaches the network. */
const OPERATIONS = {
  getSettings: () => ({ method: "GET", route: "/api/v1/history/settings" }),
  setSettings: (args) => {
    if (typeof args?.enabled !== "boolean") throw new InvalidArgument("Réglage invalide.");
    if (!RETENTION_DAYS.includes(args.retentionDays)) throw new InvalidArgument("Durée de conservation invalide.");
    return {
      method: "PUT", route: "/api/v1/history/settings", body: { enabled: args.enabled, retention_days: args.retentionDays },
    };
  },
  list: (args) => {
    const query = args?.query ?? "";
    if (typeof query !== "string" || query.length > MAX_QUERY_LENGTH) throw new InvalidArgument("Recherche invalide.");
    const params = new URLSearchParams({
      limit: String(integerIn(args?.limit, 1, MAX_PAGE, 50)), offset: String(integerIn(args?.offset, 0, 1_000_000, 0)),
    });
    if (query.trim()) params.set("query", query);
    return { method: "GET", route: `/api/v1/history/sessions?${params}` };
  },
  get: (args) => ({ method: "GET", route: `/api/v1/history/sessions/${requireId(args?.id)}` }),
  rename: (args) => {
    const title = typeof args?.title === "string" ? args.title.trim() : "";
    if (!title || title.length > MAX_TITLE_LENGTH) throw new InvalidArgument("Titre invalide.");
    return { method: "PATCH", route: `/api/v1/history/sessions/${requireId(args?.id)}`, body: { title } };
  },
  remove: (args) => ({ method: "DELETE", route: `/api/v1/history/sessions/${requireId(args?.id)}` }),
  // Wiping everything needs the explicit confirmation flag, as the backend does.
  removeAll: (args) => {
    if (args?.confirm !== true) throw new InvalidArgument("La suppression de tout l'historique demande une confirmation.");
    return { method: "DELETE", route: "/api/v1/history/sessions?confirm=all" };
  },
};

function describeFailure(response, body) {
  return {
    ok: false,
    code: typeof body?.code === "string" ? body.code : "http_error",
    message: typeof body?.detail === "string" ? body.detail : `Erreur HTTP ${response.status}`,
  };
}

async function send(config, spec, fetchImpl) {
  const headers = config.token ? { "X-LinguaNote-Token": config.token } : {};
  const init = { method: spec.method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (spec.body !== undefined) {
    init.body = JSON.stringify(spec.body);
    headers["Content-Type"] = "application/json";
  }
  try {
    return await fetchImpl(`${config.base}${spec.route}`, init);
  } catch (cause) {
    const timedOut = cause?.name === "TimeoutError";
    const error = new Error(timedOut ? "Le service local n'a pas répondu à temps." : "Service local indisponible.");
    error.code = timedOut ? "timeout" : "service_unavailable";
    throw error;
  }
}

/** Runs one allow-listed operation. Failures come back as data (see api-client.cjs for why). */
async function run(config, operation, args, fetchImpl = fetch) {
  const build = Object.hasOwn(OPERATIONS, operation) ? OPERATIONS[operation] : null;
  if (!build) return { ok: false, code: "invalid_argument", message: "Opération inconnue." };
  try {
    const response = await send(config, build(args), fetchImpl);
    if (response.status === 204) return { ok: true, data: null };
    const body = await response.json().catch(() => null);
    if (!response.ok) return describeFailure(response, body);
    return { ok: true, data: body };
  } catch (error) {
    return { ok: false, code: error.code ?? "unknown", message: error.message };
  }
}

/** Fetches an export and returns its text with the server's suggested name; the main process then asks where to save. */
async function exportSession(config, args, fetchImpl = fetch) {
  try {
    const id = requireId(args?.id);
    if (!EXPORT_FORMATS.includes(args?.format)) throw new InvalidArgument("Format d'export inconnu.");
    const response = await send(config, {
      method: "GET", route: `/api/v1/history/sessions/${id}/export?format=${args.format}`,
    }, fetchImpl);
    if (!response.ok) return describeFailure(response, await response.json().catch(() => null));
    const disposition = response.headers.get("content-disposition") ?? "";
    const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
    return { ok: true, content: await response.text(), suggestedName: encoded ? safeFileName(decodeURIComponent(encoded), args.format) : `linguanote.${args.format}` };
  } catch (error) {
    return { ok: false, code: error.code ?? "unknown", message: error.message };
  }
}

/** The name proposed to the save dialog: no folders, no reserved characters, and the right extension. */
function safeFileName(name, format) {
  const noControls = Array.from(name, (char) => (char.codePointAt(0) < 32 ? "_" : char)).join("");
  const cleaned = noControls.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  const base = cleaned.toLowerCase().endsWith(`.${format}`) ? cleaned : `${cleaned || "linguanote"}.${format}`;
  return base;
}

module.exports = { run, exportSession, safeFileName, EXPORT_FORMATS, OPERATIONS };
