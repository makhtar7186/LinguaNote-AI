import logging
import os
import shutil
import tempfile
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from importlib.util import find_spec
from pathlib import Path

from fastapi import APIRouter, File, UploadFile

from app.audio.convert import convert_to_model_wav, validate_wav
from app.config import SUPPORTED_EXTENSIONS, Settings
from app.engines.base import ModelUnavailableError, TranscriptionResult
from app.engines.registry import capabilities_for, get_engine
from app.errors import ApiError
from app.schemas.transcription import HealthResponse, Limits, SegmentOut, TranscriptionResponse

logger = logging.getLogger("linguanote.api")

UPLOAD_PATH = "/api/v1/transcriptions"

# One inference at a time: several concurrent Whisper runs would only fight over the CPU cores.
# A single worker also serialises requests; a timed-out request cancels its job if it has not started.
_inference_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="inference")


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


def effective_max_audio_seconds(settings: Settings) -> float:
    """The configured limit, lowered to what the selected engine can actually process."""
    engine_limit = getattr(capabilities_for(settings.engine), "max_audio_seconds", None)
    return min(settings.max_audio_seconds, engine_limit) if engine_limit else settings.max_audio_seconds


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


def _await_inference(future: "Future[TranscriptionResult]", timeout: int) -> TranscriptionResult:
    try:
        return future.result(timeout=timeout)
    except FutureTimeout as exc:
        # A running inference cannot be interrupted; a queued one is dropped here.
        future.cancel()
        raise ApiError(504, "inference_timeout", f"Transcription exceeded {timeout} seconds.") from exc


def _discard_when_idle(directory: str, future: Future | None) -> None:
    """Remove the temp dir now, or once a still-running inference stops reading from it."""
    if future is not None and not future.done():
        future.add_done_callback(lambda _f: shutil.rmtree(directory, ignore_errors=True))
    else:
        shutil.rmtree(directory, ignore_errors=True)


def build_router(settings: Settings) -> APIRouter:
    router = APIRouter()
    # Bounds work in flight (conversion + inference). The single inference worker would otherwise
    # let any number of already-uploaded files pile up behind it.
    admission = threading.BoundedSemaphore(max(1, settings.max_pending_transcriptions))

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
                max_audio_seconds=effective_max_audio_seconds(settings),
                extensions=sorted(SUPPORTED_EXTENSIONS),
            ),
        )

    @router.post(UPLOAD_PATH, response_model=TranscriptionResponse)
    def transcribe(file: UploadFile = File(...)) -> TranscriptionResponse:
        extension = Path(file.filename or "").suffix.lower()
        if extension not in SUPPORTED_EXTENSIONS:
            raise ApiError(415, "unsupported_extension", "Unsupported audio/video file extension.")
        if not admission.acquire(blocking=False):
            raise ApiError(429, "busy", "The service is already processing other transcriptions. Retry shortly.")
        started = time.perf_counter()
        temp_dir = tempfile.mkdtemp(prefix="linguanote-")
        inference: Future | None = None
        try:
            source = Path(temp_dir) / f"input{extension}"
            model_wav = Path(temp_dir) / "normalized.wav"
            size = _read_upload(file, source, settings.max_upload_bytes)

            try:
                engine = get_engine(settings.engine)
            except ModelUnavailableError as exc:
                raise ApiError(503, "model_unavailable", str(exc)) from exc
            limit = effective_max_audio_seconds(settings)
            if engine.capabilities.max_audio_seconds:
                limit = min(limit, engine.capabilities.max_audio_seconds)

            convert_to_model_wav(
                source, model_wav, ffmpeg=settings.ffmpeg, max_seconds=limit,
                timeout=settings.ffmpeg_timeout_seconds,
            )
            duration = validate_wav(model_wav, max_seconds=limit)
            # Keep the future even on timeout: the temp dir must outlive a still-running inference.
            inference = _inference_pool.submit(engine.transcribe, model_wav)
            result = _await_inference(inference, settings.inference_timeout_seconds)
            logger.info(
                "Transcribed upload ext=%s bytes=%d audio=%.1fs engine=%s model=%s elapsed=%.2fs",
                extension, size, duration, result.engine, result.model, time.perf_counter() - started,
            )
            return TranscriptionResponse(
                text=result.text,
                engine=result.engine,
                model=result.model,
                duration_seconds=duration,
                timing_available=engine.capabilities.timestamps and bool(result.segments),
                language=result.language,
                language_probability=result.language_probability,
                segments=[SegmentOut(start_seconds=s.start_seconds, end_seconds=s.end_seconds, text=s.text)
                          for s in result.segments],
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
            _discard_when_idle(temp_dir, inference)
            admission.release()

    return router
