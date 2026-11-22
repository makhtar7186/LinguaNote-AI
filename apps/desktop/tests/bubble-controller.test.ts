import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const { createBubbleController, SAVE_DELAY_MS } = require_("../electron/bubble-controller.cjs");

interface Bounds { x: number; y: number; width: number; height: number }

class FakeWindow {
  static last: FakeWindow;
  options: Record<string, unknown>;
  bounds: Bounds;
  visible = false;
  destroyed = false;
  alwaysOnTop: unknown[] = [];
  handlers = new Map<string, () => void>();
  webContents = { setWindowOpenHandler: vi.fn() };

  constructor(options: Bounds & Record<string, unknown>) {
    this.options = options;
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    FakeWindow.last = this;
  }

  setAlwaysOnTop(...args: unknown[]) { this.alwaysOnTop = args; }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds: Bounds) { this.bounds = { ...bounds }; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  once(event: string, handler: () => void) { this.handlers.set(event, handler); }
  on(event: string, handler: () => void) { this.handlers.set(event, handler); }
  emit(event: string) { this.handlers.get(event)?.(); }
}

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const screen = { getAllDisplays: () => [primary], getPrimaryDisplay: () => primary };

function build(
  saved: { x: number; y: number } | null = null, visibleOnStart = true,
  extra: { shouldStayVisible?: () => boolean; onClosed?: () => void } = {},
) {
  const positionStore = { load: vi.fn().mockReturnValue(saved), save: vi.fn() };
  const loadPage = vi.fn();
  const controller = createBubbleController({
    BrowserWindow: FakeWindow, screen, positionStore, preload: "/preload.cjs", loadPage, visibleOnStart, ...extra,
  });
  return { controller, positionStore, loadPage };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("bubble window creation", () => {
  it("is a small always-on-top frameless window that never takes the keyboard focus", () => {
    const { controller, loadPage } = build();
    controller.create();
    const { options, alwaysOnTop } = FakeWindow.last;
    expect(options).toMatchObject({
      frame: false, transparent: true, alwaysOnTop: true, focusable: false, skipTaskbar: true,
      resizable: false, show: false, width: 72, height: 72,
    });
    expect(alwaysOnTop).toEqual([true, "screen-saver"]);
    expect(loadPage).toHaveBeenCalledWith(FakeWindow.last);
  });

  it("keeps the renderer isolated like the main window", () => {
    build().controller.create();
    expect(FakeWindow.last.options.webPreferences).toEqual({
      preload: "/preload.cjs", contextIsolation: true, nodeIntegration: false, sandbox: true,
    });
    expect(FakeWindow.last.webContents.setWindowOpenHandler).toHaveBeenCalled();
  });

  it("appears bottom-right on first run, and where it was left afterwards", () => {
    build(null).controller.create();
    expect(FakeWindow.last.bounds).toMatchObject({ x: 1920 - 72 - 16, y: 1040 - 72 - 16 });
    build({ x: 300, y: 200 }).controller.create();
    expect(FakeWindow.last.bounds).toMatchObject({ x: 300, y: 200 });
  });

  it("does not strand the bubble off screen when the saved position is on a removed monitor", () => {
    build({ x: 5000, y: -400 }).controller.create();
    const { x, y, width, height } = FakeWindow.last.bounds;
    expect(x + width).toBeLessThanOrEqual(1920);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y + height).toBeLessThanOrEqual(1040);
  });

  it("shows itself without activating once ready, but not when told to stay hidden", () => {
    build().controller.create();
    FakeWindow.last.emit("ready-to-show");
    expect(FakeWindow.last.visible).toBe(true);
    build(null, false).controller.create();
    FakeWindow.last.emit("ready-to-show");
    expect(FakeWindow.last.visible).toBe(false);
  });

  it("creates only one window", () => {
    const { controller } = build();
    const first = controller.create();
    expect(controller.create()).toBe(first);
  });
});

