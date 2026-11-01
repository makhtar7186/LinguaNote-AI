import wave
from pathlib import Path

import numpy as np
import pytest

from app.engines.base import EngineCapabilities, Segment, TranscriptionResult
from app.language.detector import SAMPLE_RATE
from app.language.routing import LanguageRouter, RoutedEngine
from app.language.segmentation import UNKNOWN, SegmentationConfig, segment_by_language

FR_HZ, WO_HZ = 300.0, 900.0


def tone(seconds: float, hz: float, amplitude: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return (amplitude * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32)


class FrequencyDetector:
    """Stands in for a real detector: the pitch of the signal is its 'language'. 85 % sure, never certain."""

    def __init__(self) -> None:
        self.calls = 0

    def detect(self, samples):
        self.calls += 1
        # pauses carry no language, like for a real detector; relative to the window's peak so level does not matter
        voiced = samples[np.abs(samples) > 0.05 * np.abs(samples).max()]
        signs = np.signbit(voiced)
        crossings = np.count_nonzero(signs[1:] != signs[:-1])
        hz = crossings / 2 / (len(voiced) / SAMPLE_RATE)
        label = "fr" if abs(hz - FR_HZ) < abs(hz - WO_HZ) else "wo"
        other = "wo" if label == "fr" else "fr"
        return {label: 0.85, other: 0.15}


def audio(*parts):
    return np.concatenate(parts)


# -- segmentation ---------------------------------------------------------------------------------------------

def test_one_language_is_one_chunk_covering_everything():
    samples = audio(tone(9.0, FR_HZ))
    chunks = segment_by_language(samples, FrequencyDetector())
    assert [(c.index, c.label) for c in chunks] == [(0, "fr")]
    assert chunks[0].start_seconds == 0.0 and chunks[0].end_seconds == pytest.approx(9.0)
    assert chunks[0].confidence == pytest.approx(0.85)


def test_a_language_change_is_cut_in_the_pause_between_the_two():
    samples = audio(tone(6.0, FR_HZ), silence(1.0), tone(6.0, WO_HZ))
    chunks = segment_by_language(samples, FrequencyDetector())
    assert [c.label for c in chunks] == ["fr", "wo"]
    cut = chunks[0].end_seconds
    assert 6.0 <= cut <= 7.0, "the boundary must fall inside the silence, not inside a word"
    assert chunks[1].start_seconds == cut  # no gap and no overlap


def test_chunks_always_tile_the_audio_without_gap_overlap_or_loss():
    samples = audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ), silence(0.8), tone(5.0, FR_HZ), silence(0.8),
                    tone(5.0, WO_HZ))
    total = len(samples) / SAMPLE_RATE
    chunks = segment_by_language(samples, FrequencyDetector())
    assert [c.label for c in chunks] == ["fr", "wo", "fr", "wo"]
    assert [c.index for c in chunks] == [0, 1, 2, 3]
    assert chunks[0].start_seconds == 0.0 and chunks[-1].end_seconds == pytest.approx(total)
    for before, after in zip(chunks, chunks[1:], strict=False):
        assert before.end_seconds == after.start_seconds


def test_a_short_blip_of_another_language_does_not_flip_the_chunk():
    samples = audio(tone(8.0, FR_HZ), tone(0.6, WO_HZ), tone(8.0, FR_HZ))
    chunks = segment_by_language(samples, FrequencyDetector())
    assert [c.label for c in chunks] == ["fr"]


def test_without_smoothing_the_same_blip_would_split_the_audio():
    """Proves the test above has teeth: with no switch penalty and no minimum span the blip does create chunks."""
    samples = audio(tone(8.0, FR_HZ), tone(1.6, WO_HZ), tone(8.0, FR_HZ))
    raw = SegmentationConfig(switch_penalty=0.0, min_span_seconds=0.1)
    assert len(segment_by_language(samples, FrequencyDetector(), raw)) > 1


def test_silence_alone_claims_no_language():
    chunks = segment_by_language(silence(5.0), FrequencyDetector())
    assert [(c.label, c.confidence) for c in chunks] == [(UNKNOWN, 0.0)]


