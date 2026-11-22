import json
import threading
import time
import wave
from concurrent.futures import CancelledError
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from live_audio import chunks, frame, silence, tone
from starlette.websockets import WebSocketDisconnect

from app.config import load_settings
from app.engines import registry
from app.engines.base import EngineCapabilities, ModelUnavailableError, TranscriptionResult
from app.main import create_app

TOKEN = "live-api-token-0123456789"
# Starlette's TestClient defaults WebSocket URLs to the host "testserver", which TrustedHostMiddleware refuses.
LIVE = "ws://127.0.0.1/api/v1/live"


class FakeEngine:
    name = "fake"
    model = "fake-model"
    capabilities = EngineCapabilities(timestamps=True, language_detection=True)
    fail = False

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        if self.fail:
            raise RuntimeError("engine exploded")
        with wave.open(str(audio_path)) as audio:
            seconds = audio.getnframes() / audio.getframerate()
        return TranscriptionResult(text=f"audio {seconds:.1f}", engine=self.name, model=self.model,
                                   language="fr", language_probability=0.9)


@pytest.fixture(autouse=True)
def fresh_registry(monkeypatch):
    registry.reset_engine()
    monkeypatch.setattr(registry, "_build", lambda _name: FakeEngine())
    yield
    registry.reset_engine()


_open_clients: list[TestClient] = []


def make_client(**overrides) -> TestClient:
    """A client kept open for the whole test: TestClient gives every WebSocket its own event loop unless it
    is used as a context manager, and a live session (queue, worker task) belongs to one loop. uvicorn serves
    all connections from a single loop, so this only matters in tests."""
    settings = replace(load_settings(), api_token=TOKEN, **overrides)
    client = TestClient(create_app(settings), base_url="http://127.0.0.1")
    client.__enter__()
    _open_clients.append(client)
    return client


@pytest.fixture(autouse=True)
def close_clients():
    yield
    while _open_clients:
        _open_clients.pop().__exit__(None, None, None)


@contextmanager
def connect(client: TestClient):
    """Open the live socket. On exit TestClient cancels the server task even if it is still cleaning up,
    which surfaces as CancelledError; that is a harness artefact, not a failure of the code under test."""
    try:
        with client.websocket_connect(LIVE) as ws:
            yield ws
    except CancelledError:
        pass


@contextmanager
def watchdog(ws, seconds: float = 20.0):
    """A hung receive would block the suite: close the socket so it fails instead."""
    timer = threading.Timer(seconds, lambda: ws.close(1000))
    timer.start()
    try:
        yield
    finally:
        timer.cancel()


def start(ws, token: str = TOKEN) -> dict:
    ws.send_json({"type": "start", "token": token, "protocol": 1})
    return ws.receive_json()


def send_audio(ws, pcm: bytes, first_seq: int = 1, step: float = 0.1) -> int:
    seq = first_seq
    for piece in chunks(pcm, step):
        ws.send_bytes(frame(seq, piece))
        seq += 1
    return seq


def read_until(ws, event_type: str, keep: list | None = None) -> dict:
    """Read messages until one of `event_type`; transport acks are skipped, others optionally collected."""
    while True:
        message = ws.receive_json()
        if message["type"] == event_type:
            return message
        if message["type"] == "error" and event_type != "error":
            raise AssertionError(f"unexpected error while waiting for {event_type}: {message}")
        if message["type"] != "audio_ack" and keep is not None:
            keep.append(message)


def test_opening_requires_a_valid_token():
    client = make_client()
    with connect(client) as ws, watchdog(ws):
        ws.send_json({"type": "start", "token": "wrong", "protocol": 1})
        assert ws.receive_json() == {
            "type": "error", "code": "unauthorized", "message": "Missing or invalid API token.", "fatal": True,
        }
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 1008


def test_a_page_from_another_origin_cannot_open_the_socket():
    client = make_client()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(LIVE, headers={"Origin": "https://evil.example"}) as ws:
            ws.receive_json()


