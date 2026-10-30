"""Synthetic PCM helpers shared by the live-transcription tests."""
import math
from array import array

from app.live.segmenter import SAMPLE_RATE


def tone(seconds: float, amplitude: float = 0.2) -> bytes:
    count = int(SAMPLE_RATE * seconds)
    samples = array("h", (int(amplitude * 32767 * math.sin(2 * math.pi * 220 * i / SAMPLE_RATE)) for i in range(count)))
    return samples.tobytes()


def silence(seconds: float) -> bytes:
    return b"\x00\x00" * int(SAMPLE_RATE * seconds)


def frame(seq: int, pcm: bytes) -> bytes:
    return seq.to_bytes(4, "big") + pcm


def chunks(pcm: bytes, seconds: float = 0.1) -> list[bytes]:
    size = int(SAMPLE_RATE * seconds) * 2
    return [pcm[offset:offset + size] for offset in range(0, len(pcm), size)]
