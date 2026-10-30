import asyncio
import threading
import wave
from pathlib import Path

import pytest
from live_audio import chunks, silence, tone

from app.engines.base import EngineCapabilities, TranscriptionResult
from app.live.manager import BusyError, LiveManager
from app.live.segmenter import SegmenterConfig
from app.live.session import FrameResult, LiveLimits, LiveSession

LIMITS = LiveLimits(max_session_seconds=3600, idle_timeout_seconds=30, resume_seconds=30, job_timeout_seconds=5)


class FakeEngine:
    name = "fake"
    model = "fake-model"
    capabilities = EngineCapabilities(timestamps=True, language_detection=True)

    def __init__(self, text=None, fail=False, gate: threading.Event | None = None, delay: float = 0.0):
        self.text, self.fail, self.gate, self.delay = text, fail, gate, delay
        self.calls = 0

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        self.calls += 1
        if self.gate is not None:
            self.gate.wait(10)
        if self.delay:
            import time
            time.sleep(self.delay)
        if self.fail:
            raise RuntimeError("engine exploded")
        with wave.open(str(audio_path)) as audio:
            seconds = audio.getnframes() / audio.getframerate()
        text = f"audio {seconds:.1f}" if self.text is None else self.text
        return TranscriptionResult(text=text, engine=self.name, model=self.model, language="fr",
                                   language_probability=0.9)


async def feed(session: LiveSession, pcm: bytes, start_seq: int = 1, step: float = 0.1) -> int:
    seq = start_seq
    for piece in chunks(pcm, step):
        assert session.accept_frame(seq, piece) in (FrameResult.ACCEPTED, FrameResult.IGNORED)
        seq += 1
        await asyncio.sleep(0)
    return seq


async def until(predicate, timeout: float = 5.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.01)


def types(session: LiveSession) -> list[str]:
    return [event["type"] for event in session.events]


def test_a_spoken_utterance_becomes_a_final_event_with_a_session_timeline():
    async def scenario():
        session = LiveSession("s", FakeEngine(), LIMITS)
        await feed(session, tone(1.0) + silence(1.0))
        await until(lambda: "final" in types(session))
        final = next(e for e in session.events if e["type"] == "final")
        assert final["utterance_id"] == 1 and final["text"].startswith("audio ")
        assert final["language"] == "fr" and final["language_probability"] == 0.9
        assert 0.0 <= final["start_seconds"] < final["end_seconds"] <= 2.0
        assert [e["event_id"] for e in session.events] == list(range(1, len(session.events) + 1))
        session.discard()

    asyncio.run(scenario())


def test_duplicate_frames_are_ignored_and_gaps_are_reported_without_advancing():
    async def scenario():
        session = LiveSession("s", FakeEngine(), LIMITS)
        piece = tone(0.1)
        assert session.accept_frame(1, piece) is FrameResult.ACCEPTED
        assert session.accept_frame(1, piece) is FrameResult.DUPLICATE
        assert session.accept_frame(3, piece) is FrameResult.GAP
        assert session.last_seq == 1
        assert session.accept_frame(2, piece) is FrameResult.ACCEPTED
        assert session.accept_frame(3, piece) is FrameResult.ACCEPTED
        assert session.segmenter.total_seconds == pytest.approx(0.3)  # the duplicate was not counted twice
        session.discard()

    asyncio.run(scenario())


def test_partials_grow_in_revision_and_never_follow_their_final():
    async def scenario():
        config = SegmenterConfig(partial_interval_seconds=1.0)
        session = LiveSession("s", FakeEngine(), LIMITS, segmenter_config=config)
        seq = 1
        for _ in range(4):  # 4 s of speech, paced so the worker can answer between bursts
            seq = await feed(session, tone(1.0), seq)
            await asyncio.sleep(0.15)
        await feed(session, silence(1.0), seq)
        await until(lambda: "final" in types(session))
        partials = [e for e in session.events if e["type"] == "partial"]
        assert partials, "expected at least one provisional result"
        assert [p["revision"] for p in partials] == list(range(1, len(partials) + 1))
        final_position = types(session).index("final")
        assert all(i < final_position for i, e in enumerate(session.events) if e["type"] == "partial")
        session.discard()

    asyncio.run(scenario())


def test_a_partial_is_dropped_instead_of_queued_when_the_worker_is_busy():
    async def scenario():
        gate = threading.Event()
        config = SegmenterConfig(partial_interval_seconds=0.5)
        session = LiveSession("s", FakeEngine(gate=gate), LIMITS, segmenter_config=config)
        await feed(session, tone(1.2))  # first partial occupies the (blocked) worker
        await until(lambda: session._jobs.empty())
        queued_before = session._jobs.qsize()
        await feed(session, tone(2.0), start_seq=13)  # more partials are due, but the worker is busy
        assert session._jobs.qsize() == queued_before
        gate.set()
        session.discard()

    asyncio.run(scenario())


def test_speech_that_the_engine_does_not_recognise_produces_no_event():
    async def scenario():
        session = LiveSession("s", FakeEngine(text="   "), LIMITS)
        await feed(session, tone(1.0) + silence(1.0))
        session.end("client_stop")
        await until(lambda: session.ended)
        assert types(session) == ["session_ended"]
        assert session.events[-1]["utterances"] == 0

    asyncio.run(scenario())


