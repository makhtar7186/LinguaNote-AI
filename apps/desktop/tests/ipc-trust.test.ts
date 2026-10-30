import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { isTrustedSender, createOwnership, watchOwner } = createRequire(import.meta.url)("../electron/ipc-trust.cjs");

const policy = { isAppUrl: (url: string) => url === "app://index" || url === "app://bubble" };
const frame = (url: string, processId = 1, routingId = 1) => ({ url, processId, routingId });

function windowWith(mainFrame: ReturnType<typeof frame> | undefined) {
  return { mainFrame };
}

describe("isTrustedSender", () => {
  it("trusts the main frame of one of our windows showing one of our pages", () => {
    const main = frame("app://index");
    const sender = windowWith(main);
    expect(isTrustedSender({ sender, senderFrame: main }, [sender], policy)).toBe(true);
  });

  it("trusts a re-created wrapper of the same frame (same process and routing id)", () => {
    const sender = windowWith(frame("app://bubble", 7, 3));
    expect(isTrustedSender({ sender, senderFrame: frame("app://bubble", 7, 3) }, [sender], policy)).toBe(true);
  });

  it("never trusts an iframe, even one that loads an allowed page", () => {
    const sender = windowWith(frame("app://index", 1, 1));
    const iframe = frame("app://index", 1, 42); // a child frame of the same window
    expect(isTrustedSender({ sender, senderFrame: iframe }, [sender], policy)).toBe(false);
    const crossProcess = frame("app://index", 9, 1);
    expect(isTrustedSender({ sender, senderFrame: crossProcess }, [sender], policy)).toBe(false);
  });

  it("does not trust a window that is not ours", () => {
    const ours = windowWith(frame("app://index"));
    const stranger = windowWith(frame("app://index"));
    expect(isTrustedSender({ sender: stranger, senderFrame: stranger.mainFrame }, [ours], policy)).toBe(false);
  });

  it("does not trust a page that is not one of ours (navigated away)", () => {
    const sender = windowWith(frame("https://evil.example"));
    expect(isTrustedSender({ sender, senderFrame: sender.mainFrame }, [sender], policy)).toBe(false);
  });

  it.each([
    [undefined], [null], [{}], [{ sender: windowWith(undefined), senderFrame: frame("app://index") }],
  ])("fails closed on a malformed event %j", (event) => {
    expect(isTrustedSender(event, [], policy)).toBe(false);
  });

  it("fails closed when the frame is gone (null senderFrame) or has no main frame", () => {
    const sender = windowWith(frame("app://index"));
    expect(isTrustedSender({ sender, senderFrame: null }, [sender], policy)).toBe(false);
    const orphan = windowWith(undefined);
    expect(isTrustedSender({ sender: orphan, senderFrame: frame("app://index") }, [orphan], policy)).toBe(false);
  });
});

describe("createOwnership", () => {
  it("lets only the window that started the session feed audio", () => {
    const ownership = createOwnership();
    expect(ownership.isOwner(1)).toBe(false); // nobody owns anything yet
    ownership.claim(1);
    expect(ownership.isOwner(1)).toBe(true);
    expect(ownership.isOwner(2)).toBe(false);
    ownership.release();
    expect(ownership.isOwner(1)).toBe(false);
  });

  it("does not treat a missing id as the owner", () => {
    const ownership = createOwnership();
    ownership.claim(5);
    expect(ownership.isOwner(undefined)).toBe(false);
    expect(ownership.isOwner(null)).toBe(false);
  });
});

describe("watchOwner", () => {
  const windowWithId = (id: number) => Object.assign(new EventEmitter(), { id });

  it("ends the session once, and releases ownership, when the owning window is destroyed", () => {
    const ownership = createOwnership();
    const owner = windowWithId(3);
    const onGone = vi.fn();
    watchOwner(ownership, owner, onGone);
    expect(ownership.isOwner(3)).toBe(true);

    owner.emit("destroyed");
    owner.emit("render-process-gone"); // both can fire for one window
    expect(onGone).toHaveBeenCalledOnce();
    expect(ownership.isOwner(3)).toBe(false);
  });

  it("also ends it when the renderer process crashes while the window object survives", () => {
    const ownership = createOwnership();
    const owner = windowWithId(3);
    const onGone = vi.fn();
    watchOwner(ownership, owner, onGone);
    owner.emit("render-process-gone");
    expect(onGone).toHaveBeenCalledOnce();
  });

  it("does not stop a session that another window owns now", () => {
    const ownership = createOwnership();
    const first = windowWithId(1);
    const second = windowWithId(2);
    const onGone = vi.fn();
    watchOwner(ownership, first, onGone);
    watchOwner(ownership, second, onGone); // the second window started the next session
    first.emit("destroyed"); // the first window going away is now irrelevant
    expect(onGone).not.toHaveBeenCalled();
    expect(ownership.isOwner(2)).toBe(true);
  });

  it("removes its listeners on dispose so they do not pile up session after session", () => {
    const ownership = createOwnership();
    const owner = windowWithId(4);
    for (let session = 0; session < 25; session += 1) watchOwner(ownership, owner, vi.fn())();
    expect(owner.listenerCount("destroyed")).toBe(0);
    expect(owner.listenerCount("render-process-gone")).toBe(0);
  });

  it("survives a window that refuses to remove listeners after being destroyed", () => {
    const owner = Object.assign(new EventEmitter(), { id: 5 });
    const dispose = watchOwner(createOwnership(), owner, vi.fn());
    owner.removeListener = () => { throw new Error("Object has been destroyed"); };
    expect(() => dispose()).not.toThrow();
  });
});
