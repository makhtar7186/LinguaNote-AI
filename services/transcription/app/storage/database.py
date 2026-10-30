"""SQLite access for the optional transcription history.

Only text and timing are ever stored (never audio, never file names). The database file is created lazily, on the
first write, so a user who never enables the history never gets one. Deleted text is overwritten (`secure_delete`)
and can be compacted away with `VACUUM`.
"""
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

SCHEMA_VERSION = 1


def _migration_1(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE sessions (
            id               TEXT PRIMARY KEY,
            kind             TEXT NOT NULL CHECK (kind IN ('live', 'file')),
            source           TEXT CHECK (source IN ('microphone', 'system', 'both')),
            engine           TEXT,
            model            TEXT,
            title            TEXT NOT NULL,
            created_at       TEXT NOT NULL,
            ended_at         TEXT,
            duration_seconds REAL,
            status           TEXT NOT NULL CHECK (status IN ('recording', 'complete', 'interrupted'))
        );
        CREATE INDEX sessions_created ON sessions(created_at DESC);

        CREATE TABLE segments (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            position             INTEGER NOT NULL,
            start_seconds        REAL,
            end_seconds          REAL,
            text                 TEXT NOT NULL,
            language             TEXT,
            language_probability REAL
        );
        CREATE INDEX segments_session ON segments(session_id, position);

        -- Full-text search; accents are ignored ("jerejef" finds "Jërëjëf"). Kept in step by triggers.
        CREATE VIRTUAL TABLE segments_fts USING fts5(
            text, content='segments', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
            INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
            INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
            INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
            INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
        END;
        """
    )


# Index i migrates schema version i to i + 1. Never edit a released migration: append a new one.
MIGRATIONS: list[Callable[[sqlite3.Connection], None]] = [_migration_1]


class Database:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def exists(self) -> bool:
        return self.path.is_file()

    def _open(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA secure_delete = ON")  # deleted text is overwritten, not just unlinked
        self._migrate(connection)
        return connection

    @staticmethod
    def _migrate(connection: sqlite3.Connection) -> None:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise RuntimeError(
                f"The history database is from a newer version (schema {version}, this build knows {SCHEMA_VERSION})."
            )
        for index in range(version, SCHEMA_VERSION):
            with connection:  # each migration is atomic with its version bump
                MIGRATIONS[index](connection)
                connection.execute(f"PRAGMA user_version = {index + 1}")

    @contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        """A connection for changes: committed on success, rolled back on error. Creates the file if needed."""
        connection = self._open()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection | None]:
        """A connection for queries, or None when there is no database yet (nothing was ever stored)."""
        if not self.exists():
            yield None
            return
        connection = self._open()
        try:
            yield connection
        finally:
            connection.close()

    def compact(self) -> None:
        """Rewrite the file without the deleted content and fold the write-ahead log back into it."""
        if not self.exists():
            return
        connection = self._open()
        try:
            connection.execute("VACUUM")
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            connection.close()
