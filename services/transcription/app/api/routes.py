import logging
import os
import shutil
import tempfile
import threading
import time
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout
from importlib.util import find_spec
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile

from app import inference as inference_worker
from app.audio.convert import convert_to_model_wav, validate_wav
from app.config import SUPPORTED_EXTENSIONS, Settings
from app.engines.base import ModelUnavailableError, TranscriptionResult
from app.engines.language_mode import SESSION_LANGUAGES, UnsupportedLanguageError, for_language, supported_languages
from app.engines.registry import capabilities_for, get_engine
from app.errors import ApiError
from app.schemas.transcription import HealthResponse, Limits, SegmentOut, TranscriptionResponse
from app.storage.history import HistoryRepository, SessionRecorder

logger = logging.getLogger("linguanote.api")

UPLOAD_PATH = "/api/v1/transcriptions"

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
    if settings.engine == "language-routing":
        from app.engines.language_routing import routing_paths
        try:
            routing_paths()
        except ModelUnavailableError as exc:
            return False, None, str(exc)
        if find_spec("faster_whisper") is None:
            return False, None, "Install the optional Windows ASR dependencies."
        return True, f"{os.getenv('LINGUANOTE_WHISPER_MODEL', 'base')}+wolof", None
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


def save_file_transcription(
    history: HistoryRepository | None, result: TranscriptionResult, duration: float
) -> str | None:
    """Store a finished file transcription if (and only if) the user turned the history on."""
    if history is None:
        return None
    recorder = SessionRecorder.begin(history, kind="file", engine=result.engine, model=result.model)
    if recorder is None:
        return None
    if result.segments:
        for segment in result.segments:
            # A routed segment keeps its own language label; the recording-level estimate has no probability for it.
            recorder.segment(
                text=segment.text, start_seconds=segment.start_seconds, end_seconds=segment.end_seconds,
                language=segment.language or result.language,
                language_probability=None if segment.language else result.language_probability,
            )
    elif result.text.strip():
        # No timing from the engine: stored as such, never invented.
        recorder.segment(text=result.text, language=result.language, language_probability=result.language_probability)
    recorder.finish(duration_seconds=duration)
    return recorder.session_id if recorder.ok else None


def build_router(settings: Settings, history: HistoryRepository | None = None) -> APIRouter:
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
            languages=supported_languages(settings.engine) if available else [],
            limits=Limits(
                max_upload_bytes=settings.max_upload_bytes,
                max_audio_seconds=effective_max_audio_seconds(settings),
                extensions=sorted(SUPPORTED_EXTENSIONS),
            ),
        )

    @router.post(UPLOAD_PATH, response_model=TranscriptionResponse)
    def transcribe(file: UploadFile = File(...), language: str | None = Form(None)) -> TranscriptionResponse:
        # No language (or "auto"): several languages, detected. Otherwise the user's single language.
        language = None if language in (None, "", "auto") else language
        if language is not None and language not in SESSION_LANGUAGES:
            raise ApiError(422, "unsupported_language", f"Choose one of: auto, {', '.join(SESSION_LANGUAGES)}.")
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
                engine = for_language(get_engine(settings.engine), language)
            except ModelUnavailableError as exc:
                raise ApiError(503, "model_unavailable", str(exc)) from exc
            except UnsupportedLanguageError as exc:
                raise ApiError(422, "unsupported_language", str(exc)) from exc
            limit = effective_max_audio_seconds(settings)
            if engine.capabilities.max_audio_seconds:
                limit = min(limit, engine.capabilities.max_audio_seconds)

            convert_to_model_wav(
                source, model_wav, ffmpeg=settings.ffmpeg, max_seconds=limit,
                timeout=settings.ffmpeg_timeout_seconds,
            )
            duration = validate_wav(model_wav, max_seconds=limit)
            # Keep the future even on timeout: the temp dir must outlive a still-running inference.
            inference = inference_worker.submit(engine.transcribe, model_wav)
            result = _await_inference(inference, settings.inference_timeout_seconds)
            logger.info(
                "Transcribed upload ext=%s bytes=%d audio=%.1fs engine=%s model=%s language=%s elapsed=%.2fs",
                extension, size, duration, result.engine, result.model, language or "auto",
                time.perf_counter() - started,
            )
            saved_session_id = save_file_transcription(history, result, duration)
            return TranscriptionResponse(
                saved_session_id=saved_session_id,
                text=result.text,
                engine=result.engine,
                model=result.model,
                duration_seconds=duration,
                timing_available=engine.capabilities.timestamps and bool(result.segments),
                language=result.language,
                language_probability=result.language_probability,
                segments=[SegmentOut(start_seconds=s.start_seconds, end_seconds=s.end_seconds, text=s.text,
                                     language=s.language) for s in result.segments],
                warnings=list(result.warnings),
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
            inference_worker.discard_when_idle(temp_dir, inference)
            admission.release()

    return router
