"""Cuts audio into language-homogeneous chunks, numbered in time order.

Steps: (1) a language guess per sliding window, silent windows skipped; (2) a Viterbi smoothing that pays a penalty
per language switch, so a single doubtful window cannot flip the language; (3) spans too short to be a real language
change are absorbed by their neighbour; (4) each boundary is moved to the quietest instant nearby so a word is not cut.

The chunks cover the whole audio without gap or overlap: no sample is lost or transcribed twice, whatever the labels.
"""
import math
from dataclasses import dataclass

import numpy as np

from app.language.detector import SAMPLE_RATE, LanguageDetector

UNKNOWN = "unknown"
_EPSILON = 1e-4  # a label missing from a guess is unlikely, not impossible


@dataclass(frozen=True)
class SegmentationConfig:
    window_seconds: float = 3.0
    hop_seconds: float = 1.5
    # In nats, paid per switch. A language island costs two switches, so it needs about two windows of evidence
    # (two windows at 85 % confidence are worth 3.5 nats): an isolated doubtful window cannot flip the language.
    # To be calibrated on real detector output (see docs/evaluation-results.md), not a universal value.
    switch_penalty: float = 1.5
    min_span_seconds: float = 2.0  # shorter spans are merged into a neighbour
    snap_seconds: float = 0.6  # how far a boundary may move to find a quiet instant
    # Windows quieter than this carry no language information. Deliberately close to digital silence (about -66 dBFS):
    # speech levels vary by 50x between recordings (measured on FLEURS and ALFFA clips, whose speech sits around 0.001
    # to 0.05 RMS), so a higher absolute threshold turns quiet speech into "silence" and the previous language runs on.
    silence_rms: float = 0.0005
    frame_seconds: float = 0.02


@dataclass(frozen=True)
class Chunk:
    index: int  # position in time order: the key used to reassemble the text
    start_seconds: float
    end_seconds: float
    label: str
    confidence: float  # mean probability of the label over the chunk's windows; an estimate

    @property
    def duration(self) -> float:
        return self.end_seconds - self.start_seconds


def _rms(samples: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(samples)))) if samples.size else 0.0


def smooth(guesses: list[dict[str, float] | None], labels: list[str], switch_penalty: float) -> list[str | None]:
    """Most likely label sequence with a cost per switch. `None` guesses (silence) keep the previous label for free."""
    if not labels:
        return [None] * len(guesses)
    cost = {label: 0.0 for label in labels}
    back: list[dict[str, str]] = []
    for guess in guesses:
        new_cost, pointers = {}, {}
        for label in labels:
            stay = cost[label]
            best_other = min(((cost[other], other) for other in labels if other != label), default=(math.inf, label))
            switch = best_other[0] + switch_penalty
            previous = label if stay <= switch else best_other[1]
            emission = 0.0 if guess is None else -math.log(max(guess.get(label, 0.0), _EPSILON))
            new_cost[label] = min(stay, switch) + emission
            pointers[label] = previous
        cost = new_cost
        back.append(pointers)
    label = min(cost, key=cost.get)
    path = [label]
    for pointers in reversed(back[1:]):
        label = pointers[label]
        path.append(label)
    path.reverse()
    return path


def _merge_short(spans: list[list], min_seconds: float) -> list[list]:
    """spans: [start, end, label, confidence_sum, weight]. Merges the shortest too-short span into a neighbour."""
    while len(spans) > 1:
        shortest = min(range(len(spans)), key=lambda i: spans[i][1] - spans[i][0])
        if spans[shortest][1] - spans[shortest][0] >= min_seconds:
            break
        neighbours = [i for i in (shortest - 1, shortest + 1) if 0 <= i < len(spans)]
        target = max(neighbours, key=lambda i: spans[i][1] - spans[i][0])
        low, high = sorted((shortest, target))
        merged = [spans[low][0], spans[high][1], spans[target][2], 0.0, 0.0]
        merged[3] = spans[target][3] + (spans[shortest][3] if spans[shortest][2] == spans[target][2] else 0.0)
        merged[4] = spans[target][4] + (spans[shortest][4] if spans[shortest][2] == spans[target][2] else 0.0)
        spans[low:high + 1] = [merged]
        # neighbours with the same label now touch: fuse them
        fused = [spans[0]]
        for span in spans[1:]:
            if span[2] == fused[-1][2]:
                fused[-1] = [fused[-1][0], span[1], span[2], fused[-1][3] + span[3], fused[-1][4] + span[4]]
            else:
                fused.append(span)
        spans[:] = fused
    return spans


