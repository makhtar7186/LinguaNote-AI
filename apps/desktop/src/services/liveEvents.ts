import type { LiveEvent } from "../types";

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isPositiveInt = (value: unknown): value is number => isCount(value) && value >= 1;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string";
const optString = (value: unknown) => (typeof value === "string" ? value : null);

function probability(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

const CLIENT_STATES = ["idle", "connecting", "active", "reconnecting", "stopping", "ended", "failed"] as const;

/**
 * The main process is trusted but the payload still crosses a process boundary, and the service behind it is a
 * separate program: anything that does not match the contract is dropped rather than rendered.
 */
export function parseLiveEvent(value: unknown): LiveEvent | null {
  if (!isRec(value) || typeof value.type !== "string") return null;

  switch (value.type) {
    case "client_state": {
      const state = CLIENT_STATES.find((candidate) => candidate === value.state);
      return state ? { type: "client_state", state } : null;
    }
    case "session_started": {
      const engine = isRec(value.engine) && isText(value.engine.name)
        ? { name: value.engine.name, model: optString(value.engine.model) ?? "" }
        : undefined;
      return { type: "session_started", resumed: value.resumed === true, engine };
    }
    case "partial": {
      if (!isCount(value.event_id) || !isPositiveInt(value.utterance_id) || !isPositiveInt(value.revision)
        || !isText(value.text) || !isTime(value.start_seconds) || !isTime(value.end_seconds)
        || value.end_seconds < value.start_seconds) return null;
      return {
        type: "partial", event_id: value.event_id, utterance_id: value.utterance_id, revision: value.revision,
        text: value.text, start_seconds: value.start_seconds, end_seconds: value.end_seconds,
      };
    }
    case "final": {
      if (!isCount(value.event_id) || !isPositiveInt(value.utterance_id) || !isText(value.text)
        || !isTime(value.start_seconds) || !isTime(value.end_seconds) || value.end_seconds < value.start_seconds) {
        return null;
      }
      return {
        type: "final", event_id: value.event_id, utterance_id: value.utterance_id, text: value.text,
        start_seconds: value.start_seconds, end_seconds: value.end_seconds,
        language: optString(value.language), language_probability: probability(value.language_probability),
      };
    }
    case "error": {
      if (!isText(value.code) || !isText(value.message)) return null;
      return {
        type: "error", code: value.code, message: value.message, fatal: value.fatal === true,
        event_id: isCount(value.event_id) ? value.event_id : undefined,
        utterance_id: isPositiveInt(value.utterance_id) ? value.utterance_id : undefined,
      };
    }
    case "session_ended": {
      if (!isCount(value.event_id) || !isText(value.reason) || !isCount(value.utterances)) return null;
      return { type: "session_ended", event_id: value.event_id, reason: value.reason, utterances: value.utterances };
    }
    default:
      return null;
  }
}
