from pydantic import BaseModel


class SegmentOut(BaseModel):
    start_seconds: float
    end_seconds: float
    text: str


class TranscriptionResponse(BaseModel):
    text: str
    engine: str
    model: str
    duration_seconds: float
    timing_available: bool = False
    # Estimates from the engine, not proof the transcription is correct.
    language: str | None = None
    language_probability: float | None = None
    segments: list[SegmentOut] = []
    # Set only when the user turned the history on and the transcription was saved there.
    saved_session_id: str | None = None


class Limits(BaseModel):
    max_upload_bytes: int
    max_audio_seconds: float
    extensions: list[str]


class HealthResponse(BaseModel):
    status: str
    engine_selected: bool
    engine: str | None = None
    model: str | None = None
    setup_message: str | None = None
    ffmpeg_available: bool
    limits: Limits


class ErrorResponse(BaseModel):
    detail: str
    code: str
