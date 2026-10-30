import logging
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.storage.database import SCHEMA_VERSION, Database
from app.storage.history import HistoryError, HistoryRepository, SessionRecorder
from app.storage.search import HIGHLIGHT_END, HIGHLIGHT_START, build_match_query

SECRET = "Zorglub42xyz"


class Clock:
    def __init__(self):
        self.now = datetime(2026, 10, 30, 12, 0, tzinfo=UTC)

    def __call__(self):
        return self.now


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def database(tmp_path):
    return Database(tmp_path / "data" / "history.sqlite3")


@pytest.fixture
def repository(database, clock):
    return HistoryRepository(database, clock=clock)


def add_session(repository, texts, *, kind="live", title=None):
    session_id = repository.create_session(kind=kind, source="microphone" if kind == "live" else None, title=title)
    for index, text in enumerate(texts):
        repository.append_segment(session_id, text=text, start_seconds=float(index), end_seconds=index + 0.9)
    repository.finish_session(session_id, duration_seconds=float(len(texts)))
    return session_id


# -- nothing happens until the user turns the history on -------------------------------------------------------

def test_reading_never_creates_a_database_file(repository, database):
    assert repository.get_settings().enabled is False
    assert repository.list_sessions() == {"items": [], "total": 0}
    assert repository.get_session("x") is None
    assert repository.delete_all() == 0
    assert repository.purge_expired() == 0
    assert repository.mark_interrupted() == 0
    assert not database.exists()
    assert not database.path.parent.exists()


def test_defaults_are_off_and_thirty_days(repository):
    settings = repository.get_settings()
    assert (settings.enabled, settings.retention_days) == (False, 30)


def test_settings_persist_and_are_validated(repository):
    saved = repository.set_settings(enabled=True, retention_days=90)
    assert (saved.enabled, saved.retention_days) == (True, 90)
    assert repository.get_settings() == saved
    repository.set_settings(enabled=True, retention_days=None)
    assert repository.get_settings().retention_days is None  # until the user deletes
    for invalid in (0, 1, 31, -5, 10_000):
        with pytest.raises(HistoryError, match="Retention"):
            repository.set_settings(enabled=True, retention_days=invalid)
    assert repository.get_settings().retention_days is None  # a refused change leaves the settings untouched


def test_a_corrupted_retention_value_falls_back_to_the_default(repository, database):
    repository.set_settings(enabled=True, retention_days=7)
    with database.write() as connection:
        connection.execute("UPDATE settings SET value = 'banana' WHERE key = 'retention_days'")
    assert repository.get_settings().retention_days == 30
    with database.write() as connection:
        connection.execute("UPDATE settings SET value = '12' WHERE key = 'retention_days'")  # not an allowed choice
    assert repository.get_settings().retention_days == 30


# -- schema ----------------------------------------------------------------------------------------------------

def test_schema_is_versioned_and_reopening_is_harmless(repository, database):
    repository.set_settings(enabled=True, retention_days=30)
    for _ in range(3):
        with database.write() as connection:
            assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    with database.write() as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"settings", "sessions", "segments", "segments_fts"} <= tables


def test_a_database_from_a_newer_version_is_refused_rather_than_damaged(tmp_path):
    path = tmp_path / "newer.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
    connection.commit()
    connection.close()
    with pytest.raises(RuntimeError, match="newer version"):
        with Database(path).write():
            pass


def test_a_failing_write_is_rolled_back(repository, database):
    repository.set_settings(enabled=True, retention_days=30)
    with pytest.raises(sqlite3.IntegrityError):
        with database.write() as connection:
            connection.execute("INSERT INTO sessions(id, kind, title, created_at, status) VALUES ('a','live','t','x','recording')")
            connection.execute("INSERT INTO sessions(id, kind, title, created_at, status) VALUES ('a','live','t','x','recording')")
    assert repository.list_sessions()["total"] == 0  # the first insert did not survive the second one failing


# -- sessions and segments -------------------------------------------------------------------------------------

def test_a_session_keeps_its_segments_in_order_with_honest_timing(repository):
    session_id = repository.create_session(kind="file", engine="faster-whisper", model="base")
    repository.append_segment(session_id, text="  premier  ", start_seconds=0.0, end_seconds=1.5, language="fr",
                              language_probability=0.9)
    repository.append_segment(session_id, text="sans horodatage")  # no timing: stored as unknown, never invented
    repository.append_segment(session_id, text="   ")  # nothing to store
    repository.finish_session(session_id, duration_seconds=3.0)

    session = repository.get_session(session_id)
    assert [item["text"] for item in session["segments"]] == ["premier", "sans horodatage"]
    assert session["segments"][1]["start_seconds"] is None and session["segments"][1]["end_seconds"] is None
    assert session["segments"][0]["language"] == "fr"
    assert (session["kind"], session["status"], session["duration_seconds"]) == ("file", "complete", 3.0)
    assert session["title"].startswith("Fichier audio du")  # a neutral title: no file name is ever stored


