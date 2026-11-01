import os
from concurrent.futures import CancelledError
from dataclasses import replace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.engines import language_routing, registry
from app.engines.base import EngineCapabilities, ModelUnavailableError, Segment, TranscriptionResult
from app.language.classifier import train
from app.main import create_app

TOKEN = "test-token-0123456789"
LANGUAGES = ("aa", "bb", "cc")


class FakeWhisper:
    accepts_language_hint = True

    def __init__(self, model=None):
        self.model = model or os.getenv("LINGUANOTE_WHISPER_MODEL", "base")  # same rule as the real engine


def write_classifier(path, labels=("en", "fr", "wo")):
    rng = np.random.default_rng(0)
    features = np.log(rng.dirichlet(np.ones(len(LANGUAGES)), size=30 * len(labels)) + 1e-6)
    names = [label for label in labels for _ in range(30)]
    train(features, names, LANGUAGES).save(path)


@pytest.fixture
def configured(tmp_path, monkeypatch):
    model = tmp_path / "wolof-ct2"
    model.mkdir()
    (model / "model.bin").write_bytes(b"x")
    classifier = tmp_path / "lid.json"
    write_classifier(classifier)
    monkeypatch.setenv(language_routing.WOLOF_MODEL_ENV, str(model))
    monkeypatch.setenv(language_routing.CLASSIFIER_ENV, str(classifier))
    monkeypatch.setenv("LINGUANOTE_WHISPER_MODEL", "small")
    return model, classifier


@pytest.fixture
def fake_models(monkeypatch):
    monkeypatch.setattr(language_routing, "FasterWhisperEngine", FakeWhisper)
    monkeypatch.setattr(language_routing, "WhisperLanguageFeatures", lambda *a, **k: object())


def test_nothing_configured_says_what_is_missing(monkeypatch):
    monkeypatch.delenv(language_routing.WOLOF_MODEL_ENV, raising=False)
    monkeypatch.delenv(language_routing.CLASSIFIER_ENV, raising=False)
    with pytest.raises(ModelUnavailableError) as error:
        language_routing.routing_paths()
    assert language_routing.WOLOF_MODEL_ENV in str(error.value) and language_routing.CLASSIFIER_ENV in str(error.value)


def test_a_directory_that_is_not_a_converted_model_is_refused(configured, tmp_path, monkeypatch):
    monkeypatch.setenv(language_routing.WOLOF_MODEL_ENV, str(tmp_path))
    with pytest.raises(ModelUnavailableError, match="model.bin"):
        language_routing.routing_paths()


def test_a_missing_classifier_file_is_refused(configured, tmp_path, monkeypatch):
    monkeypatch.setenv(language_routing.CLASSIFIER_ENV, str(tmp_path / "absent.json"))
    with pytest.raises(ModelUnavailableError, match="does not point to a file"):
        language_routing.routing_paths()


def test_the_engine_is_assembled_from_the_configuration(configured, fake_models):
    model, _ = configured
    engine = language_routing.build_routing_engine()
    assert engine.name == "language-router" and engine.model == "small+wolof-ct2"
    engines = engine.router.engines
    assert engines["wo"].model == str(model)
    assert engines["fr"] is engines["en"] is engines["default"]  # one multilingual model, loaded once
    assert engines["fr"].model == "small"
    assert engine.router.default_label == "default" and engine.router.language_hints == {"fr", "en"}


def test_french_and_english_can_each_have_their_own_model(configured, fake_models, monkeypatch):
    monkeypatch.setenv(language_routing.FRENCH_MODEL_ENV, "french-finetune")
    monkeypatch.setenv(language_routing.ENGLISH_MODEL_ENV, "small.en")
    engine = language_routing.build_routing_engine()
    engines = engine.router.engines
    assert (engines["fr"].model, engines["en"].model, engines["default"].model) == ("french-finetune", "small.en", "small")
    assert engines["wo"].model != "small"  # the Wolof model is its own engine
    assert engine.model == "small+fr=french-finetune+en=small.en+wolof-ct2"
    # unknown audio and unlisted languages still go to the multilingual default
    assert engine.router._engine_for("unknown")[1] is engines["default"]


