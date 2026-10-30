import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { createCapturePlan, DEFAULT_TTL_MS, usesSystemAudio } = createRequire(import.meta.url)("../electron/capture-plan.cjs");

function planWithClock() {
  const clock = { now: 1_000 };
  return { clock, plan: createCapturePlan({ now: () => clock.now }) };
}

describe("capture plan", () => {
  it("allows nothing by default: system audio cannot be armed without a declaration", () => {
    const { plan } = planWithClock();
    expect(plan.allowsSystemAudio(1)).toBe(false);
    expect(plan.allowsSystemAudio(1, { ownerId: null, source: null })).toBe(false);
  });

  it.each(["system", "both"])("allows system audio for the window that declared %s", (source) => {
    const { plan } = planWithClock();
    expect(plan.declare(1, source)).toBe(true);
    expect(plan.allowsSystemAudio(1)).toBe(true);
  });

  it("does not allow system audio for a microphone-only plan", () => {
    const { plan } = planWithClock();
    plan.declare(1, "microphone");
    expect(plan.allowsSystemAudio(1)).toBe(false);
  });

  it("refuses an unknown source instead of defaulting to one, and keeps nothing", () => {
    const { plan } = planWithClock();
    for (const bad of ["cloud", "", undefined, null, 3, "System"]) expect(plan.declare(1, bad)).toBe(false);
    expect(plan.current).toBeNull();
    expect(plan.allowsSystemAudio(1)).toBe(false);
  });

  it("belongs to the window that declared it", () => {
    const { plan } = planWithClock();
    plan.declare(1, "system");
    expect(plan.allowsSystemAudio(2)).toBe(false);
  });

  it("expires", () => {
    const { clock, plan } = planWithClock();
    plan.declare(1, "system");
    clock.now += DEFAULT_TTL_MS;
    expect(plan.allowsSystemAudio(1)).toBe(true); // still valid at the very end of the window
    clock.now += 1;
    expect(plan.allowsSystemAudio(1)).toBe(false);
  });

  it("a new declaration replaces the previous one", () => {
    const { plan } = planWithClock();
    plan.declare(1, "system");
    plan.declare(2, "microphone");
    expect(plan.allowsSystemAudio(1)).toBe(false);
    expect(plan.allowsSystemAudio(2)).toBe(false);
  });

  it("is spent by clear()", () => {
    const { plan } = planWithClock();
    plan.declare(1, "system");
    plan.clear();
    expect(plan.allowsSystemAudio(1)).toBe(false);
  });

  it("lets the owner of a running system-audio session re-acquire it (resume after a pause), and nobody else", () => {
    const { plan } = planWithClock();
    expect(plan.allowsSystemAudio(1, { ownerId: 1, source: "both" })).toBe(true);
    expect(plan.allowsSystemAudio(1, { ownerId: 1, source: "system" })).toBe(true);
    expect(plan.allowsSystemAudio(2, { ownerId: 1, source: "system" })).toBe(false); // another window
    expect(plan.allowsSystemAudio(1, { ownerId: 1, source: "microphone" })).toBe(false); // a session that never used it
  });

  it("knows which sources use the computer sound", () => {
    expect([usesSystemAudio("microphone"), usesSystemAudio("system"), usesSystemAudio("both")]).toEqual([false, true, true]);
  });
});
