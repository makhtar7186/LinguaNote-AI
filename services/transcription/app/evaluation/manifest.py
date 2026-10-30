"""Evaluation corpus manifest: one CSV row per audio clip, validated before any model runs."""
import csv
from dataclasses import dataclass
from pathlib import Path

CATEGORIES = ("fr", "en", "wo", "mixed", "silence")
SPLITS = ("dev", "validation")
REQUIRED_COLUMNS = ("id", "audio_path", "category", "reference", "split", "synthetic", "rights")
# Expected language of the clip when it is a single language; mixed and silence have none.
EXPECTED_LANGUAGE = {"fr": "fr", "en": "en", "wo": "wo"}


class ManifestError(ValueError):
    """Raised with every problem found, so a corpus can be fixed in one pass."""


@dataclass(frozen=True)
class CorpusItem:
    id: str
    audio_path: Path
    category: str
    reference: str
    split: str
    synthetic: bool
    rights: str
    speaker: str = ""
    context: str = ""

    @property
    def expected_language(self) -> str | None:
        return EXPECTED_LANGUAGE.get(self.category)


def _parse_bool(value: str) -> bool | None:
    lowered = value.strip().lower()
    if lowered in ("1", "true", "yes", "oui"):
        return True
    if lowered in ("0", "false", "no", "non", ""):
        return False
    return None


def load_manifest(path: Path, *, split: str | None = None) -> list[CorpusItem]:
    """Validate the WHOLE manifest (a bad row in another split still fails), then filter by split.

    `silence` is a label: the loader cannot tell whether the audio really is silent.
    """
    path = Path(path)
    corpus_root = path.parent.resolve()
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        missing = [column for column in REQUIRED_COLUMNS if column not in (reader.fieldnames or [])]
        if missing:
            raise ManifestError(f"Missing columns: {', '.join(missing)}")
        rows = list(reader)

    problems: list[str] = []
    items: list[CorpusItem] = []
    seen: set[str] = set()
    for number, row in enumerate(rows, start=2):  # row 1 is the header
        where = f"line {number}"
        problems_before = len(problems)
        item_id = (row["id"] or "").strip()
        if not item_id:
            problems.append(f"{where}: empty id")
            continue
        if item_id in seen:
            problems.append(f"{where}: duplicate id '{item_id}'")
        seen.add(item_id)

        category = (row["category"] or "").strip()
        if category not in CATEGORIES:
            problems.append(f"{where} ({item_id}): category must be one of {', '.join(CATEGORIES)}")
        if (row["split"] or "").strip() not in SPLITS:
            problems.append(f"{where} ({item_id}): split must be one of {', '.join(SPLITS)}")
        synthetic = _parse_bool(row["synthetic"] or "")
        if synthetic is None:
            problems.append(f"{where} ({item_id}): synthetic must be 0 or 1")
        reference = (row["reference"] or "").strip()
        if category == "silence" and reference:
            problems.append(f"{where} ({item_id}): a silence clip must have an empty reference")
        if category in ("fr", "en", "wo", "mixed") and not reference:
            problems.append(f"{where} ({item_id}): empty reference")
        rights = (row["rights"] or "").strip()
        if not rights:
            problems.append(f"{where} ({item_id}): rights/consent must be stated")

        audio = (corpus_root / (row["audio_path"] or "").strip()).resolve()
        if not audio.is_relative_to(corpus_root):
            # Absolute paths and '..' would let a shared manifest point at arbitrary local files.
            problems.append(f"{where} ({item_id}): audio_path must stay inside the manifest folder")
        elif not audio.is_file():
            problems.append(f"{where} ({item_id}): audio file not found: {row['audio_path']}")

        if len(problems) == problems_before:
            items.append(CorpusItem(
                id=item_id, audio_path=audio, category=category, reference=reference,
                split=(row["split"] or "").strip(), synthetic=bool(synthetic), rights=rights,
                speaker=(row.get("speaker") or "").strip(), context=(row.get("context") or "").strip(),
            ))

    if problems:
        raise ManifestError("\n".join(problems))
    return [item for item in items if split is None or item.split == split]
