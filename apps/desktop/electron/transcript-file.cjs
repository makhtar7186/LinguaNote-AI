// Saving a transcript as a .txt file. Pure helpers (no Electron imports) so the rules can be unit-tested.

// Far above any real transcript (an hour of speech is ~60 000 characters) but bounded: the renderer is not trusted.
const MAX_TEXT_CHARS = 2_000_000;
const BOM = String.fromCharCode(0xfeff); // UTF-8 byte order mark

/** The text to save, or an error envelope. Empty text is refused: an empty file helps nobody. */
function validateText(value) {
  if (typeof value !== "string") return { ok: false, code: "invalid_argument", message: "Texte invalide." };
  if (!value.trim()) return { ok: false, code: "empty_text", message: "Il n'y a pas encore de texte à enregistrer." };
  if (value.length > MAX_TEXT_CHARS) return { ok: false, code: "text_too_large", message: "Le texte est trop long pour être enregistré." };
  return { ok: true, text: value };
}

/** "Transcription 2026-11-22 14h05.txt": no reserved characters, sorts by date. */
function defaultName(date) {
  const pad = (number) => String(number).padStart(2, "0");
  return `Transcription ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}h${pad(date.getMinutes())}.txt`;
}

/** The dialog may return a name typed without extension; the file is a text file either way. */
function withTxtExtension(filePath) {
  return /\.txt$/i.test(filePath) ? filePath : `${filePath}.txt`;
}

/**
 * File content: Windows line endings and a final newline, so Notepad and every editor show it as expected. The UTF-8
 * byte order mark lets older Windows tools recognise the accents and the Wolof letters (ë, ñ, ŋ).
 */
function content(text) {
  return `${BOM}${text.replace(/\r?\n/g, "\r\n").trimEnd()}\r\n`;
}

module.exports = { MAX_TEXT_CHARS, validateText, defaultName, withTxtExtension, content };