def test_a_failed_utterance_is_reported_explicitly_and_the_session_continues():
    async def scenario():
        engine = FakeEngine(fail=True)
        session = LiveSession("s", engine, LIMITS)
        seq = await feed(session, tone(1.0) + silence(1.0))
        await until(lambda: "error" in types(session))
        error = next(e for e in session.events if e["type"] == "error")
        assert error["code"] == "inference_failed" and error["fatal"] is False and error["utterance_id"] == 1
        assert "exploded" not in error["message"]  # internals stay in the server log

        engine.fail = False
        await feed(session, tone(1.0) + silence(1.0), seq)
        await until(lambda: "final" in types(session))
        assert next(e for e in session.events if e["type"] == "final")["utterance_id"] == 2
        session.discard()

    asyncio.run(scenario())


def test_an_utterance_that_takes_too_long_is_skipped_with_an_error():
    async def scenario():
        limits = LiveLimits(3600, 30, 30, job_timeout_seconds=0.05)
        session = LiveSession("s", FakeEngine(delay=0.5), limits)
        await feed(session, tone(1.0) + silence(1.0))
        await until(lambda: "error" in types(session))
        assert next(e for e in session.events if e["type"] == "error")["code"] == "inference_timeout"
        session.discard()

    asyncio.run(scenario())


def test_overload_stops_the_session_explicitly_instead_of_dropping_text():
    async def scenario():
        gate = threading.Event()
        limits = LiveLimits(3600, 30, 30, 5, max_queued_jobs=1)
        session = LiveSession("s", FakeEngine(gate=gate), limits)
        burst = (tone(0.5) + silence(1.0)) * 4
        assert session.accept_frame(1, burst) is FrameResult.ACCEPTED  # several utterances end in one frame
        assert session.ended and session.end_reason == "error"
        assert types(session)[-2:] == ["error", "session_ended"]
        assert session.events[-2]["code"] == "overloaded" and session.events[-2]["fatal"] is True
        assert session.accept_frame(2, tone(0.1)) is FrameResult.IGNORED
        gate.set()

    asyncio.run(scenario())


def test_stop_finalises_pending_speech_then_ends_and_ignores_later_audio():
    async def scenario():
        session = LiveSession("s", FakeEngine(), LIMITS)
        await feed(session, tone(1.0))  # no trailing silence: still in progress
        session.end("client_stop")
        await until(lambda: session.ended)
        assert types(session)[-2:] == ["final", "session_ended"]
        assert session.events[-1] == {"type": "session_ended", "event_id": session.last_event_id,
                                      "reason": "client_stop", "utterances": 1}
        assert session.accept_frame(99, tone(0.1)) is FrameResult.IGNORED

    asyncio.run(scenario())


def test_session_ends_when_the_maximum_duration_is_reached():
    async def scenario():
        limits = LiveLimits(max_session_seconds=1.0, idle_timeout_seconds=30, resume_seconds=30, job_timeout_seconds=5)
        session = LiveSession("s", FakeEngine(), limits)
        await feed(session, tone(1.5))
        await until(lambda: session.ended)
        assert session.events[-1]["reason"] == "max_duration"

    asyncio.run(scenario())


def test_replay_window_is_bounded_and_gaps_are_detected():
    async def scenario():
        session = LiveSession("s", FakeEngine(), LiveLimits(3600, 30, 30, 5, event_log_size=3))
        for number in range(10):
            session.emit("error", code=f"e{number}", message="", fatal=False)
        assert [e["event_id"] for e in session.events_after(8)] == [9, 10]
        assert session.events_after(10) == []
        assert session.events_after(0) is None  # events 1..7 are gone
        assert session.events_after(11) is None  # from the future
        assert session.events_after(-1) is None
        session.discard()

    asyncio.run(scenario())


def test_a_stale_connection_cannot_detach_a_newer_one():
    async def scenario():
        session = LiveSession("s", FakeEngine(), LIMITS)
        old = session.attach()
        new = session.attach()  # resume from a new connection
        session.detach(old)
        assert session.detached_at is None
        session.detach(new)
        assert session.detached_at is not None
        session.discard()

    asyncio.run(scenario())


def test_manager_allows_one_active_session_and_expires_unresumed_ones():
    async def scenario():
        now = [100.0]
        manager = LiveManager(LIMITS, clock=lambda: now[0])
        first = manager.create(FakeEngine())
        with pytest.raises(BusyError):
            manager.create(FakeEngine())

        generation = first.attach()
        first.detach(generation)
        now[0] += 29
        assert manager.get(first.session_id) is first  # still inside the 30 s grace period
        now[0] += 2
        assert manager.get(first.session_id) is None  # expired and discarded
        assert not first.events

        second = manager.create(FakeEngine())  # the expired session no longer blocks
        second.end("client_stop")
        await until(lambda: second.ended)
        manager.create(FakeEngine())  # an ended session does not block either
        manager.shutdown()

    asyncio.run(scenario())
