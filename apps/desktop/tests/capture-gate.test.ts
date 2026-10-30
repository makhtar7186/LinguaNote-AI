import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { createArmGate, DEFAULT_TTL_MS } = createRequire(import.meta.url)("../electron/capture-gate.cjs");

function gateWithClock(ttlMs?: number) {
  const clock = { now: 1_000 };
  return { clock, gate: createArmGate({ now: () => clock.now, ttlMs }) };
}

describe("system audio arm gate", () => {
  it("denies by default: nothing was armed", () => {
    const { gate } = gateWithClock();
    expect(gate.isArmed).toBe(false);
    expect(gate.consume(1)).toBe(false);
  });

  it("grants exactly one request after being armed, for the window that armed it", () => {
    const { gate } = gateWithClock();
    gate.arm(7);
    expect(gate.isArmed).toBe(true);
    expect(gate.consume(7)).toBe(true);
    expect(gate.consume(7)).toBe(false); // one-shot: a second request needs a new, explicit arm
    expect(gate.isArmed).toBe(false);
  });

  it("refuses another window and keeps the pending arm for its rightful owner", () => {
    const { gate } = gateWithClock();
    gate.arm(7);
    expect(gate.consume(8)).toBe(false);
    expect(gate.isArmed).toBe(true);
    expect(gate.consume(7)).toBe(true);
  });

  it("expires: a stale arm cannot be used later, and is consumed by the attempt", () => {
    const { clock, gate } = gateWithClock(5_000);
    gate.arm(7);
    clock.now += 5_001;
    expect(gate.isArmed).toBe(false);
    expect(gate.consume(7)).toBe(false);
    clock.now = 1_000; // even going back in time cannot revive it
    expect(gate.consume(7)).toBe(false);
  });

  it("is still valid exactly at the end of the window", () => {
    const { clock, gate } = gateWithClock(5_000);
    gate.arm(7);
    clock.now += 5_000;
    expect(gate.consume(7)).toBe(true);
  });

  it("a new arm replaces the previous one, even for another window", () => {
    const { gate } = gateWithClock();
    gate.arm(7);
    gate.arm(8);
    expect(gate.consume(7)).toBe(false);
    expect(gate.consume(8)).toBe(true);
  });

  it("can be disarmed when the request never reached the handler", () => {
    const { gate } = gateWithClock();
    gate.arm(7);
    gate.disarm();
    expect(gate.consume(7)).toBe(false);
  });

  it("uses a short default window", () => {
    expect(DEFAULT_TTL_MS).toBeLessThanOrEqual(10_000);
  });
});
