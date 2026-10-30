import logging
import os
import shutil
import tempfile
import threading
import time
from importlib.util import find_spec
from pathlib import Path

from fastapi import APIRouter, File, UploadFile

from app.audio.convert import convert_to_model_wav, validate_wav
from app.config import SUPPORTED_EXTENSIONS, Settings
from app.engines.base import ModelUnavailableError
from app.engines.registry import get_engine
from app.errors import ApiError
from app.schemas.transcription import HealthResponse, Limits, SegmentOut, TranscriptionResponse

logger = logging.getLogger("linguanote.api")

# One inference at a time: several concurrent Whisper runs would only fight over the CPU cores.
_inference_lock = threading.Lock()


def describe_engine(settings: Settings) -> tuple[bool, str | None, str | None]:
    """Report availability without loading any model or downloading anything."""
    if settings.engine == "faster-whisper":
        available = find_spec("faster_whisper") is not None
        model = os.getenv("LINGUANOTE_WHISPER_MODEL", "base")
        return available, model if available else None, (
            None if available else "Install the optional Windows ASR dependencies."
        )
    if settings.engine == "omnilingual-ctc":
        available = (
            find_spec("omnilingual_asr") is not None
            and os.getenv("LINGUANOTE_ALLOW_MODEL_DOWNLOAD") == "1"
        )
        model = os.getenv("LINGUANOTE_MODEL_CARD", "omniASR_CTC_300M_v2")
        return available, model if available else None, (
            None if available else "Omnilingual is experimental and unavailable in this Windows installation."
        )
    return False, None, "No supported ASR engine is selected."


def _read_upload(file: UploadFile, destination: Path, max_bytes: int) -> int:
    total = 0
    with destination.open("wb") as out:
        while chunk := file.file.read(1024 * 1024):
            total += len(chunk)
            if total > max_bytes:
                raise ApiError(413, "file_too_large", f"Media file exceeds the {max_bytes // (1024 * 1024)} MiB limit.")
            out.write(chunk)
    if total == 0:
        raise ApiError(400, "empty_file", "The uploaded file is empty.")
    return total


def build_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    @router.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        available, model, message = describe_engine(settings)
        ffmpeg_ok = shutil.which(settings.ffmpeg) is not None
        if not ffmpeg_ok and message is None:
            message = "FFmpeg was not found in PATH (see LINGUANOTE_FFMPEG)."
        return HealthResponse(
            status="ok",
            engine_selected=available,
            engine=settings.engine if available else None,
            model=model,
            setup_message=message,
            ffmpeg_available=ffmpeg_ok,
            limits=Limits(
                max_upload_bytes=settings.max_upload_bytes,
                max_audio_seconds=settings.max_audio_seconds,
                extensions=sorted(SUPPORTED_EXTENSIONS),
            ),
        )

    @router.post("/api/v1/transcriptions", response_model=TranscriptionResponse)
    def transcribe(file: UploadFile = File(...)) -> TranscriptionResponse:
        extension = Path(file.filename or "").suffix.lower()
        if extension not in SUPPORTED_EXTENSIONS:
            raise ApiError(415, "unsupported_extension", "Unsupported audio/video file extension.")
        started = time.perf_counter()
        try:
            with tempfile.TemporaryDirectory(prefix="linguanote-") as temp_dir:
                source = Path(temp_dir) / f"input{extension}"
                model_wav = Path(temp_dir) / "normalized.wav"
                size = _read_upload(file, source, settings.max_upload_bytes)

                try:
                    engine = get_engine(settings.engine)
                except ModelUnavailableError as exc:
                    raise ApiError(503, "model_unavailable", str(exc)) from exc
                limit = settings.max_audio_seconds
                if engine.capabilities.max_audio_seconds:
                    limit = min(limit, engine.capabilities.max_audio_seconds)

                convert_to_model_wav(
                    source, model_wav, ffmpeg=settings.ffmpeg, max_seconds=limit,
                    timeout=settings.ffmpeg_timeout_seconds,
                )
                duration = validate_wav(model_wav, max_seconds=limit)
                with _inference_lock:
                    result = engine.transcribe(model_wav)
                logger.info(
                    "Transcribed upload ext=%s bytes=%d audio=%.1fs engine=%s model=%s lang=%s chars=%d elapsed=%.2fs",
                    extension, size, duration, result.engine, result.model, result.language,
                    len(result.text), time.perf_counter() - started,
                )
                return TranscriptionResponse(
                    text=result.text,
                    engine=result.engine,
                    model=result.model,
                    duration_seconds=duration,
                    timing_available=engine.capabilities.timestamps and bool(result.segments),
                    language=result.language,
                    language_probability=result.language_probability,
                    segments=[SegmentOut(**vars(s)) for s in result.segments],
                )
        except ApiError as exc:
            logger.warning("Upload rejected ext=%s status=%d code=%s", extension, exc.status_code, exc.code)
            raise
        except Exception as exc:
            # Exception type and traceback only; never the audio or transcript content.
            logger.exception("Unexpected transcription failure ext=%s", extension)
            raise ApiError(500, "inference_failed", "Transcription failed unexpectedly. See service logs.") from exc
        finally:
            file.file.close()

    return router
