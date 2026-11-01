"""End-to-end test of language routing on mixed recordings built from held-out (validation) clips.

Developer tool (service environment, repository root):

    set PYTHONPATH=services/transcription
    services/transcription/.venv/Scripts/python scripts/eval_routing.py \
        --manifest data/corpus/fleurs/manifest.csv --manifest data/corpus/alffa_wolof/manifest.csv \
        --classifier data/lid/classifier-tiny-devonly.json --wolof-model data/models/whisper-small-wolof-ct2 \
        --recordings 10 --out data/eval-results/routing/run1.json

Each recording is 4-6 read clips in a random mix of wolof / french / english separated by short pauses, so the true
boundaries, languages and text are known. Four systems are compared on the SAME audio:
  multilingual  one Whisper model for everything (today's behaviour)
  wolof-only    the Wolof model for everything
  routed        detection -> language chunks -> best engine per chunk -> reassembly (the feature under test)
  oracle        the same engines with the TRUE boundaries and languages (what routing could give with a perfect detector)
Read speech glued together is an artificial mix: it measures the machinery, not natural code-switching.
"""
import argparse
import json
import os
import random
import statistics
import tempfile
import time
from pathlib import Path

import numpy as np

from app.audio.convert import convert_to_model_wav
from app.engines.base import SpeechEngine
from app.engines.faster_whisper import FasterWhisperEngine
from app.evaluation.manifest import load_manifest
from app.evaluation.metrics import EMPTY, word_counts
from app.language.classifier import ClassifierDetector, LinearLanguageClassifier
from app.language.detector import SAMPLE_RATE
from app.language.routing import LanguageRouter, RoutedEngine, read_wav
from app.language.rule import FrenchEnglishElseWolofDetector
from app.language.segmentation import Chunk, SegmentationConfig
from app.language.whisper_lid import WhisperLanguageFeatures


def build_engine(model: str) -> SpeechEngine:
    os.environ["LINGUANOTE_WHISPER_MODEL"] = model
    return FasterWhisperEngine()


def load_clip(item, ffmpeg: str) -> np.ndarray:
    with tempfile.TemporaryDirectory(prefix="linguanote-route-") as directory:
        wav = Path(directory) / "clip.wav"
        convert_to_model_wav(item.audio_path, wav, ffmpeg=ffmpeg, max_seconds=60, timeout=120)
        return read_wav(wav)


def make_recording(items, rng: random.Random, ffmpeg: str):
    """items: validation clips grouped by category. Returns samples, truth chunks, reference text."""
    count = rng.randint(4, 6)
    labels = []
    while len(set(labels)) < 2:
        labels = [rng.choice(["wo", "fr", "en"]) for _ in range(count)]
    parts, truth, texts, cursor = [], [], [], 0.0
    for index, label in enumerate(labels):
        item = rng.choice(items[label])
        clip = load_clip(item, ffmpeg)
        pause = np.random.default_rng(rng.randrange(1 << 30)).normal(0, 0.001, int(rng.uniform(0.4, 0.8) * SAMPLE_RATE))
        start = cursor
        cursor += len(clip) / SAMPLE_RATE
        truth.append({"label": label, "start": start, "end": cursor, "id": item.id})
        texts.append(item.reference)
        parts.append(clip)
        if index < len(labels) - 1:
            parts.append(pause.astype(np.float32))
            cursor += len(pause) / SAMPLE_RATE
    return np.concatenate(parts), truth, " ".join(texts)


def write_wav(path: Path, samples: np.ndarray) -> None:
    import wave
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(np.clip(samples * 32768.0, -32768, 32767).astype("<i2").tobytes())


def label_accuracy(chunks: list[Chunk], truth: list[dict]) -> tuple[float, float]:
    """Share of the SPEECH time (inside true clips) given the right label, and the total speech seconds."""
    right = total = 0.0
    for clip in truth:
        for chunk in chunks:
            overlap = max(0.0, min(clip["end"], chunk.end_seconds) - max(clip["start"], chunk.start_seconds))
            total += overlap
            if chunk.label == clip["label"]:
                right += overlap
    return right, total


def boundary_errors(chunks: list[Chunk], truth: list[dict]) -> tuple[list[float], int]:
    """Distance from each true language change to the nearest predicted boundary; and spurious predicted ones."""
    true_changes = [(a["end"] + b["start"]) / 2 for a, b in zip(truth, truth[1:], strict=False) if a["label"] != b["label"]]
    predicted = [chunk.start_seconds for chunk in chunks[1:]]
    errors = [min((abs(p - t) for p in predicted), default=float("inf")) for t in true_changes]
    spurious = sum(1 for p in predicted if all(abs(p - t) > 1.5 for t in true_changes))
    return errors, spurious


