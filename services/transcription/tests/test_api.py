import shutil
import wave
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.engines import registry
from app.engines.base import EngineCapabilities, ModelUnavailableError, Segment, TranscriptionResult
from app.main import create_app

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg not installed")


class FakeEngine:
    name = "fake"
    model = "fake-model"
    capabilities = EngineCapabilities(timestamps=True, language_detection=True)

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        return TranscriptionResult(
            text="bonjour tout le monde",
            engine=self.name,
            model=self.model,
            language="fr",
            language_probability=0.9,
            segments=(Segment(0.0, 1.0, "bonjour tout le monde"),),
        )


def make_wav(path: Path, seconds: float = 1.0, rate: int = 16000) -> Path:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(b"\x00\x00" * int(rate * seconds))
    return path


@pytest.fixture(autouse=True)
def fresh_registry():
    registry.reset_engine()
    yield
    registry.reset_engine()


@pytest.fixture
def settings():
    return replace(load_settings(), max_audio_seconds=5.0, max_upload_bytes=1024 * 1024, api_token=None)


@pytest.fixture
def use_fake_engine(monkeypatch):
    monkeypatch.setattr(registry, "_build", lambda _name: FakeEngine())


def client_for(settings) -> TestClient:
    # TrustedHostMiddleware only accepts loopback names, so the default "testserver" host is rejected.
    return TestClient(create_app(settings), base_url="http://127.0.0.1")


def post_file(client, name, content, content_type="application/octet-stream", **kwargs):
    return client.post("/api/v1/transcriptions", files={"file": (name, content, content_type)}, **kwargs)


def test_health_reports_limits_without_loading_a_model(settings):
    response = client_for(settings).get("/health")
    body = response.json()
    assert response.status_code == 200
    assert body["limits"]["max_audio_seconds"] == 5.0
    assert ".wav" in body["limits"]["extensions"]
    assert registry._engine is None


def test_rejects_unsupported_extension(settings, use_fake_engine):
    response = post_file(client_for(settings), "notes.txt", b"hello")
    assert response.status_code == 415
    assert response.json()["code"] == "unsupported_extension"


def test_rejects_empty_file(settings, use_fake_engine):
    response = post_file(client_for(settings), "empty.wav", b"")
    assert response.status_code == 400
    assert response.json()["code"] == "empty_file"


def test_rejects_oversized_upload(settings, use_fake_engine):
    response = post_file(client_for(settings), "big.wav", b"0" * (1024 * 1024 + 1))
    assert response.status_code == 413
    assert response.json()["code"] == "file_too_large"


def test_model_unavailable_maps_to_503(settings, monkeypatch, tmp_path):
    def unavailable(_name):
        raise ModelUnavailableError("model missing")

    monkeypatch.setattr(registry, "_build", unavailable)
    response = post_file(client_for(settings), "a.wav", make_wav(tmp_path / "a.wav").read_bytes())
    assert response.status_code == 503
    assert response.json() == {"detail": "model missing", "code": "model_unavailable"}


@needs_ffmpeg
def test_transcribes_wav_and_returns_metadata(settings, use_fake_engine, tmp_path):
    response = post_file(client_for(settings), "a.wav", make_wav(tmp_path / "a.wav").read_bytes())
    body = response.json()
    assert response.status_code == 200
    assert body["text"] == "bonjour tout le monde"
    assert body["language"] == "fr"
    assert body["timing_available"] is True
    assert body["segments"][0]["end_seconds"] == 1.0
    assert body["duration_seconds"] == pytest.approx(1.0, abs=0.05)


@needs_ffmpeg
def test_rejects_audio_longer_than_limit(settings, use_fake_engine, tmp_path):
    response = post_file(client_for(settings), "long.wav", make_wav(tmp_path / "l.wav", seconds=8).read_bytes())
    assert response.status_code == 413
    assert response.json()["code"] == "audio_too_long"


@needs_ffmpeg
def test_rejects_undecodable_media(settings, use_fake_engine):
    response = post_file(client_for(settings), "broken.mp3", b"not really audio")
    assert response.status_code == 415
    assert response.json()["code"] == "no_audio_stream"


def test_missing_ffmpeg_maps_to_503(settings, use_fake_engine, tmp_path):
    missing = replace(settings, ffmpeg="ffmpeg-does-not-exist")
    response = post_file(client_for(missing), "a.wav", make_wav(tmp_path / "a.wav").read_bytes())
    assert response.status_code == 503
    assert response.json()["code"] == "ffmpeg_missing"


def test_unexpected_engine_failure_hides_internals(settings, monkeypatch, tmp_path):
    class Exploding(FakeEngine):
        def transcribe(self, audio_path):
            raise RuntimeError("secret internal detail")

    monkeypatch.setattr(registry, "_build", lambda _name: Exploding())
    client = client_for(settings)
    if shutil.which("ffmpeg") is None:
        pytest.skip("FFmpeg not installed")
    response = post_file(client, "a.wav", make_wav(tmp_path / "a.wav").read_bytes())
    assert response.status_code == 500
    assert response.json()["code"] == "inference_failed"
    assert "secret" not in response.text


def test_token_is_required_when_configured(settings):
    client = client_for(replace(settings, api_token="s3cret"))
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"X-LinguaNote-Token": "wrong"}).status_code == 401
    assert client.get("/health", headers={"X-LinguaNote-Token": "s3cret"}).status_code == 200


def test_non_loopback_host_is_rejected(settings):
    client = TestClient(create_app(settings), base_url="http://evil.example")
    assert client.get("/health").status_code == 400


def test_engine_is_loaded_once_under_concurrency(monkeypatch):
    import threading
    import time

    built = []

    def slow_build(_name):
        built.append(1)
        time.sleep(0.05)
        return FakeEngine()

    monkeypatch.setattr(registry, "_build", slow_build)
    threads = [threading.Thread(target=registry.get_engine, args=("fake",)) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(built) == 1
