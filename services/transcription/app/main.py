import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.routes import build_router
from app.config import Settings, load_settings
from app.errors import ApiError
from app.logging_config import configure_logging

TOKEN_HEADER = "X-LinguaNote-Token"
logger = logging.getLogger("linguanote.api")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        log_path = configure_logging()
        logger.info("Logging to %s", log_path)
        yield

    app = FastAPI(title="LinguaNote Transcription", version="0.1.0", lifespan=lifespan)

    @app.exception_handler(ApiError)
    async def api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.message, "code": exc.code})

    @app.middleware("http")
    async def require_token(request: Request, call_next):
        # Optional shared secret: when set, a web page on another origin cannot drive the API.
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
    app.include_router(build_router(settings))
    return app


app = create_app()
