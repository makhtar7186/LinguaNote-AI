"""Text normalisation and error-rate metrics for ASR evaluation. No audio, no models, no I/O."""
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass

_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "`": "'", "´": "'"})
_NON_WORD = re.compile(r"[^\w\s']", re.UNICODE)


def normalize(text: str) -> str:
    """Comparison form: Unicode NFC, lower case, punctuation removed, apostrophes unified.

    Accents are kept on purpose: dropping them would hide real French errors and would equate
    Wolof spellings that a Wolof reviewer may consider distinct. Digits are left untouched, so
    references should spell numbers the way the engine is expected to write them.
    """
    text = unicodedata.normalize("NFC", text).translate(_APOSTROPHES).lower().replace("_", " ")
    text = _NON_WORD.sub(" ", text)
    words = (word.strip("'") for word in text.split())
    return " ".join(word for word in words if word)


@dataclass(frozen=True)
class EditCounts:
    substitutions: int
    deletions: int
    insertions: int
    reference_length: int

    @property
    def errors(self) -> int:
        return self.substitutions + self.deletions + self.insertions

    @property
    def rate(self) -> float | None:
        """errors / reference length; undefined (None) for an empty reference."""
        return self.errors / self.reference_length if self.reference_length else None

    def __add__(self, other: "EditCounts") -> "EditCounts":
        return EditCounts(
            self.substitutions + other.substitutions,
            self.deletions + other.deletions,
            self.insertions + other.insertions,
            self.reference_length + other.reference_length,
        )


EMPTY = EditCounts(0, 0, 0, 0)


def edit_counts(reference: Sequence[str], hypothesis: Sequence[str]) -> EditCounts:
    """Levenshtein alignment split into substitutions, deletions (missed) and insertions (extra).

    The total number of errors is the minimum edit distance and is unambiguous. When several optimal
    alignments exist, the S/D/I split follows the tuple order (total, S, D, I): fewest substitutions,
    then fewest deletions. Compare totals (`errors`) across systems; treat the breakdown as indicative.
    """
    # Each cell: (total, substitutions, deletions, insertions). Two rows keep memory linear.
    previous = [(j, 0, 0, j) for j in range(len(hypothesis) + 1)]
    for i, ref_token in enumerate(reference, start=1):
        current = [(i, 0, i, 0)]
        for j, hyp_token in enumerate(hypothesis, start=1):
            diagonal = previous[j - 1]
            if ref_token == hyp_token:
                candidates = [diagonal]
            else:
                candidates = [(diagonal[0] + 1, diagonal[1] + 1, diagonal[2], diagonal[3])]
            above = previous[j]
            candidates.append((above[0] + 1, above[1], above[2] + 1, above[3]))
            left = current[j - 1]
            candidates.append((left[0] + 1, left[1], left[2], left[3] + 1))
            current.append(min(candidates))
        previous = current
    _total, substitutions, deletions, insertions = previous[-1]
    return EditCounts(substitutions, deletions, insertions, len(reference))


def word_counts(reference: str, hypothesis: str) -> EditCounts:
    return edit_counts(normalize(reference).split(), normalize(hypothesis).split())


def char_counts(reference: str, hypothesis: str) -> EditCounts:
    return edit_counts(list(normalize(reference)), list(normalize(hypothesis)))
