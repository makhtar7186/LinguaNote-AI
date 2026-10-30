import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_RECORDING_SECONDS, useRecorder } from "./hooks/useRecorder";
import { getServiceHealth, transcribeFile } from "./services/transcriptionClient";
import type { ServiceHealth, TranscriptionResponse } from "./types";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDuration(totalSeconds: number) {
  return totalSeconds >= 60 ? `${Math.round(totalSeconds / 60)} min` : `${Math.round(totalSeconds)} s`;
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
    : `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

export default function App() {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<TranscriptionResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const maxBytes = health?.limits?.max_upload_bytes ?? DEFAULT_MAX_BYTES;

  const refreshHealth = useCallback(() => {
    void getServiceHealth().then(setHealth).catch(() => {
      setHealth({ ok: false, message: "Pont Electron indisponible" });
    });
  }, []);

  // Re-check periodically so the status recovers when the Python service starts after the UI.
  useEffect(() => {
    refreshHealth();
    const timer = window.setInterval(refreshHealth, 10_000);
    return () => window.clearInterval(timer);
  }, [refreshHealth]);

  async function submitAudio(audioFile: File) {
    if (audioFile.size > maxBytes) {
      setError(`Le fichier dépasse la limite de ${Math.round(maxBytes / (1024 * 1024))} Mio.`);
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const transcription = await transcribeFile(audioFile);
      setResult(transcription);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "La transcription a échoué.");
    } finally {
      setBusy(false);
    }
  }

  function chooseFile(selected: File | undefined) {
    setResult(null);
    setError("");
    setFile(selected ?? null);
  }

  const { recording, elapsed, start: startRecording, stop: stopRecording } = useRecorder({
    onRecorded: (recordedFile) => {
      setFile(recordedFile);
      void submitAudio(recordedFile);
    },
    onError: setError,
  });

  function beginRecording() {
    setError("");
    setResult(null);
    void startRecording();
  }

  async function copyTranscript() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
    } catch {
      setError("Copie impossible. Sélectionne le texte pour le copier manuellement.");
    }
  }

  const serviceLabel = health?.ok
    ? health.engine_selected ? `Moteur configuré · ${health.engine}` : "API prête · moteur absent"
    : health ? "Service local indisponible" : "Vérification du service…";

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="LinguaNote AI, accueil">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>LinguaNote <b>AI</b></span>
        </a>
        <div className={`service-pill ${health?.ok ? "online" : "offline"}`}>
          <span className="status-dot" />{serviceLabel}
        </div>
      </header>

      <section className="intro" id="top">
        <p className="eyebrow">ESPACE DE TRANSCRIPTION</p>
        <h1>Votre voix,<br /><span>en texte.</span></h1>
        <p className="intro-copy">Importez un fichier ou enregistrez quelques secondes au microphone.</p>
        <div className="language-row" aria-label="Langues à l’étude">
          <span>FR</span><span>EN</span><span>WO</span>
          <small>Français · English · Wolof en évaluation</small>
        </div>
      </section>

      <section className="workspace" aria-label="Nouvelle transcription">
        <div className="workspace-heading">
          <div>
            <p className="eyebrow">NOUVELLE TRANSCRIPTION</p>
            <h2>Choisissez votre audio</h2>
          </div>
          <span className="local-badge"><span aria-hidden="true">⌂</span> Traitement local</span>
        </div>

        {health && !health.ok && health.message && (
          <div className="notice error-notice" role="status">{health.message}</div>
        )}
        {health?.ok && health.ffmpeg_available === false && (
          <div className="notice error-notice" role="status">
            FFmpeg est introuvable : l’import de fichiers et l’enregistrement ne pourront pas être convertis.
          </div>
        )}
        {health?.ok && (
          <div className="notice setup-notice" role="status">
            {!health.engine_selected
              ? `${health.setup_message ?? "Aucun moteur ASR compatible n’est installé."} Le micro et l’import fonctionnent, mais la transcription reste indisponible.`
              : `Le modèle ${health.model ?? "Whisper base"} sera téléchargé lors de la première transcription. Le français et l’anglais sont pris en charge ; le wolof et les phrases mixtes restent à évaluer.`}
          </div>
        )}

        <button
          className="dropzone"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            chooseFile(event.dataTransfer.files[0]);
          }}
          disabled={busy || recording}
        >
          <span className="upload-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4.5 15v3.25c0 .69.56 1.25 1.25 1.25h12.5c.69 0 1.25-.56 1.25-1.25V15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </span>
          <strong>Glissez un fichier ici</strong>
          <span>ou <u>parcourez votre appareil</u></span>
          <small>Audio et vidéo · {Math.round(maxBytes / (1024 * 1024))} Mio max{health?.limits ? ` · audio < ${formatDuration(health.limits.max_audio_seconds)}` : ""}</small>
        </button>
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept="audio/*,video/*,.mp3,.m4a,.flac,.ogg,.opus,.wav,.mp4,.mov,.mkv,.webm,.wma,.aac"
          onChange={(event) => chooseFile(event.target.files?.[0])}
        />

        {file && !recording && (
          <div className="selected-file">
            <span className="file-icon" aria-hidden="true">♫</span>
            <div className="file-details"><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></div>
            {!busy && <button className="text-button" onClick={() => chooseFile(undefined)}>Retirer</button>}
          </div>
        )}

        <div className="divider"><span />OU ENREGISTREZ DIRECTEMENT<span /></div>

        <div className={`mic-card ${recording ? "is-recording" : ""}`}>
          <div className="mic-copy">
            <span className="mic-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.7"/><path d="M6 11.5a6 6 0 0012 0M12 17.5V21m-3 0h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
            </span>
            <div><strong>{recording ? "Enregistrement en cours" : "Enregistrer au microphone"}</strong><small>{recording ? `Arrêt automatique après ${formatDuration(MAX_RECORDING_SECONDS)}. L’audio est transcrit après l’arrêt.` : "Autorisez l’accès au micro pour commencer."}</small></div>
          </div>
          {recording ? (
            <button className="stop-button" onClick={stopRecording}><span /> Arrêter · {formatTime(elapsed)}</button>
          ) : (
            <button className="record-button" onClick={beginRecording} disabled={busy}>Enregistrer</button>
          )}
        </div>

        {file && !recording && (
          <button className="transcribe-button" onClick={() => void submitAudio(file)} disabled={busy}>
            {busy ? <><span className="spinner" /> Transcription…</> : "Transcrire le fichier"}
            {!busy && <span aria-hidden="true">→</span>}
          </button>
        )}

        {error && <div className="notice error-notice" role="alert">{error}</div>}

        {result && (
          <section className="result-card" aria-live="polite">
            <div className="result-heading"><div><p className="eyebrow">RÉSULTAT</p><h2>Transcription</h2></div><button className="text-button" onClick={() => void copyTranscript()}>Copier le texte</button></div>
            <p className="transcript-text">{result.text || "Aucun texte reconnu."}</p>
            <div className="result-meta">
              {result.engine} · {result.model}
              {result.language ? ` · langue estimée : ${result.language}${result.language_probability !== null ? ` (${Math.round(result.language_probability * 100)} %)` : ""}` : ""}
              {result.timing_available ? " · horodatages disponibles" : " · sans horodatage"}
            </div>
          </section>
        )}
      </section>

      <footer>LinguaNote AI <span>·</span> Prototype local · Traitement sur cet appareil</footer>
    </main>
  );
}
