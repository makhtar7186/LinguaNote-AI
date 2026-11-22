import { useCallback, useEffect, useState } from "react";
import { type CapturePreferences, KEY, loadPreferences, savePreferences } from "../services/capturePreferences";
import type { AudioSourceKind, LanguageMode } from "../types";

/**
 * The source, microphone and language the user picked, remembered between launches. The main window and the bubble
 * share them: a choice made in one window is shown in the other at once (the "storage" event reaches every other
 * window of the application), so the bubble never starts a session with a choice the user already changed elsewhere.
 */
export function useCapturePreferences() {
  const [preferences, setPreferences] = useState<CapturePreferences>(() => loadPreferences());

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) setPreferences(loadPreferences());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((patch: Partial<CapturePreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      savePreferences(next);
      return next;
    });
  }, []);

  return {
    source: preferences.source,
    deviceId: preferences.deviceId,
    language: preferences.language,
    setSource: useCallback((source: AudioSourceKind) => update({ source }), [update]),
    setDeviceId: useCallback((deviceId: string) => update({ deviceId }), [update]),
    setLanguage: useCallback((language: LanguageMode) => update({ language }), [update]),
  };
}

export interface MicrophoneOption {
  id: string;
  label: string;
}

/**
 * The microphones the system offers. Labels are empty until the user has granted access once, so the list is
 * refreshed when `refreshKey` changes (e.g. when a session starts) and when devices are plugged or unplugged.
 */
export function useMicrophones(refreshKey: unknown): MicrophoneOption[] {
  const [devices, setDevices] = useState<MicrophoneOption[]>([]);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return undefined;
    let cancelled = false;
    const refresh = () => {
      media.enumerateDevices().then((all) => {
        if (cancelled) return;
        setDevices(
          all.filter((device) => device.kind === "audioinput" && device.deviceId !== "default" && device.deviceId !== "communications")
            .map((device, index) => ({ id: device.deviceId, label: device.label || `Microphone ${index + 1}` })),
        );
      }).catch(() => undefined);
    };
    refresh();
    media.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      media.removeEventListener?.("devicechange", refresh);
    };
  }, [refreshKey]);

  return devices;
}
