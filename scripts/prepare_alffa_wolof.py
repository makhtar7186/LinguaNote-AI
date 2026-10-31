"""Builds an evaluation manifest from the ALFFA Wolof test split (Hugging Face mirror, parquet).

Developer tool, not part of the application: it needs `pyarrow`, which the service does NOT depend on. Run it from a
throw-away environment:

    python -m venv .prep-venv && .prep-venv/Scripts/python -m pip install pyarrow
    .prep-venv/Scripts/python scripts/prepare_alffa_wolof.py --parquet data/corpus/alffa_wolof/test.parquet

Source and rights: https://github.com/getalp/ALFFA_PUBLIC (MIT; cite Gauthier, Besacier, Voisin, Melese, Elingui,
LREC 2016). The Hugging Face mirror declares no licence of its own. The corpus is READ speech: it says nothing about
conversational Wolof or about mixed-language speech.

Output goes to data/ (ignored by Git). Clips whose reference contains a replacement character (corrupted text in the
mirror) are excluded and counted, never repaired by guessing.
"""
import argparse
import csv
import random
import sys
from pathlib import Path

import pyarrow.parquet as pq

RIGHTS = "MIT (getalp/ALFFA_PUBLIC); cite Gauthier et al. LREC 2016; HF mirror serge-wilson without own licence"
MAX_SECONDS = 30.0


def is_clean(sentence: str) -> bool:
    text = sentence.strip()
    return bool(text) and "�" not in text and text.isprintable()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--parquet", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path("data/corpus/alffa_wolof"))
    parser.add_argument("--dev", type=int, default=150, help="clips in the dev split")
    parser.add_argument("--validation", type=int, default=100, help="clips kept apart (validation split)")
    parser.add_argument("--seed", type=int, default=20261031)
    args = parser.parse_args()

    table = pq.read_table(args.parquet)
    sentences = table.column("sentence").to_pylist()
    audio = table.column("audio").to_pylist()
    candidates = [index for index, sentence in enumerate(sentences) if is_clean(sentence)]
    excluded = len(sentences) - len(candidates)
    print(f"{len(sentences)} clips, {excluded} excluded for corrupted or empty references, {len(candidates)} usable")

    needed = args.dev + args.validation
    if len(candidates) < needed:
        print(f"Not enough usable clips for {needed}", file=sys.stderr)
        return 1
    chosen = random.Random(args.seed).sample(candidates, needed)

    clips_dir = args.out / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for rank, index in enumerate(chosen):
        item = audio[index]
        suffix = Path(item["path"] or "clip.wav").suffix or ".wav"
        name = f"wo_{index:05d}{suffix}"
        (clips_dir / name).write_bytes(item["bytes"])
        rows.append({
            "id": f"alffa_wo_{index:05d}", "audio_path": f"clips/{name}", "category": "wo",
            "reference": sentences[index].strip(), "split": "dev" if rank < args.dev else "validation",
            "synthetic": 0, "rights": RIGHTS, "speaker": "", "context": "ALFFA read speech (test split)",
        })

    manifest = args.out / "manifest.csv"
    with manifest.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"Manifest: {manifest} ({args.dev} dev, {args.validation} validation, seed {args.seed})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
