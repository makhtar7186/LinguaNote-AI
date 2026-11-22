import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

const health = {
  ok: true, engine_selected: true, engine: "faster-whisper", model: "base", ffmpeg_available: true,
  limits: { max_upload_bytes: 52428800, max_audio_seconds: 600, extensions: [".wav"] },
};

function installBridge(transcribe: ReturnType<typeof vi.fn>, healthPayload: unknown = health) {
  window.linguaNote = { health: vi.fn().mockResolvedValue(healthPayload), transcribe } as unknown as Window["linguaNote"];
}

function chooseFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["abc"], "clip.wav", { type: "audio/wav" })] } });
}

beforeEach(() => {
  window.localStorage.clear();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => {
  cleanup();
  delete window.linguaNote;
});

describe("App", () => {
  it("shows the service state and configured limits", async () => {
    installBridge(vi.fn());
    render(<App />);
    expect(await screen.findByText(/Moteur configuré · faster-whisper/)).toBeTruthy();
    expect(screen.getByText(/audio < 10 min/)).toBeTruthy();
  });

  it("does not present a service that is still starting as a failure, and notices when it is ready", async () => {
    const starting = { ok: false, code: "starting", message: "Démarrage du service local…" };
    const healthCheck = vi.fn().mockResolvedValueOnce(starting).mockResolvedValue(health);
    window.linguaNote = { health: healthCheck, transcribe: vi.fn() } as unknown as Window["linguaNote"];
    render(<App />);

    const notice = await screen.findByText("Démarrage du service local…");
    expect(notice.className).not.toContain("error-notice");
    expect(screen.getByText("Démarrage du service…")).toBeTruthy();
    expect(screen.queryByText("Service local indisponible")).toBeNull();

    // Well before the 10 s of the regular check.
    expect(await screen.findByText(/Moteur configuré · faster-whisper/, undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText("Démarrage du service local…")).toBeNull();
  });

  it("shows a start that failed as an error", async () => {
    installBridge(vi.fn(), { ok: false, code: "backend_start_failed", message: "Le service local n'a pas démarré." });
    render(<App />);
    const notice = await screen.findByText("Le service local n'a pas démarré.");
    expect(notice.className).toContain("error-notice");
    expect(screen.getByText("Service local indisponible")).toBeTruthy();
  });

  it("warns when the service is unreachable", async () => {
    installBridge(vi.fn(), { ok: false, code: "service_unavailable", message: "Service local indisponible. Démarrez le service Python." });
    render(<App />);
    expect(await screen.findByText(/Démarrez le service Python/)).toBeTruthy();
  });

  it("warns when FFmpeg is missing", async () => {
    installBridge(vi.fn(), { ...health, ffmpeg_available: false });
    render(<App />);
    expect(await screen.findByText(/FFmpeg est introuvable/)).toBeTruthy();
  });

  it("transcribes a chosen file and renders text, estimated language and copy action", async () => {
    const transcribe = vi.fn().mockResolvedValue({
      ok: true,
      data: { text: "bonjour le monde", engine: "faster-whisper", model: "base", language: "fr", language_probability: 0.92 },
    });
    installBridge(transcribe);
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    chooseFile();
    fireEvent.click(await screen.findByText("Transcrire le fichier"));
    expect(await screen.findByText("bonjour le monde")).toBeTruthy();
    expect(screen.getByText(/langue estimée : fr \(92 %\)/)).toBeTruthy();
    fireEvent.click(screen.getByText("Copier le texte"));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("bonjour le monde"));
  });

  it("shows the backend error message as is", async () => {
    installBridge(vi.fn().mockResolvedValue({ ok: false, code: "audio_too_long", message: "Audio trop long." }));
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    chooseFile();
    fireEvent.click(await screen.findByText("Transcrire le fichier"));
    expect((await screen.findByRole("alert")).textContent).toBe("Audio trop long.");
  });

  it("reports that microphone recording is unavailable without MediaRecorder", async () => {
    installBridge(vi.fn());
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Enregistrer"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/pas disponible/);
  });
});

describe("spoken language and saving as text", () => {
  const result = { ok: true, data: { text: "naka nga def", engine: "language-router", model: "m", language: "wo" } };

  it("sends no language in the several-languages mode (the default)", async () => {
    const transcribe = vi.fn().mockResolvedValue(result);
    installBridge(transcribe);
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    expect(screen.getByRole("radio", { name: "Plusieurs langues" }).getAttribute("aria-checked")).toBe("true");
    chooseFile();
    fireEvent.click(await screen.findByText("Transcrire le fichier"));
    await waitFor(() => expect(transcribe).toHaveBeenCalled());
    expect(transcribe.mock.calls[0][0]).not.toHaveProperty("language");
  });

  it("imposes the chosen language on an imported file", async () => {
    const transcribe = vi.fn().mockResolvedValue(result);
    installBridge(transcribe, { ...health, engine: "language-routing", languages: ["fr", "en", "wo"] });
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByRole("radio", { name: "Wolof" }));
    chooseFile();
    fireEvent.click(await screen.findByText("Transcrire le fichier"));
    await waitFor(() => expect(transcribe).toHaveBeenCalled());
    expect(transcribe.mock.calls[0][0]).toMatchObject({ name: "clip.wav", language: "wo" });
  });

  it("greys out a language the configured engine cannot impose", async () => {
    installBridge(vi.fn(), { ...health, languages: ["en", "fr"] });
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    await waitFor(() => expect((screen.getByRole("radio", { name: "Wolof" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("radio", { name: "Français" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("saves the transcription as a .txt file through the application", async () => {
    installBridge(vi.fn().mockResolvedValue(result));
    const saveText = vi.fn().mockResolvedValue({ ok: true, saved: true });
    Object.assign(window.linguaNote!, { transcript: { saveText } });
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    chooseFile();
    fireEvent.click(await screen.findByText("Transcrire le fichier"));
    fireEvent.click(await screen.findByText("Enregistrer en .txt"));
    await waitFor(() => expect(saveText).toHaveBeenCalledWith("naka nga def"));
    expect(await screen.findByText("Fichier texte enregistré.")).toBeTruthy();
  });

  it("says nothing was saved when the user cancels, and shows a write failure", async () => {
    installBridge(vi.fn().mockResolvedValue(result));
    const saveText = vi.fn()
      .mockResolvedValueOnce({ ok: true, saved: false })
      .mockResolvedValueOnce({ ok: false, code: "write_failed", message: "Le fichier n'a pas pu être écrit." });
    Object.assign(window.linguaNote!, { transcript: { saveText } });
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    chooseFile();
    fireEvent.click(await screen.findByText("Transcrire le fichier"));
    fireEvent.click(await screen.findByText("Enregistrer en .txt"));
    await waitFor(() => expect(saveText).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Fichier texte enregistré.")).toBeNull();
    fireEvent.click(screen.getByText("Enregistrer en .txt"));
    expect(await screen.findByText("Le fichier n'a pas pu être écrit.")).toBeTruthy();
  });
});
