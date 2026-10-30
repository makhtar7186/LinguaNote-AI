import { useCallback, useEffect, useRef, useState } from "react";
import {
  HistoryError, RETENTION_CHOICES, deleteAllSessions, deleteSession, detailText, exportSession, getSession,
  getSettings, listSessions, renameSession, saveSettings, splitHighlights,
} from "../services/historyClient";
import { sourceLabel } from "../services/audioSource";
import type { HistoryExportFormat, HistorySessionDetail, HistorySessionSummary, HistorySettings } from "../types";

const FORMATS: { id: HistoryExportFormat; label: string }[] = [
  { id: "txt", label: "Texte" }, { id: "md", label: "Markdown" }, { id: "srt", label: "SRT" },
  { id: "vtt", label: "VTT" }, { id: "json", label: "JSON" },
];
const STATUS_LABEL = { recording: "en cours", complete: "terminée", interrupted: "interrompue" } as const;
const SEARCH_DELAY_MS = 250;

const messageOf = (error: unknown) => (error instanceof HistoryError || error instanceof Error ? error.message : "L’opération a échoué.");

function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function Highlighted({ snippet }: { snippet: string }) {
  return (
    <>{splitHighlights(snippet).map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : part.text))}</>
  );
}

export function HistoryPanel() {
  const [settings, setSettings] = useState<HistorySettings | null>(null);
  const [items, setItems] = useState<HistorySessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<HistorySessionDetail | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [confirmingAll, setConfirmingAll] = useState(false);
  const latestRequest = useRef(0);
  const latestDetail = useRef(0);

  const refresh = useCallback(async (search: string) => {
    const request = ++latestRequest.current;
    try {
      const page = await listSessions(search);
      if (request !== latestRequest.current) return; // a newer search is already on its way
      setItems(page.items);
      setTotal(page.total);
    } catch (failure) {
      if (request === latestRequest.current) setError(messageOf(failure));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSettings().then((loaded) => { if (!cancelled) setSettings(loaded); }, (failure) => { if (!cancelled) setError(messageOf(failure)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!settings) return undefined;
    const timer = window.setTimeout(() => void refresh(query), query ? SEARCH_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
  }, [settings, query, refresh]);

  async function run(action: () => Promise<void>, done = "") {
    setError("");
    setInfo("");
    try {
      await action();
      if (done) setInfo(done);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }

  const changeSettings = (enabled: boolean, retentionDays: number | null) => run(async () => {
    setSettings(await saveSettings(enabled, retentionDays));
    setOpen(null);
    await refresh(query);
  });

  const openSession = (id: string) => run(async () => {
    const request = ++latestDetail.current;
    const detail = await getSession(id);
    if (request !== latestDetail.current) return; // the user has clicked another session since
    setOpen(detail);
    setTitle(detail.title ?? "");
  });

  const rename = () => open && run(async () => {
    await renameSession(open.id, title);
    setOpen({ ...open, title: title.trim() });
    await refresh(query);
  }, "Titre enregistré.");

  const remove = () => open && run(async () => {
    await deleteSession(open.id);
    setOpen(null);
    await refresh(query);
  }, "Session supprimée.");

  const removeAll = () => run(async () => {
    await deleteAllSessions();
    setConfirmingAll(false);
    setOpen(null);
    await refresh(query);
  }, "Tout l’historique a été supprimé.");

  const copy = () => open && run(async () => {
    try {
      await navigator.clipboard.writeText(detailText(open));
    } catch {
      throw new Error("Copie impossible. Sélectionne le texte pour le copier manuellement.");
    }
  }, "Texte copié.");

  const exportAs = (format: HistoryExportFormat) => open && run(async () => {
    if (await exportSession(open.id, format)) setInfo("Fichier enregistré.");
  });

  return (
    <section className="workspace history-workspace" aria-label="Historique">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">HISTORIQUE</p>
          <h2>Transcriptions conservées</h2>
        </div>
        <span className="local-badge">{settings?.enabled ? "Activé" : "Désactivé"}</span>
      </div>

      <div className="history-settings">
        <label className="history-toggle">
          <input
            type="checkbox"
            checked={settings?.enabled ?? false}
            disabled={!settings}
            onChange={(event) => void changeSettings(event.target.checked, settings?.retentionDays ?? 30)}
          />
          <span>Conserver l’historique sur cet ordinateur</span>
        </label>
        <label className="history-retention">
          Durée de conservation
          <select
            value={String(settings?.retentionDays ?? "none")}
            disabled={!settings}
            onChange={(event) => void changeSettings(settings?.enabled ?? false, event.target.value === "none" ? null : Number(event.target.value))}
          >
            {RETENTION_CHOICES.map((choice) => (
              <option key={String(choice.days)} value={String(choice.days ?? "none")}>{choice.label}</option>
            ))}
          </select>
        </label>
        <p className="history-note">
          Désactivé par défaut. Quand il est activé, le texte des dictées et des fichiers est enregistré localement,
          sans chiffrement propre à l’application (il dépend de la protection de votre compte Windows). L’audio n’est jamais conservé.
        </p>
      </div>

      {error && <div className="notice error-notice" role="alert">{error}</div>}
      {info && <div className="notice" role="status">{info}</div>}

      {settings && (
        <>
          <input
            type="search"
            className="history-search"
            placeholder="Rechercher dans l’historique"
            aria-label="Rechercher dans l’historique"
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
          />
          {items.length === 0 ? (
            <p className="history-empty">
              {query ? "Aucun résultat." : settings.enabled ? "Rien n’a encore été enregistré." : "L’historique est désactivé : rien n’est enregistré."}
            </p>
          ) : (
            <ul className="history-list">
              {items.map((item) => (
                <li key={item.id}>
                  <button className="history-item" onClick={() => void openSession(item.id)} aria-current={open?.id === item.id}>
                    <strong>{item.title ?? (item.kind === "live" ? "Dictée en direct" : "Fichier audio")}</strong>
                    <small>
                      {formatDate(item.createdAt)} · {item.segmentCount} passage(s)
                      {item.source ? ` · ${sourceLabel(item.source)}` : ""} · {STATUS_LABEL[item.status]}
                    </small>
                    <span className="history-snippet">
                      {item.snippet ? <Highlighted snippet={item.snippet} /> : item.preview}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {total > items.length && <p className="history-empty">{total} sessions au total : affinez la recherche.</p>}
        </>
      )}

      {open && (
        <div className="result-card history-detail" aria-label="Session sélectionnée">
          <div className="history-rename">
            <input aria-label="Titre de la session" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
            <button className="text-button" onClick={() => void rename()} disabled={!title.trim()}>Renommer</button>
          </div>
          <p className="transcript-text">
            {open.segments.length ? open.segments.map((segment) => segment.text).join(" ") : "Aucun texte enregistré."}
          </p>
          {open.status === "interrupted" && (
            <div className="result-meta">Session interrompue : le texte peut être incomplet.</div>
          )}
          <div className="history-actions">
            <button className="text-button" onClick={() => void copy()}>Copier</button>
            {FORMATS.map((format) => (
              <button key={format.id} className="text-button" onClick={() => void exportAs(format.id)}>
                Exporter · {format.label}
              </button>
            ))}
            <button className="text-button danger" onClick={() => void remove()}>Supprimer</button>
          </div>
        </div>
      )}

      {total > 0 && (
        <div className="history-danger">
          {confirmingAll ? (
            <>
              <span>Supprimer définitivement les {total} sessions ? Cette action est irréversible.</span>
              <button className="text-button danger" onClick={() => void removeAll()}>Oui, tout supprimer</button>
              <button className="text-button" onClick={() => setConfirmingAll(false)}>Annuler</button>
            </>
          ) : (
            <button className="text-button danger" onClick={() => setConfirmingAll(true)}>Supprimer tout l’historique…</button>
          )}
        </div>
      )}
    </section>
  );
}
