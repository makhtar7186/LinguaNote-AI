import type { LiveState } from "../types";

/** What the bubble looks like. One value per state the product requires (AGENTS.md section 4.6). */
export type BubbleMode = "inactive" | "recording" | "paused" | "processing" | "error";

export function bubbleMode(state: LiveState): BubbleMode {
  switch (state.status) {
    case "failed":
      return "error";
    case "live":
      return state.paused ? "paused" : "recording";
    case "connecting":
    case "stopping":
    case "reconnecting":
      return "processing";
    default:
      return "inactive"; // idle, or a finished session whose text can still be read
  }
}

const STATUS_LABEL: Record<LiveState["status"], string> = {
  idle: "Prêt",
  connecting: "Connexion…",
  live: "Enregistrement",
  reconnecting: "Reconnexion…",
  stopping: "Finalisation…",
  ended: "Terminé",
  failed: "Erreur",
};

export function statusLabel(state: LiveState): string {
  return state.status === "live" && state.paused ? "En pause" : STATUS_LABEL[state.status];
}

/** The microphone is open while recording or reconnecting (not paused, not finished). */
export function microphoneOpen(state: LiveState): boolean {
  return (state.status === "live" && !state.paused) || state.status === "reconnecting" || state.status === "connecting";
}

/** The last few lines of the transcript: the bubble is small, the main window shows everything. */
export function tail(state: LiveState, maxFinals = 3): { final: string; provisional: string } {
  return {
    final: state.finals.slice(-maxFinals).map((item) => item.text).join(" "),
    provisional: state.partial?.text ?? "",
  };
}
