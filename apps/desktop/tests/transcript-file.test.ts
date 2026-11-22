import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { nextDevice } from "../src/components/SourcePicker";
import { languageAvailable, requestedLanguage } from "../src/services/languageMode";

const file = createRequire(import.meta.url)("../electron/transcript-file.cjs");

describe("saving a transcript as .txt (main process rules)", () => {
  it("refuses what is not text, empty text and absurdly long text", () => {
    expect(file.validateText(42)).toMatchObject({ ok: false, code: "invalid_argument" });
    expect(file.validateText("   ")).toMatchObject({ ok: false, code: "empty_text" });
    expect(file.validateText("a".repeat(file.MAX_TEXT_CHARS + 1))).toMatchObject({ ok: false, code: "text_too_large" });
    expect(file.validateText("Naka nga def ?")).toEqual({ ok: true, text: "Naka nga def ?" });
  });

  it("proposes a dated name without reserved characters", () => {
    const name = file.defaultName(new Date(2026, 10, 22, 9, 5));
    expect(name).toBe("Transcription 2026-11-22 09h05.txt");
    expect(name).not.toMatch(/[<>:"/\\|?*]/);
  });

  it("always writes a .txt file", () => {
    expect(file.withTxtExtension("C:\\Docs\\notes")).toBe("C:\\Docs\\notes.txt");
    expect(file.withTxtExtension("C:\\Docs\\notes.TXT")).toBe("C:\\Docs\\notes.TXT");
  });

  it("writes UTF-8 with a byte order mark and Windows line endings, keeping Wolof letters", () => {
    expect(file.content("Jërëjëf ñaari\nwaxtaan  ")).toBe("\uFEFFJërëjëf ñaari\r\nwaxtaan\r\n");
  });
});

describe("language mode", () => {
  it("sends nothing for several languages, the language otherwise", () => {
    expect(requestedLanguage("auto")).toBeUndefined();
    expect(requestedLanguage("wo")).toBe("wo");
  });

  it("leaves every choice open while the service has not said what it supports", () => {
    expect(languageAvailable("wo", undefined)).toBe(true);
    expect(languageAvailable("wo", ["fr", "en"])).toBe(false);
    expect(languageAvailable("auto", [])).toBe(true);
  });
});

describe("microphone choice in the bubble", () => {
  const devices = [{ id: "a", label: "Casque" }, { id: "b", label: "Webcam" }];

  it("cycles from the system default through every microphone and back", () => {
    expect(nextDevice("", devices)).toBe("a");
    expect(nextDevice("a", devices)).toBe("b");
    expect(nextDevice("b", devices)).toBe("");
  });

  it("starts over at the default when the chosen microphone was unplugged", () => {
    expect(nextDevice("gone", devices)).toBe("");
  });
});
