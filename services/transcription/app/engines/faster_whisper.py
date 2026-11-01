import os
from pathlib import Path

from app.engines.base import EngineCapabilities, ModelUnavailableError, Segment, TranscriptionResult


class FasterWhisperEngine:
    """CPU-oriented multilingual Whisper adapter for supported Windows installs."""

    name = "faster-whisper"
    capabilities = EngineCapabilities(timestamps=True, language_detection=True)

    def __init__(self, model: str | None = None) -> None:
        # An explicit model lets several instances coexist (language routing); the default stays the environment.
        self.model = model or os.getenv("LINGUANOTE_WHISPER_MODEL", "base")
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise ModelUnavailableError(
                "Install the Windows ASR extra with: "
                'python -m pip install -e ".[api,windows-asr]"'
            ) from exc

        try:
            self._pipeline = WhisperModel(
                self.model,
                device="cpu",
                compute_type="int8",
                cpu_threads=int(os.getenv("LINGUANOTE_CPU_THREADS", "4")),
            )
        except Exception as exc:
            raise ModelUnavailableError(
                f"The Whisper model '{self.model}' could not be loaded. "
                "Check network access on first use and available disk space."
            ) from exc

    # The language-routing engine passes the language it already detected for the passage (see routing.py).
    accepts_language_hint = True

    def transcribe(self, audio_path: Path, language: str | None = None) -> TranscriptionResult:
        """`language` forces the language of the whole file; None lets Whisper detect it (the default)."""
        segments, info = self._pipeline.transcribe(
            str(audio_path),
            task="transcribe",
            language=language,
            beam_size=3,
            vad_filter=True,
        )
        # The segment iterator is lazy: inference actually runs while it is consumed.
        parts = tuple(
            Segment(float(s.start), float(s.end), s.text.strip())
            for s in segments
        )
        return TranscriptionResult(
            text=" ".join(p.text for p in parts if p.text).strip(),
            engine=self.name,
            model=self.model,
            language=getattr(info, "language", None),
            language_probability=getattr(info, "language_probability", None),
            segments=parts,
        )
