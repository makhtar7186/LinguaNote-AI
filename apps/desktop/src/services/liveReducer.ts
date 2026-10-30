import type { LiveEvent, LiveState } from "../types";

export const MAX_NOTICES = 20;

export const initialLiveState: LiveState = {
  status: "idle",
  finals: [],
  partial: null,
  notices: [],
  lastEventId: 0,
  endReason: null,
  paused: false,
  source: null,
};

export type LiveAction = LiveEvent | { type: "reset" };

const STATUS_BY_CLIENT_STATE = {
  idle: "idle", connecting: "connecting", active: "live", reconnecting: "reconnecting",
  stopping: "stopping", ended: "ended", failed: "failed",
} as const;

/**
 * Reconciles the stream of provisional and final results (docs/api-contracts.md):
 * - an event already seen (event_id not greater than the last one) is ignored, so a replay cannot duplicate text;
 * - a partial replaces the previous one for the same utterance only if its revision is higher;
 * - a final replaces any partial of its utterance, is never revised, and a late partial for it is ignored;
 * - a partial that was never finalised is discarded when the session ends (the service finalises pending audio
 *   before ending, so what remains was not recognised).
 */
export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  if (action.type === "reset") return { ...initialLiveState, status: "connecting" };

  if ("event_id" in action && typeof action.event_id === "number") {
    if (action.event_id <= state.lastEventId) return state;
    state = { ...state, lastEventId: action.event_id };
  }

  switch (action.type) {
    case "client_state": {
      // A new session (seen by every window, not only the one that started it) starts from a clean transcript.
      if (action.state === "connecting" && ["idle", "ended", "failed"].includes(state.status)) {
        return { ...initialLiveState, status: "connecting" };
      }
      // The server's session_ended is the authoritative end; a trailing "idle" must not erase it.
      if (action.state === "idle" && (state.status === "ended" || state.status === "failed")) return state;
      const status = STATUS_BY_CLIENT_STATE[action.state];
      return { ...state, status, paused: status === "live" || status === "reconnecting" ? state.paused : false };
    }
    case "pause_state":
      return { ...state, paused: action.paused };
    case "capture_source":
      return { ...state, source: action.source };
    case "session_started":
      return { ...state, status: state.status === "stopping" ? "stopping" : "live", engine: action.engine ?? state.engine };
    case "partial": {
      if (state.finals.some((item) => item.utterance_id === action.utterance_id)) return state;
      const current = state.partial;
      if (current && action.utterance_id < current.utterance_id) return state;
      if (current && current.utterance_id === action.utterance_id && action.revision <= current.revision) return state;
      return {
        ...state,
        partial: {
          utterance_id: action.utterance_id, revision: action.revision, text: action.text,
          start_seconds: action.start_seconds, end_seconds: action.end_seconds,
        },
      };
    }
    case "final": {
      const segment = {
        utterance_id: action.utterance_id, text: action.text, start_seconds: action.start_seconds,
        end_seconds: action.end_seconds, language: action.language, language_probability: action.language_probability,
      };
      const others = state.finals.filter((item) => item.utterance_id !== action.utterance_id);
      const finals = [...others, segment].sort((a, b) => a.utterance_id - b.utterance_id);
      const partial = state.partial && state.partial.utterance_id <= action.utterance_id ? null : state.partial;
      return { ...state, finals, partial };
    }
    case "error": {
      const notices = [
        ...state.notices,
        { code: action.code, message: action.message, utterance_id: action.utterance_id, fatal: action.fatal },
      ].slice(-MAX_NOTICES);
      return { ...state, notices, status: action.fatal && state.status !== "ended" ? "failed" : state.status };
    }
    case "session_ended":
      return { ...state, status: "ended", partial: null, endReason: action.reason, paused: false };
    default:
      return state;
  }
}

/** The text to display: finalised utterances in order, then the provisional one (if any). */
export function transcriptText(state: LiveState): { final: string; provisional: string } {
  return {
    final: state.finals.map((item) => item.text).join(" "),
    provisional: state.partial?.text ?? "",
  };
}
