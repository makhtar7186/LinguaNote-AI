"""Runtime settings read from LINGUANOTE_* environment variables."""
import os
from dataclasses import dataclass

SUPPORTED_EXTENSIONS = frozenset({
    ".aac", ".flac", ".m4a", ".mkv", ".mov", ".mp3", ".mp4",
    ".oga", ".ogg", ".opus", ".wav", ".webm", ".wma",
})
DEFAULT_CORS_ORIGINS = "http://127.0.0.1:5173"
MIN_TOKEN_LENGTH = 16
# Multipart framing (boundaries, headers) added on top of the file itself.
MULTIPART_OVERHEAD_BYTES = 64 * 1024


class ConfigurationError(RuntimeError):
    """Raised at startup when the service would otherwise run unprotected or misconfigured."""


@dataclass(frozen=True)
class Settings:
    engine: str
    max_upload_bytes: int
    max_audio_seconds: float
    ffmpeg: str
    ffmpeg_timeout_seconds: int
    inference_timeout_seconds: int
    cors_origins: tuple[str, ...]
    api_token: str | None
    allow_no_auth: bool = False
    # Transcriptions accepted at once (running + waiting); further ones get 429 instead of queueing forever.
    max_pending_transcriptions: int = 3


def load_settings() -> Settings:
    origins = os.getenv("LINGUANOTE_CORS_ORIGINS", DEFAULT_CORS_ORIGINS)
    return Settings(
        engine=os.getenv("LINGUANOTE_ASR_ENGINE", "faster-whisper"),
        max_upload_bytes=int(os.getenv("LINGUANOTE_MAX_UPLOAD_MIB", "50")) * 1024 * 1024,
        max_audio_seconds=float(os.getenv("LINGUANOTE_MAX_AUDIO_SECONDS", "600")),
        ffmpeg=os.getenv("LINGUANOTE_FFMPEG", "ffmpeg"),
        ffmpeg_timeout_seconds=int(os.getenv("LINGUANOTE_FFMPEG_TIMEOUT_SECONDS", "120")),
        inference_timeout_seconds=int(os.getenv("LINGUANOTE_INFERENCE_TIMEOUT_SECONDS", "840")),
        cors_origins=tuple(o.strip() for o in origins.split(",") if o.strip()),
        api_token=os.getenv("LINGUANOTE_API_TOKEN") or None,
        allow_no_auth=os.getenv("LINGUANOTE_ALLOW_NO_AUTH") == "1",
        max_pending_transcriptions=int(os.getenv("LINGUANOTE_MAX_PENDING", "3")),
    )


def validate_settings(settings: Settings) -> None:
    """Fail closed: the local API never starts without a secret unless the opt-out is explicit."""
    if settings.api_token is None:
        if settings.allow_no_auth:
            return
        raise ConfigurationError(
            "LINGUANOTE_API_TOKEN is required. Generate one with "
            "'python -c \"import secrets; print(secrets.token_urlsafe(32))\"' "
            "(development only: LINGUANOTE_ALLOW_NO_AUTH=1 disables authentication)."
        )
    if len(settings.api_token) < MIN_TOKEN_LENGTH:
        raise ConfigurationError(f"LINGUANOTE_API_TOKEN must be at least {MIN_TOKEN_LENGTH} characters long.")
