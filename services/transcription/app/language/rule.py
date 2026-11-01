"""A detector made of one rule instead of a trained model: French or English when Whisper is confident it hears one
of them, Wolof otherwise.

It needs no training data and no classifier file. It rests on a measured fact (docs/evaluation-wolof.md): Whisper has
no Wolof label, so on Wolof it is never confident about French or English. Its weakness is the mirror image: French
or English that Whisper is NOT confident about (noise, a short window, an accent) is sent to the Wolof model. The
threshold was tuned on read speech only and moved a lot between corpora (0.54 to 0.77); treat it as a setting to
re-measure on your own audio, not as a constant.
"""
import math

from app.language.detector import LanguageGuess


class FrenchEnglishElseWolofDetector:
    def __init__(self, extractor, threshold: float = 0.77, steepness: float = 20.0) -> None:
        if not 0.0 < threshold < 1.0:
            raise ValueError("The threshold must be strictly between 0 and 1.")
        if steepness <= 0.0:
            raise ValueError("The steepness must be positive.")
        self._extractor = extractor
        self._threshold = threshold
        self._steepness = steepness  # sharpness of the soft transition: the smoothing needs a gradient, not 0/1

    def detect(self, samples) -> LanguageGuess:
        vector = self._extractor.vector(samples)
        if not vector:  # too short to identify: no opinion, the smoothing keeps the language it already had
            return {}
        french, english = vector.get("fr", 0.0), vector.get("en", 0.0)
        label, confidence = ("fr", french) if french >= english else ("en", english)
        wolof = 1.0 / (1.0 + math.exp(self._steepness * (confidence - self._threshold)))  # 0.5 exactly at the threshold
        return {label: 1.0 - wolof, "wo": wolof}
