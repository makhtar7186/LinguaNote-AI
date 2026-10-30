import json

import pytest

from app.export.formats import ExportError, render, safe_filename

TIMED = {
    "id": "abc", "kind": "live", "source": "both", "engine": "faster-whisper", "model": "base",
    "title": "Réunion du lundi", "created_at": "2026-10-30T12:00:00+00:00", "ended_at": None, "duration_seconds": 75.5,
    "status": "complete",
    "segments": [
        {"position": 0, "start_seconds": 0.0, "end_seconds": 2.5, "text": "Bonjour à tous.", "language": "fr", "language_probability": 0.9},
        {"position": 1, "start_seconds": 3661.25, "end_seconds": 3663.0, "text": "Jërëjëf, merci.", "language": None, "language_probability": None},
    ],
}
UNTIMED = {**TIMED, "segments": [{"position": 0, "start_seconds": None, "end_seconds": None, "text": "Texte sans horodatage",
                                  "language": None, "language_probability": None}]}


def test_plain_text_is_one_utterance_per_line():
    content, media_type = render(TIMED, "txt")
    assert content == "Bonjour à tous.\nJërëjëf, merci.\n"
    assert media_type.startswith("text/plain") and "utf-8" in media_type


def test_markdown_carries_the_title_the_source_and_a_reliability_note():
    content, _ = render(TIMED, "md")
    assert content.startswith("# Réunion du lundi\n")
    assert "Source : microphone + son de l'ordinateur" in content
    assert "Moteur : faster-whisper / base" in content
    assert "peut contenir des erreurs" in content  # a recognised text is never presented as certain
    assert "[00:00:00] Bonjour à tous." in content
    assert "[01:01:01] Jërëjëf, merci." in content


def test_markdown_without_timestamps_has_no_invented_time():
    content, _ = render(UNTIMED, "md")
    assert "Texte sans horodatage" in content
    assert "[" not in content.split("erreurs.")[1]


def test_srt_uses_comma_milliseconds_and_numbers_the_cues():
    content, media_type = render(TIMED, "srt")
    assert content == (
        "1\n00:00:00,000 --> 00:00:02,500\nBonjour à tous.\n\n"
        "2\n01:01:01,250 --> 01:01:03,000\nJërëjëf, merci.\n"
    )
    assert "subrip" in media_type


def test_vtt_has_the_header_and_dot_milliseconds():
    content, media_type = render(TIMED, "vtt")
    assert content.startswith("WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nBonjour à tous.")
    assert "01:01:01.250 --> 01:01:03.000" in content
    assert "vtt" in media_type


@pytest.mark.parametrize("fmt", ["srt", "vtt"])
def test_subtitles_refuse_to_invent_times(fmt):
    with pytest.raises(ExportError, match="no timestamps"):
        render(UNTIMED, fmt)


@pytest.mark.parametrize("fmt", ["srt", "vtt"])
def test_subtitles_of_an_empty_session_are_refused(fmt):
    with pytest.raises(ExportError, match="no text"):
        render({**TIMED, "segments": []}, fmt)


def test_json_is_versioned_and_lossless():
    content, media_type = render(TIMED, "json")
    data = json.loads(content)
    assert data["export_version"] == 1
    assert data["segments"][1]["text"] == "Jërëjëf, merci."
    assert data["segments"][0]["language_probability"] == 0.9
    assert "Jërëjëf" in content  # readable, not escaped to \u sequences
    assert "json" in media_type


def test_text_exports_of_an_empty_session_are_empty_not_failures():
    assert render({**TIMED, "segments": []}, "txt")[0].strip() == ""
    assert "# Réunion du lundi" in render({**TIMED, "segments": []}, "md")[0]


def test_an_unknown_format_is_refused_and_lists_the_valid_ones():
    with pytest.raises(ExportError, match="txt, md, srt, vtt, json"):
        render(TIMED, "docx")


@pytest.mark.parametrize("title, expected", [
    ("Réunion du lundi", "Réunion du lundi.txt"),
    ("../../etc/passwd", "etc passwd.txt"),
    ('a<b>:c"d|e?f*g', "a b c d e f g.txt"),
    ("C:\\Windows\\system32", "C Windows system32.txt"),
    ("   ...   ", "transcription.txt"),
    ("", "transcription.txt"),
    ("con\x00trol\n", "con trol.txt"),
])
def test_file_names_can_never_escape_a_folder_or_use_reserved_characters(title, expected):
    assert safe_filename(title, "txt") == expected


def test_file_names_are_bounded():
    name = safe_filename("x" * 500, "md")
    assert name.endswith(".md") and len(name) <= 83