def test_the_same_model_for_french_and_english_is_loaded_once(configured, fake_models, monkeypatch):
    monkeypatch.setenv(language_routing.FRENCH_MODEL_ENV, "shared")
    monkeypatch.setenv(language_routing.ENGLISH_MODEL_ENV, "shared")
    engines = language_routing.build_routing_engine().router.engines
    assert engines["fr"] is engines["en"] and engines["fr"] is not engines["default"]


def test_the_rule_detector_needs_no_classifier_file(configured, fake_models, monkeypatch):
    from app.language.rule import FrenchEnglishElseWolofDetector

    monkeypatch.setenv(language_routing.DETECTOR_ENV, "fr-en-else-wolof")
    monkeypatch.delenv(language_routing.CLASSIFIER_ENV)
    engine = language_routing.build_routing_engine()
    assert isinstance(engine.router.detector, FrenchEnglishElseWolofDetector)
    assert engine.router.detector._threshold == pytest.approx(language_routing.DEFAULT_RULE_THRESHOLD)


def test_the_rule_threshold_comes_from_the_environment_and_is_validated(configured, fake_models, monkeypatch):
    monkeypatch.setenv(language_routing.DETECTOR_ENV, "fr-en-else-wolof")
    monkeypatch.setenv(language_routing.RULE_THRESHOLD_ENV, "0.6")
    assert language_routing.build_routing_engine().router.detector._threshold == pytest.approx(0.6)
    for bad in ("abc", "0", "1", "1.4", "-1"):
        monkeypatch.setenv(language_routing.RULE_THRESHOLD_ENV, bad)
        with pytest.raises(ModelUnavailableError, match="strictly between 0 and 1"):
            language_routing.build_routing_engine()


def test_an_invalid_threshold_is_refused_before_any_model_is_loaded(configured, monkeypatch):
    loaded = []

    class Counting(FakeWhisper):
        def __init__(self, model=None):
            loaded.append(model)
            super().__init__(model)

    monkeypatch.setattr(language_routing, "FasterWhisperEngine", Counting)
    monkeypatch.setattr(language_routing, "WhisperLanguageFeatures", lambda *a, **k: loaded.append("lid"))
    monkeypatch.setenv(language_routing.DETECTOR_ENV, "fr-en-else-wolof")
    monkeypatch.setenv(language_routing.RULE_THRESHOLD_ENV, "2")
    with pytest.raises(ModelUnavailableError):
        language_routing.build_routing_engine()
    assert loaded == []  # nothing heavy was loaded for a configuration that could never work


def test_the_default_detector_is_the_trained_classifier(configured, fake_models, monkeypatch):
    from app.language.classifier import ClassifierDetector

    monkeypatch.delenv(language_routing.DETECTOR_ENV, raising=False)
    assert isinstance(language_routing.build_routing_engine().router.detector, ClassifierDetector)


def test_an_unknown_detector_name_is_refused(configured, monkeypatch):
    monkeypatch.setenv(language_routing.DETECTOR_ENV, "magic")
    with pytest.raises(ModelUnavailableError, match="must be 'classifier' or 'fr-en-else-wolof'"):
        language_routing.routing_paths()


def test_the_classifier_detector_still_requires_its_file(configured, monkeypatch):
    monkeypatch.delenv(language_routing.CLASSIFIER_ENV)
    with pytest.raises(ModelUnavailableError, match=language_routing.CLASSIFIER_ENV):
        language_routing.routing_paths()


def test_a_classifier_that_does_not_know_wolof_is_refused(configured, fake_models):
    _, classifier = configured
    write_classifier(classifier, labels=("en", "fr"))
    with pytest.raises(ModelUnavailableError, match="fr, en and wo"):
        language_routing.build_routing_engine()


def test_a_corrupt_classifier_is_unavailable_not_a_crash(configured, fake_models):
    _, classifier = configured
    classifier.write_text("{not json", encoding="utf-8")
    with pytest.raises(ModelUnavailableError, match="could not be read"):
        language_routing.build_routing_engine()


