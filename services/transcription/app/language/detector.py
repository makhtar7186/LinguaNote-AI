"""Contract of a window-level language detector.

A detector returns a probability per label for a short window of 16 kHz mono float audio in [-1, 1]. Labels are
plain strings ("fr", "en", "wo", ...): the routing code never assumes a fixed set. A guess is an ESTIMATE, not
proof that the transcription will be correct (docs/evaluation-protocol.md).
"""
from typing import Protocol

import numpy as np

SAMPLE_RATE = 16000

LanguageGuess = dict[str, float]


class LanguageDetector(Protocol):
    def detect(self, samples: np.ndarray) -> LanguageGuess:
        """Probabilities per label for this window (they need not be exhaustive, but must be >= 0)."""
        ...
