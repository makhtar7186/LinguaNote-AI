import { LANGUAGE_CHOICES, LANGUAGE_MODE_HELP, languageAvailable, languageModeLabel } from "../services/languageMode";
import type { LanguageMode } from "../types";
import { ChoiceButtons } from "./ChoiceButtons";

interface Props {
  value: LanguageMode;
  /** Languages the configured engine can impose (from /health); undefined while unknown. */
  available: readonly string[] | undefined;
  disabled?: boolean;
  compact?: boolean;
  onChange: (mode: LanguageMode) => void;
}

const UNAVAILABLE = "Indisponible avec le moteur configuré";

/** Several languages (detected) or one language imposed on the whole session or file. */
export function LanguagePicker({ value, available, disabled = false, compact = false, onChange }: Props) {
  const choices = LANGUAGE_CHOICES.map((choice) => {
    const usable = languageAvailable(choice.mode, available);
    return {
      value: choice.mode,
      label: compact ? choice.short : choice.label,
      disabled: !usable,
      title: usable ? `${choice.label} : ${LANGUAGE_MODE_HELP[choice.mode]}` : `${choice.label} : ${UNAVAILABLE}`,
    };
  });
  const usable = languageAvailable(value, available);
  return (
    <div className={`language-picker ${compact ? "is-compact" : ""}`}>
      <span className="source-label">Langue parlée</span>
      <ChoiceButtons label="Langue parlée" choices={choices} value={value} disabled={disabled} onChange={onChange} />
      {!usable && (
        <small className="language-warning" role="status">
          {languageModeLabel(value)} : {UNAVAILABLE.toLowerCase()}. Choisissez un autre mode.
        </small>
      )}
      {usable && !compact && <small className="source-help">{LANGUAGE_MODE_HELP[value]}</small>}
    </div>
  );
}
