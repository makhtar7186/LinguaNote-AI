"""Builds the language-routing engine from configuration (opt-in: LINGUANOTE_ASR_ENGINE=language-routing).

Three things must be configured, because nothing is downloaded or guessed:
  LINGUANOTE_WHISPER_MODEL            multilingual Whisper used for French, English and any unlisted language
  LINGUANOTE_ROUTING_WOLOF_MODEL      directory of a CTranslate2 Wolof Whisper model (see docs/model-selection.md)
  LINGUANOTE_ROUTING_CLASSIFIER       JSON file written by scripts/train_language_classifier.py
Optional: LINGUANOTE_ROUTING_LID_MODEL (Whisper size used to read the language, default "tiny").
"""
import os
from pathlib import Path

from app.engines.base import ModelUnavailableError
from app.engines.faster_whisper import FasterWhisperEngine
from app.language.classifier import ClassifierDetector, LinearLanguageClassifier
from app.language.routing import LanguageRouter, RoutedEngine
from app.language.whisper_lid import WhisperLanguageFeatures

WOLOF_MODEL_ENV = "LINGUANOTE_ROUTING_WOLOF_MODEL"
CLASSIFIER_ENV = "LINGUANOTE_ROUTING_CLASSIFIER"
LID_MODEL_ENV = "LINGUANOTE_ROUTING_LID_MODEL"
FRENCH_LABEL = "fr"  # the label that receives audio whose language has no dedicated engine


def routing_paths() -> tuple[Path, Path]:
    """The configured Wolof model directory and classifier file, or ModelUnavailableError saying what is missing."""
    wolof, classifier = os.getenv(WOLOF_MODEL_ENV), os.getenv(CLASSIFIER_ENV)
    missing = [name for name, value in ((WOLOF_MODEL_ENV, wolof), (CLASSIFIER_ENV, classifier)) if not value]
    if missing:
        raise ModelUnavailableError(f"Language routing needs {' and '.join(missing)} to be set.")
    wolof_path, classifier_path = Path(wolof), Path(classifier)
    if not (wolof_path / "model.bin").is_file():
        raise ModelUnavailableError(f"{WOLOF_MODEL_ENV} must be a CTranslate2 model directory (no model.bin found).")
    if not classifier_path.is_file():
        raise ModelUnavailableError(f"{CLASSIFIER_ENV} does not point to a file.")
    return wolof_path, classifier_path


def build_routing_engine() -> RoutedEngine:
    wolof_path, classifier_path = routing_paths()
    try:
        classifier = LinearLanguageClassifier.load(classifier_path)
    except (OSError, ValueError, KeyError) as exc:
        raise ModelUnavailableError(f"The language classifier file could not be read: {exc}") from exc
    if not {FRENCH_LABEL, "en", "wo"} <= set(classifier.labels):
        raise ModelUnavailableError("The language classifier must know the labels fr, en and wo.")

    multilingual = FasterWhisperEngine()  # LINGUANOTE_WHISPER_MODEL
    wolof = FasterWhisperEngine(str(wolof_path))
    try:
        lid = WhisperLanguageFeatures(
            os.getenv(LID_MODEL_ENV, "tiny"), cpu_threads=int(os.getenv("LINGUANOTE_CPU_THREADS", "4")),
        )
    except Exception as exc:  # noqa: BLE001 - missing package, no network on first use, disk: all mean "unavailable"
        raise ModelUnavailableError("The language identification model could not be loaded.") from exc
    router = LanguageRouter(
        {FRENCH_LABEL: multilingual, "en": multilingual, "wo": wolof}, FRENCH_LABEL,
        ClassifierDetector(lid, classifier),
    )
    return RoutedEngine(router, model_label=f"{multilingual.model}+{wolof_path.name}")
