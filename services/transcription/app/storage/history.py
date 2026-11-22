"""The transcription history: settings, sessions, segments, search, deletion, retention.

Policy (docs/security.md): the history is on by default (the product owner's choice, 2026-11-22) and the user can turn
it off at any time, after which nothing more is stored; only text, timing and a few
facts about the session are kept (no audio, no file names); everything expires after the retention period the user
chose; the user can delete one session or everything, and deleted text is overwritten and compacted away.
"""
import logging
import re
import secrets
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.storage.database import Database
from app.storage.search import HIGHLIGHT_END, HIGHLIGHT_START, build_match_query

logger = logging.getLogger("linguanote.history")

ALLOWED_RETENTION_DAYS: tuple[int | None, ...] = (7, 30, 90, 365, None)  # None = until deleted by the user
DEFAULT_RETENTION_DAYS = 30
# Used until the user makes a choice; an explicit choice (on or off) is stored and always wins.
DEFAULT_ENABLED = True
MAX_SEGMENT_CHARS = 20_000
MAX_TITLE_CHARS = 200
MAX_PAGE_SIZE = 200
SOURCES = ("microphone", "system", "both")

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class HistoryError(ValueError):
    """An invalid request to the history (message is safe to show to the user)."""


@dataclass(frozen=True)
class HistorySettings:
    enabled: bool = DEFAULT_ENABLED
    retention_days: int | None = DEFAULT_RETENTION_DAYS


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="seconds")


def default_title(kind: str, moment: datetime) -> str:
    label = "Dictée en direct" if kind == "live" else "Fichier audio"
    return f"{label} du {moment.astimezone().strftime('%d/%m/%Y à %H:%M')}"


def clean_title(raw: str) -> str:
    title = _CONTROL.sub(" ", raw or "").strip()
    title = re.sub(r"\s+", " ", title)
    if not title:
        raise HistoryError("The title cannot be empty.")
    return title[:MAX_TITLE_CHARS]


