import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import BubbleApp from "../src/bubble/BubbleApp";
import { startMicCapture } from "../src/services/micCapture";

vi.mock("../src/services/micCapture", () => ({ startMicCapture: vi.fn() }));

const health = {
  ok: true, engine_selected: true, engine: "faster-whisper", model: "base", ffmpeg_available: true,
  limits: { max_upload_bytes: 52428800, max_audio_seconds: 600, extensions: [".wav"] },
};

interface CaptureOptions {
  source?: string; deviceId?: string; onLevel?: (rms: number) => void; onSourceEnded?: (kind: string) => void;
}

function install({ withCapture = true }: { withCapture?: boolean } = {}) {
  const capture = { armSystemAudio: vi.fn(), disarm: vi.fn() };
  let listener: (event: unknown) => void = () => {};
  let commandListener: (command: unknown) => void = () => {};
  const live = {
    prepare: vi.fn().mockResolvedValue({ ok: true }),
    start: vi.fn().mockResolvedValue({ ok: true }), stop: vi.fn().mockResolvedValue({ ok: true }),
    pause: vi.fn().mockResolvedValue({ ok: true }), resume: vi.fn().mockResolvedValue({ ok: true }),
    status: vi.fn().mockResolvedValue({ ok: true, state: "idle", paused: false }), sendAudio: vi.fn(),
    onEvent: vi.fn((callback: (event: unknown) => void) => { listener = callback; return vi.fn(); }),
  };
  window.linguaNote = {
    health: vi.fn().mockResolvedValue(health), transcribe: vi.fn(), live,
    ...(withCapture ? { capture } : {}),
    bubble: {
      setExpanded: vi.fn().mockResolvedValue({ ok: true }), setVisible: vi.fn().mockResolvedValue({ ok: true }), getState: vi.fn(),
      onCommand: vi.fn((callback: (command: unknown) => void) => { commandListener = callback; return vi.fn(); }),
    },
    shortcuts: { getReport: vi.fn().mockResolvedValue({ registered: [], failed: [] }) },
  } as unknown as Window["linguaNote"];

  const micStop = vi.fn();
  vi.mocked(startMicCapture).mockResolvedValue({ stop: micStop });
  return {
    live, micStop, capture,
    emit: (event: unknown) => act(() => listener(event)),
    command: (command: unknown) => act(() => commandListener(command)),
    options: (call = 0) => vi.mocked(startMicCapture).mock.calls[call][1] as CaptureOptions,
  };
}

const sourceSelect = () => screen.getByLabelText("Source audio") as HTMLSelectElement;

