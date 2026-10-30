import { describe, expect, it } from "vitest";
import { parseLiveEvent } from "../src/services/liveEvents";
import { initialLiveState, type LiveAction, liveReducer, MAX_NOTICES, transcriptText } from "../src/services/liveReducer";
import { FrameBuffer, floatToInt16, Resampler } from "../src/services/pcm";
import type { LiveState } from "../src/types";

const partial = (id: number, revision: number, text: string, eventId: number): LiveAction => ({
  type: "partial", event_id: eventId, utterance_id: id, revision, text, start_seconds: 0, end_seconds: 1,
});
const final = (id: number, text: string, eventId: number): LiveAction => ({
  type: "final", event_id: eventId, utterance_id: id, text, start_seconds: 0, end_seconds: 1,
  language: "fr", language_probability: 0.9,
});
const run = (actions: LiveAction[], from: LiveState = initialLiveState) => actions.reduce(liveReducer, from);

describe("liveReducer reconciliation", () => {
  it("replaces the provisional text of an utterance with higher revisions, never with older ones", () => {
    const state = run([partial(1, 1, "bonj", 1), partial(1, 2, "bonjour tout", 2), partial(1, 1, "stale", 3)]);
    expect(state.partial).toMatchObject({ utterance_id: 1, revision: 2, text: "bonjour tout" });
  });

  it("a final replaces its partial, and a late partial for it is ignored", () => {
    const state = run([partial(1, 1, "bonj", 1), final(1, "Bonjour tout le monde", 2), partial(1, 5, "late", 3)]);
    expect(state.partial).toBeNull();
    expect(state.finals.map((item) => item.text)).toEqual(["Bonjour tout le monde"]);
  });

  it("ignores replayed events, so a resume cannot duplicate text", () => {
    const events = [final(1, "un", 1), final(2, "deux", 2)];
    const state = run([...events, ...events, final(3, "trois", 3)]);
    expect(state.finals.map((item) => item.text)).toEqual(["un", "deux", "trois"]);
    expect(state.lastEventId).toBe(3);
  });

  it("keeps finals ordered by utterance even if they arrive out of order, without duplicates", () => {
    const state = run([final(2, "deux", 2), final(1, "un", 3), { ...final(2, "deux bis", 4) }]);
    expect(state.finals.map((item) => `${item.utterance_id}:${item.text}`)).toEqual(["1:un", "2:deux bis"]);
  });

  it("a final of a later utterance clears an older unfinished partial", () => {
    const state = run([partial(1, 1, "abc", 1), final(2, "deux", 2)]);
    expect(state.partial).toBeNull();
  });

  it("ignores a partial older than the one on screen", () => {
    const state = run([partial(3, 1, "trois", 1), partial(2, 9, "deux", 2)]);
    expect(state.partial?.utterance_id).toBe(3);
  });

  it("drops an unfinished partial when the session ends and records why", () => {
    const state = run([partial(1, 1, "abc", 1), { type: "session_ended", event_id: 2, reason: "client_stop", utterances: 0 }]);
    expect(state).toMatchObject({ status: "ended", partial: null, endReason: "client_stop" });
  });

  it("shows transport state and keeps a server end authoritative over a trailing idle", () => {
    let state = run([{ type: "reset" }, { type: "client_state", state: "active" }]);
    expect(state.status).toBe("live");
    state = run([{ type: "client_state", state: "reconnecting" }], state);
    expect(state.status).toBe("reconnecting");
    state = run([{ type: "session_ended", event_id: 1, reason: "client_stop", utterances: 0 }, { type: "client_state", state: "idle" }], state);
    expect(state.status).toBe("ended");
  });

  it("tracks pause and clears it when the session leaves the live state", () => {
    let state = run([{ type: "reset" }, { type: "client_state", state: "active" }, { type: "pause_state", paused: true }]);
    expect(state.paused).toBe(true);
    state = run([{ type: "client_state", state: "reconnecting" }], state);
    expect(state.paused).toBe(true); // a pause survives a reconnection
    state = run([{ type: "pause_state", paused: false }, { type: "pause_state", paused: true },
      { type: "session_ended", event_id: 1, reason: "client_stop", utterances: 0 }], state);
    expect(state.paused).toBe(false);
  });

  it("starts a new session from a clean transcript in every window, not only the one that started it", () => {
    const previous = run([final(1, "ancien texte", 1), { type: "session_ended", event_id: 2, reason: "client_stop", utterances: 1 }]);
    expect(previous.finals).toHaveLength(1);
    const fresh = run([{ type: "client_state", state: "connecting" }], previous);
    expect(fresh).toMatchObject({ status: "connecting", finals: [], partial: null, lastEventId: 0, endReason: null });
    // ...but a "connecting" while a session is already running is a plain status change, not a reset.
    const running = run([final(1, "en cours", 1), { type: "client_state", state: "reconnecting" }]);
    expect(run([{ type: "client_state", state: "connecting" }], running).finals).toHaveLength(1);
  });

  it("records non-fatal notices without stopping and marks fatal errors as failed", () => {
    let state = run([{ type: "error", code: "inference_failed", message: "x", fatal: false, event_id: 1, utterance_id: 4 }]);
    expect(state.notices).toEqual([{ code: "inference_failed", message: "x", utterance_id: 4, fatal: false }]);
    expect(state.status).toBe("idle");
    state = run([{ type: "error", code: "busy", message: "y", fatal: true }], state);
    expect(state.status).toBe("failed");
  });

  it("bounds the number of notices", () => {
    const errors: LiveAction[] = Array.from({ length: MAX_NOTICES + 5 }, (_unused, index) => ({
      type: "error", code: `e${index}`, message: "", fatal: false, event_id: index + 1,
    }));
    expect(run(errors).notices).toHaveLength(MAX_NOTICES);
  });

  it("builds the displayed transcript from finals then the provisional text", () => {
    const state = run([final(1, "Bonjour", 1), final(2, "tout le monde", 2), partial(3, 1, "et mer", 3)]);
    expect(transcriptText(state)).toEqual({ final: "Bonjour tout le monde", provisional: "et mer" });
  });
});

