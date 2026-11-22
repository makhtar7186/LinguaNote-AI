import type { MicrophoneOption } from "../hooks/useCapturePreferences";
import { AUDIO_SOURCES, sourceLabel, usesMicrophone } from "../services/audioSource";
import type { AudioSourceKind } from "../types";
import { ChoiceButtons } from "./ChoiceButtons";

interface Props {
  source: AudioSourceKind;
  deviceId: string;
  devices: MicrophoneOption[];
  /** The computer sound needs the Electron app (and Windows); in the browser preview it cannot be offered. */
  systemAvailable: boolean;
  disabled: boolean;
  compact?: boolean;
  onSource: (source: AudioSourceKind) => void;
  onDevice: (deviceId: string) => void;
}

const SHORT_LABEL: Record<AudioSourceKind, string> = { microphone: "Micro", system: "Ordinateur", both: "Les deux" };

/** The next microphone in the list ("" = system default first), for the one-button picker of the bubble. */
export function nextDevice(current: string, devices: MicrophoneOption[]): string {
  const order = ["", ...devices.map((device) => device.id)];
  const index = order.indexOf(current);
  return order[(index + 1) % order.length] ?? "";
}

/** Which source a session listens to. Chosen here, shown while recording, never changed behind the user's back. */
export function SourcePicker(props: Props) {
  return props.compact ? <CompactSourcePicker {...props} /> : <FullSourcePicker {...props} />;
}

/**
 * The bubble cannot take the keyboard focus (it must not steal it from the document being dictated into), and a
 * drop-down list does not open reliably in such a window on Windows: everything here is a plain button.
 */
function CompactSourcePicker({ source, deviceId, devices, systemAvailable, disabled, onSource, onDevice }: Props) {
  const choices = AUDIO_SOURCES.map((option) => {
    const unavailable = !systemAvailable && option.kind !== "microphone";
    return {
      value: option.kind,
      label: SHORT_LABEL[option.kind],
      disabled: unavailable,
      title: unavailable ? `${option.label} : indisponible ici` : `${option.label} : ${option.description}`,
    };
  });
  const current = devices.find((device) => device.id === deviceId)?.label ?? "Par défaut du système";
  return (
    <div className="source-picker is-compact">
      <span className="source-label">Source audio</span>
      <ChoiceButtons label="Source audio" choices={choices} value={source} disabled={disabled} onChange={onSource} />
      {usesMicrophone(source) && devices.length > 0 && (
        <button
          type="button"
          className="device-cycle"
          disabled={disabled}
          title="Passer au microphone suivant"
          aria-label={`Microphone : ${current}. Passer au suivant`}
          onClick={() => onDevice(nextDevice(deviceId, devices))}
        >
          <span className="device-name">Micro : {current}</span>
          <span aria-hidden="true">⟳</span>
        </button>
      )}
    </div>
  );
}

function FullSourcePicker({ source, deviceId, devices, systemAvailable, disabled, onSource, onDevice }: Props) {
  const description = AUDIO_SOURCES.find((option) => option.kind === source)?.description ?? "";
  return (
    <div className="source-picker">
      <label>
        <span className="source-label">Source audio</span>
        <select value={source} disabled={disabled} onChange={(event) => onSource(event.target.value as AudioSourceKind)}>
          {AUDIO_SOURCES.map((option) => {
            const unavailable = !systemAvailable && option.kind !== "microphone";
            return (
              <option key={option.kind} value={option.kind} disabled={unavailable}>
                {option.label}{unavailable ? " (indisponible ici)" : ""}
              </option>
            );
          })}
        </select>
      </label>
      {usesMicrophone(source) && devices.length > 0 && (
        <label>
          <span className="source-label">Microphone</span>
          <select value={deviceId} disabled={disabled} onChange={(event) => onDevice(event.target.value)}>
            <option value="">Par défaut du système</option>
            {devices.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
          </select>
        </label>
      )}
      <small className="source-help">{description}</small>
    </div>
  );
}

/** Ten-step level bar: proof that the chosen source is delivering sound. */
export function LevelMeter({ level, label }: { level: number; label: string }) {
  return (
    <div
      className="level-meter"
      role="meter"
      aria-label={`Niveau sonore de ${label}`}
      aria-valuemin={0}
      aria-valuemax={10}
      aria-valuenow={level}
    >
      {Array.from({ length: 10 }, (_unused, index) => <span key={index} className={index < level ? "on" : ""} />)}
    </div>
  );
}

export function SilenceWarning({ source }: { source: AudioSourceKind }) {
  return (
    <p className="notice setup-notice" role="status">
      Aucun son reçu de « {sourceLabel(source)} » depuis plusieurs secondes.{" "}
      {source === "microphone"
        ? "Vérifiez le microphone choisi et son volume."
        : "Vérifiez que quelque chose est en cours de lecture et que le volume de l’ordinateur n’est pas coupé."}
    </p>
  );
}
