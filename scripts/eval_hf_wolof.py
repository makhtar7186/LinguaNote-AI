"""Scores a Hugging Face Wolof ASR model on a LinguaNote evaluation manifest, with the project's own metrics.

Developer tool, not part of the application: it needs torch + transformers, which the service does not depend on. Run
it from a throw-away environment, with the service folder on PYTHONPATH so the SAME decoding chain (FFmpeg, 16 kHz
mono) and the SAME normalisation / WER / CER code as `python -m app.evaluation` are used:

    set PYTHONPATH=services/transcription
    python scripts/eval_hf_wolof.py --manifest data/corpus/alffa_wolof/manifest.csv --split dev \
        --kind whisper --model M9and2M/whisper-small-wolof --out data/eval-results/hf-wolof/<name>.json

--kind whisper : encoder-decoder Whisper fine-tune. --kind ctc : wav2vec2-style CTC model.
Weights are downloaded by Hugging Face the first time (this is the consent point: pass --allow-download).
"""
import argparse
import json
import os
import statistics
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModelForCTC, AutoProcessor, WhisperForConditionalGeneration, WhisperProcessor

from app.audio.convert import convert_to_model_wav, validate_wav
from app.evaluation.manifest import load_manifest
from app.evaluation.metrics import EMPTY, char_counts, word_counts

SAMPLE_RATE = 16000


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as audio:
        frames = audio.readframes(audio.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def load(kind: str, model_id: str):
    if kind == "whisper":
        return WhisperProcessor.from_pretrained(model_id), WhisperForConditionalGeneration.from_pretrained(model_id)
    return AutoProcessor.from_pretrained(model_id), AutoModelForCTC.from_pretrained(model_id)


def transcribe(kind: str, processor, model, samples: np.ndarray, language: str | None) -> str:
    with torch.inference_mode():
        if kind == "whisper":
            features = processor(samples, sampling_rate=SAMPLE_RATE, return_tensors="pt").input_features
            options = {"max_new_tokens": 160, "task": "transcribe"}
            if language:
                options["language"] = language
            ids = model.generate(features, **options)
            return processor.batch_decode(ids, skip_special_tokens=True)[0].strip()
        inputs = processor(samples, sampling_rate=SAMPLE_RATE, return_tensors="pt")
        logits = model(inputs.input_values).logits
        return processor.batch_decode(torch.argmax(logits, dim=-1))[0].strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--split", choices=("dev", "validation"), default="dev")
    parser.add_argument("--kind", choices=("whisper", "ctc"), required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", help="Whisper only: language token to force (default: the model decides)")
    parser.add_argument("--category", help="only the clips of this category (wo, fr, en...)")
    parser.add_argument("--limit", type=int, help="first N clips only (quick check)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--ffmpeg", default=os.getenv("LINGUANOTE_FFMPEG", "ffmpeg"))
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--allow-download", action="store_true")
    args = parser.parse_args()

    if not args.allow_download:
        os.environ["HF_HUB_OFFLINE"] = "1"
    torch.set_num_threads(args.threads)
    items = [item for item in load_manifest(Path(args.manifest), split=args.split)
             if not args.category or item.category == args.category][: args.limit]

    started = time.perf_counter()
    processor, model = load(args.kind, args.model)
    model.eval()
    load_seconds = time.perf_counter() - started

    results, words, chars = [], EMPTY, EMPTY
    for item in items:
        with tempfile.TemporaryDirectory(prefix="linguanote-hf-") as directory:
            wav = Path(directory) / "normalized.wav"
            convert_to_model_wav(item.audio_path, wav, ffmpeg=args.ffmpeg, max_seconds=60, timeout=120)
            duration = validate_wav(wav, max_seconds=60)
            samples = read_wav(wav)
        begin = time.perf_counter()
        hypothesis = transcribe(args.kind, processor, model, samples, args.language)
        elapsed = time.perf_counter() - begin
        word, char = word_counts(item.reference, hypothesis), char_counts(item.reference, hypothesis)
        words, chars = words + word, chars + char
        results.append({"id": item.id, "audio_seconds": duration, "inference_seconds": elapsed,
                        "reference": item.reference, "hypothesis": hypothesis,
                        "word_errors": word.errors, "reference_words": word.reference_length})

    summary = {
        "model": args.model, "kind": args.kind, "language": args.language, "split": args.split, "clips": len(results),
        "wer": words.rate, "cer": chars.rate,
        "substitutions": words.substitutions, "deletions": words.deletions, "insertions": words.insertions,
        "median_latency_seconds": statistics.median(r["inference_seconds"] for r in results),
        "real_time_factor": sum(r["inference_seconds"] for r in results) / sum(r["audio_seconds"] for r in results),
        "load_seconds": load_seconds, "torch": torch.__version__, "threads": args.threads,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps({"summary": summary, "items": results}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
