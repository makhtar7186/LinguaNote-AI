"""Logging setup: console plus a rotating log file.

Logs must never contain audio or transcript content (see AGENTS.md, section 5).
Log only metadata such as sizes, durations, engine names, and error types.
"""
import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_FORMAT = "%(asctime)s %(levelname)-8s %(name)s: %(message)s"
LOG_FILE_NAME = "linguanote.log"
MAX_LOG_BYTES = 5 * 1024 * 1024
BACKUP_COUNT = 3
_HANDLER_MARKER = "_linguanote_handler"

# services/transcription/app/logging_config.py -> repository root/data/logs (git-ignored)
DEFAULT_LOG_DIR = Path(__file__).resolve().parents[3] / "data" / "logs"


def configure_logging(log_dir: Path | None = None, level: str | None = None) -> Path:
    """Configure the `linguanote` logger and return the log file path.

    Safe to call more than once: previously installed handlers are replaced.
    Environment overrides: LINGUANOTE_LOG_DIR, LINGUANOTE_LOG_LEVEL. Logs follow LINGUANOTE_DATA_DIR when it is set:
    the source tree does not exist (or is read-only) in an installed application.
    """
    data_dir = os.getenv("LINGUANOTE_DATA_DIR")
    default_dir = Path(data_dir) / "logs" if data_dir else DEFAULT_LOG_DIR
    directory = log_dir or Path(os.getenv("LINGUANOTE_LOG_DIR") or default_dir)
    level_name = (level or os.getenv("LINGUANOTE_LOG_LEVEL", "INFO")).upper()
    log_level = logging.getLevelName(level_name)
    if not isinstance(log_level, int):
        raise ValueError(f"Invalid log level '{level_name}'.")

    directory.mkdir(parents=True, exist_ok=True)
    log_path = directory / LOG_FILE_NAME

    logger = logging.getLogger("linguanote")
    logger.setLevel(log_level)
    logger.propagate = False
    for handler in [h for h in logger.handlers if getattr(h, _HANDLER_MARKER, False)]:
        logger.removeHandler(handler)
        handler.close()

    formatter = logging.Formatter(LOG_FORMAT)
    file_handler = RotatingFileHandler(
        log_path, maxBytes=MAX_LOG_BYTES, backupCount=BACKUP_COUNT, encoding="utf-8"
    )
    console_handler = logging.StreamHandler()
    for handler in (file_handler, console_handler):
        handler.setFormatter(formatter)
        setattr(handler, _HANDLER_MARKER, True)
        logger.addHandler(handler)
    return log_path
