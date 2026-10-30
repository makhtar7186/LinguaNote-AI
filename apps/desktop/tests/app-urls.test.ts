import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const { createUrlPolicy } = require_("../electron/app-urls.cjs");
const { createPositionStore } = require_("../electron/position-store.cjs");

const distDir = path.resolve("C:/app/dist");
const fileUrl = (name: string) => pathToFileURL(path.join(distDir, name)).href;

describe("url policy (built pages)", () => {
  const policy = createUrlPolicy({ useDist: true, devUrl: "http://127.0.0.1:5173", distDir });

  it("trusts exactly the two built pages, ignoring query and fragment", () => {
    expect(policy.isAppUrl(fileUrl("index.html"))).toBe(true);
    expect(policy.isAppUrl(`${fileUrl("bubble.html")}#top`)).toBe(true);
    expect(policy.isAppUrl(`${fileUrl("index.html")}?x=1`)).toBe(true);
  });

  it.each([
    "file:///C:/app/dist/evil.html", "file:///C:/other/index.html", "http://127.0.0.1:5173/", "https://example.org",
    "javascript:alert(1)", "", undefined, null, 42,
  ])("does not trust %j", (url) => {
    expect(policy.isAppUrl(url as string)).toBe(false);
  });

  it("targets files on disk and refuses unknown pages", () => {
    expect(policy.target("main")).toBe(path.join(distDir, "index.html"));
    expect(policy.target("bubble")).toBe(path.join(distDir, "bubble.html"));
    expect(() => policy.target("admin")).toThrow(RangeError);
  });
});

describe("url policy (dev server)", () => {
  const policy = createUrlPolicy({ useDist: false, devUrl: "http://127.0.0.1:5173", distDir });

  it("trusts the dev pages only", () => {
    expect(policy.isAppUrl("http://127.0.0.1:5173/")).toBe(true);
    expect(policy.isAppUrl("http://127.0.0.1:5173/bubble.html")).toBe(true);
    expect(policy.isAppUrl("http://127.0.0.1:5173/other.html")).toBe(false);
    expect(policy.isAppUrl("http://127.0.0.1:5174/")).toBe(false);
    expect(policy.isAppUrl("http://localhost:5173/")).toBe(false);
    expect(policy.isAppUrl("http://127.0.0.1:5173.evil.example/")).toBe(false);
  });

  it("targets dev server URLs", () => {
    expect(policy.target("main")).toBe("http://127.0.0.1:5173/");
    expect(policy.target("bubble")).toBe("http://127.0.0.1:5173/bubble.html");
  });
});

describe("position store", () => {
  const file = path.join("C:/data", "bubble-position.json");

  it("round-trips a position through the file system", () => {
    const files = new Map<string, string>();
    const fs = {
      readFileSync: (f: string) => { if (!files.has(f)) throw new Error("ENOENT"); return files.get(f); },
      writeFileSync: (f: string, content: string) => { files.set(f, content); },
      mkdirSync: vi.fn(),
    };
    const store = createPositionStore(fs, file);
    expect(store.load()).toBeNull();
    expect(store.save({ x: 10.6, y: 20.2 })).toBe(true);
    expect(store.load()).toEqual({ x: 11, y: 20 });
    expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(file), { recursive: true });
  });

  it("ignores a corrupted file and survives a failing disk", () => {
    const corrupted = createPositionStore({ readFileSync: () => "{broken", writeFileSync: vi.fn(), mkdirSync: vi.fn() }, file);
    expect(corrupted.load()).toBeNull();
    const failing = createPositionStore({
      readFileSync: () => { throw new Error("denied"); },
      writeFileSync: () => { throw new Error("disk full"); },
      mkdirSync: vi.fn(),
    }, file);
    expect(failing.load()).toBeNull();
    expect(failing.save({ x: 1, y: 2 })).toBe(false); // no exception: dictation is never disturbed
  });
});
