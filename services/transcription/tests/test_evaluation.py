import shutil
import wave
from pathlib import Path

import pytest

from app.engines.base import EngineCapabilities, TranscriptionResult
from app.evaluation.manifest import ManifestError, load_manifest
from app.evaluation.metrics import char_counts, edit_counts, normalize, word_counts
from app.evaluation.runner import ItemResult, evaluate_item, render_markdown, result_to_dict, summarize

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg not installed")


# --- metrics ---------------------------------------------------------------------------------------------

def test_normalize_unifies_case_punctuation_and_apostrophes_but_keeps_accents():
    assert normalize("  Bonjour,  J’ESPÈRE   que ça va ?! ") == "bonjour j'espère que ça va"
    assert normalize("'quoted' word -- done.") == "quoted word done"
    assert normalize("") == ""


def test_normalize_does_not_merge_distinct_spellings():
    assert normalize("jërëjëf") != normalize("jerejef")


def test_edit_counts_separates_substitutions_deletions_insertions():
    counts = edit_counts("a b c d".split(), "a x c d e".split())
    assert (counts.substitutions, counts.deletions, counts.insertions) == (1, 0, 1)
    assert counts.reference_length == 4
    assert counts.rate == pytest.approx(0.5)

    deletion = edit_counts("a b c".split(), "a c".split())
    assert (deletion.substitutions, deletion.deletions, deletion.insertions) == (0, 1, 0)


def test_identical_text_has_zero_errors_and_empty_reference_has_no_rate():
    assert word_counts("Bonjour tout le monde.", "bonjour tout le monde").errors == 0
    empty = word_counts("", "spurious words here")
    assert empty.reference_length == 0
    assert empty.insertions == 3
    assert empty.rate is None


def test_cer_counts_characters():
    counts = char_counts("chat", "chats")
    assert (counts.insertions, counts.errors) == (1, 1)
    assert counts.rate == pytest.approx(1 / 4)


def test_word_error_rate_can_exceed_one():
    assert word_counts("a", "x y z").rate == pytest.approx(3.0)


# --- manifest --------------------------------------------------------------------------------------------

HEADER = "id,audio_path,category,reference,split,synthetic,rights,speaker,context\n"


def write_manifest(tmp_path: Path, rows: list[str], audio: tuple[str, ...] = ("a.wav",)) -> Path:
    for name in audio:
        (tmp_path / name).write_bytes(b"RIFF")
    manifest = tmp_path / "manifest.csv"
    manifest.write_text(HEADER + "\n".join(rows) + "\n", encoding="utf-8")
    return manifest


def test_manifest_loads_valid_rows_and_resolves_audio_relative_to_it(tmp_path):
    manifest = write_manifest(tmp_path, [
        "fr-1,a.wav,fr,Bonjour tout le monde,dev,1,own text,,",
        "sil-1,a.wav,silence,,validation,1,generated,,",
    ])
    items = load_manifest(manifest)
    assert [i.id for i in items] == ["fr-1", "sil-1"]
    assert items[0].audio_path == (tmp_path / "a.wav").resolve()
    assert items[0].expected_language == "fr"
    assert items[1].expected_language is None
    assert [i.id for i in load_manifest(manifest, split="validation")] == ["sil-1"]


def test_manifest_reports_every_problem_at_once(tmp_path):
    manifest = write_manifest(tmp_path, [
        "dup,a.wav,fr,texte,dev,1,own,,",
        "dup,a.wav,klingon,texte,dev,1,own,,",
        "no-ref,a.wav,en,,dev,1,own,,",
        "no-rights,a.wav,en,text,dev,1,,,",
        "bad-split,a.wav,en,text,train,1,own,,",
        "missing,gone.wav,en,text,dev,1,own,,",
        "noisy-silence,a.wav,silence,not empty,dev,1,own,,",
    ])
    with pytest.raises(ManifestError) as raised:
        load_manifest(manifest)
    message = str(raised.value)
    for expected in ("duplicate id", "category must be", "empty reference", "rights/consent",
                     "split must be", "audio file not found", "silence clip must have an empty reference"):
        assert expected in message


def test_manifest_rejects_missing_columns(tmp_path):
    manifest = tmp_path / "manifest.csv"
    manifest.write_text("id,audio_path\nx,a.wav\n", encoding="utf-8")
    with pytest.raises(ManifestError, match="Missing columns"):
        load_manifest(manifest)


# --- runner ----------------------------------------------------------------------------------------------