def _quietest_point(
    samples: np.ndarray, centre: float, config: SegmentationConfig, lower: float, upper: float,
) -> float:
    frame = max(1, int(config.frame_seconds * SAMPLE_RATE))
    first = max(lower, centre - config.snap_seconds)
    last = min(upper, centre + config.snap_seconds)
    start, stop = int(first * SAMPLE_RATE), int(last * SAMPLE_RATE)
    if stop - start < 2 * frame:
        return centre
    best_energy, best_position = math.inf, centre
    for begin in range(start, stop - frame, frame):
        energy = _rms(samples[begin:begin + frame])
        # a tie goes to the instant closest to the original boundary
        if energy < best_energy - 1e-12 or (abs(energy - best_energy) <= 1e-12
                                            and abs(begin / SAMPLE_RATE - centre) < abs(best_position - centre)):
            best_energy, best_position = energy, (begin + frame / 2) / SAMPLE_RATE
    return best_position


def segment_by_language(
    samples: np.ndarray, detector: LanguageDetector, config: SegmentationConfig | None = None,
) -> list[Chunk]:
    """Language-homogeneous chunks covering `samples` entirely, in time order. Empty audio gives no chunk."""
    config = config or SegmentationConfig()
    total = len(samples) / SAMPLE_RATE
    if total <= 0:
        return []
    window, hop = int(config.window_seconds * SAMPLE_RATE), int(config.hop_seconds * SAMPLE_RATE)
    starts = list(range(0, max(1, len(samples) - window + hop), hop)) if len(samples) > window else [0]

    guesses: list[dict[str, float] | None] = []
    for begin in starts:
        piece = samples[begin:begin + window]
        guesses.append(None if _rms(piece) < config.silence_rms else detector.detect(piece))
    labels = sorted({label for guess in guesses if guess for label in guess})
    if not labels:  # nothing but silence: one chunk, no language claimed
        return [Chunk(0, 0.0, total, UNKNOWN, 0.0)]

    path = smooth(guesses, labels, config.switch_penalty)
    # leading silent windows take the first decided label
    first_label = next(label for label in path if label is not None)
    path = [label or first_label for label in path]

    # window i is trusted for the hop around its centre; adjacent windows meet in the middle of their overlap
    centres = [(begin + window / 2) / SAMPLE_RATE for begin in starts]
    edges = [0.0] + [(a + b) / 2 for a, b in zip(centres, centres[1:], strict=False)] + [total]
    spans: list[list] = []
    for i, label in enumerate(path):
        probability = guesses[i].get(label, 0.0) if guesses[i] else 0.0
        weight = 1.0 if guesses[i] else 0.0
        if spans and spans[-1][2] == label:
            spans[-1][1] = edges[i + 1]
            spans[-1][3] += probability
            spans[-1][4] += weight
        else:
            spans.append([edges[i], edges[i + 1], label, probability, weight])
    spans = _merge_short(spans, config.min_span_seconds)

    # move each internal boundary to the quietest nearby instant, never across a neighbouring boundary
    boundaries = [0.0] + [span[1] for span in spans[:-1]] + [total]
    for k in range(1, len(boundaries) - 1):
        boundaries[k] = _quietest_point(
            samples, boundaries[k], config, boundaries[k - 1] + 0.1, boundaries[k + 1] - 0.1,
        )

    return [
        Chunk(index, boundaries[index], boundaries[index + 1], span[2], (span[3] / span[4]) if span[4] else 0.0)
        for index, span in enumerate(spans)
    ]
