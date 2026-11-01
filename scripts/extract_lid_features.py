"""Extracts Whisper language-probability vectors from short crops of the evaluation clips.

Developer tool (run in the service environment, from the repository root):

    set PYTHONPATH=services/transcription
    services/transcription/.venv/Scripts/python scripts/extract_lid_features.py \
        --manifest data/corpus/fleurs/manifest.csv --manifest data/corpus/alffa_wolof/manifest.csv \
        --lid-model tiny --out data/lid/features-tiny.npz

Each clip yields up to --crops random crops of --seconds seconds (the real window size of the segmenter). Rows keep
the clip id and the split, so training never sees a validation clip, even through a different crop of it.
"""
import argparse
import random
import tempfile
import time
from pathlib import Path

import numpy as np

from app.audio.convert import convert_to_model_wav
from app.evaluation.manifest import load_manifest
from app.language.detector import SAMPLE_RATE
from app.language.routing import read_wav
from app.language.whisper_lid import WhisperLanguageFeatures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--manifest", action="append", required=True)
    parser.add_argument("--lid-model", default="tiny")
    parser.add_argument("--seconds", type=float, default=3.0)
    parser.add_argument("--crops", type=int, default=3)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--seed", type=int, default=20261031)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    lid = WhisperLanguageFeatures(args.lid_model)
    rng = random.Random(args.seed)
    window = int(args.seconds * SAMPLE_RATE)
    rows, started, detections = [], time.perf_counter(), 0
    for manifest in args.manifest:
        for item in load_manifest(Path(manifest)):
            with tempfile.TemporaryDirectory(prefix="linguanote-lid-") as directory:
                wav = Path(directory) / "clip.wav"
                convert_to_model_wav(item.audio_path, wav, ffmpeg=args.ffmpeg, max_seconds=120, timeout=120)
                samples = read_wav(wav)
            if len(samples) < window:
                continue
            for _ in range(args.crops):
                begin = rng.randrange(0, len(samples) - window + 1)
                crop = samples[begin:begin + window]
                if float(np.sqrt(np.mean(np.square(crop)))) < 0.005:
                    continue  # a crop of silence says nothing about the language
                vector = lid.vector(crop)
                detections += 1
                rows.append((item.id, item.category, item.split, Path(manifest).parent.name, vector))
    elapsed = time.perf_counter() - started
    languages = list(lid.languages)
    features = np.array([[row[4].get(language, 0.0) for language in languages] for row in rows], dtype=np.float32)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.out, features=features, languages=np.array(languages), clip=np.array([r[0] for r in rows]),
        label=np.array([r[1] for r in rows]), split=np.array([r[2] for r in rows]),
        corpus=np.array([r[3] for r in rows]), lid_model=args.lid_model, seconds=args.seconds,
    )
    print(f"{detections} detections in {elapsed:.0f} s ({elapsed / max(detections, 1):.2f} s each) -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
