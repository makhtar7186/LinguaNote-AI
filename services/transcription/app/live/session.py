"""One live transcription session: audio sequencing, the event log, and a sequential job worker.

Everything here runs on the event loop except engine calls, which go through the shared inference worker.
Neither audio nor transcript text is ever logged.
"""
import asyncio
import logging
import tempfile
import time
import wave
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from app import inference
from app.engines.base import SpeechEngine, TranscriptionResult
from app.live.segmenter import SAMPLE_RATE, SegmenterConfig, Utterance, UtteranceSegmenter
from app.storage.history import SessionRecorder

logger = logging.getLogger("linguanote.live")

_END = "end"


@dataclass(frozen=True)
class LiveLimits:
    max_session_seconds: float
    idle_timeout_seconds: float
    resume_seconds: float
    job_timeout_seconds: float
    max_frame_bytes: int = 64 * 1024
    event_log_size: int = 500
    max_queued_jobs: int = 8
    # Frames accepted per window. A legitimate client sends 10 to 50 per second and may replay up to 30 s
    # of audio after a reconnection; far beyond that is a flood, not audio.
    max_frames_per_window: int = 5000
    rate_window_seconds: float = 10.0


class FrameResult(Enum):
    ACCEPTED = "accepted"
    DUPLICATE = "duplicate"  # seq already received: ignored and re-acknowledged
    GAP = "gap"  # a frame is missing before this one: the client must resend from `expected`
    IGNORED = "ignored"  # the session is stopping or over


def write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(pcm)


