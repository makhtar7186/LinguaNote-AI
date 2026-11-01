"""Language-probability vectors from Whisper's own language identification.

Whisper has no Wolof label, so its top-1 answer is useless for Wolof (it says Swahili, French, Shona...). Its full
probability vector is still informative: a small classifier trained on it can recognise "this looks like none of the
languages I know, in the way Wolof does" (see classifier.py). The same function feeds the training script and the
running service, so the two cannot drift apart.
"""
import numpy as np

from app.language.detector import SAMPLE_RATE


class WhisperLanguageFeatures:
    def __init__(self, model_name: str = "tiny", cpu_threads: int = 4) -> None:
        from faster_whisper import WhisperModel

        self.model_name = model_name
        self._model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=cpu_threads)
        self.languages: tuple[str, ...] = ()

    def vector(self, samples: np.ndarray) -> dict[str, float]:
        """Probability of every language Whisper knows for this window (16 kHz mono float32)."""
        if samples.size < SAMPLE_RATE // 2:  # under half a second there is nothing to identify
            return {}
        _, _, scores = self._model.detect_language(
            audio=samples.astype(np.float32, copy=False), language_detection_segments=1,
        )
        probabilities = {language: float(probability) for language, probability in scores}
        if not self.languages:
            self.languages = tuple(sorted(probabilities))
        return probabilities
