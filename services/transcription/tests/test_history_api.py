import shutil
import sqlite3
import wave
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from live_audio import chunks, frame, silence, tone

from app.config import load_settings
from app.engines import registry
from app.engines.base import EngineCapabilities, Segment, TranscriptionResult
from app.main import create_app

TOKEN = "history-api-token-0123456789"
AUTH = {"X-LinguaNote-Token": TOKEN}
LIVE = "ws://127.0.0.1/api/v1/live"
needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg not installed")


class FakeEngine:
    name = "fake"
    model = "fake-model"
    capabilities = EngineCapabilities(timestamps=True, language_detection=True)

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        with wave.open(str(audio_path)) as audio:
            seconds = audio.getnframes() / audio.getframerate()
        return TranscriptionResult(
            text=f"phrase de {seconds:.1f} secondes", engine=self.name, model=self.model, language="fr",
            language_probability=0.9, segments=(Segment(0.0, seconds, f"phrase de {seconds:.1f} secondes"),),
        )


@pytest.fixture(autouse=True)
def engine(monkeypatch):
    registry.reset_engine()
    monkeypatch.setattr(registry, "_build", lambda _name: FakeEngine())
    yield
    registry.reset_engine()


@pytest.fixture
def data_dir(tmp_path):
    return tmp_path / "data"


def make_client(data_dir, **overrides):
    settings = replace(load_settings(), api_token=TOKEN, data_dir=data_dir, **overrides)
    client = TestClient(create_app(settings), base_url="http://127.0.0.1", headers=AUTH)
    client.__enter__()  # one event loop for the whole test (see test_live_api.py)
    return client


@pytest.fixture
def client(data_dir):
    test_client = make_client(data_dir)
    yield test_client
    test_client.__exit__(None, None, None)


def enable(client, retention_days=30):
    response = client.put("/api/v1/history/settings", json={"enabled": True, "retention_days": retention_days})
    assert response.status_code == 200
    return response.json()


def add_stored_session(client, texts, title=None):
    repository = client.app.state.history
    session_id = repository.create_session(kind="live", source="microphone", title=title)
    for index, text in enumerate(texts):
        repository.append_segment(session_id, text=text, start_seconds=float(index), end_seconds=index + 0.9)
    repository.finish_session(session_id, duration_seconds=float(len(texts)))
    return session_id


def wav_bytes(tmp_path, seconds=1.0):
    path = tmp_path / "clip.wav"
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes(b"\x00\x00" * int(16000 * seconds))
    return path.read_bytes()


# -- access ---------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("method, path", [
    ("GET", "/api/v1/history/settings"), ("PUT", "/api/v1/history/settings"),
    ("GET", "/api/v1/history/sessions"), ("GET", "/api/v1/history/sessions/abc"),
    ("DELETE", "/api/v1/history/sessions?confirm=all"), ("GET", "/api/v1/history/sessions/abc/export"),
])
def test_every_history_route_requires_the_token(client, method, path):
    response = client.request(method, path, headers={"X-LinguaNote-Token": "wrong"})
    assert response.status_code == 401


def test_the_history_is_off_by_default_and_nothing_is_stored(client, data_dir):
    assert client.get("/api/v1/history/settings").json() == {"enabled": False, "retention_days": 30}
    assert client.get("/api/v1/history/sessions").json() == {"items": [], "total": 0}
    assert not data_dir.exists()  # not even an empty database


# -- settings -------------------------------------------------------------------------------------------------

def test_settings_are_saved_and_validated(client):
    assert enable(client, 90) == {"enabled": True, "retention_days": 90}
    assert client.get("/api/v1/history/settings").json() == {"enabled": True, "retention_days": 90}
    forever = client.put("/api/v1/history/settings", json={"enabled": True, "retention_days": None})
    assert forever.json()["retention_days"] is None
    bad = client.put("/api/v1/history/settings", json={"enabled": True, "retention_days": 13})
    assert bad.status_code == 422 and bad.json()["code"] == "invalid_retention"
    assert client.put("/api/v1/history/settings", json={"retention_days": 30}).status_code == 422  # `enabled` is required
    assert client.get("/api/v1/history/settings").json()["retention_days"] is None  # unchanged by the refusals


