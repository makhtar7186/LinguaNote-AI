import pytest

from app import serve
from app.main import create_app


def test_the_service_listens_on_loopback_only_with_the_requested_port(monkeypatch):
    calls = []
    monkeypatch.setattr(serve.uvicorn, "run", lambda target, **options: calls.append((target, options)))

    serve.main(["--port", "5555", "--ws-max-size", "1024"])

    assert calls == [(create_app, {"factory": True, "host": "127.0.0.1", "port": 5555, "ws_max_size": 1024})]


def test_the_websocket_limit_stays_far_below_the_uvicorn_default_when_not_given():
    assert serve.parse_arguments(["--port", "5555"]).ws_max_size == 256 * 1024


def test_the_host_cannot_be_changed_from_the_command_line(capsys):
    with pytest.raises(SystemExit):
        serve.parse_arguments(["--port", "5555", "--host", "0.0.0.0"])
    assert "--host" in capsys.readouterr().err


@pytest.mark.parametrize("arguments", [[], ["--port", "0"], ["--port", "70000"], ["--port", "abc"],
                                       ["--port", "5555", "--ws-max-size", "0"]])
def test_invalid_arguments_stop_the_service_before_it_starts(arguments):
    with pytest.raises(SystemExit):
        serve.parse_arguments(arguments)
