import type {
  HistoryBridge, HistoryExportFormat, HistorySessionDetail, HistorySessionSummary, HistorySettings,
} from "../types";

export class HistoryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null;
const str = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export const RETENTION_CHOICES: { days: number | null; label: string }[] = [
  { days: 7, label: "7 jours" },
  { days: 30, label: "30 jours" },
  { days: 90, label: "90 jours" },
  { days: 365, label: "1 an" },
  { days: null, label: "Sans limite" },
];

const KINDS = ["live", "file"];
const SOURCES = ["microphone", "system", "both"];
const STATUSES = ["recording", "complete", "interrupted"];

function invalid(): never {
  throw new HistoryError("invalid_response", "Réponse invalide du service.");
}

export function parseSettings(value: unknown): HistorySettings {
  if (!isRec(value) || typeof value.enabled !== "boolean") invalid();
  const days = value.retention_days === null ? null : num(value.retention_days);
  if (value.retention_days !== null && days === null) invalid();
  return { enabled: value.enabled, retentionDays: days };
}

function parseSummary(value: unknown): HistorySessionSummary {
  if (!isRec(value) || typeof value.id !== "string" || typeof value.created_at !== "string") invalid();
  const kind = str(value.kind);
  const status = str(value.status);
  if (!kind || !KINDS.includes(kind) || !status || !STATUSES.includes(status)) invalid();
  const source = str(value.source);
  return {
    id: value.id,
    kind: kind as HistorySessionSummary["kind"],
    source: source && SOURCES.includes(source) ? (source as HistorySessionSummary["source"]) : null,
    status: status as HistorySessionSummary["status"],
    title: str(value.title),
    createdAt: value.created_at,
    durationSeconds: num(value.duration_seconds),
    engine: str(value.engine),
    model: str(value.model),
    segmentCount: num(value.segment_count) ?? 0,
    preview: str(value.preview),
    snippet: str(value.snippet),
  };
}

export function parseList(value: unknown): { items: HistorySessionSummary[]; total: number } {
  if (!isRec(value) || !Array.isArray(value.items)) invalid();
  return { items: value.items.map(parseSummary), total: num(value.total) ?? value.items.length };
}

export function parseDetail(value: unknown): HistorySessionDetail {
  if (!isRec(value) || !Array.isArray(value.segments)) invalid();
  return {
    ...parseSummary(value),
    segments: value.segments.map((segment) => {
      if (!isRec(segment) || typeof segment.text !== "string") invalid();
      return {
        text: segment.text,
        startSeconds: num(segment.start_seconds),
        endSeconds: num(segment.end_seconds),
        language: str(segment.language),
        languageProbability: num(segment.language_probability),
      };
    }),
  };
}

function bridge(): HistoryBridge {
  const history = window.linguaNote?.history;
  if (!history) throw new HistoryError("bridge_unavailable", "L’historique nécessite l’application Electron.");
  return history;
}

/** Unwraps the `{ok}` envelope of the bridge: failures become a HistoryError carrying the service's message. */
async function call(promise: Promise<unknown>): Promise<unknown> {
  const answer = await promise;
  if (!isRec(answer) || typeof answer.ok !== "boolean") invalid();
  if (!answer.ok) throw new HistoryError(str(answer.code) ?? "unknown", str(answer.message) ?? "L’opération a échoué.");
  return answer;
}

export async function getSettings(): Promise<HistorySettings> {
  return parseSettings((await call(bridge().getSettings()) as Rec).data);
}

export async function saveSettings(enabled: boolean, retentionDays: number | null): Promise<HistorySettings> {
  return parseSettings((await call(bridge().setSettings(enabled, retentionDays)) as Rec).data);
}

export async function listSessions(query: string): Promise<{ items: HistorySessionSummary[]; total: number }> {
  return parseList((await call(bridge().list({ query })) as Rec).data);
}

export async function getSession(id: string): Promise<HistorySessionDetail> {
  return parseDetail((await call(bridge().get(id)) as Rec).data);
}

export async function renameSession(id: string, title: string): Promise<void> {
  await call(bridge().rename(id, title));
}

export async function deleteSession(id: string): Promise<void> {
  await call(bridge().remove(id));
}

export async function deleteAllSessions(): Promise<void> {
  await call(bridge().removeAll(true));
}

/** Resolves to false when the user cancelled the save dialog. */
export async function exportSession(id: string, format: HistoryExportFormat): Promise<boolean> {
  return (await call(bridge().export(id, format)) as Rec).saved === true;
}

const START = "\x02";
const END = "\x03";

/** Splits a search snippet into plain and highlighted parts. Rendered as text nodes: no HTML is ever interpreted. */
export function splitHighlights(snippet: string): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  let match = false;
  for (const piece of snippet.split(new RegExp(`([${START}${END}])`))) {
    if (piece === START) match = true;
    else if (piece === END) match = false;
    else if (piece) parts.push({ text: piece, match });
  }
  return parts;
}

export function detailText(detail: HistorySessionDetail): string {
  return detail.segments.map((segment) => segment.text).join("\n");
}
