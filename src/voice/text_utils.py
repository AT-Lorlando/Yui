"""
Text helpers: trigger word, stop words, sentence boundary detection.
"""
import re

from .config import STOP_WORDS, TRIGGER_WORD

# ── Trigger word ──────────────────────────────────────────────────────────────

_trigger_re = re.compile(rf"\b{re.escape(TRIGGER_WORD)}\b", re.IGNORECASE)


def contains_trigger(text: str) -> bool:
    return bool(_trigger_re.search(text))


def strip_trigger(text: str) -> str:
    """
    Remove the trigger word and surrounding punctuation.

    "Lunix, allume les lumières"              → "allume les lumières"
    "allume les lumières s'il te plaît Lunix" → "allume les lumières s'il te plaît"
    """
    cleaned = _trigger_re.sub("", text)
    return re.sub(r"\s+", " ", cleaned).strip().lstrip(",.!?").rstrip().strip()


# ── Stop words ────────────────────────────────────────────────────────────────

_stop_re = (
    re.compile(
        r"\b(" + "|".join(re.escape(w) for w in STOP_WORDS) + r")\b",
        re.IGNORECASE,
    )
    if STOP_WORDS
    else None
)


def contains_stop_word(text: str) -> bool:
    return bool(_stop_re and _stop_re.search(text))


def strip_stop_words(text: str) -> str:
    if not _stop_re:
        return text
    cleaned = _stop_re.sub("", text)
    return re.sub(r"\s+", " ", cleaned).strip().lstrip(",.!?").strip()


# ── Sentence boundary ─────────────────────────────────────────────────────────

def find_sentence_end(buf: str) -> int:
    """
    Return the index of the first sentence-ending character (. ! ?)
    followed by whitespace (or end-of-string).
    Ignores decimal numbers like '3.5' (digit before '.').
    Returns -1 if no boundary found.
    """
    for i, ch in enumerate(buf):
        if ch in ".!?" and i >= 5:
            if ch == "." and i > 0 and buf[i - 1].isdigit():
                continue
            next_ch = buf[i + 1] if i + 1 < len(buf) else " "
            if next_ch in " \n\r\t":
                return i
    return -1
