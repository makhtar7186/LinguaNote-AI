// WebSocket client for live transcription, run in the Electron main process (the renderer never sees the token).
// Implements the client side of docs/api-contracts.md: sequence numbers, acknowledgements, a bounded buffer of
// unacknowledged audio, resume with event de-duplication. Free of Electron imports so it can be unit-tested.

const PROTOCOL = 1;
const SAMPLE_RATE = 16_000;
const SEQ_BYTES = 4;
const MAX_FRAME_BYTES = 32_000; // 1 s; the server accepts up to 64 KiB
const MAX_CHUNK_BYTES = 1_000_000; // largest chunk the renderer may hand over in one IPC message
// Sent when pausing so the service sees a pause longer than its end-of-utterance silence (0.7 s) and finalises
// the sentence in progress instead of leaving it dangling until the user resumes.
const PAUSE_SILENCE_BYTES = 28_800; // 0.9 s of digital silence

const DEFAULT_OPTIONS = {
  maxBufferedSeconds: 30, // unacknowledged audio kept for replay after a reconnection
  pingMs: 10_000,
  backoffMs: [250, 500, 1_000, 2_000, 4_000],
  resumeWindowMs: 30_000, // matches LINGUANOTE_LIVE_RESUME_SECONDS on the server
};

class LiveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Validates audio handed over by the renderer. PCM s16le: whole samples, bounded size. */
function validateAudioChunk(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new LiveError("invalid_payload", "Audio invalide.");
  }
  if (bytes.byteLength % 2 !== 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
    throw new LiveError("invalid_payload", "Audio invalide (échantillons de 16 bits attendus).");
  }
}

function toWebSocketUrl(base) {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/live";
  return url.href;
}

class LiveClient {
  /**
   * @param {{base: string, token: string}} config
   * @param {{WebSocketImpl?: typeof WebSocket, onEvent: (event: object) => void,
   *          onState?: (state: string) => void, now?: () => number, options?: object}} deps
   */
  constructor(config, { WebSocketImpl = globalThis.WebSocket, onEvent, onState = () => {}, now = Date.now, options = {}, source = null }) {
    this.config = config;
    this.source = source; // informational: stored with the session in the history when it is on
    this.WebSocketImpl = WebSocketImpl;
    this.onEvent = onEvent;
    this.onState = onState;
    this.now = now;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.state = "idle";
    this.#reset();
  }

  #reset() {
    this.ws = null;
    this.sessionId = null;
    this.lastEventId = 0;
    this.seq = 0;
    this.unacked = []; // [{seq, data}] in order
    this.unackedBytes = 0;
    this.stopRequested = false;
    this.paused = false;
    this.attempt = 0;
    this.disconnectedAt = null;
    this.audioLost = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  /** Opens a new session. Audio may be queued with sendAudio() right away. */
  start() {
    if (!["idle", "ended", "failed"].includes(this.state)) {
      throw new LiveError("already_running", "Une session en direct est déjà en cours.");
    }
    this.#clearTimers();
    this.#reset();
    this.#setState("connecting");
    this.#connect(false);
  }

  /** Queues PCM s16le mono 16 kHz. Safe to call while connecting or reconnecting: nothing is lost unless the buffer overflows. */
  sendAudio(bytes) {
    validateAudioChunk(bytes);
    if (["idle", "ended", "failed"].includes(this.state) || this.stopRequested || this.paused) return;
    this.#enqueue(bytes);
  }

