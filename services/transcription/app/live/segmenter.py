"""Splits a continuous 16 kHz mono PCM stream into utterances at silences. Pure: no models, no I/O.

Utterances never overlap and no sample of speech is dropped or repeated, so concatenating the
transcripts of consecutive utterances cannot duplicate or lose words (docs/api-contracts.md).
Only long stretches of non-speech are discarded.
"""
import math
from array import array
from collections import deque
from dataclasses import dataclass

SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2
FRAME_SAMPLES = 320  # 20 ms analysis frames
FRAME_BYTES = FRAME_SAMPLES * BYTES_PER_SAMPLE
FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE


@dataclass(frozen=True)
class SegmenterConfig:
    speech_rms: float = 0.012  # normalised amplitude in [0, 1]; about -38 dBFS
    min_speech_seconds: float = 0.12  # shorter bursts (clicks, bumps) never become an utterance
    endpoint_silence_seconds: float = 0.7
    max_utterance_seconds: float = 15.0
    # A silence only ends an utterance once it is this long: longer passages let the language be read reliably
    # (language routing). 0 keeps the default behaviour: every pause ends the utterance.
    min_utterance_seconds: float = 0.0
    partial_interval_seconds: float = 2.0
    cut_search_seconds: float = 2.0  # where to look for the quietest point of a forced cut
    pre_roll_seconds: float = 0.2  # kept before the first loud frame so word onsets are not clipped
    tail_silence_seconds: float = 0.3  # trailing silence kept on a finished utterance


@dataclass(frozen=True)
class Utterance:
    utterance_id: int
    pcm: bytes
    start_seconds: float
    end_seconds: float


def frame_rms(frame: bytes) -> float:
    samples = array("h")
    samples.frombytes(frame)
    if not samples:
        return 0.0
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples)) / 32768.0


