"""A small multinomial logistic regression over Whisper's language-probability vector.

Pure numpy (no new runtime dependency); the trained weights are a small JSON file. The classifier answers "which of the
labels I was trained on is this window closest to", which is what the router needs. It is an estimate: it can only be
trusted for the labels, voices and recording conditions it was measured on (docs/evaluation-results.md).
"""
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.language.detector import LanguageGuess

_FLOOR = 1e-6


def to_features(vector: dict[str, float], languages: tuple[str, ...]) -> np.ndarray:
    """log-probabilities in a fixed language order (a language missing from the vector counts as ~0)."""
    return np.log(np.array([vector.get(language, 0.0) for language in languages], dtype=np.float64) + _FLOOR)


@dataclass(frozen=True)
class LinearLanguageClassifier:
    languages: tuple[str, ...]  # the input features, in order
    labels: tuple[str, ...]  # the outputs
    mean: np.ndarray
    scale: np.ndarray
    weights: np.ndarray  # (len(languages), len(labels))
    bias: np.ndarray

    def predict_proba_matrix(self, features: np.ndarray) -> np.ndarray:
        scores = ((features - self.mean) / self.scale) @ self.weights + self.bias
        scores -= scores.max(axis=1, keepdims=True)
        exp = np.exp(scores)
        return exp / exp.sum(axis=1, keepdims=True)

    def predict_proba(self, vector: dict[str, float]) -> LanguageGuess:
        row = self.predict_proba_matrix(to_features(vector, self.languages)[None, :])[0]
        return {label: float(p) for label, p in zip(self.labels, row, strict=True)}

    def save(self, path: Path) -> None:
        payload = {
            "format": 1, "languages": list(self.languages), "labels": list(self.labels),
            "mean": self.mean.tolist(), "scale": self.scale.tolist(),
            "weights": self.weights.tolist(), "bias": self.bias.tolist(),
        }
        Path(path).write_text(json.dumps(payload), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "LinearLanguageClassifier":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if data.get("format") != 1:
            raise ValueError("Unsupported language classifier file.")
        return cls(
            tuple(data["languages"]), tuple(data["labels"]), np.array(data["mean"]), np.array(data["scale"]),
            np.array(data["weights"]), np.array(data["bias"]),
        )


def train(
    features: np.ndarray, labels: list[str], languages: tuple[str, ...], *, l2: float = 1.0, epochs: int = 600,
    learning_rate: float = 0.1, balance_classes: bool = True,
) -> LinearLanguageClassifier:
    """Full-batch gradient descent on the regularised cross-entropy. Deterministic (no randomness)."""
    classes = tuple(sorted(set(labels)))
    index = np.array([classes.index(label) for label in labels])
    mean, scale = features.mean(axis=0), features.std(axis=0) + 1e-6
    x = (features - mean) / scale
    n, d = x.shape
    targets = np.zeros((n, len(classes)))
    targets[np.arange(n), index] = 1.0
    counts = np.bincount(index, minlength=len(classes)).astype(np.float64)
    sample_weight = (n / (len(classes) * counts))[index] if balance_classes else np.ones(n)
    weights, bias = np.zeros((d, len(classes))), np.zeros(len(classes))
    for _ in range(epochs):
        scores = x @ weights + bias
        scores -= scores.max(axis=1, keepdims=True)
        exp = np.exp(scores)
        probabilities = exp / exp.sum(axis=1, keepdims=True)
        error = (probabilities - targets) * sample_weight[:, None] / n
        weights -= learning_rate * (x.T @ error + l2 * weights / n)
        bias -= learning_rate * error.sum(axis=0)
    return LinearLanguageClassifier(languages, classes, mean, scale, weights, bias)


class ClassifierDetector:
    """LanguageDetector made of a Whisper feature extractor and a trained classifier."""

    def __init__(self, extractor, classifier: LinearLanguageClassifier) -> None:
        self._extractor = extractor
        self._classifier = classifier

    def detect(self, samples: np.ndarray) -> LanguageGuess:
        vector = self._extractor.vector(samples)
        # Too short to identify: no opinion, so the smoothing keeps the language it already had.
        return self._classifier.predict_proba(vector) if vector else {}