describe("expanding, showing and remembering the position", () => {
  it("expands up and left from the corner and collapses back to the same place", () => {
    const { controller } = build();
    controller.create();
    const start = FakeWindow.last.getBounds();
    expect(controller.setExpanded(true)).toBe(true);
    expect(FakeWindow.last.bounds).toMatchObject({ width: 340, height: 480 });
    expect(FakeWindow.last.bounds.x + 340).toBe(start.x + 72);
    expect(controller.isExpanded()).toBe(true);
    controller.setExpanded(false);
    expect(FakeWindow.last.bounds).toEqual(start);
    expect(controller.isExpanded()).toBe(false);
  });

  it("shows and hides without activating", () => {
    const { controller } = build();
    controller.create();
    expect(controller.setVisible(true)).toBe(true);
    expect(controller.isVisible()).toBe(true);
    expect(controller.setVisible(false)).toBe(false);
  });

  it("saves the position once the user stops dragging, not on every move event", () => {
    const { controller, positionStore } = build();
    controller.create();
    for (let i = 0; i < 20; i += 1) {
      FakeWindow.last.bounds = { ...FakeWindow.last.bounds, x: 100 + i };
      FakeWindow.last.emit("moved");
      vi.advanceTimersByTime(50);
    }
    expect(positionStore.save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(positionStore.save).toHaveBeenCalledTimes(1);
    expect(positionStore.save).toHaveBeenCalledWith({ x: 119, y: FakeWindow.last.bounds.y });
  });

  it("does nothing once the window is gone", () => {
    const { controller, positionStore } = build();
    controller.create();
    FakeWindow.last.emit("moved");
    FakeWindow.last.emit("closed");
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
    expect(positionStore.save).not.toHaveBeenCalled();
    expect(controller.window).toBeNull();
    expect(controller.setExpanded(true)).toBe(false);
    expect(controller.setVisible(true)).toBe(false);
    expect(controller.isVisible()).toBe(false);
  });

  it("destroys the window", () => {
    const { controller } = build();
    controller.create();
    const window = FakeWindow.last;
    controller.destroy();
    expect(window.destroyed).toBe(true);
    expect(controller.window).toBeNull();
  });
});

describe("the bubble is the recording indicator", () => {
  it("is shown again at once if something hides it while the microphone is in use", () => {
    let recording = true;
    const { controller } = build(null, true, { shouldStayVisible: () => recording });
    controller.create();
    FakeWindow.last.showInactive();
    FakeWindow.last.hide(); // not through setVisible: the OS, another tool...
    FakeWindow.last.emit("hide");
    expect(FakeWindow.last.visible).toBe(true);

    recording = false; // nothing recording any more: hiding is just hiding
    FakeWindow.last.hide();
    FakeWindow.last.emit("hide");
    expect(FakeWindow.last.visible).toBe(false);
  });

  it("does not fight its own, deliberate hide", () => {
    const { controller } = build(null, true, { shouldStayVisible: () => true });
    controller.create();
    FakeWindow.last.showInactive();
    const originalHide = FakeWindow.last.hide.bind(FakeWindow.last);
    FakeWindow.last.hide = () => { originalHide(); FakeWindow.last.emit("hide"); }; // Electron emits "hide" synchronously
    expect(controller.setVisible(false)).toBe(false); // the caller (main process) decides if that is allowed
    expect(FakeWindow.last.visible).toBe(false);
  });

  it("tells the main process when the window disappears by itself, but not when it destroys it", () => {
    const onClosed = vi.fn();
    const { controller } = build(null, true, { onClosed });
    controller.create();
    FakeWindow.last.emit("closed"); // closed by the user/OS
    expect(onClosed).toHaveBeenCalledOnce();

    controller.create(); // recreated
    controller.destroy(); // our own shutdown
    FakeWindow.last.emit("closed");
    expect(onClosed).toHaveBeenCalledOnce();
  });
});
