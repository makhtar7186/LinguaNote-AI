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
