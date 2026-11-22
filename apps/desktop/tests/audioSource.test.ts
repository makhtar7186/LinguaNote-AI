import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_SOURCES, DEFAULT_SOURCE, isAudioSourceKind, sourceLabel, usesMicrophone, usesSystemAudio,
} from "../src/services/audioSource";
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from "../src/services/capturePreferences";

describe("audio sources", () => {
  it("offers the three sources, the microphone being the default", () => {
    expect(AUDIO_SOURCES.map((option) => option.kind)).toEqual(["microphone", "system", "both"]);
    expect(DEFAULT_SOURCE).toBe("microphone");
  });

  it("knows which devices each source opens", () => {
    expect([usesMicrophone("microphone"), usesSystemAudio("microphone")]).toEqual([true, false]);
    expect([usesMicrophone("system"), usesSystemAudio("system")]).toEqual([false, true]);
    expect([usesMicrophone("both"), usesSystemAudio("both")]).toEqual([true, true]);
  });

  it("labels each source and falls back to the raw value for an unknown one", () => {
    expect(sourceLabel("system")).toBe("Son de l’ordinateur");
    expect(sourceLabel("nope" as never)).toBe("nope");
  });

  it("validates a source value", () => {
    expect(isAudioSourceKind("both")).toBe(true);
    for (const bad of ["Microphone", "", null, undefined, 3, {}]) expect(isAudioSourceKind(bad)).toBe(false);
  });

  it("warns about the echo of speakers for the combined source", () => {
    expect(AUDIO_SOURCES.find((option) => option.kind === "both")?.description).toMatch(/casque/);
  });
});

describe("capture preferences", () => {
  const storageWith = (value: string | null) => ({ getItem: () => value });

  it("reads a saved choice", () => {
    expect(loadPreferences(storageWith('{"source":"system","deviceId":"abc","language":"wo"}')))
      .toEqual({ source: "system", deviceId: "abc", language: "wo" });
  });

  it("reads a choice saved before the language existed as several languages", () => {
    expect(loadPreferences(storageWith('{"source":"system","deviceId":"abc"}')).language).toBe("auto");
  });

  it.each([['"de"'], ['42'], ['null'], ['"FR"']])("never imposes an unknown language (%s): several languages instead", (raw) => {
    expect(loadPreferences(storageWith(`{"source":"microphone","deviceId":"","language":${raw}}`)).language).toBe("auto");
  });

  it.each([
    [null], [""], ["not json"], ["null"], ["[]"], ['"system"'], ['{"source":"cloud"}'], ['{"source":42}'],
  ])("falls back to the microphone for %j rather than guessing a source", (raw) => {
    expect(loadPreferences(storageWith(raw)).source).toBe("microphone");
  });

  it("ignores a malformed or oversized device id", () => {
    expect(loadPreferences(storageWith('{"source":"both","deviceId":12}'))).toEqual({ source: "both", deviceId: "", language: "auto" });
    expect(loadPreferences(storageWith(JSON.stringify({ source: "both", deviceId: "x".repeat(600) })))).toMatchObject({ deviceId: "" });
  });

  it("survives storage that is missing or throws", () => {
    expect(loadPreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(loadPreferences({ getItem: () => { throw new Error("blocked"); } })).toEqual(DEFAULT_PREFERENCES);
    expect(() => savePreferences({ source: "system", deviceId: "", language: "auto" }, { setItem: () => { throw new Error("full"); } })).not.toThrow();
    expect(() => savePreferences({ source: "system", deviceId: "", language: "auto" }, undefined)).not.toThrow();
  });

  it("saves and reloads the choice", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { store.set(key, value); }) };
    savePreferences({ source: "both", deviceId: "mic-1", language: "fr" }, storage);
    expect(loadPreferences(storage)).toEqual({ source: "both", deviceId: "mic-1", language: "fr" });
  });
});
