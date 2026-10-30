import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { createElectronClipboardPort, classify } = createRequire(import.meta.url)("../electron/electron-clipboard.cjs");

const RAW = (name: string) => `electron application/osclipboard;format="${name}"`;

class FakeItem {
  types: string[];
  data: Record<string, string>;
  constructor(data: Record<string, string>) { this.data = data; this.types = Object.keys(data); }
  async getType(type: string) {
    if (!(type in this.data)) throw new Error("absent");
    return { text: async () => this.data[type] };
  }
}

function fakeElectron(initial: Record<string, string> | null) {
  const state = { current: initial, cleared: 0, written: [] as Record<string, string>[] };
  const clipboard = {
    read: async () => (state.current ? [new FakeItem(state.current)] : []),
    clear: () => { state.current = null; state.cleared += 1; },
    write: async (items: FakeItem[]) => { state.current = items[0].data; state.written.push(state.current); },
    writeText: async (text: string) => { state.current = { "text/plain": text }; },
    readText: async () => state.current?.["text/plain"] ?? "",
  };
  return { state, port: createElectronClipboardPort({ clipboard, ClipboardItem: FakeItem }) };
}

describe("classifying clipboard formats", () => {
  it("accepts portable text, with or without application internals", () => {
    expect(classify(["text/plain"])).toEqual({ restorable: true, portable: ["text/plain"] });
    expect(classify(["text/plain", "text/html", RAW("DataObject"), RAW("Ole Private Data")]))
      .toMatchObject({ restorable: true, portable: ["text/plain", "text/html"] });
    expect(classify([])).toMatchObject({ restorable: true });
  });

  it("refuses real content that cannot be put back", () => {
    for (const types of [
      ["image/png"], ["text/plain", "image/png"], ["application/x-weird"],
      ["text/plain", RAW("FileNameW")], ["text/plain", RAW("Shell IDList Array")], ["text/plain", RAW("CF_HDROP")],
      ["text/plain", RAW("Bitmap")], ["text/plain", RAW("DIBV5")],
    ]) expect(classify(types).restorable, types.join(",")).toBe(false);
  });

  it("refuses a clipboard that holds only internal entries (no text to put back)", () => {
    expect(classify([RAW("DataObject")]).restorable).toBe(false);
  });
});

describe("snapshot and restore", () => {
  it("round-trips text and html and drops the application internals", async () => {
    const { state, port } = fakeElectron({ "text/plain": "Jërëjëf", "text/html": "<i>Jërëjëf</i>", [RAW("DataObject")]: "x" });
    const snapshot = await port.snapshot();
    expect(snapshot).toEqual({ empty: false, parts: { "text/plain": "Jërëjëf", "text/html": "<i>Jërëjëf</i>" } });
    await port.writeText("autre chose");
    await port.restore(snapshot);
    expect(state.current).toEqual({ "text/plain": "Jërëjëf", "text/html": "<i>Jërëjëf</i>" });
  });

  it("restores an empty clipboard by clearing it", async () => {
    const { state, port } = fakeElectron(null);
    const snapshot = await port.snapshot();
    expect(snapshot).toEqual({ empty: true });
    await port.writeText("temporaire");
    await port.restore(snapshot);
    expect(state.cleared).toBe(1);
    expect(state.current).toBeNull();
  });

  it("returns null for an image and never writes anything", async () => {
    const { state, port } = fakeElectron({ "image/png": "…" });
    expect(await port.snapshot()).toBeNull();
    expect(state.written).toEqual([]);
  });
});
