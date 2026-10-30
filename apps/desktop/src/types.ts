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

export interface LinguaNoteBridge {
  health: () => Promise<unknown>;
  transcribe: (payload: { name: string; type: string; bytes: Uint8Array }) => Promise<unknown>;
}

declare global {
  interface Window {
    linguaNote?: LinguaNoteBridge;
  }
}
