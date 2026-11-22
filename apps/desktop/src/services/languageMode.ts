import type { LanguageMode, SpokenLanguage } from "../types";

export interface LanguageChoice {
  mode: LanguageMode;
  label: string;
  /** For the small bubble. */
  short: string;
}

export const LANGUAGE_CHOICES: readonly LanguageChoice[] = [
  { mode: "auto", label: "Plusieurs langues", short: "Auto" },
  { mode: "fr", label: "Français", short: "FR" },
  { mode: "en", label: "English", short: "EN" },
  { mode: "wo", label: "Wolof", short: "WO" },
];

export const SPOKEN_LANGUAGES: readonly SpokenLanguage[] = ["fr", "en", "wo"];

export function isSpokenLanguage(value: unknown): value is SpokenLanguage {
  return value === "fr" || value === "en" || value === "wo";
}

export function isLanguageMode(value: unknown): value is LanguageMode {
  return value === "auto" || isSpokenLanguage(value);
}

/** What is sent to the service: nothing for several languages, otherwise the imposed language. */
export function requestedLanguage(mode: LanguageMode): SpokenLanguage | undefined {
  return mode === "auto" ? undefined : mode;
}

export function languageModeLabel(mode: LanguageMode): string {
  return LANGUAGE_CHOICES.find((choice) => choice.mode === mode)?.label ?? mode;
}

/**
 * Whether the configured engine can impose this language. `available` is what /health reported; when the service has
 * not answered yet the choice is left open (the service still refuses, with a message, what it cannot do).
 */
export function languageAvailable(mode: LanguageMode, available: readonly string[] | undefined): boolean {
  return mode === "auto" || available === undefined || available.includes(mode);
}

export const LANGUAGE_MODE_HELP: Record<LanguageMode, string> = {
  auto: "La langue est détectée passage par passage. Un changement de langue au milieu d’une phrase est souvent mal reconnu.",
  fr: "Tout est transcrit en français : une autre langue parlée sera mal transcrite, voire traduite.",
  en: "Tout est transcrit en anglais : une autre langue parlée sera mal transcrite, voire traduite.",
  wo: "Tout est transcrit par le modèle wolof : le français ou l’anglais parlés seront mal transcrits.",
};
