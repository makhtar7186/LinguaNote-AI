import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.live import build_live_router
from app.api.routes import UPLOAD_PATH, build_router
from app.config import MULTIPART_OVERHEAD_BYTES, Settings, load_settings, validate_settings
from app.errors import ApiError
from app.live.manager import LiveManager
from app.live.session import LiveLimits
from app.logging_config import configure_logging
from app.security import BodyLimitMiddleware

TOKEN_HEADER = "X-LinguaNote-Token"
logger = logging.getLogger("linguanote.api")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Application factory. Run with: uvicorn --factory app.main:create_app"""
    settings = settings or load_settings()
    validate_settings(settings)

    live_manager = LiveManager(LiveLimits(
        max_session_seconds=settings.live_max_session_seconds,
        idle_timeout_seconds=settings.live_idle_timeout_seconds,
        resume_seconds=settings.live_resume_seconds,
        job_timeout_seconds=settings.live_job_timeout_seconds,
    ))

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        log_path = configure_logging()
        logger.info("Logging to %s", log_path)
        yield
        live_manager.shutdown()

    app = FastAPI(title="LinguaNote Transcription", version="0.1.0", lifespan=lifespan)

    @app.exception_handler(ApiError)
    async def api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.message, "code": exc.code})

    @app.middleware("http")
    async def require_token(request: Request, call_next):
        # Mandatory shared secret (see validate_settings). The custom header also makes every browser
        # request non-"simple", so a web page on another origin is stopped at the CORS preflight.
        if settings.api_token and request.method != "OPTIONS":
            supplied = request.headers.get(TOKEN_HEADER, "")
            if not hmac.compare_digest(supplied.encode(), settings.api_token.encode()):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Missing or invalid API token.", "code": "unauthorized"},
                )
        return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", TOKEN_HEADER],
    )
    # Mitigates DNS rebinding: only loopback host names are served.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])
    # Outermost: oversized bodies are refused before authentication or multipart parsing buffer them.
    app.add_middleware(
        BodyLimitMiddleware,
        max_bytes=settings.max_upload_bytes + MULTIPART_OVERHEAD_BYTES,
        upload_path=UPLOAD_PATH,
    )
    app.include_router(build_router(settings))
    app.include_router(build_live_router(settings, live_manager))
    return app