beforeEach(() => {
  vi.mocked(startMicCapture).mockReset();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.linguaNote;
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("choosing the source (main window)", () => {
  it("listens to the microphone by default", async () => {
    const env = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    expect(sourceSelect().value).toBe("microphone");
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(env.live.start).toHaveBeenCalledWith({ source: "microphone" }));
    expect(env.options().source).toBe("microphone");
  });

  it.each([["system", "Son de l’ordinateur"], ["both", "Microphone + son de l’ordinateur"]])(
    "listens to %s only when the user chose it, and tells the service", async (kind) => {
      const env = install();
      render(<App />);
      await screen.findByText(/Moteur configuré/);
      fireEvent.change(sourceSelect(), { target: { value: kind } });
      fireEvent.click(screen.getByText("Démarrer le direct"));
      await waitFor(() => expect(env.live.start).toHaveBeenCalledWith({ source: kind }));
      expect(env.options().source).toBe(kind);
      env.emit({ type: "client_state", state: "active" });
      env.emit({ type: "capture_source", source: kind });
      expect(screen.getByTestId("active-source").textContent).toContain(
        kind === "system" ? "Son de l’ordinateur" : "Microphone + son de l’ordinateur",
      );
    },
  );

  it("remembers the choice between launches", async () => {
    install();
    const first = render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.change(sourceSelect(), { target: { value: "both" } });
    first.unmount();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    expect(sourceSelect().value).toBe("both");
  });

  it("falls back to the microphone, not to a guess, when the remembered value is corrupted", async () => {
    window.localStorage.setItem("linguanote.capture", '{"source":"cloud"}');
    install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    expect(sourceSelect().value).toBe("microphone");
  });

  it("does not offer the computer sound where it cannot work (browser preview)", async () => {
    install({ withCapture: false });
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    const options = Array.from(sourceSelect().options);
    expect(options.find((option) => option.value === "microphone")?.disabled).toBe(false);
    expect(options.find((option) => option.value === "system")?.disabled).toBe(true);
    expect(options.find((option) => option.value === "both")?.disabled).toBe(true);
    expect(options.find((option) => option.value === "system")?.textContent).toContain("indisponible");
  });

  it("explains what each source captures, including the echo advice for the combined one", async () => {
    install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    expect(screen.getByText("Votre voix.")).toBeTruthy();
    fireEvent.change(sourceSelect(), { target: { value: "both" } });
    expect(screen.getByText(/casque/)).toBeTruthy();
  });

  it("locks the choice while a session is running", async () => {
    const env = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(env.live.start).toHaveBeenCalled());
    env.emit({ type: "client_state", state: "active" });
    expect(sourceSelect().disabled).toBe(true);
  });

  it("uses the microphone the user picked", async () => {
    const env = install();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "audioinput", deviceId: "default", label: "Par défaut" },
          { kind: "audioinput", deviceId: "usb-1", label: "Micro casque USB" },
          { kind: "videoinput", deviceId: "cam", label: "Caméra" },
        ]),
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
      },
    });
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    const microphone = (await screen.findByLabelText("Microphone")) as HTMLSelectElement;
    expect(Array.from(microphone.options).map((option) => option.textContent)).toEqual(["Par défaut du système", "Micro casque USB"]);
    fireEvent.change(microphone, { target: { value: "usb-1" } });
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(env.live.start).toHaveBeenCalled());
    expect(env.options().deviceId).toBe("usb-1");
  });
});

describe("a source that stops or stays silent", () => {
  it("ends the session explicitly when the computer sound stops, and does not reopen anything", async () => {
    const env = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.change(sourceSelect(), { target: { value: "system" } });
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(env.live.start).toHaveBeenCalled());
    env.emit({ type: "client_state", state: "active" });

    act(() => env.options().onSourceEnded?.("system")); // the user clicked "stop sharing"
    expect((await screen.findAllByRole("alert"))[0].textContent).toMatch(/partage du son de l’ordinateur s’est arrêté/);
    await waitFor(() => expect(env.live.stop).toHaveBeenCalledOnce());
    expect(env.micStop).toHaveBeenCalled();
    expect(startMicCapture).toHaveBeenCalledTimes(1); // no quiet switch to the microphone
  });

  it("names the microphone when it is the one that disappears", async () => {
    const env = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(env.live.start).toHaveBeenCalled());
    env.emit({ type: "client_state", state: "active" });
    act(() => env.options().onSourceEnded?.("microphone"));
    expect((await screen.findAllByRole("alert"))[0].textContent).toMatch(/microphone a été déconnecté/);
  });

  it("shows the level of the source, so the user can see it is alive", async () => {
    const env = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(env.live.start).toHaveBeenCalled());
    env.emit({ type: "client_state", state: "active" });
    env.emit({ type: "capture_source", source: "microphone" });
    const meter = () => screen.getByRole("meter", { name: /Niveau sonore de Microphone/ });
    expect(meter().getAttribute("aria-valuenow")).toBe("0");
    act(() => env.options().onLevel?.(0.25));
    expect(Number(meter().getAttribute("aria-valuenow"))).toBeGreaterThan(3);
  });

  it("warns when the source has delivered nothing for several seconds, then stops warning once sound returns", async () => {
    const env = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.change(sourceSelect(), { target: { value: "system" } });
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(env.live.start).toHaveBeenCalled());
    // Fake only the clock and the interval, and only now: Testing Library's own polling needs the real ones.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    env.emit({ type: "client_state", state: "active" });
    env.emit({ type: "capture_source", source: "system" });

    expect(screen.queryByText(/Aucun son reçu/)).toBeNull();
    act(() => { vi.advanceTimersByTime(9_000); });
    expect(screen.getByText(/Aucun son reçu de « Son de l’ordinateur »/)).toBeTruthy();
    expect(screen.getByText(/quelque chose est en cours de lecture/)).toBeTruthy();

    act(() => env.options().onLevel?.(0.3));
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.queryByText(/Aucun son reçu/)).toBeNull();
  });

  it("does not warn while paused (the sources are released on purpose)", async () => {
    const env = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(env.live.start).toHaveBeenCalled());
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    env.emit({ type: "client_state", state: "active" });
    env.emit({ type: "capture_source", source: "microphone" });
    env.emit({ type: "pause_state", paused: true });
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(screen.queryByText(/Aucun son reçu/)).toBeNull();
  });
});