def test_a_live_session_starts_as_recording_and_the_title_is_neutral(repository):
    session_id = repository.create_session(kind="live", source="both")
    session = repository.get_session(session_id)
    assert session["status"] == "recording" and session["source"] == "both"
    assert session["title"].startswith("Dictée en direct du")


def test_invalid_session_details_are_refused(repository):
    with pytest.raises(HistoryError):
        repository.create_session(kind="cloud")
    with pytest.raises(HistoryError):
        repository.create_session(kind="live", source="webcam")


def test_oversized_text_is_cut_to_a_bounded_size(repository):
    session_id = repository.create_session(kind="file")
    repository.append_segment(session_id, text="x" * 50_000)
    assert len(repository.get_session(session_id)["segments"][0]["text"]) == 20_000


def test_sessions_interrupted_by_a_crash_are_marked_when_the_service_restarts(repository, clock):
    done = add_session(repository, ["fini"])
    crashed = repository.create_session(kind="live")
    clock.now += timedelta(minutes=5)
    assert repository.mark_interrupted() == 1
    assert repository.get_session(crashed)["status"] == "interrupted"
    assert repository.get_session(crashed)["ended_at"] is not None
    assert repository.get_session(done)["status"] == "complete"


# -- listing and renaming --------------------------------------------------------------------------------------

def test_listing_is_newest_first_with_paging_and_previews(repository, clock):
    ids = []
    for number in range(5):
        clock.now += timedelta(minutes=1)
        ids.append(add_session(repository, [f"séance numéro {number}", "suite"]))
    page = repository.list_sessions(limit=2, offset=0)
    assert page["total"] == 5
    assert [item["id"] for item in page["items"]] == [ids[4], ids[3]]
    assert page["items"][0]["preview"] == "séance numéro 4" and page["items"][0]["segment_count"] == 2
    assert [item["id"] for item in repository.list_sessions(limit=2, offset=4)["items"]] == [ids[0]]
    assert len(repository.list_sessions(limit=10_000)["items"]) == 5  # the page size is capped, not trusted


def test_renaming_cleans_the_title_and_reports_unknown_sessions(repository):
    session_id = add_session(repository, ["a"])
    assert repository.rename_session(session_id, "  Réunion\x00 du\n lundi\t ") is True
    assert repository.get_session(session_id)["title"] == "Réunion du lundi"
    assert repository.rename_session(session_id, "t" * 500) is True
    assert len(repository.get_session(session_id)["title"]) == 200
    with pytest.raises(HistoryError):
        repository.rename_session(session_id, " \n ")
    assert repository.rename_session("unknown", "x") is False


# -- search ----------------------------------------------------------------------------------------------------

def test_search_ignores_accents_and_matches_prefixes_so_wolof_spellings_are_found(repository, clock):
    wolof = add_session(repository, ["Jërëjëf, baal ma"])
    clock.now += timedelta(minutes=1)
    french = add_session(repository, ["Le train pour Dakar part à huit heures"])

    def hits(query):
        return [item["id"] for item in repository.list_sessions(query=query)["items"]]

    assert hits("jerejef") == [wolof]  # typed without the accents
    assert hits("jërëjëf") == [wolof]
    assert hits("jere") == [wolof]  # while still typing
    assert hits("a huit") == [french]  # accented "à" matches a plain "a"; all words must match
    assert hits("dakar train") == [french]
    assert hits("dakar jerejef") == []  # words from two different sessions do not combine
    assert hits("introuvable") == []


def test_search_returns_a_highlighted_snippet_and_the_total(repository):
    add_session(repository, ["Nous avons parlé du budget annuel avec toute l'équipe"])
    result = repository.list_sessions(query="budget")
    assert result["total"] == 1
    snippet = result["items"][0]["snippet"]
    assert f"{HIGHLIGHT_START}budget{HIGHLIGHT_END}" in snippet
    assert result["items"][0]["preview"] is None


@pytest.mark.parametrize("hostile", [
    '"', '""', "*", "a OR b", "NEAR(a b)", "a AND", "NOT", ":", "text:secret", "(", ")", "-", "--", "'; DROP TABLE sessions; --",
    'budget" OR "x', "^budget", "{budget}", "bud*get", "\x00budget", "budget" * 100, " ".join(["mot"] * 100),
])
def test_no_search_input_can_break_or_alter_the_query(repository, hostile):
    add_session(repository, ["le budget annuel"])
    result = repository.list_sessions(query=hostile)  # must neither raise nor touch the data
    assert isinstance(result["total"], int)
    assert repository.list_sessions()["total"] == 1


def test_a_query_without_any_word_lists_everything(repository):
    add_session(repository, ["un"])
    add_session(repository, ["deux"])
    for query in (None, "", "   ", "***", '"" ()'):
        assert repository.list_sessions(query=query)["total"] == 2


