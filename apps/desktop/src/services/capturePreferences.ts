import type { AudioSourceKind, LanguageMode } from "../types";
import { DEFAULT_SOURCE, isAudioSourceKind } from "./audioSource";
import { isLanguageMode } from "./languageMode";

export interface CapturePreferences {
  source: AudioSourceKind;
  /** Microphone chosen by the user; empty means the system default. */
  deviceId: string;
  /** Several languages (detected) or one imposed language; applies to live sessions and imported files. */
  language: LanguageMode;
}

export const KEY = "linguanote.capture";
export const DEFAULT_PREFERENCES: CapturePreferences = { source: DEFAULT_SOURCE, deviceId: "", language: "auto" };

/**
 * Remembers the user's choice between launches. Browser storage can be blocked or hold anything, so every read is
 * validated and every failure falls back to the safe default (the microphone): a corrupted value never selects a
 * source the user did not choose.
 */
export function loadPreferences(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): CapturePreferences {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFERENCES;
    const { source, deviceId, language } = parsed as { source?: unknown; deviceId?: unknown; language?: unknown };
    return {
      source: isAudioSourceKind(source) ? source : DEFAULT_SOURCE,
      deviceId: typeof deviceId === "string" && deviceId.length <= 512 ? deviceId : "",
      language: isLanguageMode(language) ? language : "auto",
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(
  preferences: CapturePreferences,
  storage: Pick<Storage, "setItem"> | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(KEY, JSON.stringify(preferences));
  } catch {
    // Storage full or blocked: the choice simply is not remembered.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
