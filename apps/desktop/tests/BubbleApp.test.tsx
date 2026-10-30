import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BubbleApp from "../src/bubble/BubbleApp";
import { bubbleMode, microphoneOpen, statusLabel, tail } from "../src/bubble/bubbleMode";
import { initialLiveState } from "../src/services/liveReducer";
import { startMicCapture } from "../src/services/micCapture";
import type { LiveState } from "../src/types";

vi.mock("../src/services/micCapture", () => ({ startMicCapture: vi.fn() }));

const state = (overrides: Partial<LiveState>): LiveState => ({ ...initialLiveState, ...overrides });

describe("bubbleMode", () => {
  it.each([
    [{ status: "idle" }, "inactive", "Prêt"],
    [{ status: "ended" }, "inactive", "Terminé"],
    [{ status: "live", paused: false }, "recording", "Enregistrement"],
    [{ status: "live", paused: true }, "paused", "En pause"],
    [{ status: "connecting" }, "processing", "Connexion…"],
    [{ status: "reconnecting" }, "processing", "Reconnexion…"],
    [{ status: "stopping" }, "processing", "Finalisation…"],
    [{ status: "failed" }, "error", "Erreur"],
  ] as const)("%j is %s (%s)", (overrides, mode, label) => {
    expect(bubbleMode(state(overrides))).toBe(mode);
    expect(statusLabel(state(overrides))).toBe(label);
  });

  it("knows when the microphone is open: recording, connecting or reconnecting only", () => {
    expect(microphoneOpen(state({ status: "live", paused: false }))).toBe(true);
    expect(microphoneOpen(state({ status: "reconnecting" }))).toBe(true);
    expect(microphoneOpen(state({ status: "live", paused: true }))).toBe(false); // paused: released
    expect(microphoneOpen(state({ status: "idle" }))).toBe(false);
    expect(microphoneOpen(state({ status: "ended" }))).toBe(false);
  });

  it("keeps only the last lines of the transcript", () => {
    const finals = [1, 2, 3, 4, 5].map((id) => ({
      utterance_id: id, text: `phrase ${id}`, start_seconds: 0, end_seconds: 1, language: null, language_probability: null,
    }));
    const partial = { utterance_id: 6, revision: 1, text: "en cours", start_seconds: 0, end_seconds: 1 };
    expect(tail(state({ finals, partial }))).toEqual({ final: "phrase 3 phrase 4 phrase 5", provisional: "en cours" });
  });
});

interface Harness {
  emit: (event: unknown) => void;
  command: (command: unknown) => void;
  live: Record<"prepare" | "start" | "stop" | "pause" | "resume" | "status" | "sendAudio" | "onEvent", ReturnType<typeof vi.fn>>;
  bubble: Record<"setExpanded" | "setVisible", ReturnType<typeof vi.fn>>;
}

function install(report: unknown = { registered: [], failed: [] }): Harness {
  let listener: (event: unknown) => void = () => {};
  let commandListener: (command: unknown) => void = () => {};
  const live = {
    prepare: vi.fn().mockResolvedValue({ ok: true }),
    start: vi.fn().mockResolvedValue({ ok: true }), stop: vi.fn().mockResolvedValue({ ok: true }),
    pause: vi.fn().mockResolvedValue({ ok: true }), resume: vi.fn().mockResolvedValue({ ok: true }),
    status: vi.fn().mockResolvedValue({ ok: true, state: "idle", paused: false }), sendAudio: vi.fn(),
    onEvent: vi.fn((callback: (event: unknown) => void) => { listener = callback; return vi.fn(); }),
  };
  const bubble = {
    setExpanded: vi.fn().mockResolvedValue({ ok: true }), setVisible: vi.fn().mockResolvedValue({ ok: true, visible: false }),
    getState: vi.fn(), onCommand: vi.fn((callback: (command: unknown) => void) => { commandListener = callback; return vi.fn(); }),
  };
  window.linguaNote = {
    health: vi.fn(), transcribe: vi.fn(), live, bubble, shortcuts: { getReport: vi.fn().mockResolvedValue(report) },
  } as unknown as Window["linguaNote"];
  vi.mocked(startMicCapture).mockResolvedValue({ stop: vi.fn() });
  return { emit: (event) => act(() => listener(event)), command: (command) => act(() => commandListener(command)), live, bubble };
}

const final = (id: number, text: string, eventId: number) => ({
  type: "final", event_id: eventId, utterance_id: id, text, start_seconds: 0, end_seconds: 1,
  language: "fr", language_probability: 0.9,
});
const root = () => screen.getByTestId("bubble");

beforeEach(() => {
  // Block body on purpose: a hook that returns a function is treated as its teardown and would be called.
  vi.mocked(startMicCapture).mockReset();
});
afterEach(() => {
  cleanup();
  delete window.linguaNote;
});

