import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryPanel } from "../src/components/HistoryPanel";
import { parseDetail, parseList, parseSettings, splitHighlights } from "../src/services/historyClient";

const summary = (extra: Record<string, unknown> = {}) => ({
  id: "s1", kind: "live", source: "microphone", status: "complete", title: null, created_at: "2026-01-02T10:00:00+00:00",
  ended_at: null, duration_seconds: 4, engine: "fw", model: "small", segment_count: 2, preview: "Bonjour tout le monde", snippet: null,
  ...extra,
});
const ok = (data: unknown) => Promise.resolve({ ok: true, data });
const fail = (code: string, message: string) => Promise.resolve({ ok: false, code, message });

let bridge: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  bridge = {
    getSettings: vi.fn(() => ok({ enabled: true, retention_days: 30 })),
    setSettings: vi.fn((enabled: boolean, days: number | null) => ok({ enabled, retention_days: days })),
    list: vi.fn(() => ok({ items: [summary()], total: 1 })),
    get: vi.fn(() => ok({ ...summary(), segments: [
      { text: "Bonjour", start_seconds: 0, end_seconds: 1, language: "fr", language_probability: 0.9 },
      { text: "Jërëjëf", start_seconds: 1, end_seconds: 2, language: null, language_probability: null },
    ] })),
    rename: vi.fn(() => ok(null)),
    remove: vi.fn(() => ok(null)),
    removeAll: vi.fn(() => ok({ deleted: 1 })),
    export: vi.fn(() => Promise.resolve({ ok: true, saved: true })),
  };
  window.linguaNote = { history: bridge } as unknown as Window["linguaNote"];
});
afterEach(() => {
  cleanup();
  delete window.linguaNote;
});