class HistoryRepository:
    def __init__(self, database: Database, clock: Callable[[], datetime] = _now) -> None:
        self.database = database
        self._clock = clock

    # -- settings -------------------------------------------------------------------------------------

    def get_settings(self) -> HistorySettings:
        with self.database.read() as connection:
            if connection is None:
                return HistorySettings()
            rows = dict(connection.execute("SELECT key, value FROM settings").fetchall())
        retention = rows.get("retention_days", str(DEFAULT_RETENTION_DAYS))
        try:
            days = None if retention == "forever" else int(retention)
        except ValueError:
            days = DEFAULT_RETENTION_DAYS
        if days not in ALLOWED_RETENTION_DAYS:
            days = DEFAULT_RETENTION_DAYS
        stored = rows.get("history_enabled")
        enabled = DEFAULT_ENABLED if stored is None else stored == "1"
        return HistorySettings(enabled=enabled, retention_days=days)

    def set_settings(self, *, enabled: bool, retention_days: int | None) -> HistorySettings:
        if retention_days not in ALLOWED_RETENTION_DAYS:
            allowed = ", ".join("forever" if value is None else str(value) for value in ALLOWED_RETENTION_DAYS)
            raise HistoryError(f"Retention must be one of: {allowed}.")
        with self.database.write() as connection:
            for key, value in (
                ("history_enabled", "1" if enabled else "0"),
                ("retention_days", "forever" if retention_days is None else str(retention_days)),
            ):
                connection.execute(
                    "INSERT INTO settings(key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value),
                )
        return HistorySettings(enabled=enabled, retention_days=retention_days)

    # -- writing --------------------------------------------------------------------------------------

    def create_session(
        self, *, kind: str, source: str | None = None, engine: str | None = None, model: str | None = None,
        title: str | None = None,
    ) -> str:
        if kind not in ("live", "file"):
            raise HistoryError("Unknown session kind.")
        if source is not None and source not in SOURCES:
            raise HistoryError("Unknown audio source.")
        moment = self._clock()
        session_id = secrets.token_urlsafe(12)
        with self.database.write() as connection:
            connection.execute(
                "INSERT INTO sessions(id, kind, source, engine, model, title, created_at, status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'recording')",
                (session_id, kind, source, engine, model, clean_title(title) if title else default_title(kind, moment),
                 _iso(moment)),
            )
        return session_id

    def append_segment(
        self, session_id: str, *, text: str, start_seconds: float | None = None, end_seconds: float | None = None,
        language: str | None = None, language_probability: float | None = None, position: int | None = None,
        only_if_enabled: bool = False,
    ) -> bool:
        """Append a segment. With `only_if_enabled`, the setting is checked inside the same write transaction, so a
        history turned off at any moment is never written to afterwards. Returns whether a row was written."""
        text = text.strip()[:MAX_SEGMENT_CHARS]
        if not text:
            return False
        with self.database.write() as connection:
            if only_if_enabled:
                connection.execute("BEGIN IMMEDIATE")  # takes the write lock first: no settings change can slip in
                enabled = connection.execute("SELECT value FROM settings WHERE key = 'history_enabled'").fetchone()
                if (DEFAULT_ENABLED is False and enabled is None) or (enabled is not None and enabled[0] != "1"):
                    return False
            if position is None:
                position = connection.execute(
                    "SELECT COALESCE(MAX(position) + 1, 0) FROM segments WHERE session_id = ?", (session_id,),
                ).fetchone()[0]
            connection.execute(
                "INSERT INTO segments(session_id, position, start_seconds, end_seconds, text, language, "
                "language_probability) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (session_id, position, start_seconds, end_seconds, text, language, language_probability),
            )
        return True

    def finish_session(self, session_id: str, *, duration_seconds: float | None, status: str = "complete") -> None:
        with self.database.write() as connection:
            connection.execute(
                "UPDATE sessions SET ended_at = ?, duration_seconds = ?, status = ? WHERE id = ?",
                (_iso(self._clock()), duration_seconds, status, session_id),
            )

    def mark_interrupted(self) -> int:
        """Sessions still marked 'recording' when the service starts were cut short (crash, power loss)."""
        if not self.database.exists():
            return 0
        with self.database.write() as connection:
            return connection.execute(
                "UPDATE sessions SET status = 'interrupted', ended_at = COALESCE(ended_at, ?) "
                "WHERE status = 'recording'",
                (_iso(self._clock()),),
            ).rowcount

    def rename_session(self, session_id: str, title: str) -> bool:
        with self.database.write() as connection:
            return connection.execute(
                "UPDATE sessions SET title = ? WHERE id = ?", (clean_title(title), session_id),
            ).rowcount > 0

    # -- reading --------------------------------------------------------------------------------------

    @staticmethod
    def _summary(row: sqlite3.Row) -> dict:
        return {key: row[key] for key in (
            "id", "kind", "source", "engine", "model", "title", "created_at", "ended_at", "duration_seconds", "status",
        )}

    def list_sessions(self, *, query: str | None = None, limit: int = 50, offset: int = 0) -> dict:
        limit = max(1, min(int(limit), MAX_PAGE_SIZE))
        offset = max(0, int(offset))
        match = build_match_query(query or "")
        with self.database.read() as connection:
            if connection is None:
                return {"items": [], "total": 0}
            if match is None:
                total = connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
                rows = connection.execute(
                    "SELECT s.*, (SELECT COUNT(*) FROM segments g WHERE g.session_id = s.id) AS segment_count, "
                    "(SELECT substr(text, 1, 140) FROM segments g WHERE g.session_id = s.id "
                    " ORDER BY position LIMIT 1) AS preview, NULL AS snippet "
                    "FROM sessions s ORDER BY s.created_at DESC, s.rowid DESC LIMIT ? OFFSET ?",
                    (limit, offset),
                ).fetchall()
            else:
                matching = (
                    "s.id IN (SELECT g.session_id FROM segments g WHERE g.id IN "
                    "(SELECT rowid FROM segments_fts WHERE segments_fts MATCH :match))"
                )
                total = connection.execute(
                    f"SELECT COUNT(*) FROM sessions s WHERE {matching}", {"match": match},
                ).fetchone()[0]
                rows = connection.execute(
                    "SELECT s.*, (SELECT COUNT(*) FROM segments g WHERE g.session_id = s.id) AS segment_count, "
                    "NULL AS preview, (SELECT snippet(segments_fts, 0, :start, :end, '…', 14) FROM segments_fts "
                    " WHERE segments_fts MATCH :match AND rowid IN (SELECT id FROM segments WHERE session_id = s.id) "
                    " LIMIT 1) AS snippet "
                    f"FROM sessions s WHERE {matching} "
                    "ORDER BY s.created_at DESC, s.rowid DESC LIMIT :limit OFFSET :offset",
                    {"match": match, "start": HIGHLIGHT_START, "end": HIGHLIGHT_END, "limit": limit, "offset": offset},
                ).fetchall()
        items = [{**self._summary(row), "segment_count": row["segment_count"], "preview": row["preview"],
                  "snippet": row["snippet"]} for row in rows]
        return {"items": items, "total": total}

    def get_session(self, session_id: str) -> dict | None:
        with self.database.read() as connection:
            if connection is None:
                return None
            row = connection.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if row is None:
                return None
            segments = connection.execute(
                "SELECT position, start_seconds, end_seconds, text, language, language_probability "
                "FROM segments WHERE session_id = ? ORDER BY position", (session_id,),
            ).fetchall()
        return {**self._summary(row), "segments": [dict(segment) for segment in segments]}

    # -- deletion and retention -----------------------------------------------------------------------

    def delete_session(self, session_id: str) -> bool:
        if not self.database.exists():
            return False
        with self.database.write() as connection:
            deleted = connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,)).rowcount > 0
        if deleted:
            self.database.compact()
        return deleted

    def delete_all(self) -> int:
        if not self.database.exists():
            return 0
        with self.database.write() as connection:
            deleted = connection.execute("DELETE FROM sessions").rowcount
        self.database.compact()
        return deleted

    def purge_expired(self) -> int:
        """Delete sessions older than the retention period. Applies even if the history has since been turned off."""
        retention = self.get_settings().retention_days
        if retention is None or not self.database.exists():
            return 0
        cutoff = _iso(self._clock() - timedelta(days=retention))
        with self.database.write() as connection:
            deleted = connection.execute("DELETE FROM sessions WHERE created_at < ?", (cutoff,)).rowcount
        if deleted:
            self.database.compact()
        return deleted


