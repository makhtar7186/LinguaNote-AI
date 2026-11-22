"""Single-language mode: which engine serves a chosen language, and what is refused instead of guessed."""
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.engines.base import EngineCapabilities, TranscriptionResult
from app.engines.language_mode import (
    FixedLanguageEngine,
    UnsupportedLanguageError,
    for_language,
    supported_languages,
)


class WhisperLike:
    """Accepts the language hint, like FasterWhisperEngine."""

    accepts_language_hint = True
    capabilities = EngineCapabilities(timestamps=True, language_detection=True)

    def __init__(self, name="whisper"):
        self.name, self.model, self.calls = name, f"{name}-model", []

    def transcribe(self, audio_path: Path, language: str | None = None) -> TranscriptionResult:
        self.calls.append(language)
        return TranscriptionResult(text="texte", engine=self.name, model=self.model, language="en",
                                   language_probability=0.6)


class WolofOnly:
    """A dedicated Wolof model: no language argument at all."""

    capabilities = EngineCapabilities(timestamps=True)
    name, model = "whisper", "wolof-model"

    def __init__(self):
        self.calls = 0

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        self.calls += 1
        return TranscriptionResult(text="naka nga def", engine=self.name, model=self.model)


def routed(french, english, wolof, default):
    return SimpleNamespace(router=SimpleNamespace(engines={"default": default, "fr": french, "en": english, "wo": wolof}))


def test_no_language_keeps_the_engine_unchanged():
    engine = WhisperLike()
    assert for_language(engine, None) is engine


def test_a_whisper_engine_is_told_the_chosen_language():
    engine = WhisperLike()
    fixed = for_language(engine, "fr")
    result = fixed.transcribe(Path("x.wav"))
    assert engine.calls == ["fr"]
    # The label is the user's choice, not an estimate: no probability, no claim of detection.
    assert (result.language, result.language_probability) == ("fr", None)
    assert fixed.capabilities.language_detection is False and fixed.capabilities.timestamps is True
    assert (fixed.name, fixed.model) == ("whisper", "whisper-model")


def test_wolof_is_refused_by_an_engine_that_has_no_wolof_model():
    with pytest.raises(UnsupportedLanguageError, match="wolof"):
        for_language(WhisperLike(), "wo")


def test_an_engine_without_language_hint_cannot_force_french():
    with pytest.raises(UnsupportedLanguageError):
        for_language(WolofOnly(), "fr")


def test_an_unknown_language_is_refused():
    with pytest.raises(UnsupportedLanguageError):
        for_language(WhisperLike(), "de")


def test_routing_sends_wolof_to_the_wolof_model_without_detection_or_hint():
    french, english, wolof, default = WhisperLike("fr"), WhisperLike("en"), WolofOnly(), WhisperLike("default")
    fixed = for_language(routed(french, english, wolof, default), "wo")
    result = fixed.transcribe(Path("x.wav"))
    assert wolof.calls == 1 and french.calls == english.calls == default.calls == []
    assert result.text == "naka nga def" and result.language == "wo"


def test_routing_sends_english_to_the_english_engine_with_the_hint():
    french, english, wolof, default = WhisperLike("fr"), WhisperLike("en"), WolofOnly(), WhisperLike("default")
    assert isinstance(for_language(routed(french, english, wolof, default), "en"), FixedLanguageEngine)
    for_language(routed(french, english, wolof, default), "en").transcribe(Path("x.wav"))
    assert english.calls == ["en"] and french.calls == [] and wolof.calls == 0


def test_supported_languages_are_reported_per_engine_without_loading_anything():
    assert supported_languages("language-routing") == ["fr", "en", "wo"]
    assert supported_languages("faster-whisper") == ["en", "fr"]
    assert supported_languages("omnilingual-ctc") == []
