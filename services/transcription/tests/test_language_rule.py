import numpy as np
import pytest

from app.language.rule import FrenchEnglishElseWolofDetector

WINDOW = np.zeros(48000, dtype=np.float32)


class FakeExtractor:
    def __init__(self, vector):
        self.vector_value = vector

    def vector(self, samples):
        return self.vector_value


def decide(vector, **kwargs):
    guess = FrenchEnglishElseWolofDetector(FakeExtractor(vector), **kwargs).detect(WINDOW)
    return max(guess, key=guess.get), guess


def test_a_confident_french_window_is_french():
    label, guess = decide({"fr": 0.97, "en": 0.01, "ar": 0.02})
    assert label == "fr" and guess["fr"] > 0.9


def test_a_confident_english_window_is_english():
    assert decide({"fr": 0.02, "en": 0.95, "sw": 0.03})[0] == "en"


def test_a_window_where_neither_is_confident_goes_to_wolof():
    # Whisper has no Wolof label: on Wolof it spreads its belief over other languages (here ar, sw, fr, id)
    label, guess = decide({"ar": 0.30, "sw": 0.25, "fr": 0.20, "id": 0.15, "en": 0.02})
    assert label == "wo" and guess["wo"] > 0.9


def test_the_threshold_is_the_decision_point():
    below, _ = decide({"fr": 0.70, "ar": 0.30}, threshold=0.77)
    above, _ = decide({"fr": 0.80, "ar": 0.20}, threshold=0.77)
    assert (below, above) == ("wo", "fr")
    assert decide({"fr": 0.70, "ar": 0.30}, threshold=0.5)[0] == "fr"  # a lower threshold accepts it


def test_the_probabilities_are_a_distribution_with_a_soft_edge():
    _, at_threshold = decide({"fr": 0.77, "ar": 0.23}, threshold=0.77)
    assert sum(at_threshold.values()) == pytest.approx(1.0)
    assert at_threshold["wo"] == pytest.approx(0.5)  # exactly undecided at the threshold, not a hard 0/1


def test_a_window_too_short_to_identify_gives_no_opinion():
    assert FrenchEnglishElseWolofDetector(FakeExtractor({}), 0.77).detect(WINDOW) == {}


@pytest.mark.parametrize("threshold", [0.0, 1.0, -0.2, 1.5])
def test_a_threshold_outside_the_open_unit_interval_is_refused(threshold):
    with pytest.raises(ValueError):
        FrenchEnglishElseWolofDetector(FakeExtractor({}), threshold)


def test_the_steepness_must_be_positive():
    with pytest.raises(ValueError):
        FrenchEnglishElseWolofDetector(FakeExtractor({}), 0.77, steepness=0.0)
