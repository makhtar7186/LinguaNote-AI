"""Command-line entry point of the service, used by the installed application (no Python on the user's machine).

The host is deliberately not an option: this service only ever listens on the loopback interface.
"""
import argparse
from collections.abc import Sequence

import uvicorn

from app.main import create_app

HOST = "127.0.0.1"
# Largest WebSocket message uvicorn will buffer (its default is 16 MiB). Audio frames are at most 64 KiB.
DEFAULT_WS_MAX_BYTES = 256 * 1024


def parse_arguments(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="linguanote-service", description="LinguaNote local transcription service")
    parser.add_argument("--port", type=int, required=True, help="loopback port to listen on")
    parser.add_argument("--ws-max-size", type=int, default=DEFAULT_WS_MAX_BYTES, help="largest WebSocket message")
    arguments = parser.parse_args(argv)
    if not 1 <= arguments.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if arguments.ws_max_size < 1:
        parser.error("--ws-max-size must be positive")
    return arguments


def main(argv: Sequence[str] | None = None) -> None:
    arguments = parse_arguments(argv)
    # The factory object, not an import string: a frozen build has no importable path to resolve at run time.
    uvicorn.run(create_app, factory=True, host=HOST, port=arguments.port, ws_max_size=arguments.ws_max_size)


if __name__ == "__main__":
    main()