def test_a_language_identification_model_that_cannot_load_is_unavailable(configured, monkeypatch):
    monkeypatch.setattr(language_routing, "FasterWhisperEngine", FakeWhisper)

    def broken(*_args, **_kwargs):
        raise OSError("no network")

    monkeypatch.setattr(language_routing, "WhisperLanguageFeatures", broken)
    with pytest.raises(ModelUnavailableError, match="language identification"):
        language_routing.build_routing_engine()


def test_the_registry_knows_the_engine_and_its_capabilities(configured, fake_models):
    registry.reset_engine()
    try:
        assert registry.get_engine("language-routing").name == "language-router"
        assert registry.capabilities_for("language-routing").timestamps is True
    finally:
        registry.reset_engine()


# -- through the HTTP API ---------------------------------------------------------------------------------------

def client(monkeypatch=None):
    settings = replace(load_settings(), engine="language-routing", api_token=TOKEN)
    return TestClient(create_app(settings), base_url="http://127.0.0.1", headers={"X-LinguaNote-Token": TOKEN})


def test_health_says_why_routing_is_unavailable(monkeypatch):
    monkeypatch.delenv(language_routing.WOLOF_MODEL_ENV, raising=False)
    monkeypatch.delenv(language_routing.CLASSIFIER_ENV, raising=False)
    body = client().get("/health").json()
    assert body["engine_selected"] is False and language_routing.WOLOF_MODEL_ENV in body["setup_message"]


def test_live_transcription_refuses_the_routing_engine_with_a_clear_message():
    replies = []
    with client() as http:  # a client used as a context manager gives the socket the loop the app runs on
        try:
            with http.websocket_connect("ws://127.0.0.1/api/v1/live") as socket:
                socket.send_json({"type": "start", "token": TOKEN, "protocol": 1})
                replies.append(socket.receive_json())
        except CancelledError:  # harness artefact when TestClient cancels the server task on exit
            pass
    assert replies[0]["type"] == "error" and replies[0]["code"] == "model_unavailable"
    assert "files" in replies[0]["message"]


class RoutedLikeEngine:
    name, model = "language-router", "small+wolof"
    capabilities = EngineCapabilities(timestamps=True, language_detection=True)

    def transcribe(self, audio_path):
        return TranscriptionResult(
            text="bonjour waaw", engine=self.name, model=self.model,
            segments=(Segment(0.0, 1.0, "bonjour", "fr"), Segment(1.0, 2.0, "waaw", "wo")),
            warnings=("passage_failed: 2.0-3.0 s (wo) is missing from the text",),
        )


def test_the_upload_response_carries_segment_languages_and_warnings(monkeypatch, tmp_path):
    import shutil
    import wave
    if shutil.which("ffmpeg") is None:
        pytest.skip("FFmpeg not installed")
    registry.reset_engine()
    monkeypatch.setattr(registry, "_build", lambda _name: RoutedLikeEngine())
    wav = tmp_path / "a.wav"
    with wave.open(str(wav), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes(b"\x00\x00" * 16000)
    try:
        response = client().post("/api/v1/transcriptions", files={"file": ("a.wav", wav.read_bytes())})
    finally:
        registry.reset_engine()
    body = response.json()
    assert response.status_code == 200
    assert [s["language"] for s in body["segments"]] == ["fr", "wo"]
    assert body["warnings"] == ["passage_failed: 2.0-3.0 s (wo) is missing from the text"]


def test_the_history_keeps_each_segments_own_language(tmp_path):
    from app.api.routes import save_file_transcription
    from app.storage.database import Database
    from app.storage.history import HistoryRepository

    history = HistoryRepository(Database(tmp_path / "data" / "history.sqlite3"))
    history.set_settings(enabled=True, retention_days=30)
    result = RoutedLikeEngine().transcribe(tmp_path / "unused.wav")
    session_id = save_file_transcription(history, result, 2.0)
    detail = history.get_session(session_id)
    assert [s["language"] for s in detail["segments"]] == ["fr", "wo"]
