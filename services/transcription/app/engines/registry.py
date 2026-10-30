"""Engine selection and lifecycle: at most one model instance, loaded once."""
import threading

from app.engines.base import EngineCapabilities, ModelUnavailableError, SpeechEngine

_lock = threading.Lock()
_engine: SpeechEngine | None = None
_engine_name: str | None = None


def _build(engine_name: str) -> SpeechEngine:
    if engine_name == "faster-whisper":
        from app.engines.faster_whisper import FasterWhisperEngine
        return FasterWhisperEngine()
    if engine_name == "omnilingual-ctc":
        from app.engines.omnilingual_ctc import OmnilingualCtcEngine
        return OmnilingualCtcEngine()
    raise ModelUnavailableError(
        f"Unknown ASR engine '{engine_name}'. Choose faster-whisper or omnilingual-ctc."
    )


def capabilities_for(engine_name: str) -> EngineCapabilities | None:
    """Declared capabilities without loading a model (they are class attributes). None if unknown."""
    if engine_name == "faster-whisper":
        from app.engines.faster_whisper import FasterWhisperEngine
        return FasterWhisperEngine.capabilities
    if engine_name == "omnilingual-ctc":
        from app.engines.omnilingual_ctc import OmnilingualCtcEngine
        return OmnilingualCtcEngine.capabilities
    return None


def get_engine(engine_name: str) -> SpeechEngine:
    """Return the shared engine, building it under a lock so concurrent first
    requests cannot load (or download) the model twice. Failures are not cached."""
    global _engine, _engine_name
    with _lock:
        if _engine is None or _engine_name != engine_name:
            _engine = _build(engine_name)
            _engine_name = engine_name
        return _engine


def reset_engine() -> None:
    global _engine, _engine_name
    with _lock:
        _engine = None
        _engine_name = None