describe("HistoryPanel", () => {
  it("shows the saved sessions and says when the history is off", async () => {
    render(<HistoryPanel />);
    expect(await screen.findByText("Bonjour tout le monde")).toBeTruthy();
    cleanup();
    bridge.getSettings.mockReturnValue(ok({ enabled: false, retention_days: 30 }));
    bridge.list.mockReturnValue(ok({ items: [], total: 0 }));
    render(<HistoryPanel />);
    expect(await screen.findByText(/rien n’est enregistré/)).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("turns the history on and changes the retention through the bridge", async () => {
    bridge.getSettings.mockReturnValue(ok({ enabled: false, retention_days: 30 }));
    render(<HistoryPanel />);
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(bridge.setSettings).toHaveBeenCalledWith(true, 30));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "none" } });
    await waitFor(() => expect(bridge.setSettings).toHaveBeenLastCalledWith(true, null));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "90" } });
    await waitFor(() => expect(bridge.setSettings).toHaveBeenLastCalledWith(true, 90));
  });

  it("searches, and renders matches as highlighted text, never as HTML", async () => {
    bridge.list.mockImplementation((options?: { query?: string }) => options?.query
      ? ok({ items: [summary({ snippet: "dit \x02<b>bonjour</b>\x03 à tous" })], total: 1 })
      : ok({ items: [summary()], total: 1 }));
    const { container } = render(<HistoryPanel />);
    await screen.findByText("Bonjour tout le monde");
    fireEvent.change(screen.getByLabelText("Rechercher dans l’historique"), { target: { value: "bonjour" } });
    await waitFor(() => expect(container.querySelector("mark")?.textContent).toBe("<b>bonjour</b>"));
    expect(container.querySelector("b")).toBeNull();
  });

  it("ignores the answer of an older search that arrives late", async () => {
    let releaseSlow: (value: unknown) => void = () => {};
    bridge.list.mockImplementation((options?: { query?: string }) => {
      if (options?.query === "a") return new Promise((resolve) => { releaseSlow = resolve; });
      return ok({ items: [summary({ id: "new", preview: "résultat récent" })], total: 1 });
    });
    render(<HistoryPanel />);
    await screen.findByText("résultat récent");
    const input = screen.getByLabelText("Rechercher dans l’historique");
    fireEvent.change(input, { target: { value: "a" } });
    await waitFor(() => expect(bridge.list).toHaveBeenCalledWith({ query: "a" }));
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(bridge.list).toHaveBeenLastCalledWith({ query: "" }));
    releaseSlow(ok({ items: [summary({ id: "old", preview: "résultat périmé" })], total: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("résultat périmé")).toBeNull();
  });

  it("opens a session, copies it, renames it and exports it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<HistoryPanel />);
    fireEvent.click(await screen.findByText("Bonjour tout le monde"));
    await screen.findByText("Bonjour Jërëjëf");
    fireEvent.click(screen.getByText("Copier"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Bonjour\nJërëjëf"));
    fireEvent.change(screen.getByLabelText("Titre de la session"), { target: { value: " Réunion " } });
    fireEvent.click(screen.getByText("Renommer"));
    await waitFor(() => expect(bridge.rename).toHaveBeenCalledWith("s1", " Réunion "));
    fireEvent.click(screen.getByText("Exporter · SRT"));
    await waitFor(() => expect(bridge.export).toHaveBeenCalledWith("s1", "srt"));
    expect(await screen.findByText("Fichier enregistré.")).toBeTruthy();
  });

  it("does not claim a file was saved when the user cancels the dialog", async () => {
    bridge.export.mockReturnValue(Promise.resolve({ ok: true, saved: false }));
    render(<HistoryPanel />);
    fireEvent.click(await screen.findByText("Bonjour tout le monde"));
    fireEvent.click(await screen.findByText("Exporter · Texte"));
    await waitFor(() => expect(bridge.export).toHaveBeenCalled());
    expect(screen.queryByText("Fichier enregistré.")).toBeNull();
  });

  it("shows the service's refusal instead of a generic error", async () => {
    bridge.export.mockReturnValue(fail("export_not_possible", "Cette session n’a pas d’horodatage."));
    render(<HistoryPanel />);
    fireEvent.click(await screen.findByText("Bonjour tout le monde"));
    fireEvent.click(await screen.findByText("Exporter · SRT"));
    expect((await screen.findByRole("alert")).textContent).toContain("horodatage");
  });

  it("deletes one session, and everything only after a second explicit click", async () => {
    render(<HistoryPanel />);
    fireEvent.click(await screen.findByText("Bonjour tout le monde"));
    fireEvent.click(await screen.findByText("Supprimer"));
    await waitFor(() => expect(bridge.remove).toHaveBeenCalledWith("s1"));

    fireEvent.click(await screen.findByText("Supprimer tout l’historique…"));
    expect(bridge.removeAll).not.toHaveBeenCalled(); // the first click only asks
    fireEvent.click(screen.getByText("Annuler"));
    expect(bridge.removeAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Supprimer tout l’historique…"));
    fireEvent.click(screen.getByText("Oui, tout supprimer"));
    await waitFor(() => expect(bridge.removeAll).toHaveBeenCalledWith(true));
  });

  it("warns that an interrupted session may be incomplete", async () => {
    bridge.get.mockReturnValue(ok({ ...summary({ status: "interrupted" }), segments: [] }));
    render(<HistoryPanel />);
    fireEvent.click(await screen.findByText("Bonjour tout le monde"));
    expect(await screen.findByText(/peut être incomplet/)).toBeTruthy();
    expect(screen.getByText("Aucun texte enregistré.")).toBeTruthy();
  });

  it("reports a failing service without crashing", async () => {
    bridge.getSettings.mockReturnValue(fail("service_unavailable", "Service local indisponible."));
    render(<HistoryPanel />);
    expect((await screen.findByRole("alert")).textContent).toContain("indisponible");
  });
});

describe("response parsing", () => {
  it("rejects malformed settings and sessions", () => {
    expect(() => parseSettings({ enabled: "yes" })).toThrow();
    expect(() => parseSettings({ enabled: true, retention_days: "30" })).toThrow();
    expect(parseSettings({ enabled: true, retention_days: null })).toEqual({ enabled: true, retentionDays: null });
    expect(() => parseList({ items: [{ id: 1 }] })).toThrow();
    expect(() => parseList({ items: [summary({ status: "weird" })] })).toThrow();
    expect(() => parseDetail({ ...summary(), segments: [{ nope: 1 }] })).toThrow();
  });

  it("splits highlight markers, including unbalanced ones", () => {
    expect(splitHighlights("a \x02b\x03 c")).toEqual([
      { text: "a ", match: false }, { text: "b", match: true }, { text: " c", match: false },
    ]);
    expect(splitHighlights("\x02seul")).toEqual([{ text: "seul", match: true }]);
    expect(splitHighlights("")).toEqual([]);
  });
});
