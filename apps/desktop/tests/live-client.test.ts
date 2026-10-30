import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const live = createRequire(import.meta.url)("../electron/live-client.cjs");
const config = { base: "http://127.0.0.1:9000", token: "tok" };

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "";
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | Uint8Array) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }

  // -- helpers for the test, playing the server --
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
  json(): Record<string, unknown>[] {
    return this.sent.filter((item): item is string => typeof item === "string").map((item) => JSON.parse(item));
  }
  frames(): { seq: number; bytes: number }[] {
    return this.sent.filter((item): item is Uint8Array => typeof item !== "string").map((frame) => ({
      seq: new DataView(frame.buffer, frame.byteOffset).getUint32(0, false), bytes: frame.byteLength - 4,
    }));
  }
}

const pcm = (samples: number) => new Uint8Array(samples * 2).fill(1);
const started = (extra: Record<string, unknown> = {}) => ({
  type: "session_started", session_id: "S1", protocol: 1, resumed: false, audio_ack: 0, ...extra,
});

function setup(options: Record<string, unknown> = {}) {
  const events: Record<string, unknown>[] = [];
  const states: string[] = [];
  const client = new live.LiveClient(config, {
    WebSocketImpl: FakeWebSocket,
    onEvent: (event: Record<string, unknown>) => events.push(event),
    onState: (state: string) => states.push(state),
    options,
  });
  return { client, events, states, socket: () => FakeWebSocket.instances.at(-1)! };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("opening", () => {
  it("connects to the live endpoint and sends the token in the first message, never in the URL", () => {
    const { client, socket } = setup();
    client.start();
    expect(socket().url).toBe("ws://127.0.0.1:9000/api/v1/live");
    socket().open();
    expect(socket().json()[0]).toEqual({ type: "start", token: "tok", protocol: 1 });
    expect(socket().url).not.toContain("tok");
  });

  it("becomes active on session_started and forwards it", () => {
    const { client, events, states, socket } = setup();
    client.start();
    socket().open();
    socket().receive(started({ engine: { name: "fake" } }));
    expect(states).toEqual(["connecting", "active"]);
    expect(events[0]).toMatchObject({ type: "session_started", session_id: "S1" });
  });

  it("reports an unreachable service instead of hanging", () => {
    const { client, events, states, socket } = setup();
    client.start();
    socket().drop(); // closed before any session existed
    expect(states.at(-1)).toBe("failed");
    expect(events[0]).toMatchObject({ type: "error", code: "service_unavailable", fatal: true });
  });

  it("refuses to start twice", () => {
    const { client, socket } = setup();
    client.start();
    socket().open();
    expect(() => client.start()).toThrow(/déjà en cours/);
  });

  it("forwards a fatal transport error (bad token) and fails", () => {
    const { client, events, states, socket } = setup();
    client.start();
    socket().open();
    socket().receive({ type: "error", code: "unauthorized", message: "no", fatal: true });
    expect(events).toHaveLength(1);
    expect(states.at(-1)).toBe("failed");
  });
});

describe("audio", () => {
  it("numbers frames from 1, big-endian, and queues audio sent before the session is ready", () => {
    const { client, socket } = setup();
    client.start();
    client.sendAudio(pcm(1600)); // before the connection is open
    socket().open();
    expect(socket().frames()).toEqual([]);
    socket().receive(started());
    client.sendAudio(pcm(1600));
    expect(socket().frames()).toEqual([{ seq: 1, bytes: 3200 }, { seq: 2, bytes: 3200 }]);
  });

  it("splits large chunks into frames of at most one second", () => {
    const { client, socket } = setup();
    client.start();
    socket().open();
    socket().receive(started());
    client.sendAudio(pcm(40_000)); // 2.5 s
    expect(socket().frames().map((f) => f.bytes)).toEqual([32_000, 32_000, 16_000]);
  });

  it("rejects odd or empty audio before touching the network", () => {
    const { client } = setup();
    client.start();
    expect(() => client.sendAudio(new Uint8Array(3))).toThrow();
    expect(() => client.sendAudio(new Uint8Array(0))).toThrow();
    expect(() => client.sendAudio("nope" as unknown as Uint8Array)).toThrow();
  });

  it("forgets acknowledged frames and resends only the missing ones after a gap report", () => {
    const { client, socket } = setup();
    client.start();
    socket().open();
    socket().receive(started());
    for (let i = 0; i < 4; i += 1) client.sendAudio(pcm(1600));
    socket().receive({ type: "audio_ack", seq: 2 });
    socket().sent.length = 0;
    socket().receive({ type: "error", code: "sequence_gap", expected: 3, fatal: false });
    expect(socket().frames().map((f) => f.seq)).toEqual([3, 4]);
  });

  it("fails explicitly when the server asks for audio that was already dropped from the buffer", () => {
    const { client, events, states, socket } = setup({ maxBufferedSeconds: 0.2 });
    client.start();
    socket().open();
    socket().receive(started());
    for (let i = 0; i < 5; i += 1) client.sendAudio(pcm(1600)); // 0.5 s against a 0.2 s buffer
    socket().receive({ type: "error", code: "sequence_gap", expected: 1, fatal: false });
    expect(events.some((e) => e.code === "audio_lost")).toBe(true);
    expect(states.at(-1)).toBe("failed");
  });

  it("warns once when the buffer overflows instead of silently losing audio", () => {
    const { client, events } = setup({ maxBufferedSeconds: 0.2 });
    client.start(); // never connects: the buffer fills up
    for (let i = 0; i < 6; i += 1) client.sendAudio(pcm(1600));
    expect(events.filter((e) => e.code === "audio_buffer_overflow")).toHaveLength(1);
  });
});

describe("events", () => {
  it("delivers each event once and ignores replays", () => {
    const { client, events, socket } = setup();
    client.start();
    socket().open();
    socket().receive(started());
    socket().receive({ type: "final", event_id: 1, utterance_id: 1, text: "a" });
    socket().receive({ type: "final", event_id: 1, utterance_id: 1, text: "a" });
    socket().receive({ type: "partial", event_id: 2, utterance_id: 2, revision: 1, text: "b" });
    expect(events.map((e) => e.type)).toEqual(["session_started", "final", "partial"]);
  });

  it("ignores malformed server messages", () => {
    const { client, events, socket } = setup();
    client.start();
    socket().open();
    socket().onmessage?.({ data: "not json" });
    socket().onmessage?.({ data: new ArrayBuffer(4) });
    socket().receive({ nothing: true });
    expect(events).toEqual([]);
  });

  it("ends the session on session_ended and closes the socket", () => {
    const { client, events, states, socket } = setup();
    client.start();
    socket().open();
    socket().receive(started());
    client.stop();
    expect(socket().json().at(-1)).toEqual({ type: "stop" });
    expect(states.at(-1)).toBe("stopping");
    socket().receive({ type: "session_ended", event_id: 1, reason: "client_stop", utterances: 0 });
    expect(states.at(-1)).toBe("ended");
    expect(events.at(-1)).toMatchObject({ type: "session_ended" });
    expect(socket().closed).toBe(true);
  });
});

describe("keeping the connection alive and recovering from drops", () => {
  it("pings regularly so a quiet microphone does not look idle", () => {
    const { client, socket } = setup({ pingMs: 1000 });
    client.start();
    socket().open();
    socket().receive(started());
    socket().sent.length = 0;
    vi.advanceTimersByTime(3100);
    expect(socket().json().filter((m) => m.type === "ping")).toHaveLength(3);
  });

  it("resumes after a drop with the last event id, resending only unacknowledged audio", () => {
    const { client, events, states, socket } = setup();
    client.start();
    socket().open();
    socket().receive(started());
    for (let i = 0; i < 5; i += 1) client.sendAudio(pcm(1600));
    socket().receive({ type: "audio_ack", seq: 3 });
    socket().receive({ type: "final", event_id: 7, utterance_id: 1, text: "bonjour" });
    const first = socket();
    first.drop();

    expect(states.at(-1)).toBe("reconnecting");
    client.sendAudio(pcm(1600)); // keeps buffering while offline (seq 6)
    vi.advanceTimersByTime(250);
    const second = socket();
    expect(second).not.toBe(first);
    second.open();
    expect(second.json()[0]).toEqual({
      type: "resume", token: "tok", protocol: 1, session_id: "S1", last_event_id: 7,
    });

    // The server only has frames up to 4: the client replays 5 and 6, never 1-4.
    second.receive(started({ resumed: true, audio_ack: 4 }));
    expect(second.frames().map((f) => f.seq)).toEqual([5, 6]);
    // The replayed final is dropped; a genuinely new event gets through.
    second.receive({ type: "final", event_id: 7, utterance_id: 1, text: "bonjour" });
    second.receive({ type: "final", event_id: 8, utterance_id: 2, text: "tout le monde" });
    expect(events.filter((e) => e.type === "final").map((e) => e.text)).toEqual(["bonjour", "tout le monde"]);
    expect(states.at(-1)).toBe("active");
  });

  it("backs off between attempts and gives up once the resume window is over", () => {
    let clock = 1_000_000;
    const events: Record<string, unknown>[] = [];
    const states: string[] = [];
    const client = new live.LiveClient(config, {
      WebSocketImpl: FakeWebSocket, onEvent: (e: Record<string, unknown>) => events.push(e),
      onState: (s: string) => states.push(s), now: () => clock,
      options: { backoffMs: [100, 200], resumeWindowMs: 1000 },
    });
    client.start();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].receive(started());
    FakeWebSocket.instances[0].drop();

    for (const delay of [100, 200, 200]) {
      vi.advanceTimersByTime(delay);
      clock += delay;
      FakeWebSocket.instances.at(-1)!.drop(); // each attempt fails to connect
    }
    clock += 1000;
    vi.advanceTimersByTime(200);
    FakeWebSocket.instances.at(-1)!.drop();
    expect(states.at(-1)).toBe("failed");
    expect(events.at(-1)).toMatchObject({ code: "session_lost", fatal: true });
  });

  it("fails cleanly when the server no longer knows the session", () => {
    const { client, events, states, socket } = setup();
    client.start();
    socket().open();
    socket().receive(started());
    socket().drop();
    vi.advanceTimersByTime(250);
    socket().open();
    socket().receive({ type: "error", code: "session_not_found", message: "expired", fatal: true });
    expect(events.at(-1)).toMatchObject({ code: "session_not_found" });
    expect(states.at(-1)).toBe("failed");
  });

  it("sends the stop that was requested while offline once the session is back", () => {
    const { client, socket } = setup();
    client.start();
    socket().open();
    socket().receive(started());
    socket().drop();
    client.stop(); // requested while reconnecting
    vi.advanceTimersByTime(250);
    socket().open();
    socket().receive(started({ resumed: true }));
    expect(socket().json().at(-1)).toEqual({ type: "stop" });
  });

  it("ignores events from a socket that was replaced", () => {
    const { client, events, socket } = setup();
    client.start();
    const stale = socket();
    stale.open();
    stale.receive(started());
    stale.drop();
    vi.advanceTimersByTime(250);
    socket().open();
    socket().receive(started({ resumed: true }));
    const before = events.length;
    stale.receive({ type: "final", event_id: 99, utterance_id: 9, text: "ghost" });
    expect(events).toHaveLength(before);
  });
});

