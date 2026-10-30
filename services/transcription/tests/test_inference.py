import threading
import time
from pathlib import Path

from app import inference


def wait_until_idle(timeout: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout
    while not inference.is_idle() and time.monotonic() < deadline:
        time.sleep(0.01)
    return inference.is_idle()


def test_worker_reports_busy_while_a_job_runs_and_idle_afterwards():
    started, release = threading.Event(), threading.Event()

    def job():
        started.set()
        release.wait(5)
        return 42

    assert wait_until_idle()
    future = inference.submit(job)
    assert started.wait(5)
    assert not inference.is_idle()
    release.set()
    assert future.result(timeout=5) == 42
    assert wait_until_idle()


def test_a_cancelled_queued_job_does_not_leave_the_worker_marked_busy():
    started, release = threading.Event(), threading.Event()
    blocker = inference.submit(lambda: (started.set(), release.wait(5)))
    assert started.wait(5)
    queued = inference.submit(lambda: "never runs")
    assert queued.cancel()
    release.set()
    blocker.result(timeout=5)
    assert wait_until_idle()


def test_a_failing_job_still_releases_the_worker():
    future = inference.submit(lambda: 1 / 0)
    try:
        future.result(timeout=5)
    except ZeroDivisionError:
        pass
    assert wait_until_idle()


def test_directory_removal_waits_for_a_running_job(tmp_path):
    directory = tmp_path / "work"
    directory.mkdir()
    (directory / "audio.wav").write_bytes(b"x")
    release = threading.Event()
    future = inference.submit(lambda: release.wait(5))
    inference.discard_when_idle(str(directory), future)
    assert Path(directory).exists()  # the job is still running
    release.set()
    future.result(timeout=5)
    deadline = time.monotonic() + 2
    while directory.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not directory.exists()
