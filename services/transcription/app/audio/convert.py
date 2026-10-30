"""Audio conversion and validation. No speech recognition happens here."""
import subprocess
import wave
from pathlib import Path

from app.errors import ApiError


def convert_to_model_wav(
    source: Path, destination: Path, *, ffmpeg: str, max_seconds: float, timeout: int
) -> None:
    """Extract the first audio stream as PCM mono 16 kHz, truncated just past the limit."""
    command = [
        ffmpeg, "-nostdin", "-v", "error",
        "-i", str(source),
        "-map", "0:a:0", "-vn",
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        "-t", str(max_seconds + 0.1),
        "-y", str(destination),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=timeout)
    except FileNotFoundError as exc:
        raise ApiError(503, "ffmpeg_missing", "FFmpeg is required to decode uploaded media.") from exc
    except subprocess.TimeoutExpired as exc:
        raise ApiError(504, "conversion_timeout", f"Audio conversion exceeded {timeout} seconds.") from exc
    except subprocess.CalledProcessError as exc:
        raise ApiError(415, "no_audio_stream", "The file has no decodable audio stream.") from exc


def validate_wav(path: Path, *, max_seconds: float) -> float:
    """Return the duration in seconds, or raise if the WAV is unusable or too long."""
    try:
        with wave.open(str(path), "rb") as audio:
            if audio.getcomptype() != "NONE":
                raise ApiError(415, "invalid_audio", "Only uncompressed PCM WAV is supported.")
            rate = audio.getframerate()
            if rate <= 0:
                raise ApiError(415, "invalid_audio", "Invalid WAV sample rate.")
            duration = audio.getnframes() / rate
    except wave.Error as exc:
        raise ApiError(415, "invalid_audio", "Invalid or unsupported WAV file.") from exc
    if duration > max_seconds:
        raise ApiError(413, "audio_too_long", f"Audio must be shorter than {max_seconds:g} seconds.")
    if duration == 0:
        raise ApiError(415, "invalid_audio", "The audio stream is empty.")
    return duration