describe("another window's session", () => {
  it("shows which source it listens to without opening any device here", async () => {
    const env = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    env.emit({ type: "client_state", state: "active" });
    env.emit({ type: "capture_source", source: "both" });
    expect(screen.getByTestId("active-source").textContent).toContain("Microphone + son de l’ordinateur");
    expect(startMicCapture).not.toHaveBeenCalled();
  });
});

describe("source choice in the bubble", () => {
  it("offers the choice only when idle, starts with it, and shows the active source", async () => {
    const env = install();
    render(<BubbleApp />);
    fireEvent.click(screen.getByRole("button", { name: /Ouvrir/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Ordinateur" }));
    expect(screen.getByRole("radio", { name: "Ordinateur" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByText("Démarrer"));
    await waitFor(() => expect(env.live.start).toHaveBeenCalledWith({ source: "system" }));

    env.emit({ type: "client_state", state: "active" });
    env.emit({ type: "capture_source", source: "system" });
    expect(screen.queryByRole("radiogroup", { name: "Source audio" })).toBeNull(); // cannot change source mid-session
    expect(screen.getByTestId("active-source").textContent).toContain("Son de l’ordinateur");
  });

  it("a shortcut starts the session with the source currently chosen in the bubble", async () => {
    const env = install();
    render(<BubbleApp />);
    fireEvent.click(screen.getByRole("button", { name: /Ouvrir/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Les deux" }));

    env.command({ action: "toggle_live" });
    await waitFor(() => expect(env.live.start).toHaveBeenCalledWith({ source: "both" }));
    expect(env.options().source).toBe("both");
  });

  it("uses no drop-down list: the bubble never takes the focus, and Windows does not open one reliably there", async () => {
    install();
    const { container } = render(<BubbleApp />);
    fireEvent.click(screen.getByRole("button", { name: /Ouvrir/ }));
    await screen.findByRole("radiogroup", { name: "Source audio" });
    expect(container.querySelector("select")).toBeNull();
  });

  it("imposes the language chosen in the bubble, and starts several-language sessions without one", async () => {
    const env = install();
    render(<BubbleApp />);
    fireEvent.click(screen.getByRole("button", { name: /Ouvrir/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "WO" }));
    fireEvent.click(screen.getByText("Démarrer"));
    await waitFor(() => expect(env.live.start).toHaveBeenCalledWith({ source: "microphone", language: "wo" }));
  });

  it("follows a choice made in the main window (shared preferences)", async () => {
    install();
    render(<BubbleApp />);
    fireEvent.click(screen.getByRole("button", { name: /Ouvrir/ }));
    await screen.findByRole("radio", { name: "Micro" });
    window.localStorage.setItem("linguanote.capture", JSON.stringify({ source: "both", deviceId: "", language: "en" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "linguanote.capture" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Les deux" }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("radio", { name: "EN" }).getAttribute("aria-checked")).toBe("true");
  });

  it("a shortcut never silently picks another source than the one shown", async () => {
    const env = install();
    render(<BubbleApp />);
    env.command({ action: "toggle_live" }); // nothing chosen: the default, which is the microphone
    await waitFor(() => expect(env.live.start).toHaveBeenCalledWith({ source: "microphone" }));
  });
});

describe("declaring the source before opening any device", () => {
  it("declares the source first, then opens the devices, then starts the session", async () => {
    const env = install();
    const order: string[] = [];
    env.live.prepare.mockImplementation(async () => { order.push("prepare"); return { ok: true }; });
    vi.mocked(startMicCapture).mockImplementation(async () => { order.push("devices"); return { stop: env.micStop }; });
    env.live.start.mockImplementation(async () => { order.push("start"); return { ok: true }; });
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.change(sourceSelect(), { target: { value: "system" } });
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(env.live.start).toHaveBeenCalled());
    expect(order).toEqual(["prepare", "devices", "start"]); // the indicator is up before any device opens
    expect(env.live.prepare).toHaveBeenCalledWith({ source: "system" });
  });

  it("opens no device and starts no session when the declaration is refused", async () => {
    const env = install();
    env.live.prepare.mockResolvedValue({ ok: false, code: "invalid_source", message: "Source audio inconnue." });
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    expect((await screen.findAllByRole("alert"))[0].textContent).toBe("Source audio inconnue.");
    expect(startMicCapture).not.toHaveBeenCalled();
    expect(env.live.start).not.toHaveBeenCalled();
  });

  it("stopping while the declaration is in flight opens nothing", async () => {
    const env = install();
    let answer: (value: unknown) => void = () => {};
    env.live.prepare.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(env.live.prepare).toHaveBeenCalled());
    fireEvent.click(await screen.findByText("Arrêter"));
    await waitFor(() => expect(env.live.stop).toHaveBeenCalled());

    await act(async () => answer({ ok: true }));
    expect(startMicCapture).not.toHaveBeenCalled(); // the user stopped: no device is opened afterwards
    expect(env.live.start).not.toHaveBeenCalled();
  });

  it("mirrors a session another window already runs instead of showing an error", async () => {
    const env = install();
    env.live.prepare.mockResolvedValue({ ok: false, code: "already_running", message: "déjà en cours" });
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    // Another window starts a session just after this one rendered: the declaration is refused with already_running.
    env.live.status.mockResolvedValue({ ok: true, state: "active", paused: false, source: "both" });
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(screen.getByTestId("active-source").textContent).toContain("Microphone + son de l’ordinateur"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(startMicCapture).not.toHaveBeenCalled();
  });
});

describe("withdrawing a declaration that did not become a session", () => {
  it("disarms when the user stops while the declaration is in flight", async () => {
    const env = install();
    let answer: (value: unknown) => void = () => {};
    env.live.prepare.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.change(sourceSelect(), { target: { value: "system" } });
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(env.live.prepare).toHaveBeenCalled());
    fireEvent.click(await screen.findByText("Arrêter"));
    await waitFor(() => expect(env.capture.disarm).toHaveBeenCalled()); // nothing may stay armable after the stop
    await act(async () => answer({ ok: true }));
    expect(env.capture.disarm.mock.calls.length).toBeGreaterThanOrEqual(2); // and again once the late answer is discarded
  });

  it("disarms when opening the devices fails, with the error shown", async () => {
    const env = install();
    vi.mocked(startMicCapture).mockRejectedValue(new Error("Le son de l’ordinateur n’a pas pu être capturé."));
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.change(sourceSelect(), { target: { value: "system" } });
    fireEvent.click(screen.getByText("Démarrer le direct"));
    expect((await screen.findAllByRole("alert"))[0].textContent).toMatch(/n’a pas pu être capturé/);
    expect(env.capture.disarm).toHaveBeenCalled();
    expect(env.live.start).not.toHaveBeenCalled();
  });

  it("disarms on a normal stop too", async () => {
    const env = install();
    render(<App />);
    await screen.findByText(/Moteur configuré/);
    fireEvent.click(screen.getByText("Démarrer le direct"));
    await waitFor(() => expect(env.live.start).toHaveBeenCalled());
    env.emit({ type: "client_state", state: "active" });
    env.capture.disarm.mockClear();
    fireEvent.click(await screen.findByText("Arrêter"));
    await waitFor(() => expect(env.capture.disarm).toHaveBeenCalledOnce());
  });
});