describe("close", () => {
  it("stops everything and returns to idle", () => {
    const { client, states, socket } = setup({ pingMs: 1000 });
    client.start();
    socket().open();
    socket().receive(started());
    client.close();
    expect(socket().closed).toBe(true);
    expect(states.at(-1)).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("validateAudioChunk and toWebSocketUrl", () => {
  it("accepts whole 16-bit samples within the size cap only", () => {
    expect(() => live.validateAudioChunk(new Uint8Array(2))).not.toThrow();
    expect(() => live.validateAudioChunk(new Uint8Array(live.MAX_CHUNK_BYTES + 2))).toThrow();
  });

  it("maps http to ws and https to wss on the fixed live path", () => {
    expect(live.toWebSocketUrl("http://127.0.0.1:8765")).toBe("ws://127.0.0.1:8765/api/v1/live");
    expect(live.toWebSocketUrl("https://example.org/base")).toBe("wss://example.org/api/v1/live");
  });
});

describe("pause and resume", () => {
  const activeClient = (options: Record<string, unknown> = {}) => {
    const harness = setup(options);
    harness.client.start();
    harness.socket().open();
    harness.socket().receive(started());
    return harness;
  };

  it("sends a closing silence, then discards microphone audio while paused", () => {
    const { client, events, socket } = activeClient();
    client.sendAudio(pcm(1600));
    expect(client.pause()).toBe(true);
    const framesAtPause = socket().frames();
    // 1 audio frame + 0.9 s of silence = 28 800 bytes
    expect(framesAtPause.map((f) => f.bytes).reduce((a, b) => a + b, 0)).toBe(3200 + 28_800);
    expect(events.at(-1)).toEqual({ type: "pause_state", paused: true });

    client.sendAudio(pcm(1600)); // dropped, not buffered
    client.sendAudio(pcm(1600));
    expect(socket().frames()).toHaveLength(framesAtPause.length);
  });

  it("resumes with consecutive sequence numbers and reports the state", () => {
    const { client, events, socket } = activeClient();
    client.pause();
    const last = socket().frames().at(-1)!.seq;
    expect(client.resume()).toBe(true);
    expect(events.at(-1)).toEqual({ type: "pause_state", paused: false });
    client.sendAudio(pcm(1600));
    expect(socket().frames().at(-1)!.seq).toBe(last + 1); // no hole, no reset: the server sees one stream
  });

  it("only pauses an active session and ignores repeated requests", () => {
    const idle = setup();
    expect(idle.client.pause()).toBe(false);
    expect(idle.client.resume()).toBe(false);

    const { client } = activeClient();
    expect(client.pause()).toBe(true);
    expect(client.pause()).toBe(false);
    expect(client.resume()).toBe(true);
    expect(client.resume()).toBe(false);
  });

  it("can still be stopped while paused, and a new session starts unpaused", () => {
    const { client, states, socket } = activeClient();
    client.pause();
    client.stop();
    expect(socket().json().at(-1)).toEqual({ type: "stop" });
    socket().receive({ type: "session_ended", event_id: 1, reason: "client_stop", utterances: 0 });
    expect(states.at(-1)).toBe("ended");
    client.start();
    expect(client.paused).toBe(false);
  });

  it("keeps the pause across a reconnection", () => {
    const { client, socket } = activeClient();
    client.pause();
    socket().drop();
    vi.advanceTimersByTime(250);
    socket().open();
    socket().receive(started({ resumed: true, audio_ack: 0 }));
    const sentBefore = socket().frames().length;
    client.sendAudio(pcm(1600));
    expect(socket().frames()).toHaveLength(sentBefore); // still paused after the session came back
  });
});
