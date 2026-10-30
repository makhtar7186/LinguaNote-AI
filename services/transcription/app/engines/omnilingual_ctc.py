import os
from pathlib import Path

from app.engines.base import EngineCapabilities, ModelUnavailableError, TranscriptionResult


class OmnilingualCtcEngine:
    """Optional Omnilingual CTC adapter; model initialization is explicit."""

    # Same identifier as LINGUANOTE_ASR_ENGINE, so /health and transcription results agree.
    name = "omnilingual-ctc"
    # The upstream inference pipeline only accepts clips shorter than 40 s.
    capabilities = EngineCapabilities(max_audio_seconds=39.0)

    def __init__(self) -> None:
        if os.getenv("LINGUANOTE_ALLOW_MODEL_DOWNLOAD") != "1":
            raise ModelUnavailableError(
                "Model loading can download weights. Set "
                "LINGUANOTE_ALLOW_MODEL_DOWNLOAD=1 only after reviewing the model."
            )

        self.model = os.getenv("LINGUANOTE_MODEL_CARD", "omniASR_CTC_300M_v2")
        try:
            from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline
        except ImportError as exc:
            raise ModelUnavailableError(
                "Install the optional 'omnilingual' dependency to use this engine."
            ) from exc

        try:
            self._pipeline = ASRInferencePipeline(model_card=self.model, device="cpu")
        except Exception as exc:
            raise ModelUnavailableError(
                f"The Omnilingual model '{self.model}' could not be loaded. "
                "Check the model card name, disk space and local model cache."
            ) from exc

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        texts = self._pipeline.transcribe([str(audio_path)], batch_size=1)
        return TranscriptionResult(
            text=texts[0].strip(),
            engine=self.name,
            model=self.model,
        )
