import { useEffect, useState } from "react";
import { getServiceHealth } from "../services/transcriptionClient";
import type { SpokenLanguage } from "../types";

/**
 * Languages the single-language mode can use with the configured engine, asked again whenever `refreshKey` changes.
 * undefined while unknown (service not answering yet): nothing is greyed out on a guess.
 */
export function useServiceLanguages(refreshKey: unknown): SpokenLanguage[] | undefined {
  const [languages, setLanguages] = useState<SpokenLanguage[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    getServiceHealth()
      .then((health) => { if (!cancelled && health.ok) setLanguages(health.languages); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [refreshKey]);
  return languages;
}
