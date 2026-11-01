"""Engine selection and lifecycle: at most one model instance, loaded once."""
import threading

from app.engines.base import EngineCapabilities, ModelUnavailableError, SpeechEngine

# Internal name: the routing engine built for live use (lighter Wolof model). Not a LINGUANOTE_ASR_ENGINE value.
LIVE_ROUTING = "language-routing-live"

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
    if engine_name == "language-routing":
        from app.engines.language_routing import build_routing_engine
        return build_routing_engine()
    if engine_name == LIVE_ROUTING:
        from app.engines.language_routing import build_routing_engine
        return build_routing_engine(live=True)
    raise ModelUnavailableError(
        f"Unknown ASR engine '{engine_name}'. Choose faster-whisper, omnilingual-ctc or language-routing."
    )


def create_engine(engine_name: str) -> SpeechEngine:
    """Build a fresh, unshared engine (evaluation runs); the service uses get_engine()."""
    return _build(engine_name)


def capabilities_for(engine_name: str) -> EngineCapabilities | None:
    """Declared capabilities without loading a model (they are class attributes). None if unknown."""
    if engine_name == "faster-whisper":
        from app.engines.faster_whisper import FasterWhisperEngine
        return FasterWhisperEngine.capabilities
    if engine_name == "omnilingual-ctc":
        from app.engines.omnilingual_ctc import OmnilingualCtcEngine
        return OmnilingualCtcEngine.capabilities
    if engine_name == "language-routing":
        from app.language.routing import RoutedEngine
        return RoutedEngine.capabilities
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