@pytest.mark.parametrize("opening", [
    {"type": "nope"},
    {"type": "start", "token": TOKEN},  # protocol missing
    {"type": "start", "token": TOKEN, "protocol": 1, "extra": 1},
    {"type": "resume", "token": TOKEN, "protocol": 1, "session_id": "", "last_event_id": 0},
    {"type": "resume", "token": TOKEN, "protocol": 1, "session_id": "x", "last_event_id": -1},
])
def test_malformed_opening_messages_are_rejected(opening):
    with connect(make_client()) as ws, watchdog(ws):
        ws.send_json(opening)
        assert ws.receive_json()["code"] == "invalid_message"


def test_non_json_and_unsupported_protocol_are_rejected():
    with connect(make_client()) as ws, watchdog(ws):
        ws.send_text("not json")
        assert ws.receive_json()["code"] == "invalid_message"
    with connect(make_client()) as ws, watchdog(ws):
        ws.send_json({"type": "start", "token": TOKEN, "protocol": 99})
        assert "Unsupported protocol" in ws.receive_json()["message"]


def test_session_started_describes_the_audio_format_and_engine():
    with connect(make_client()) as ws, watchdog(ws):
        started = start(ws)
        assert started["type"] == "session_started" and started["resumed"] is False
        assert started["audio_ack"] == 0 and started["protocol"] == 1
        assert started["audio"] == {"format": "pcm_s16le", "sample_rate": 16000, "channels": 1,
                                    "max_frame_bytes": 65536}
        assert started["engine"] == {"name": "fake", "model": "fake-model", "timestamps": True}
        assert "event_id" not in started
        ws.send_json({"type": "stop"})
        assert read_until(ws, "session_ended")["reason"] == "client_stop"


def test_speech_is_transcribed_and_acknowledged_then_stop_ends_the_session():
    with connect(make_client()) as ws, watchdog(ws):
        start(ws)
        ws.send_bytes(frame(1, tone(0.1)))
        assert ws.receive_json() == {"type": "audio_ack", "seq": 1}
        send_audio(ws, tone(1.0) + silence(1.0), first_seq=2)
        final = read_until(ws, "final")
        assert final["utterance_id"] == 1 and final["text"].startswith("audio ")
        assert final["event_id"] >= 1
        ws.send_json({"type": "stop"})
        ended = read_until(ws, "session_ended")
        assert ended["reason"] == "client_stop" and ended["utterances"] == 1
        assert ended["event_id"] > final["event_id"]


def test_ping_gets_a_pong_without_an_event_id():
    with connect(make_client()) as ws, watchdog(ws):
        start(ws)
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def test_duplicate_frames_are_reacknowledged_and_gaps_are_reported():
    with connect(make_client()) as ws, watchdog(ws):
        start(ws)
        piece = tone(0.1)
        ws.send_bytes(frame(1, piece))
        assert ws.receive_json() == {"type": "audio_ack", "seq": 1}
        ws.send_bytes(frame(1, piece))  # duplicate
        assert ws.receive_json() == {"type": "audio_ack", "seq": 1}
        ws.send_bytes(frame(3, piece))  # frame 2 is missing
        gap = ws.receive_json()
        assert gap["code"] == "sequence_gap" and gap["expected"] == 2 and gap["fatal"] is False
        # A rejected frame is not acknowledged: the next message is the ack of the frame sent next.
        ws.send_bytes(frame(2, piece))
        assert ws.receive_json() == {"type": "audio_ack", "seq": 2}


