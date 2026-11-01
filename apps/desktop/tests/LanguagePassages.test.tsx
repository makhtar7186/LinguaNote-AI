import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LanguagePassages } from "../src/components/LanguagePassages";

afterEach(cleanup);

const segment = (text: string, language: string | null, start = 0) => (
  { start_seconds: start, end_seconds: start + 1, text, language }
);

describe("LanguagePassages", () => {
  it("shows each passage with its estimated language, in order", () => {
    render(<LanguagePassages segments={[segment("bonjour", "fr"), segment("waaw", "wo", 1), segment("hello", "en", 2)]} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["Françaisbonjour", "Wolofwaaw", "Anglaishello"]);
  });

  it("shows nothing when the engine did not detect any language", () => {
    const { container } = render(<LanguagePassages segments={[segment("bonjour", null)]} />);
    expect(container.innerHTML).toBe("");
  });

  it("does not hide a passage whose language is unknown or not in the label list", () => {
    render(<LanguagePassages segments={[segment("salut", "fr"), segment("???", null, 1), segment("hola", "es", 2)]} />);
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "Françaissalut", "Langue inconnue???", "eshola",
    ]);
  });
});
