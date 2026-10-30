"""Turns what a user types into a safe SQLite FTS5 query. Pure: no database access."""
import re

_WORD = re.compile(r"[\w'’-]+", re.UNICODE)
MAX_TERMS = 12
MAX_TERM_LENGTH = 64

# Markers around the matching words in a snippet. Control characters cannot occur in a transcript, so the client can
# split on them safely (no HTML, nothing to escape or inject).
HIGHLIGHT_START = "\x02"
HIGHLIGHT_END = "\x03"


def build_match_query(raw: str) -> str | None:
    """Every word becomes a quoted FTS5 phrase and the last one is a prefix, so "jere" finds "Jërëjëf" while typing.

    FTS5 operators (AND, OR, NOT, NEAR, `*`, `:`, quotes, parentheses) in the input are neutralised: only words are
    kept, so no input can change the structure of the query or raise a syntax error. None when nothing searchable
    remains (the caller then lists everything).
    """
    words = [word.strip("'’-") for word in _WORD.findall(raw or "")]
    words = [word[:MAX_TERM_LENGTH] for word in words if word][:MAX_TERMS]
    if not words:
        return None
    quoted = ['"' + word.replace('"', '""') + '"' for word in words]
    quoted[-1] += "*"
    return " ".join(quoted)
