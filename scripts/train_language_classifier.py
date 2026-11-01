"""Trains and evaluates the Wolof / French / English window classifier from extracted Whisper language vectors.

Developer tool (service environment, repository root):

    set PYTHONPATH=services/transcription
    services/transcription/.venv/Scripts/python scripts/train_language_classifier.py \
        --features data/lid/features-tiny.npz --out data/lid/classifier-tiny.json

Training uses the `dev` rows only; every figure below is computed on the held-out `validation` rows (other clips, never
other crops of a training clip). The cross-corpus check trains on one corpus's Wolof and tests on the other's, which
is the closest thing to "a voice and a recording setup it has not seen" that these data allow.
"""
import argparse
import json
from pathlib import Path

import numpy as np

from app.language.classifier import LinearLanguageClassifier, train

LABELS = ("en", "fr", "wo")


def report(name: str, model: LinearLanguageClassifier, features: np.ndarray, labels: np.ndarray) -> dict:
    probabilities = model.predict_proba_matrix(features)
    predicted = np.array(model.labels)[probabilities.argmax(axis=1)]
    confusion = {truth: {guess: int(np.sum((labels == truth) & (predicted == guess))) for guess in model.labels}
                 for truth in model.labels if np.any(labels == truth)}
    per_class = {truth: float(np.mean(predicted[labels == truth] == truth)) for truth in confusion}
    accuracy = float(np.mean(predicted == labels))
    confident = probabilities.max(axis=1) >= 0.8
    print(f"\n== {name} ({len(labels)} windows) ==")
    print(f"accuracy {accuracy:.1%}; per language: " + ", ".join(f"{k} {v:.1%}" for k, v in per_class.items()))
    print(f"windows with confidence >= 0.8: {confident.mean():.0%}, accuracy there "
          f"{(np.mean(predicted[confident] == labels[confident]) if confident.any() else float('nan')):.1%}")
    print("confusion (rows = truth):")
    for truth, row in confusion.items():
        print(f"  {truth}: " + "  ".join(f"{guess}={count}" for guess, count in row.items()))
    return {"accuracy": accuracy, "per_class": per_class, "confusion": confusion, "windows": int(len(labels))}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--features", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--l2", type=float, default=1.0)
    args = parser.parse_args()

    data = np.load(args.features, allow_pickle=False)
    x, y = data["features"].astype(np.float64), data["label"]
    split, corpus = data["split"], data["corpus"]
    languages = tuple(str(language) for language in data["languages"])
    logx = np.log(x + 1e-6)
    results: dict = {"lid_model": str(data["lid_model"]), "seconds": float(data["seconds"])}

    dev, validation = split == "dev", split == "validation"
    model = train(logx[dev], list(y[dev]), languages, l2=args.l2)
    results["validation_all"] = report("held-out validation, all corpora", model, logx[validation], y[validation])
    for name in sorted(set(corpus)):
        selected = validation & (corpus == name)
        results[f"validation_{name}"] = report(f"held-out validation, {name} only", model, logx[selected], y[selected])

    # Cross-corpus: Wolof of one corpus for training, Wolof of the other for testing (fr/en come from FLEURS only).
    for train_corpus, test_corpus in (("fleurs", "alffa_wolof"), ("alffa_wolof", "fleurs")):
        train_rows = ((corpus == train_corpus) | (y != "wo")) & dev
        cross = train(logx[train_rows], list(y[train_rows]), languages, l2=args.l2)
        test_rows = (corpus == test_corpus) & (y == "wo")
        results[f"cross_{train_corpus}_to_{test_corpus}"] = report(
            f"CROSS-CORPUS: Wolof learnt from {train_corpus}, tested on {test_corpus} Wolof", cross,
            logx[test_rows], y[test_rows])

    final = train(logx[dev | validation], list(y[dev | validation]), languages, l2=args.l2)  # all data, for shipping
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    final.save(Path(args.out))
    # Dev-only copy: the one to use when testing on validation clips (the shipped one has seen them).
    model.save(Path(args.out).with_name(Path(args.out).stem + "-devonly.json"))
    Path(args.out).with_suffix(".report.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    print(f"\nclassifier (trained on dev + validation) -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
