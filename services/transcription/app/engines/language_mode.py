"""Single-language mode: the user says which language will be spoken, so nothing has to guess it.

Without a language (the default) the configured engine works as usual: Whisper detects the language of each passage,
the language-routing engine detects it window by window. With one of SESSION_LANGUAGES the whole recording goes to
the engine of that language, told the language when it understands the hint (Whisper: "fr", "en"). Wolof has no
Whisper code: only an engine dedicated to Wolof (language routing) can serve it; otherwise the request is refused,
never quietly transcribed as French or English.
"""
from dataclasses import replace
from pathlib import Path

from app.engines.base import EngineCapabilities, SpeechEngine, TranscriptionResult

SESSION_LANGUAGES = ("fr", "en", "wo")
WHISPER_LANGUAGES = frozenset({"fr", "en"})
LANGUAGE_NAMES = {"fr": "le français", "en": "l'anglais", "wo": "le wolof"}


class UnsupportedLanguageError(ValueError):
    """The selected engine cannot transcribe the requested language (message is safe to show to the user)."""


class FixedLanguageEngine:
    """Wraps one engine so every call transcribes the chosen language. The rest of the application sees an engine."""

    def __init__(self, engine: SpeechEngine, language: str, *, hint: bool, model_label: str | None = None) -> None:
        self._engine = engine
        self.language = language
        self._hint = hint
        self._model = model_label or engine.model

    @property
    def name(self) -> str:
        return self._engine.name

    @property
    def model(self) -> str:
        return self._model

    @property
    def capabilities(self) -> EngineCapabilities:
        # The language is the user's choice, not a detection.
        return replace(self._engine.capabilities, language_detection=False)

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        if self._hint:
            result = self._engine.transcribe(audio_path, language=self.language)  # type: ignore[call-arg]
        else:
            result = self._engine.transcribe(audio_path)
        # The label is what the user chose; no probability, since nothing was estimated.
        return replace(result, language=self.language, language_probability=None)


def supported_languages(engine_name: str) -> list[str]:
    """Languages the single-language mode can offer with this engine, without loading any model."""
    if engine_name == "language-routing":
        return list(SESSION_LANGUAGES)
    if engine_name == "faster-whisper":
        return sorted(WHISPER_LANGUAGES)
    return []


def for_language(engine: SpeechEngine, language: str | None) -> SpeechEngine:
    """The engine to use for a session in `language` (None: several languages, the engine unchanged)."""
    if language is None:
        return engine
    if language not in SESSION_LANGUAGES:
        raise UnsupportedLanguageError(f"Langue inconnue : choisissez parmi {', '.join(SESSION_LANGUAGES)}.")
    router = getattr(engine, "router", None)
    if router is not None:
        # Language routing: skip detection and send everything to the engine of that language.
        inner = router.engines.get(language)
        if inner is None:
            raise UnsupportedLanguageError(f"Aucun modèle n'est configuré pour {LANGUAGE_NAMES[language]}.")
        hint = language in WHISPER_LANGUAGES and getattr(inner, "accepts_language_hint", False)
        return FixedLanguageEngine(inner, language, hint=hint)
    if language in WHISPER_LANGUAGES and getattr(engine, "accepts_language_hint", False):
        return FixedLanguageEngine(engine, language, hint=True)
    raise UnsupportedLanguageError(
        f"Le moteur actuel ne transcrit pas {LANGUAGE_NAMES[language]}. Choisissez « Plusieurs langues » "
        "ou configurez le moteur language-routing avec un modèle wolof."
        if language == "wo" else
        f"Le moteur actuel ne permet pas d'imposer {LANGUAGE_NAMES[language]} : choisissez « Plusieurs langues »."
    )
