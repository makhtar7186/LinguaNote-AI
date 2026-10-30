import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsertionControl, parseInsertionStatus } from "../src/components/InsertionControl";

const base = { supported: true, state: "off", target: null, pendingChars: 0, inserted: 0, problem: null };
let push: (status: unknown) => void;
let bridge: { arm: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; onStatus: ReturnType<typeof vi.fn> };

beforeEach(() => {
  bridge = {
    arm: vi.fn(() => Promise.resolve({ ok: true })),
    stop: vi.fn(() => Promise.resolve({ ok: true, dropped: 0 })),
    status: vi.fn(() => Promise.resolve(base)),
    onStatus: vi.fn((listener: (status: unknown) => void) => { push = listener; return () => {}; }),
  };
  window.linguaNote = { insertion: bridge } as unknown as Window["linguaNote"];
});
afterEach(() => {
  cleanup();
  delete window.linguaNote;
});

describe("InsertionControl", () => {
  it("renders nothing without the bridge or on a platform that does not support it", async () => {
    delete window.linguaNote;
    const { container } = render(<InsertionControl liveActive />);
    expect(container.innerHTML).toBe("");
    cleanup();
    window.linguaNote = { insertion: { ...bridge, status: vi.fn(() => Promise.resolve({ ...base, supported: false })) } } as unknown as Window["linguaNote"];
    const second = render(<InsertionControl liveActive />);
    await waitFor(() => expect(bridge.onStatus).toHaveBeenCalled());
    expect(second.container.innerHTML).toBe("");
  });

  it("cannot be armed without a running live session", async () => {
    render(<InsertionControl liveActive={false} />);
    const button = await screen.findByText("Insérer le texte dans une autre application");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Démarrez d’abord le direct.")).toBeTruthy();
  });

  it("arms on click, shows the countdown, the locked target and the waiting text, and can be stopped", async () => {
    render(<InsertionControl liveActive />);
    fireEvent.click(await screen.findByText("Insérer le texte dans une autre application"));
    await waitFor(() => expect(bridge.arm).toHaveBeenCalled());
    act(() => push({ ...base, state: "locking" }));
    expect(screen.getByText(/Cliquez maintenant/)).toBeTruthy();
    act(() => push({ ...base, state: "on", target: { title: "Bloc-notes" } }));
    expect(screen.getByText("Bloc-notes")).toBeTruthy();
    act(() => push({ ...base, state: "paused", target: { title: "Bloc-notes" }, pendingChars: 12,
      problem: { code: "target_left", message: "Insertion en pause : revenez dans « Bloc-notes »." } }));
    expect(screen.getByText(/12 caractère/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("revenez");
    fireEvent.click(screen.getByText("Arrêter l’insertion"));
    expect(bridge.stop).toHaveBeenCalled();
  });

  it("shows the main process's refusal", async () => {
    bridge.arm.mockReturnValue(Promise.resolve({ ok: false, code: "no_live_session", message: "Démarrez d’abord une dictée en direct." }));
    render(<InsertionControl liveActive />);
    fireEvent.click(await screen.findByText("Insérer le texte dans une autre application"));
    expect((await screen.findByRole("alert")).textContent).toContain("Démarrez");
  });

  it("keeps the problem visible when insertion has stopped on its own", async () => {
    render(<InsertionControl liveActive />);
    await screen.findByText("Insérer le texte dans une autre application");
    act(() => push({ ...base, problem: { code: "target_is_self", message: "LinguaNote ne peut pas être la cible." } }));
    expect(screen.getByRole("alert").textContent).toContain("ne peut pas");
  });
});

describe("status parsing", () => {
  it("rejects anything that is not a status", () => {
    for (const bad of [null, "on", { state: "weird" }, { state: 5 }, undefined]) expect(parseInsertionStatus(bad)).toBeNull();
    expect(parseInsertionStatus({ state: "on", target: { title: 4 }, problem: { code: 1 } })).toMatchObject({ target: null, problem: null });
  });
});