def oracle_chunks(truth: list[dict], total: float) -> list[Chunk]:
    boundaries = [0.0] + [(a["end"] + b["start"]) / 2 for a, b in zip(truth, truth[1:], strict=False)] + [total]
    return [Chunk(i, boundaries[i], boundaries[i + 1], clip["label"], 1.0) for i, clip in enumerate(truth)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--manifest", action="append", required=True)
    parser.add_argument("--detector", choices=("classifier", "rule"), default="classifier")
    parser.add_argument("--classifier", help="classifier JSON (required for --detector classifier)")
    parser.add_argument("--rule-threshold", type=float, default=0.77, help="--detector rule: confidence to call fr/en")
    parser.add_argument("--only-routed", action="store_true",
                        help="skip the multilingual, wolof-only and oracle systems (compare detectors faster)")
    parser.add_argument("--language-hints", action="store_true",
                        help="tell the multilingual model the language detected for each fr/en passage")
    parser.add_argument("--wolof-model", required=True)
    parser.add_argument("--multilingual-model", default="small")
    parser.add_argument("--lid-model", default="tiny")
    parser.add_argument("--recordings", type=int, default=10)
    parser.add_argument("--seed", type=int, default=20261031)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.detector == "classifier" and not args.classifier:
        parser.error("--classifier is required with --detector classifier")

    items = {"wo": [], "fr": [], "en": []}
    for manifest in args.manifest:
        for item in load_manifest(Path(manifest), split="validation"):
            if item.category in items:
                items[item.category].append(item)

    multilingual = build_engine(args.multilingual_model)
    wolof = build_engine(args.wolof_model)
    lid = WhisperLanguageFeatures(args.lid_model)
    if args.detector == "rule":
        detector = FrenchEnglishElseWolofDetector(lid, args.rule_threshold)
    else:
        detector = ClassifierDetector(lid, LinearLanguageClassifier.load(Path(args.classifier)))
    config = SegmentationConfig()
    engines = {"fr": multilingual, "en": multilingual, "wo": wolof}
    hints = frozenset({"fr", "en"}) if args.language_hints else frozenset()
    routed_engine = RoutedEngine(LanguageRouter(engines, "fr", detector, config, language_hints=hints))
    rng = random.Random(args.seed)

    systems = {name: EMPTY for name in ("multilingual", "wolof-only", "routed", "oracle")}
    seconds = {name: 0.0 for name in systems}
    right = total = 0.0
    errors_all: list[float] = []
    spurious = misses = changes = 0
    detail = []
    for number in range(args.recordings):
        samples, truth, reference = make_recording(items, rng, args.ffmpeg)
        duration = len(samples) / SAMPLE_RATE
        with tempfile.TemporaryDirectory(prefix="linguanote-route-") as directory:
            path = Path(directory) / "mixed.wav"
            write_wav(path, samples)
            outputs = {}

            def oracle_text() -> str:
                # same engines, TRUE boundaries and languages: isolates the cost of detection errors
                router = routed_engine.router
                parts = [router._transcribe_chunk(c, samples) for c in oracle_chunks(truth, duration)]
                return " ".join(part.text for part in parts if part.text)

            for name, run in (
                ("multilingual", lambda: multilingual.transcribe(path).text),
                ("wolof-only", lambda: wolof.transcribe(path).text),
                ("routed", lambda: routed_engine.transcribe(path).text),
                ("oracle", oracle_text),
            ):
                if args.only_routed and name != "routed":
                    continue
                begin = time.perf_counter()
                outputs[name] = run()
                seconds[name] += time.perf_counter() - begin
        for name, text in outputs.items():
            systems[name] = systems[name] + word_counts(reference, text)
        chunks = [item.chunk for item in routed_engine.last.chunks]
        r, t = label_accuracy(chunks, truth)
        right, total = right + r, total + t
        errors, extra = boundary_errors(chunks, truth)
        errors_all += [e for e in errors if e != float("inf")]
        misses += sum(1 for e in errors if e == float("inf") or e > 1.5)
        changes += len(errors)
        spurious += extra
        detail.append({"recording": number, "seconds": duration, "truth": truth, "predicted": [
            {"label": c.label, "start": c.start_seconds, "end": c.end_seconds, "confidence": c.confidence} for c in chunks]})
        print(f"recording {number + 1}/{args.recordings}: {duration:.0f} s, {len(chunks)} chunks for {len(truth)} clips", flush=True)

    summary = {
        "recordings": args.recordings,
        "wer": {name: counts.rate for name, counts in systems.items()},
        "seconds_of_processing": seconds,
        "speech_labelled_correctly": right / total if total else None,
        "language_changes": changes, "changes_missed_or_more_than_1.5s_off": misses,
        "median_boundary_error_seconds": statistics.median(errors_all) if errors_all else None,
        "max_boundary_error_seconds": max(errors_all) if errors_all else None,
        "spurious_boundaries": spurious,
        "language_hints": args.language_hints, "detector": args.detector, "rule_threshold": args.rule_threshold if args.detector == "rule" else None,
        "classifier": args.classifier, "wolof_model": args.wolof_model, "multilingual_model": args.multilingual_model,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps({"summary": summary, "recordings": detail}, indent=1), encoding="utf-8")
    print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
