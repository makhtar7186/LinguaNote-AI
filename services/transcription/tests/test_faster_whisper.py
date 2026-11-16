import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.engines.base import ModelUnavailableError
from app.engines.faster_whisper import FasterWhisperEngine


class FasterWhisperEngineTests(unittest.TestCase):
    def test_transcribes_without_forcing_one_language(self):
        captured = {}

        class FakeModel:
            def __init__(self, model, **kwargs):
                captured["model"] = model
                captured.update(kwargs)

            def transcribe(self, path, **kwargs):
                captured["path"] = path
                captured["transcribe"] = kwargs
                segments = iter([
                    SimpleNamespace(start=0.0, end=1.2, text=" Bonjour"),
                    SimpleNamespace(start=1.2, end=2.0, text=" world."),
                ])
                return segments, SimpleNamespace(language="fr", language_probability=0.8)

        with patch.dict(os.environ, {"LINGUANOTE_WHISPER_MODEL": "base"}), patch.dict(
            sys.modules,
            {"faster_whisper": SimpleNamespace(WhisperModel=FakeModel)},
        ):
            engine = FasterWhisperEngine()
            result = engine.transcribe(Path("sample.wav"))

        self.assertEqual(result.text, "Bonjour world.")
        self.assertEqual(result.engine, "faster-whisper")
        self.assertEqual(result.language, "fr")
        self.assertEqual([s.end_seconds for s in result.segments], [1.2, 2.0])
        self.assertEqual(captured["device"], "cpu")
        self.assertEqual(captured["compute_type"], "int8")
        self.assertIsNone(captured["transcribe"]["language"])

    def test_missing_dependency_raises_model_unavailable(self):
        with patch.dict(sys.modules, {"faster_whisper": None}):
            with self.assertRaises(ModelUnavailableError):
                FasterWhisperEngine()

    def test_model_load_failure_raises_model_unavailable(self):
        class BrokenModel:
            def __init__(self, *args, **kwargs):
                raise OSError("offline")

        with patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=BrokenModel)}):
            with self.assertRaises(ModelUnavailableError):
                FasterWhisperEngine()

    def test_a_refused_download_says_what_to_do_instead_of_blaming_the_network(self):
        class BrokenModel:
            def __init__(self, *args, **kwargs):
                raise OSError("not in the cache")

        with patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=BrokenModel)}):
            with patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}):
                with self.assertRaisesRegex(ModelUnavailableError, "acceptez le téléchargement"):
                    FasterWhisperEngine()
