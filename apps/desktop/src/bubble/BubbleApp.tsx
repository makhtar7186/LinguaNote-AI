import { useCallback, useEffect, useState } from "react";
import { LanguagePicker } from "../components/LanguagePicker";
import { LevelMeter, SilenceWarning, SourcePicker } from "../components/SourcePicker";
import { useCapturePreferences, useMicrophones } from "../hooks/useCapturePreferences";
import { useLiveTranscription } from "../hooks/useLiveTranscription";
import { useServiceLanguages } from "../hooks/useServiceLanguages";
import { sourceLabel } from "../services/audioSource";
import { languageAvailable, requestedLanguage } from "../services/languageMode";
import { transcriptText } from "../services/liveReducer";
import { saveTranscriptText } from "../services/transcriptFile";
import type { ShortcutReport } from "../types";
import { bubbleMode, statusLabel, tail } from "./bubbleMode";

const SHORTCUT_LABEL: Record<string, string> = {
  toggleLive: "démarrer / arrêter", pauseLive: "pause / reprise", toggleBubble: "afficher / masquer la bulle",
};

function parseShortcutReport(value: unknown): ShortcutReport | null {
  if (typeof value !== "object" || value === null) return null;
  const { registered, failed } = value as Partial<ShortcutReport>;
  if (!Array.isArray(registered) || !Array.isArray(failed)) return null;
  return { registered, failed };
}

const prettyKey = (accelerator: string) => accelerator.replace("CommandOrControl", "Ctrl").replace("Space", "Espace");

