import sys
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.engines.base import ModelUnavailableError
from app.engines.omnilingual_ctc import OmnilingualCtcEngine
from app.engines.registry import capabilities_for


def _fake_pipeline_modules(pipeline_class):
    return {
        "omnilingual_asr": SimpleNamespace(),
        "omnilingual_asr.models": SimpleNamespace(),
        "omnilingual_asr.models.inference": SimpleNamespace(),
        "omnilingual_asr.models.inference.pipeline": SimpleNamespace(ASRInferencePipeline=pipeline_class),
    }


def test_pipeline_construction_failure_is_model_unavailable(monkeypatch):
    class Broken:
        def __init__(self, **_kwargs):
            raise RuntimeError("internal path C:\\secret\\cache")

    monkeypatch.setenv("LINGUANOTE_ALLOW_MODEL_DOWNLOAD", "1")
    with patch.dict(sys.modules, _fake_pipeline_modules(Broken)):
        with pytest.raises(ModelUnavailableError) as raised:
            OmnilingualCtcEngine()
    assert "secret" not in str(raised.value)


def test_download_must_be_explicitly_allowed(monkeypatch):
    monkeypatch.delenv("LINGUANOTE_ALLOW_MODEL_DOWNLOAD", raising=False)
    with pytest.raises(ModelUnavailableError):
        OmnilingualCtcEngine()


def test_engine_identifier_matches_the_configuration_key():
    assert OmnilingualCtcEngine.name == "omnilingual-ctc"
    assert capabilities_for("omnilingual-ctc").max_audio_seconds == 39.0
    assert capabilities_for("unknown") is None
