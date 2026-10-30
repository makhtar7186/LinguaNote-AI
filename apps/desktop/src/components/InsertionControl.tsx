import { useEffect, useState } from "react";
import type { InsertionStatus } from "../types";

const isRec = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The main process is the authority; anything that is not a well-formed status is ignored. */
export function parseInsertionStatus(value: unknown): InsertionStatus | null {
  if (!isRec(value) || !["off", "locking", "on", "paused"].includes(String(value.state))) return null;
  const target = isRec(value.target) && typeof value.target.title === "string" ? { title: value.target.title } : null;
  const problem = isRec(value.problem) && typeof value.problem.code === "string" && typeof value.problem.message === "string"
    ? { code: value.problem.code, message: value.problem.message } : null;
  return {
    supported: value.supported !== false,
    state: value.state as InsertionStatus["state"],
    target,
    pendingChars: typeof value.pendingChars === "number" ? value.pendingChars : 0,
    inserted: typeof value.inserted === "number" ? value.inserted : 0,
    problem,
  };
}

export function InsertionControl({ liveActive }: { liveActive: boolean }) {
  const bridge = window.linguaNote?.insertion;
  const [status, setStatus] = useState<InsertionStatus | null>(null);
  const [refusal, setRefusal] = useState("");

  useEffect(() => {
    if (!bridge) return undefined;
    let cancelled = false;
    void bridge.status().then((value) => { if (!cancelled) setStatus(parseInsertionStatus(value)); }, () => {});
    const off = bridge.onStatus((value) => {
      const parsed = parseInsertionStatus(value);
      if (parsed) setStatus((previous) => ({ ...parsed, supported: previous?.supported ?? true }));
    });
    return () => { cancelled = true; off(); };
  }, [bridge]);

  if (!bridge || !status || !status.supported) return null;

  async function arm() {
    setRefusal("");
    const answer = await bridge?.arm();
    // Cancelling the system confirmation is a choice, not an error.
    if (isRec(answer) && answer.ok === false && answer.code !== "declined") setRefusal(typeof answer.message === "string" ? answer.message : "Impossible d’activer l’insertion.");
  }

  const active = status.state !== "off";
  return (
    <div className="insertion-control" data-testid="insertion" aria-live="polite">
      {status.state === "off" && (
        <>
          <button className="text-button" onClick={() => void arm()} disabled={!liveActive}
            title="Après un court décompte, le texte validé est collé dans la fenêtre où vous aurez cliqué">
            Insérer le texte dans une autre application
          </button>
          {!liveActive && <small>Démarrez d’abord le direct.</small>}
        </>
      )}
      {status.state === "locking" && <strong>Cliquez maintenant dans l’application où écrire : la fenêtre au premier plan va être verrouillée…</strong>}
      {(status.state === "on" || status.state === "paused") && (
        <span>
          Insertion {status.state === "paused" ? "en pause" : "active"} dans <strong>{status.target?.title}</strong>
          {status.pendingChars > 0 ? ` · ${status.pendingChars} caractère(s) en attente` : ""}
        </span>
      )}
      {active && (
        <button className="text-button danger" onClick={() => void bridge.stop()}>Arrêter l’insertion</button>
      )}
      {(status.problem || refusal) && (
        <div className="notice error-notice" role="alert">{status.problem?.message ?? refusal}</div>
      )}
      <small className="insertion-note">
        Le texte est collé avec Ctrl+V dans la fenêtre verrouillée, et votre presse-papiers est remis en place ensuite.
        Une application lancée en administrateur peut ignorer cette insertion.
      </small>
    </div>
  );
}
