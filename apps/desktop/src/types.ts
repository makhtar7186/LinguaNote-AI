export interface Segment {
  start_seconds: number;
  end_seconds: number;
  text: string;
}

export interface TranscriptionResponse {
  text: string;
  engine: string;
  model: string;
  duration_seconds: number;
  timing_available: boolean;
  language: string | null;
  language_probability: number | null;
  segments: Segment[];
}

export interface Limits {
  max_upload_bytes: number;
  max_audio_seconds: number;
  extensions: string[];
}

export interface ServiceHealth {
  ok: boolean;
  engine_selected?: boolean;
  engine?: string | null;
  model?: string | null;
  setup_message?: string | null;
  ffmpeg_available?: boolean;
  limits?: Limits;
  message?: string;
  code?: string;
}

/** What a live session listens to. Chosen by the user, shown everywhere, never switched silently. */
export type AudioSourceKind = "microphone" | "system" | "both";

export type LiveClientState = "idle" | "connecting" | "active" | "reconnecting" | "stopping" | "ended" | "failed";

/** Validated live events (see src/services/liveEvents.ts). Those with an event_id are de-duplicated by it. */
export type LiveEvent =
  | { type: "client_state"; state: LiveClientState }
  | { type: "pause_state"; paused: boolean }
  | { type: "capture_source"; source: AudioSourceKind }
  | { type: "session_started"; resumed: boolean; engine?: { name: string; model: string } }
  | {
    type: "partial"; event_id: number; utterance_id: number; revision: number; text: string;
    start_seconds: number; end_seconds: number;
  }
  | {
    type: "final"; event_id: number; utterance_id: number; text: string; start_seconds: number; end_seconds: number;
    language: string | null; language_probability: number | null;
  }
  | { type: "error"; code: string; message: string; fatal: boolean; event_id?: number; utterance_id?: number }
  | { type: "session_ended"; event_id: number; reason: string; utterances: number };

export interface FinalSegment {
  utterance_id: number;
  text: string;
  start_seconds: number;
  end_seconds: number;
  language: string | null;
  language_probability: number | null;
}

export interface PartialSegment {
  utterance_id: number;
  revision: number;
  text: string;
  start_seconds: number;
  end_seconds: number;
}

export interface LiveNotice {
  code: string;
  message: string;
  utterance_id?: number;
  fatal: boolean;
}

export interface LiveState {
  status: "idle" | "connecting" | "live" | "reconnecting" | "stopping" | "ended" | "failed";
  finals: FinalSegment[];
  partial: PartialSegment | null;
  notices: LiveNotice[];
  lastEventId: number;
  endReason: string | null;
  paused: boolean;
  source: AudioSourceKind | null;
  engine?: { name: string; model: string };
}

export interface LiveBridge {
  /** Opens a session; resolves to the same `{ok}` envelope as the other bridge calls. */
  start: (options?: { source?: AudioSourceKind }) => Promise<unknown>;
  /** Fire and forget: 16 kHz mono PCM s16le. */
  sendAudio: (pcm: Uint8Array) => void;
  stop: () => Promise<unknown>;
  pause: () => Promise<unknown>;
  resume: () => Promise<unknown>;
  /** Current session state, for a window opened or reloaded mid-session. */
  status: () => Promise<unknown>;
  /** Subscribes to raw events from the main process; returns the unsubscribe function. */
  onEvent: (listener: (event: unknown) => void) => () => void;
}

export interface CaptureBridge {
  /** Must be called just before asking for system audio; otherwise the main process denies the request. */
  armSystemAudio: () => Promise<unknown>;
  disarm: () => Promise<unknown>;
}

export interface BubbleBridge {
  setExpanded: (expanded: boolean) => Promise<unknown>;
  setVisible: (visible: boolean) => Promise<unknown>;
  getState: () => Promise<unknown>;
  /** Commands from global shortcuts that need the microphone (only a renderer can capture audio). */
  onCommand: (listener: (command: unknown) => void) => () => void;
}

export interface ShortcutsBridge {
  getReport: () => Promise<unknown>;
}

export interface ShortcutReport {
  registered: { name: string; accelerator: string }[];
  failed: { name: string; accelerator: string; reason: string }[];
}

export interface LinguaNoteBridge {
  health: () => Promise<unknown>;
  transcribe: (payload: { name: string; type: string; bytes: Uint8Array }) => Promise<unknown>;
  live?: LiveBridge;
  bubble?: BubbleBridge;
  capture?: CaptureBridge;
  shortcuts?: ShortcutsBridge;
}

declare global {
  interface Window {
    linguaNote?: LinguaNoteBridge;
  }
}