describe("collapsed bubble", () => {
  it("is a small inactive bubble that opens the panel and asks for the larger window", async () => {
    const harness = install();
    render(<BubbleApp />);
    expect(root().dataset.mode).toBe("inactive");
    expect(root().className).toContain("bubble-collapsed");
    await waitFor(() => expect(harness.bubble.setExpanded).toHaveBeenCalledWith(false));
    fireEvent.click(screen.getByRole("button", { name: /Ouvrir/ }));
    expect(root().className).toContain("bubble-panel");
    await waitFor(() => expect(harness.bubble.setExpanded).toHaveBeenLastCalledWith(true));
  });

  it("shows a clear recording indicator, and none when paused or idle", async () => {
    const harness = install();
    const { container } = render(<BubbleApp />);
    expect(container.querySelector(".rec-dot")).toBeNull();
    harness.emit({ type: "client_state", state: "active" });
    expect(root().dataset.mode).toBe("recording");
    expect(container.querySelector(".rec-dot")).not.toBeNull();
    expect(root().getAttribute("aria-label")).toBe("Enregistrement"); // announced, not only coloured
    harness.emit({ type: "pause_state", paused: true });
    expect(root().dataset.mode).toBe("paused");
    expect(container.querySelector(".rec-dot")).toBeNull();
  });

  it("shows the processing mode while connecting, reconnecting and finalising", () => {
    const harness = install();
    render(<BubbleApp />);
    for (const next of ["connecting", "active", "reconnecting", "stopping"] as const) {
      harness.emit({ type: "client_state", state: next });
    }
    expect(root().dataset.mode).toBe("processing");
    expect(root().getAttribute("aria-label")).toBe("Finalisation…");
  });
});