def test_shortening_the_retention_deletes_what_is_now_too_old_immediately(client):
    enable(client, 365)
    old = add_stored_session(client, ["très ancien"])
    with client.app.state.history.database.write() as connection:
        connection.execute("UPDATE sessions SET created_at = '2020-01-01T00:00:00+00:00'")
    enable(client, 7)
    assert client.get(f"/api/v1/history/sessions/{old}").status_code == 404


# -- sessions -------------------------------------------------------------------------------------------------

def test_sessions_can_be_listed_searched_read_renamed_and_deleted(client):
    enable(client)
    wolof = add_stored_session(client, ["Jërëjëf, baal ma", "Waaw"], title="Marché de Dakar")
    add_stored_session(client, ["Le budget annuel"])

    listing = client.get("/api/v1/history/sessions").json()
    assert listing["total"] == 2 and listing["items"][0]["preview"] is not None

    found = client.get("/api/v1/history/sessions", params={"query": "jerejef"}).json()
    assert [item["id"] for item in found["items"]] == [wolof]  # typed without the accents
    assert "\x02" in found["items"][0]["snippet"]

    detail = client.get(f"/api/v1/history/sessions/{wolof}").json()
    assert detail["title"] == "Marché de Dakar" and [s["text"] for s in detail["segments"]] == ["Jërëjëf, baal ma", "Waaw"]

    renamed = client.patch(f"/api/v1/history/sessions/{wolof}", json={"title": "  Réunion  "})
    assert renamed.status_code == 200 and renamed.json()["title"] == "Réunion"

    assert client.delete(f"/api/v1/history/sessions/{wolof}").status_code == 204
    assert client.get(f"/api/v1/history/sessions/{wolof}").status_code == 404
    assert client.get("/api/v1/history/sessions").json()["total"] == 1


def test_unknown_sessions_and_malformed_ids_are_rejected(client):
    enable(client)
    assert client.get("/api/v1/history/sessions/doesnotexist").json()["code"] == "session_not_found"
    assert client.delete("/api/v1/history/sessions/doesnotexist").status_code == 404
    assert client.patch("/api/v1/history/sessions/doesnotexist", json={"title": "x"}).status_code == 404
    for bad_id in ("a b", "a%20b", "x" * 65, "..%2f..%2fetc"):
        assert client.get(f"/api/v1/history/sessions/{bad_id}").status_code in (404, 422)


def test_a_blank_title_is_refused(client):
    enable(client)
    session_id = add_stored_session(client, ["a"])
    assert client.patch(f"/api/v1/history/sessions/{session_id}", json={"title": "   "}).json()["code"] == "invalid_title"
    assert client.patch(f"/api/v1/history/sessions/{session_id}", json={"title": ""}).status_code == 422


def test_paging_limits_are_enforced(client):
    enable(client)
    for query in ({"limit": 0}, {"limit": 201}, {"offset": -1}):
        assert client.get("/api/v1/history/sessions", params=query).status_code == 422
    assert client.get("/api/v1/history/sessions", params={"query": "x" * 201}).status_code == 422


def test_deleting_everything_needs_an_explicit_confirmation(client):
    enable(client)
    add_stored_session(client, ["un"])
    add_stored_session(client, ["deux"])
    refused = client.delete("/api/v1/history/sessions")
    assert refused.status_code == 400 and refused.json()["code"] == "confirmation_required"
    assert client.delete("/api/v1/history/sessions", params={"confirm": "yes"}).status_code == 400
    assert client.get("/api/v1/history/sessions").json()["total"] == 2  # nothing was deleted by the refusals
    assert client.delete("/api/v1/history/sessions", params={"confirm": "all"}).json() == {"deleted": 2}
    assert client.get("/api/v1/history/sessions").json()["total"] == 0