def test_a_replaced_connection_cannot_feed_or_stop_the_session():
    client = make_client()
    manager = client.app.state.live_manager
    with connect(client) as old, watchdog(old):
        session_id = start(old)["session_id"]
        with connect(client) as new, watchdog(new):
            new.send_json({"type": "resume", "token": TOKEN, "protocol": 1, "session_id": session_id,
                           "last_event_id": 0})
            assert new.receive_json()["resumed"] is True
            old.send_bytes(frame(1, tone(0.1)))  # the old socket is still open on the client's side
            old.send_json({"type": "stop"})
            time.sleep(0.3)
            session = manager.get(session_id)
            assert session.last_seq == 0 and not session.ended
            with pytest.raises(WebSocketDisconnect):
                old.receive_json()  # the server closed it
            new.send_bytes(frame(1, tone(0.1)))
            assert new.receive_json() == {"type": "audio_ack", "seq": 1}


def test_oversized_or_binary_opening_messages_are_refused():
    with connect(make_client()) as ws, watchdog(ws):
        ws.send_text(json.dumps({"type": "start", "token": "x" * 5000, "protocol": 1}))
        assert ws.receive_json()["code"] == "invalid_message"
    with connect(make_client()) as ws, watchdog(ws):
        ws.send_bytes(b"\x00\x01\x02")
        assert ws.receive_json()["code"] == "invalid_message"


def test_an_oversized_control_message_ends_the_session():
    with connect(make_client()) as ws, watchdog(ws):
        start(ws)
        ws.send_text("x" * 300)
        error = read_until(ws, "error")
        assert error["code"] == "invalid_message" and error["fatal"] is True


@pytest.mark.parametrize("payload, code", [
    (b"\x00\x00\x00\x01\x00", "invalid_message"),  # odd number of PCM bytes
    (b"\x00\x00", "invalid_message"),  # no payload at all
    (frame(1, b"\x00\x00" * 40000), "frame_too_large"),
])
def test_invalid_audio_frames_end_the_session_with_a_fatal_error(payload, code):
    with connect(make_client()) as ws, watchdog(ws):
        start(ws)
        ws.send_bytes(payload)
        error = read_until(ws, "error")
        assert error["code"] == code and error["fatal"] is True and "event_id" in error
        assert read_until(ws, "session_ended")["reason"] == "error"


def test_unknown_control_messages_are_fatal():
    with connect(make_client()) as ws, watchdog(ws):
        start(ws)
        ws.send_json({"type": "explode"})
        assert read_until(ws, "error")["code"] == "invalid_message"


def test_a_second_session_is_refused_while_one_is_running():
    client = make_client()
    with connect(client) as first, watchdog(first):
        start(first)
        with connect(client) as second, watchdog(second):
            second.send_json({"type": "start", "token": TOKEN, "protocol": 1})
            assert second.receive_json()["code"] == "busy"


def test_a_dropped_connection_can_be_resumed_without_losing_or_repeating_text():
    client = make_client()
    with connect(client) as ws, watchdog(ws):
        started = start(ws)
        send_audio(ws, tone(1.0) + silence(1.0))
        first_final = read_until(ws, "final")
        session_id = started["session_id"]
    # The connection is gone (no stop). Resume and ask for everything after the event already seen.
    with connect(client) as ws, watchdog(ws):
        ws.send_json({"type": "resume", "token": TOKEN, "protocol": 1, "session_id": session_id,
                      "last_event_id": first_final["event_id"]})
        resumed = ws.receive_json()
        assert resumed["type"] == "session_started" and resumed["resumed"] is True
        assert resumed["session_id"] == session_id
        assert resumed["audio_ack"] == 20  # 2 s of 100 ms frames were acknowledged before the drop
        # Continue the audio where the server stopped counting, then end.
        send_audio(ws, tone(1.0) + silence(1.0), first_seq=resumed["audio_ack"] + 1)
        second_final = read_until(ws, "final")
        assert second_final["utterance_id"] == 2  # the first final is NOT replayed
        assert second_final["event_id"] > first_final["event_id"]
        ws.send_json({"type": "stop"})
        assert read_until(ws, "session_ended")["utterances"] == 2


