"""Registry of live sessions: one active session at a time, expiry of sessions nobody resumed."""
import secrets
import time
from collections.abc import Callable

from app.engines.base import SpeechEngine
from app.live.segmenter import SegmenterConfig
from app.live.session import LiveLimits, LiveSession
from app.storage.history import HistoryRepository, SessionRecorder


class BusyError(RuntimeError):
    """Another live session is still running."""


class LiveManager:
    def __init__(
        self,
        limits: LiveLimits,
        *,
        segmenter_config: SegmenterConfig | None = None,
        clock: Callable[[], float] = time.monotonic,
        history: HistoryRepository | None = None,
    ) -> None:
        self.limits = limits
        self._history = history
        self._segmenter_config = segmenter_config
        self._clock = clock
        self._sessions: dict[str, LiveSession] = {}

    def sweep(self) -> None:
        """Discard sessions whose connection dropped and was not resumed within the grace period."""
        now = self._clock()
        for session_id, session in list(self._sessions.items()):
            if session.detached_at is not None and now - session.detached_at > self.limits.resume_seconds:
                session.discard()
                del self._sessions[session_id]

    def create(self, engine: SpeechEngine, source: str | None = None) -> LiveSession:
        self.sweep()
        if any(not session.ended for session in self._sessions.values()):
            raise BusyError("A live session is already running.")
        session_id = secrets.token_urlsafe(16)
        # None unless the user turned the history on: then the session is recorded as it goes.
        recorder = (
            SessionRecorder.begin(self._history, kind="live", source=source, engine=engine.name, model=engine.model)
            if self._history is not None else None
        )
        session = LiveSession(
            session_id, engine, self.limits, segmenter_config=self._segmenter_config, clock=self._clock,
            recorder=recorder,
        )
        self._sessions[session_id] = session
        return session

    def get(self, session_id: str) -> LiveSession | None:
        self.sweep()
        return self._sessions.get(session_id)

    def remove(self, session_id: str) -> None:
        session = self._sessions.pop(session_id, None)
        if session is not None:
            session.discard()

    def shutdown(self) -> None:
        for session_id in list(self._sessions):
            self.remove(session_id)
