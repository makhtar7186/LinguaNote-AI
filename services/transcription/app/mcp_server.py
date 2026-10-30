"""Local MCP tools for the LinguaNote transcription service."""

import json
import mimetypes
import os
import secrets
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from mcp.server.fastmcp import FastMCP

TOKEN_HEADER = "X-LinguaNote-Token"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost"})


def resolve_api_base_url(raw: str, *, allow_remote: bool) -> str:
    """Files and the API token are sent to this URL, so it must stay on this machine by default."""
    url = raw.rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("LINGUANOTE_API_URL must be an http(s) URL.")
    if parsed.hostname in LOOPBACK_HOSTS and parsed.scheme == "http":
        return url
    if allow_remote and parsed.scheme == "https":
        return url
    raise ValueError(
        "LINGUANOTE_API_URL must be an http loopback address. A remote backend would receive your audio "
        "files and API token; it requires https and LINGUANOTE_ALLOW_REMOTE_API=1."
    )


API_BASE_URL = resolve_api_base_url(
    os.getenv("LINGUANOTE_API_URL", "http://127.0.0.1:8765"),
    allow_remote=os.getenv("LINGUANOTE_ALLOW_REMOTE_API") == "1",
)
API_TOKEN = os.getenv("LINGUANOTE_API_TOKEN", "")

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


def build_multipart(path: Path, payload: bytes) -> tuple[bytes, str]:
    """Return (body, boundary). The boundary is random so file content cannot forge a part delimiter."""
    boundary = f"linguanote-{secrets.token_hex(16)}"
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    filename = path.name.replace('"', "").replace("\r", "").replace("\n", "")
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode()
    return head + payload + f"\r\n--{boundary}--\r\n".encode(), boundary


@mcp.tool()
def service_status() -> dict:
    """Check whether the local LinguaNote transcription service and engine are ready."""
    return _request(f"{API_BASE_URL}/health")


@mcp.tool()
def transcribe_file(file_path: str) -> dict:
    """Transcribe a local audio or video file using LinguaNote's configured local ASR engine.

    Limits and supported extensions are read from the service itself (/health), so they always
    match the backend configuration. The file is sent only to the configured LinguaNote service,
    which is restricted to this machine unless remote use was explicitly enabled. Model downloads
    may occur if the ASR model has not yet been installed.
    """
    limits = _request(f"{API_BASE_URL}/health")["limits"]
    path = Path(file_path).expanduser()
    if not path.is_file():
        raise ValueError("The supplied path does not point to a readable file.")
    if path.suffix.lower() not in limits["extensions"]:
        raise ValueError(f"Unsupported media extension. Supported extensions: {', '.join(limits['extensions'])}")
    size = path.stat().st_size
    if size == 0:
        raise ValueError("The media file is empty.")
    if size > limits["max_upload_bytes"]:
        raise ValueError(
            f"The file exceeds the service upload limit of {limits['max_upload_bytes'] // (1024 * 1024)} MiB."
        )

    body, boundary = build_multipart(path, path.read_bytes())
    return _request(
        f"{API_BASE_URL}/api/v1/transcriptions",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        timeout=900,
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")
