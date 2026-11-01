"""Speech recognition engine adapters."""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


class ModelUnavailableError(RuntimeError):
    """Raised when an engine or its configured model cannot be loaded."""


@dataclass(frozen=True)
class Segment:
    start_seconds: float
    end_seconds: float
    text: str
    # Language the segment was routed under (an estimate); only set by engines that detect it per passage.
    language: str | None = None


@dataclass(frozen=True)
class EngineCapabilities:
    """What an engine can honestly provide; clients must not assume more."""
    timestamps: bool = False
    language_detection: bool = False
    streaming: bool = False
    max_audio_seconds: float | None = None


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    engine: str
    model: str
    # Language detection is an estimate, not proof of correct transcription.
    language: str | None = None
    language_probability: float | None = None
    segments: tuple[Segment, ...] = field(default_factory=tuple)
    # Things the caller must know about a result that is otherwise returned normally (e.g. a passage that failed).
    warnings: tuple[str, ...] = field(default_factory=tuple)


class SpeechEngine(Protocol):
    """Common contract; concrete engines may expose different capabilities."""

    @property
    def name(self) -> str: ...

    @property
    def model(self) -> str: ...

    @property
    def capabilities(self) -> EngineCapabilities: ...

    def transcribe(self, audio_path: Path) -> TranscriptionResult: ...