describe("expanded panel", () => {
  async function open(harness: Harness) {
    fireEvent.click(screen.getByRole("button", { name: /Ouvrir/ }));
    await waitFor(() => expect(harness.bubble.setExpanded).toHaveBeenLastCalledWith(true));
  }

  it("starts dictation from the panel and offers pause and stop while recording", async () => {
    const harness = install();
    render(<BubbleApp />);
    await open(harness);
    fireEvent.click(screen.getByText("Démarrer"));
    await waitFor(() => expect(harness.live.start).toHaveBeenCalledOnce());
    harness.emit({ type: "client_state", state: "active" });

    fireEvent.click(await screen.findByText("Pause"));
    expect(harness.live.pause).toHaveBeenCalledOnce();
    harness.emit({ type: "pause_state", paused: true });
    fireEvent.click(await screen.findByText("Reprendre"));
    expect(harness.live.resume).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByText("Arrêter"));
    await waitFor(() => expect(harness.live.stop).toHaveBeenCalledOnce());
  });

  it("disables stop while finalising and hides pause outside the recording state", async () => {
    const harness = install();
    render(<BubbleApp />);
    await open(harness);
    harness.emit({ type: "client_state", state: "connecting" });
    expect(screen.queryByText("Pause")).toBeNull();
    harness.emit({ type: "client_state", state: "stopping" });
    expect((screen.getByText("Arrêter") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the last words with provisional text apart, and a placeholder when empty", async () => {
    const harness = install();
    render(<BubbleApp />);
    await open(harness);
    expect(screen.getByText("Prêt à écouter.")).toBeTruthy();
    harness.emit({ type: "client_state", state: "active" });
    expect(screen.getByText("Parlez : le texte apparaît ici.")).toBeTruthy();
    harness.emit(final(1, "Bonjour tout le monde.", 1));
    harness.emit({ type: "partial", event_id: 2, utterance_id: 2, revision: 1, text: "et bienv", start_seconds: 1, end_seconds: 2 });
    expect(screen.getByText(/Bonjour tout le monde\./)).toBeTruthy();
    expect(screen.getByTestId("provisional").textContent).toContain("et bienv");
  });

  it("collapses again and asks for the small window", async () => {
    const harness = install();
    render(<BubbleApp />);
    await open(harness);
    fireEvent.click(screen.getByRole("button", { name: "Réduire" }));
    expect(root().className).toContain("bubble-collapsed");
    await waitFor(() => expect(harness.bubble.setExpanded).toHaveBeenLastCalledWith(false));
  });

  it("opens by itself on a fatal error and shows why, until the user collapses it", async () => {
    const harness = install();
    render(<BubbleApp />);
    harness.emit({ type: "error", code: "busy", message: "Le service est occupé.", fatal: true });
    expect(root().dataset.mode).toBe("error");
    expect(root().className).toContain("bubble-panel");
    expect((await screen.findByRole("alert")).textContent).toBe("Le service est occupé.");
    await waitFor(() => expect(harness.bubble.setExpanded).toHaveBeenLastCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: "Réduire" }));
    expect(root().className).toContain("bubble-collapsed"); // dismissed
    expect(root().dataset.mode).toBe("error"); // still visibly in error
    harness.emit({ type: "error", code: "other", message: "Autre erreur.", fatal: false, event_id: 5 });
    expect(root().className).toContain("bubble-panel"); // a new problem reopens it
  });

  it("hides on request, and says why when the bubble cannot be hidden", async () => {
    const harness = install();
    render(<BubbleApp />);
    await open(harness);
    fireEvent.click(screen.getByRole("button", { name: "Masquer la bulle" }));
    await waitFor(() => expect(harness.bubble.setVisible).toHaveBeenCalledWith(false));
    harness.bubble.setVisible.mockResolvedValueOnce({ ok: false, code: "recording_active", message: "Arrêtez la dictée avant de masquer la bulle." });
    fireEvent.click(screen.getByRole("button", { name: "Masquer la bulle" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Arrêtez la dictée avant de masquer la bulle.");
  });

  it("lists the active shortcuts and warns about those another application already holds", async () => {
    const harness = install({
      registered: [{ name: "toggleLive", accelerator: "CommandOrControl+Alt+Space" }],
      failed: [
        { name: "pauseLive", accelerator: "CommandOrControl+Alt+P", reason: "already_in_use_or_invalid" },
        { name: "toggleBubble", accelerator: "", reason: "disabled" },
      ],
    });
    render(<BubbleApp />);
    await open(harness);
    expect(await screen.findByText("Ctrl+Alt+Espace")).toBeTruthy();
    expect(screen.getByText(/pause \/ reprise.*indisponible/)).toBeTruthy();
    expect(screen.queryByText(/afficher \/ masquer la bulle.*indisponible/)).toBeNull(); // disabled on purpose
  });

  it("copes with an unreadable shortcut report", async () => {
    const harness = install("nonsense");
    render(<BubbleApp />);
    await open(harness);
    expect(screen.queryByText(/Raccourci .*indisponible/)).toBeNull();
  });
});

describe("shortcut commands", () => {
  it("toggle_live starts when idle and stops when running; other commands are ignored", async () => {
    const harness = install();
    render(<BubbleApp />);

    harness.command({ action: "toggle_live" });
    await waitFor(() => expect(harness.live.start).toHaveBeenCalledOnce());
    harness.emit({ type: "client_state", state: "active" });

    harness.command({ action: "toggle_live" });
    await waitFor(() => expect(harness.live.stop).toHaveBeenCalledOnce());

    harness.command({ action: "format_disk" });
    harness.command("garbage");
    harness.command(null);
    expect(harness.live.start).toHaveBeenCalledOnce();
    expect(harness.live.stop).toHaveBeenCalledOnce();
  });

  it("two start requests in the same instant open a single microphone", async () => {
    const harness = install();
    let finish: (capture: { stop: () => void }) => void = () => {};
    vi.mocked(startMicCapture).mockReset();
    vi.mocked(startMicCapture).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<BubbleApp />);

    // Both arrive before React re-renders (one batch): the synchronous lock, not the status, must refuse the second.
    act(() => {
      harness.command({ action: "toggle_live" });
      harness.command({ action: "toggle_live" });
    });
    await waitFor(() => expect(startMicCapture).toHaveBeenCalledTimes(1));
    expect(harness.live.prepare).toHaveBeenCalledTimes(1); // the lock refused the second request before anything happened
    const capture = { stop: vi.fn() };
    await act(async () => finish(capture));
    await waitFor(() => expect(harness.live.start).toHaveBeenCalledOnce());
  });

  it("stopping while the microphone is still opening closes it as soon as it arrives", async () => {
    const harness = install();
    let finish: (capture: { stop: () => void }) => void = () => {};
    vi.mocked(startMicCapture).mockReset();
    vi.mocked(startMicCapture).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<BubbleApp />);
    harness.command({ action: "toggle_live" }); // start: the device is being opened
    await waitFor(() => expect(startMicCapture).toHaveBeenCalledOnce());
    harness.emit({ type: "client_state", state: "connecting" });

    harness.command({ action: "toggle_live" }); // the user changes their mind
    await waitFor(() => expect(harness.live.stop).toHaveBeenCalledOnce());

    const late = { stop: vi.fn() };
    await act(async () => finish(late));
    expect(late.stop).toHaveBeenCalledOnce(); // not leaked
    expect(harness.live.start).not.toHaveBeenCalled(); // and no session was opened for nothing
  });

  it("closing the window while the microphone is still opening closes it as soon as it arrives", async () => {
    const harness = install();
    let finish: (capture: { stop: () => void }) => void = () => {};
    vi.mocked(startMicCapture).mockReset();
    vi.mocked(startMicCapture).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<BubbleApp />);
    harness.command({ action: "toggle_live" });
    await waitFor(() => expect(startMicCapture).toHaveBeenCalledOnce());
    view.unmount();

    const late = { stop: vi.fn() };
    await act(async () => finish(late));
    expect(late.stop).toHaveBeenCalledOnce();
    expect(harness.live.start).not.toHaveBeenCalled();
  });
});