def test_a_fraction_of_a_second_of_silence_is_still_one_covering_chunk():
    chunks = segment_by_language(silence(0.3), FrequencyDetector())
    assert [(c.label, c.start_seconds, c.end_seconds) for c in chunks] == [(UNKNOWN, 0.0, pytest.approx(0.3))]


def test_spans_shorter_than_the_minimum_are_absorbed_by_a_neighbour_and_time_stays_covered():
    from app.language.segmentation import _merge_short

    spans = [[0.0, 1.0, "fr", 0.9, 1.0], [1.0, 1.4, "wo", 0.6, 1.0], [1.4, 2.0, "fr", 0.8, 1.0],
             [2.0, 3.0, "en", 0.7, 1.0], [3.0, 9.0, "wo", 0.95, 4.0]]
    merged = _merge_short([list(span) for span in spans], 2.0)
    assert merged[0][0] == 0.0 and merged[-1][1] == 9.0  # the recording is still covered end to end
    for before, after in zip(merged, merged[1:], strict=False):
        assert after[0] == before[1] and after[2] != before[2]  # contiguous, and neighbours differ in label
    assert all(span[1] - span[0] >= 2.0 for span in merged)


def test_many_tiny_alternating_passages_still_tile_the_audio():
    # 20 alternations of 0.5 s: far shorter than a detection window. Nothing may be dropped or overlap.
    # (The smoothing alone keeps this input from producing micro-chunks, so this does not exercise the merge step:
    # test_spans_shorter_than_the_minimum... does.)
    parts = []
    for index in range(20):
        parts.append(tone(0.5, FR_HZ if index % 2 == 0 else WO_HZ))
    samples = audio(*parts)
    config = SegmentationConfig()
    chunks = segment_by_language(samples, FrequencyDetector(), config)
    assert chunks[0].start_seconds == 0.0 and chunks[-1].end_seconds == pytest.approx(10.0)
    for before, after in zip(chunks, chunks[1:], strict=False):
        assert after.start_seconds == pytest.approx(before.end_seconds)  # contiguous: no gap, no overlap
    assert [c.index for c in chunks] == list(range(len(chunks)))
    assert all(c.duration >= config.min_span_seconds - 1e-6 for c in chunks) or len(chunks) == 1


def test_empty_audio_gives_no_chunk_and_asks_nothing_of_the_detector():
    detector = FrequencyDetector()
    assert segment_by_language(np.zeros(0, dtype=np.float32), detector) == []
    assert detector.calls == 0


def test_audio_shorter_than_a_window_is_still_handled():
    chunks = segment_by_language(tone(1.0, WO_HZ), FrequencyDetector())
    assert [c.label for c in chunks] == ["wo"]
    assert chunks[0].end_seconds == pytest.approx(1.0)


def test_silent_windows_are_not_sent_to_the_detector():
    detector = FrequencyDetector()
    segment_by_language(audio(tone(3.0, FR_HZ), silence(30.0), tone(3.0, FR_HZ)), detector)
    assert detector.calls < 12  # a 36 s file with 30 s of silence is not 24 detections


def test_quiet_speech_is_not_mistaken_for_silence():
    # Measured on real corpora: some recordings sit around 0.001 RMS while others sit around 0.05. The quiet one must
    # still reach the detector, or the previous language silently runs over it.
    samples = audio(tone(6.0, FR_HZ, 0.05), silence(1.0), tone(6.0, WO_HZ, 0.002))
    chunks = segment_by_language(samples, FrequencyDetector())
    assert [c.label for c in chunks] == ["fr", "wo"]


# -- routing --------------------------------------------------------------------------------------------------

class FakeEngine:
    capabilities = EngineCapabilities(timestamps=True)

    def __init__(self, name, fail=False):
        self.name, self.model, self.fail, self.calls = name, f"{name}-model", fail, []

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        with wave.open(str(audio_path)) as wav:
            seconds = wav.getnframes() / wav.getframerate()
        self.calls.append(seconds)
        if self.fail:
            raise RuntimeError("model crashed on private text")
        text = f"[{self.name} {seconds:.0f}s]"
        return TranscriptionResult(text=text, engine=self.name, model=self.model,
                                   segments=(Segment(0.0, seconds, text),))


