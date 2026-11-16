"""Proves that the frozen service really works, on real speech, without the development environment.

    services\\transcription\\.venv\\Scripts\\python.exe scripts\\verify_frozen_service.py [--exe PATH] [--ffmpeg PATH]

The service runs with a minimal environment (no Python, Anaconda or FFmpeg in PATH, no LINGUANOTE_* setting of this
machine). Windows speaks a French sentence through its built-in voice; it must come back as text both from a file
upload and from a live session. This is a check that the bundle works, NOT a measure of transcription quality:
synthetic voice is the easy case (see docs/evaluation-results.md).

The speech model must already be in the local cache: nothing is downloaded (HF_HUB_OFFLINE=1).
"""
import argparse
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
import wave
from pathlib import Path

from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EXE = ROOT / "services/transcription/dist/linguanote-service/linguanote-service.exe"
DEFAULT_FFMPEG = ROOT / "services/transcription/dist/ffmpeg/ffmpeg.exe"
SENTENCE = "Le train pour Dakar part de la gare à huit heures du matin."
MIN_WORD_OVERLAP = 0.5
TOKEN_HEADER = "X-LinguaNote-Token"
FRAME_BYTES = 3200  # 100 ms of 16 kHz mono PCM

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{f'  ->  {detail}' if detail and not ok else ''}", flush=True)
    if not ok:
        failures.append(name)


def words(text: str) -> set[str]:
    plain = unicodedata.normalize("NFD", text.lower())
    plain = "".join(c if c.isalnum() else " " for c in plain if not unicodedata.combining(c))
    return set(plain.split())


def overlap(text: str) -> float:
    reference = words(SENTENCE)
    return len(reference & words(text)) / len(reference)


def speak_to_wav(path: Path) -> None:
    script = (
        "Add-Type -AssemblyName System.Speech;"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,"
        " [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);"
        f"$s.SetOutputToWaveFile('{path}', $f);"
        f"$s.Speak('{SENTENCE.replace(chr(39), chr(39) * 2)}');"
        "$s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True, timeout=60)


def request(
    base: str, path: str, *, token: str | None, body: bytes | None = None, content_type: str = "",
) -> tuple[int, dict]:
    headers = {TOKEN_HEADER: token} if token else {}
    if content_type:
        headers["Content-Type"] = content_type
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, data=body, headers=headers), timeout=300) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def upload(base: str, token: str, audio: Path) -> tuple[int, dict]:
    boundary = secrets.token_hex(16)
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="check.wav"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode() + audio.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    return request(base, "/api/v1/transcriptions", token=token, body=body,
                   content_type=f"multipart/form-data; boundary={boundary}")


