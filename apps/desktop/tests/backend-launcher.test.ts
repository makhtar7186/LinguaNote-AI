import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const launcher = createRequire(import.meta.url)("../electron/backend-launcher.cjs");

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("planBackend", () => {
  it("manages the backend by default and honours an explicit external URL", () => {
    expect(launcher.planBackend({})).toEqual({ mode: "managed" });
    expect(launcher.planBackend({ LINGUANOTE_API_URL: "http://127.0.0.1:9000" })).toEqual({ mode: "external" });
  });
});

describe("newToken", () => {
  it("is long, url-safe and different every time", () => {
    const first = launcher.newToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(launcher.newToken()).not.toBe(first);
  });
});

describe("findFreePort", () => {
  it("returns a usable loopback port", async () => {
    const port = await launcher.findFreePort();
    expect(port).toBeGreaterThan(1023);
  });
});

describe("startManagedBackend", () => {
  it("starts on the chosen port with a secret only the child receives", async () => {
    const child = fakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const ready = vi.fn().mockResolvedValue(undefined);
    const backend = await launcher.startManagedBackend(
      { LINGUANOTE_PYTHON: "py.exe", PATH: "x" },
      { spawn, portFinder: async () => 5555, ready },
    );

    expect(backend.base).toBe("http://127.0.0.1:5555");
    const [python, args, options] = spawn.mock.calls[0];
    expect(python).toBe("py.exe");
    expect(args).toEqual(expect.arrayContaining(["--factory", "app.main:create_app", "--host", "127.0.0.1", "--port", "5555"]));
    expect(options.env.LINGUANOTE_API_TOKEN).toBe(backend.token);
    expect(options.windowsHide).toBe(true);
    expect(ready).toHaveBeenCalledWith("http://127.0.0.1:5555", backend.token, expect.anything());
  });

  it("stops the child process on request", async () => {
    const child = fakeChild();
    const killTree = vi.fn();
    const backend = await launcher.startManagedBackend({}, {
      spawn: () => child, portFinder: async () => 1, ready: async () => undefined, killTree,
    });
    backend.stop();
    expect(killTree).toHaveBeenCalledWith(child);
  });

  it("reports a missing Python interpreter in readable terms", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    });
    await expect(launcher.startManagedBackend({ LINGUANOTE_PYTHON: "missing.exe" }, {
      spawn, portFinder: async () => 1, ready: () => new Promise(() => undefined),
    })).rejects.toThrow(/Impossible de lancer Python \(missing\.exe\)/);
  });

  it("kills the child and includes its last log lines when it never becomes ready", async () => {
    const child = fakeChild();
    const ready = vi.fn(async () => {
      child.stderr.emit("data", "ConfigurationError: boom\n");
      throw new launcher.BackendStartError("Le service local s'est arrêté pendant son démarrage.");
    });
    const killTree = vi.fn();
    await expect(launcher.startManagedBackend({}, { spawn: () => child, portFinder: async () => 1, ready, killTree }))
      .rejects.toThrow(/arrêté pendant son démarrage.*ConfigurationError: boom/);
    expect(killTree).toHaveBeenCalledWith(child);
  });
});

describe("waitUntilReady", () => {
  it("polls /health with the token until it answers", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("refused"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await launcher.waitUntilReady("http://127.0.0.1:1", "tok", { fetchImpl, isAlive: () => true, sleep: async () => undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1].headers).toEqual({ "X-LinguaNote-Token": "tok" });
  });

  it("fails fast when the process is gone", async () => {
    await expect(launcher.waitUntilReady("http://127.0.0.1:1", "tok", {
      fetchImpl: vi.fn(), isAlive: () => false, sleep: async () => undefined,
    })).rejects.toThrow(/arrêté/);
  });

  it("gives up after the timeout", async () => {
    await expect(launcher.waitUntilReady("http://127.0.0.1:1", "tok", {
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("refused")),
      isAlive: () => true, timeoutMs: 20, sleep: () => new Promise((resolve) => setTimeout(resolve, 15)),
    })).rejects.toThrow(/pas répondu à temps/);
  });
});