def test_the_history_survives_a_restart_of_the_service(data_dir):
    first = make_client(data_dir)
    enable(first)
    session_id = add_stored_session(first, ["conservé après redémarrage"])
    first.__exit__(None, None, None)

    second = make_client(data_dir)
    try:
        assert second.get("/api/v1/history/settings").json()["enabled"] is True
        assert second.get(f"/api/v1/history/sessions/{session_id}").json()["segments"][0]["text"] == "conservé après redémarrage"
    finally:
        second.__exit__(None, None, None)


def test_starting_the_service_marks_crashed_sessions_and_deletes_expired_ones(data_dir):
    first = make_client(data_dir)
    enable(first, 7)
    crashed = first.app.state.history.create_session(kind="live")  # never finished: the service died
    old = add_stored_session(first, ["périmé"])
    with first.app.state.history.database.write() as connection:
        connection.execute("UPDATE sessions SET created_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", (old,))
    first.__exit__(None, None, None)

    second = make_client(data_dir)  # startup upkeep runs in the lifespan
    try:
        assert second.get(f"/api/v1/history/sessions/{crashed}").json()["status"] == "interrupted"
        assert second.get(f"/api/v1/history/sessions/{old}").status_code == 404
    finally:
        second.__exit__(None, None, None)


# -- export ---------------------------------------------------------------------------------------------------

def test_export_formats_come_with_the_right_type_and_a_safe_file_name(client):
    enable(client)
    session_id = add_stored_session(client, ["Bonjour", "Jërëjëf"], title="../Réunion: Q4?")
    expected = {"txt": "text/plain", "md": "text/markdown", "srt": "application/x-subrip", "vtt": "text/vtt",
                "json": "application/json"}
    for fmt, media_type in expected.items():
        response = client.get(f"/api/v1/history/sessions/{session_id}/export", params={"format": fmt})
        assert response.status_code == 200, fmt
        assert response.headers["content-type"].startswith(media_type)
        disposition = response.headers["content-disposition"]
        assert disposition.startswith("attachment; filename*=UTF-8''") and "/" not in disposition.split("''")[1]
        assert f".{fmt}" in disposition
    assert client.get(f"/api/v1/history/sessions/{session_id}/export").text == "Bonjour\nJërëjëf\n"  # txt by default
    assert "00:00:00,000 --> 00:00:00,900" in client.get(
        f"/api/v1/history/sessions/{session_id}/export", params={"format": "srt"}).text


def test_export_refuses_what_it_cannot_express_without_inventing_it(client):
    enable(client)
    repository = client.app.state.history
    untimed = repository.create_session(kind="file")
    repository.append_segment(untimed, text="sans temps")
    refused = client.get(f"/api/v1/history/sessions/{untimed}/export", params={"format": "srt"})
    assert refused.status_code == 422 and refused.json()["code"] == "export_not_possible"
    assert client.get(f"/api/v1/history/sessions/{untimed}/export", params={"format": "docx"}).json()["code"] == "unsupported_format"
    assert client.get("/api/v1/history/sessions/missing/export").status_code == 404


# -- what gets recorded ---------------------------------------------------------------------------------------

@needs_ffmpeg
def test_a_file_transcription_is_saved_only_when_the_history_is_on(client, data_dir, tmp_path):
    audio = wav_bytes(tmp_path)
    off = client.post("/api/v1/transcriptions", files={"file": ("secret-name.wav", audio, "audio/wav")})
    assert off.status_code == 200 and off.json()["saved_session_id"] is None
    assert not data_dir.exists()  # nothing written while the history is off

    enable(client)
    on = client.post("/api/v1/transcriptions", files={"file": ("secret-name.wav", audio, "audio/wav")})
    saved = on.json()["saved_session_id"]
    assert saved
    stored = client.get(f"/api/v1/history/sessions/{saved}").json()
    assert stored["kind"] == "file" and stored["status"] == "complete"
    assert stored["segments"][0]["language"] == "fr" and stored["segments"][0]["end_seconds"] == pytest.approx(1.0, abs=0.1)
    assert "secret-name" not in str(stored)  # the file name is never kept