def live(port: int, token: str, audio: Path) -> str:
    """Streams the sentence followed by silence, then stops; returns the text of the final events."""
    with wave.open(str(audio)) as source:
        pcm = source.readframes(source.getnframes())
    pcm += b"\x00" * (16000 * 2)  # one second of silence ends the utterance
    texts: list[str] = []
    with connect(f"ws://127.0.0.1:{port}/api/v1/live", open_timeout=30) as socket_:
        socket_.send(json.dumps({"type": "start", "token": token, "protocol": 1}))
        started = json.loads(socket_.recv(timeout=120))
        if started.get("type") != "session_started":
            raise RuntimeError(f"unexpected opening: {started.get('type')} {started.get('code')}")
        for sequence, offset in enumerate(range(0, len(pcm), FRAME_BYTES), start=1):
            socket_.send(sequence.to_bytes(4, "big") + pcm[offset:offset + FRAME_BYTES])
        socket_.send(json.dumps({"type": "stop"}))
        while True:
            message = json.loads(socket_.recv(timeout=180))
            if message["type"] == "final":
                texts.append(message["text"])
            elif message["type"] == "error":
                raise RuntimeError(f"live error: {message.get('code')}")
            elif message["type"] == "session_ended":
                return " ".join(texts)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, default=DEFAULT_EXE)
    parser.add_argument("--ffmpeg", type=Path, default=DEFAULT_FFMPEG)
    parser.add_argument("--routing", action="store_true",
                        help="keep this machine's language-routing settings (its Wolof models must be installed)")
    arguments = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if not arguments.exe.exists() or not arguments.ffmpeg.exists():
        print(f"Missing {arguments.exe} or {arguments.ffmpeg}: build it first (scripts/build-installer.ps1).")
        return 2

    with tempfile.TemporaryDirectory(prefix="linguanote-frozen-") as temporary:
        directory = Path(temporary)
        speech = directory / "speech.wav"
        speak_to_wav(speech)

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        token = secrets.token_urlsafe(32)
        windows = os.environ.get("SystemRoot", r"C:\Windows")
        env = {
            "SystemRoot": windows, "PATH": rf"{windows}\System32", "TEMP": str(directory), "TMP": str(directory),
            "USERPROFILE": os.environ["USERPROFILE"], "LOCALAPPDATA": os.environ.get("LOCALAPPDATA", ""),
            "HF_HUB_OFFLINE": "1",
            "LINGUANOTE_API_TOKEN": token,
            "LINGUANOTE_FFMPEG": str(arguments.ffmpeg),
            "LINGUANOTE_DATA_DIR": str(directory / "data"),
        }
        if arguments.routing:
            env.update({name: value for name, value in os.environ.items()
                        if name.startswith("LINGUANOTE_ROUTING_") or name == "LINGUANOTE_ASR_ENGINE"})
            env["LINGUANOTE_ASR_ENGINE"] = "language-routing"
            print("Engine: language-routing")
        # A file, not a pipe: nobody reads a pipe while the checks run, and a full one would block the service.
        stderr_path = directory / "service-stderr.log"
        stderr_file = stderr_path.open("wb")
        service = subprocess.Popen(
            [str(arguments.exe), "--port", str(port)], env=env, cwd=arguments.exe.parent,
            stdout=subprocess.DEVNULL, stderr=stderr_file, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        base = f"http://127.0.0.1:{port}"
        try:
            started_at = time.monotonic()
            health = None
            while time.monotonic() - started_at < 90 and service.poll() is None:
                try:
                    status, health = request(base, "/health", token=token)
                    if status == 200:
                        break
                except OSError:
                    time.sleep(0.3)
            check("the frozen service starts without the development environment", bool(health),
                  f"exit code {service.poll()}")
            if not health:
                return 1
            print(f"      started in {time.monotonic() - started_at:.1f} s")
            check("health reports an available engine", health.get("engine_selected") is True,
                  json.dumps(health))
            check("a request without the token is refused", request(base, "/health", token=None)[0] == 401)

            started_at = time.monotonic()
            status, result = upload(base, token, speech)
            elapsed = time.monotonic() - started_at
            score = overlap(result.get("text", ""))
            check(f"a file becomes text ({score:.0%} of the words, {elapsed:.1f} s)",
                  status == 200 and score >= MIN_WORD_OVERLAP,
                  f"{status} {json.dumps(result, ensure_ascii=False)[:300]}")
            print(f"      text: {result.get('text')!r}, language: {result.get('language')}")

            text = live(port, token, speech)
            score = overlap(text)
            check(f"live audio becomes text ({score:.0%} of the words)", score >= MIN_WORD_OVERLAP, repr(text))
            print(f"      text: {text!r}")
            log = directory / "data" / "logs" / "linguanote.log"
            check("logs are written to the data folder, not next to the program", log.exists())
            check("the logs contain neither the token nor the transcript",
                  log.exists() and token not in log.read_text("utf-8") and "Dakar" not in log.read_text("utf-8"))
        finally:
            subprocess.run(["taskkill", "/pid", str(service.pid), "/T", "/F"], capture_output=True, check=False)
            service.wait(timeout=20)
            stderr_file.close()
            stderr = stderr_path.read_text("utf-8", "replace")
            if failures and stderr.strip():
                print("--- service stderr ---\n" + "\n".join(stderr.splitlines()[-25:]))

    print("\nFROZEN SERVICE OK" if not failures else f"\nFROZEN SERVICE FAILED ({len(failures)} failing)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