def test_the_query_builder_keeps_words_only_and_marks_the_last_as_a_prefix():
    assert build_match_query("Dakar  train") == '"Dakar" "train"*'
    assert build_match_query("l'été") == '"l\'été"*'
    assert build_match_query("a OR b") == '"a" "OR" "b"*'  # operators become plain words
    assert build_match_query("***") is None
    assert build_match_query("") is None
    assert build_match_query(None) is None  # type: ignore[arg-type]
    assert len(build_match_query(" ".join(["w"] * 100)).split()) == 12


# -- deletion --------------------------------------------------------------------------------------------------

def database_bytes(database):
    return b"".join(path.read_bytes() for path in (database.path, Path(f"{database.path}-wal")) if path.exists())


def test_deleting_a_session_removes_its_text_from_search_and_from_the_file(repository, database):
    keep = add_session(repository, ["à conserver"])
    gone = add_session(repository, [f"contenu confidentiel {SECRET} à effacer"])
    assert SECRET.encode() in database_bytes(database) or repository.list_sessions(query=SECRET)["total"] == 1
    assert repository.list_sessions(query=SECRET)["total"] == 1

    assert repository.delete_session(gone) is True
    assert repository.get_session(gone) is None
    assert repository.list_sessions(query=SECRET)["total"] == 0
    assert SECRET.encode() not in database_bytes(database)  # overwritten and compacted, not merely unlinked
    assert repository.get_session(keep) is not None
    assert repository.delete_session(gone) is False


def test_deleting_everything_leaves_nothing_readable(repository, database):
    for number in range(3):
        add_session(repository, [f"{SECRET} numéro {number}"])
    assert repository.delete_all() == 3
    assert repository.list_sessions() == {"items": [], "total": 0}
    assert SECRET.encode() not in database_bytes(database)


# -- retention -------------------------------------------------------------------------------------------------

def test_expired_sessions_are_purged_and_recent_ones_kept(repository, clock):
    repository.set_settings(enabled=True, retention_days=30)
    old = add_session(repository, ["ancien"])
    clock.now += timedelta(days=20)
    recent = add_session(repository, ["récent"])
    clock.now += timedelta(days=15)  # the old one is now 35 days old, the recent one 15
    assert repository.purge_expired() == 1
    assert repository.get_session(old) is None and repository.get_session(recent) is not None


def test_retention_still_applies_after_the_history_is_turned_off(repository, clock):
    repository.set_settings(enabled=True, retention_days=7)
    old = add_session(repository, ["ancien"])
    repository.set_settings(enabled=False, retention_days=7)
    clock.now += timedelta(days=8)
    assert repository.purge_expired() == 1
    assert repository.get_session(old) is None


def test_keeping_forever_purges_nothing(repository, clock):
    repository.set_settings(enabled=True, retention_days=None)
    old = add_session(repository, ["ancien"])
    clock.now += timedelta(days=5_000)
    assert repository.purge_expired() == 0
    assert repository.get_session(old) is not None


# -- the recorder used by live sessions and file imports -------------------------------------------------------

def test_the_recorder_stores_nothing_when_the_history_is_off(repository, database):
    assert SessionRecorder.begin(repository, kind="live") is None
    assert not database.exists()


def test_the_recorder_writes_ordered_segments_and_closes_the_session(repository):
    repository.set_settings(enabled=True, retention_days=30)
    recorder = SessionRecorder.begin(repository, kind="live", source="system", engine="fake", model="m")
    assert recorder is not None
    assert recorder.segment(text="un", start_seconds=0.0, end_seconds=1.0)
    assert recorder.segment(text="deux", start_seconds=1.0, end_seconds=2.0)
    assert recorder.finish(duration_seconds=2.0)
    session = repository.get_session(recorder.session_id)
    assert [item["text"] for item in session["segments"]] == ["un", "deux"]
    assert (session["status"], session["source"], session["engine"]) == ("complete", "system", "fake")


def test_a_storage_failure_never_raises_and_never_logs_the_text(repository, caplog, monkeypatch):
    repository.set_settings(enabled=True, retention_days=30)
    recorder = SessionRecorder.begin(repository, kind="live")

    def broken(*_args, **_kwargs):
        raise sqlite3.OperationalError(f"disk I/O error near {SECRET}")

    monkeypatch.setattr(repository, "append_segment", broken)
    with caplog.at_level(logging.DEBUG, logger="linguanote.history"):
        assert recorder.segment(text=SECRET) is False
    assert recorder.ok is False
    assert "OperationalError" in caplog.text  # the error type is logged...
    assert SECRET not in caplog.text  # ...never the message, which could contain content


def test_a_session_that_cannot_be_created_is_skipped_quietly(repository, monkeypatch):
    repository.set_settings(enabled=True, retention_days=30)
    monkeypatch.setattr(repository, "create_session", lambda **_k: (_ for _ in ()).throw(sqlite3.OperationalError("x")))
    assert SessionRecorder.begin(repository, kind="live") is None
