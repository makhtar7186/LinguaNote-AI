export type SaveOutcome = "saved" | "cancelled";

const BOM = String.fromCharCode(0xfeff); // UTF-8 byte order mark: Windows tools then read the accents right

const isRec = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Saves a transcript as a .txt file. In the application the main process asks where (native dialog) and writes it;
 * in the browser preview the browser downloads it. Throws an Error with a message for the user on failure.
 */
export async function saveTranscriptText(text: string): Promise<SaveOutcome> {
  if (!text.trim()) throw new Error("Il n’y a pas encore de texte à enregistrer.");
  const bridge = window.linguaNote?.transcript;
  if (!bridge) return downloadInBrowser(text);
  const answer: unknown = await bridge.saveText(text);
  if (!isRec(answer) || typeof answer.ok !== "boolean") throw new Error("Réponse invalide de l’application.");
  if (!answer.ok) throw new Error(typeof answer.message === "string" ? answer.message : "L’enregistrement a échoué.");
  return answer.saved === true ? "saved" : "cancelled";
}

function downloadInBrowser(text: string): SaveOutcome {
  const url = URL.createObjectURL(new Blob([`${BOM}${text}`], { type: "text/plain;charset=utf-8" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = "Transcription.txt";
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return "saved";
}
