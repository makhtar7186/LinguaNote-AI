"""WebSocket endpoint for live transcription. Protocol: docs/api-contracts.md."""
import asyncio
import hmac
import json
import logging

from fastapi import APIRouter, WebSocket
from fastapi.concurrency import run_in_threadpool
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.engines.base import ModelUnavailableError
from app.engines.language_mode import UnsupportedLanguageError, for_language
from app.engines.registry import LIVE_ROUTING, get_engine
from app.live.manager import BusyError, LiveManager
from app.live.protocol import (
    MAX_CONTROL_TEXT_BYTES,
    MAX_OPENING_TEXT_BYTES,
    PROTOCOL_VERSION,
    SEQ_BYTES,
    ControlAdapter,
    OpeningMessage,
    ResumeMessage,
    transport_error,
)
from app.live.segmenter import SAMPLE_RATE, SegmenterConfig
from app.live.session import FrameResult, LiveSession

logger = logging.getLogger("linguanote.live")

LIVE_PATH = "/api/v1/live"
OPENING_TIMEOUT_SECONDS = 5.0
POLICY_VIOLATION = 1008
ROUTING_SEGMENTER = SegmenterConfig(min_utterance_seconds=10.0, max_utterance_seconds=20.0)


class _Connection:
    """One WebSocket plus a lock: the event pump and the receive loop both send."""

    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self._lock = asyncio.Lock()

    async def send(self, message: dict) -> None:
        async with self._lock:
            await self.websocket.send_json(message)


async def _reject(connection: _Connection, code: str, message: str, close_code: int = 1000) -> None:
    try:
        await connection.send(transport_error(code, message, fatal=True))
        await connection.websocket.close(code=close_code)
    except (RuntimeError, WebSocketDisconnect):
        pass  # the client is already gone


def handle_idle_timeout(session: LiveSession, generation: int) -> str:
    """The receive loop of one connection saw no message for too long.

    Only the connection that owns the session may end it: a replaced one going quiet says nothing
    about a session that a newer connection is actively using.
    """
    if not session.is_current(generation):
        return "superseded"
    session.end("idle_timeout")
    return "idle"


def release_connection(session: LiveSession, manager: LiveManager, generation: int) -> None:
    """Final state change of a connection handler (synchronous, so a cancellation cannot cut it short).

    A replaced connection leaves the session to its successor; otherwise it could delete a session that
    was just resumed. The owner either removes a finished session or keeps an unfinished one for resume.
    """
    if not session.is_current(generation):
        return
    if session.ended:
        logger.info("Live session over reason=%s utterances=%d", session.end_reason, session.final_count)
        manager.remove(session.session_id)
    else:
        session.detach(generation)  # kept for LINGUANOTE_LIVE_RESUME_SECONDS