@needs_ffmpeg
def test_a_storage_failure_does_not_lose_the_transcription(client, tmp_path, monkeypatch):
    enable(client)

    def broken(*_args, **_kwargs):
        raise sqlite3.OperationalError("disk full")

    monkeypatch.setattr(client.app.state.history, "create_session", broken)
    response = client.post("/api/v1/transcriptions", files={"file": ("a.wav", wav_bytes(tmp_path), "audio/wav")})
    assert response.status_code == 200
    assert response.json()["text"].startswith("phrase de") and response.json()["saved_session_id"] is None


def run_live(client, *, source="microphone", then="stop"):
    with client.websocket_connect(LIVE) as ws:
        ws.send_json({"type": "start", "token": TOKEN, "protocol": 1, "source": source})
        started = ws.receive_json()
        seq = 1
        for piece in chunks(tone(1.0) + silence(1.0)):
            ws.send_bytes(frame(seq, piece))
            seq += 1
        events = []
        while True:
            message = ws.receive_json()
            events.append(message)
            if message["type"] == "final":
                break
        if then == "stop":
            ws.send_json({"type": "stop"})
            while ws.receive_json()["type"] != "session_ended":
                pass
        return started, events


def test_a_live_session_is_recorded_as_it_goes_when_the_history_is_on(client):
    enable(client)
    started, _events = run_live(client, source="system")
    assert started["type"] == "session_started"
    sessions = client.get("/api/v1/history/sessions").json()["items"]
    assert len(sessions) == 1
    stored = client.get(f"/api/v1/history/sessions/{sessions[0]['id']}").json()
    assert (stored["kind"], stored["source"], stored["status"]) == ("live", "system", "complete")
    assert stored["segments"][0]["text"].startswith("phrase de") and stored["segments"][0]["start_seconds"] is not None


def test_a_live_session_is_not_recorded_when_the_history_is_off(client, data_dir):
    run_live(client)
    assert not data_dir.exists()


def test_a_live_session_that_ends_in_error_is_kept_but_marked_interrupted(client):
    enable(client)
    with client.websocket_connect(LIVE) as ws:
        ws.send_json({"type": "start", "token": TOKEN, "protocol": 1, "source": "microphone"})
        ws.receive_json()
        ws.send_bytes(b"\x00\x00\x00\x01\x00")  # malformed frame: the session is aborted
        while ws.receive_json()["type"] != "session_ended":
            pass
    stored = client.get("/api/v1/history/sessions").json()["items"][0]
    assert stored["status"] == "interrupted"


def test_a_storage_failure_during_a_live_session_is_reported_once_and_the_text_still_arrives(client, monkeypatch):
    enable(client)
    repository = client.app.state.history

    def broken(*_args, **_kwargs):
        raise sqlite3.OperationalError("disk full")

    monkeypatch.setattr(repository, "append_segment", broken)
    with client.websocket_connect(LIVE) as ws:
        ws.send_json({"type": "start", "token": TOKEN, "protocol": 1, "source": "both"})
        ws.receive_json()
        seq = 1
        for piece in chunks(tone(1.0) + silence(1.0) + tone(1.0) + silence(1.0)):
            ws.send_bytes(frame(seq, piece))
            seq += 1
        ws.send_json({"type": "stop"})
        kinds = []
        while True:
            message = ws.receive_json()
            kinds.append((message["type"], message.get("code")))
            if message["type"] == "session_ended":
                break
    assert kinds.count(("final", None)) == 2  # the user got both utterances
    assert kinds.count(("error", "history_write_failed")) == 1  # told once, not once per utterance


def test_an_unknown_source_in_the_opening_message_is_refused(client):
    with client.websocket_connect(LIVE) as ws:
        ws.send_json({"type": "start", "token": TOKEN, "protocol": 1, "source": "cloud"})
        assert ws.receive_json()["code"] == "invalid_message"