class HintEngine(FakeEngine):
    """An engine that accepts the language the router detected, and remembers what it was told."""

    accepts_language_hint = True

    def __init__(self, name, fail=False):
        super().__init__(name, fail)
        self.hints = []

    def transcribe(self, audio_path: Path, language=None) -> TranscriptionResult:
        self.hints.append(language)
        return super().transcribe(audio_path)


def router(engines=None, **kwargs):
    engines = engines or {"fr": FakeEngine("multi"), "wo": FakeEngine("wolof")}
    return LanguageRouter(engines, "fr", FrequencyDetector(), **kwargs), engines


def test_each_chunk_goes_to_its_engine_and_the_text_follows_the_recording_order():
    r, engines = router()
    samples = audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ), silence(0.8), tone(5.0, FR_HZ))
    result = r.transcribe_samples(samples)
    assert [item.engine_label for item in result.chunks] == ["fr", "wo", "fr"]
    assert result.text.split(" ")[0] == "[multi" and "[wolof" in result.text
    assert [s.text.split(" ")[0] for s in result.segments] == ["[multi", "[wolof", "[multi"]
    assert len(engines["wo"].calls) == 1 and len(engines["fr"].calls) == 2


def test_segment_times_are_shifted_back_to_the_whole_recording():
    r, _ = router()
    result = r.transcribe_samples(audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ)))
    first, second = result.segments
    assert first.start_seconds == 0.0
    assert second.start_seconds == pytest.approx(result.chunks[1].chunk.start_seconds)
    assert second.end_seconds == pytest.approx(result.chunks[1].chunk.end_seconds)
    assert first.end_seconds <= second.start_seconds + 1e-6


def test_a_language_without_engine_falls_back_to_the_default_and_says_so():
    r, engines = router({"fr": FakeEngine("multi")})  # no Wolof engine installed
    result = r.transcribe_samples(audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ)))
    wolof_chunk = result.chunks[1]
    assert wolof_chunk.chunk.label == "wo" and wolof_chunk.engine_label == "fr" and wolof_chunk.fallback is True
    assert result.chunks[0].fallback is False
    assert len(engines["fr"].calls) == 2


def test_a_failing_chunk_is_reported_and_the_others_survive():
    engines = {"fr": FakeEngine("multi"), "wo": FakeEngine("wolof", fail=True)}
    r, _ = router(engines)
    result = r.transcribe_samples(audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ), silence(0.8), tone(5.0, FR_HZ)))
    assert result.failed_chunks == (1,)
    assert result.chunks[1].error == "RuntimeError"
    assert "private text" not in str(result.chunks[1].error)  # only the error type is kept
    assert result.text.count("[multi") == 2


def test_a_passage_is_transcribed_in_the_language_detected_for_it_except_wolof():
    engines = {"fr": HintEngine("multi"), "wo": HintEngine("wolof")}
    r, _ = router(engines, language_hints=frozenset({"fr", "en"}))
    r.transcribe_samples(audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ), silence(0.8), tone(5.0, FR_HZ)))
    assert engines["fr"].hints == ["fr", "fr"]  # told the detected language
    assert engines["wo"].hints == [None]  # Whisper has no Wolof code: the Wolof model is told nothing


def test_no_hint_is_given_when_the_router_was_not_asked_to_or_the_engine_cannot_take_one():
    engines = {"fr": HintEngine("multi"), "wo": FakeEngine("wolof")}
    r, _ = router(engines)  # no language_hints configured
    r.transcribe_samples(audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ)))
    assert engines["fr"].hints == [None]
    # an engine without the capability is called exactly as before (no unexpected keyword argument)
    r2, _ = router({"fr": FakeEngine("multi"), "wo": FakeEngine("wolof")}, language_hints=frozenset({"fr", "wo"}))
    assert r2.transcribe_samples(audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ))).failed_chunks == ()


def test_a_fallback_passage_is_not_forced_into_the_language_it_was_labelled_with():
    engines = {"fr": HintEngine("multi")}  # no Wolof engine: the Wolof passage falls back to the default engine
    r, _ = router(engines, language_hints=frozenset({"fr", "en", "wo"}))
    r.transcribe_samples(audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ)))
    assert engines["fr"].hints == ["fr", None]  # only the passage that really is French is told so