def build_live_router(settings: Settings, manager: LiveManager) -> APIRouter:
    router = APIRouter()

    def token_ok(supplied: str) -> bool:
        if not settings.api_token:
            return True  # LINGUANOTE_ALLOW_NO_AUTH development mode
        return hmac.compare_digest(supplied.encode(), settings.api_token.encode())

    async def open_session(connection: _Connection) -> tuple[LiveSession, bool, int] | None:
        """Read and validate the opening message. Returns (session, resumed, last_event_id) or None."""
        try:
            message = await asyncio.wait_for(connection.websocket.receive(), OPENING_TIMEOUT_SECONDS)
        except TimeoutError:
            await _reject(connection, "invalid_message", "No opening message received in time.", POLICY_VIOLATION)
            return None
        if message["type"] == "websocket.disconnect":
            return None
        text = message.get("text") or ""
        if len(text.encode()) > MAX_OPENING_TEXT_BYTES:
            await _reject(connection, "invalid_message", "Opening message too large.", POLICY_VIOLATION)
            return None
        try:
            opening = OpeningMessage.validate_python(json.loads(text))
        except (ValueError, ValidationError):
            await _reject(connection, "invalid_message", "Invalid opening message.", POLICY_VIOLATION)
            return None
        if not token_ok(opening.token):
            await _reject(connection, "unauthorized", "Missing or invalid API token.", POLICY_VIOLATION)
            return None
        if opening.protocol != PROTOCOL_VERSION:
            await _reject(connection, "invalid_message", f"Unsupported protocol (expected {PROTOCOL_VERSION}).")
            return None

        if isinstance(opening, ResumeMessage):
            session = manager.get(opening.session_id)
            if session is None:
                await _reject(connection, "session_not_found", "Unknown or expired session.")
                return None
            if session.events_after(opening.last_event_id) is None:
                await _reject(connection, "resume_gap", "Too many events were missed to resume this session.")
                return None
            return session, True, opening.last_event_id

        routed = settings.engine == "language-routing"
        language = getattr(opening, "language", None)
        try:
            engine = await run_in_threadpool(get_engine, LIVE_ROUTING if routed else settings.engine)
            engine = for_language(engine, language)
        except ModelUnavailableError as exc:
            await _reject(connection, "model_unavailable", str(exc))
            return None
        except UnsupportedLanguageError as exc:
            await _reject(connection, "unsupported_language", str(exc))
            return None
        try:
            # Routing reads the language of whole passages: long chunks (10 to 20 s), final text only. The Wolof
            # model alone keeps that pace too: it is barely faster than speech here (docs/packaging.md).
            slow = routed and language in (None, "wo")
            options = {"segmenter_config": ROUTING_SEGMENTER, "partials": False} if slow else {}
            return manager.create(engine, source=getattr(opening, "source", None), **options), False, 0
        except BusyError:
            await _reject(connection, "busy", "A live session is already running.")
            return None

    @router.websocket(LIVE_PATH)
    async def live(websocket: WebSocket) -> None:
        # WebSockets are not subject to CORS: a page on another origin could open this socket.
        origin = websocket.headers.get("origin")
        if origin is not None and origin not in settings.cors_origins:
            await websocket.close(code=POLICY_VIOLATION)
            return
        await websocket.accept()
        connection = _Connection(websocket)

        opened = await open_session(connection)
        if opened is None:
            return
        session, resumed, last_event_id = opened
        generation = session.attach()
        limits = session.limits

        await connection.send({
            "type": "session_started", "session_id": session.session_id, "protocol": PROTOCOL_VERSION,
            "resumed": resumed, "audio_ack": session.last_seq,
            "audio": {"format": "pcm_s16le", "sample_rate": SAMPLE_RATE, "channels": 1,
                      "max_frame_bytes": limits.max_frame_bytes},
            "limits": {"max_session_seconds": limits.max_session_seconds},
            "engine": {"name": session.engine.name, "model": session.engine.model,
                       "timestamps": session.engine.capabilities.timestamps},
        })

        async def pump() -> None:
            """Send every logged event the client has not seen yet, in order."""
            sent = last_event_id
            while True:
                if not session.is_current(generation):
                    return  # a newer connection resumed the session: this one must send nothing more
                session.clear_signal()
                batch = session.events_after(sent)
                if batch is None:
                    await _reject(connection, "resume_gap", "Events were lost while the connection was slow.")
                    return
                for event in batch:
                    if not session.is_current(generation):
                        return  # replaced while a batch was being sent: stop before the next event
                    await connection.send(event)
                    sent = event["event_id"]
                if session.ended and not batch:
                    return  # session_ended (the last event) has been delivered
                if not batch:
                    await session.wait_for_event(1.0)

        async def receive_loop() -> str:
            while True:
                try:
                    message = await asyncio.wait_for(websocket.receive(), limits.idle_timeout_seconds)
                except TimeoutError:
                    return handle_idle_timeout(session, generation)
                if message["type"] == "websocket.disconnect":
                    return "disconnect"
                if not session.is_current(generation):
                    return "superseded"  # nothing from a replaced connection may reach the session
                session.touch()

                data = message.get("bytes")
                if data is not None:
                    if len(data) < SEQ_BYTES + 2 or (len(data) - SEQ_BYTES) % 2:
                        session.abort("invalid_message", "Audio frames: 4-byte sequence number, then whole samples.")
                        return "fatal"
                    if len(data) - SEQ_BYTES > limits.max_frame_bytes:
                        session.abort("frame_too_large", f"Audio frames are limited to {limits.max_frame_bytes} bytes.")
                        return "fatal"
                    result = session.accept_frame(int.from_bytes(data[:SEQ_BYTES], "big"), data[SEQ_BYTES:])
                    if result is FrameResult.GAP:
                        # No acknowledgement for a rejected frame: the client resends from `expected`.
                        await connection.send(transport_error(
                            "sequence_gap", "A frame is missing; resend from the expected sequence number.",
                            fatal=False, expected=session.last_seq + 1,
                        ))
                    elif result is not FrameResult.IGNORED:
                        await connection.send({"type": "audio_ack", "seq": session.last_seq})
                    if session.ended:
                        return "fatal"
                    continue

                text = message.get("text") or ""
                if len(text.encode()) > MAX_CONTROL_TEXT_BYTES:
                    session.abort("invalid_message", "Control message too large.")
                    return "fatal"
                try:
                    control = ControlAdapter.validate_python(json.loads(text))
                except (ValueError, ValidationError):
                    session.abort("invalid_message", "Unknown or malformed message.")
                    return "fatal"
                if control.type == "ping":
                    await connection.send({"type": "pong"})
                else:
                    session.end("client_stop")
                    return "stopped"

        pump_task = asyncio.create_task(pump())
        receive_task = asyncio.create_task(receive_loop())
        try:
            await asyncio.wait({pump_task, receive_task}, return_when=asyncio.FIRST_COMPLETED)
            if receive_task.done() and not pump_task.done():
                outcome = receive_task.exception() or receive_task.result()
                if outcome == "disconnect" or isinstance(outcome, BaseException):
                    pump_task.cancel()
                else:
                    # The client asked to stop (or went idle): wait for the remaining text to be delivered.
                    try:
                        await asyncio.wait_for(asyncio.shield(pump_task), limits.job_timeout_seconds * 2 + 10)
                    except (TimeoutError, WebSocketDisconnect, RuntimeError):
                        pass
        finally:
            # Session state first and synchronously: a cancellation (server shutdown) must not be able to
            # leave the session attached to a connection that no longer exists.
            release_connection(session, manager, generation)
            for task in (pump_task, receive_task):
                if not task.done():
                    task.cancel()
            outcomes = await asyncio.gather(pump_task, receive_task, return_exceptions=True)
            for outcome in outcomes:
                # A client dropping is normal; anything else is a server-side failure worth a trace
                # (exception types and stack only: never audio or transcript text).
                if isinstance(outcome, Exception) and not isinstance(outcome, WebSocketDisconnect):
                    logger.error("Live connection task failed", exc_info=outcome)
            try:
                await websocket.close()
            except RuntimeError:
                pass  # already closed

    return router
