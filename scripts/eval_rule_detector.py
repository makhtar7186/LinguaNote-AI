"""Measures the rule 'French or English if Whisper is confident, otherwise Wolof' on the stored language vectors.

Developer tool (service environment, repository root; needs data/lid/features-tiny.npz from extract_lid_features.py):

    services/transcription/.venv/Scripts/python -X utf8 scripts/eval_rule_detector.py

The threshold is chosen on the `dev` windows and judged on the held-out `validation` windows, as for the trained
classifier, which is printed last for comparison. The 'renormalised' variant (Whisper restricted to French and English)
is measured too because it is the literal reading of "detect only two languages"; it is much worse.
"""
import sys

import numpy as np

sys.path.insert(0, "services/transcription")
from app.language.classifier import LinearLanguageClassifier  # noqa: E402

d = np.load("data/lid/features-tiny.npz", allow_pickle=False)
x, y, split, corpus = d["features"].astype(np.float64), d["label"], d["split"], d["corpus"]
langs = [str(s) for s in d["languages"]]
fr, en = langs.index("fr"), langs.index("en")
dev, val = split == "dev", split == "validation"


def rule(features, threshold, renormalise):
    p_fr, p_en = features[:, fr], features[:, en]
    best = np.where(p_fr >= p_en, "fr", "en")
    score = np.maximum(p_fr, p_en)
    if renormalise:  # probability of the better of the two among fr+en only
        score = score / np.maximum(p_fr + p_en, 1e-9)
    return np.where(score >= threshold, best, "wo")


def accuracy(pred, truth):
    per = {k: float(np.mean(pred[truth == k] == k)) for k in ("fr", "en", "wo")}
    return float(np.mean(pred == truth)), per


print(f"windows: dev {dev.sum()}  validation {val.sum()}  (wo/fr/en in validation: "
      f"{[(k, int(((y == k) & val).sum())) for k in ('wo', 'fr', 'en')]})")
for renorm in (False, True):
    name = "restricted to fr+en (renormalised)" if renorm else "raw probability of fr or en"
    best_t, best_acc = None, -1.0
    for t in np.arange(0.05, 0.99, 0.01):
        acc = accuracy(rule(x[dev], t, renorm), y[dev])[0]
        if acc > best_acc:
            best_t, best_acc = float(t), acc
    acc, per = accuracy(rule(x[val], best_t, renorm), y[val])
    print(f"\nRULE {name}: threshold {best_t:.2f} chosen on dev (dev acc {best_acc:.1%})")
    print(f"  validation accuracy {acc:.1%}; per language " + ", ".join(f"{k} {v:.1%}" for k, v in per.items()))
    for c in sorted(set(corpus)):
        sel = val & (corpus == c)
        a, p = accuracy(rule(x[sel], best_t, renorm), y[sel])
        print(f"  validation {c}: {a:.1%} " + ", ".join(f"{k} {v:.1%}" for k, v in p.items() if np.any(y[sel] == k)))
    # cross-corpus for the Wolof side: threshold chosen without one corpus's wolof
    for train_c, test_c in (("fleurs", "alffa_wolof"), ("alffa_wolof", "fleurs")):
        rows = ((corpus == train_c) | (y != "wo")) & dev
        bt, ba = None, -1
        for t in np.arange(0.05, 0.99, 0.01):
            a = accuracy(rule(x[rows], t, renorm), y[rows])[0]
            if a > ba:
                bt, ba = float(t), a
        sel = (corpus == test_c) & (y == "wo")
        print(f"  cross-corpus (threshold from {train_c}) -> wolof of {test_c}: {np.mean(rule(x[sel], bt, renorm) == 'wo'):.1%} (t={bt:.2f})")

# The trained classifier on the same validation windows, for reference.
logx = np.log(x + 1e-6)
sys.path.insert(0, "services/transcription")
clf = LinearLanguageClassifier.load("data/lid/classifier-tiny-devonly.json")
pred = np.array(clf.labels)[clf.predict_proba_matrix(logx[val]).argmax(axis=1)]
acc, per = accuracy(pred, y[val])
print(f"\nTRAINED CLASSIFIER (dev only), same validation windows: {acc:.1%}; " + ", ".join(f"{k} {v:.1%}" for k, v in per.items()))