def test_the_default_label_must_have_an_engine():
    with pytest.raises(ValueError):
        LanguageRouter({"wo": FakeEngine("wolof")}, "fr", FrequencyDetector())


def write_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes((samples * 32767).astype("<i2").tobytes())


def test_the_routed_engine_is_a_speech_engine_for_the_rest_of_the_application(tmp_path):
    r, _ = router()
    engine = RoutedEngine(r, "multi+wolof")
    write_wav(tmp_path / "mixed.wav", audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ)))
    result = engine.transcribe(tmp_path / "mixed.wav")
    assert (result.engine, result.model) == ("language-router", "multi+wolof")
    assert result.language is None  # two languages: no single language is claimed
    assert len(result.segments) == 2 and engine.last is not None and len(engine.last.chunks) == 2


def test_the_routed_engine_reports_a_language_only_for_a_single_language_recording(tmp_path):
    r, _ = router()
    write_wav(tmp_path / "wolof.wav", tone(6.0, WO_HZ))
    assert RoutedEngine(r).transcribe(tmp_path / "wolof.wav").language == "wo"


def test_audio_with_no_detectable_language_goes_to_the_default_engine_and_claims_no_language(tmp_path):
    r, engines = router()
    write_wav(tmp_path / "quiet.wav", silence(5.0))
    engine = RoutedEngine(r)
    result = engine.transcribe(tmp_path / "quiet.wav")
    item = engine.last.chunks[0]
    assert item.chunk.label == UNKNOWN and item.fallback is True and item.engine_label == "fr"
    assert result.language is None and all(s.language is None for s in result.segments)
    assert len(engines["fr"].calls) == 1 and engines["wo"].calls == []


def test_every_segment_carries_the_language_it_was_routed_under(tmp_path):
    r, _ = router()
    write_wav(tmp_path / "mixed.wav", audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ)))
    result = RoutedEngine(r).transcribe(tmp_path / "mixed.wav")
    assert [s.language for s in result.segments] == ["fr", "wo"]
    assert result.warnings == ()


def test_a_lost_passage_is_a_warning_in_the_result_not_a_silent_gap(tmp_path):
    engines = {"fr": FakeEngine("multi"), "wo": FakeEngine("wolof", fail=True)}
    r, _ = router(engines)
    write_wav(tmp_path / "mixed.wav", audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ), silence(0.8), tone(5.0, FR_HZ)))
    result = RoutedEngine(r).transcribe(tmp_path / "mixed.wav")
    assert len(result.warnings) == 1 and result.warnings[0].startswith("passage_failed:") and "(wo)" in result.warnings[0]
    assert "private text" not in result.warnings[0]
    assert result.text.count("[multi") == 2


def test_when_every_passage_fails_the_engine_raises_instead_of_returning_an_empty_text(tmp_path):
    r, _ = router({"fr": FakeEngine("multi", fail=True), "wo": FakeEngine("wolof", fail=True)})
    write_wav(tmp_path / "mixed.wav", audio(tone(5.0, FR_HZ), silence(0.8), tone(5.0, WO_HZ)))
    with pytest.raises(RuntimeError):
        RoutedEngine(r).transcribe(tmp_path / "mixed.wav")


def test_the_routed_engine_refuses_audio_that_is_not_normalised(tmp_path):
    path = tmp_path / "stereo.wav"
    with wave.open(str(path), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(b"\x00\x00" * 200)
    r, _ = router()
    with pytest.raises(ValueError):
        RoutedEngine(r).transcribe(path)


def test_a_boundary_inside_speech_is_moved_to_the_nearby_pause():
    from app.language.segmentation import _quietest_point

    samples = audio(tone(5.0, FR_HZ), silence(0.4), tone(5.0, WO_HZ))  # the pause is 5.0 - 5.4 s
    moved = _quietest_point(samples, 5.6, SegmentationConfig(), 0.1, 10.0)  # raw boundary: inside the second word
    assert 5.0 <= moved <= 5.4
    # nothing quiet in range: the boundary stays where it was
    assert _quietest_point(tone(10.0, FR_HZ), 5.0, SegmentationConfig(), 0.1, 9.9) == pytest.approx(5.0, abs=0.05)
