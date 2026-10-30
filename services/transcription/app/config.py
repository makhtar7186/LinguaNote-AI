"""Runtime settings read from LINGUANOTE_* environment variables."""
import os
from dataclasses import dataclass

SUPPORTED_EXTENSIONS = frozenset({
    ".aac", ".flac", ".m4a", ".mkv", ".mov", ".mp3", ".mp4",
    ".oga", ".ogg", ".opus", ".wav", ".webm", ".wma",
})
DEFAULT_CORS_ORIGINS = "http://127.0.0.1:5173"


@dataclass(frozen=True)
class Settings:
    engine: str
    max_upload_bytes: int
    max_audio_seconds: float
    ffmpeg: str
    ffmpeg_timeout_seconds: int
    cors_origins: tuple[str, ...]
    api_token: str | None


def load_settings() -> Settings:
    origins = os.getenv("LINGUANOTE_CORS_ORIGINS", DEFAULT_CORS_ORIGINS)
    return Settings(
        engine=os.getenv("LINGUANOTE_ASR_ENGINE", "faster-whisper"),
        max_upload_bytes=int(os.getenv("LINGUANOTE_MAX_UPLOAD_MIB", "50")) * 1024 * 1024,
        max_audio_seconds=float(os.getenv("LINGUANOTE_MAX_AUDIO_SECONDS", "600")),
        ffmpeg=os.getenv("LINGUANOTE_FFMPEG", "ffmpeg"),
        ffmpeg_timeout_seconds=int(os.getenv("LINGUANOTE_FFMPEG_TIMEOUT_SECONDS", "120")),
        cors_origins=tuple(o.strip() for o in origins.split(",") if o.strip()),
        api_token=os.getenv("LINGUANOTE_API_TOKEN") or None,
    )
