"""Wire format of the live WebSocket (see docs/api-contracts.md). Client messages are validated here."""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

PROTOCOL_VERSION = 1
SEQ_BYTES = 4  # binary frames: uint32 big-endian sequence number, then PCM
# Text messages are tiny by design; anything larger is refused before it is parsed.
MAX_OPENING_TEXT_BYTES = 4096
MAX_CONTROL_TEXT_BYTES = 256


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StartMessage(_Strict):
    type: Literal["start"]
    token: str = Field(default="", max_length=512)
    protocol: int
    # What the client listens to. Informational: it is stored with the session in the history, nothing else.
    source: Literal["microphone", "system", "both"] | None = None


class ResumeMessage(_Strict):
    type: Literal["resume"]
    token: str = Field(default="", max_length=512)
    protocol: int
    session_id: str = Field(min_length=1, max_length=128)
    last_event_id: int = Field(ge=0)


class ControlMessage(_Strict):
    type: Literal["stop", "ping"]


OpeningMessage = TypeAdapter(Annotated[StartMessage | ResumeMessage, Field(discriminator="type")])
ControlAdapter = TypeAdapter(ControlMessage)


def transport_error(code: str, message: str, *, fatal: bool, **extra) -> dict:
    """An error that belongs to the connection (no event_id, never replayed)."""
    return {"type": "error", "code": code, "message": message, "fatal": fatal, **extra}
