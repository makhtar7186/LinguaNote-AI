"""HTTP API of the transcription history (token-protected like every other route)."""
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Path, Query, Response
from pydantic import BaseModel, Field

from app.errors import ApiError
from app.export.formats import FORMATS, ExportError, render, safe_filename
from app.storage.history import MAX_PAGE_SIZE, MAX_TITLE_CHARS, HistoryError, HistoryRepository

SessionId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,64}$")]


class SettingsBody(BaseModel):
    enabled: bool
    # 7, 30, 90, 365 days, or null to keep until the user deletes (validated against the allowed list).
    retention_days: int | None = None


class RenameBody(BaseModel):
    title: str = Field(min_length=1, max_length=MAX_TITLE_CHARS * 2)


def build_history_router(repository: HistoryRepository) -> APIRouter:
    router = APIRouter(prefix="/api/v1/history")

    def settings_payload() -> dict:
        settings = repository.get_settings()
        return {"enabled": settings.enabled, "retention_days": settings.retention_days}

    @router.get("/settings")
    def get_settings() -> dict:
        return settings_payload()

    @router.put("/settings")
    def put_settings(body: SettingsBody) -> dict:
        try:
            repository.set_settings(enabled=body.enabled, retention_days=body.retention_days)
        except HistoryError as exc:
            raise ApiError(422, "invalid_retention", str(exc)) from exc
        if repository.get_settings().retention_days is not None:
            repository.purge_expired()  # a shorter retention takes effect now, not at the next start
        return settings_payload()

    @router.get("/sessions")
    def list_sessions(
        query: Annotated[str | None, Query(max_length=200)] = None,
        limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = 50,
        offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    ) -> dict:
        return repository.list_sessions(query=query, limit=limit, offset=offset)

    @router.get("/sessions/{session_id}")
    def get_session(session_id: SessionId) -> dict:
        session = repository.get_session(session_id)
        if session is None:
            raise ApiError(404, "session_not_found", "This session does not exist (it may have been deleted).")
        return session

    @router.patch("/sessions/{session_id}")
    def rename_session(session_id: SessionId, body: RenameBody) -> dict:
        try:
            renamed = repository.rename_session(session_id, body.title)
        except HistoryError as exc:
            raise ApiError(422, "invalid_title", str(exc)) from exc
        if not renamed:
            raise ApiError(404, "session_not_found", "This session does not exist (it may have been deleted).")
        return repository.get_session(session_id) or {}

    @router.delete("/sessions/{session_id}", status_code=204)
    def delete_session(session_id: SessionId) -> Response:
        if not repository.delete_session(session_id):
            raise ApiError(404, "session_not_found", "This session does not exist (it may have been deleted).")
        return Response(status_code=204)

    @router.delete("/sessions")
    def delete_everything(confirm: Annotated[str | None, Query()] = None) -> dict:
        # A bare DELETE must never wipe the history: the caller has to say so explicitly.
        if confirm != "all":
            raise ApiError(400, "confirmation_required", "Pass confirm=all to delete the whole history.")
        return {"deleted": repository.delete_all()}

    @router.get("/sessions/{session_id}/export")
    def export_session(session_id: SessionId, format: Annotated[str, Query()] = "txt") -> Response:  # noqa: A002
        if format not in FORMATS:
            raise ApiError(422, "unsupported_format", f"Choose one of: {', '.join(FORMATS)}.")
        session = repository.get_session(session_id)
        if session is None:
            raise ApiError(404, "session_not_found", "This session does not exist (it may have been deleted).")
        try:
            content, media_type = render(session, format)
        except ExportError as exc:
            raise ApiError(422, "export_not_possible", str(exc)) from exc
        filename = safe_filename(session["title"], format)
        return Response(
            content=content.encode("utf-8"),
            media_type=media_type,
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
        )

    return router
