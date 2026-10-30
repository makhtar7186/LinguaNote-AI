"""The single inference worker shared by file uploads and live sessions.

One worker serialises all model use (concurrent Whisper runs would only fight over the CPU cores) and
lets callers ask whether it is idle, so best-effort work such as live partials can be skipped
instead of queueing behind real work.
"""
import shutil
import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="inference")
_pending = 0
_lock = threading.Lock()


def _finished(_future: Future) -> None:
    global _pending
    with _lock:
        _pending -= 1


def submit(function: Callable[..., Any], *args: Any) -> Future:
    """Queue `function(*args)` on the worker."""
    global _pending
    with _lock:
        _pending += 1
    try:
        future = _pool.submit(function, *args)
    except BaseException:
        with _lock:
            _pending -= 1
        raise
    future.add_done_callback(_finished)  # also runs when the job is cancelled before it starts
    return future


def is_idle() -> bool:
    """True when nothing is running or queued."""
    with _lock:
        return _pending == 0


def discard_when_idle(directory: str, future: Future | None) -> None:
    """Remove a temp dir now, or once a still-running job stops reading from it."""
    if future is not None and not future.done():
        future.add_done_callback(lambda _f: shutil.rmtree(directory, ignore_errors=True))
    else:
        shutil.rmtree(directory, ignore_errors=True)