  #enqueue(bytes) {
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_FRAME_BYTES) {
      const data = bytes.slice(offset, Math.min(offset + MAX_FRAME_BYTES, bytes.byteLength));
      const entry = { seq: ++this.seq, data };
      this.unacked.push(entry);
      this.unackedBytes += data.byteLength;
      this.#enforceBufferLimit();
      if (this.state === "active") this.#sendFrame(entry);
    }
  }

  /**
   * Pauses dictation: microphone audio is discarded (not buffered) until resume(). The session stays open and the
   * keep-alive pings continue. A short silence is sent first so the sentence in progress is finalised.
   * Only valid while active; returns whether the state changed.
   */
  pause() {
    if (this.state !== "active" || this.paused) return false;
    this.#enqueue(new Uint8Array(PAUSE_SILENCE_BYTES));
    this.paused = true;
    this.onEvent({ type: "pause_state", paused: true });
    return true;
  }

  resume() {
    if (!this.paused) return false;
    this.paused = false;
    if (this.state !== "idle") this.onEvent({ type: "pause_state", paused: false });
    return true;
  }

  /** Asks the server to finish: the remaining speech is finalised, then session_ended arrives. */
  stop() {
    if (["idle", "ended", "failed"].includes(this.state)) return;
    this.stopRequested = true;
    if (this.state === "active") {
      this.#sendJson({ type: "stop" });
      this.#setState("stopping");
    }
    // While connecting or reconnecting, the stop is sent as soon as the session is (re)established.
  }

  /** Hard stop (application quitting). Nothing more is delivered. */
  close() {
    this.#clearTimers();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already closed */ }
    this.#reset();
    this.#setState("idle");
  }

  // -- connection -----------------------------------------------------------------------------------

  #connect(resume) {
    let ws;
    try {
      ws = new this.WebSocketImpl(toWebSocketUrl(this.config.base));
    } catch {
      this.#fail("service_unavailable", "Service local indisponible.");
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (ws !== this.ws) return;
      const opening = resume
        ? { type: "resume", token: this.config.token, protocol: PROTOCOL, session_id: this.sessionId, last_event_id: this.lastEventId }
        : { type: "start", token: this.config.token, protocol: PROTOCOL, ...(this.source ? { source: this.source } : {}) };
      this.#sendJson(opening);
    };
    ws.onmessage = (event) => {
      if (ws === this.ws) this.#onMessage(event.data);
    };
    ws.onclose = () => {
      if (ws === this.ws) this.#onClose();
    };
    ws.onerror = () => { /* a close event follows */ };
  }

  #sendJson(message) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(message));
  }

  #sendFrame(entry) {
    if (this.ws?.readyState !== 1) return;
    const frame = new Uint8Array(SEQ_BYTES + entry.data.byteLength);
    new DataView(frame.buffer).setUint32(0, entry.seq, false);
    frame.set(entry.data, SEQ_BYTES);
    this.ws.send(frame);
  }

  #enforceBufferLimit() {
    const limit = this.options.maxBufferedSeconds * SAMPLE_RATE * 2;
    let dropped = 0;
    while (this.unackedBytes > limit && this.unacked.length > 1) {
      const oldest = this.unacked.shift();
      this.unackedBytes -= oldest.data.byteLength;
      dropped += oldest.data.byteLength;
    }
    if (dropped > 0 && !this.audioLost) {
      // Audio the server never acknowledged can no longer be replayed: say so instead of hiding a hole in the text.
      this.audioLost = true;
      this.onEvent({
        type: "error", code: "audio_buffer_overflow", fatal: false, local: true,
        message: "La connexion est trop lente : une partie de l'audio n'a pas pu être envoyée.",
      });
    }
  }

  #trimAcked(ackedSeq) {
    while (this.unacked.length > 0 && this.unacked[0].seq <= ackedSeq) {
      this.unackedBytes -= this.unacked.shift().data.byteLength;
    }
  }

  #resendFrom(seq) {
    if (this.unacked.length > 0 && this.unacked[0].seq > seq) {
      this.#fail("audio_lost", "Des données audio non acquittées ont été perdues ; la session ne peut pas continuer.");
      return;
    }
    for (const entry of this.unacked) {
      if (entry.seq >= seq) this.#sendFrame(entry);
    }
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : "");
    } catch {
      return; // not a protocol message
    }
    if (!message || typeof message.type !== "string") return;

    switch (message.type) {
      case "session_started": {
        this.sessionId = message.session_id;
        this.attempt = 0;
        this.disconnectedAt = null;
        this.#trimAcked(message.audio_ack ?? 0);
        // The server counts frames from `audio_ack`: replay everything after it, in order.
        this.#setState(this.stopRequested ? "stopping" : "active");
        this.#resendFrom((message.audio_ack ?? 0) + 1);
        if (this.stopRequested) this.#sendJson({ type: "stop" });
        this.#startPing();
        this.onEvent(message);
        return;
      }
      case "audio_ack":
        this.#trimAcked(message.seq);
        return;
      case "pong":
        return;
      default:
        break;
    }

    if (message.type === "error" && message.event_id === undefined) {
      // Transport-level error.
      if (message.code === "sequence_gap" && Number.isInteger(message.expected)) {
        this.#resendFrom(message.expected);
        return;
      }
      this.onEvent(message);
      if (message.fatal) this.#fail(message.code, message.message ?? "Erreur du service.", false);
      return;
    }

    if (Number.isInteger(message.event_id)) {
      if (message.event_id <= this.lastEventId) return; // replayed event already delivered
      this.lastEventId = message.event_id;
    }
    this.onEvent(message);
    if (message.type === "session_ended") {
      this.#clearTimers();
      const ws = this.ws;
      this.ws = null;
      try { ws?.close(); } catch { /* already closed */ }
      this.#setState("ended");
    }
  }

  #onClose() {
    this.#clearPing();
    if (["idle", "ended", "failed"].includes(this.state)) return;
    if (!this.sessionId) {
      this.#fail("service_unavailable", "Impossible d'ouvrir la session en direct. Le service local est-il démarré ?");
      return;
    }
    this.disconnectedAt ??= this.now();
    this.#setState("reconnecting");
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.now() - this.disconnectedAt > this.options.resumeWindowMs) {
      this.#fail("session_lost", "La connexion au service a été perdue trop longtemps ; la session est terminée.");
      return;
    }
    const delays = this.options.backoffMs;
    const delay = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect(true);
    }, delay);
  }

  #fail(code, message, announce = true) {
    this.#clearTimers();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already closed */ }
    if (announce) this.onEvent({ type: "error", code, message, fatal: true, local: true });
    this.#setState("failed");
  }

  // -- timers ---------------------------------------------------------------------------------------

  #startPing() {
    this.#clearPing();
    this.pingTimer = setInterval(() => this.#sendJson({ type: "ping" }), this.options.pingMs);
  }

  #clearPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  #clearTimers() {
    this.#clearPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

module.exports = {
  LiveClient, LiveError, validateAudioChunk, toWebSocketUrl, DEFAULT_OPTIONS, MAX_CHUNK_BYTES, MAX_FRAME_BYTES,
};
