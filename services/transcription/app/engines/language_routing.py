"""Builds the language-routing engine from configuration (opt-in: LINGUANOTE_ASR_ENGINE=language-routing).

Configured explicitly, because nothing is downloaded or guessed:
  LINGUANOTE_WHISPER_MODEL            multilingual Whisper used for French, English and any unlisted language
  LINGUANOTE_ROUTING_WOLOF_MODEL      directory of a CTranslate2 Wolof Whisper model (see docs/model-selection.md)
  LINGUANOTE_ROUTING_CLASSIFIER       JSON file written by scripts/train_language_classifier.py (default detector only)
Optional:
  LINGUANOTE_ROUTING_DETECTOR         "classifier" (default) or "fr-en-else-wolof" (one rule, no classifier file)
  LINGUANOTE_ROUTING_RULE_THRESHOLD   confidence needed to call a window French or English (rule detector, default 0.77)
  LINGUANOTE_ROUTING_FRENCH_MODEL     Whisper model for French passages (default: LINGUANOTE_WHISPER_MODEL)
  LINGUANOTE_ROUTING_ENGLISH_MODEL    Whisper model for English passages (default: LINGUANOTE_WHISPER_MODEL)
  LINGUANOTE_ROUTING_LID_MODEL        Whisper size used to read the language, default "tiny"
Each passage is transcribed in the language detected for it (the model is told), except Wolof: Whisper has no code.
"""
import os
from pathlib import Path

from app.engines.base import ModelUnavailableError
from app.engines.faster_whisper import FasterWhisperEngine
from app.language.classifier import ClassifierDetector, LinearLanguageClassifier
from app.language.routing import LanguageRouter, RoutedEngine
from app.language.rule import FrenchEnglishElseWolofDetector
from app.language.whisper_lid import WhisperLanguageFeatures

WOLOF_MODEL_ENV = "LINGUANOTE_ROUTING_WOLOF_MODEL"
CLASSIFIER_ENV = "LINGUANOTE_ROUTING_CLASSIFIER"
DETECTOR_ENV = "LINGUANOTE_ROUTING_DETECTOR"
RULE_THRESHOLD_ENV = "LINGUANOTE_ROUTING_RULE_THRESHOLD"
LID_MODEL_ENV = "LINGUANOTE_ROUTING_LID_MODEL"
CLASSIFIER_DETECTOR, RULE_DETECTOR = "classifier", "fr-en-else-wolof"
FRENCH_MODEL_ENV = "LINGUANOTE_ROUTING_FRENCH_MODEL"
ENGLISH_MODEL_ENV = "LINGUANOTE_ROUTING_ENGLISH_MODEL"
DEFAULT_RULE_THRESHOLD = 0.77
FRENCH_LABEL = "fr"
DEFAULT_LABEL = "default"  # receives audio whose language has no dedicated engine


def detector_kind() -> str:
    kind = os.getenv(DETECTOR_ENV, CLASSIFIER_DETECTOR)
    if kind not in (CLASSIFIER_DETECTOR, RULE_DETECTOR):
        raise ModelUnavailableError(f"{DETECTOR_ENV} must be '{CLASSIFIER_DETECTOR}' or '{RULE_DETECTOR}'.")
    return kind


def routing_paths() -> tuple[Path, Path | None]:
    """The configured Wolof model directory and (classifier detector only) classifier file, or
    ModelUnavailableError saying what is missing."""
    kind = detector_kind()
    wolof, classifier = os.getenv(WOLOF_MODEL_ENV), os.getenv(CLASSIFIER_ENV)
    needed = [(WOLOF_MODEL_ENV, wolof)] + ([(CLASSIFIER_ENV, classifier)] if kind == CLASSIFIER_DETECTOR else [])
    missing = [name for name, value in needed if not value]
    if missing:
        raise ModelUnavailableError(f"Language routing needs {' and '.join(missing)} to be set.")
    wolof_path = Path(wolof)
    if not (wolof_path / "model.bin").is_file():
        raise ModelUnavailableError(f"{WOLOF_MODEL_ENV} must be a CTranslate2 model directory (no model.bin found).")
    if kind == RULE_DETECTOR:
        return wolof_path, None
    classifier_path = Path(classifier)
    if not classifier_path.is_file():
        raise ModelUnavailableError(f"{CLASSIFIER_ENV} does not point to a file.")
    return wolof_path, classifier_path


def _load_classifier(path: Path) -> LinearLanguageClassifier:
    try:
        classifier = LinearLanguageClassifier.load(path)
    except (OSError, ValueError, KeyError) as exc:
        raise ModelUnavailableError(f"The language classifier file could not be read: {exc}") from exc
    if not {FRENCH_LABEL, "en", "wo"} <= set(classifier.labels):
        raise ModelUnavailableError("The language classifier must know the labels fr, en and wo.")
    return classifier


def _rule_threshold() -> float:
    raw = os.getenv(RULE_THRESHOLD_ENV)
    try:
        value = float(raw) if raw else DEFAULT_RULE_THRESHOLD
    except ValueError:
        value = -1.0
    if not 0.0 < value < 1.0:
        raise ModelUnavailableError(f"{RULE_THRESHOLD_ENV} must be a number strictly between 0 and 1.")
    return value


def build_routing_engine() -> RoutedEngine:
    wolof_path, classifier_path = routing_paths()
    classifier = _load_classifier(classifier_path) if classifier_path else None
    threshold = None if classifier else _rule_threshold()  # validated before any model is loaded

    loaded: dict[str, FasterWhisperEngine] = {}  # one instance per model name: French and English may share one

    def engine_for(model: str) -> FasterWhisperEngine:
        if model not in loaded:
            loaded[model] = FasterWhisperEngine(model)
        return loaded[model]

    default_model = os.getenv("LINGUANOTE_WHISPER_MODEL", "base")
    french_model = os.getenv(FRENCH_MODEL_ENV) or default_model
    english_model = os.getenv(ENGLISH_MODEL_ENV) or default_model
    multilingual = engine_for(default_model)
    french, english = engine_for(french_model), engine_for(english_model)
    wolof = FasterWhisperEngine(str(wolof_path))
    try:
        lid = WhisperLanguageFeatures(
            os.getenv(LID_MODEL_ENV, "tiny"), cpu_threads=int(os.getenv("LINGUANOTE_CPU_THREADS", "4")),
        )
    except Exception as exc:  # noqa: BLE001 - missing package, no network on first use, disk: all mean "unavailable"
        raise ModelUnavailableError("The language identification model could not be loaded.") from exc
    detector = ClassifierDetector(lid, classifier) if classifier else FrenchEnglishElseWolofDetector(lid, threshold)
    # "default" (the multilingual model) takes every language that has no dedicated engine, including unknown audio.
    engines = {DEFAULT_LABEL: multilingual, FRENCH_LABEL: french, "en": english, "wo": wolof}
    router = LanguageRouter(engines, DEFAULT_LABEL, detector, language_hints=frozenset({FRENCH_LABEL, "en"}))
    names = [default_model]
    names += [f"fr={french_model}"] if french_model != default_model else []
    names += [f"en={english_model}"] if english_model != default_model else []
    return RoutedEngine(router, model_label="+".join(names + [wolof_path.name]))
