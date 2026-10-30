import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const shortcuts = createRequire(import.meta.url)("../electron/shortcuts.cjs");

function fakeGlobalShortcut(taken: string[] = [], throwing: string[] = []) {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    register: vi.fn((accelerator: string, handler: () => void) => {
      if (throwing.includes(accelerator)) throw new Error("Invalid accelerator");
      if (taken.includes(accelerator)) return false;
      handlers.set(accelerator, handler);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => { handlers.delete(accelerator); }),
  };
}

describe("resolveAccelerators", () => {
  it("uses the documented defaults", () => {
    expect(shortcuts.resolveAccelerators({})).toEqual({
      toggleLive: "CommandOrControl+Alt+Space", pauseLive: "CommandOrControl+Alt+P", toggleBubble: "CommandOrControl+Alt+B",
    });
  });

  it("lets the environment override one shortcut or disable it with an empty value", () => {
    const resolved = shortcuts.resolveAccelerators({
      LINGUANOTE_SHORTCUT_TOGGLE_LIVE: " Control+Shift+L ", LINGUANOTE_SHORTCUT_PAUSE_LIVE: "",
    });
    expect(resolved).toMatchObject({ toggleLive: "Control+Shift+L", pauseLive: "", toggleBubble: "CommandOrControl+Alt+B" });
  });
});

describe("registerShortcuts", () => {
  const bindings = (handler = vi.fn()) => ({
    toggleLive: { accelerator: "A", handler },
    pauseLive: { accelerator: "B", handler },
    toggleBubble: { accelerator: "C", handler },
  });

  it("registers every free shortcut", () => {
    const globalShortcut = fakeGlobalShortcut();
    const report = shortcuts.registerShortcuts(globalShortcut, bindings());
    expect(report.registered.map((r: { name: string }) => r.name)).toEqual(["toggleLive", "pauseLive", "toggleBubble"]);
    expect(report.failed).toEqual([]);
  });

  it("reports a shortcut taken by another application, an invalid one, and a disabled one", () => {
    const globalShortcut = fakeGlobalShortcut(["A"], ["B"]);
    const report = shortcuts.registerShortcuts(globalShortcut, {
      ...bindings(), toggleBubble: { accelerator: "", handler: vi.fn() },
    });
    expect(report.registered).toEqual([]);
    expect(report.failed).toEqual([
      { name: "toggleLive", accelerator: "A", reason: "already_in_use_or_invalid" },
      { name: "pauseLive", accelerator: "B", reason: "Invalid accelerator" },
      { name: "toggleBubble", accelerator: "", reason: "disabled" },
    ]);
  });

  it("still registers the others when one fails", () => {
    const report = shortcuts.registerShortcuts(fakeGlobalShortcut(["A"]), bindings());
    expect(report.registered.map((r: { name: string }) => r.name)).toEqual(["pauseLive", "toggleBubble"]);
  });

  it("runs the handler once when the key is held down, and again after the guard delay", () => {
    let now = 1_000;
    const handler = vi.fn();
    const globalShortcut = fakeGlobalShortcut();
    shortcuts.registerShortcuts(globalShortcut, { toggleLive: { accelerator: "A", handler } }, () => now);
    const fire = globalShortcut.handlers.get("A")!;
    fire(); now += 50; fire(); now += 50; fire(); // key repeat
    expect(handler).toHaveBeenCalledTimes(1);
    now += shortcuts.REPEAT_GUARD_MS;
    fire();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("contains a throwing handler", () => {
    const globalShortcut = fakeGlobalShortcut();
    shortcuts.registerShortcuts(globalShortcut, {
      toggleLive: { accelerator: "A", handler: () => { throw new Error("boom"); } },
    });
    expect(() => globalShortcut.handlers.get("A")!()).not.toThrow();
  });

  it("releases only what was registered", () => {
    const globalShortcut = fakeGlobalShortcut(["A"]);
    const report = shortcuts.registerShortcuts(globalShortcut, bindings());
    shortcuts.unregisterShortcuts(globalShortcut, report.registered);
    expect(globalShortcut.unregister.mock.calls.map(([accelerator]) => accelerator)).toEqual(["B", "C"]);
  });
});
