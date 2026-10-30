"""Local MCP tools for the LinguaNote transcription service."""

import json
import mimetypes
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from mcp.server.fastmcp import FastMCP

from app.config import SUPPORTED_EXTENSIONS

API_BASE_URL = os.getenv("LINGUANOTE_API_URL", "http://127.0.0.1:8765").rstrip("/")
API_TOKEN = os.getenv("LINGUANOTE_API_TOKEN", "")
MAX_UPLOAD_BYTES = int(os.getenv("LINGUANOTE_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
TOKEN_HEADER = "X-LinguaNote-Token"

mcp = FastMCP("LinguaNote AI")


def _request(
    url: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
) -> dict:
    request_headers = dict(headers or {})
    if API_TOKEN:
        request_headers[TOKEN_HEADER] = API_TOKEN
    try:
        with urlopen(Request(url, data=data, headers=request_headers), timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8"))
            detail = body.get("detail", "Request rejected")
        except (ValueError, UnicodeDecodeError):
            detail = "Request rejected"
        raise RuntimeError(f"Transcription service returned HTTP {exc.code}: {detail}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(
            f"Cannot reach the local transcription service at {API_BASE_URL}. Start the FastAPI service first."
        ) from exc


@mcp.tool()
def service_status() -> dict:
    """Check whether the local LinguaNote transcription service and engine are ready."""
    return _request(f"{API_BASE_URL}/health")


@mcp.tool()
def transcribe_file(file_path: str) -> dict:
    """Transcribe a local audio or video file using LinguaNote's configured local ASR engine.

    Supported files include WAV, MP3, M4A, FLAC, OGG, Opus, MP4, MOV, MKV, WebM, WMA, and AAC.
    The file is sent only to the local LinguaNote service. Model downloads may occur if the ASR
    model has not yet been installed.
    """
    path = Path(file_path).expanduser()
    if not path.is_file():
        raise ValueError("The supplied path does not point to a readable file.")
    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"Unsupported media extension. Supported extensions: {', '.join(sorted(SUPPORTED_EXTENSIONS))}")
    size = path.stat().st_size
    if size == 0:
        raise ValueError("The media file is empty.")
    if size > MAX_UPLOAD_BYTES:
        raise ValueError(f"The file exceeds the configured upload limit of {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB.")

    boundary = "----LinguaNoteMCPBoundary"
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    payload = path.read_bytes()
    filename = path.name.replace('"', "")
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode() + payload + f"\r\n--{boundary}--\r\n".encode()
    return _request(
        f"{API_BASE_URL}/api/v1/transcriptions",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        timeout=900,
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")
