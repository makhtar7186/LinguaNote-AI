import type { Segment } from "../types";

const LANGUAGE_LABELS: Record<string, string> = { fr: "Français", en: "Anglais", wo: "Wolof" };

/** One row per passage with its estimated language. Nothing is shown when the engine did not detect languages. */
export function LanguagePassages({ segments }: { segments: Segment[] }) {
  if (!segments.some((segment) => segment.language)) return null;
  return (
    <ol className="language-passages" aria-label="Passages par langue estimée">
      {segments.map((segment, index) => (
        <li key={`${segment.start_seconds}-${index}`}>
          <span className={`language-badge language-${segment.language ?? "unknown"}`}>
            {segment.language ? LANGUAGE_LABELS[segment.language] ?? segment.language : "Langue inconnue"}
          </span>
          <span>{segment.text}</span>
        </li>
      ))}
    </ol>
  );
}
