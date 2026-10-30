import pytest

pytest.importorskip("mcp")

from app.mcp_server import build_multipart, resolve_api_base_url  # noqa: E402


def test_loopback_http_is_accepted():
    assert resolve_api_base_url("http://127.0.0.1:8765/", allow_remote=False) == "http://127.0.0.1:8765"
    assert resolve_api_base_url("http://localhost:8765", allow_remote=False) == "http://localhost:8765"


@pytest.mark.parametrize("url", ["http://example.com", "https://example.com", "http://192.168.1.10:8765", "ftp://x"])
def test_remote_destination_is_refused_by_default(url):
    with pytest.raises(ValueError):
        resolve_api_base_url(url, allow_remote=False)


def test_remote_requires_https_and_explicit_opt_in():
    assert resolve_api_base_url("https://asr.example.org", allow_remote=True) == "https://asr.example.org"
    with pytest.raises(ValueError):
        resolve_api_base_url("http://asr.example.org", allow_remote=True)


def test_multipart_boundary_is_random_and_filename_sanitised(tmp_path):
    path = tmp_path / 'a"b.wav'
    first, boundary_one = build_multipart(path, b"data")
    _second, boundary_two = build_multipart(path, b"data")
    assert boundary_one != boundary_two
    assert b'filename="ab.wav"' in first
    assert first.endswith(f"--{boundary_one}--\r\n".encode())
