import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { startMicCapture } from "../src/services/micCapture";

vi.mock("../src/services/micCapture", () => ({ startMicCapture: vi.fn() }));

const health = {
  ok: true, engine_selected: true, engine: "faster-whisper", model: "base", ffmpeg_available: true,
  limits: { max_upload_bytes: 52428800, max_audio_seconds: 600, extensions: [".wav"] },
};

interface Harness {
  emit: (event: unknown) => void;
  live: { start: ReturnType<typeof vi.fn>; sendAudio: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onEvent: ReturnType<typeof vi.fn> };
  unsubscribe: ReturnType<typeof vi.fn>;
  micStop: ReturnType<typeof vi.fn>;
  pushFrame: (bytes?: number) => void;
}

function install(overrides: { start?: ReturnType<typeof vi.fn>; withLive?: boolean } = {}): Harness {
  let listener: (event: unknown) => void = () => {};
  const unsubscribe = vi.fn();
  const live = {
    start: overrides.start ?? vi.fn().mockResolvedValue({ ok: true }),
    sendAudio: vi.fn(),
    stop: vi.fn().mockResolvedValue({ ok: true }),
    onEvent: vi.fn((callback: (event: unknown) => void) => { listener = callback; return unsubscribe; }),
  };
  window.linguaNote = {
    health: vi.fn().mockResolvedValue(health), transcribe: vi.fn(), ...(overrides.withLive === false ? {} : { live }),
  } as unknown as Window["linguaNote"];

  const micStop = vi.fn();
  let onFrame: (pcm: Uint8Array) => void = () => {};
  vi.mocked(startMicCapture).mockImplementation(async (callback) => {
    onFrame = callback;
    return { stop: micStop };
  });
  return {
    emit: (event) => act(() => listener(event)), live, unsubscribe, micStop,
    pushFrame: (bytes = 3200) => onFrame(new Uint8Array(bytes)),
  };
}

const final = (id: number, text: string, eventId: number) => ({
  type: "final", event_id: eventId, utterance_id: id, text, start_seconds: 0, end_seconds: 1,
  language: "fr", language_probability: 0.9,
});

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.mocked(startMicCapture).mockReset();
});

afterEach(() => {
  cleanup();
  delete window.linguaNote;
});

describe("live panel", () => {
  it("explains that live transcription needs Electron and disables the button without the bridge", async () => {
    install({ withLive: false });
    render(<App />);
    expect(await screen.findByText(/nécessite l’application Electron/)).toBeTruthy();
    expect((screen.getByText("Démarrer le direct") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows provisional text apart from final text and never duplicates a replayed event", async () => {
    const harness = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(harness.live.start).toHaveBeenCalledOnce());

    harness.emit({ type: "client_state", state: "active" });
    expect(screen.getByText("En direct")).toBeTruthy();

    harness.emit({ type: "partial", event_id: 1, utterance_id: 1, revision: 1, text: "bonjour to", start_seconds: 0, end_seconds: 1 });
    expect(screen.getByTestId("provisional").textContent).toContain("bonjour to");

    harness.emit(final(1, "Bonjour tout le monde.", 2));
    harness.emit(final(1, "Bonjour tout le monde.", 2)); // replay after a reconnection
    expect(screen.queryByTestId("provisional")).toBeNull();
    expect(screen.getAllByText(/Bonjour tout le monde\./)).toHaveLength(1);
  });

  it("holds microphone frames until the session is open, then sends them in order", async () => {
    let finishStart: (value: unknown) => void = () => {};
    const harness = install({ start: vi.fn().mockReturnValue(new Promise((resolve) => { finishStart = resolve; })) });
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(harness.live.start).toHaveBeenCalled());

    harness.pushFrame(3200); // captured while the session is still being opened
    expect(harness.live.sendAudio).not.toHaveBeenCalled();
    await act(async () => finishStart({ ok: true }));
    expect(harness.live.sendAudio).toHaveBeenCalledTimes(1);
    harness.pushFrame(3200); // now sent straight away
    expect(harness.live.sendAudio).toHaveBeenCalledTimes(2);
  });

  it("stops the microphone first, then asks the service to finish, and reports why the session ended", async () => {
    const harness = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(harness.live.start).toHaveBeenCalled());
    harness.emit({ type: "client_state", state: "active" });

    fireEvent.click(await screen.findByText("Arrêter"));
    await waitFor(() => expect(harness.live.stop).toHaveBeenCalledOnce());
    expect(harness.micStop).toHaveBeenCalledOnce();

    harness.emit(final(1, "Au revoir", 1));
    harness.emit({ type: "session_ended", event_id: 2, reason: "client_stop", utterances: 1 });
    expect(await screen.findByText(/Session terminée \(arrêt demandé\)/)).toBeTruthy();
    expect(harness.unsubscribe).toHaveBeenCalled();
  });

  it("does not open a session when the microphone is refused", async () => {
    const harness = install();
    vi.mocked(startMicCapture).mockRejectedValueOnce(new Error("Permission denied"));
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    expect((await screen.findByRole("alert")).textContent).toBe("Permission denied");
    expect(harness.live.start).not.toHaveBeenCalled();
    expect(screen.getByText("Interrompu")).toBeTruthy();
  });

  it("releases the microphone when the service refuses to start", async () => {
    const harness = install({ start: vi.fn().mockResolvedValue({ ok: false, code: "backend_start_failed", message: "Service absent." }) });
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    expect((await screen.findByRole("alert")).textContent).toBe("Service absent.");
    expect(harness.micStop).toHaveBeenCalled();
    expect(harness.unsubscribe).toHaveBeenCalled();
  });

  it("releases the microphone on a fatal error from the service", async () => {
    const harness = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(harness.live.start).toHaveBeenCalled());
    harness.emit({ type: "error", code: "busy", message: "Une session est déjà en cours.", fatal: true });
    expect((await screen.findByRole("alert")).textContent).toBe("Une session est déjà en cours.");
    await waitFor(() => expect(harness.micStop).toHaveBeenCalled());
  });

  it("drops malformed events instead of rendering them", async () => {
    const harness = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(harness.live.start).toHaveBeenCalled());
    harness.emit({ type: "final", event_id: "x", utterance_id: 1, text: "<img src=x>" });
    harness.emit("garbage");
    harness.emit(null);
    expect(document.querySelector(".live-transcript")?.textContent ?? "").not.toContain("img");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("locks the file import while live is active", async () => {
    const harness = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(harness.live.start).toHaveBeenCalled());
    harness.emit({ type: "client_state", state: "active" });
    expect((screen.getByText("Enregistrer") as HTMLButtonElement).disabled).toBe(true);
  });

  it("releases the microphone and the subscription when the window content unmounts", async () => {
    const harness = install();
    const view = render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(harness.live.start).toHaveBeenCalled());
    view.unmount();
    expect(harness.micStop).toHaveBeenCalled();
    expect(harness.unsubscribe).toHaveBeenCalled();
  });
});
