import numpy as np
import pytest

from app.language.classifier import ClassifierDetector, LinearLanguageClassifier, to_features, train

LANGUAGES = ("aa", "bb", "cc", "dd")


def make_vectors(rng, dominant: str, n: int):
    """Fake Whisper vectors: most of the mass on `dominant`, noise elsewhere."""
    rows = []
    for _ in range(n):
        noise = rng.dirichlet(np.ones(len(LANGUAGES)) * 0.3)
        mass = 0.6 + 0.3 * rng.random()
        vector = noise * (1 - mass)
        vector[LANGUAGES.index(dominant)] += mass
        rows.append(vector / vector.sum())
    return np.array(rows)


def dataset(seed=0):
    rng = np.random.default_rng(seed)
    # 'wo' is the label whose evidence is a spread over "other" languages (cc, dd), like Whisper on Wolof
    xs = np.vstack([make_vectors(rng, "aa", 60), make_vectors(rng, "bb", 60), make_vectors(rng, "cc", 60)])
    ys = ["fr"] * 60 + ["en"] * 60 + ["wo"] * 60
    return np.log(xs + 1e-6), ys


def test_training_separates_classes_it_was_given():
    features, labels = dataset(0)
    model = train(features, labels, LANGUAGES)
    test_features, test_labels = dataset(1)
    predicted = model.predict_proba_matrix(test_features).argmax(axis=1)
    accuracy = np.mean([model.labels[p] == y for p, y in zip(predicted, test_labels, strict=True)])
    assert accuracy > 0.95


def test_training_is_deterministic():
    features, labels = dataset(0)
    a, b = train(features, labels, LANGUAGES), train(features, labels, LANGUAGES)
    assert np.array_equal(a.weights, b.weights)


def test_probabilities_are_a_distribution_and_a_dict_input_works():
    features, labels = dataset(0)
    model = train(features, labels, LANGUAGES)
    guess = model.predict_proba({"aa": 0.9, "bb": 0.05, "cc": 0.03, "dd": 0.02})
    assert set(guess) == {"fr", "en", "wo"}
    assert sum(guess.values()) == pytest.approx(1.0)
    assert max(guess, key=guess.get) == "fr"


def test_a_language_missing_from_the_vector_does_not_break_prediction():
    features, labels = dataset(0)
    model = train(features, labels, LANGUAGES)
    guess = model.predict_proba({"aa": 1.0})
    assert sum(guess.values()) == pytest.approx(1.0)


def test_class_balancing_stops_a_large_class_from_swallowing_a_small_one():
    rng = np.random.default_rng(3)
    xs = np.vstack([make_vectors(rng, "aa", 400), make_vectors(rng, "cc", 20)])
    ys = ["fr"] * 400 + ["wo"] * 20
    features = np.log(xs + 1e-6)
    balanced = train(features, ys, LANGUAGES, balance_classes=True)
    wo_rows = features[400:]
    recall = np.mean(balanced.predict_proba_matrix(wo_rows).argmax(axis=1) == balanced.labels.index("wo"))
    assert recall > 0.9


def test_a_saved_classifier_gives_identical_predictions(tmp_path):
    features, labels = dataset(0)
    model = train(features, labels, LANGUAGES)
    model.save(tmp_path / "lid.json")
    loaded = LinearLanguageClassifier.load(tmp_path / "lid.json")
    assert np.allclose(model.predict_proba_matrix(features), loaded.predict_proba_matrix(features))
    assert loaded.languages == LANGUAGES and loaded.labels == model.labels


def test_an_unknown_file_format_is_refused(tmp_path):
    (tmp_path / "bad.json").write_text('{"format": 99}', encoding="utf-8")
    with pytest.raises(ValueError):
        LinearLanguageClassifier.load(tmp_path / "bad.json")


class FakeExtractor:
    def __init__(self, vector):
        self.vector_value = vector

    def vector(self, samples):
        return self.vector_value


def test_the_detector_has_no_opinion_when_the_window_is_too_short_to_identify():
    features, labels = dataset(0)
    model = train(features, labels, LANGUAGES)
    assert ClassifierDetector(FakeExtractor({}), model).detect(np.zeros(100, dtype=np.float32)) == {}
    guess = ClassifierDetector(FakeExtractor({"aa": 0.95, "bb": 0.05}), model).detect(np.zeros(100, dtype=np.float32))
    assert max(guess, key=guess.get) == "fr"


def test_features_are_log_probabilities_in_the_fixed_language_order():
    row = to_features({"bb": 0.5, "aa": 0.25}, LANGUAGES)
    assert row[0] == pytest.approx(np.log(0.25 + 1e-6)) and row[1] == pytest.approx(np.log(0.5 + 1e-6))
    assert row[2] == pytest.approx(np.log(1e-6))
