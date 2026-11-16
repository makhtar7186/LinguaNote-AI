// Starts and stops the local Python service. Kept free of Electron imports so it can be unit-tested.
const nodeCrypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const childProcess = require("node:child_process");

// Generous: at the first launch of an installed application, antivirus software scans every file of the frozen service.
const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 400;
const STDERR_TAIL_LINES = 20;
const MAX_DETAIL_CHARS = 300;
const MAX_START_ATTEMPTS = 3;
// Largest WebSocket message uvicorn will buffer (default 16 MiB). Audio frames are at most 64 KiB.
const WS_MAX_MESSAGE_BYTES = 256 * 1024;
const SERVICE_DIR = path.join(__dirname, "..", "..", "..", "services", "transcription");

class BackendStartError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

function newToken() {
  return nodeCrypto.randomBytes(32).toString("base64url");
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    // Port 0 asks the OS for a free port, which avoids conflicts with whatever already uses 8765.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The Windows venv python.exe is a launcher stub: killing only it would orphan the real interpreter. */
function killProcessTree(child) {
  if (process.platform === "win32" && child.pid) {
    childProcess.spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill();
  }
}

function resolvePython(env) {
  if (env.LINGUANOTE_PYTHON) return env.LINGUANOTE_PYTHON;
  return path.join(SERVICE_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

/**
 * What to run. An installed application runs the service it ships (`packagedService`: { executable, ffmpeg }) and
 * ignores LINGUANOTE_PYTHON: it must not start an interpreter named by the environment. From the sources, it is Python.
 */
function planServiceProcess(env, port, packagedService) {
  if (packagedService) {
    return {
      command: packagedService.executable,
      label: "le service local",
      args: ["--port", String(port), "--ws-max-size", String(WS_MAX_MESSAGE_BYTES)],
      cwd: path.dirname(packagedService.executable),
      // An explicit choice of FFmpeg wins over the copy shipped with the application.
      env: { LINGUANOTE_FFMPEG: env.LINGUANOTE_FFMPEG || packagedService.ffmpeg },
    };
  }
  const python = resolvePython(env);
  return {
    command: python,
    label: `Python (${python})`,
    args: ["-m", "uvicorn", "--factory", "app.main:create_app", "--host", "127.0.0.1", "--port", String(port), "--ws-max-size", String(WS_MAX_MESSAGE_BYTES)],
    cwd: SERVICE_DIR,
    env: {},
  };
}

/** `external` when the user points at a backend they run themselves; otherwise Electron owns the process. */
function planBackend(env = process.env) {
  if (env.LINGUANOTE_API_URL) return { mode: "external" };
  return { mode: "managed" };
}

async function waitUntilReady(base, token, { fetchImpl = fetch, isAlive, timeoutMs = READY_TIMEOUT_MS, sleep }) {
  const deadline = Date.now() + timeoutMs;
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  while (Date.now() < deadline) {
    if (!isAlive()) throw new BackendStartError("Le service local s'est arrêté pendant son démarrage.", { retryable: true });
    try {
      const response = await fetchImpl(`${base}/health`, {
        headers: { "X-LinguaNote-Token": token },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await wait(POLL_INTERVAL_MS);
  }
  throw new BackendStartError("Le service local n'a pas répondu à temps au démarrage.");
}

function redact(text, token) {
  // The secret is never expected in the service's output, but this text is shown to the user: be certain.
  return text.split(token).join("***").slice(0, MAX_DETAIL_CHARS);
}

async function startOnce(env, deps) {
  const {
    spawn = childProcess.spawn, portFinder = findFreePort, ready = waitUntilReady, killTree = killProcessTree,
    onSpawn = () => {}, onUnexpectedExit = () => {},
  } = deps;
  const token = newToken();
  const port = await portFinder();
  const base = `http://127.0.0.1:${port}`;
  const service = planServiceProcess(env, port, deps.packagedService);

  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...env, ...service.env, LINGUANOTE_API_TOKEN: token },
  });

  let alive = true;
  let stopping = false;
  let started = false;
  const stderrTail = [];
  child.stderr?.on("data", (chunk) => {
    // Only the tail of the service's own log output is kept, to explain a failed start.
    stderrTail.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES);
  });
  const spawnFailure = new Promise((_, reject) => {
    child.once("error", (error) => {
      alive = false;
      reject(new BackendStartError(`Impossible de lancer ${service.label} : ${error.message}`));
    });
  });
  child.once("exit", () => {
    alive = false;
    if (started && !stopping) onUnexpectedExit();
  });

  const stop = () => {
    stopping = true;
    if (alive) killTree(child);
  };
  // Lets the caller stop the process even if the application quits before startup finishes.
  onSpawn(stop);
  if (deps.isCancelled?.()) stop();

  try {
    await Promise.race([ready(base, token, { isAlive: () => alive }), spawnFailure]);
  } catch (error) {
    stop();
    const detail = redact(stderrTail.slice(-5).join(" | "), token);
    const message = error instanceof BackendStartError ? error.message : "Démarrage du service impossible.";
    throw new BackendStartError(detail ? `${message} (${detail})` : message, { retryable: error.retryable });
  }
  started = true;
  return { base, token, stop };
}

/**
 * Starts the service on a free loopback port with a fresh secret that only this process knows.
 * Returns `{ base, token, stop }`. Throws BackendStartError with a user-readable message.
 * The port is released before Python binds it, so another process can take it in between:
 * a process that exits during startup is retried on a new port.
 */
async function startManagedBackend(env = process.env, deps = {}) {
  const { isCancelled = () => false } = deps;
  let lastError;
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS && !isCancelled(); attempt += 1) {
    try {
      return await startOnce(env, deps);
    } catch (error) {
      lastError = error;
      if (!(error instanceof BackendStartError) || !error.retryable) break;
    }
  }
  throw lastError ?? new BackendStartError("Démarrage du service annulé.");
}

module.exports = {
  BackendStartError, newToken, findFreePort, resolvePython, planBackend, planServiceProcess, waitUntilReady, startManagedBackend, redact,
};
