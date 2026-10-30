"""Export of one stored session as text, Markdown, subtitles or JSON. Pure: a session dict in, a string out."""
import json
import re

FORMATS = ("txt", "md", "srt", "vtt", "json")
MEDIA_TYPES = {
    "txt": "text/plain; charset=utf-8",
    "md": "text/markdown; charset=utf-8",
    "srt": "application/x-subrip; charset=utf-8",
    "vtt": "text/vtt; charset=utf-8",
    "json": "application/json; charset=utf-8",
}
JSON_EXPORT_VERSION = 1


class ExportError(ValueError):
    """The session cannot be exported in that format (message is safe to show to the user)."""


def _clock(seconds: float, separator: str) -> str:
    total_ms = max(0, round(seconds * 1000))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{millis:03d}"


def _stamp(seconds: float | None) -> str:
    return "" if seconds is None else f"[{_clock(seconds, '.')[:-4]}] "


def _timed_cues(session: dict) -> list[dict]:
    """Subtitles need real times. Missing ones are never invented."""
    segments = session["segments"]
    if not segments:
        raise ExportError("This session has no text to export.")
    if any(item["start_seconds"] is None or item["end_seconds"] is None for item in segments):
        raise ExportError("This session has no timestamps, so it cannot be exported as subtitles.")
    return segments


def to_txt(session: dict) -> str:
    return "\n".join(item["text"] for item in session["segments"]) + "\n"


def to_markdown(session: dict) -> str:
    source = {"microphone": "microphone", "system": "son de l'ordinateur", "both": "microphone + son de l'ordinateur"}
    details = [f"Date : {session['created_at']}"]
    if session.get("source"):
        details.append(f"Source : {source.get(session['source'], session['source'])}")
    if session.get("engine"):
        details.append(f"Moteur : {session['engine']}{' / ' + session['model'] if session.get('model') else ''}")
    lines = [f"# {session['title']}", "", *(f"- {detail}" for detail in details), "",
             "_Texte reconnu automatiquement : la langue est estimée et le texte peut contenir des erreurs._", ""]
    for item in session["segments"]:
        lines += [f"{_stamp(item['start_seconds'])}{item['text']}".strip(), ""]
    return "\n".join(lines)


def to_srt(session: dict) -> str:
    blocks = []
    for index, item in enumerate(_timed_cues(session), start=1):
        blocks.append(
            f"{index}\n{_clock(item['start_seconds'], ',')} --> {_clock(item['end_seconds'], ',')}\n{item['text']}\n"
        )
    return "\n".join(blocks)


def to_vtt(session: dict) -> str:
    blocks = ["WEBVTT\n"]
    for item in _timed_cues(session):
        blocks.append(f"{_clock(item['start_seconds'], '.')} --> {_clock(item['end_seconds'], '.')}\n{item['text']}\n")
    return "\n".join(blocks)


def to_json(session: dict) -> str:
    return json.dumps({"export_version": JSON_EXPORT_VERSION, **session}, ensure_ascii=False, indent=2) + "\n"


_RENDERERS = {"txt": to_txt, "md": to_markdown, "srt": to_srt, "vtt": to_vtt, "json": to_json}


def render(session: dict, fmt: str) -> tuple[str, str]:
    """(content, media type). Raises ExportError for an unknown format or content the format cannot express."""
    if fmt not in _RENDERERS:
        raise ExportError(f"Unsupported export format. Choose one of: {', '.join(FORMATS)}.")
    return _RENDERERS[fmt](session), MEDIA_TYPES[fmt]


_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


def safe_filename(title: str, extension: str) -> str:
    """A file name that is safe on every platform: no path parts, no reserved characters, bounded length."""
    stem = _UNSAFE.sub(" ", title or "").strip(" .") or "transcription"
    stem = re.sub(r"\s+", " ", stem)[:80].strip(" .") or "transcription"
    return f"{stem}.{extension}"
