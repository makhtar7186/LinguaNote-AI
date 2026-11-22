import logging

import pytest

from app.logging_config import configure_logging


@pytest.fixture(autouse=True)
def restore_logger():
    yield
    logger = logging.getLogger("linguanote")
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()


def test_writes_messages_to_log_file(tmp_path):
    log_path = configure_logging(tmp_path / "logs", "INFO")
    logging.getLogger("linguanote.test").info("hello metadata")
    for handler in logging.getLogger("linguanote").handlers:
        handler.flush()
    assert "hello metadata" in log_path.read_text(encoding="utf-8")


def test_reconfiguring_does_not_duplicate_handlers(tmp_path):
    configure_logging(tmp_path, "INFO")
    configure_logging(tmp_path, "INFO")
    ours = [h for h in logging.getLogger("linguanote").handlers if getattr(h, "_linguanote_handler", False)]
    assert len(ours) == 2


def test_respects_level(tmp_path):
    log_path = configure_logging(tmp_path, "WARNING")
    logging.getLogger("linguanote.test").info("hidden")
    logging.getLogger("linguanote.test").warning("shown")
    for handler in logging.getLogger("linguanote").handlers:
        handler.flush()
    content = log_path.read_text(encoding="utf-8")
    assert "shown" in content and "hidden" not in content


def test_invalid_level_raises(tmp_path):
    with pytest.raises(ValueError):
        configure_logging(tmp_path, "LOUD")


def test_logs_follow_the_data_folder_so_an_installed_app_never_writes_to_its_install_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("LINGUANOTE_DATA_DIR", str(tmp_path / "profile"))
    assert configure_logging(level="INFO") == tmp_path / "profile" / "logs" / "linguanote.log"


def test_an_explicit_log_folder_wins_over_the_data_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("LINGUANOTE_DATA_DIR", str(tmp_path / "profile"))
    monkeypatch.setenv("LINGUANOTE_LOG_DIR", str(tmp_path / "elsewhere"))
    assert configure_logging(level="INFO") == tmp_path / "elsewhere" / "linguanote.log"