class SessionRecorder:
    """Writes one live or file session to the history, never letting a storage problem disturb the transcription.

    Every method returns False (and logs only the error type, never text) when the write failed. `ok` turns False
    at the first failure so the caller can tell the user once that the history is incomplete.
    """

    def __init__(self, repository: HistoryRepository, session_id: str) -> None:
        self.repository = repository
        self.session_id = session_id
        self.ok = True
        self._position = 0

    @classmethod
    def begin(cls, repository: HistoryRepository, **details) -> "SessionRecorder | None":
        """None when the history is off (nothing is stored) or the session could not be created."""
        try:
            if not repository.get_settings().enabled:
                return None
            return cls(repository, repository.create_session(**details))
        except Exception as error:  # noqa: BLE001 - storage must never break transcription
            logger.warning("History session not created (%s)", type(error).__name__)
            return None

    def segment(self, **fields) -> bool:
        try:
            # Turning the history off takes effect at once, even in the middle of a session: the setting is checked
            # in the same transaction as the write, so nothing is stored after it (what was saved before stays until
            # the user deletes it).
            written = self.repository.append_segment(
                self.session_id, position=self._position, only_if_enabled=True, **fields,
            )
            if written:
                self._position += 1
            return True  # not written because the history is off (or the text empty) is not a failure
        except Exception as error:  # noqa: BLE001
            logger.warning("History segment not saved (%s)", type(error).__name__)
            self.ok = False
            return False

    def finish(self, *, duration_seconds: float | None, status: str = "complete") -> bool:
        try:
            self.repository.finish_session(self.session_id, duration_seconds=duration_seconds, status=status)
            return True
        except Exception as error:  # noqa: BLE001
            logger.warning("History session not closed (%s)", type(error).__name__)
            self.ok = False
            return False
