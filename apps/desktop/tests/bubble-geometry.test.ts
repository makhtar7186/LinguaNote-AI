import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const geometry = createRequire(import.meta.url)("../electron/bubble-geometry.cjs");
const screen = { x: 0, y: 0, width: 1920, height: 1040 }; // a work area (taskbar excluded)
const second = { x: 1920, y: 0, width: 1280, height: 1024 };

describe("clampToWorkArea", () => {
  it("keeps a window that is already inside untouched", () => {
    expect(geometry.clampToWorkArea({ x: 100, y: 100, width: 72, height: 72 }, screen))
      .toEqual({ x: 100, y: 100, width: 72, height: 72 });
  });

  it.each([
    [{ x: -50, y: 10 }, { x: 0, y: 10 }],
    [{ x: 10, y: -80 }, { x: 10, y: 0 }],
    [{ x: 1900, y: 10 }, { x: 1848, y: 10 }],
    [{ x: 10, y: 1500 }, { x: 10, y: 968 }],
    [{ x: 5000, y: 5000 }, { x: 1848, y: 968 }],
  ])("pulls %j back on screen", (position, expected) => {
    expect(geometry.clampToWorkArea({ ...position, width: 72, height: 72 }, screen)).toMatchObject(expected);
  });

  it("anchors a window larger than the area at its top-left instead of producing negative space", () => {
    expect(geometry.clampToWorkArea({ x: 500, y: 500, width: 4000, height: 3000 }, screen)).toMatchObject({ x: 0, y: 0 });
  });
});

describe("defaultBounds", () => {
  it("puts the bubble in the bottom-right corner, away from the edges", () => {
    expect(geometry.defaultBounds(screen)).toEqual({ x: 1920 - 72 - 16, y: 1040 - 72 - 16, width: 72, height: 72 });
  });
});

describe("pickWorkArea", () => {
  const displays = [{ workArea: screen }, { workArea: second }];

  it("uses the screen that contains the centre of the window", () => {
    expect(geometry.pickWorkArea({ x: 2000, y: 100, width: 72, height: 72 }, displays, displays[0])).toBe(second);
  });

  it("falls back to the primary screen when the saved screen is gone", () => {
    expect(geometry.pickWorkArea({ x: 6000, y: 100, width: 72, height: 72 }, displays, displays[0])).toBe(screen);
  });
});

describe("resizeAnchored", () => {
  it("grows up and to the left when the bubble sits in the bottom-right corner", () => {
    const collapsed = geometry.defaultBounds(screen);
    const expanded = geometry.resizeAnchored(collapsed, geometry.EXPANDED, screen);
    expect(expanded.x + expanded.width).toBe(collapsed.x + collapsed.width); // right edge fixed
    expect(expanded.y + expanded.height).toBe(collapsed.y + collapsed.height); // bottom edge fixed
    expect(expanded).toMatchObject(geometry.EXPANDED);
  });

  it("grows down and to the right from the top-left", () => {
    const expanded = geometry.resizeAnchored({ x: 20, y: 20, width: 72, height: 72 }, geometry.EXPANDED, screen);
    expect(expanded).toMatchObject({ x: 20, y: 20, width: 340, height: 300 });
  });

  it("returns exactly to the original place after collapsing", () => {
    const start = { x: 1500, y: 700, width: 72, height: 72 };
    const expanded = geometry.resizeAnchored(start, geometry.EXPANDED, screen);
    expect(geometry.resizeAnchored(expanded, geometry.COLLAPSED, screen)).toEqual(start);
  });

  it("never leaves the screen, even when expanding near an edge", () => {
    const expanded = geometry.resizeAnchored({ x: 1840, y: 960, width: 72, height: 72 }, geometry.EXPANDED, screen);
    expect(expanded.x).toBeGreaterThanOrEqual(0);
    expect(expanded.y).toBeGreaterThanOrEqual(0);
    expect(expanded.x + expanded.width).toBeLessThanOrEqual(1920);
    expect(expanded.y + expanded.height).toBeLessThanOrEqual(1040);
  });

  it("works on a second monitor with an offset origin", () => {
    const bounds = { x: 2000, y: 100, width: 72, height: 72 };
    const expanded = geometry.resizeAnchored(bounds, geometry.EXPANDED, second);
    expect(expanded.x).toBeGreaterThanOrEqual(second.x);
    expect(expanded.x + expanded.width).toBeLessThanOrEqual(second.x + second.width);
  });
});

describe("parseSavedPosition", () => {
  it("accepts a plain position, from text or an object", () => {
    expect(geometry.parseSavedPosition('{"x": 10.4, "y": 20}')).toEqual({ x: 10, y: 20 });
    expect(geometry.parseSavedPosition({ x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
  });

  it.each([null, undefined, "", "not json", "[]", '{"x":"1","y":2}', '{"x":1}', { x: Number.NaN, y: 1 }, { x: Infinity, y: 1 }])(
    "rejects %j", (raw) => {
      expect(geometry.parseSavedPosition(raw)).toBeNull();
    },
  );
});
