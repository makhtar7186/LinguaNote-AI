export interface Choice<T extends string> {
  value: T;
  label: string;
  title?: string;
  disabled?: boolean;
}

interface Props<T extends string> {
  label: string;
  choices: readonly Choice<T>[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}

/**
 * A single choice shown as buttons. Used instead of a drop-down list where the window cannot take the keyboard
 * focus (the bubble): Windows does not open a native list reliably there, plain buttons always work.
 */
export function ChoiceButtons<T extends string>({ label, choices, value, disabled = false, onChange }: Props<T>) {
  return (
    <div className="choice-group" role="radiogroup" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={choice.value === value}
          className={`choice${choice.value === value ? " is-selected" : ""}`}
          title={choice.title}
          disabled={disabled || choice.disabled}
          onClick={() => onChange(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}