class UtteranceSegmenter:
    def __init__(self, config: SegmenterConfig | None = None) -> None:
        self.config = config or SegmenterConfig()
        self._carry = b""
        self._frames_seen = 0  # frames consumed so far, for timestamps
        self._pre_roll: deque[tuple[int, bytes, float]] = deque(
            maxlen=max(1, round(self.config.pre_roll_seconds / FRAME_SECONDS))
        )
        self._frames: list[tuple[bytes, float]] = []  # (pcm, rms) of the utterance being built
        self._first_frame_index = 0
        self._silence_run = 0
        self._speech_frames = 0
        self._next_id = 1
        self._utterance_id: int | None = None  # set once the utterance is confirmed as speech
        self._frames_at_last_partial = 0

    # -- public ---------------------------------------------------------------------------------------

    @property
    def total_seconds(self) -> float:
        """Audio time received so far (whole frames only)."""
        return self._frames_seen * FRAME_SECONDS

    def feed(self, pcm: bytes) -> list[Utterance]:
        """Consume audio; return the utterances that just ended."""
        data = self._carry + pcm
        usable = len(data) - len(data) % FRAME_BYTES
        self._carry = data[usable:]
        finished: list[Utterance] = []
        for offset in range(0, usable, FRAME_BYTES):
            finished.extend(self._on_frame(data[offset:offset + FRAME_BYTES]))
        return finished

    def due_partial(self) -> Utterance | None:
        """The utterance in progress, if enough new audio arrived since the last partial."""
        if self._utterance_id is None:
            return None
        since = (len(self._frames) - self._frames_at_last_partial) * FRAME_SECONDS
        if since < self.config.partial_interval_seconds:
            return None
        self._frames_at_last_partial = len(self._frames)
        return self._snapshot()

    def flush(self) -> list[Utterance]:
        """End of stream: finish the utterance in progress (a trailing partial frame is padded)."""
        finished: list[Utterance] = []
        if self._carry:
            padded = self._carry + b"\x00" * (FRAME_BYTES - len(self._carry))
            self._carry = b""
            finished.extend(self._on_frame(padded))
        if self._utterance_id is not None:
            finished.append(self._finish(len(self._frames)))
        self._reset_utterance()
        return finished

    # -- internals ------------------------------------------------------------------------------------

    def _on_frame(self, frame: bytes) -> list[Utterance]:
        rms = frame_rms(frame)
        index = self._frames_seen
        self._frames_seen += 1
        loud = rms >= self.config.speech_rms

        if not self._frames:
            if not loud:
                self._pre_roll.append((index, frame, rms))
                return []
            # First loud frame: the utterance starts with the pre-roll that preceded it.
            self._first_frame_index = self._pre_roll[0][0] if self._pre_roll else index
            self._frames = [(pcm, level) for _i, pcm, level in self._pre_roll]
            self._pre_roll.clear()

        self._frames.append((frame, rms))
        if loud:
            self._silence_run = 0
            self._speech_frames += 1
        else:
            self._silence_run += 1

        if self._utterance_id is None and self._speech_frames * FRAME_SECONDS >= self.config.min_speech_seconds:
            self._utterance_id = self._next_id
            self._next_id += 1

        finished: list[Utterance] = []
        long_enough = len(self._frames) * FRAME_SECONDS >= self.config.min_utterance_seconds
        if self._silence_run * FRAME_SECONDS >= self.config.endpoint_silence_seconds and (
            long_enough or self._utterance_id is None
        ):
            if self._utterance_id is not None:
                finished.append(self._finish(len(self._frames)))
            self._reset_utterance()
        elif len(self._frames) * FRAME_SECONDS >= self.config.max_utterance_seconds and self._utterance_id is not None:
            finished.append(self._finish(self._quietest_cut()))
        return finished

    def _quietest_cut(self) -> int:
        """Frame count to keep in the finished utterance: cut after the quietest recent frame."""
        window = max(1, round(self.config.cut_search_seconds / FRAME_SECONDS))
        start = max(1, len(self._frames) - window)
        quietest = min(range(start, len(self._frames)), key=lambda i: self._frames[i][1])
        return quietest + 1

    def _finish(self, keep_frames: int) -> Utterance:
        """Emit the first `keep_frames` frames; anything after them starts the next utterance."""
        kept = self._frames[:keep_frames]
        remainder = self._frames[keep_frames:]
        first_index = self._first_frame_index

        # Trim long trailing silence (only ever non-speech) but keep a short tail.
        tail = max(1, round(self.config.tail_silence_seconds / FRAME_SECONDS))
        last_loud = max((i for i, (_f, level) in enumerate(kept) if level >= self.config.speech_rms), default=-1)
        trimmed = kept[:last_loud + 1 + tail]
        utterance = Utterance(
            utterance_id=self._utterance_id if self._utterance_id is not None else 0,
            pcm=b"".join(frame for frame, _level in trimmed),
            start_seconds=first_index * FRAME_SECONDS,
            end_seconds=(first_index + len(trimmed)) * FRAME_SECONDS,
        )

        self._reset_utterance()
        if remainder:
            # Forced cut: the rest continues as a new utterance, without overlap and without loss.
            self._frames = remainder
            self._first_frame_index = first_index + keep_frames
            self._speech_frames = sum(1 for _f, level in remainder if level >= self.config.speech_rms)
            self._silence_run = 0
            for _f, level in reversed(remainder):
                if level >= self.config.speech_rms:
                    break
                self._silence_run += 1
            if self._speech_frames * FRAME_SECONDS >= self.config.min_speech_seconds:
                self._utterance_id = self._next_id
                self._next_id += 1
        return utterance

    def _snapshot(self) -> Utterance:
        assert self._utterance_id is not None
        return Utterance(
            utterance_id=self._utterance_id,
            pcm=b"".join(frame for frame, _level in self._frames),
            start_seconds=self._first_frame_index * FRAME_SECONDS,
            end_seconds=(self._first_frame_index + len(self._frames)) * FRAME_SECONDS,
        )

    def _reset_utterance(self) -> None:
        self._frames = []
        self._silence_run = 0
        self._speech_frames = 0
        self._utterance_id = None
        self._frames_at_last_partial = 0
