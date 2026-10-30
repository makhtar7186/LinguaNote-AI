"""Behaviour over a real HTTP socket (uvicorn), which Starlette's TestClient cannot reproduce."""
import http.client
import socket
import threading
import time
from dataclasses import replace

import pytest
import uvicorn

from app.config import load_settings
from app.main import create_app

TOKEN = "live-token-0123456789"
LIMIT = 1024 * 1024
HEADERS = {"X-LinguaNote-Token": TOKEN}
BOUNDARY = "b"


@pytest.fixture
def live_port():
    settings = replace(load_settings(), max_upload_bytes=LIMIT, api_token=TOKEN)
    server = uvicorn.Server(uvicorn.Config(create_app(settings), host="127.0.0.1", port=0, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started, "uvicorn did not start"
    yield server.servers[0].sockets[0].getsockname()[1]
    server.should_exit = True
    thread.join(timeout=10)


def multipart_chunks(total_bytes: int):
    yield f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n\r\n'.encode()
    sent = 0
    while sent < total_bytes:
        yield b"0" * 65536
        sent += 65536
    yield f"\r\n--{BOUNDARY}--\r\n".encode()


def post_chunked(port: int, total_bytes: int) -> int | str:
    """Status code, or 'reset' when the server cut the connection while the client was still sending."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    try:
        connection.request(
            "POST", "/api/v1/transcriptions", body=multipart_chunks(total_bytes), encode_chunked=True,
            headers={**HEADERS, "Content-Type": f"multipart/form-data; boundary={BOUNDARY}",
                     "Transfer-Encoding": "chunked"},
        )
        return connection.getresponse().status
    except (ConnectionError, http.client.HTTPException):
        return "reset"
    finally:
        connection.close()


def get_status(port: int, headers: dict[str, str]) -> int:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.request("GET", "/health", headers=headers)
        response = connection.getresponse()
        response.read()
        return response.status
    finally:
        connection.close()


def declared_length_status_line(port: int, path: str, length: int) -> bytes:
    """Send only headers announcing `length` body bytes and return the start of the response."""
    with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
        sock.sendall(
            (
                f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-LinguaNote-Token: {TOKEN}\r\n"
                f"Content-Type: multipart/form-data; boundary={BOUNDARY}\r\nContent-Length: {length}\r\n\r\n"
            ).encode()
        )
        return sock.recv(64)


def test_real_server_requires_the_token(live_port):
    assert get_status(live_port, HEADERS) == 200
    assert get_status(live_port, {}) == 401


def test_chunked_body_over_the_limit_is_never_accepted(live_port):
    # 4 MiB streamed with no Content-Length against a 1 MiB limit.
    assert post_chunked(live_port, 4 * LIMIT) in (413, "reset")


def test_declared_length_over_the_limit_is_refused_without_sending_the_body(live_port):
    assert declared_length_status_line(live_port, "/api/v1/transcriptions", 50 * LIMIT).startswith(b"HTTP/1.1 413")


def test_other_routes_have_a_small_body_cap(live_port):
    assert declared_length_status_line(live_port, "/health", 128 * 1024).startswith(b"HTTP/1.1 413")
