import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import nodePath from "node:path";
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

describe("planServiceProcess", () => {
  const shipped = { executable: nodePath.join("app", "service", "linguanote-service.exe"), ffmpeg: nodePath.join("app", "ffmpeg", "ffmpeg.exe") };

  it("runs Python from the sources when no service is shipped", () => {
    const plan = launcher.planServiceProcess({ LINGUANOTE_PYTHON: "py.exe" }, 5555, undefined);
    expect(plan.command).toBe("py.exe");
    expect(plan.args).toEqual(expect.arrayContaining(["-m", "uvicorn", "--host", "127.0.0.1", "--port", "5555"]));
    expect(plan.env).toEqual({});
  });

  it("runs the shipped service from its own folder, with the shipped FFmpeg", () => {
    const plan = launcher.planServiceProcess({}, 5555, shipped);
    expect(plan.command).toBe(shipped.executable);
    expect(plan.args.slice(0, 2)).toEqual(["--port", "5555"]);
    expect(plan.args).toContain("--ws-max-size");
    expect(plan.cwd).toBe(nodePath.join("app", "service"));
    expect(plan.env.LINGUANOTE_FFMPEG).toBe(shipped.ffmpeg);
  });

  it("does not let the environment replace the shipped service with another program", () => {
    expect(launcher.planServiceProcess({ LINGUANOTE_PYTHON: "other.exe" }, 5555, shipped).command).toBe(shipped.executable);
  });

  it("keeps a FFmpeg the user chose explicitly", () => {
    expect(launcher.planServiceProcess({ LINGUANOTE_FFMPEG: "chosen.exe" }, 5555, shipped).env.LINGUANOTE_FFMPEG).toBe("chosen.exe");
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
  it("starts the shipped service with the secret and the shipped FFmpeg", async () => {
    const spawn = vi.fn().mockReturnValue(fakeChild());
    const backend = await launcher.startManagedBackend(
      { PATH: "x" },
      { spawn, portFinder: async () => 5555, ready: vi.fn().mockResolvedValue(undefined), packagedService: { executable: "svc.exe", ffmpeg: "ff.exe" } },
    );
    const [command, , options] = spawn.mock.calls[0];
    expect(command).toBe("svc.exe");
    expect(options.env).toMatchObject({ LINGUANOTE_API_TOKEN: backend.token, LINGUANOTE_FFMPEG: "ff.exe", PATH: "x" });
  });

  it("names the service, not Python, when the shipped service cannot be launched", async () => {
    const child = fakeChild();
    const spawn = vi.fn().mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child;
    });
    await expect(launcher.startManagedBackend(
      {},
      { spawn, portFinder: async () => 5555, ready: () => new Promise(() => {}), packagedService: { executable: "svc.exe", ffmpeg: "ff.exe" } },
    )).rejects.toThrow(/Impossible de lancer le service local : ENOENT/);
  });

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

describe("startManagedBackend resilience", () => {
  const exitedEarly = () => {
    throw new launcher.BackendStartError("Le service local s'est arrêté pendant son démarrage.", { retryable: true });
  };

  it("retries on a new port when the process dies while starting (port taken in between)", async () => {
    const ports = [4001, 4002];
    const children = [fakeChild(), fakeChild()];
    const spawn = vi.fn(() => children.shift());
    const ready = vi.fn()
      .mockImplementationOnce(async () => exitedEarly())
      .mockResolvedValueOnce(undefined);
    const backend = await launcher.startManagedBackend({}, {
      spawn, portFinder: async () => ports.shift(), ready, killTree: vi.fn(),
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(backend.base).toBe("http://127.0.0.1:4002");
  });

  it("does not retry a failure that a new port cannot fix", async () => {
    const spawn = vi.fn(() => fakeChild());
    const ready = vi.fn().mockRejectedValue(new launcher.BackendStartError("pas répondu à temps"));
    await expect(launcher.startManagedBackend({}, {
      spawn, portFinder: async () => 1, ready, killTree: vi.fn(),
    })).rejects.toThrow(/pas répondu/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("gives up after three attempts", async () => {
    const spawn = vi.fn(() => fakeChild());
    await expect(launcher.startManagedBackend({}, {
      spawn, portFinder: async () => 1, ready: async () => exitedEarly(), killTree: vi.fn(),
    })).rejects.toThrow(/arrêté/);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it("hands the stop function out before the service is ready, so quitting mid-startup can stop it", async () => {
    const child = fakeChild();
    const killTree = vi.fn();
    let stop: (() => void) | undefined;
    let release: () => void = () => undefined;
    const ready = () => new Promise<void>((resolve) => { release = resolve; });
    const pending = launcher.startManagedBackend({}, {
      spawn: () => child, portFinder: async () => 1, ready, killTree, onSpawn: (fn: () => void) => { stop = fn; },
    });
    await vi.waitFor(() => expect(stop).toBeTypeOf("function"));
    stop?.();
    expect(killTree).toHaveBeenCalledWith(child);
    release();
    await pending;
  });

  it("stops immediately and does not retry when the app is already quitting", async () => {
    const spawn = vi.fn(() => fakeChild());
    const killTree = vi.fn();
    await expect(launcher.startManagedBackend({}, {
      spawn, portFinder: async () => 1, ready: async () => exitedEarly(), killTree, isCancelled: () => true,
    })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports an unexpected exit after a successful start, but not a requested stop", async () => {
    const child = fakeChild();
    const onUnexpectedExit = vi.fn();
    const backend = await launcher.startManagedBackend({}, {
      spawn: () => child, portFinder: async () => 1, ready: async () => undefined, killTree: vi.fn(), onUnexpectedExit,
    });
    child.emit("exit", 1);
    expect(onUnexpectedExit).toHaveBeenCalledOnce();

    const second = fakeChild();
    const onSecond = vi.fn();
    const requested = await launcher.startManagedBackend({}, {
      spawn: () => second, portFinder: async () => 1, ready: async () => undefined, killTree: vi.fn(), onUnexpectedExit: onSecond,
    });
    requested.stop();
    second.emit("exit", 0);
    expect(onSecond).not.toHaveBeenCalled();
    expect(backend.base).toContain("127.0.0.1");
  });
});

describe("redact", () => {
  it("removes the secret and bounds the length of text shown to the user", () => {
    const token = "s3cr3t-token";
    const shown = launcher.redact(`boom ${token} ${"x".repeat(1000)}`, token);
    expect(shown).not.toContain(token);
    expect(shown).toContain("***");
    expect(shown.length).toBeLessThanOrEqual(300);
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
