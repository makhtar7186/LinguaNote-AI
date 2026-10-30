import type { AudioSourceKind } from "../types";

export interface AudioSourceOption {
  kind: AudioSourceKind;
  label: string;
  description: string;
}

/** The three sources a session can listen to. Imported files are a separate feature (they are not live). */
export const AUDIO_SOURCES: readonly AudioSourceOption[] = [
  { kind: "microphone", label: "Microphone", description: "Votre voix." },
  {
    kind: "system", label: "Son de l’ordinateur",
    description: "Ce que l’ordinateur joue : une vidéo, une réunion en ligne (les autres participants). Windows uniquement.",
  },
  {
    kind: "both", label: "Microphone + son de l’ordinateur",
    description: "Une réunion : votre voix et celle des autres. Utilisez un casque, sinon le micro reprend le son des haut-parleurs.",
  },
];

export const DEFAULT_SOURCE: AudioSourceKind = "microphone";

export function isAudioSourceKind(value: unknown): value is AudioSourceKind {
  return value === "microphone" || value === "system" || value === "both";
}

export function sourceLabel(kind: AudioSourceKind): string {
  return AUDIO_SOURCES.find((option) => option.kind === kind)?.label ?? kind;
}

export const usesMicrophone = (kind: AudioSourceKind) => kind === "microphone" || kind === "both";
export const usesSystemAudio = (kind: AudioSourceKind) => kind === "system" || kind === "both";
