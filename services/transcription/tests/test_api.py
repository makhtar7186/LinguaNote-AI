import shutil
import wave
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import ConfigurationError, load_settings
from app.engines import registry
from app.engines.base import EngineCapabilities, ModelUnavailableError, Segment, TranscriptionResult
from app.main import create_app

TOKEN = "test-token-0123456789"
AUTH = {"X-LinguaNote-Token": TOKEN}

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
    return replace(load_settings(), max_audio_seconds=5.0, max_upload_bytes=1024 * 1024, api_token=TOKEN)


@pytest.fixture
def use_fake_engine(monkeypatch):
    monkeypatch.setattr(registry, "_build", lambda _name: FakeEngine())


def client_for(settings) -> TestClient:
    # TrustedHostMiddleware only accepts loopback names, so the default "testserver" host is rejected.
    return TestClient(create_app(settings), base_url="http://127.0.0.1", headers=AUTH)


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


def test_token_is_required(settings):
    client = TestClient(create_app(settings), base_url="http://127.0.0.1")
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"X-LinguaNote-Token": "wrong"}).status_code == 401
    assert client.get("/health", headers=AUTH).status_code == 200


def test_startup_refuses_to_run_without_a_token(settings):
    with pytest.raises(ConfigurationError, match="LINGUANOTE_API_TOKEN is required"):
        create_app(replace(settings, api_token=None))


def test_startup_rejects_a_short_token(settings):
    with pytest.raises(ConfigurationError, match="at least"):
        create_app(replace(settings, api_token="short"))


def test_explicit_opt_out_allows_running_without_a_token(settings):
    app = create_app(replace(settings, api_token=None, allow_no_auth=True))
    assert TestClient(app, base_url="http://127.0.0.1").get("/health").status_code == 200


def test_cross_origin_preflight_is_not_granted(settings):
    response = client_for(settings).options(
        "/api/v1/transcriptions",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-linguanote-token",
        },
    )
    assert "access-control-allow-origin" not in response.headers


def test_declared_oversized_body_is_refused_before_parsing(settings):
    response = client_for(settings).post(
        "/api/v1/transcriptions",
        content=b"x",
        headers={"Content-Length": str(10 * 1024 * 1024), "Content-Type": "multipart/form-data; boundary=b"},
    )
    assert response.status_code == 413
    assert response.json()["code"] == "file_too_large"


def test_streamed_oversized_body_is_cut_off(settings):
    def chunks():
        # Well-formed multipart, streamed (no Content-Length): 2.5 MiB against a 1 MiB limit plus overhead.
        yield b'--b\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n\r\n'
        for _ in range(40):
            yield b"0" * (64 * 1024)
        yield b"\r\n--b--\r\n"

    response = client_for(settings).post(
        "/api/v1/transcriptions", content=chunks(),
        headers={"Content-Type": "multipart/form-data; boundary=b"},
    )
    assert response.status_code == 413


@needs_ffmpeg
def test_overload_is_rejected_with_429_instead_of_queueing(settings, monkeypatch, tmp_path):
    import threading
    import time

    class Slow(FakeEngine):
        def transcribe(self, audio_path):
            time.sleep(0.6)
            return super().transcribe(audio_path)

    monkeypatch.setattr(registry, "_build", lambda _name: Slow())
    client = client_for(replace(settings, max_pending_transcriptions=1))
    audio = make_wav(tmp_path / "a.wav").read_bytes()
    statuses = []

    def attempt():
        statuses.append(post_file(client, "a.wav", audio).status_code)

    threads = [threading.Thread(target=attempt) for _ in range(3)]
    for thread in threads:
        thread.start()
        time.sleep(0.1)
    for thread in threads:
        thread.join()
    assert sorted(statuses) == [200, 429, 429]


def test_health_reports_the_engine_effective_audio_limit(settings):
    omnilingual = replace(settings, engine="omnilingual-ctc", max_audio_seconds=600.0)
    assert client_for(omnilingual).get("/health").json()["limits"]["max_audio_seconds"] == 39.0
    whisper = replace(settings, engine="faster-whisper", max_audio_seconds=600.0)
    assert client_for(whisper).get("/health").json()["limits"]["max_audio_seconds"] == 600.0


@needs_ffmpeg
def test_inference_timeout_maps_to_504_and_temp_dir_is_removed(settings, monkeypatch, tmp_path):
    import glob
    import tempfile
    import time

    class Slow(FakeEngine):
        def transcribe(self, audio_path):
            time.sleep(0.5)
            return super().transcribe(audio_path)

    pattern = str(Path(tempfile.gettempdir()) / "linguanote-*")
    before = set(glob.glob(pattern))
    monkeypatch.setattr(registry, "_build", lambda _name: Slow())
    short = replace(settings, inference_timeout_seconds=0)
    response = post_file(client_for(short), "a.wav", make_wav(tmp_path / "a.wav").read_bytes())
    assert response.status_code == 504
    assert response.json()["code"] == "inference_timeout"
    time.sleep(1.0)  # the worker finishes, then the deferred cleanup removes the directory
    assert set(glob.glob(pattern)) - before == set()


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


# -- single-language mode ---------------------------------------------------------------------------------------

class HintedFakeEngine(FakeEngine):
    accepts_language_hint = True

    def __init__(self):
        self.languages: list = []

    def transcribe(self, audio_path: Path, language: str | None = None) -> TranscriptionResult:
        self.languages.append(language)
        return super().transcribe(audio_path)


def test_health_lists_the_languages_the_single_language_mode_offers(settings):
    body = client_for(replace(settings, engine="faster-whisper")).get("/health").json()
    expected = ["en", "fr"] if body["engine_selected"] else []
    assert body["languages"] == expected  # faster-whisper never offers Wolof
    assert registry._engine is None


def test_an_unknown_language_is_refused_before_any_work(settings, use_fake_engine, tmp_path):
    response = post_file(client_for(settings), "a.wav", make_wav(tmp_path / "a.wav").read_bytes(), data={"language": "de"})
    assert response.status_code == 422 and response.json()["code"] == "unsupported_language"
    assert registry._engine is None


@needs_ffmpeg
def test_wolof_is_refused_by_an_engine_without_a_wolof_model(settings, use_fake_engine, tmp_path):
    response = post_file(client_for(settings), "a.wav", make_wav(tmp_path / "a.wav").read_bytes(), data={"language": "wo"})
    assert response.status_code == 422 and response.json()["code"] == "unsupported_language"
    assert "wolof" in response.json()["detail"]


@needs_ffmpeg
def test_a_chosen_language_is_imposed_and_reported_as_chosen(settings, monkeypatch, tmp_path):
    engine = HintedFakeEngine()
    monkeypatch.setattr(registry, "_build", lambda _name: engine)
    client = client_for(settings)
    chosen = post_file(client, "a.wav", make_wav(tmp_path / "a.wav").read_bytes(), data={"language": "en"})
    assert chosen.status_code == 200
    assert (chosen.json()["language"], chosen.json()["language_probability"]) == ("en", None)
    auto = post_file(client, "a.wav", make_wav(tmp_path / "a.wav").read_bytes(), data={"language": "auto"})
    assert auto.status_code == 200 and auto.json()["language"] == "fr"  # detected, as before
    assert engine.languages == ["en", None]
