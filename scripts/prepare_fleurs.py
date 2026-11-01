"""Builds an evaluation manifest (wo / fr / en) from the FLEURS test parquet files.

Developer tool, not part of the application: it needs `pyarrow` (see prepare_alffa_wolof.py for a throw-away venv).

    .prep-venv/Scripts/python scripts/prepare_fleurs.py --dir data/corpus/fleurs

Expects wo_sn-test.parquet, fr_fr-test.parquet and en_us-test.parquet in --dir (from the `refs/convert/parquet` branch
of google/fleurs). FLEURS is CC BY 4.0: cite Conneau et al., "FLEURS: Few-shot Learning Evaluation of Universal
Representations of Speech", 2022. Read speech of Wikipedia-style sentences: it says nothing about conversations or
about mixed-language speech.
"""
import argparse
import csv
import random
from pathlib import Path

import pyarrow.parquet as pq

RIGHTS = "CC BY 4.0 (google/fleurs); cite Conneau et al. 2022"
FILES = {"wo": "wo_sn-test.parquet", "fr": "fr_fr-test.parquet", "en": "en_us-test.parquet"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dir", type=Path, default=Path("data/corpus/fleurs"))
    parser.add_argument("--per-language", type=int, default=120)
    parser.add_argument("--validation-share", type=float, default=0.4)
    parser.add_argument("--seed", type=int, default=20261031)
    args = parser.parse_args()

    clips = args.dir / "clips"
    clips.mkdir(parents=True, exist_ok=True)
    rows = []
    for category, filename in FILES.items():
        table = pq.read_table(args.dir / filename, columns=["id", "audio", "transcription", "gender"])
        ids, audio = table.column("id").to_pylist(), table.column("audio").to_pylist()
        transcripts, genders = table.column("transcription").to_pylist(), table.column("gender").to_pylist()
        # The same sentence is read by several speakers (same id): keep one reading, so a sentence never lands in
        # both the dev and the validation split.
        seen: set = set()
        usable = []
        for i, text in enumerate(transcripts):
            if text and text.strip() and "�" not in text and ids[i] not in seen:
                seen.add(ids[i])
                usable.append(i)
        chosen = random.Random(args.seed).sample(usable, min(args.per_language, len(usable)))
        cut = round(len(chosen) * (1 - args.validation_share))
        for rank, i in enumerate(chosen):
            name = f"{category}_{ids[i]}.wav"
            (clips / name).write_bytes(audio[i]["bytes"])
            rows.append({
                "id": f"fleurs_{category}_{ids[i]}", "audio_path": f"clips/{name}", "category": category,
                "reference": transcripts[i].strip(), "split": "dev" if rank < cut else "validation", "synthetic": 0,
                "rights": RIGHTS, "speaker": f"{genders[i]}", "context": "FLEURS read speech (test split)",
            })
        print(f"{category}: {len(usable)} usable, {len(chosen)} kept")

    with (args.dir / "manifest.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"Manifest: {args.dir / 'manifest.csv'} ({len(rows)} clips)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
