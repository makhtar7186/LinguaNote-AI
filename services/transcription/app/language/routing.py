"""Sends each language-homogeneous chunk to the engine that suits it and reassembles the text in time order.

Rules that keep the final text honest:
  * chunks are processed and joined by their `index` (time order), never by completion order;
  * a chunk whose language has no dedicated engine goes to the default (multilingual) engine and is reported as such;
  * a chunk that fails is listed in `failed_chunks` and leaves a gap that is visible in the result, never a silent loss;
  * the original recognised text is preserved: nothing is translated or corrected.
"""
import logging
import tempfile
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from app.engines.base import EngineCapabilities, Segment, SpeechEngine, TranscriptionResult
from app.language.detector import SAMPLE_RATE, LanguageDetector
from app.language.segmentation import UNKNOWN, Chunk, SegmentationConfig, segment_by_language

logger = logging.getLogger("linguanote.routing")


@dataclass(frozen=True)
class RoutedChunk:
    chunk: Chunk
    engine_label: str  # the language whose engine transcribed it (may differ from chunk.label on fallback)
    fallback: bool
    text: str
    segments: tuple[Segment, ...]
    error: str | None = None


@dataclass(frozen=True)
class RoutedTranscription:
    chunks: tuple[RoutedChunk, ...]
    text: str
    segments: tuple[Segment, ...]
    failed_chunks: tuple[int, ...] = field(default_factory=tuple)


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as audio:
        if audio.getframerate() != SAMPLE_RATE or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError("Routing expects 16 kHz mono 16-bit audio (the normalised format).")
        frames = audio.readframes(audio.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def _write_wav(path: Path, samples: np.ndarray) -> None:
    pcm = np.clip(samples * 32768.0, -32768, 32767).astype("<i2").tobytes()
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(pcm)


class LanguageRouter:
    def __init__(
        self, engines: dict[str, SpeechEngine], default_label: str, detector: LanguageDetector,
        config: SegmentationConfig | None = None,
    ) -> None:
        if default_label not in engines:
            raise ValueError("The default label needs an engine.")
        self.engines = engines
        self.default_label = default_label
        self.detector = detector
        self.config = config or SegmentationConfig()

    def _engine_for(self, label: str) -> tuple[str, SpeechEngine, bool]:
        if label in self.engines:
            return label, self.engines[label], False
        return self.default_label, self.engines[self.default_label], True

    def _transcribe_chunk(self, chunk: Chunk, samples: np.ndarray) -> RoutedChunk:
        engine_label, engine, fallback = self._engine_for(chunk.label)
        begin, end = int(chunk.start_seconds * SAMPLE_RATE), int(chunk.end_seconds * SAMPLE_RATE)
        with tempfile.TemporaryDirectory(prefix="linguanote-chunk-") as directory:
            path = Path(directory) / "chunk.wav"
            _write_wav(path, samples[begin:end])
            try:
                result = engine.transcribe(path)
            except Exception as error:  # noqa: BLE001 - one bad chunk must not lose the others
                logger.warning("Chunk %d failed (%s)", chunk.index, type(error).__name__)  # never the audio or text
                return RoutedChunk(chunk, engine_label, fallback, "", (), error=type(error).__name__)
        # times returned by the engine are relative to the chunk: shifted back to the whole recording
        shifted = tuple(
            Segment(chunk.start_seconds + s.start_seconds, chunk.start_seconds + s.end_seconds, s.text)
            for s in result.segments
        )
        return RoutedChunk(chunk, engine_label, fallback, result.text.strip(), shifted)

    def transcribe_samples(self, samples: np.ndarray) -> RoutedTranscription:
        chunks = segment_by_language(samples, self.detector, self.config)
        routed = [self._transcribe_chunk(chunk, samples) for chunk in chunks]  # sequential: one inference worker
        routed.sort(key=lambda item: item.chunk.index)  # the order of the recording, whatever happened above
        return RoutedTranscription(
            chunks=tuple(routed),
            text=" ".join(item.text for item in routed if item.text),
            segments=tuple(segment for item in routed for segment in item.segments),
            failed_chunks=tuple(item.chunk.index for item in routed if item.error),
        )


class RoutedEngine:
    """A SpeechEngine made of several engines: the rest of the application sees one engine."""

    name = "language-router"
    capabilities = EngineCapabilities(timestamps=True, language_detection=True)

    def __init__(self, router: LanguageRouter, model_label: str = "routed") -> None:
        self.router = router
        self._model = model_label
        self.last: RoutedTranscription | None = None  # chunk-level detail of the latest call, for diagnostics

    @property
    def model(self) -> str:
        return self._model

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        routed = self.router.transcribe_samples(read_wav(audio_path))
        self.last = routed
        labels = {item.chunk.label for item in routed.chunks if item.text}
        # The single `language` field is only filled when the whole recording is in one language.
        language = labels.pop() if len(labels) == 1 and UNKNOWN not in labels else None
        return TranscriptionResult(
            text=routed.text, engine=self.name, model=self._model, language=language, language_probability=None,
            segments=routed.segments,
        )