class LiveSession:
    def __init__(
        self,
        session_id: str,
        engine: SpeechEngine,
        limits: LiveLimits,
        *,
        segmenter_config: SegmenterConfig | None = None,
        clock: Callable[[], float] = time.monotonic,
        recorder: SessionRecorder | None = None,
        partials: bool = True,
    ) -> None:
        self.session_id = session_id
        self._partials = partials  # False: final text only (routing cannot cheaply revise a growing buffer)
        self._recorder = recorder
        self._history_warned = False
        self.engine = engine
        self.limits = limits
        self._clock = clock
        self.segmenter = UtteranceSegmenter(segmenter_config)

        self.events: deque[dict] = deque(maxlen=limits.event_log_size)
        self._next_event_id = 1
        self.last_seq = 0
        self.ended = False
        self.end_reason: str | None = None
        self.final_count = 0
        self.detached_at: float | None = None  # None while a connection is attached
        self._connection = 0  # generation of the attached connection, so a stale one cannot detach a newer one
        self.last_activity = clock()

        self._stopping = False
        self._window_started = clock()
        self._window_frames = 0
        self._finalized: set[int] = set()
        self._revisions: dict[int, int] = {}
        self._jobs: asyncio.Queue = asyncio.Queue(limits.max_queued_jobs)
        self._signal = asyncio.Event()
        self._worker = asyncio.create_task(self._run())

    # -- events ---------------------------------------------------------------------------------------

    def emit(self, event_type: str, **fields) -> dict:
        event = {"type": event_type, "event_id": self._next_event_id, **fields}
        self._next_event_id += 1
        self.events.append(event)
        self._signal.set()
        return event

    @property
    def last_event_id(self) -> int:
        return self._next_event_id - 1

    def events_after(self, last_event_id: int) -> list[dict] | None:
        """Events newer than `last_event_id`, or None when they cannot all be provided (replay gap)."""
        if last_event_id < 0 or last_event_id > self.last_event_id:
            return None
        if self.events and last_event_id + 1 < self.events[0]["event_id"]:
            return None
        return [event for event in self.events if event["event_id"] > last_event_id]

    def clear_signal(self) -> None:
        self._signal.clear()

    async def wait_for_event(self, timeout: float) -> None:
        try:
            await asyncio.wait_for(self._signal.wait(), timeout)
        except TimeoutError:
            pass

    # -- connection lifecycle -------------------------------------------------------------------------

    def attach(self) -> int:
        """Attach a connection (a resume replaces any earlier one) and return its generation number."""
        self._connection += 1
        self.detached_at = None
        self.last_activity = self._clock()
        self._signal.set()  # wakes the previous connection's event pump so it notices it was replaced
        return self._connection

    def is_current(self, connection: int) -> bool:
        """False once a newer connection has taken the session over: the old one must do nothing more."""
        return connection == self._connection

    def detach(self, connection: int) -> None:
        if connection == self._connection:
            self.detached_at = self._clock()

    def touch(self) -> None:
        self.last_activity = self._clock()

    def idle_for(self) -> float:
        return self._clock() - self.last_activity

    # -- audio ----------------------------------------------------------------------------------------

    def accept_frame(self, seq: int, payload: bytes) -> FrameResult:
        if self.ended or self._stopping:
            return FrameResult.IGNORED
        if self._over_rate_limit():
            self.abort("rate_limited", "Too many audio frames were sent in a short time. The session was stopped.")
            return FrameResult.IGNORED
        if seq <= self.last_seq:
            return FrameResult.DUPLICATE
        if seq != self.last_seq + 1:
            return FrameResult.GAP
        self.last_seq = seq
        self.touch()

        for utterance in self.segmenter.feed(payload):
            if not self._enqueue(("final", utterance)):
                return FrameResult.ACCEPTED  # the session was aborted as overloaded
        partial = self.segmenter.due_partial() if self._partials else None
        # A partial is best-effort: skipped when anything is already queued or running.
        if partial is not None and self._jobs.empty() and inference.is_idle():
            self._enqueue(("partial", partial))
        if self.segmenter.total_seconds >= self.limits.max_session_seconds:
            self.end("max_duration")
        return FrameResult.ACCEPTED

    def _over_rate_limit(self) -> bool:
        now = self._clock()
        if now - self._window_started >= self.limits.rate_window_seconds:
            self._window_started, self._window_frames = now, 0
        self._window_frames += 1
        return self._window_frames > self.limits.max_frames_per_window

    def end(self, reason: str) -> None:
        """Finish gracefully: the audio still pending is finalised, then `session_ended` is emitted."""
        if self.ended or self._stopping:
            return
        self._stopping = True
        for utterance in self.segmenter.flush():
            if not self._enqueue(("final", utterance)):
                return
        if not self._enqueue((_END, reason)):
            return

    def discard(self) -> None:
        """Drop the session and its buffered text from memory (resume window over, or server shutdown)."""
        self._worker.cancel()
        self._close_history("interrupted")  # no-op if the session already ended properly
        self.ended = True
        self.events.clear()

    def _enqueue(self, job: tuple) -> bool:
        try:
            self._jobs.put_nowait(job)
            return True
        except asyncio.QueueFull:
            self.abort("overloaded", "Transcription cannot keep up with the audio. The session was stopped.")
            return False

    def abort(self, code: str, message: str) -> None:
        """Explicit failure instead of silently dropping text: report it, then end."""
        self._stopping = True
        self._worker.cancel()
        self.emit("error", code=code, message=message, fatal=True)
        self.ended = True
        self.end_reason = "error"
        self._close_history("interrupted")
        self.emit("session_ended", reason="error", utterances=self.final_count)

    # -- worker ---------------------------------------------------------------------------------------

    async def _run(self) -> None:
        while True:
            kind, payload = await self._jobs.get()
            if kind == _END:
                self.ended = True
                self.end_reason = payload
                self._close_history("complete")
                self.emit("session_ended", reason=payload, utterances=self.final_count)
                return
            await self._process(kind, payload)

    async def _process(self, kind: str, utterance: Utterance) -> None:
        if kind == "partial" and utterance.utterance_id in self._finalized:
            return
        try:
            result = await self._transcribe(utterance.pcm)
        except TimeoutError:
            self.emit("error", code="inference_timeout", fatal=False, utterance_id=utterance.utterance_id,
                      message="Transcription of this utterance took too long and was skipped.")
            return
        except Exception:
            logger.exception("Live inference failed")  # traceback only; never audio or text
            self.emit("error", code="inference_failed", fatal=False, utterance_id=utterance.utterance_id,
                      message="Transcription of this utterance failed.")
            return

        text = result.text.strip()
        if not text:
            return
        times = {"start_seconds": utterance.start_seconds, "end_seconds": utterance.end_seconds}
        if kind == "partial":
            revision = self._revisions.get(utterance.utterance_id, 0) + 1
            self._revisions[utterance.utterance_id] = revision
            self.emit("partial", utterance_id=utterance.utterance_id, revision=revision, text=text, **times)
        else:
            self._finalized.add(utterance.utterance_id)
            self.final_count += 1
            await self._record(result, text, utterance)
            self.emit(
                "final", utterance_id=utterance.utterance_id, text=text, **times,
                language=result.language, language_probability=result.language_probability,
            )

    async def _record(self, result: TranscriptionResult, text: str, utterance: Utterance) -> None:
        """Append a finished utterance to the history, off the event loop. A storage problem is reported once."""
        if self._recorder is None:
            return
        saved = await asyncio.to_thread(
            self._recorder.segment, text=text, start_seconds=utterance.start_seconds,
            end_seconds=utterance.end_seconds, language=result.language,
            language_probability=result.language_probability,
        )
        if not saved and not self._history_warned:
            self._history_warned = True  # the text still reaches the user; only its saving failed
            self.emit("error", code="history_write_failed", fatal=False,
                      message="Le texte n'a pas pu être enregistré dans l'historique (le direct continue).")

    def _close_history(self, status: str) -> None:
        recorder, self._recorder = self._recorder, None  # closed once
        if recorder is not None:
            recorder.finish(duration_seconds=self.segmenter.total_seconds, status=status)

    async def _transcribe(self, pcm: bytes) -> TranscriptionResult:
        directory = tempfile.mkdtemp(prefix="linguanote-live-")
        future: Future | None = None
        try:
            path = Path(directory) / "utterance.wav"
            write_wav(path, pcm)
            future = inference.submit(self.engine.transcribe, path)
            return await asyncio.wait_for(asyncio.wrap_future(future), self.limits.job_timeout_seconds)
        finally:
            inference.discard_when_idle(directory, future)
