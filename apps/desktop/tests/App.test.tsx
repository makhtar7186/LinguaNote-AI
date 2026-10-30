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