export default function BubbleApp() {
  const preferences = useCapturePreferences();
  // A shortcut starts a session with this window's own current choice: shown in the panel, never implicit.
  const language = requestedLanguage(preferences.language);
  const live = useLiveTranscription({
    handleCommands: true,
    defaultStart: { source: preferences.source, deviceId: preferences.deviceId, language },
  });
  const microphones = useMicrophones(live.state.status);
  const [openedByUser, setOpenedByUser] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [shortcuts, setShortcuts] = useState<ShortcutReport | null>(null);
  const [refusal, setRefusal] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const mode = bubbleMode(live.state);
  const text = tail(live.state);
  const bubbleApi = window.linguaNote?.bubble;

  // An error must be readable: the panel opens by itself until the user has seen it and collapses it.
  const errorKey = `${live.state.notices.length}:${live.state.endReason ?? ""}`;
  const expanded = openedByUser || (mode === "error" && dismissedError !== errorKey);
  const collapse = useCallback(() => {
    setOpenedByUser(false);
    setDismissedError(errorKey);
  }, [errorKey]);

  // The window itself is resized by the main process; the page only says which size it needs.
  useEffect(() => {
    void bubbleApi?.setExpanded(expanded);
  }, [expanded, bubbleApi]);

  // Asked again each time the panel opens: the service may have finished starting since.
  const languages = useServiceLanguages(expanded);
  const languageUsable = languageAvailable(preferences.language, languages);

  async function saveText() {
    setSaveMessage("");
    try {
      const outcome = await saveTranscriptText(transcriptText(live.state).final);
      if (outcome === "saved") setSaveMessage("Fichier texte enregistré.");
    } catch (cause) {
      setSaveMessage(cause instanceof Error ? cause.message : "L’enregistrement a échoué.");
    }
  }

  useEffect(() => {
    void window.linguaNote?.shortcuts?.getReport().then((report) => setShortcuts(parseShortcutReport(report))).catch(() => undefined);
  }, []);

  async function hide() {
    const answer = await bubbleApi?.setVisible(false);
    const message = (answer as { ok?: boolean; message?: string } | undefined)?.message;
    setRefusal(message && (answer as { ok?: boolean }).ok === false ? message : "");
  }

  const live_ = ["live", "reconnecting", "connecting", "stopping"].includes(live.state.status);

  if (!expanded) {
    return (
      <div className="bubble bubble-collapsed" data-testid="bubble" data-mode={mode} role="status" aria-label={statusLabel(live.state)}>
        <button className="bubble-core" onClick={() => setOpenedByUser(true)} aria-label={`LinguaNote — ${statusLabel(live.state)}. Ouvrir`}>
          <svg className="bubble-glyph" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
        {mode === "recording" && <span className="rec-dot" aria-hidden="true" />}
      </div>
    );
  }

  return (
    <div className="bubble bubble-panel" data-testid="bubble" data-mode={mode}>
      <header className="bubble-header">
        <span className="bubble-indicator" aria-hidden="true" />
        <strong role="status">{statusLabel(live.state)}</strong>
        <span className="bubble-spacer" />
        <button className="bubble-icon" onClick={collapse} aria-label="Réduire">–</button>
        <button className="bubble-icon" onClick={() => void hide()} aria-label="Masquer la bulle">×</button>
      </header>

      {live_ && live.state.source && (
        <div className="bubble-source" data-testid="active-source">
          <span>{sourceLabel(live.state.source)}</span>
          <LevelMeter level={live.level} label={sourceLabel(live.state.source)} />
        </div>
      )}
      {live.silent && live.state.source && <SilenceWarning source={live.state.source} />}
      {!live_ && (
        <>
          <SourcePicker
            compact
            source={preferences.source}
            deviceId={preferences.deviceId}
            devices={microphones}
            systemAvailable={Boolean(window.linguaNote?.capture)}
            disabled={false}
            onSource={preferences.setSource}
            onDevice={preferences.setDeviceId}
          />
          <LanguagePicker compact value={preferences.language} available={languages} onChange={preferences.setLanguage} />
        </>
      )}

      <p className="bubble-transcript" aria-live="polite">
        {text.final}
        {text.provisional && <span className="bubble-provisional" data-testid="provisional"> {text.provisional}</span>}
        {!text.final && !text.provisional && (
          <span className="bubble-placeholder">{live_ ? "Parlez : le texte apparaît ici." : "Prêt à écouter."}</span>
        )}
      </p>

      {live.state.notices.slice(-2).map((notice, index) => (
        <p key={`${notice.code}-${index}`} className="bubble-notice" role="alert">{notice.message}</p>
      ))}
      {refusal && <p className="bubble-notice" role="alert">{refusal}</p>}
      {saveMessage && <p className="bubble-info" role="status">{saveMessage}</p>}

      <div className="bubble-controls">
        {!live_ ? (
          <>
            <button
              className="bubble-primary"
              onClick={() => void live.start({ source: preferences.source, deviceId: preferences.deviceId, language })}
              disabled={!live.supported || !languageUsable}
            >
              Démarrer
            </button>
            {live.state.finals.length > 0 && (
              <button className="bubble-secondary" onClick={() => void saveText()} title="Enregistrer tout le texte de la session dans un fichier .txt">
                Enregistrer .txt
              </button>
            )}
          </>
        ) : (
          <>
            {live.state.status === "live" && (
              <button className="bubble-secondary" onClick={() => void (live.state.paused ? live.resume() : live.pause())}>
                {live.state.paused ? "Reprendre" : "Pause"}
              </button>
            )}
            <button className="bubble-danger" onClick={() => void live.stop()} disabled={live.state.status === "stopping"}>
              Arrêter
            </button>
          </>
        )}
      </div>

      <footer className="bubble-hints">
        {shortcuts?.registered.map((item) => (
          <span key={item.name}><kbd>{prettyKey(item.accelerator)}</kbd> {SHORTCUT_LABEL[item.name] ?? item.name}</span>
        ))}
        {shortcuts?.failed.filter((item) => item.reason !== "disabled").map((item) => (
          <span key={item.name} className="bubble-warning">Raccourci « {SHORTCUT_LABEL[item.name] ?? item.name} » indisponible (déjà utilisé ?)</span>
        ))}
      </footer>
    </div>
  );
}