def test_resume_replays_events_the_client_missed():
    client = make_client()
    with connect(client) as ws, watchdog(ws):
        session_id = start(ws)["session_id"]
        send_audio(ws, tone(1.0) + silence(1.0))
        original = read_until(ws, "final")
    with connect(client) as ws, watchdog(ws):
        ws.send_json({"type": "resume", "token": TOKEN, "protocol": 1, "session_id": session_id,
                      "last_event_id": 0})
        assert ws.receive_json()["type"] == "session_started"
        assert read_until(ws, "final") == original  # same event, same id: the client can de-duplicate


def test_resume_of_an_unknown_session_or_with_a_wrong_token_fails():
    client = make_client()
    with connect(client) as ws, watchdog(ws):
        ws.send_json({"type": "resume", "token": TOKEN, "protocol": 1, "session_id": "nope", "last_event_id": 0})
        assert ws.receive_json()["code"] == "session_not_found"
    with connect(client) as ws, watchdog(ws):
        ws.send_json({"type": "resume", "token": "x", "protocol": 1, "session_id": "nope", "last_event_id": 0})
        assert ws.receive_json()["code"] == "unauthorized"


def test_a_session_nobody_resumes_expires_and_frees_the_slot():
    client = make_client(live_resume_seconds=0.2)
    with connect(client) as ws, watchdog(ws):
        session_id = start(ws)["session_id"]
    time.sleep(0.5)
    with connect(client) as ws, watchdog(ws):
        ws.send_json({"type": "resume", "token": TOKEN, "protocol": 1, "session_id": session_id, "last_event_id": 0})
        assert ws.receive_json()["code"] == "session_not_found"
    with connect(client) as ws, watchdog(ws):
        assert start(ws)["type"] == "session_started"  # no longer blocked by the abandoned session


def test_silence_for_too_long_ends_the_session():
    with connect(make_client(live_idle_timeout_seconds=0.3)) as ws, watchdog(ws):
        start(ws)
        assert read_until(ws, "session_ended")["reason"] == "idle_timeout"


def test_the_maximum_session_duration_is_enforced():
    with connect(make_client(live_max_session_seconds=1.0)) as ws, watchdog(ws):
        start(ws)
        send_audio(ws, tone(1.5))
        assert read_until(ws, "session_ended")["reason"] == "max_duration"


def test_an_unavailable_model_is_reported_before_any_session_exists(monkeypatch):
    def unavailable(_name):
        raise ModelUnavailableError("model missing")

    monkeypatch.setattr(registry, "_build", unavailable)
    with connect(make_client()) as ws, watchdog(ws):
        ws.send_json({"type": "start", "token": TOKEN, "protocol": 1})
        message = ws.receive_json()
        assert message["code"] == "model_unavailable" and message["message"] == "model missing"
        assert "event_id" not in message


def test_engine_failures_are_reported_per_utterance_without_leaking_internals(monkeypatch):
    engine = FakeEngine()
    engine.fail = True
    monkeypatch.setattr(registry, "_build", lambda _name: engine)
    with connect(make_client()) as ws, watchdog(ws):
        start(ws)
        send_audio(ws, tone(1.0) + silence(1.0))
        error = read_until(ws, "error")
        assert error["code"] == "inference_failed" and error["fatal"] is False and error["utterance_id"] == 1
        assert "exploded" not in str(error)
        ws.send_json({"type": "stop"})
        assert read_until(ws, "session_ended")["utterances"] == 0


def test_language_routing_is_used_live_with_long_passages_and_no_partial_text(monkeypatch):
    built = []
    monkeypatch.setattr(registry, "_build", lambda name: built.append(name) or FakeEngine())
    with connect(make_client(engine="language-routing")) as ws, watchdog(ws):
        assert start(ws)["type"] == "session_started"
        # two bursts split by a 1.2 s pause: without routing they are two utterances (with partials)
        send_audio(ws, tone(3.0) + silence(1.2) + tone(3.0) + silence(1.2))
        ws.send_json({"type": "stop"})
        seen: list = []
        read_until(ws, "session_ended", keep=seen)
    assert built == [registry.LIVE_ROUTING]
    assert [m["type"] for m in seen] == ["final"]  # one passage, no partial
    assert seen[0]["end_seconds"] - seen[0]["start_seconds"] > 6.5


