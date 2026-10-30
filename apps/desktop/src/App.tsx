import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveTranscription } from "./hooks/useLiveTranscription";
import { MAX_RECORDING_SECONDS, useRecorder } from "./hooks/useRecorder";
import { transcriptText } from "./services/liveReducer";
import { getServiceHealth, transcribeFile } from "./services/transcriptionClient";
import type { ServiceHealth, TranscriptionResponse } from "./types";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_ACCEPT = "audio/*,video/*,.mp3,.m4a,.flac,.ogg,.opus,.wav,.mp4,.mov,.mkv,.webm,.wma,.aac";

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDuration(totalSeconds: number) {
  return totalSeconds >= 60 ? `${Math.round(totalSeconds / 60)} min` : `${Math.round(totalSeconds)} s`;
}

const LIVE_STATUS_LABEL = {
  idle: "Prêt", connecting: "Connexion…", live: "En direct", reconnecting: "Reconnexion…",
  stopping: "Finalisation…", ended: "Terminé", failed: "Interrompu",
} as const;

const LIVE_END_REASON = {
  client_stop: "arrêt demandé", idle_timeout: "silence prolongé", max_duration: "durée maximale atteinte", error: "erreur",
} as const;

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
  const live = useLiveTranscription();
  const liveActive = ["connecting", "live", "reconnecting", "stopping"].includes(live.state.status);
  const liveText = transcriptText(live.state);
  const [bubbleNotice, setBubbleNotice] = useState("");
  const maxBytes = health?.limits?.max_upload_bytes ?? DEFAULT_MAX_BYTES;
  // The service is the source of truth for supported formats; the fallback only covers "service not reached yet".
  const acceptedExtensions = health?.limits?.extensions.length
    ? health.limits.extensions.join(",")
    : DEFAULT_ACCEPT;

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

  async function showBubble() {
    const answer = (await window.linguaNote?.bubble?.setVisible(true)) as { ok?: boolean; message?: string } | undefined;
    setBubbleNotice(answer?.ok === false && answer.message ? answer.message : "");
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
        <div className="topbar-actions">
          {window.linguaNote?.bubble && (
            <button className="text-button" onClick={() => void showBubble()} title="Affiche la bulle flottante au-dessus des autres applications">
              Afficher la bulle
            </button>
          )}
          <div className={`service-pill ${health?.ok ? "online" : "offline"}`}>
            <span className="status-dot" />{serviceLabel}
          </div>
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
          disabled={busy || recording || liveActive}
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
          accept={acceptedExtensions}
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
            <button className="record-button" onClick={beginRecording} disabled={busy || liveActive}>Enregistrer</button>
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

      <section className="workspace live-workspace" aria-label="Transcription en direct">
        <div className="workspace-heading">
          <div>
            <p className="eyebrow">TRANSCRIPTION EN DIRECT</p>
            <h2>Dictée en direct</h2>
          </div>
          <span className={`local-badge live-status live-${live.state.status}`} role="status">
            {live.state.status === "live" && live.state.paused ? "En pause" : LIVE_STATUS_LABEL[live.state.status]}
          </span>
        </div>

        {!live.supported && (
          <div className="notice setup-notice" role="status">
            Le direct nécessite l’application Electron : il n’est pas disponible dans l’aperçu navigateur.
          </div>
        )}

        <div className="mic-card live-card">
          <div className="mic-copy">
            <div>
              <strong>{liveActive ? "Écoute en cours" : "Parlez, le texte apparaît pendant que vous parlez"}</strong>
              <small>Le texte en gris est provisoire et peut changer ; il devient définitif à la fin de la phrase.</small>
            </div>
          </div>
          {liveActive ? (
            <div className="live-controls">
              {live.state.status === "live" && (
                <button className="text-button" onClick={() => void (live.state.paused ? live.resume() : live.pause())}>
                  {live.state.paused ? "Reprendre" : "Pause"}
                </button>
              )}
              <button className="stop-button" onClick={() => void live.stop()} disabled={live.state.status === "stopping"}>
                <span /> Arrêter
              </button>
            </div>
          ) : (
            <button className="record-button" onClick={() => void live.start()} disabled={!live.supported || busy || recording}>
              Démarrer le direct
            </button>
          )}
        </div>

        {(liveText.final || liveText.provisional || liveActive) && (
          <div className="result-card live-transcript-card" aria-live="polite">
            <p className="transcript-text live-transcript">
              {liveText.final}
              {liveText.provisional && <span className="live-provisional" data-testid="provisional"> {liveText.provisional}</span>}
              {!liveText.final && !liveText.provisional && <span className="live-placeholder">Parlez : le texte apparaît ici.</span>}
            </p>
            {live.state.status === "reconnecting" && (
              <div className="result-meta">Connexion au service perdue : reprise automatique, rien n’est perdu tant qu’elle réussit.</div>
            )}
            {live.state.status === "ended" && (
              <div className="result-meta">
                Session terminée ({LIVE_END_REASON[live.state.endReason as keyof typeof LIVE_END_REASON] ?? "terminée"}) ·{" "}
                {live.state.finals.length} passage(s)
                {live.state.engine ? ` · ${live.state.engine.name} ${live.state.engine.model}` : ""} · langue estimée par passage,
                wolof et phrases mixtes non validés
              </div>
            )}
          </div>
        )}

        {bubbleNotice && <div className="notice error-notice" role="alert">{bubbleNotice}</div>}

        {live.state.notices.map((notice, index) => (
          <div key={`${notice.code}-${index}`} className="notice error-notice" role="alert">{notice.message}</div>
        ))}

        {liveText.final && !liveActive && (
          <button className="text-button" onClick={() => void navigator.clipboard.writeText(liveText.final).catch(() => setError("Copie impossible. Sélectionne le texte pour le copier manuellement."))}>
            Copier le texte du direct
          </button>
        )}
      </section>

      <footer>LinguaNote AI <span>·</span> Prototype local · Traitement sur cet appareil</footer>
    </main>
  );
}