def make_result(category, hypothesis, reference, *, audio=2.0, inference=1.0, detected="fr", error=None):
    words = word_counts(reference, hypothesis)
    chars = char_counts(reference, hypothesis)
    return ItemResult(
        id=f"{category}-x", category=category, split="dev", synthetic=True, audio_seconds=audio,
        inference_seconds=inference, detected_language=detected, language_probability=0.9,
        reference=reference, hypothesis=hypothesis,
        word_errors={"substitutions": words.substitutions, "deletions": words.deletions,
                     "insertions": words.insertions, "reference_length": words.reference_length},
        char_errors={"substitutions": chars.substitutions, "deletions": chars.deletions,
                     "insertions": chars.insertions, "reference_length": chars.reference_length},
        error=error,
    )


def test_summary_is_micro_averaged_not_a_mean_of_rates():
    # 1 error on 2 words, then 0 errors on 8 words: micro WER = 1/10 (a mean of rates would say 25 %).
    results = [
        make_result("fr", "bonjour monde", "bonjour tout"),
        make_result("fr", "un deux trois quatre cinq six sept huit", "un deux trois quatre cinq six sept huit"),
    ]
    summary = {s.category: s for s in summarize(results)}["fr"]
    assert summary.clips == 2
    assert summary.wer == pytest.approx(0.1)
    assert summary.language_match == 1.0
    assert summary.real_time_factor == pytest.approx(0.5)


def test_summary_counts_hallucinations_on_silence_and_wrong_language_and_failures():
    results = [
        make_result("silence", "merci d'avoir regardé", "", detected="fr"),
        make_result("silence", "", "", detected=None),
        make_result("en", "hello", "hello", detected="fr"),
        make_result("en", "", "hello", error="RuntimeError: boom"),
    ]
    by_category = {s.category: s for s in summarize(results)}
    assert by_category["silence"].hallucinated_words == 3
    assert by_category["silence"].wer is None  # no reference words: undefined, not 0 %
    assert by_category["en"].clips == 2 and by_category["en"].failed == 1
    assert by_category["en"].language_match == 0.0


def test_markdown_report_shows_clip_counts_next_to_scores():
    run = {
        "meta": {"engine": "faster-whisper", "model": "base", "load_seconds": 1.5, "peak_memory_bytes": 300 * 2**20},
        "items": [result_to_dict(make_result("fr", "bonjour", "bonjour"))],
    }
    report = render_markdown([run])
    assert "faster-whisper / base" in report
    assert "| fr | 1 (0) | 0.0 % |" in report
    assert "300 Mio" in report


class ScriptedEngine:
    name = "scripted"
    model = "scripted-model"
    capabilities = EngineCapabilities(timestamps=False, language_detection=True)

    def __init__(self, text="bonjour tout le monde", fail=False):
        self.text, self.fail = text, fail

    def transcribe(self, audio_path):
        if self.fail:
            raise RuntimeError("engine exploded")
        return TranscriptionResult(text=self.text, engine=self.name, model=self.model, language="fr",
                                   language_probability=0.8)


def write_wav(path: Path, seconds: float = 1.0, rate: int = 16000) -> Path:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(b"\x00\x00" * int(rate * seconds))
    return path


def corpus_item(tmp_path: Path, reference="bonjour tout le monde", category="fr"):
    manifest = write_manifest(tmp_path, [f"clip,a.wav,{category},{reference},dev,1,own text,,"])
    write_wav(tmp_path / "a.wav")
    return load_manifest(manifest)[0]


@needs_ffmpeg
def test_evaluate_item_scores_a_real_decode_and_transcription(tmp_path):
    result = evaluate_item(ScriptedEngine(), corpus_item(tmp_path), ffmpeg="ffmpeg")
    assert result.error is None
    assert result.audio_seconds == pytest.approx(1.0, abs=0.05)
    assert result.word_errors["substitutions"] == 0 and result.word_errors["reference_length"] == 4
    assert result.detected_language == "fr"


@needs_ffmpeg
def test_evaluate_item_records_engine_failure_instead_of_aborting(tmp_path):
    result = evaluate_item(ScriptedEngine(fail=True), corpus_item(tmp_path), ffmpeg="ffmpeg")
    assert result.error == "RuntimeError: engine exploded"
    assert result.hypothesis == ""


def test_evaluate_item_records_missing_ffmpeg_as_a_failure(tmp_path):
    result = evaluate_item(ScriptedEngine(), corpus_item(tmp_path), ffmpeg="ffmpeg-does-not-exist")
    assert result.error is not None and "ApiError" in result.error