def test_without_routing_the_live_behaviour_is_unchanged(monkeypatch):
    built = []
    monkeypatch.setattr(registry, "_build", lambda name: built.append(name) or FakeEngine())
    with connect(make_client(engine="faster-whisper")) as ws, watchdog(ws):
        start(ws)
        send_audio(ws, tone(1.0) + silence(1.2) + tone(1.0) + silence(1.2))
        ws.send_json({"type": "stop"})
        seen: list = []
        read_until(ws, "session_ended", keep=seen)
    assert built == ["faster-whisper"]
    assert [m["type"] for m in seen].count("final") == 2


def test_a_live_session_can_be_limited_to_one_language(monkeypatch):
    class Hinted(FakeEngine):
        accepts_language_hint = True
        seen: list = []

        def transcribe(self, audio_path: Path, language: str | None = None) -> TranscriptionResult:
            self.seen.append(language)
            return super().transcribe(audio_path)

    monkeypatch.setattr(registry, "_build", lambda _name: Hinted())
    with connect(make_client(engine="faster-whisper")) as ws, watchdog(ws):
        ws.send_json({"type": "start", "token": TOKEN, "protocol": 1, "language": "en"})
        assert ws.receive_json()["type"] == "session_started"
        send_audio(ws, tone(1.0) + silence(1.2))
        final = read_until(ws, "final")
        assert (final["language"], final["language_probability"]) == ("en", None)
        ws.send_json({"type": "stop"})
        read_until(ws, "session_ended")
    assert Hinted.seen and set(Hinted.seen) == {"en"}


def test_a_live_language_the_engine_cannot_serve_is_refused_at_once():
    with connect(make_client(engine="faster-whisper")) as ws, watchdog(ws):
        ws.send_json({"type": "start", "token": TOKEN, "protocol": 1, "language": "wo"})
        message = ws.receive_json()
        assert message["type"] == "error" and message["code"] == "unsupported_language" and message["fatal"] is True


def test_an_invalid_live_language_is_an_invalid_opening():
    with connect(make_client()) as ws, watchdog(ws):
        ws.send_json({"type": "start", "token": TOKEN, "protocol": 1, "language": "de"})
        assert ws.receive_json()["code"] == "invalid_message"


def test_routing_limited_to_french_gets_ordinary_live_passages(monkeypatch):
    class Router:
        name, model = "language-router", "routed"
        capabilities = EngineCapabilities(timestamps=True, language_detection=True)

        def __init__(self):
            class Hinted(FakeEngine):
                accepts_language_hint = True

                def transcribe(self, audio_path: Path, language: str | None = None) -> TranscriptionResult:
                    return super().transcribe(audio_path)
            self.router = type("R", (), {"engines": {"default": Hinted(), "fr": Hinted(), "en": Hinted(),
                                                     "wo": FakeEngine()}})()

    monkeypatch.setattr(registry, "_build", lambda _name: Router())
    with connect(make_client(engine="language-routing")) as ws, watchdog(ws):
        ws.send_json({"type": "start", "token": TOKEN, "protocol": 1, "language": "fr"})
        assert ws.receive_json()["type"] == "session_started"
        send_audio(ws, tone(1.0) + silence(1.2) + tone(1.0) + silence(1.2))
        ws.send_json({"type": "stop"})
        seen: list = []
        read_until(ws, "session_ended", keep=seen)
    # One language, no detection: short passages again (two of them), not the 10 to 20 s routing passages.
    assert [m["type"] for m in seen].count("final") == 2
