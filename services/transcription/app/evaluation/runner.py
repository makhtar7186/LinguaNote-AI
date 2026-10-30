"""Run an engine over a corpus and aggregate the results per category."""
import statistics
import tempfile
import time
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

from app.audio.convert import convert_to_model_wav, validate_wav
from app.engines.base import SpeechEngine
from app.evaluation.manifest import CorpusItem
from app.evaluation.metrics import EMPTY, EditCounts, char_counts, normalize, word_counts

# Evaluation reads clips up to the engine limit; longer clips are reported as failures, never truncated.
DEFAULT_MAX_SECONDS = 600.0


@dataclass(frozen=True)
class ItemResult:
    id: str
    category: str
    split: str
    synthetic: bool
    audio_seconds: float
    inference_seconds: float
    detected_language: str | None
    language_probability: float | None
    reference: str
    hypothesis: str
    word_errors: dict
    char_errors: dict
    error: str | None = None

    @property
    def real_time_factor(self) -> float | None:
        return self.inference_seconds / self.audio_seconds if self.audio_seconds else None


def _counts_to_dict(counts: EditCounts) -> dict:
    return {
        "substitutions": counts.substitutions, "deletions": counts.deletions,
        "insertions": counts.insertions, "reference_length": counts.reference_length,
    }


def _counts_from_dict(data: dict) -> EditCounts:
    return EditCounts(data["substitutions"], data["deletions"], data["insertions"], data["reference_length"])


def evaluate_item(
    engine: SpeechEngine, item: CorpusItem, *, ffmpeg: str, ffmpeg_timeout: int = 120,
    max_seconds: float = DEFAULT_MAX_SECONDS,
) -> ItemResult:
    """Decode with the same chain as the service, transcribe, score. Failures are recorded, not raised."""
    limit = min(max_seconds, engine.capabilities.max_audio_seconds or max_seconds)
    try:
        with tempfile.TemporaryDirectory(prefix="linguanote-eval-") as directory:
            wav = Path(directory) / "normalized.wav"
            convert_to_model_wav(item.audio_path, wav, ffmpeg=ffmpeg, max_seconds=limit, timeout=ffmpeg_timeout)
            duration = validate_wav(wav, max_seconds=limit)
            started = time.perf_counter()
            result = engine.transcribe(wav)
            elapsed = time.perf_counter() - started
    except Exception as exc:  # noqa: BLE001 - one bad clip must not abort the whole run
        return ItemResult(
            id=item.id, category=item.category, split=item.split, synthetic=item.synthetic,
            audio_seconds=0.0, inference_seconds=0.0, detected_language=None, language_probability=None,
            reference=item.reference, hypothesis="", word_errors=_counts_to_dict(EMPTY),
            char_errors=_counts_to_dict(EMPTY), error=f"{type(exc).__name__}: {exc}",
        )
    return ItemResult(
        id=item.id, category=item.category, split=item.split, synthetic=item.synthetic,
        audio_seconds=duration, inference_seconds=elapsed,
        detected_language=result.language, language_probability=result.language_probability,
        reference=item.reference, hypothesis=result.text,
        word_errors=_counts_to_dict(word_counts(item.reference, result.text)),
        char_errors=_counts_to_dict(char_counts(item.reference, result.text)),
    )


def result_from_dict(data: dict) -> ItemResult:
    return ItemResult(**data)


def result_to_dict(result: ItemResult) -> dict:
    return asdict(result)


@dataclass(frozen=True)
class CategorySummary:
    category: str
    clips: int
    failed: int
    wer: float | None
    cer: float | None
    substitutions: int
    deletions: int
    insertions: int
    language_match: float | None  # share of clips whose detected language equals the expected one
    median_latency_seconds: float | None
    real_time_factor: float | None  # total inference time / total audio time
    hallucinated_words: int  # words produced for silence clips


_EXPECTED = {"fr": "fr", "en": "en", "wo": "wo"}


def summarize(results: Sequence[ItemResult]) -> list[CategorySummary]:
    """Micro-averaged per category: total errors over total reference length, not a mean of rates."""
    summaries = []
    for category in sorted({result.category for result in results}):
        group = [r for r in results if r.category == category]
        ok = [r for r in group if r.error is None]
        words = sum((_counts_from_dict(r.word_errors) for r in ok), EMPTY)
        chars = sum((_counts_from_dict(r.char_errors) for r in ok), EMPTY)
        audio = sum(r.audio_seconds for r in ok)
        expected = _EXPECTED.get(category)
        language_match = (
            sum(1 for r in ok if r.detected_language == expected) / len(ok) if expected and ok else None
        )
        summaries.append(CategorySummary(
            category=category, clips=len(group), failed=len(group) - len(ok),
            wer=words.rate, cer=chars.rate,
            substitutions=words.substitutions, deletions=words.deletions, insertions=words.insertions,
            language_match=language_match,
            median_latency_seconds=statistics.median(r.inference_seconds for r in ok) if ok else None,
            real_time_factor=(sum(r.inference_seconds for r in ok) / audio) if audio else None,
            hallucinated_words=sum(len(normalize(r.hypothesis).split()) for r in ok) if category == "silence" else 0,
        ))
    return summaries


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f} %"


def _num(value: float | None, digits: int = 2) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def render_markdown(model_runs: Sequence[dict]) -> str:
    """One table per model. Always shows the number of clips next to every score."""
    lines: list[str] = []
    for run in model_runs:
        meta = run["meta"]
        results = [result_from_dict(item) for item in run["items"]]
        peak = meta.get("peak_memory_bytes")
        lines += [
            f"### {meta['engine']} / {meta['model']}",
            "",
            f"Chargement du modèle : {_num(meta.get('load_seconds'), 1)} s · "
            f"pic mémoire : {'n/a' if peak is None else f'{peak / 2**20:.0f} Mio'} · "
            f"{meta.get('device', 'cpu')} ({meta.get('compute_type', 'n/a')})",
            "",
            "| Catégorie | Clips (échecs) | WER | CER | S / D / I | Langue détectée = attendue "
            "| Latence médiane | Facteur temps réel | Mots dans les silences |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for s in summarize(results):
            lines.append(
                f"| {s.category} | {s.clips} ({s.failed}) | {_pct(s.wer)} | {_pct(s.cer)} | "
                f"{s.substitutions} / {s.deletions} / {s.insertions} | {_pct(s.language_match)} | "
                f"{_num(s.median_latency_seconds)} s | {_num(s.real_time_factor)} | "
                f"{s.hallucinated_words if s.category == 'silence' else '-'} |"
            )
        lines.append("")
    return "\n".join(lines)
