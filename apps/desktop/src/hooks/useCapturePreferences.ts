import { useCallback, useEffect, useState } from "react";
import { type CapturePreferences, loadPreferences, savePreferences } from "../services/capturePreferences";
import type { AudioSourceKind } from "../types";

/** The source and microphone the user picked, remembered between launches. */
export function useCapturePreferences() {
  const [preferences, setPreferences] = useState<CapturePreferences>(() => loadPreferences());

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
    setSource: useCallback((source: AudioSourceKind) => update({ source }), [update]),
    setDeviceId: useCallback((deviceId: string) => update({ deviceId }), [update]),
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
