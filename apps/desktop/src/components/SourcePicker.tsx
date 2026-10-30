import type { MicrophoneOption } from "../hooks/useCapturePreferences";
import { AUDIO_SOURCES, sourceLabel, usesMicrophone } from "../services/audioSource";
import type { AudioSourceKind } from "../types";

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

/** Which source a session listens to. Chosen here, shown while recording, never changed behind the user's back. */
export function SourcePicker({ source, deviceId, devices, systemAvailable, disabled, compact, onSource, onDevice }: Props) {
  const description = AUDIO_SOURCES.find((option) => option.kind === source)?.description ?? "";
  return (
    <div className={`source-picker ${compact ? "is-compact" : ""}`}>
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
      {!compact && <small className="source-help">{description}</small>}
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