describe("parseLiveEvent", () => {
  const goodFinal = {
    type: "final", event_id: 2, utterance_id: 1, text: "ok", start_seconds: 0, end_seconds: 1,
    language: "fr", language_probability: 0.5,
  };

  it("accepts well-formed events", () => {
    expect(parseLiveEvent(goodFinal)).toMatchObject({ type: "final", text: "ok" });
    expect(parseLiveEvent({ type: "client_state", state: "active" })).toEqual({ type: "client_state", state: "active" });
    expect(parseLiveEvent({ type: "session_started", resumed: true, engine: { name: "e", model: "m" } }))
      .toMatchObject({ resumed: true, engine: { name: "e", model: "m" } });
  });

  it("parses pause_state and rejects a non-boolean one", () => {
    expect(parseLiveEvent({ type: "pause_state", paused: true })).toEqual({ type: "pause_state", paused: true });
    expect(parseLiveEvent({ type: "pause_state", paused: "yes" })).toBeNull();
  });

  it.each([
    [null], ["x"], [{}], [{ type: "unknown" }],
    [{ ...goodFinal, event_id: -1 }], [{ ...goodFinal, utterance_id: 0 }], [{ ...goodFinal, text: 3 }],
    [{ ...goodFinal, start_seconds: 2, end_seconds: 1 }], [{ ...goodFinal, end_seconds: Number.NaN }],
    [{ type: "partial", event_id: 1, utterance_id: 1, revision: 0, text: "", start_seconds: 0, end_seconds: 1 }],
    [{ type: "client_state", state: "exploding" }],
    [{ type: "session_ended", event_id: 1, reason: "x", utterances: -1 }],
    [{ type: "error", code: 1, message: "x" }],
  ])("drops malformed event %#", (value) => {
    expect(parseLiveEvent(value)).toBeNull();
  });

  it("treats an out-of-range language probability as absent", () => {
    expect(parseLiveEvent({ ...goodFinal, language_probability: 7 })).toMatchObject({ language_probability: null });
  });
});

describe("Resampler", () => {
  const sine = (rate: number, hertz: number, seconds: number) =>
    Float32Array.from({ length: Math.round(rate * seconds) }, (_unused, index) => 0.5 * Math.sin((2 * Math.PI * hertz * index) / rate));
  const crossings = (samples: Float32Array) => samples.reduce((count, value, index) => (index > 0 && samples[index - 1] < 0 && value >= 0 ? count + 1 : count), 0);

  it.each([48_000, 44_100, 32_000, 16_000, 8_000])("outputs 16 kHz and keeps a 440 Hz tone at %i Hz", (rate) => {
    const output = new Resampler(rate).process(sine(rate, 440, 1));
    expect(Math.abs(output.length - 16_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(crossings(output) - 440)).toBeLessThanOrEqual(2);
    expect(Math.max(...output)).toBeGreaterThan(0.45); // amplitude is preserved, not attenuated away
  });

  it("gives the same result however the input is cut into chunks", () => {
    const input = sine(44_100, 300, 0.5);
    const whole = new Resampler(44_100).process(input);
    const pieces = new Resampler(44_100);
    const parts: number[] = [];
    for (let offset = 0; offset < input.length; offset += 1_000) parts.push(...pieces.process(input.subarray(offset, offset + 1_000)));
    expect(parts).toHaveLength(whole.length);
    expect(Array.from(whole).every((value, index) => Math.abs(value - parts[index]) < 1e-6)).toBe(true);
  });

  it("rejects an invalid sample rate", () => {
    expect(() => new Resampler(0)).toThrow(RangeError);
    expect(() => new Resampler(Number.NaN)).toThrow(RangeError);
  });
});

describe("floatToInt16 and FrameBuffer", () => {
  it("clips instead of wrapping around", () => {
    expect(Array.from(floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32767, 32767, -32767, 16384]);
  });

  it("emits 100 ms little-endian frames and flushes the remainder", () => {
    const frames: Uint8Array[] = [];
    const buffer = new FrameBuffer((frame) => frames.push(frame));
    buffer.push(new Int16Array(1_000).fill(1));
    expect(frames).toHaveLength(0);
    buffer.push(new Int16Array(2_300).fill(256));
    expect(frames.map((frame) => frame.byteLength)).toEqual([3_200, 3_200]);
    expect(Array.from(frames[0].slice(0, 2))).toEqual([1, 0]); // 1 as int16 little-endian
    buffer.flush();
    expect(frames.map((frame) => frame.byteLength)).toEqual([3_200, 3_200, 200]);
    buffer.flush();
    expect(frames).toHaveLength(3);
  });
});
