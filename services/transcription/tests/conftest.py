"""The suite must give the same result on any machine, whatever that machine's own configuration is.

A developer's LINGUANOTE_* variables (for example LINGUANOTE_ASR_ENGINE=language-routing) change how live sessions
segment audio, and the default paths point at the real history database and log folder.
"""
import os

import pytest

_OUTSIDE_VARIABLES = ("HF_HUB_OFFLINE",)


def _is_machine_configuration(name: str) -> bool:
    return name.upper().startswith("LINGUANOTE_") or name.upper() in _OUTSIDE_VARIABLES


# Also at import time: modules are collected, and may read settings, before any fixture runs.
for _name in [name for name in os.environ if _is_machine_configuration(name)]:
    del os.environ[_name]


@pytest.fixture(autouse=True)
def isolated_machine_configuration(monkeypatch, tmp_path):
    """Nothing a test does may reach the user's real history or logs."""
    for name in [name for name in os.environ if _is_machine_configuration(name)]:
        monkeypatch.delenv(name)
    monkeypatch.setenv("LINGUANOTE_DATA_DIR", str(tmp_path / "linguanote-data"))
